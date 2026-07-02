// Fork-local extractor for X (Twitter) status pages.
//
// Background: X serves (at least) two different web front-ends for a tweet:
//   1. The classic React SPA — `article[data-testid="tweet"]`,
//      `[data-testid="tweetText"]`, `[data-testid="User-Name"]`, `css-*` classes.
//   2. A newer lightweight, Tailwind-based page — `article[data-tweet-id]`,
//      `whitespace-pre-wrap` text nodes, and NO `data-testid` attributes at all.
// Which one you get depends on session/rollout (observed: logged-out → new,
// logged-in → classic, but this is not guaranteed).
//
// defuddle ships a `TwitterExtractor` that only understands markup (1). On markup
// (2) its `canExtract()` returns false; and even on markup (1) it sometimes does
// not run in this extension's pipeline. Whenever defuddle does NOT run a
// site-specific extractor it falls back to its generic reader, which scrapes the
// surrounding UI chrome AND collapses the tweet's line breaks (they are real
// `\n` characters — either in `white-space: pre-wrap` nodes or `<span>`s — with
// no `<br>`/`<p>`) into a single dense, unreadable paragraph.
//
// This module reads BOTH markups and produces clean HTML (paragraphs, images,
// replies as blockquotes) mirroring defuddle's TwitterExtractor output, so the
// existing `createMarkdownContent` pipeline yields a readable note.
//
// `content.ts` invokes it ONLY when defuddle produced no `extractorType` (i.e. it
// fell back to generic) on an X status URL, so a working defuddle extraction is
// never clobbered. See docs/design/fork-additions.md.

export interface XPostOverride {
	content: string;
	title: string;
	author: string;
	site: string;
	description: string;
	published?: string;
	extractedContent: { tweetId: string; tweetAuthor: string };
}

const STATUS_URL_RE = /(?:x|twitter)\.com\/[^/]+\/status\/(\d+)/;

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

/** True for any X/Twitter single-status URL. */
export function isXStatusUrl(url: string): boolean {
	return STATUS_URL_RE.test(url);
}

/**
 * True when the page uses the NEW `article[data-tweet-id]` markup (and not the
 * classic `data-testid` markup). Retained for tests / callers that need to
 * distinguish the variants; `extractXPost` handles both regardless.
 */
export function isNewXPostPage(doc: Document, url: string): boolean {
	if (!STATUS_URL_RE.test(url)) return false;
	if (doc.querySelector('article[data-testid="tweet"], [data-testid="tweetText"]')) {
		return false;
	}
	return !!doc.querySelector('article[data-tweet-id]');
}

function getStatusId(url: string): string {
	return url.match(STATUS_URL_RE)?.[1] ?? '';
}

interface ParsedTweet {
	id: string;
	name: string;
	handle: string;
	date: string; // ISO date (YYYY-MM-DD) when parseable, else ''
	permalink: string;
	textLines: string[];
	images: { src: string; alt: string }[];
	quoted: ParsedTweet | null;
}

interface Collected {
	main: ParsedTweet;
	rest: ParsedTweet[];
}

function upgradeMediaSrc(src: string): string {
	return src.replace(/&name=\w+$/, '&name=large');
}

// ---------------------------------------------------------------------------
// New markup: article[data-tweet-id] + whitespace-pre-wrap
// ---------------------------------------------------------------------------

function ownAnchorsNew(root: HTMLElement): HTMLAnchorElement[] {
	return Array.from(root.querySelectorAll<HTMLAnchorElement>('a[href]')).filter(
		a => a.closest('article[data-tweet-id]') === root
	);
}

function parseTweetDateText(text: string): string {
	// Absolute timestamp reads like "9:45 PM · Jul 1, 2026"; take the date part.
	const datePart = text.includes('·') ? text.split('·').pop()!.trim() : text.trim();
	const parsed = new Date(datePart);
	return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString().split('T')[0];
}

