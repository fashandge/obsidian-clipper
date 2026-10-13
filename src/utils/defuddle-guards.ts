// Fork-local workarounds for defuddle clutter selectors that delete real
// article bodies.
//
// defuddle's EXACT_SELECTORS list contains `[data-date]`, aimed at small date
// badges. Some themes (e.g. the Ghost theme on felixrieseberg.com) put
// `data-date` on the article body container itself
// (`<div class="content gh-content" data-date="...">`), so defuddle removes the
// entire body on every retry pass and the clip ends up empty.
//
// defuddle clones the live document internally and needs the live window for
// computed styles, so we can't hand it a pre-cleaned copy. Instead the
// attribute is removed from qualifying elements for the duration of the parse
// and restored afterwards.

// A date badge never holds paragraphs of prose; a body container always does.
const MIN_CONTAINER_TEXT_LENGTH = 200;

function isContentContainer(el: Element): boolean {
	return !!el.querySelector('p') && (el.textContent || '').trim().length >= MIN_CONTAINER_TEXT_LENGTH;
}

/** Remove `data-date` from content containers; returns a function that restores it. */
export function shieldContentDateAttributes(doc: Document): () => void {
	const shielded: Array<[Element, string]> = [];
	doc.querySelectorAll('[data-date]').forEach(el => {
		if (isContentContainer(el)) {
			shielded.push([el, el.getAttribute('data-date') || '']);
			el.removeAttribute('data-date');
		}
	});
	return () => {
		for (const [el, value] of shielded) el.setAttribute('data-date', value);
	};
}

/** Run `parse` with content containers shielded from defuddle's `[data-date]` selector. */
export function withShieldedContent<T>(doc: Document, parse: () => T): T {
	const restore = shieldContentDateAttributes(doc);
	try {
		return parse();
	} finally {
		restore();
	}
}

/** Async variant of withShieldedContent. */
export async function withShieldedContentAsync<T>(doc: Document, parse: () => Promise<T>): Promise<T> {
	const restore = shieldContentDateAttributes(doc);
	try {
		return await parse();
	} finally {
		restore();
	}
}
