// @vitest-environment jsdom
import { describe, test, expect, beforeEach } from 'vitest';
import { isNewXPostPage, extractXPost } from './x-post-extractor';

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
