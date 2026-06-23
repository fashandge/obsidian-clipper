# Fork additions design notes

This document describes the features this fork (`fashandge/obsidian-clipper`)
adds on top of the official `obsidianmd/obsidian-clipper`. It is a design /
maintenance reference for those changes, not user-facing help. The official
user docs live alongside this file in `docs/`.

## Why this fork exists

The upstream clipper saves notes by opening an `obsidian://` URI, which requires
the Obsidian app to come to the foreground. This fork adds the ability to write
Markdown **directly into a local Obsidian vault folder** (Chrome only), so
clipping never has to foreground Obsidian, plus some quality-of-life features
around it (a selection context-menu, auto-save on open).

## Feature overview

| Feature | Entry point | Key modules |
| --- | --- | --- |
| Local-folder ("local vault") saves | `SaveBehavior = 'saveToLocalFolder'` | `utils/local-vault-writer.ts`, `utils/local-vault-storage.ts`, `utils/title-normalizer.ts` |
| Connect a vault to a local folder | Settings UI | `managers/general-settings.ts`, `utils/local-vault-storage.ts` |
| "Clip selection as new note" context menu | Right-click menu | `background.ts`, `content.ts`, `core/popup.ts` |
| Auto-save to local folder on popup open | `autoSaveLocalFolderOnOpen` setting | `core/popup.ts` |
| Background-worker write offload (perf) | `saveToLocalVaultFolder` message | `background.ts`, `core/popup.ts` |

---

## 1. Local-folder ("local vault") saves

### Concept

