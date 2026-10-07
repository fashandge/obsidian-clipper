// Fork-local extractor for ChatGPT conversation pages (chatgpt.com/c/<id>).
//
// Background: defuddle ships a `ChatGPTExtractor`, but it only understands the
// old markup — `article[data-testid^="conversation-turn-"]` turns holding
// `[data-message-author-role]` messages. ChatGPT's current web app (observed
// 2026-10) has neither: turns are `[data-turn-key]` blocks, each message is a
// `[data-content-search-unit-key="<turn>:<n>:<role>"]` unit, and the assistant
// body is a `[data-markdown-text-style="assistant-message"]` root. So defuddle
// falls back to its generic reader, which can keep the user prompt but throw
// away the whole assistant answer (partial-selector + hidden-element clutter
// removal strip it, and defuddle's retries don't recover it).
//
// Assistant answers now come in two shapes, both handled here:
//   1. Classic Markdown — semantic <p>/<strong>/<table>, with sources as
//      `a[data-testid="chatgpt-citation"]` pills.
//   2. Generative-UI layout — `data-d-component="title|text|list|table|box|grid|…"`
//      elements where emphasis lives in attributes (`data-d-default-strong`,
//      `data-d-weight`, `data-d-font-style`) and sources are href-less badge
//      pills (`data-d-component="badge"` with a favicon).
//
// Output mirrors defuddle's ConversationExtractor (author header per message,
// <hr> between messages, citations as footnotes) so notes look like the old
// ChatGPT clips. Unlike that extractor it does NOT re-run defuddle over the
// assembled HTML: defuddle's heuristics drop the assistant header and a leading
// <h1> from generative-UI answers, so attributes are stripped here instead.
//
// `content.ts` only calls this when defuddle produced no `extractorType` on a
// ChatGPT conversation URL, so a working defuddle extraction is never
// clobbered. See docs/design/fork-additions.md.

import { serializeChildren } from './dom-utils';

export interface ChatGPTConversationOverride {
	content: string;
	title: string;
	site: string;
	description: string;
	wordCount: number;
	extractedContent: { messageCount: string };
}

interface Footnote {
	url: string;
	html: string;
}

const CONVERSATION_URL_RE = /^https?:\/\/(?:chatgpt\.com|chat\.openai\.com)\/(?:g\/[^/]+\/)?(?:c|share)\/[\w-]+/;
const UNIT_SELECTOR = '[data-content-search-unit-key]';
const HEADING_SELECTOR = 'h4, h5, h6';
const KEPT_ATTRIBUTES = new Set(['href', 'src', 'alt', 'title', 'id', 'colspan', 'rowspan']);

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

/** True for a ChatGPT conversation (or shared conversation) URL. */
export function isChatGPTConversationUrl(url: string): boolean {
	return CONVERSATION_URL_RE.test(url);
}

/** Parse HTML into an inert document (no script/handler execution, no loads). */
function parseInert(html: string): Document {
	return new DOMParser().parseFromString(html, 'text/html');
}

function replaceWithHtml(el: Element, html: string): void {
	const nodes = Array.from(parseInert(html).body.childNodes).map(n => el.ownerDocument.importNode(n, true));
	el.replaceWith(...nodes);
}

function countWords(html: string): number {
	return (parseInert(html).body.textContent ?? '').trim().split(/\s+/).filter(Boolean).length;
}

function stripTrackingParams(url: string): string {
	try {
		const parsed = new URL(url);
		if (parsed.searchParams.get('utm_source') === 'chatgpt.com') {
			parsed.searchParams.delete('utm_source');
		}
		return parsed.href;
	} catch {
		return url;
	}
}

function hostnameOf(url: string): string {
	try {
		return new URL(url).hostname.replace(/^www\./, '');
	} catch {
		return url;
	}
}

class FootnoteCollector {
	readonly notes: Footnote[] = [];

	/** Returns the 1-based footnote number for `url`, adding it if new. */
	add(url: string, html: string): number {
		const existing = this.notes.findIndex(note => note.url === url);
		if (existing !== -1) return existing + 1;
		this.notes.push({ url, html });
		return this.notes.length;
	}

	refHtml(n: number): string {
		return `<sup id="fnref:${n}"><a href="#fn:${n}">${n}</a></sup>`;
	}

	sectionHtml(): string {
		if (this.notes.length === 0) return '';
		const items = this.notes.map((note, i) =>
			`<li class="footnote" id="fn:${i + 1}"><p>${note.html}&nbsp;<a href="#fnref:${i + 1}" class="footnote-backref">↩</a></p></li>`
		).join('\n');
		return `<div id="footnotes"><ol>\n${items}\n</ol></div>`;
	}
}

