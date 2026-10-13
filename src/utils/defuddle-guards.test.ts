// @vitest-environment jsdom
import { describe, test, expect, beforeEach } from 'vitest';
import Defuddle from 'defuddle';
import { shieldContentDateAttributes, withShieldedContent } from './defuddle-guards';

const PARAGRAPH = 'This sentence is filler prose standing in for the body of a blog post. ';

// Reduced from the Ghost theme on felixrieseberg.com: the body container
// carries `data-date`, which defuddle's `[data-date]` clutter selector removes.
function ghostMarkup(): string {
	return `
	<main id="app">
		<article class="post">
			<header class="phead">
				<h1>A post title</h1>
				<time class="badge" data-date="2026-10-13">13 October 2026</time>
			</header>
			<div class="content gh-content" data-slug="a-post" data-date="2026-10-13">
				<p>${PARAGRAPH.repeat(8)}</p>
				<h2>Section</h2>
				<p>${PARAGRAPH.repeat(8)}</p>
			</div>
		</article>
	</main>`;
}

describe('shieldContentDateAttributes', () => {
	beforeEach(() => {
		document.body.innerHTML = ghostMarkup();
	});

	test('removes data-date only from content containers and restores it', () => {
		const body = document.querySelector('.gh-content')!;
		const badge = document.querySelector('.badge')!;

		const restore = shieldContentDateAttributes(document);
		expect(body.hasAttribute('data-date')).toBe(false);
		expect(badge.getAttribute('data-date')).toBe('2026-10-13');

		restore();
		expect(body.getAttribute('data-date')).toBe('2026-10-13');
	});

	test('defuddle keeps the article body when shielded', () => {
		const unshielded = new Defuddle(document, { url: 'https://example.com/a-post/' }).parse();
		expect(unshielded.content).not.toContain('filler prose');

		const shielded = withShieldedContent(document, () =>
			new Defuddle(document, { url: 'https://example.com/a-post/' }).parse());
		expect(shielded.content).toContain('filler prose');
		expect(document.querySelector('.gh-content')!.getAttribute('data-date')).toBe('2026-10-13');
	});
});
