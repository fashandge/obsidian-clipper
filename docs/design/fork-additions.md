# Fork additions design notes

This document describes the features this fork (`fashandge/obsidian-clipper`)
adds on top of the official `obsidianmd/obsidian-clipper`. It is a design /
maintenance reference for those changes, not user-facing help. The official
user docs are maintained upstream in the
[obsidian-help repo](https://github.com/obsidianmd/obsidian-help/tree/master/en/Obsidian%20Web%20Clipper).

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
| X/Twitter post extractor (both markups) | `getPageContent` handler | `utils/x-post-extractor.ts`, `content.ts` |
| ChatGPT conversation extractor (2026 markup) | `getPageContent` handler | `utils/chatgpt-conversation-extractor.ts`, `content.ts` |
| Shield article bodies from defuddle's `[data-date]` clutter selector | every defuddle parse of the live page | `utils/defuddle-guards.ts`, `content.ts`, `utils/clip-utils.ts`, `utils/reader.ts` |

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

### Auto-save ignores incidental page selections

The clipper's normal rule is "if the page has a text selection, clip just that
selection" — `refreshFields` (`popup.ts`) prefers the selection over the
full-page content, and `initializePageContent` swaps the whole note body for it.
That is the right behavior for a *manual* clip, but for auto-save-on-open the
user's intent is "save the whole page", so a stray selection left on the page
(e.g. a double-click that selected a sidebar date) must not silently hijack the
body. When `shouldAutoSaveLocalFolderOnOpen` is true, `refreshFields` therefore
ignores the page's own `selectedHtml`; only an **explicit** "Clip selection as
new note" request (§2, via `forcedSelectedHtml`) still overrides the body.

Defensively, `content.ts`'s `getPageContent` handler also only treats a
selection as real when it is non-collapsed and carries trimmed text (mirroring
`captureSelectionSnapshot`) — a collapsed caret reports `rangeCount > 0` but
must not count as a selection.

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

## 5. X/Twitter post extractor

### Problem

X serves (at least) **two different web front-ends** for a tweet, chosen by
session/rollout (observed: logged-out → new, logged-in → classic — not
guaranteed):

1. **Classic** React SPA — `article[data-testid="tweet"]`,
   `[data-testid="tweetText"]`, `[data-testid="User-Name"]`, `css-*` classes.
   Line breaks are real `\n` inside `<span>`s (no `<br>`/`<p>`).
2. **New** lightweight Tailwind page — `article[data-tweet-id]`,
   `white-space: pre-wrap` text nodes, **no `data-testid` at all**. Line breaks
   are real `\n` made visible only by the pre-wrap CSS.

`defuddle` ships a `TwitterExtractor` that only understands markup (1). On markup
(2) its `canExtract()` returns false; and on markup (1) it sometimes still does
not run in this extension's pipeline. Whenever no site-specific extractor runs,
defuddle falls back to its **generic reader**, which (a) scrapes surrounding UI
chrome (`View quotes`, `Post your reply`, engagement counts) and (b) collapses
the tweet's `\n` line breaks — insignificant to HTML flow, significant only via
CSS the Markdown step never sees — into a single dense, unreadable paragraph.

### Solution — `utils/x-post-extractor.ts`

A fork-local extractor that reads **both** markups and mirrors defuddle's
`TwitterExtractor` output:

- `extractXPost(doc, url)` returns an override `{ content, title, author, site,
  description, published?, extractedContent }` or `null`. It picks the markup
  (`article[data-tweet-id]` → new path, else `article[data-testid="tweet"]` →
  classic path), splits the tweet text on `\n` into `<p>` paragraphs (**the core
  fix**), keeps emoji `<img alt>` as inline text, upgrades media images to
  `&name=large`, and classifies self-replies by the main author as an appended
  thread (`<hr>`-separated) with other authors' replies in a `## Replies`
  blockquote section.
- `isXStatusUrl(url)` / `isNewXPostPage(doc, url)` are helpers for gating/tests.

`content.ts`'s `getPageContent` handler runs `extractXPost` **only when defuddle
produced no `extractorType`** (i.e. it fell back to the generic reader) on an X
status URL, then overrides `defuddled.content/title/author/site/description/
published/variables`. Gating on `!extractorType` guarantees a *working* defuddle
`TwitterExtractor` is never clobbered, while still rescuing every case where
defuddle fell back — regardless of which markup X served. All other metadata
(favicon, image, schemaOrgData, wordCount) stays from defuddle, and a try/catch
falls back to defuddle's output on any error.

This is **not** browser-gated — it helps X clips on Chrome, Firefox, and Safari.
Because defuddle's `ExtractorRegistry` is not exported from the package's public
entry points, the override lives in the extension rather than being registered as
a defuddle extractor.

## 6. ChatGPT conversation extractor

### Problem

defuddle's `ChatGPTExtractor` (still true in defuddle 0.19.4) only matches the
old markup: `article[data-testid^="conversation-turn-"]` turns holding
`[data-message-author-role]` messages. ChatGPT's current web app (observed
2026-10) has neither:

