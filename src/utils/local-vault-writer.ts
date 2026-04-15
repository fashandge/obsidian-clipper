import { Template } from '../types/types';
import { getStoredLocalVaultHandle } from './local-vault-storage';
import { normalizeTitleForFileName } from './title-normalizer';

export class LocalVaultWriteError extends Error {
	code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = 'LocalVaultWriteError';
		this.code = code;
	}
}

export interface LocalVaultWriterDependencies {
	getVaultHandle: (vaultName: string) => Promise<FileSystemDirectoryHandle | null>;
}

const defaultDependencies: LocalVaultWriterDependencies = {
	getVaultHandle: getStoredLocalVaultHandle,
};

const LOCAL_HANDLE_NAME_MAX_BYTES = 180;
const MARKDOWN_EXTENSION = '.md';

export function splitFrontmatter(content: string): { frontmatter: string; body: string } {
	if (!content.startsWith('---\n') && !content.startsWith('---\r\n')) {
		return { frontmatter: '', body: content };
	}

	const match = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
	if (!match) {
		return { frontmatter: '', body: content };
	}

	return {
		frontmatter: match[0],
		body: content.slice(match[0].length),
	};
}

function normalizeSectionBreaks(content: string): string {
	return content.replace(/^\n+/, '').replace(/\n+$/, '');
}

function removeUnpairedSurrogates(value: string): string {
	let result = '';

	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		const isHighSurrogate = code >= 0xD800 && code <= 0xDBFF;
		const isLowSurrogate = code >= 0xDC00 && code <= 0xDFFF;

		if (isHighSurrogate) {
			const nextCode = value.charCodeAt(index + 1);
			if (nextCode >= 0xDC00 && nextCode <= 0xDFFF) {
				result += value[index] + value[index + 1];
				index += 1;
			}
			continue;
		}

		if (!isLowSurrogate) {
			result += value[index];
		}
	}

	return result;
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

export function sanitizeFileSystemAccessName(
	name: string,
	fallback = 'Untitled',
	maxBytes = LOCAL_HANDLE_NAME_MAX_BYTES
): string {
	let sanitized = removeUnpairedSurrogates(name.normalize('NFKC'))
		.replace(/[<>:"\/\\|?*\x00-\x1F\x7F-\x9F]/g, '')
		.replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, '')
		.replace(/\s+/g, ' ')
		.replace(/^[.\s]+/, '')
		.replace(/[.\s]+$/, '')
		.trim();

	sanitized = truncateUtf8Bytes(sanitized, maxBytes)
		.replace(/[.\s]+$/, '')
		.trim();

	if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i.test(sanitized)) {
		sanitized = `_${sanitized}`;
		sanitized = truncateUtf8Bytes(sanitized, maxBytes).replace(/[.\s]+$/, '').trim();
	}

	if (!sanitized || sanitized === '.' || sanitized === '..') {
		return fallback;
	}

	return sanitized;
}

export function buildLocalVaultFileName(noteName: string): string {
	const rawName = noteName || 'Untitled';
	const withoutMarkdownExtension = rawName.toLowerCase().endsWith(MARKDOWN_EXTENSION)
		? rawName.slice(0, -MARKDOWN_EXTENSION.length)
		: rawName;
	const normalizedName = normalizeTitleForFileName(withoutMarkdownExtension);
	const sanitizedBaseName = sanitizeFileSystemAccessName(
		normalizedName,
		'Untitled',
		LOCAL_HANDLE_NAME_MAX_BYTES - MARKDOWN_EXTENSION.length
	);

	return `${sanitizedBaseName}${MARKDOWN_EXTENSION}`;
}

function stableHash(value: string): string {
	let hash = 0x811c9dc5;
	for (let index = 0; index < value.length; index += 1) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(36);
}

export function buildFallbackLocalVaultFileName(noteName: string): string {
	const asciiBaseName = sanitizeFileSystemAccessName(noteName || 'Untitled', 'Untitled', 80)
		.normalize('NFKD')
		.replace(/[^\w .-]/g, '')
		.replace(/\s+/g, '-')
		.replace(/^-+|-+$/g, '');
	const baseName = asciiBaseName || 'Untitled';

	return `${sanitizeFileSystemAccessName(`${baseName}-${stableHash(noteName || 'Untitled')}`, 'Untitled', 96)}${MARKDOWN_EXTENSION}`;
}

function isHandleNameError(error: unknown): boolean {
	return error instanceof TypeError && /name is not allowed/i.test(error.message);
}

export function mergeNoteContent(
	behavior: Template['behavior'],
	existingContent: string,
	newContent: string
): string {
	const existing = splitFrontmatter(existingContent);
	const next = splitFrontmatter(newContent);

	if (behavior === 'overwrite') {
		return newContent;
	}

	if (behavior === 'create') {
		return newContent;
	}

	const existingBody = normalizeSectionBreaks(existing.body);
	const nextBody = normalizeSectionBreaks(next.body);

	if (behavior === 'append-specific') {
		const mergedBody = [existingBody, nextBody].filter(Boolean).join('\n\n');
		return `${existing.frontmatter}${mergedBody}`.trimEnd() + '\n';
	}

	if (behavior === 'prepend-specific') {
		const mergedBody = [nextBody, existingBody].filter(Boolean).join('\n\n');
		return `${existing.frontmatter}${mergedBody}`.trimEnd() + '\n';
	}

	return newContent;
}