/** Classic Markdown answers: `a[data-testid="chatgpt-citation"]` source pills. */
function convertCitationLinks(root: HTMLElement, footnotes: FootnoteCollector): void {
	root.querySelectorAll<HTMLAnchorElement>('a[data-testid="chatgpt-citation"]').forEach(a => {
		const href = a.getAttribute('href') ?? '';
		if (!href) return;
		const url = stripTrackingParams(href);
		// aria-label reads "<domain>: <page title>, <url>".
		let label = (a.getAttribute('aria-label') ?? '').trim();
		if (label.endsWith(href)) label = label.slice(0, -href.length).replace(/,\s*$/, '');
		const sourceTitle = label.includes(': ') ? label.slice(label.indexOf(': ') + 2).trim() : '';
		const html = `<a href="${escapeHtml(url)}">${escapeHtml(hostnameOf(url))}</a>${sourceTitle ? ` — ${escapeHtml(sourceTitle)}` : ''}`;
		const n = footnotes.add(url, html);
		const pill = a.closest('[data-search-result-target]');
		replaceWithHtml(pill && root.contains(pill) ? pill : a, footnotes.refHtml(n));
	});
}

/** Generative-UI answers: href-less source badges ("SEC +1") with a favicon. */
function convertSourceBadges(root: HTMLElement, footnotes: FootnoteCollector): void {
	root.querySelectorAll('[data-d-component="badge"]').forEach(badge => {
		const label = Array.from(badge.querySelectorAll('[data-d-component="text"]'))
			.map(el => (el.textContent ?? '').trim())
			.filter(Boolean)
			.join(' ') || (badge.textContent ?? '').trim();
		let origin = '';
		const favicon = badge.querySelector('img')?.getAttribute('src') ?? '';
		try {
			const params = new URL(favicon).searchParams;
			const target = params.get('domain') ?? params.get('url') ?? '';
			if (target) origin = new URL(target.includes('://') ? target : `https://${target}`).origin;
		} catch {
			origin = '';
		}
		const trigger = badge.closest('[data-d-component="popover-trigger"]');
		const el = trigger && root.contains(trigger) ? trigger : badge;
		if (origin) {
			const html = `<a href="${escapeHtml(origin)}">${escapeHtml(hostnameOf(origin))}</a>${label ? ` (${escapeHtml(label)})` : ''}`;
			replaceWithHtml(el, footnotes.refHtml(footnotes.add(origin, html)));
		} else if (label) {
			replaceWithHtml(el, ` (${escapeHtml(label)})`);
		} else {
			el.remove();
		}
	});
}

function wrapChildren(el: Element, tag: 'strong' | 'em'): void {
	const wrapper = el.ownerDocument.createElement(tag);
	while (el.firstChild) wrapper.appendChild(el.firstChild);
	el.appendChild(wrapper);
}

/** Generative-UI emphasis is carried by attributes; make it semantic. */
function convertGenerativeUiEmphasis(root: HTMLElement): void {
	root.querySelectorAll(
		'[data-d-default-strong], [data-d-weight="bold"], [data-d-weight="semibold"]'
	).forEach(el => {
		if (el.matches('h1, h2, h3, h4, h5, h6') || el.closest('strong, b, h1, h2, h3, h4, h5, h6, th')) return;
		wrapChildren(el, 'strong');
	});
	root.querySelectorAll('[data-d-font-style="italic"]').forEach(el => {
		if (el.closest('em, i')) return;
		wrapChildren(el, 'em');
	});
	root.querySelectorAll('span[data-d-component="caption"]').forEach(el => {
		const p = el.ownerDocument.createElement('p');
		const em = el.ownerDocument.createElement('em');
		while (el.firstChild) em.appendChild(el.firstChild);
		p.appendChild(em);
		el.replaceWith(p);
	});
}

/** User prompts are plain text with real `\n`s; keep their line breaks. */
function preserveLineBreaks(root: HTMLElement): void {
	const doc = root.ownerDocument;
	const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	const textNodes: Text[] = [];
	while (walker.nextNode()) textNodes.push(walker.currentNode as Text);
	for (const node of textNodes) {
		const text = node.data;
		if (!text.includes('\n') || node.parentElement?.closest('pre, code')) continue;
		const fragment = doc.createDocumentFragment();
		text.replace(/^\n+|\n+$/g, '').split('\n').forEach((line, i) => {
			if (i > 0) fragment.appendChild(doc.createElement('br'));
			fragment.appendChild(doc.createTextNode(line));
		});
		node.replaceWith(fragment);
	}
}