Each Obsidian **vault name** known to the clipper can be *bound* to a local
folder on disk via the [File System Access API][fsa]. Once bound, choosing the
`saveToLocalFolder` behavior writes the `.md` file straight into that folder
(under the template's path), with no `obsidian://` round-trip and no app
foregrounding.

This is **Chrome-only** — it depends on `window.showDirectoryPicker` and the
`FileSystemDirectoryHandle` write APIs. `isChromeLocalVaultWriteSupported()`
gates the whole feature; on Firefox/Safari it is inert and the clipper behaves
exactly as upstream.

[fsa]: https://developer.mozilla.org/en-US/docs/Web/API/File_System_API

### Persisting folder access — `utils/local-vault-storage.ts`

Browsers can't serialize a directory handle into normal extension storage, so
handles are kept in **IndexedDB**:

- DB `obsidian-clipper-local-vaults`, object store `vault-handles`, keyed by
  `vaultName`.
- `chooseLocalVaultFolder(vaultName)` opens the OS folder picker, requests
  read-write permission, stores the handle, and returns a `LocalVaultBinding`
  (`{ folderName, configuredAt }`) for display.
- `getStoredLocalVaultHandle`, `getLocalVaultPermissionState`,
  `requestLocalVaultPermission`, `clearStoredLocalVaultFolder` manage the handle
  and its permission lifecycle.

The lightweight, serializable `LocalVaultBinding` metadata (folder name, when it
was configured) is mirrored in `Settings.localVaultBindings`
(`Record<vaultName, LocalVaultBinding>`) so the settings UI can render bindings
without touching IndexedDB. The **authoritative** handle always lives in
IndexedDB; `localVaultBindings` is display-only.

Chrome may downgrade a granted handle back to the `prompt` state (e.g. after a
restart). Restoring write access then needs a real user gesture, which is why
permission handling is split into a "query" path (no gesture) and a "request"
path (needs a click) — see the auto-save section.

### Writing the file — `utils/local-vault-writer.ts`

`saveToLocalVault(params, deps)` is the core writer. Steps:

1. Reject `append-daily` / `prepend-daily` (daily notes still use the Obsidian
   URI — the extension doesn't know the vault's daily-note path).
2. Resolve the directory handle for the vault (`deps.getVaultHandle`).
3. `ensureReadWritePermission` — `queryPermission`, and only `requestPermission`
   when `allowPermissionPrompt` is true. Throws `LocalVaultWriteError` with a
   typed `code` (`missing-vault`, `missing-binding`, `permission-denied`,
   `file-exists`, `daily-notes-unsupported`, …) otherwise.
4. Walk/create the template path with `getDirectoryHandle({ create: true })`.
5. `writeMarkdownFile` — read any existing file, apply the merge behavior, then
   `getFileHandle({create:true})` → `createWritable()` → `write()` → `close()`.

Filename handling (`buildLocalVaultFileName` + `title-normalizer.ts`):
- Normalize the title (NFKC), strip illegal/zero-width characters, collapse
  whitespace, guard Windows reserved names, and truncate to a **180-byte** UTF-8
  budget (leaving room for `.md`).
- If the OS rejects the name (`isHandleNameError`), retry once with
  `buildFallbackLocalVaultFileName` — an ASCII-only slug plus a stable FNV hash
  of the original title, so two different titles never collide on the fallback.

Merge behaviors (`mergeNoteContent`) mirror the clipper's existing semantics:
`create`/`overwrite` replace; `append-specific`/`prepend-specific` splice the new
body around the existing body while preserving the existing frontmatter.

### Settings / type changes

- `SaveBehavior` gains `'saveToLocalFolder'`; `Settings.stats` gains a
  `saveToLocalFolder` counter; `Template.action`/triggers accept it too.
- `Settings.localVaultBindings: Record<string, LocalVaultBinding>`.
- New i18n keys: `saveToLocalFolder` and the `localVault*` family
  (status/error strings) in `_locales/*/messages.json`.

---

## 2. "Clip selection as new note" context menu

Lets you right-click a text selection and clip just that selection.

Flow:
1. `background.ts` registers a `contextMenus` item titled `clipSelectionAsNewNote`.
2. On click, `cacheSelectionClipRequest(tabId, info)` asks the content script for
   a rich snapshot (`content.ts` handles `captureSelectionSnapshot`, returning the
   selection's `innerHTML`), falling back to escaped `info.selectionText` if the
   content script is unavailable.
3. The snapshot is stored in `storage.local` under
   `selection_clip_request` (`{ tabId, selectedHtml, createdAt }`), and the popup
   is opened.
4. On open, `popup.ts#loadPendingSelectionClipRequest` reads and clears that
   record for the current tab and parks the HTML in `forcedSelectedHtml`, which
   `refreshFields` then prefers over the page's own selection when building
   `{{selection}}`/`{{selectionHtml}}` variables.

A `storage.local` handoff is used (rather than a direct message) because the
context-menu click and the popup are separate lifecycles.

---

## 3. Auto-save to local folder on popup open

When `Settings.autoSaveLocalFolderOnOpen` is on, the save behavior is
`saveToLocalFolder`, the browser is Chrome, and we're not in the side panel or an
iframe, the popup saves automatically shortly after it opens.

- `shouldAutoSaveLocalFolderOnOpen` is computed during popup init.
- After the initial content load, `scheduleAutoSaveLocalFolderIfNeeded()` arms a
  ~1s timer that runs `handleClipToLocalFolder({ allowPermissionPrompt: false })`.
- `allowPermissionPrompt: false` is important: auto-save must not pop a
  permission dialog without a user gesture. If Chrome has downgraded the handle
  to `prompt`, the save throws `permission-denied` and the popup shows the
  `autoSaveLocalFolderNeedsClick` inline notice asking for one manual click.

---

## 4. Background-worker write offload (performance)

### Problem

On a **synced** vault folder (notably iCloud Drive with "Optimize Mac Storage"),
`FileSystemWritableFileStream.close()` — the atomic commit that renames the
`.crswap` swap file onto the target and waits for the file provider to confirm
durability — can block for ~20s. The file content lands on local disk quickly
(Obsidian sees it almost immediately), but the `close()` *call* doesn't return
until the OS/iCloud coordination finishes. Because the popup `await`ed that
`close()`, the popup window stayed open ~20s. This only became constant once
auto-save started running the write on *every* popup open (before, local-folder
writes were only triggered manually).

This was diagnosed with temporary timing instrumentation forwarded to the
service-worker console; the entire delay was isolated to the single `close()`
call. (See commit history around `popup.ts#getCurrentTabInfo` for a related,
separate fix: it stopped re-extracting the whole page just to read the title for
the history entry.)

### Solution

`handleClipToLocalFolder` no longer performs the write itself. Instead:

1. The popup still does `primeLocalVaultPermission` **synchronously while open**,
   so the common errors (`missing-binding`, `missing-vault`, `permission-denied`)
   are surfaced before anything is offloaded.
2. It prepares the content and sends a `saveToLocalVaultFolder` message to the
   background service worker **without awaiting completion**, then closes
   immediately (~1s).
3. `background.ts` handles `saveToLocalVaultFolder`: it loads the handle from
   IndexedDB and runs `saveToLocalVault` (with `allowPermissionPrompt: false`).
   The slow `close()` happens here, in the persistent worker, where nothing the
   user sees is waiting on it. On success it records the stat/history entry; on
   failure it stores `local_vault_last_error` in `storage.local`.

Why keep awaiting `close()` in the worker at all, since the file appears
instantly? Two reasons: (a) abandoning `close()` risks a half-committed write or
a stray `.crswap`; awaiting it makes completion deterministic instead of relying
on popup-teardown behavior; (b) the worker needs the result to record history
accurately and to report failures.

Error surfacing: on the next popup open, `surfacePendingLocalVaultError()` reads
and clears `local_vault_last_error`, shows the matching inline notice, and
**skips that open's auto-save** so a persistently failing write doesn't retry
silently in a loop. A successful background write clears the stored error.

### Trade-off

Rare failures that occur *after* the permission/binding checks (e.g. disk full,
an OS-rejected filename that even the fallback can't satisfy) are reported on the
*next* popup open rather than instantly, because the triggering popup has already
closed. This is an accepted trade-off for making the popup responsive.

---

## Files added by the fork

```
src/utils/local-vault-storage.ts      IndexedDB handle storage + permission helpers
src/utils/local-vault-writer.ts       saveToLocalVault + filename/merge logic
src/utils/title-normalizer.ts         filename title normalization
src/types/file-system-access.d.ts     ambient types for the File System Access API
src/utils/local-vault-writer.test.ts  writer unit tests
src/utils/storage-utils.test.ts       settings/stat tests
src/utils/title-normalizer.test.ts    normalizer unit tests
docs/design/fork-additions.md         this document
```

Notably touched upstream files: `core/popup.ts` (save flow, auto-save, selection
clip, permission priming), `background.ts` (context menu, selection snapshot
cache, `saveToLocalVaultFolder` offload), `managers/general-settings.ts` (bind /
reconnect / clear folder UI), `types/types.ts`, and the locale catalogs.

## Browser support

All of the above is **Chrome-only**, gated by `isChromeLocalVaultWriteSupported()`.
On other browsers the new save behavior is unavailable and the clipper falls back
to upstream behavior. Daily-note templates always use the Obsidian URI, even on
Chrome.
