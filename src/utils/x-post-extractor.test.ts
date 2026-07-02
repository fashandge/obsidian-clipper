// @vitest-environment jsdom
import { describe, test, expect, beforeEach } from 'vitest';
import { isNewXPostPage, isXStatusUrl, extractXPost } from './x-post-extractor';

const URL = 'https://x.com/diegocabezas01/status/2072436501263339841';

// Minimal reproduction of X's new lightweight markup (article[data-tweet-id],
// Tailwind classes, whitespace-pre-wrap text nodes, NO data-testid). Mirrors the
// structure captured from the live page. The `\n` line breaks are the crux: the
// generic reader collapses them, this extractor must preserve them as paragraphs.
function mainTweetMarkup(text: string): string {
	return `
	<article class="flex flex-col gap-1" data-tweet-id="2072436501263339841">
		<div class="flex flex-col gap-2">
			<div class="flex flex-col gap-3">
				<div class="flex gap-2">
					<a data-slot="hover-card-trigger" href="https://x.com/diegocabezas01"><img alt="user avatar" src="https://pbs.twimg.com/profile_images/1/x_normal.jpg"></a>
					<div class="flex min-w-0 flex-1 flex-col">
						<div data-slot="hover-card-trigger">
							<a class="whitespace-pre-wrap" href="https://x.com/diegocabezas01">Diego | AI 🚀 - e/acc</a>
							<a class="whitespace-pre-wrap" href="https://x.com/diegocabezas01">@diegocabezas01</a>
						</div>
					</div>
				</div>
				<div class="flex flex-col gap-3">
					<div class="font-chirp whitespace-pre-wrap break-words"><span class="whitespace-pre-wrap">${text}</span></div>
					<div class="relative overflow-hidden border">
						<a aria-label="Image" href="/diegocabezas01/status/2072436501263339841/photo/1"><img alt="a diagram" src="https://pbs.twimg.com/media/ABC?format=jpg&name=small"></a>
					</div>
					<div class="flex items-center">
						<a href="/diegocabezas01/status/2072436501263339841">9:45 PM · Jul 1, 2026</a>
						<a href="https://x.com/diegocabezas01/status/2072436501263339841/analytics"><span>344.2K</span><span>Views</span></a>
					</div>
				</div>
			</div>
			<div class="flex w-full">
				<button aria-label="Reply"></button>
				<button aria-label="139"></button>
				<button aria-label="Like"></button>
			</div>
			<button><span>Read 139 replies</span></button>
		</div>
	</article>`;
}

function replyMarkup(id: string, handle: string, name: string, text: string): string {
	return `
	<article class="flex flex-col gap-1" data-tweet-id="${id}">
		<div data-slot="hover-card-trigger">
			<a href="https://x.com/${handle}">${name}</a>
			<a href="https://x.com/${handle}">@${handle}</a>
		</div>
		<div class="font-chirp whitespace-pre-wrap"><span class="whitespace-pre-wrap">${text}</span></div>
		<div class="flex items-center"><a href="https://x.com/${handle}/status/${id}">19h</a></div>
	</article>`;
}

describe('isNewXPostPage', () => {
	beforeEach(() => { document.body.innerHTML = ''; });

	test('true for the new article[data-tweet-id] markup on a status URL', () => {
		document.body.innerHTML = mainTweetMarkup('Hello');
		expect(isNewXPostPage(document, URL)).toBe(true);
	});

	test('false when the classic data-testid markup is present (defuddle handles it)', () => {
		document.body.innerHTML =
			'<article data-testid="tweet"><div data-testid="tweetText">Hi</div></article>' +
			mainTweetMarkup('Hello');
		expect(isNewXPostPage(document, URL)).toBe(false);
	});

	test('false for non-status URLs', () => {
		document.body.innerHTML = mainTweetMarkup('Hello');
		expect(isNewXPostPage(document, 'https://x.com/home')).toBe(false);
	});

	test('false for unrelated sites', () => {
		document.body.innerHTML = '<article data-tweet-id="1"></article>';
		expect(isNewXPostPage(document, 'https://example.com/x')).toBe(false);
	});
});