/** Drop ChatGPT's styling/state attributes; keep code-language classes. */
function stripAttributes(root: HTMLElement): void {
	for (const el of [root, ...Array.from(root.querySelectorAll('*'))]) {
		for (const name of el.getAttributeNames()) {
			if (KEPT_ATTRIBUTES.has(name)) continue;
			if (name === 'class' && el.matches('code')) continue;
			el.removeAttribute(name);
		}
	}
}

function cleanContent(root: HTMLElement, footnotes: FootnoteCollector): void {
	root.querySelectorAll(
		'button, svg, [hidden], .sr-only, [data-conversation-role], [data-markdown-copy="exclude"]'
	).forEach(el => el.remove());
	convertCitationLinks(root, footnotes);
	convertSourceBadges(root, footnotes);
	convertGenerativeUiEmphasis(root);
	stripAttributes(root);
}

/** The localized sr-only heading ("You said:", "ChatGPT said:") for a unit. */
function findAuthorLabel(unit: Element, turn: Element | null): string {
	const own = unit.querySelector(HEADING_SELECTOR);
	if (own) return (own.textContent ?? '').trim();
	// The user heading sits beside the unit's wrapper, not inside it.
	for (let el: Element | null = unit; el && el !== turn; el = el.parentElement) {
		const prev = el.previousElementSibling;
		if (prev?.matches(HEADING_SELECTOR)) return (prev.textContent ?? '').trim();
	}
	return '';
}

function messageContentRoots(unit: Element, role: string): Element[] {
	if (role === 'user') {
		return [unit.querySelector('[data-user-message-bubble]') ?? unit];
	}
	for (const selector of ['[data-markdown-text-style]', '.markdown']) {
		const all = Array.from(unit.querySelectorAll(selector));
		const top = all.filter(el => !all.some(other => other !== el && other.contains(el)));
		if (top.length > 0) return top;
	}
	return [unit];
}

/**
 * Extract a ChatGPT conversation from the current (2026) markup. Returns null
 * when the page doesn't carry it, so callers keep defuddle's output.
 */
export function extractChatGPTConversation(doc: Document, url: string): ChatGPTConversationOverride | null {
	if (!isChatGPTConversationUrl(url)) return null;

	const units = Array.from(doc.querySelectorAll(UNIT_SELECTOR)).filter(
		unit => !unit.parentElement?.closest(UNIT_SELECTOR)
	);
	if (units.length === 0) return null;

	const footnotes = new FootnoteCollector();
	const messages: { author: string; role: string; html: string; text: string }[] = [];
	for (const unit of units) {
		const role = (unit.getAttribute('data-content-search-unit-key') ?? '').split(':').pop() || 'unknown';
		const author = findAuthorLabel(unit, unit.closest('[data-turn-key]')).replace(/:\s*$/, '')
			|| (role === 'user' ? 'You said' : role === 'assistant' ? 'ChatGPT said' : role);

		const parts = messageContentRoots(unit, role).map(source => {
			const clone = source.cloneNode(true) as HTMLElement;
			cleanContent(clone, footnotes);
			if (role === 'user') preserveLineBreaks(clone);
			return clone;
		});
		const html = parts.map(part => serializeChildren(part)).join('\n').replace(/​/g, '').trim();
		const text = parts.map(part => (part.textContent ?? '').trim()).join(' ').trim();
		if (!text && !/<img\b/i.test(html)) continue;
		messages.push({ author, role, html, text });
	}
	if (!messages.some(m => m.role === 'assistant')) return null;

	const messagesHtml = messages.map(m => {
		const body = /<(p|div|ul|ol|table|h[1-6]|pre|blockquote)\b/i.test(m.html) ? m.html : `<p>${m.html}</p>`;
		return `<div class="message message-${escapeHtml(m.role)}" data-role="${escapeHtml(m.role)}">
<div class="message-header"><p class="message-author"><strong>${escapeHtml(m.author)}</strong></p></div>
<div class="message-content">${body}</div>
</div>`;
	}).join('\n<hr>\n');
	const content = `${messagesHtml}\n${footnotes.sectionHtml()}`.trim();

	const pageTitle = doc.title.trim();
	const firstUser = messages.find(m => m.role === 'user')?.text ?? '';
	const title = pageTitle && pageTitle !== 'ChatGPT'
		? pageTitle
		: firstUser.slice(0, 50).trim() || 'ChatGPT conversation';

	return {
		content,
		title,
		site: 'ChatGPT',
		description: `ChatGPT conversation with ${messages.length} messages`,
		wordCount: countWords(content),
		extractedContent: { messageCount: messages.length.toString() },
	};
}
