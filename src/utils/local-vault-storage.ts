import browser from './browser-polyfill';
import { LocalVaultBinding } from '../types/types';

const LOCAL_VAULT_DB_NAME = 'obsidian-clipper-local-vaults';
const LOCAL_VAULT_STORE_NAME = 'vault-handles';
export const HANDLE_PERMISSION_QUERY_TIMEOUT_MS = 2500;

export type LocalVaultPermissionQueryResult = PermissionState | 'unresponsive';

interface StoredVaultHandle {
	vaultName: string;
	handle: FileSystemDirectoryHandle;
	updatedAt: string;
}

function isIndexedDbAvailable(): boolean {
	return typeof indexedDB !== 'undefined';
}

function openVaultHandleDatabase(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		if (!isIndexedDbAvailable()) {
			reject(new Error('IndexedDB is not available.'));
			return;
		}

		const request = indexedDB.open(LOCAL_VAULT_DB_NAME, 1);

		request.onerror = () => reject(request.error || new Error('Failed to open local vault database.'));
		request.onsuccess = () => resolve(request.result);
		request.onupgradeneeded = () => {
			const db = request.result;
			if (!db.objectStoreNames.contains(LOCAL_VAULT_STORE_NAME)) {
				db.createObjectStore(LOCAL_VAULT_STORE_NAME, { keyPath: 'vaultName' });
			}
		};
	});
}

async function withStore<T>(
	mode: IDBTransactionMode,
	handler: (store: IDBObjectStore) => Promise<T> | T
): Promise<T> {
	const db = await openVaultHandleDatabase();

	return new Promise<T>((resolve, reject) => {
		const transaction = db.transaction(LOCAL_VAULT_STORE_NAME, mode);
		const store = transaction.objectStore(LOCAL_VAULT_STORE_NAME);
		let isDone = false;
		let result: T;

		transaction.oncomplete = () => {
			db.close();
			if (!isDone) {
				isDone = true;
				resolve(result);
			}
		};
		transaction.onerror = () => {
			db.close();
			if (!isDone) {
				isDone = true;
				reject(transaction.error || new Error('Local vault transaction failed.'));
			}
		};
		transaction.onabort = () => {
			db.close();
			if (!isDone) {
				isDone = true;
				reject(transaction.error || new Error('Local vault transaction was aborted.'));
			}
		};

		Promise.resolve(handler(store))
			.then((value) => {
				result = value;
			})
			.catch((error) => {
				isDone = true;
				try {
					transaction.abort();
				} catch {
					// Ignore abort errors when the transaction is already complete.
				}
				db.close();
				reject(error);
			});
	});
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error || new Error('IndexedDB request failed.'));
	});
}

export function isChromeLocalVaultWriteSupported(): boolean {
	return typeof window !== 'undefined'
		&& typeof window.showDirectoryPicker === 'function'
		&& isIndexedDbAvailable();
}

export async function getStoredLocalVaultHandle(vaultName: string): Promise<FileSystemDirectoryHandle | null> {
	const stored = await withStore('readonly', (store) =>
		requestToPromise(store.get(vaultName) as IDBRequest<StoredVaultHandle | undefined>)
	);
	return stored?.handle || null;
}

export async function setStoredLocalVaultHandle(vaultName: string, handle: FileSystemDirectoryHandle): Promise<void> {
	await withStore('readwrite', (store) => requestToPromise(store.put({
		vaultName,
		handle,
		updatedAt: new Date().toISOString(),
	} satisfies StoredVaultHandle)));
}

export async function deleteStoredLocalVaultHandle(vaultName: string): Promise<void> {
	await withStore('readwrite', (store) => requestToPromise(store.delete(vaultName)));
}

/**
 * Query permission on a stored File System Access handle with a timeout guard.
 *
 * Chrome 158+ can hang indefinitely (never resolving or rejecting) on every
 * async method of a FileSystemDirectoryHandle serialized in IndexedDB before
 * M158 (Chromium issues 587468319 / 588328253). Bounding queryPermission lets
 * callers detect an unresponsive handle and direct the user to reconnect it
 * instead of stalling auto-save, manual saves, and settings status checks.
 */