describe('extractXPost', () => {
	beforeEach(() => { document.body.innerHTML = ''; });

	test('preserves the tweet\'s line breaks as separate paragraphs', () => {
		document.body.innerHTML = mainTweetMarkup('Line one\n\nLine two\nLine three');
		const result = extractXPost(document, URL)!;
		expect(result).not.toBeNull();
		expect(result.content).toContain('<p>Line one</p>');
		expect(result.content).toContain('<p>Line two</p>');
		expect(result.content).toContain('<p>Line three</p>');
		// The three lines must NOT be collapsed into one dense paragraph.
		expect(result.content).not.toContain('Line one Line two');
	});

	test('extracts author, handle, title, date, and description', () => {
		document.body.innerHTML = mainTweetMarkup('First sentence here. Second one.');
		const result = extractXPost(document, URL)!;
		expect(result.author).toBe('@diegocabezas01');
		expect(result.title).toBe('Post by @diegocabezas01 on X');
		expect(result.site).toBe('X (Twitter)');
		expect(result.published).toBe('2026-07-01');
		expect(result.description).toContain('First sentence here.');
		expect(result.extractedContent).toEqual({
			tweetId: '2072436501263339841',
			tweetAuthor: '@diegocabezas01',
		});
	});

	test('includes media images and excludes avatars / UI chrome', () => {
		document.body.innerHTML = mainTweetMarkup('Body');
		const result = extractXPost(document, URL)!;
		expect(result.content).toContain('pbs.twimg.com/media/ABC');
		// Upgraded from &name=small; the & is HTML-escaped in the attribute (turndown
		// decodes it back to &name=large in the final markdown).
		expect(result.content).toContain('name=large');
		expect(result.content).not.toContain('name=small');
		expect(result.content).not.toContain('user avatar');
		expect(result.content).not.toContain('Read 139 replies');
		expect(result.content).not.toContain('Views');
	});

	test('classifies self-replies as thread and others as replies', () => {
		document.body.innerHTML =
			mainTweetMarkup('Main tweet') +
			replyMarkup('2072436501263339999', 'diegocabezas01', 'Diego | AI 🚀 - e/acc', 'My own follow-up') +
			replyMarkup('2072436501263340000', 'someoneelse', 'Someone Else', 'Nice thread!');
		const result = extractXPost(document, URL)!;
		// Self-reply is appended to the post body (separated by <hr>), not the replies section.
		expect(result.content).toContain('<p>My own follow-up</p>');
		expect(result.content).toContain('<h2>Replies</h2>');
		expect(result.content).toContain('<strong>Someone Else @someoneelse</strong>');
		// The other-author reply lives after the Replies heading.
		const repliesIdx = result.content.indexOf('<h2>Replies</h2>');
		expect(result.content.indexOf('Nice thread!')).toBeGreaterThan(repliesIdx);
		expect(result.content.indexOf('My own follow-up')).toBeLessThan(repliesIdx);
	});

	test('returns null when no tweet article is present', () => {
		document.body.innerHTML = '<div>not a tweet</div>';
		expect(extractXPost(document, URL)).toBeNull();
	});
});

// Classic React SPA markup (data-testid). Mirrors the live structure captured
// from a logged-in session: tweetText is spans with real `\n` text and inline
// emoji <img alt>, the author lives in [data-testid="User-Name"], the timestamp
// in a <time datetime> inside a permalink. This is the case where defuddle's own
// TwitterExtractor should work but sometimes falls back to the generic reader.
function classicTweetMarkup(
	id: string, handle: string, name: string, text: string, datetime: string,
	opts: { emoji?: boolean; photo?: boolean } = {}
): string {
	const emoji = opts.emoji ? '<img alt="🧵" src="https://abs.twimg.com/emoji/v2/svg/1f9f5.svg">' : '';
	const photo = opts.photo
		? '<div data-testid="tweetPhoto"><img alt="a chart" src="https://pbs.twimg.com/media/XYZ?format=jpg&name=small"></div>'
		: '';
	return `
	<div data-testid="cellInnerDiv">
	<article data-testid="tweet">
		<div data-testid="User-Name">
			<a href="https://x.com/${handle}">${name}</a>
			<a href="https://x.com/${handle}">@${handle}</a>
			<a href="https://x.com/${handle}/status/${id}"><time datetime="${datetime}">Jul 1</time></a>
		</div>
		<div data-testid="tweetText"><span>${text}</span>${emoji}</div>
		${photo}
	</article>
	</div>`;
}

