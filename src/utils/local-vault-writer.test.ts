import { describe, expect, test } from 'vitest';
import { LocalVaultWriteError, mergeNoteContent, saveToLocalVault, splitFrontmatter, splitVaultPath } from './local-vault-writer';

class FakeWritableFileStream {
	private readonly commit: (content: string) => void;
	private buffer = '';

	constructor(commit: (content: string) => void) {
		this.commit = commit;
	}

	async write(content: string): Promise<void> {
		this.buffer = content;
	}

	async close(): Promise<void> {
		this.commit(this.buffer);
	}
}

class FakeFileHandle {
	private readonly readContent: () => string;
	private readonly writeContent: (content: string) => void;

	constructor(readContent: () => string, writeContent: (content: string) => void) {
		this.readContent = readContent;
		this.writeContent = writeContent;
	}

	async getFile(): Promise<{ text: () => Promise<string> }> {
		return {
			text: async () => this.readContent(),
		};
	}

	async createWritable(): Promise<FakeWritableFileStream> {
		return new FakeWritableFileStream(this.writeContent);
	}
}

class FakeDirectoryHandle {
	kind = 'directory' as const;
	name: string;
	permission: PermissionState;
	files = new Map<string, string>();
	directories = new Map<string, FakeDirectoryHandle>();

	constructor(name: string, permission: PermissionState = 'granted') {
		this.name = name;
		this.permission = permission;
	}

	async queryPermission(): Promise<PermissionState> {
		return this.permission;
	}

	async requestPermission(): Promise<PermissionState> {
		return this.permission;
	}

	async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<FakeDirectoryHandle> {
		const existing = this.directories.get(name);
		if (existing) {
			return existing;
		}
		if (options?.create) {
			const created = new FakeDirectoryHandle(name, this.permission);
			this.directories.set(name, created);
			return created;
		}
		throw new DOMException('Directory not found', 'NotFoundError');
	}

	async getFileHandle(name: string, options?: { create?: boolean }): Promise<FakeFileHandle> {
		if (this.files.has(name)) {
			return new FakeFileHandle(
				() => this.files.get(name) || '',
				(content) => this.files.set(name, content)
			);
		}

		if (options?.create) {
			this.files.set(name, '');
			return new FakeFileHandle(
				() => this.files.get(name) || '',
				(content) => this.files.set(name, content)
			);
		}

		throw new DOMException('File not found', 'NotFoundError');
	}
}

describe('splitFrontmatter', () => {
	test('returns frontmatter and body separately', () => {
		expect(splitFrontmatter('---\ntitle: Test\n---\nBody text')).toEqual({
			frontmatter: '---\ntitle: Test\n---\n',
			body: 'Body text',
		});
	});

	test('returns empty frontmatter when content has none', () => {
		expect(splitFrontmatter('Body only')).toEqual({
			frontmatter: '',
			body: 'Body only',
		});
	});
});

describe('mergeNoteContent', () => {
	test('appends body content while preserving existing frontmatter', () => {
		const existing = '---\nfoo: bar\n---\nExisting body';
		const incoming = '---\nnew: value\n---\nNew body';
		expect(mergeNoteContent('append-specific', existing, incoming)).toBe(
			'---\nfoo: bar\n---\nExisting body\n\nNew body\n'
		);
	});

	test('prepends body content while preserving existing frontmatter', () => {
		const existing = '---\nfoo: bar\n---\nExisting body';
		const incoming = '---\nnew: value\n---\nNew body';
		expect(mergeNoteContent('prepend-specific', existing, incoming)).toBe(
			'---\nfoo: bar\n---\nNew body\n\nExisting body\n'
		);
	});
});

describe('splitVaultPath', () => {
	test('removes empty and traversal-like segments', () => {
		expect(splitVaultPath('/Articles//2026/./../Drafts/')).toEqual(['Articles', '2026', 'Drafts']);
	});
});

describe('saveToLocalVault', () => {
	test('creates nested directories and writes a new file', async () => {
		const root = new FakeDirectoryHandle('Vault');

		await saveToLocalVault({
			fileContent: '---\ntitle: Test\n---\nBody',
			noteName: 'Clip Note',
			path: 'Articles/Inbox',
			vault: 'Main Vault',
			behavior: 'create',
		}, {
			getVaultHandle: async () => root as unknown as FileSystemDirectoryHandle,
		});

		expect(root.directories.get('Articles')?.directories.get('Inbox')?.files.get('Clip Note.md')).toBe(
			'---\ntitle: Test\n---\nBody'
		);
	});

	test('overwrites an existing file for overwrite behavior', async () => {
		const root = new FakeDirectoryHandle('Vault');
		root.files.set('Existing.md', 'Old content');

		await saveToLocalVault({
			fileContent: '---\ntitle: Test\n---\nReplacement',
			noteName: 'Existing',
			path: '',
			vault: 'Main Vault',
			behavior: 'overwrite',
		}, {
			getVaultHandle: async () => root as unknown as FileSystemDirectoryHandle,
		});

		expect(root.files.get('Existing.md')).toBe('---\ntitle: Test\n---\nReplacement');
	});

	test('appends body content and keeps existing frontmatter', async () => {
		const root = new FakeDirectoryHandle('Vault');
		root.files.set('Existing.md', '---\nfoo: bar\n---\nExisting');

		await saveToLocalVault({
			fileContent: '---\nnew: value\n---\nIncoming',
			noteName: 'Existing',
			path: '',
			vault: 'Main Vault',
			behavior: 'append-specific',
		}, {
			getVaultHandle: async () => root as unknown as FileSystemDirectoryHandle,
		});

		expect(root.files.get('Existing.md')).toBe('---\nfoo: bar\n---\nExisting\n\nIncoming\n');
	});

	test('throws when create behavior targets an existing file', async () => {
		const root = new FakeDirectoryHandle('Vault');
		root.files.set('Existing.md', 'Old content');

		await expect(saveToLocalVault({
			fileContent: 'New content',
			noteName: 'Existing',
			path: '',
			vault: 'Main Vault',
			behavior: 'create',
		}, {
			getVaultHandle: async () => root as unknown as FileSystemDirectoryHandle,
		})).rejects.toMatchObject({
			code: 'file-exists',
		});
	});

	test('throws when the vault folder binding is missing', async () => {
		await expect(saveToLocalVault({
			fileContent: 'Body',
			noteName: 'Missing',
			path: '',
			vault: 'Main Vault',
			behavior: 'create',
		}, {
			getVaultHandle: async () => null,
		})).rejects.toMatchObject({
			code: 'missing-binding',
		});
	});

	test('throws when permission is no longer granted', async () => {
		const root = new FakeDirectoryHandle('Vault', 'denied');

		await expect(saveToLocalVault({
			fileContent: 'Body',
			noteName: 'Clip',
			path: '',
			vault: 'Main Vault',
			behavior: 'create',
		}, {
			getVaultHandle: async () => root as unknown as FileSystemDirectoryHandle,
		})).rejects.toMatchObject({
			code: 'permission-denied',
		});
	});

	test('rejects daily note behaviors in local vault mode', async () => {
		const root = new FakeDirectoryHandle('Vault');

		await expect(saveToLocalVault({
			fileContent: 'Body',
			noteName: 'Clip',
			path: '',
			vault: 'Main Vault',
			behavior: 'append-daily',
		}, {
			getVaultHandle: async () => root as unknown as FileSystemDirectoryHandle,
		})).rejects.toMatchObject({
			code: 'daily-notes-unsupported',
		});
	});
});