export async function queryLocalVaultHandlePermission(
	handle: FileSystemDirectoryHandle,
	mode: FileSystemPermissionMode = 'readwrite',
	timeoutMs: number = HANDLE_PERMISSION_QUERY_TIMEOUT_MS
): Promise<LocalVaultPermissionQueryResult> {
	if (!handle.queryPermission) {
		return 'prompt';
	}

	let timeoutId: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			handle.queryPermission({ mode }),
			new Promise<'unresponsive'>((resolve) => {
				timeoutId = setTimeout(() => resolve('unresponsive'), timeoutMs);
			}),
		]);
	} finally {
		if (timeoutId !== undefined) {
			clearTimeout(timeoutId);
		}
	}
}

export async function getLocalVaultPermissionState(
	vaultName: string,
	mode: FileSystemPermissionMode = 'readwrite',
	timeoutMs: number = HANDLE_PERMISSION_QUERY_TIMEOUT_MS
): Promise<PermissionState | 'missing' | 'unresponsive'> {
	const handle = await getStoredLocalVaultHandle(vaultName);
	if (!handle) {
		return 'missing';
	}
	return queryLocalVaultHandlePermission(handle, mode, timeoutMs);
}

export async function requestLocalVaultPermission(
	vaultName: string,
	mode: FileSystemPermissionMode = 'readwrite',
	timeoutMs: number = HANDLE_PERMISSION_QUERY_TIMEOUT_MS
): Promise<PermissionState | 'missing' | 'unresponsive'> {
	const handle = await getStoredLocalVaultHandle(vaultName);
	if (!handle) {
		return 'missing';
	}
	const current = await queryLocalVaultHandlePermission(handle, mode, timeoutMs);
	if (current === 'granted' || current === 'unresponsive') {
		return current;
	}
	if (!handle.requestPermission) {
		return 'prompt';
	}
	return handle.requestPermission({ mode });
}

export async function chooseLocalVaultFolder(vaultName: string): Promise<LocalVaultBinding> {
	if (!isChromeLocalVaultWriteSupported()) {
		throw new Error('Chrome local vault writes are not supported in this browser.');
	}

	const showDirectoryPicker = window.showDirectoryPicker;
	if (!showDirectoryPicker) {
		throw new Error('Chrome local vault writes are not supported in this browser.');
	}

	const handle = await showDirectoryPicker({
		mode: 'readwrite',
		id: `obsidian-clipper-${vaultName}`,
	});

	const permission = handle.requestPermission
		? await handle.requestPermission({ mode: 'readwrite' })
		: 'prompt';
	if (permission !== 'granted') {
		throw new Error('Write permission was not granted for this folder.');
	}

	await setStoredLocalVaultHandle(vaultName, handle);
	try {
		await browser.storage.local.remove('local_vault_last_error');
	} catch {
		// Best-effort cleanup so the next popup open can auto-save immediately.
	}

	const binding: LocalVaultBinding = {
		folderName: handle.name,
		configuredAt: new Date().toISOString(),
	};

	return binding;
}

export async function clearStoredLocalVaultFolder(vaultName: string): Promise<void> {
	await deleteStoredLocalVaultHandle(vaultName);
}

export async function getLocalVaultBindingsFromStorage(): Promise<Record<string, LocalVaultBinding>> {
	const result = await browser.storage.local.get('local_vault_bindings');
	const bindings = result.local_vault_bindings;

	if (!bindings || typeof bindings !== 'object' || Array.isArray(bindings)) {
		return {};
	}

	const sanitizedBindings: Record<string, LocalVaultBinding> = {};
	for (const [vaultName, binding] of Object.entries(bindings as Record<string, Partial<LocalVaultBinding>>)) {
		if (!vaultName || typeof vaultName !== 'string') {
			continue;
		}
		if (!binding || typeof binding.folderName !== 'string') {
			continue;
		}
		sanitizedBindings[vaultName] = {
			folderName: binding.folderName,
			configuredAt: typeof binding.configuredAt === 'string' ? binding.configuredAt : '',
		};
	}

	return sanitizedBindings;
}
