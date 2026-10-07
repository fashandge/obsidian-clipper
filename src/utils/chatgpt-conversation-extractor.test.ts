// @vitest-environment jsdom
import { describe, test, expect, beforeEach } from 'vitest';
import { extractChatGPTConversation, isChatGPTConversationUrl } from './chatgpt-conversation-extractor';

const URL = 'https://chatgpt.com/c/6ac6cc30-2408-83e8-9b20-f97182a602c2';

// Minimal reproductions of ChatGPT's 2026 markup, mirroring the structure
// captured from live pages: `[data-turn-key]` turns, role-suffixed
// `[data-content-search-unit-key]` units, sr-only "You said:" / "ChatGPT said:"
// headings (the user's sits OUTSIDE its unit), and no `data-message-author-role`.
function userUnit(turn: number, text: string): string {
	return `
	<h4 class="sr-only">You said:</h4>
	<div data-chatgpt-search-unit-key="fallback-turn-${turn}:0:user">
		<div data-content-search-unit-key="fallback-turn-${turn}:0:user">
			<div data-user-message-bubble="true" class="bg-user-message"><div dir="auto" class="whitespace-pre-wrap">${text}</div></div>
			<div><button aria-label="Copy message"></button><button aria-label="Edit message"></button></div>
		</div>
	</div>`;
}

function assistantUnit(turn: number, body: string): string {
	return `
	<div data-content-search-unit-key="fallback-turn-${turn}:2:assistant">
		<h4 class="sr-only" data-conversation-role="assistant">ChatGPT said:</h4>
		<div><div data-markdown-text-style="assistant-message" class="MarkdownRoot-rZKhxa">${body}</div></div>
		<div data-markdown-copy="exclude">ChatGPT can make mistakes. Check important info.</div>
	</div>`;
}

function turn(key: string, inner: string): string {
	return `<div data-turn-key="${key}"><div data-talvt-turn-state="complete">${inner}</div></div>`;
}

// Generative-UI answer: emphasis in data-d-* attributes, href-less source badge.
const GEN_UI_BODY = `
	<div data-d-component="box" data-d-direction="col">
		<h1 data-d-component="title" data-d-weight="semibold">TER vs. AEHR: How their businesses differ</h1>
		<p data-d-component="text"><span data-d-component="text" data-d-default-strong="">Teradyne (NASDAQ: TER)</span> sells testers, a process called <span data-d-component="text" data-d-font-style="italic">burn-in</span>.
			<span data-d-component="text"><span data-d-component="popover-trigger" role="button" data-state="closed"><span data-d-component="box"><span data-d-component="badge"><span data-d-component="favicon"><img src="https://www.google.com/s2/favicons?domain=https://www.sec.gov&amp;sz=32"></span><span data-d-component="text">SEC</span><span data-d-component="text">+1</span></span></span></span></span></p>
		<p data-d-component="text" data-d-weight="bold">TER — Functional testing</p>
		<div data-d-component="table"><table><tbody>
			<tr data-d-component="table-row"><th data-d-component="table-cell"><p data-d-component="text">Dimension</p></th><th data-d-component="table-cell"><p data-d-component="text">TER</p></th></tr>
			<tr data-d-component="table-row"><td data-d-component="table-cell"><p data-d-component="text">Core specialty</p></td><td data-d-component="table-cell"><p data-d-component="text">Automated test equipment</p></td></tr>
		</tbody></table></div>
		<span data-d-component="caption">Illustrative workflow, not a fixed sequence.</span>
	</div>`;

// Classic Markdown answer: semantic tags, citation pill with href + aria-label.
const CITE_URL = 'https://stockanalysis.com/stocks/ba/history/?utm_source=chatgpt.com';
const CLASSIC_BODY = `
	<p class="Paragraph-kKnbIo"><span>Consider </span><strong class="font-semibold"><span>$175–180</span></strong><span> as an entry.</span><span class="contents" data-markdown-copy="contents"><span data-state="closed" class="contents"><span class="ms-1 inline-flex" data-search-result-target=""><a data-testid="chatgpt-citation" aria-label="stockanalysis.com: The Boeing Company (BA) Stock Price History, ${CITE_URL}" href="${CITE_URL}" rel="noopener noreferrer" target="_blank"><span><img alt="" src="https://t0.gstatic.com/faviconV2?url=https%3A%2F%2Fstockanalysis.com"></span><span>stockanalysis.com</span></a></span></span></span></p>
	<p>Again <span data-search-result-target=""><a data-testid="chatgpt-citation" aria-label="stockanalysis.com: The Boeing Company (BA) Stock Price History, ${CITE_URL}" href="${CITE_URL}">stockanalysis.com</a></span></p>`;

function setPage(title: string, turnsHtml: string): void {
	document.title = title;
	document.body.innerHTML = `
	<nav><a href="/c/other">Some other chat in the sidebar</a></nav>
	<main><div data-thread-find-target="conversation">${turnsHtml}</div></main>
	<div data-composer-body><div contenteditable="true" aria-label="Ask ChatGPT"><p>Ask ChatGPT</p></div></div>`;
}