function parseNewTweet(art: HTMLElement): ParsedTweet {
	const id = art.getAttribute('data-tweet-id') ?? '';

	// Author name + handle come from the header profile links.
	const anchors = ownAnchorsNew(art);
	let handle = '';
	let name = '';
	let firstProfileHref = '';
	for (const a of anchors) {
		const t = (a.textContent ?? '').trim();
		const href = a.getAttribute('href') ?? '';
		if (!t) continue;
		if (!handle && t.startsWith('@')) {
			handle = t;
			continue;
		}
		if (
			!name &&
			!t.startsWith('@') &&
			!href.includes('/status/') &&
			!/\d[\d.,]*[KM]?\s*(Views|Reposts|Likes|Replies|Bookmarks)/i.test(t) &&
			!t.includes('·')
		) {
			name = t;
			if (!firstProfileHref) firstProfileHref = href;
		}
	}
	if (!handle) {
		const href = firstProfileHref || anchors[0]?.getAttribute('href') || '';
		const m = href.match(/(?:x|twitter)\.com\/([^/?#]+)/) ?? href.match(/^\/([^/?#]+)/);
		if (m && m[1] && !['i', 'home', 'search', 'explore'].includes(m[1])) handle = `@${m[1]}`;
	}

	// Date + permalink: the status-permalink anchor whose text carries a timestamp.
	let date = '';
	let permalink = '';
	const statusAnchors = Array.from(art.querySelectorAll<HTMLAnchorElement>('a[href*="/status/"]')).filter(
		a => a.closest('article[data-tweet-id]') === art
	);
	for (const a of statusAnchors) {
		const t = (a.textContent ?? '').trim();
		if (/Views|Reposts|Likes|Bookmarks/i.test(t)) continue;
		if (/·|\b\d{4}\b|^\d+[smhd]$|^[A-Z][a-z]{2} \d/.test(t)) {
			date = parseTweetDateText(t);
			permalink = a.href;
			break;
		}
	}
	if (!permalink && statusAnchors[0]) permalink = statusAnchors[0].href;

	// Tweet body: the block <div> carrying whitespace-pre-wrap text (not the
	// header name/handle <a>s, and not inside a nested quoted tweet).
	let textEl: HTMLElement | null = null;
	art.querySelectorAll<HTMLElement>('div.whitespace-pre-wrap, div[class*="whitespace-pre-wrap"]').forEach(el => {
		if (el.closest('article[data-tweet-id]') !== art) return;
		if (el.closest('[data-slot="hover-card-trigger"]')) return;
		const len = (el.textContent ?? '').trim().length;
		if (len === 0) return;
		if (!textEl || len > (textEl.textContent ?? '').trim().length) textEl = el;
	});
	const rawText = textEl ? ((textEl as HTMLElement).textContent ?? '') : '';
	const textLines = splitLines(rawText);

	const images: { src: string; alt: string }[] = [];
	art.querySelectorAll<HTMLImageElement>('img[src*="pbs.twimg.com/media"]').forEach(img => {
		if (img.closest('article[data-tweet-id]') !== art) return;
		const src = upgradeMediaSrc(img.getAttribute('src') ?? '');
		const alt = (img.getAttribute('alt') ?? '').replace(/\s+/g, ' ').trim();
		if (src) images.push({ src, alt });
	});

	const nested = Array.from(art.querySelectorAll<HTMLElement>('article[data-tweet-id]')).find(n => n !== art);
	const quoted = nested ? parseNewTweet(nested) : null;

	return { id, name, handle, date, permalink, textLines, images, quoted };
}

function collectNew(doc: Document, statusId: string): Collected | null {
	const articles = Array.from(doc.querySelectorAll<HTMLElement>('article[data-tweet-id]')).filter(
		art => art.parentElement?.closest('article[data-tweet-id]') == null
	);
	if (articles.length === 0) return null;
	const mainArt = articles.find(a => a.getAttribute('data-tweet-id') === statusId) ?? articles[0];
	const mainIndex = articles.indexOf(mainArt);
	return {
		main: parseNewTweet(mainArt),
		rest: articles.slice(mainIndex + 1).map(parseNewTweet),
	};
}

// ---------------------------------------------------------------------------
// Classic markup: article[data-testid="tweet"] + [data-testid="tweetText"]
// ---------------------------------------------------------------------------

/**
 * Convert a `[data-testid="tweetText"]` element to plain text lines, preserving
 * the tweet's `\n` line breaks (which the generic reader collapses). Emoji are
 * rendered as `<img alt>` inline — swap each for its alt so it survives as text.
 */
function classicTweetTextLines(textEl: HTMLElement): string[] {
	const clone = textEl.cloneNode(true) as HTMLElement;
	clone.querySelectorAll('img').forEach(img => {
		const alt = img.getAttribute('alt') ?? '';
		img.replaceWith(clone.ownerDocument.createTextNode(alt));
	});
	return splitLines(clone.textContent ?? '');
}

function parseClassicTweet(art: HTMLElement): ParsedTweet {
	// Name + handle from the User-Name block.
	const nameEl = art.querySelector('[data-testid="User-Name"]');
	const links = nameEl ? Array.from(nameEl.querySelectorAll('a')) : [];
	let name = links[0]?.textContent?.trim() ?? '';
	let handle = '';
	for (const a of links) {
		const t = a.textContent?.trim() ?? '';
		if (t.startsWith('@')) {
			handle = t;
			break;
		}
	}
	if (name.startsWith('@')) name = '';

	// Date + permalink from the timestamp.
	const time = art.querySelector('time');
	const datetime = time?.getAttribute('datetime') ?? '';
	let date = '';
	if (datetime) {
		const parsed = new Date(datetime);
		if (!Number.isNaN(parsed.getTime())) date = parsed.toISOString().split('T')[0];
	}
	const permalink = (time?.closest('a') as HTMLAnchorElement | null)?.href ?? '';

	// Body text (first tweetText in the article; a quoted tweet has its own).
	const textEl = art.querySelector<HTMLElement>('[data-testid="tweetText"]');
	const textLines = textEl ? classicTweetTextLines(textEl) : [];

	// Media images.
	const images: { src: string; alt: string }[] = [];
	const seen = new Set<string>();
	art.querySelectorAll<HTMLImageElement>('[data-testid="tweetPhoto"] img, img[src*="pbs.twimg.com/media"]').forEach(img => {
		const alt = (img.getAttribute('alt') ?? '').replace(/\s+/g, ' ').trim();
		const src = upgradeMediaSrc(img.getAttribute('src') ?? '');
		if (!src || seen.has(src)) return;
		seen.add(src);
		images.push({ src, alt });
	});

	return { id: '', name, handle, date, permalink, textLines, images, quoted: null };
}

function collectClassic(doc: Document, statusId: string): Collected | null {
	// Top-level tweet articles in document order (quoted tweets are not
	// `article[data-testid="tweet"]`, so they're naturally excluded).
	const articles = Array.from(doc.querySelectorAll<HTMLElement>('article[data-testid="tweet"]')).filter(
		art => art.parentElement?.closest('article[data-testid="tweet"]') == null
	);
	if (articles.length === 0) return null;
	// The focused (main) tweet is the one whose permalink carries the status id.
	const mainArt =
		articles.find(a => a.querySelector(`a[href*="/status/${statusId}"]`)) ?? articles[0];
	const mainIndex = articles.indexOf(mainArt);
	return {
		main: parseClassicTweet(mainArt),
		rest: articles.slice(mainIndex + 1).map(parseClassicTweet),
	};
}

// ---------------------------------------------------------------------------
// Shared HTML building
// ---------------------------------------------------------------------------

function splitLines(raw: string): string[] {
	return raw
		.split('\n')
		.map(line => line.trim())
		.filter(line => line.length > 0);
}

function tweetBodyHtml(tweet: ParsedTweet): string {
	const parts: string[] = [];
	for (const line of tweet.textLines) parts.push(`<p>${escapeHtml(line)}</p>`);
	for (const img of tweet.images) {
		parts.push(`<img src="${escapeHtml(img.src)}" alt="${escapeHtml(img.alt)}" />`);
	}
	if (tweet.quoted) {
		const q = tweet.quoted;
		const header = q.name || q.handle
			? `<p><strong>${escapeHtml([q.name, q.handle].filter(Boolean).join(' '))}</strong>${q.date ? ` · ${escapeHtml(q.date)}` : ''}</p>`
			: '';
		parts.push(`<blockquote>${header}${tweetBodyHtml(q)}</blockquote>`);
	}
	return parts.join('\n');
}

function replyHtml(reply: ParsedTweet): string {
	const authorLine = [reply.name, reply.handle].filter(Boolean).join(' ');
	const dateHtml = reply.permalink
		? `<a href="${escapeHtml(reply.permalink)}">${escapeHtml(reply.date || 'link')}</a>`
		: escapeHtml(reply.date);
	const meta = authorLine
		? `<p><strong>${escapeHtml(authorLine)}</strong>${reply.date || reply.permalink ? ` · ${dateHtml}` : ''}</p>`
		: '';
	return `<blockquote>${meta}${tweetBodyHtml(reply)}</blockquote>`;
}

/**
 * Extract a clean X post (+ self-reply thread + replies) from either the classic
 * or the new markup. Returns null when the page can't be parsed as an X status
 * page. Callers should only invoke this when defuddle fell back to its generic
 * reader (no `extractorType`).
 */
export function extractXPost(doc: Document, url: string): XPostOverride | null {
	if (!STATUS_URL_RE.test(url)) return null;
	const statusId = getStatusId(url);

	const collected = doc.querySelector('article[data-tweet-id]')
		? collectNew(doc, statusId)
		: doc.querySelector('article[data-testid="tweet"]')
			? collectClassic(doc, statusId)
			: null;
	if (!collected) return null;

	const { main, rest } = collected;
	if (main.textLines.length === 0 && main.images.length === 0) return null;

	// Self-replies by the main author at the top of the timeline are part of the
	// post (a thread); everything after the first reply by someone else is a reply.
	const thread: ParsedTweet[] = [];
	const replies: ParsedTweet[] = [];
	let threadEnded = false;
	for (const t of rest) {
		if (!threadEnded && main.handle && t.handle === main.handle) {
			thread.push(t);
		} else {
			threadEnded = true;
			replies.push(t);
		}
	}

	const postParts = [tweetBodyHtml(main), ...thread.map(tweetBodyHtml)];
	let html = `<div class="x-post">${postParts.join('\n<hr>\n')}</div>`;
	if (replies.length > 0) {
		html += `\n<hr>\n<div class="x-replies"><h2>Replies</h2>\n${replies.map(replyHtml).join('\n')}</div>`;
	}

	const author = main.handle || main.name || '';
	const description = main.textLines.join(' ').slice(0, 140).replace(/\s+/g, ' ').trim();
	const title = author ? `Post by ${author} on X` : 'Post on X';

	return {
		content: html,
		title,
		author,
		site: 'X (Twitter)',
		description,
		published: main.date || undefined,
		extractedContent: { tweetId: statusId, tweetAuthor: author },
	};
}
