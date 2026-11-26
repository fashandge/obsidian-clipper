import { describe, expect, test, vi } from 'vitest';
import {
	buildFallbackLocalVaultFileName,
	buildLocalVaultFileName,
	ensureReadWritePermission,
	LocalVaultWriteError,
	mergeNoteContent,
	sanitizeFileSystemAccessName,
	saveToLocalVault,
	splitFrontmatter,
	splitVaultPath
} from './local-vault-writer';
import {
	hasObsidianVaultMarker,
	probeLocalVaultDirectoryHandle,
	queryLocalVaultHandlePermission,
} from './local-vault-storage';

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
	deleted = false;
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

	keys() {
		const entries = [...this.directories.keys(), ...this.files.keys()];
		let index = 0;
		const isDeleted = () => this.deleted;
		return {
			next: async () => {
				if (isDeleted()) {
					throw new DOMException('A requested file or directory could not be found.', 'NotFoundError');
				}
				if (index < entries.length) {
					return { value: entries[index++], done: false };
				}
				return { value: undefined, done: true };
			},
		};
	}

	async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<FakeDirectoryHandle> {
		this.assertAllowedName(name);
		if (this.deleted) {
			throw new DOMException('A requested file or directory could not be found.', 'NotFoundError');
		}

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
		this.assertAllowedName(name);
		if (this.deleted) {
			throw new DOMException('A requested file or directory could not be found.', 'NotFoundError');
		}

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

	private assertAllowedName(name: string): void {
		const byteLength = new TextEncoder().encode(name).length;
		if (
			!name
			|| name === '.'
			|| name === '..'
			|| /[<>:"\/\\|?*\x00-\x1F\x7F-\x9F]/.test(name)
			|| /[\uD800-\uDFFF]/.test(name)
			|| byteLength > 180
		) {
			throw new TypeError('Name is not allowed.');
		}
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

	test('removes File System Access forbidden characters from path segments', () => {
		expect(splitVaultPath('/Articles/X\\Posts/2026/')).toEqual(['Articles', 'XPosts', '2026']);
	});
});

describe('sanitizeFileSystemAccessName', () => {
	test('removes names rejected by File System Access handles', () => {
		expect(sanitizeFileSystemAccessName('X post \\ article: "quoted"?')).toBe('X post article quoted');
	});

	test('falls back when the sanitized handle name is empty', () => {
		expect(sanitizeFileSystemAccessName('\\')).toBe('Untitled');
	});

	test('truncates by UTF-8 byte length for multibyte titles', () => {
		const sanitized = sanitizeFileSystemAccessName('标题'.repeat(120));
		expect(new TextEncoder().encode(sanitized).length).toBeLessThanOrEqual(180);
	});

	test('removes lone surrogate characters left by character-based truncation', () => {
		expect(sanitizeFileSystemAccessName('Article \uD83D')).toBe('Article');
	});
});

describe('buildLocalVaultFileName', () => {
	test('builds a Chrome-safe markdown filename from long multibyte names', () => {
		const fileName = buildLocalVaultFileName('标题'.repeat(120));
		expect(fileName.endsWith('.md')).toBe(true);
		expect(new TextEncoder().encode(fileName).length).toBeLessThanOrEqual(180);
	});

	test('does not duplicate an existing markdown extension', () => {
		expect(buildLocalVaultFileName('Clip.md')).toBe('Clip.md');
	});

	test('sanitizes the X article title that Chrome rejected', () => {
		expect(buildLocalVaultFileName('"三省六部幻觉：为什么\\"虚拟公司\\"式多Agent架构在工程上不成立"')).toBe(
			'三省六部幻觉为什么虚拟公司式多Agent架构在工程上不成立.md'
		);
	});
});

describe('buildFallbackLocalVaultFileName', () => {
	test('builds an ASCII fallback filename', () => {
		const fileName = buildFallbackLocalVaultFileName('"三省六部幻觉：为什么\\"虚拟公司\\"式多Agent架构在工程上不成立"');
		expect(fileName).toMatch(/^Agent-[a-z0-9]+\.md$/);
		expect(new TextEncoder().encode(fileName).length).toBeLessThanOrEqual(100);
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

	test('sanitizes note names before passing them to File System Access', async () => {
		const root = new FakeDirectoryHandle('Vault');

		await saveToLocalVault({
			fileContent: 'Body',
			noteName: 'X post \\ article',
			path: 'Articles/X\\Posts',
			vault: 'Main Vault',
			behavior: 'create',
		}, {
			getVaultHandle: async () => root as unknown as FileSystemDirectoryHandle,
		});

		expect(root.directories.get('Articles')?.directories.get('XPosts')?.files.get('X post article.md')).toBe(
			'Body'
		);
	});

	test('saves long multibyte note names using a byte-limited local filename', async () => {
		const root = new FakeDirectoryHandle('Vault');

		await saveToLocalVault({
			fileContent: 'Body',
			noteName: '标题'.repeat(120),
			path: '',
			vault: 'Main Vault',
			behavior: 'create',
		}, {
			getVaultHandle: async () => root as unknown as FileSystemDirectoryHandle,
		});

		expect(Array.from(root.files.keys())).toHaveLength(1);
		expect(root.files.values().next().value).toBe(
			'Body'
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

	test('throws without prompting when non-interactive save has only prompt permission', async () => {
		const root = new FakeDirectoryHandle('Vault', 'prompt');

		await expect(saveToLocalVault({
			fileContent: 'Body',
			noteName: 'Clip',
			path: '',
			vault: 'Main Vault',
			behavior: 'create',
			allowPermissionPrompt: false,
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

	test('fails with stale-handle when queryPermission hangs indefinitely', async () => {
		const requestPermission = vi.fn(() => new Promise<PermissionState>(() => {}));
		const hangingHandle = {
			kind: 'directory',
			name: 'Vault',
			queryPermission: () => new Promise<PermissionState>(() => {}),
			requestPermission,
		} as unknown as FileSystemDirectoryHandle;

		await expect(saveToLocalVault({
			fileContent: 'Body',
			noteName: 'Clip',
			path: '',
			vault: 'Main Vault',
			behavior: 'create',
			allowPermissionPrompt: false,
		}, {
			getVaultHandle: async () => hangingHandle,
			permissionQueryTimeoutMs: 15,
		})).rejects.toMatchObject({
			code: 'stale-handle',
		});

		await expect(ensureReadWritePermission(hangingHandle, {
			allowPermissionPrompt: true,
			permissionQueryTimeoutMs: 15,
		})).rejects.toMatchObject({
			code: 'stale-handle',
		});

		// Must not call requestPermission on an unresponsive handle (it also hangs in Chrome 158).
		expect(requestPermission).not.toHaveBeenCalled();
	});

	test('fails with folder-not-found when the bound folder was deleted on disk despite granted permission', async () => {
		const root = new FakeDirectoryHandle('inbox', 'granted');
		root.deleted = true;

		await expect(ensureReadWritePermission(root as unknown as FileSystemDirectoryHandle, {
			allowPermissionPrompt: false,
		})).rejects.toMatchObject({
			code: 'folder-not-found',
		});

		await expect(saveToLocalVault({
			fileContent: 'Body',
			noteName: 'Clip',
			path: 'raw/inbox',
			vault: 'notes',
			behavior: 'create',
			allowPermissionPrompt: false,
		}, {
			getVaultHandle: async () => root as unknown as FileSystemDirectoryHandle,
		})).rejects.toMatchObject({
			code: 'folder-not-found',
		});
	});

	test('maps NotFoundError during nested directory creation to folder-not-found', async () => {
		const handleWithoutKeys = {
			kind: 'directory',
			name: 'inbox',
			queryPermission: async () => 'granted' as PermissionState,
			getDirectoryHandle: async () => {
				throw new DOMException('Directory not found', 'NotFoundError');
			},
		} as unknown as FileSystemDirectoryHandle;

		await expect(saveToLocalVault({
			fileContent: 'Body',
			noteName: 'Clip',
			path: 'raw/inbox',
			vault: 'notes',
			behavior: 'create',
			allowPermissionPrompt: false,
		}, {
			getVaultHandle: async () => handleWithoutKeys,
		})).rejects.toMatchObject({
			code: 'folder-not-found',
		});
	});
});

describe('queryLocalVaultHandlePermission', () => {
	test('returns unresponsive when queryPermission never settles', async () => {
		const hangingHandle = {
			kind: 'directory',
			name: 'Vault',
			queryPermission: () => new Promise<PermissionState>(() => {}),
		} as unknown as FileSystemDirectoryHandle;

		await expect(queryLocalVaultHandlePermission(hangingHandle, 'readwrite', 15)).resolves.toBe('unresponsive');
	});

	test('returns granted when queryPermission resolves before timeout', async () => {
		const root = new FakeDirectoryHandle('Vault', 'granted');

		await expect(
			queryLocalVaultHandlePermission(root as unknown as FileSystemDirectoryHandle, 'readwrite', 50)
		).resolves.toBe('granted');
	});
});

describe('probeLocalVaultDirectoryHandle', () => {
	test('returns accessible for an existing directory (even when empty)', async () => {
		const root = new FakeDirectoryHandle('notes', 'granted');

		await expect(
			probeLocalVaultDirectoryHandle(root as unknown as FileSystemDirectoryHandle, 50)
		).resolves.toBe('accessible');
	});

	test('returns not-found when the underlying directory was deleted', async () => {
		const root = new FakeDirectoryHandle('inbox', 'granted');
		root.deleted = true;

		await expect(
			probeLocalVaultDirectoryHandle(root as unknown as FileSystemDirectoryHandle, 50)
		).resolves.toBe('not-found');
	});

	test('returns unresponsive when keys().next() hangs indefinitely', async () => {
		const hangingHandle = {
			kind: 'directory',
			name: 'notes',
			keys: () => ({ next: () => new Promise(() => {}) }),
		} as unknown as FileSystemDirectoryHandle;

		await expect(probeLocalVaultDirectoryHandle(hangingHandle, 15)).resolves.toBe('unresponsive');
	});
});

describe('hasObsidianVaultMarker', () => {
	test('detects whether a directory contains .obsidian', async () => {
		const vaultRoot = new FakeDirectoryHandle('notes', 'granted');
		await vaultRoot.getDirectoryHandle('.obsidian', { create: true });
		const subfolder = new FakeDirectoryHandle('inbox', 'granted');

		await expect(hasObsidianVaultMarker(vaultRoot as unknown as FileSystemDirectoryHandle)).resolves.toBe(true);
		await expect(hasObsidianVaultMarker(subfolder as unknown as FileSystemDirectoryHandle)).resolves.toBe(false);
	});
});