describe('isChatGPTConversationUrl', () => {
	test('matches conversation, project-GPT and share URLs', () => {
		expect(isChatGPTConversationUrl(URL)).toBe(true);
		expect(isChatGPTConversationUrl('https://chatgpt.com/g/g-p-abc-project/c/6ac6cc30-2408')).toBe(true);
		expect(isChatGPTConversationUrl('https://chatgpt.com/share/6ac6cc30-2408')).toBe(true);
		expect(isChatGPTConversationUrl('https://chat.openai.com/c/abc-123')).toBe(true);
	});

	test('rejects non-conversation pages', () => {
		expect(isChatGPTConversationUrl('https://chatgpt.com/')).toBe(false);
		expect(isChatGPTConversationUrl('https://chatgpt.com/gpts')).toBe(false);
		expect(isChatGPTConversationUrl('https://example.com/c/abc')).toBe(false);
	});
});

describe('extractChatGPTConversation', () => {
	beforeEach(() => {
		document.body.innerHTML = '';
		document.title = '';
	});

	test('keeps the full generative-UI answer, with headers, emphasis and sources', () => {
		setPage('TER AEHR business comparison', turn('t0',
			userUnit(0, 'illustrate the differences between TER and AEHR') + assistantUnit(0, GEN_UI_BODY)));

		const result = extractChatGPTConversation(document, URL);
		expect(result).not.toBeNull();
		const html = result!.content;

		expect(result!.title).toBe('TER AEHR business comparison');
		expect(result!.site).toBe('ChatGPT');
		expect(result!.extractedContent.messageCount).toBe('2');

		// Both messages, in order, under localized author headers (colon stripped).
		expect(html.indexOf('<strong>You said</strong>')).toBeGreaterThan(-1);
		expect(html.indexOf('<strong>ChatGPT said</strong>')).toBeGreaterThan(html.indexOf('illustrate the differences'));
		// The answer itself — the part the generic reader used to drop.
		expect(html).toContain('<h1>TER vs. AEHR: How their businesses differ</h1>');
		expect(html).toContain('<strong>Teradyne (NASDAQ: TER)</strong>');
		expect(html).toContain('<em>burn-in</em>');
		expect(html).toContain('<strong>TER — Functional testing</strong>');
		expect(html).toContain('<td><p>Automated test equipment</p></td>');
		expect(html).toContain('<p><em>Illustrative workflow, not a fixed sequence.</em></p>');
		// Badge becomes a footnote pointing at the favicon's site.
		expect(html).toContain('<sup id="fnref:1"><a href="#fn:1">1</a></sup>');
		expect(html).toContain('<a href="https://www.sec.gov">sec.gov</a> (SEC +1)');

		// UI chrome is gone.
		expect(html).not.toContain('ChatGPT can make mistakes');
		expect(html).not.toContain('<button');
		expect(html).not.toContain('Some other chat');
		expect(html).not.toContain('Ask ChatGPT');
		expect(html).not.toMatch(/data-d-|class="Markdown/);
	});

	test('turns classic citation pills into deduplicated footnotes without the tracking param', () => {
		setPage('Boeing entry price', turn('t0', userUnit(0, 'BA price?') + assistantUnit(0, CLASSIC_BODY)));

		const html = extractChatGPTConversation(document, URL)!.content;
		expect(html).toContain('<strong><span>$175–180</span></strong>');
		expect(html.match(/<sup id="fnref:1">/g)).toHaveLength(2);
		expect(html).not.toContain('fnref:2');
		expect(html).toContain(
			'<a href="https://stockanalysis.com/stocks/ba/history/">stockanalysis.com</a> — The Boeing Company (BA) Stock Price History'
		);
		expect(html).not.toContain('utm_source');
	});

	test('extracts every turn of a multi-turn conversation and keeps prompt line breaks', () => {
		setPage('Chat', [
			turn('t0', userUnit(0, 'first line\nsecond line') + assistantUnit(0, '<p>Answer one</p>')),
			turn('t1', userUnit(1, 'follow-up') + assistantUnit(1, '<p>Answer two</p>')),
		].join(''));

		const result = extractChatGPTConversation(document, URL)!;
		expect(result.extractedContent.messageCount).toBe('4');
		const html = result.content;
		expect(html).toContain('first line<br>second line');
		const order = ['first line', 'Answer one', 'follow-up', 'Answer two'].map(t => html.indexOf(t));
		expect(order.every(i => i > -1)).toBe(true);
		expect([...order].sort((a, b) => a - b)).toEqual(order);
		expect(html.match(/<hr>/g)).toHaveLength(3);
	});

	test('falls back to the first prompt for the title when the page title is generic', () => {
		setPage('ChatGPT', turn('t0', userUnit(0, 'How do I lower LDL') + assistantUnit(0, '<p>Eat oats.</p>')));
		expect(extractChatGPTConversation(document, URL)!.title).toBe('How do I lower LDL');
	});

	test('returns null when the page lacks the new markup or the URL is not a conversation', () => {
		document.body.innerHTML = '<article data-testid="conversation-turn-1"><div data-message-author-role="user">hi</div></article>';
		expect(extractChatGPTConversation(document, URL)).toBeNull();

		setPage('Chat', turn('t0', userUnit(0, 'q') + assistantUnit(0, '<p>a</p>')));
		expect(extractChatGPTConversation(document, 'https://chatgpt.com/')).toBeNull();
	});

	test('returns null when no assistant message rendered yet', () => {
		setPage('Chat', turn('t0', userUnit(0, 'just asked')));
		expect(extractChatGPTConversation(document, URL)).toBeNull();
	});
});
