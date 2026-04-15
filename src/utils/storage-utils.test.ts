import { beforeEach, describe, expect, test, vi } from 'vitest';
import browser from './browser-polyfill';
import { loadSettings, saveSettings } from './storage-utils';

describe('storage-utils local vault bindings', () => {
	beforeEach(() => {
		browser.storage.sync.get = vi.fn().mockResolvedValue({});
		browser.storage.sync.set = vi.fn().mockResolvedValue(undefined);
		browser.storage.local.get = vi.fn().mockResolvedValue({});
		browser.storage.local.set = vi.fn().mockResolvedValue(undefined);
	});

	test('loads local vault bindings from local storage alongside sync settings', async () => {
		(browser.storage.sync.get as any).mockResolvedValue({
			vaults: ['Main Vault'],
			general_settings: {
				saveBehavior: 'saveToLocalFolder',
				autoSaveLocalFolderOnOpen: true,
			},
		});
		(browser.storage.local.get as any).mockResolvedValue({
			local_vault_bindings: {
				'Main Vault': {
					folderName: 'ObsidianVault',
					configuredAt: '2026-04-14T00:00:00.000Z',
				},
			},
		});

		const settings = await loadSettings();

		expect(settings.saveBehavior).toBe('saveToLocalFolder');
		expect(settings.autoSaveLocalFolderOnOpen).toBe(true);
		expect(settings.localVaultBindings['Main Vault']).toEqual({
			folderName: 'ObsidianVault',
			configuredAt: '2026-04-14T00:00:00.000Z',
		});
	});

	test('persists local vault bindings only to local storage', async () => {
		await saveSettings({
			vaults: ['Main Vault'],
			localVaultBindings: {
				'Main Vault': {
					folderName: 'ObsidianVault',
					configuredAt: '2026-04-14T00:00:00.000Z',
				},
			},
			showMoreActionsButton: false,
			betaFeatures: false,
			legacyMode: false,
			silentOpen: false,
			autoSaveLocalFolderOnOpen: true,
			openBehavior: 'popup',
			highlighterEnabled: true,
			alwaysShowHighlights: false,
			highlightBehavior: 'highlight-inline',
			interpreterModel: '',
			models: [],
			providers: [],
			interpreterEnabled: false,
			interpreterAutoRun: false,
			defaultPromptContext: '',
			propertyTypes: [],
			readerSettings: {
				fontSize: 16,
				lineHeight: 1.6,
				maxWidth: 38,
				lightTheme: 'default',
				darkTheme: 'same',
				appearance: 'auto',
				fonts: [],
				defaultFont: '',
				blendImages: true,
				colorLinks: false,
				pinPlayer: true,
				autoScroll: true,
				highlightActiveLine: true,
				followLinks: true,
				customCss: '',
			},
			stats: {
				addToObsidian: 0,
				saveFile: 0,
				copyToClipboard: 0,
				saveToLocalFolder: 0,
				share: 0,
			},
			history: [],
			ratings: [],
			saveBehavior: 'saveToLocalFolder',
		});

		expect(browser.storage.sync.set).toHaveBeenCalledWith(expect.objectContaining({
			vaults: ['Main Vault'],
			general_settings: expect.objectContaining({
				saveBehavior: 'saveToLocalFolder',
				autoSaveLocalFolderOnOpen: true,
			}),
		}));
		expect(browser.storage.local.set).toHaveBeenCalledWith({
			local_vault_bindings: {
				'Main Vault': {
					folderName: 'ObsidianVault',
					configuredAt: '2026-04-14T00:00:00.000Z',
				},
			},
		});
	});
});
