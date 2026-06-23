# AGENTS.md

This file provides guidance to AI coding agents (Claude Code, Codex, OpenClaw, Hermes, and similar tools) when working with code in this repository.

## Project

Obsidian Web Clipper — a browser extension (Chrome, Firefox, Safari) that clips web pages into Obsidian. Source is TypeScript under `src/`, bundled with webpack. This checkout is a local fork of the upstream Obsidian repo with personal patches on top (local-vault saves, selection clipping, auto-save). Those fork-specific features are documented in `docs/design/fork-additions.md` — read it before touching the local-folder save flow, the selection context menu, or the background-worker write offload.

## Git workflow

This repo has **two remotes** — keep them straight:

```
origin → https://github.com/obsidianmd/obsidian-clipper   (UPSTREAM — pull updates from here, never push)
fork   → https://github.com/fashandge/obsidian-clipper     (personal fork — push your work here for backup)
```

Local `main` tracks `fork/main`, and carries personal commits rebased on top of upstream `main`.

### Back up local commits to the fork

```bash
git push                       # local main tracks fork/main, so a bare push backs up here
```

After history is rewritten by a rebase (see below), the fork has diverged, so use:

```bash
git push --force-with-lease fork main    # safe force: refuses if the fork moved underneath you
```

### Pull the latest upstream and rebase personal commits on top

```bash
git fetch origin                         # download latest from obsidianmd/obsidian-clipper
git rebase origin/main                   # replay personal commits on top of upstream main
# ...resolve any conflicts, then:
git push --force-with-lease fork main     # update the backup with the rewritten history
```

After such a rebase, **reinstall dependencies** if `package.json` / `package-lock.json` changed (e.g. an upstream "Bump <dep>" commit), then rebuild and test before pushing:

```bash
npm install
npm run build:chrome
npm test
```

### One-time fork setup (already done here; for reference / fresh clones)

```bash
gh repo fork obsidianmd/obsidian-clipper          # creates fashandge/obsidian-clipper
git remote add fork https://github.com/fashandge/obsidian-clipper.git
git push -u fork main
```

### Conventions

- Do **not** push to `origin` (it is the upstream Obsidian repo).
- Personal work currently lives directly on `main`. If you intend to open an upstream PR, move it to a feature branch first (`git switch -c my-feature && git push fork my-feature`) rather than PRing from `main`.
- Resolving rebase conflicts in `src/_locales/en/messages.json`: it is a flat JSON map of message keys — keep **both** sides' keys and validate with `python3 -c "import json;json.load(open('src/_locales/en/messages.json'))"`.

## Build & test commands

```bash
npm run dev:chrome      # webpack watch build for Chrome (also dev:firefox, dev:safari)
npm run build:chrome    # production build for Chrome (also build:firefox, build:safari)
npm run build           # build all three browsers
npm run build:cli       # build the CLI entry (scripts/build-cli.mjs)
npm run build:api       # build the API entry (scripts/build-api.mjs)
npm test                # run the full vitest suite once
npm run test:watch      # vitest in watch mode
```

The real type-check happens through the webpack build (`ts-loader`), not bare `tsc` — `tsc --noEmit` reports false positives because it ignores the project's module config. Validate compilation with `npm run build:chrome`.

## Code layout

- `src/core/` — popup, reader view, and other top-level UI entry points.
- `src/managers/` — settings, templates, and other stateful managers.
- `src/utils/` — extraction, storage, obsidian-note creation, and helpers. Unit tests are colocated as `*.test.ts`.
- `src/types/` — shared TypeScript types and ambient declarations.
- `src/_locales/<lang>/messages.json` — i18n message catalogs (flat key → `{ "message": ... }` maps).
- `src/icons/icons.ts` — the curated set of lucide icons imported and re-exported for use in the UI.