describe('extractXPost — classic data-testid markup', () => {
	const cURL = 'https://x.com/hwchase17/status/2072694781285986625';
	beforeEach(() => { document.body.innerHTML = ''; });

	test('preserves the tweet\'s line breaks as separate paragraphs', () => {
		document.body.innerHTML = classicTweetMarkup(
			'2072694781285986625', 'hwchase17', 'Harrison Chase',
			'big week at langchain:\n\n1/ OpenWiki\n2/ voice agent tutorials', '2026-07-01T21:00:00.000Z'
		);
		const result = extractXPost(document, cURL)!;
		expect(result).not.toBeNull();
		expect(result.content).toContain('<p>big week at langchain:</p>');
		expect(result.content).toContain('<p>1/ OpenWiki</p>');
		expect(result.content).toContain('<p>2/ voice agent tutorials</p>');
		expect(result.content).not.toContain('OpenWiki 2/ voice'); // not collapsed
	});

	test('extracts author, handle, title, date, image, and keeps emoji alt', () => {
		document.body.innerHTML = classicTweetMarkup(
			'2072694781285986625', 'hwchase17', 'Harrison Chase',
			'launch thread ', '2026-07-01T21:00:00.000Z', { emoji: true, photo: true }
		);
		const result = extractXPost(document, cURL)!;
		expect(result.author).toBe('@hwchase17');
		expect(result.title).toBe('Post by @hwchase17 on X');
		expect(result.published).toBe('2026-07-01');
		expect(result.content).toContain('pbs.twimg.com/media/XYZ');
		expect(result.content).toContain('name=large');
		expect(result.content).toContain('🧵'); // emoji alt survives inline
		expect(result.extractedContent.tweetId).toBe('2072694781285986625');
	});

	test('classifies self-replies as thread and others as replies', () => {
		document.body.innerHTML =
			classicTweetMarkup('2072694781285986625', 'hwchase17', 'Harrison Chase', 'Main', '2026-07-01T21:00:00.000Z') +
			classicTweetMarkup('2072694781285986999', 'hwchase17', 'Harrison Chase', 'my follow-up', '2026-07-01T21:05:00.000Z') +
			classicTweetMarkup('2072694781285987000', 'someoneelse', 'Someone Else', 'great launch', '2026-07-01T22:00:00.000Z');
		const result = extractXPost(document, cURL)!;
		expect(result.content).toContain('<p>my follow-up</p>');
		expect(result.content).toContain('<h2>Replies</h2>');
		expect(result.content).toContain('<strong>Someone Else @someoneelse</strong>');
		const repliesIdx = result.content.indexOf('<h2>Replies</h2>');
		expect(result.content.indexOf('great launch')).toBeGreaterThan(repliesIdx);
		expect(result.content.indexOf('my follow-up')).toBeLessThan(repliesIdx);
	});
});

describe('isXStatusUrl', () => {
	test('matches x.com and twitter.com status URLs', () => {
		expect(isXStatusUrl('https://x.com/a/status/123')).toBe(true);
		expect(isXStatusUrl('https://twitter.com/a/status/123')).toBe(true);
	});
	test('rejects non-status and non-X URLs', () => {
		expect(isXStatusUrl('https://x.com/home')).toBe(false);
		expect(isXStatusUrl('https://example.com/a/status/123')).toBe(false);
	});
});
