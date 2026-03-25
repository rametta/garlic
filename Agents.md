# Git GUI App — agent context

Use this file to align quickly on **what this repo is** and **what to build**. It is the product + stack brief for AI and humans.

## Purpose

Desktop **Git client** with a simple UI: open or clone repos, manage branches and remotes, **rebase**, stage and commit, push, and **see branch history in a tree-shaped view** (graph / ancestry), not just a flat list.

## Stack

- **Desktop shell:** Tauri 2 (`src-tauri/`, Rust)
- **Frontend:** React + TypeScript (`src/`)
- **Styling:** Tailwind CSS v4 with the Vite plugin (`@tailwindcss/vite`): `@import "tailwindcss"` in `src/index.css`, utilities in components — see [Tailwind + Vite](https://tailwindcss.com/docs/installation/using-vite)
- **Bundler:** Vite
- **Package manager:** Bun (user preference; scripts in `package.json` work with `bun run …`)
- **Lint / format:** oxlint + oxfmt (configs: `.oxlintrc.json`, `.oxfmtrc.json`)

**After editing TypeScript, TSX, JSON, or CSS in this repo:** run `bun run fmt` to format and `bun run lint` to lint before considering the task complete.

Git operations should run where it fits the design: typically **Tauri commands** invoking `git` (CLI) or a Rust Git library, with results returned to the UI. Keep the React side focused on state, views, and calling the backend.

**Persisted app data** (last opened repo, theme, future settings) belongs in the **Rust layer**: write under the app config (e.g. `settings.json` via `AppHandle::path().app_config_dir()`), expose **`invoke` commands** (`restore_app_bootstrap`, `set_last_repo_path`, `set_theme`, …), and **bootstrap the UI** in `main.tsx` (await `invoke` before `createRoot`, set `document.documentElement.dataset.theme` for DaisyUI before paint) so the shell does not need a `useEffect` to “hydrate” from the backend.

### React / `useEffect`

Treat **`useEffect` as a last resort**. Prefer: **event handlers** and **data from props** (including values resolved before `createRoot` in `main.tsx`), **`useMemo` / `useCallback`** for derived state, and **Tauri events** with `listen` only when you truly need a subscription to a side channel (e.g. menu → `open-repo-request`). Avoid “load data on mount” effects when the same data can come from a Tauri command awaited at startup or from user actions.

## Core features (must support)

1. **Clone** — clone a remote URL into a chosen local path; surface progress/errors clearly.
2. **Branches** — list local (and optionally remote-tracking) branches; **create** new branches from a base.
3. **Checkout** — switch branches (handle dirty working tree with clear messaging or safe defaults).
4. **Remotes** — view `origin` and others; **add / set / remove** remotes and URLs as needed for a small GUI.
5. **Stage** — stage/unstage files (hunks optional later); show status (modified, added, deleted, renamed).
6. **Commit** — commit with message; optional author config exposure if you add settings later.
7. **Push** — push current branch to configured remote; handle upstream and common failures.
8. **Rebase** — rebase current branch onto another branch or commit (interactive rebase optional later); show in-progress rebase state, **continue / abort / skip** when conflicts occur; clear errors and refresh repo state after completion.
9. **Branch tree / graph** — visualize branches and merges in a **tree-like** structure (DAG graph: commits as nodes, parent/merge edges), not only a vertical list of branch names.

## UX / product notes

- **Simple** beats feature-complete at first: one repo per window/session is fine until multi-repo is required.
- Prefer **explicit actions** (buttons, confirmations) for destructive or confusing Git operations.
- **Refresh** status after mutating operations (checkout, commit, push, rebase, etc.).

## Out of scope (unless asked)

- Hosting or CI integration, code review inside the app, complex **merge** UI (beyond basics), submodule wizardry — unless the product brief expands.

## Repo layout (typical Tauri + Vite)

- `src/index.css` — Tailwind entry (`@import "tailwindcss"`), imported from `src/main.tsx`.
- `src/` — React UI, TypeScript.
- `src-tauri/` — Rust, Tauri config, **invoke handlers** for Git.
- `package.json` — frontend scripts; `tauri` CLI for dev/build.

When adding behavior, extend **Tauri commands** + **typed TS wrappers** (`@tauri-apps/api` `invoke`) so the UI stays thin. Register new commands in `src-tauri/src/lib.rs` and allow them in `src-tauri/capabilities/default.json` when required.