export function splitVaultPath(path: string): string[] {
	return path
		.split('/')
		.map((segment) => segment.trim())
		.map((segment) => sanitizeFileSystemAccessName(segment, ''))
		.filter((segment) => segment !== '');
}

async function getNestedDirectoryHandle(
	rootHandle: FileSystemDirectoryHandle,
	segments: string[]
): Promise<FileSystemDirectoryHandle> {
	let currentHandle = rootHandle;

	for (const segment of segments) {
		currentHandle = await currentHandle.getDirectoryHandle(segment, { create: true });
	}

	return currentHandle;
}

async function fileExists(
	directoryHandle: FileSystemDirectoryHandle,
	fileName: string
): Promise<boolean> {
	try {
		await directoryHandle.getFileHandle(fileName);
		return true;
	} catch (error) {
		if (error instanceof DOMException && error.name === 'NotFoundError') {
			return false;
		}
		throw error;
	}
}

async function readExistingFile(
	directoryHandle: FileSystemDirectoryHandle,
	fileName: string
): Promise<string | null> {
	try {
		const fileHandle = await directoryHandle.getFileHandle(fileName);
		const file = await fileHandle.getFile();
		return file.text();
	} catch (error) {
		if (error instanceof DOMException && error.name === 'NotFoundError') {
			return null;
		}
		throw error;
	}
}

async function ensureReadWritePermission(
	handle: FileSystemDirectoryHandle,
	{ allowPermissionPrompt = true }: { allowPermissionPrompt?: boolean } = {}
): Promise<void> {
	const currentPermission = handle.queryPermission
		? await handle.queryPermission({ mode: 'readwrite' })
		: 'prompt';
	if (currentPermission === 'granted') {
		return;
	}
	if (!allowPermissionPrompt) {
		throw new LocalVaultWriteError(
			'permission-denied',
			'Chrome needs an explicit click before it can restore write access to this vault folder. Click Save again or reconnect the folder in settings.'
		);
	}

	let requestedPermission: PermissionState | 'prompt' = 'prompt';
	try {
		requestedPermission = handle.requestPermission
			? await handle.requestPermission({ mode: 'readwrite' })
			: 'prompt';
	} catch (error) {
		if (error instanceof DOMException && error.name === 'SecurityError') {
			throw new LocalVaultWriteError(
				'permission-denied',
				'Chrome needs an explicit click before it can restore write access to this vault folder. Click Save again or reconnect the folder in settings.'
			);
		}
		throw error;
	}
	if (requestedPermission !== 'granted') {
		throw new LocalVaultWriteError(
			'permission-denied',
			'Chrome can no longer write to this vault folder. Reconnect the folder in settings and try again.'
		);
	}
}

export interface SaveToLocalVaultParams {
	fileContent: string;
	noteName: string;
	path: string;
	vault: string;
	behavior: Template['behavior'];
	allowPermissionPrompt?: boolean;
}

async function writeMarkdownFile(
	directoryHandle: FileSystemDirectoryHandle,
	fileName: string,
	params: SaveToLocalVaultParams
): Promise<void> {
	const existingContent = await readExistingFile(directoryHandle, fileName);
	if (params.behavior === 'create' && existingContent !== null) {
		throw new LocalVaultWriteError(
			'file-exists',
			'A note with this name already exists in the selected local folder.'
		);
	}

	const nextContent = existingContent === null
		? params.fileContent
		: mergeNoteContent(params.behavior, existingContent, params.fileContent);

	const fileHandle = await directoryHandle.getFileHandle(fileName, { create: true });
	const writable = await fileHandle.createWritable();
	await writable.write(nextContent);
	await writable.close();
}

export async function saveToLocalVault(
	params: SaveToLocalVaultParams,
	dependencies: LocalVaultWriterDependencies = defaultDependencies
): Promise<void> {
	if (params.behavior === 'append-daily' || params.behavior === 'prepend-daily') {
		throw new LocalVaultWriteError('daily-notes-unsupported', 'Daily note saves should use the Obsidian URI flow.');
	}

	if (!params.vault) {
		throw new LocalVaultWriteError('missing-vault', 'Choose a vault before saving to a local folder.');
	}

	const vaultHandle = await dependencies.getVaultHandle(params.vault);
	if (!vaultHandle) {
		throw new LocalVaultWriteError(
			'missing-binding',
			'This vault is not connected to a local folder yet. Choose a folder in settings first.'
		);
	}

	await ensureReadWritePermission(vaultHandle, {
		allowPermissionPrompt: params.allowPermissionPrompt ?? true,
	});

	const directoryHandle = await getNestedDirectoryHandle(vaultHandle, splitVaultPath(params.path));
	const fileName = buildLocalVaultFileName(params.noteName);
	try {
		await writeMarkdownFile(directoryHandle, fileName, params);
	} catch (error) {
		const fallbackFileName = buildFallbackLocalVaultFileName(params.noteName);
		if (isHandleNameError(error) && fallbackFileName !== fileName) {
			await writeMarkdownFile(directoryHandle, fallbackFileName, params);
			return;
		}
		throw error;
	}
}
