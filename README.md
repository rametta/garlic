# 🧄 Garlic

**Garlic** is a desktop Git client with a focused UI: work in one repo at a time, run everyday Git workflows from the app, and explore history as a **branch graph** (commits and merges as a DAG), not only a flat branch list.

## What it does

- **Open & clone** — pick a local repo or clone a remote into a folder; errors and progress stay visible.
- **Branches & checkout** — list branches, create from a base, switch branches with clear handling when the tree is dirty.
- **Remotes** — view and manage remotes and URLs (`origin` and others).
- **Working tree** — see status (modified, added, deleted, renamed); stage and unstage; commit with a message.
- **Push** — push the current branch and surface upstream / common failures clearly.
- **Rebase** — rebase onto another branch or commit; when a rebase is in progress, **continue**, **abort**, or **skip** with refreshed repo state after you finish.
- **History graph** — visualize ancestry with commits as nodes and parent/merge edges.

Design goal: **simple** over exhaustive—explicit actions for risky operations, and status refreshed after commands that change the repo.

## Tech stack

| Layer | Choices |
| --- | --- |
| **App shell** | [Tauri 2](https://v2.tauri.app/) — Rust backend (`src-tauri/`), native window, `invoke` commands for Git |
| **UI** | [React](https://react.dev/) + [TypeScript](https://www.typescriptlang.org/) (`src/`) |
| **Build** | [Vite](https://vite.dev/) |
| **Styling** | [Tailwind CSS v4](https://tailwindcss.com/) (Vite plugin), [DaisyUI](https://daisyui.com/) |
| **Package manager** | [Bun](https://bun.sh/) — `bun run …` for scripts |
| **Lint / format** | [oxlint](https://oxc.rs/docs/guide/usage/linter.html), [oxfmt](https://oxc.rs/docs/guide/usage/formatter.html) |

Git work runs in the Rust layer (CLI `git` or Rust libraries), with results passed to the UI via typed Tauri commands.

## Docs & development

For architecture notes, feature checklist, repo layout, and contribution-style guidance, see [`AGENTS.md`](./AGENTS.md).

```bash
bun install
bun run tauri dev
```

Before finishing TypeScript/UI changes: `bun run fmt` and `bun run lint`.
