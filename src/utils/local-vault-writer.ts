import { Template } from '../types/types';
import { sanitizeFileName } from './string-utils';
import { getStoredLocalVaultHandle } from './local-vault-storage';

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
		.filter((segment) => segment !== '' && segment !== '.' && segment !== '..');
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

async function ensureReadWritePermission(handle: FileSystemDirectoryHandle): Promise<void> {
	const currentPermission = handle.queryPermission
		? await handle.queryPermission({ mode: 'readwrite' })
		: 'prompt';
	if (currentPermission === 'granted') {
		return;
	}

	const requestedPermission = handle.requestPermission
		? await handle.requestPermission({ mode: 'readwrite' })
		: 'prompt';
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

	await ensureReadWritePermission(vaultHandle);

	const directoryHandle = await getNestedDirectoryHandle(vaultHandle, splitVaultPath(params.path));
	const sanitizedFileName = sanitizeFileName(params.noteName || 'Untitled');
	const fileName = sanitizedFileName.toLowerCase().endsWith('.md')
		? sanitizedFileName
		: `${sanitizedFileName}.md`;

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
