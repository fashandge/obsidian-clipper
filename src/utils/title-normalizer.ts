const URL_IN_TEXT_RE = /https?:\/\/\S+|www\.\S+/gi;
const SINGLE_MARKDOWN_LINK_RE = /^\[([^\]]+)\]\([^)]+\)$/;
const TRUNCATION_BOUNDARY_RE = /[.!?。？！]/g;
const TRAILING_SHARP_RE = /\b([A-Za-z0-9]+)#(?=[^A-Za-z0-9]|$)/g;
const TAIL_STOPWORD_RE = /^(?:a|an|the|and|or|but|to|of|for|in|on|with|by|from)$/i;
const NORMALIZED_TITLE_MAX_BYTES = 120;
const NORMALIZED_TITLE_MAX_WORDS = 20;

function stripTrailingFilenamePunctuation(text: string): string {
	return text.replace(/[ \t.,!?;:'"`~…。，、！？：；]+$/g, '').trim();
}

function cleanupTruncatedTail(text: string): string {
	const boundaryMatches = [...text.matchAll(TRUNCATION_BOUNDARY_RE)];
	TRUNCATION_BOUNDARY_RE.lastIndex = 0;

	if (boundaryMatches.length === 0) {
		return text;
	}

	const lastBoundary = boundaryMatches[boundaryMatches.length - 1];
	const boundaryIndex = lastBoundary.index ?? -1;
	if (boundaryIndex < 0) {
		return text;
	}

	const head = text.slice(0, boundaryIndex).trimEnd();
	const tail = text.slice(boundaryIndex + lastBoundary[0].length).trim();
	if (!head || !tail) {
		return text;
	}

	const tailWords = tail.split(/\s+/).filter((word) => !TAIL_STOPWORD_RE.test(word));
	const cleanedTail = tailWords.join(' ').trim();
	if (tailWords.length < 4 && cleanedTail.length < 8) {
		return stripTrailingFilenamePunctuation(head);
	}

	return text;
}

function truncateUtf8Bytes(value: string, maxBytes: number): string {
	const encoder = new TextEncoder();
	let result = '';
	let byteLength = 0;

	for (const char of value) {
		const charByteLength = encoder.encode(char).length;
		if (byteLength + charByteLength > maxBytes) {
			break;
		}
		result += char;
		byteLength += charByteLength;
	}

	return result;
}

export function normalizeTitleForFileName(title: string): string {
	let name = title.normalize('NFC');
	name = name.replace(URL_IN_TEXT_RE, ' ');
	name = name.replace(/\s*:\s*/g, ' - ');
	name = name.replace(TRAILING_SHARP_RE, '$1 sharp');
	name = name.replace(/\[/g, '(').replace(/\]/g, ')');
	name = name.replace(/\s*\|\s*/g, ' - ');
	name = name.replace(/\^/g, ' ');
	name = name.replace(/#/g, ' ');
	name = name.replace(/[\/\x00]/g, '-');
	name = name.replace(/\s+/g, ' ').trim();
	name = name.replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');
	name = stripTrailingFilenamePunctuation(name);

	let wasTruncated = false;
	const words = name.split(/\s+/).filter(Boolean);
	if (words.length > NORMALIZED_TITLE_MAX_WORDS) {
		name = words.slice(0, NORMALIZED_TITLE_MAX_WORDS).join(' ');
		name = stripTrailingFilenamePunctuation(name);
		wasTruncated = true;
	}

	while (new TextEncoder().encode(name).length > NORMALIZED_TITLE_MAX_BYTES && name) {
		wasTruncated = true;
		const parts = name.split(/\s+/).filter(Boolean);
		if (parts.length > 1) {
			name = parts.slice(0, -1).join(' ');
		} else {
			name = truncateUtf8Bytes(name, NORMALIZED_TITLE_MAX_BYTES);
			break;
		}
		name = stripTrailingFilenamePunctuation(name);
	}

	name = stripTrailingFilenamePunctuation(name);
	if (wasTruncated) {
		name = cleanupTruncatedTail(name);
	}

	return name || 'untitled';
}

export function extractTitleFromSingleMarkdownLink(text: string): string | null {
	const match = SINGLE_MARKDOWN_LINK_RE.exec(text.trim());
	return match ? match[1].trim() : null;
}
