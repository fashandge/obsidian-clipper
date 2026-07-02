// Fork-local extractor for X's (Twitter's) newer lightweight web front-end.
//
// Background: defuddle ships a `TwitterExtractor` that keys off the classic
// React SPA markup (`article[data-testid="tweet"]`, `[data-testid="tweetText"]`,
// `[data-testid="User-Name"]`, …). X has begun serving a different, Tailwind-based
// page whose tweets are `article[data-tweet-id]` elements with `whitespace-pre-wrap`
// text nodes and NO `data-testid` attributes at all. On those pages defuddle's
// `canExtract()` returns false, so it falls back to its generic reader, which
// scrapes the surrounding UI chrome AND collapses the tweet's CSS-preserved
// newlines (`white-space: pre-wrap`, no `<br>`/`<p>`) into a single dense
// paragraph.
//
// This module detects that new markup and produces clean HTML (paragraphs,
// images, replies as blockquotes) mirroring defuddle's TwitterExtractor output,
// so the existing `createMarkdownContent` pipeline yields a readable note.
//
// It is intentionally scoped to ONLY the new markup: when X serves the classic
// `data-testid` markup, `isNewXPostPage()` returns false and defuddle's own
// TwitterExtractor keeps handling it. See docs/design/fork-additions.md.

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

/**
 * True when the current page is an X/Twitter status page rendered with the new
 * `article[data-tweet-id]` markup and WITHOUT the classic `data-testid` markup
 * that defuddle already handles.
 */
export function isNewXPostPage(doc: Document, url: string): boolean {
	if (!STATUS_URL_RE.test(url)) return false;
	// If the classic markup is present, let defuddle's TwitterExtractor handle it.
	if (doc.querySelector('article[data-testid="tweet"], [data-testid="tweetText"]')) {
		return false;
	}
	return !!doc.querySelector('article[data-tweet-id]');
}

function getStatusId(url: string): string {
	return url.match(STATUS_URL_RE)?.[1] ?? '';
}

/** Top-level tweet articles (excludes quoted tweets nested inside another article). */
function topLevelArticles(doc: Document): HTMLElement[] {
	return Array.from(doc.querySelectorAll<HTMLElement>('article[data-tweet-id]')).filter(
		art => art.parentElement?.closest('article[data-tweet-id]') == null
	);
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

function ownAnchors(root: HTMLElement): HTMLAnchorElement[] {
	// Anchors that belong to THIS tweet (not a nested quoted tweet).
	return Array.from(root.querySelectorAll<HTMLAnchorElement>('a[href]')).filter(
		a => a.closest('article[data-tweet-id]') === root
	);
}

function parseTweetDate(text: string): string {
	// Main tweet timestamp reads like "9:45 PM · Jul 1, 2026"; take the date part.
	const datePart = text.includes('·') ? text.split('·').pop()!.trim() : text.trim();
	const parsed = new Date(datePart);
	if (!Number.isNaN(parsed.getTime())) {
		return parsed.toISOString().split('T')[0];
	}
	return '';
}

function extractTweet(art: HTMLElement, doc: Document): ParsedTweet {
	const id = art.getAttribute('data-tweet-id') ?? '';

	// Author name + handle come from the header profile links. Scan all anchors
	// owned by this tweet: the handle is the "@name" link; the display name is the
	// first profile link that isn't the handle, a status/permalink, or a stat.
	const anchors = ownAnchors(art);
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
	// Fallback: derive handle from a profile link path.
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
		// Absolute ("Jul 1, 2026") or relative ("19h", "2m") timestamp, but not stats.
		if (/Views|Reposts|Likes|Bookmarks/i.test(t)) continue;
		if (/·|\b\d{4}\b|^\d+[smhd]$|^[A-Z][a-z]{2} \d/.test(t)) {
			date = parseTweetDate(t);
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
	const textLines = rawText
		.split('\n')
		.map(line => line.trim())
		.filter(line => line.length > 0);

	// Media images (exclude avatars and emoji sprites).
	const images: { src: string; alt: string }[] = [];
	art.querySelectorAll<HTMLImageElement>('img[src*="pbs.twimg.com/media"]').forEach(img => {
		if (img.closest('article[data-tweet-id]') !== art) return;
		const src = (img.getAttribute('src') ?? '').replace(/&name=\w+$/, '&name=large');
		const alt = (img.getAttribute('alt') ?? '').replace(/\s+/g, ' ').trim();
		if (src) images.push({ src, alt });
	});

	// Quoted tweet: first nested tweet article.
	const nested = Array.from(art.querySelectorAll<HTMLElement>('article[data-tweet-id]')).find(
		n => n !== art
	);
	const quoted = nested ? extractTweet(nested, doc) : null;

	return { id, name, handle, date, permalink, textLines, images, quoted };
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
 * Extract a clean X post (+ self-reply thread + replies) from the new markup.
 * Returns null when the page can't be parsed as an X status page.
 */
export function extractXPost(doc: Document, url: string): XPostOverride | null {
	if (!isNewXPostPage(doc, url)) return null;

	const statusId = getStatusId(url);
	const articles = topLevelArticles(doc);
	if (articles.length === 0) return null;

	const mainArt = articles.find(a => a.getAttribute('data-tweet-id') === statusId) ?? articles[0];
	const main = extractTweet(mainArt, doc);
	if (main.textLines.length === 0 && main.images.length === 0) return null;

	// Classify the remaining articles: self-replies by the main author at the top
	// of the timeline are part of the post (a thread); everything after the first
	// reply by someone else is a reply.
	const mainIndex = articles.indexOf(mainArt);
	const rest = articles.slice(mainIndex + 1).map(a => extractTweet(a, doc));
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

	// Build post content (main tweet + thread, separated by <hr>).
	const postParts = [tweetBodyHtml(main), ...thread.map(tweetBodyHtml)];
	let html = `<div class="x-post">${postParts.join('\n<hr>\n')}</div>`;
	if (replies.length > 0) {
		html += `\n<hr>\n<div class="x-replies"><h2>Replies</h2>\n${replies.map(replyHtml).join('\n')}</div>`;
	}

	const author = main.handle || (main.name ? main.name : '');
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
