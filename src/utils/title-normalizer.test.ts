import { describe, expect, test } from 'vitest';
import { extractTitleFromSingleMarkdownLink, normalizeTitleForFileName } from './title-normalizer';

describe('normalizeTitleForFileName', () => {
	test('strips URLs and trailing punctuation like clipping normalize.py', () => {
		expect(normalizeTitleForFileName(
			'发现一个做 AI SaaS + SEO 的宝藏网站。 https://t.co/bkI5DOlQi6 这是一个专门出售 / 购买高质量 AI 提示词的在线市场。...'
		)).toBe('发现一个做 AI SaaS + SEO 的宝藏网站。 这是一个专门出售 - 购买高质量 AI 提示词的在线市场');
	});

	test('replaces colon with spaced dash like clipping normalize.py', () => {
		expect(normalizeTitleForFileName(
			'6551Team/opennews-mcp: Crypto News Aggregation · AI Ratings · Trading Signals'
		)).toBe('6551Team-opennews-mcp - Crypto News Aggregation · AI Ratings · Trading Signals');
	});

	test('strips Obsidian link unsafe characters like clipping normalize.py', () => {
		expect(normalizeTitleForFileName('Alpha #beta ^block [draft] final | notes')).toBe(
			'Alpha beta block (draft) final - notes'
		);
	});

	test('keeps meaning for trailing sharp like clipping normalize.py', () => {
		expect(normalizeTitleForFileName('C# [guide]')).toBe('C sharp (guide)');
	});

	test('collapses consecutive spaces like clipping normalize.py', () => {
		expect(normalizeTitleForFileName('Alpha   beta    [draft]')).toBe('Alpha beta (draft)');
	});

	test('caps length and word count like clipping normalize.py', () => {
		const normalizedValue = normalizeTitleForFileName(
			'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen '
			+ 'seventeen eighteen nineteen twenty twentyone twentytwo twentythree'
		);

		expect(normalizedValue.split(/\s+/).length).toBeLessThanOrEqual(20);
		expect(new TextEncoder().encode(normalizedValue).length).toBeLessThanOrEqual(120);
		expect(normalizedValue.endsWith('eighteen')).toBe(true);
	});

	test('cleans dangling truncated tail after boundary like clipping normalize.py', () => {
		const normalizedValue = normalizeTitleForFileName(
			'I used the Mythos referenced architecture patterns from the leaked source to restructure '
			+ 'how I prompt Claude Code. The leaked source shows that Claude Code uses a multi-agent orchestration system internally.'
		);

		expect(normalizedValue).toBe(
			'I used the Mythos referenced architecture patterns from the leaked source to restructure '
			+ 'how I prompt Claude Code'
		);
	});

	test('keeps meaningful short tail when not truncated like clipping normalize.py', () => {
		expect(normalizeTitleForFileName('A practical note. Deep dive')).toBe('A practical note. Deep dive');
	});
});

describe('extractTitleFromSingleMarkdownLink', () => {
	test('extracts a title from a single markdown link', () => {
		expect(extractTitleFromSingleMarkdownLink('[Example](https://example.com)')).toBe('Example');
	});

	test('returns null for regular markdown content', () => {
		expect(extractTitleFromSingleMarkdownLink('# Example\n\nBody')).toBeNull();
	});
});