- turns are `[data-turn-key]` blocks;
- each message is a `[data-content-search-unit-key="fallback-turn-N:i:<role>"]`
  unit, with a localized sr-only heading ("You said:" sits *beside* the user
  unit; "ChatGPT said:" is `h4[data-conversation-role]` inside the assistant one);
- the assistant body is `[data-markdown-text-style="assistant-message"]`, in one
  of two shapes: **classic Markdown** (semantic tags, sources as
  `a[data-testid="chatgpt-citation"]` pills) or a **generative-UI layout**
  (`data-d-component="title|text|list|table|box|grid|badge|…"`, with bold/italic
  carried by `data-d-default-strong`, `data-d-weight`, `data-d-font-style`, and
  sources as href-less favicon badges).

With no extractor matching, defuddle's generic reader kept the user prompt but
dropped the **entire assistant answer** on generative-UI pages (19 words for a
~600-word answer): partial-selector and hidden-element removal strip it, and the
retry passes don't recover it (the `removePartialSelectors: false` retry returned
24 words, although the same option on a fresh document returns ~610).

### Solution — `utils/chatgpt-conversation-extractor.ts`

`extractChatGPTConversation(doc, url)` walks the top-level units in document
order, clones each message body, and cleans the clone: removes buttons, SVGs,
`[hidden]`/sr-only nodes and the "ChatGPT can make mistakes" footer; turns
citation pills and source badges into footnotes (deduplicated by URL,
`utm_source=chatgpt.com` stripped); converts the generative-UI emphasis
attributes into `<strong>`/`<em>` and captions into italic paragraphs; keeps user
prompt line breaks as `<br>`; and strips all styling attributes. The output
mirrors defuddle's `ConversationExtractor` HTML (bold author header per message,
`<hr>` between messages, footnotes section).

Unlike `ConversationExtractor` it does **not** re-run defuddle over the
assembled HTML: that pass's heuristics drop the assistant header and the
answer's leading `<h1>`.

`content.ts` applies it with the same gate as the X override — **only when
defuddle produced no `extractorType`** on a `chatgpt.com/c/…`, `/g/…/c/…` or
`/share/…` URL — and overrides `content/title/site/description/wordCount/
variables` (`{{messageCount}}`). It returns `null` (keeping defuddle's output)
when the page has no units or no assistant message yet.

Like the X extractor this is not browser-gated.

Known limits: the units must be in the DOM (they were for every conversation
checked, up to 5 turns; a virtualized very long thread may not render every
turn); generative-UI badges only expose the source's site, not the exact page,
so their footnotes link to the site origin; chart-like rows (label + value)
come out as separate lines.

## 7. Defuddle `[data-date]` guard

defuddle's exact clutter selectors include `[data-date]`, aimed at small date
badges. Some themes put that attribute on the article body container itself —
e.g. the Ghost theme on felixrieseberg.com renders
`<div class="content gh-content" data-date="…">` — so defuddle removes the
whole body on every retry pass and the clip has a title but no text. This is
still the case in defuddle 0.19.5.

`utils/defuddle-guards.ts` removes `data-date` from any element that is clearly
a content container (it contains a `<p>` and at least 200 characters of text),
runs the parse, then restores the attribute. It mutates the live DOM rather
than a copy because defuddle clones the document itself and needs the live
window for computed styles. Wrapped call sites: the `getPageContent` handler in
`content.ts`, `parseForClip` in `utils/clip-utils.ts`, and reader mode in
`utils/reader.ts`. Remove the guard once upstream defuddle stops matching
content containers with that selector.

## Files added by the fork

```
src/utils/local-vault-storage.ts      IndexedDB handle storage + permission helpers
src/utils/local-vault-writer.ts       saveToLocalVault + filename/merge logic
src/utils/title-normalizer.ts         filename title normalization
src/utils/x-post-extractor.ts         X/Twitter new-markup extractor (+ .test.ts)
src/utils/chatgpt-conversation-extractor.ts  ChatGPT 2026-markup extractor (+ .test.ts)
src/utils/defuddle-guards.ts          shields article bodies from defuddle's [data-date] selector (+ .test.ts)
src/types/file-system-access.d.ts     ambient types for the File System Access API
src/utils/local-vault-writer.test.ts  writer unit tests
src/utils/storage-utils.test.ts       settings/stat tests
src/utils/title-normalizer.test.ts    normalizer unit tests
docs/design/fork-additions.md         this document
```

Notably touched upstream files: `core/popup.ts` (save flow, auto-save, selection
clip, permission priming), `background.ts` (context menu, selection snapshot
cache, `saveToLocalVaultFolder` offload), `managers/general-settings.ts` (bind /
reconnect / clear folder UI), `content.ts` (X and ChatGPT extractor overrides, defuddle guard),
`types/types.ts`, and the locale catalogs.

## Browser support

All of the above is **Chrome-only**, gated by `isChromeLocalVaultWriteSupported()`.
On other browsers the new save behavior is unavailable and the clipper falls back
to upstream behavior. Daily-note templates always use the Obsidian URI, even on
Chrome.
