import { Fragment, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ask, open } from "@tauri-apps/plugin-dialog";
import { CommitGraphColumn } from "./components/CommitGraphColumn";
import { UnifiedDiff } from "./components/UnifiedDiff";
import {
  COMMIT_GRAPH_ROW_HEIGHT,
  computeCommitGraphLayout,
  type BranchTip,
} from "./commitGraphLayout";
import { resolveThemePreference } from "./theme";

/** How long to wait after `window-focused` before starting refresh (avoids stacking work on focus). */
const FOCUS_REFRESH_DEBOUNCE_MS = 350;
/**
 * On window focus, skip `list_local_branches` / `list_remote_branches` unless HEAD changed or this
 * many ms have passed since the last full branch list refresh (reduces subprocess churn).
 */
const BRANCH_LIST_FULL_REFRESH_INTERVAL_MS = 45_000;

function IconEye({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function IconEyeOff({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49" />
      <path d="M14.084 14.158a3 3 0 0 1-4.087-4.087" />
      <path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143" />
      <path d="m2 2 20 20" />
    </svg>
  );
}

interface RemoteEntry {
  name: string;
  fetchUrl: string;
}

interface RepoMetadata {
  path: string;
  name: string;
  gitRoot: string | null;
  error: string | null;
  branch: string | null;
  headShort: string | null;
  headSubject: string | null;
  headAuthor: string | null;
  headDate: string | null;
  detached: boolean;
  remotes: RemoteEntry[];
  workingTreeClean: boolean | null;
  ahead: number | null;
  behind: number | null;
}

interface CommitEntry {
  hash: string;
  shortHash: string;
  subject: string;
  author: string;
  authorEmail: string;
  date: string;
  parentHashes: string[];
  /** Set when this row is a stash WIP commit (`stash@{n}`). */
  stashRef?: string | null;
}

interface GraphCommitsPage {
  commits: CommitEntry[];
  hasMore: boolean;
}

/** From `get_commit_signature_status` (`git log -1 --format=%G?`). */
interface CommitSignatureStatus {
  verified: boolean | null;
}

/** Local branch row from `list_local_branches` / bootstrap. */
export interface LocalBranchEntry {
  name: string;
  /** Tip commit OID for this branch. */
  tipHash: string;
  /** Remote-tracking upstream ref (e.g. origin/main); null if not configured. */
  upstreamName: string | null;
  /** Commits on this branch not on upstream; null if no upstream. */
  ahead: number | null;
  /** Commits on upstream not on this branch; null if no upstream. */
  behind: number | null;
}

/** Remote-tracking branch from `list_remote_branches`. */
export interface RemoteBranchEntry {
  name: string;
  tipHash: string;
}

/** One stash from `list_stashes` / bootstrap. */
export interface StashEntry {
  refName: string;
  message: string;
}

/** Line counts from `git diff --numstat` / `--cached` (or file read for untracked). */
export interface LineStat {
  additions: number;
  deletions: number;
  isBinary: boolean;
}

/** One file changed in a commit from `list_commit_files`. */
export interface CommitFileEntry {
  path: string;
  stats: LineStat;
}

/** One path in the working tree from `list_working_tree_files` / bootstrap. */
export interface WorkingTreeFile {
  path: string;
  staged: boolean;
  unstaged: boolean;
  stagedStats?: LineStat;
  unstagedStats?: LineStat;
}

/** Repo snapshot from `restore_app_bootstrap` (`repo` field). */
export interface RestoreLastRepo {
  loadError: string | null;
  metadata: RepoMetadata | null;
  localBranches: LocalBranchEntry[];
  remoteBranches: RemoteBranchEntry[];
  stashes: StashEntry[];
  commits: CommitEntry[];
  graphCommitsHasMore: boolean;
  workingTreeFiles: WorkingTreeFile[];
  listsError: string | null;
}

function localBranchUpstreamLabel(ahead: number | null, behind: number | null): string | null {
  if (ahead === null || behind === null) return null;
  return `↑${ahead} ↓${behind}`;
}

/** Rules aligned with `git check-ref-format --branch` for short branch names. */
function branchNameValidationError(name: string): string | null {
  if (name.length === 0) return null;
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    if (c <= 0x20 || c === 0x7f) {
      return "Branch names cannot contain spaces or control characters.";
    }
  }
  if (/[~^:?*[\]\\]/.test(name)) {
    return "Branch names cannot contain ~ ^ : ? * [ ] \\.";
  }
  if (name.includes("..")) {
    return 'Branch names cannot contain "..".';
  }
  if (name.includes("@{")) {
    return 'Branch names cannot contain "@{".';
  }
  if (name.startsWith("/") || name.endsWith("/")) {
    return 'Branch names cannot start or end with "/".';
  }
  if (name.includes("//")) {
    return 'Branch names cannot contain "//".';
  }
  if (name.endsWith(".lock")) {
    return 'Branch names cannot end with ".lock".';
  }
  if (name.endsWith(".")) {
    return 'Branch names cannot end with ".".';
  }
  if (name.startsWith(".")) {
    return 'Branch names cannot start with ".".';
  }
  if (name.startsWith("-")) {
    return 'Branch names cannot start with "-".';
  }
  return null;
}

function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

/** Short relative label for dense commit rows (e.g. `2h ago`, `3d ago`). */
function formatRelativeShort(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  const t = d.getTime();
  if (Number.isNaN(t)) return null;
  const diffSec = Math.round((Date.now() - t) / 1000);
  if (diffSec < 0) {
    return formatDate(iso);
  }
  if (diffSec < 45) {
    return "now";
  }
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) {
    return `${diffMin}m ago`;
  }
  const diffH = Math.round(diffMin / 60);
  if (diffH < 24) {
    return `${diffH}h ago`;
  }
  const diffD = Math.round(diffH / 24);
  if (diffD < 7) {
    return `${diffD}d ago`;
  }
  const diffW = Math.round(diffD / 7);
  if (diffW < 8) {
    return `${diffW}w ago`;
  }
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: d.getFullYear() !== new Date().getFullYear() ? "numeric" : undefined,
  });
}

/** Prefer `Name` from Git's `Name <email>` for dense rows. */
function formatAuthorDisplay(author: string): string {
  const t = author.trim();
  const lt = t.indexOf("<");
  if (lt > 0) {
    return t.slice(0, lt).trim();
  }
  return t;
}

/** Tauri `invoke` may reject with a string or a non-Error object; normalize for display. */
function invokeErrorMessage(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  if (e !== null && typeof e === "object" && "message" in e) {
    const m = (e as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  return String(e);
}

function DiffLineStatBadge({ stat }: { stat: LineStat }) {
  if (stat.isBinary) {
    return (
      <span className="shrink-0 text-[0.65rem] text-base-content/50 tabular-nums">binary</span>
    );
  }
  return (
    <span
      className="shrink-0 text-[0.65rem] leading-none tabular-nums"
      title={`${stat.additions} insertions, ${stat.deletions} deletions`}
    >
      <span className="text-success">+{stat.additions}</span>{" "}
      <span className="text-error">−{stat.deletions}</span>
    </span>
  );
}

function StagePanelLineStats({
  variant,
  f,
}: {
  variant: "unstaged" | "staged";
  f: WorkingTreeFile;
}) {
  const s = variant === "unstaged" ? f.unstagedStats : f.stagedStats;
  if (!s) return null;
  return <DiffLineStatBadge stat={s} />;
}

function StagePanelFileRow({
  f,
  selected,
  busy,
  variant,
  onSelect,
  onStage,
  onUnstage,
}: {
  f: WorkingTreeFile;
  selected: boolean;
  busy: boolean;
  variant: "unstaged" | "staged";
  onSelect: () => void;
  onStage: () => void;
  onUnstage: () => void;
}) {
  const selectable = f.staged || f.unstaged;
  return (
    <li
      role={selectable ? "button" : undefined}
      tabIndex={selectable ? 0 : undefined}
      className={`rounded-md border bg-base-200/80 px-2 py-1 ${
        selectable
          ? `cursor-pointer transition-colors hover:bg-base-300/50 ${
              selected ? "border-primary ring-1 ring-primary/40" : "border-base-300"
            }`
          : "border-base-300"
      }`}
      onClick={() => {
        if (!selectable) return;
        onSelect();
      }}
      onKeyDown={(e) => {
        if (!selectable) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
    >
      <div className="flex min-h-7 items-center gap-2">
        <code className="min-w-0 flex-1 font-mono text-[0.7rem] leading-snug wrap-break-word text-base-content">
          {f.path}
        </code>
        <StagePanelLineStats variant={variant} f={f} />
        <div className="flex shrink-0 items-center gap-0.5">
          {variant === "unstaged" && f.unstaged ? (
            <button
              type="button"
              className="btn btn-square min-h-7 min-w-7 px-0 font-mono text-sm leading-none btn-xs btn-primary"
              disabled={busy}
              aria-label={`Stage ${f.path}`}
              title="Stage"
              onClick={(e) => {
                e.stopPropagation();
                onStage();
              }}
            >
              +
            </button>
          ) : null}
          {variant === "staged" && f.staged ? (
            <button
              type="button"
              className="btn btn-square min-h-7 min-w-7 px-0 font-mono text-sm leading-none btn-ghost btn-xs"
              disabled={busy}
              aria-label={`Unstage ${f.path}`}
              title="Unstage"
              onClick={(e) => {
                e.stopPropagation();
                onUnstage();
              }}
            >
              −
            </button>
          ) : null}
        </div>
      </div>
    </li>
  );
}

function MetaRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[8.5rem_1fr] items-baseline gap-x-4 gap-y-2 text-sm">
      <dt className="m-0 font-semibold text-base-content/70">{label}</dt>
      <dd className="m-0 min-w-0 wrap-break-word text-base-content">{children}</dd>
    </div>
  );
}

function BranchPanel({
  title,
  empty,
  emptyHint,
  headerRight,
  children,
}: {
  title: string;
  empty: boolean;
  emptyHint: string;
  /** Optional control (e.g. action button) aligned with the panel title. */
  headerRight?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="card border-base-300 bg-base-100 shadow-sm">
      <div className="card-body min-h-0 gap-0 p-0">
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-base-300 px-3 py-2">
          <h2 className="m-0 card-title min-w-0 flex-1 text-xs font-semibold tracking-wide uppercase opacity-70">
            {title}
          </h2>
          {headerRight ? <div className="shrink-0">{headerRight}</div> : null}
        </div>
        <div className="max-h-[40vh] min-h-16 overflow-y-auto p-2">
          {empty ? (
            <p className="m-0 py-2 text-center text-xs text-base-content/50">{emptyHint}</p>
          ) : (
            children
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Path segments → nested folders (supports `a` + `a/b` as in Git).
 * UI: DaisyUI [collapsible submenu](https://daisyui.com/components/menu/#collapsible-submenu) (`li` → `details` → `summary` + `ul`).
 */
type BranchTrieNode = {
  branchHere: LocalBranchEntry | null;
  children: Map<string, BranchTrieNode>;
};

function emptyBranchTrieNode(): BranchTrieNode {
  return { branchHere: null, children: new Map() };
}

function insertLocalBranchIntoTrie(root: BranchTrieNode, branch: LocalBranchEntry) {
  const parts = branch.name.split("/").filter((p) => p.length > 0);
  if (parts.length === 0) return;
  let node = root;
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i];
    if (!node.children.has(seg)) {
      node.children.set(seg, emptyBranchTrieNode());
    }
    node = node.children.get(seg)!;
    if (i === parts.length - 1) {
      node.branchHere = branch;
    }
  }
}

function buildLocalBranchTrie(branches: LocalBranchEntry[]): BranchTrieNode {
  const root = emptyBranchTrieNode();
  for (const b of branches) {
    insertLocalBranchIntoTrie(root, b);
  }
  return root;
}

/** All local branch names under this trie node (including `branchHere` and descendants). */
function collectLocalBranchNamesInSubtree(node: BranchTrieNode): string[] {
  const out: string[] = [];
  if (node.branchHere) {
    out.push(node.branchHere.name);
  }
  for (const child of node.children.values()) {
    out.push(...collectLocalBranchNamesInSubtree(child));
  }
  return out;
}

type RemoteTrieNode = {
  refHere: string | null;
  children: Map<string, RemoteTrieNode>;
};

function emptyRemoteTrieNode(): RemoteTrieNode {
  return { refHere: null, children: new Map() };
}

function insertRemoteRefIntoTrie(root: RemoteTrieNode, fullRef: string) {
  const parts = fullRef.split("/").filter((p) => p.length > 0);
  if (parts.length === 0) return;
  let node = root;
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i];
    if (!node.children.has(seg)) {
      node.children.set(seg, emptyRemoteTrieNode());
    }
    node = node.children.get(seg)!;
    if (i === parts.length - 1) {
      node.refHere = fullRef;
    }
  }
}

function buildRemoteBranchTrie(refs: RemoteBranchEntry[]): RemoteTrieNode {
  const root = emptyRemoteTrieNode();
  for (const r of refs) {
    insertRemoteRefIntoTrie(root, r.name);
  }
  return root;
}

/** All remote ref strings under this trie node (including `refHere` and descendants). */
function collectRemoteRefsInSubtree(node: RemoteTrieNode): string[] {
  const out: string[] = [];
  if (node.refHere) {
    out.push(node.refHere);
  }
  for (const child of node.children.values()) {
    out.push(...collectRemoteRefsInSubtree(child));
  }
  return out;
}

type BranchGraphControls = {
  graphVisibleLocal: (name: string) => boolean;
  toggleGraphLocal: (name: string) => void;
  graphFolderAnyVisibleLocal: (node: BranchTrieNode) => boolean;
  toggleGraphLocalFolder: (node: BranchTrieNode) => void;
  graphVisibleRemote: (name: string) => boolean;
  toggleGraphRemote: (name: string) => void;
  graphFolderAnyVisibleRemote: (node: RemoteTrieNode) => boolean;
  toggleGraphRemoteFolder: (node: RemoteTrieNode) => void;
};

function LocalBranchRow({
  branch,
  currentBranchName,
  branchBusy,
  onCheckoutLocal,
  onLocalBranchContextMenu,
  graph,
}: {
  branch: LocalBranchEntry;
  currentBranchName: string | null;
  branchBusy: string | null;
  onCheckoutLocal: (name: string) => void;
  onLocalBranchContextMenu: (branchName: string, clientX: number, clientY: number) => void;
  graph: BranchGraphControls;
}) {
  const isCurrent = currentBranchName === branch.name;
  const busy = branchBusy === `local:${branch.name}` || branchBusy === `delete:${branch.name}`;
  const upstreamLabel = localBranchUpstreamLabel(branch.ahead, branch.behind);
  const graphVisible = graph.graphVisibleLocal(branch.name);

  return (
    <li className={isCurrent ? "menu-active" : ""}>
      <div
        className="flex w-full min-w-0 items-stretch gap-0"
        onContextMenu={(e) => {
          if (isCurrent || busy) return;
          e.preventDefault();
          onLocalBranchContextMenu(branch.name, e.clientX, e.clientY);
        }}
      >
        <button
          type="button"
          disabled={busy || isCurrent}
          onClick={() => {
            onCheckoutLocal(branch.name);
          }}
          className={`flex h-auto min-h-0 min-w-0 flex-1 flex-row items-center justify-between gap-2 py-2 pr-1 pl-2 text-left ${busy ? "opacity-60" : ""}`}
        >
          <span
            className="min-w-0 flex-1 truncate text-[0.8125rem] leading-snug"
            title={busy ? undefined : branch.name}
          >
            {busy ? "Switching…" : branch.name}
            {isCurrent && !busy ? (
              <span className="ml-1.5 text-xs font-normal opacity-70">(current)</span>
            ) : null}
          </span>
          {upstreamLabel && !busy ? (
            <span
              className={`shrink-0 font-mono text-[0.65rem] leading-none tracking-tight ${
                isCurrent ? "text-inherit opacity-90" : "text-base-content/60"
              }`}
              title={
                branch.upstreamName
                  ? `Ahead of ${branch.upstreamName}: ${branch.ahead ?? 0}; behind: ${branch.behind ?? 0}`
                  : "Commits ahead / behind configured upstream"
              }
            >
              {upstreamLabel}
            </span>
          ) : null}
        </button>
        <button
          type="button"
          className="btn shrink-0 rounded-none px-2 opacity-90 btn-ghost btn-xs"
          title={graphVisible ? "Hide branch from commit graph" : "Show branch in commit graph"}
          aria-label={graphVisible ? "Hide from graph" : "Show in graph"}
          aria-pressed={graphVisible}
          disabled={busy}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            graph.toggleGraphLocal(branch.name);
          }}
        >
          {graphVisible ? (
            <IconEye className="opacity-90" />
          ) : (
            <IconEyeOff className="opacity-50" />
          )}
        </button>
      </div>
    </li>
  );
}

function renderLocalBranchTrieChildren(
  node: BranchTrieNode,
  currentBranchName: string | null,
  branchBusy: string | null,
  onCheckoutLocal: (name: string) => void,
  onLocalBranchContextMenu: (branchName: string, clientX: number, clientY: number) => void,
  graph: BranchGraphControls,
): ReactNode {
  const sorted = [...node.children.entries()].sort((a, b) =>
    a[0].localeCompare(b[0], undefined, { sensitivity: "base" }),
  );
  return sorted.map(([segment, child]) => {
    const leafOnly = child.children.size === 0 && child.branchHere !== null;
    if (leafOnly) {
      const b = child.branchHere!;
      return (
        <LocalBranchRow
          key={b.name}
          branch={b}
          currentBranchName={currentBranchName}
          branchBusy={branchBusy}
          onCheckoutLocal={onCheckoutLocal}
          onLocalBranchContextMenu={onLocalBranchContextMenu}
          graph={graph}
        />
      );
    }
    const folderGraphVisible = graph.graphFolderAnyVisibleLocal(child);
    return (
      <li key={segment}>
        <details open>
          <summary className="min-w-0 font-mono text-[0.8125rem]">
            <span className="min-w-0 wrap-break-word">{segment}</span>
            <button
              type="button"
              className="btn w-fit shrink-0 justify-self-end rounded-none px-2 opacity-90 btn-ghost btn-xs"
              title={
                folderGraphVisible
                  ? "Hide all branches in this folder from commit graph"
                  : "Show all branches in this folder in commit graph"
              }
              aria-label={folderGraphVisible ? "Hide folder from graph" : "Show folder in graph"}
              aria-pressed={folderGraphVisible}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                graph.toggleGraphLocalFolder(child);
              }}
            >
              {folderGraphVisible ? (
                <IconEye className="opacity-90" />
              ) : (
                <IconEyeOff className="opacity-50" />
              )}
            </button>
          </summary>
          <ul>
            {child.branchHere ? (
              <LocalBranchRow
                branch={child.branchHere}
                currentBranchName={currentBranchName}
                branchBusy={branchBusy}
                onCheckoutLocal={onCheckoutLocal}
                onLocalBranchContextMenu={onLocalBranchContextMenu}
                graph={graph}
              />
            ) : null}
            {renderLocalBranchTrieChildren(
              child,
              currentBranchName,
              branchBusy,
              onCheckoutLocal,
              onLocalBranchContextMenu,
              graph,
            )}
          </ul>
        </details>
      </li>
    );
  });
}

function RemoteBranchRow({
  fullRef,
  branchBusy,
  onCreateFromRemote,
  graph,
}: {
  fullRef: string;
  branchBusy: string | null;
  onCreateFromRemote: (remoteRef: string) => void;
  graph: BranchGraphControls;
}) {
  const busy = branchBusy === `remote:${fullRef}`;
  const graphVisible = graph.graphVisibleRemote(fullRef);

  return (
    <li>
      <div className="flex w-full min-w-0 items-stretch gap-0">
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            onCreateFromRemote(fullRef);
          }}
          className={`flex h-auto min-h-0 min-w-0 flex-1 justify-start py-2 pr-1 pl-2 text-left font-mono text-[0.8125rem] whitespace-normal ${busy ? "opacity-60" : ""}`}
        >
          {busy ? "Creating…" : fullRef}
        </button>
        <button
          type="button"
          className="btn shrink-0 rounded-none px-2 opacity-90 btn-ghost btn-xs"
          title={graphVisible ? "Hide remote from commit graph" : "Show remote in commit graph"}
          aria-label={graphVisible ? "Hide from graph" : "Show in graph"}
          aria-pressed={graphVisible}
          disabled={busy}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            graph.toggleGraphRemote(fullRef);
          }}
        >
          {graphVisible ? (
            <IconEye className="opacity-90" />
          ) : (
            <IconEyeOff className="opacity-50" />
          )}
        </button>
      </div>
    </li>
  );
}

function renderRemoteBranchTrieChildren(
  node: RemoteTrieNode,
  branchBusy: string | null,
  onCreateFromRemote: (remoteRef: string) => void,
  graph: BranchGraphControls,
): ReactNode {
  const sorted = [...node.children.entries()].sort((a, b) =>
    a[0].localeCompare(b[0], undefined, { sensitivity: "base" }),
  );
  return sorted.map(([segment, child]) => {
    const leafOnly = child.children.size === 0 && child.refHere !== null;
    if (leafOnly) {
      const r = child.refHere!;
      return (
        <RemoteBranchRow
          key={r}
          fullRef={r}
          branchBusy={branchBusy}
          onCreateFromRemote={onCreateFromRemote}
          graph={graph}
        />
      );
    }
    const folderGraphVisible = graph.graphFolderAnyVisibleRemote(child);
    return (
      <li key={segment}>
        <details open>
          <summary className="min-w-0 font-mono text-[0.8125rem]">
            <span className="min-w-0 wrap-break-word">{segment}</span>
            <button
              type="button"
              className="btn w-fit shrink-0 justify-self-end rounded-none px-2 opacity-90 btn-ghost btn-xs"
              title={
                folderGraphVisible
                  ? "Hide all remote branches in this folder from commit graph"
                  : "Show all remote branches in this folder in commit graph"
              }
              aria-label={folderGraphVisible ? "Hide folder from graph" : "Show folder in graph"}
              aria-pressed={folderGraphVisible}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                graph.toggleGraphRemoteFolder(child);
              }}
            >
              {folderGraphVisible ? (
                <IconEye className="opacity-90" />
              ) : (
                <IconEyeOff className="opacity-50" />
              )}
            </button>
          </summary>
          <ul>
            {child.refHere ? (
              <RemoteBranchRow
                fullRef={child.refHere}
                branchBusy={branchBusy}
                onCreateFromRemote={onCreateFromRemote}
                graph={graph}
              />
            ) : null}
            {renderRemoteBranchTrieChildren(child, branchBusy, onCreateFromRemote, graph)}
          </ul>
        </details>
      </li>
    );
  });
}

export default function App({
  startup,
  themePreference: initialThemePreference,
}: {
  startup: RestoreLastRepo;
  /** Persisted value: `auto` or a DaisyUI theme name. */
  themePreference: string;
}) {
  const [themePreference, setThemePreference] = useState(initialThemePreference);
  const [repo, setRepo] = useState<RepoMetadata | null>(() => startup.metadata ?? null);
  const [loadError, setLoadError] = useState<string | null>(() => startup.loadError ?? null);
  /** Mutations (checkout, commit, refresh, …) while a repo is open — shown inline, not as a full-panel error. */
  const [operationError, setOperationError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [localBranches, setLocalBranches] = useState<LocalBranchEntry[]>(
    () => startup.localBranches,
  );
  const [remoteBranches, setRemoteBranches] = useState<RemoteBranchEntry[]>(
    () => startup.remoteBranches,
  );
  const [stashes, setStashes] = useState<StashEntry[]>(() => startup.stashes);
  const [commits, setCommits] = useState<CommitEntry[]>(() => startup.commits);
  const [graphCommitsHasMore, setGraphCommitsHasMore] = useState(() => startup.graphCommitsHasMore);
  const [loadingMoreGraphCommits, setLoadingMoreGraphCommits] = useState(false);
  /** `local:name` / `remote:name` → visible in commit graph (default true when key missing). */
  const [graphBranchVisible, setGraphBranchVisible] = useState<Record<string, boolean>>({});
  const [workingTreeFiles, setWorkingTreeFiles] = useState<WorkingTreeFile[]>(
    () => startup.workingTreeFiles,
  );
  const [branchBusy, setBranchBusy] = useState<string | null>(null);
  /** `push` or `pop:<ref>` while a stash command runs. */
  const [stashBusy, setStashBusy] = useState<string | null>(null);
  const [listsError, setListsError] = useState<string | null>(() => startup.listsError ?? null);
  const [commitMessage, setCommitMessage] = useState("");
  const [selectedDiffPath, setSelectedDiffPath] = useState<string | null>(null);
  /** Which sidebar list opened the diff (staged vs unstaged); matters when both apply to the same path. */
  const [selectedDiffSide, setSelectedDiffSide] = useState<"unstaged" | "staged" | null>(null);
  const [diffStagedText, setDiffStagedText] = useState<string | null>(null);
  const [diffUnstagedText, setDiffUnstagedText] = useState<string | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [commitBrowseHash, setCommitBrowseHash] = useState<string | null>(null);
  const [commitBrowseFiles, setCommitBrowseFiles] = useState<CommitFileEntry[]>([]);
  const [commitBrowseLoading, setCommitBrowseLoading] = useState(false);
  const [commitBrowseError, setCommitBrowseError] = useState<string | null>(null);
  const [commitSignature, setCommitSignature] = useState<{
    loading: boolean;
    verified: boolean | null;
  }>({ loading: false, verified: null });
  const [commitDiffPath, setCommitDiffPath] = useState<string | null>(null);
  const [commitDiffText, setCommitDiffText] = useState<string | null>(null);
  const [commitDiffLoading, setCommitDiffLoading] = useState(false);
  const [commitDiffError, setCommitDiffError] = useState<string | null>(null);
  const [stageCommitBusy, setStageCommitBusy] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  const [commitPushBusy, setCommitPushBusy] = useState(false);
  const createBranchDialogRef = useRef<HTMLDialogElement>(null);
  const newBranchInputRef = useRef<HTMLInputElement>(null);
  /** Last time we ran full local+remote branch listing (used to lighten focus refreshes). */
  const lastFullBranchListRefreshAtRef = useRef(0);
  const focusRefreshDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [newBranchName, setNewBranchName] = useState("");
  const [createBranchFieldError, setCreateBranchFieldError] = useState<string | null>(null);
  /** Case-insensitive substring filter for local + remote branch lists in the sidebar. */
  const [branchListFilter, setBranchListFilter] = useState("");
  /** Right-click context menu on a local branch row (`clientX` / `clientY` for positioning). */
  const [branchContextMenu, setBranchContextMenu] = useState<{
    branchName: string;
    x: number;
    y: number;
  } | null>(null);
  /** Right-click context menu on a stash row. */
  const [stashContextMenu, setStashContextMenu] = useState<{
    stashRef: string;
    x: number;
    y: number;
  } | null>(null);
  const refreshLists = useCallback(async (repoPath: string): Promise<WorkingTreeFile[] | null> => {
    setListsError(null);
    try {
      const [locals, remotes, worktree, stashList] = await Promise.all([
        invoke<LocalBranchEntry[]>("list_local_branches", { path: repoPath }),
        invoke<RemoteBranchEntry[]>("list_remote_branches", { path: repoPath }),
        invoke<WorkingTreeFile[]>("list_working_tree_files", { path: repoPath }),
        invoke<StashEntry[]>("list_stashes", { path: repoPath }),
      ]);
      setLocalBranches(locals);
      setRemoteBranches(remotes);
      setWorkingTreeFiles(worktree);
      setStashes(stashList);
      return worktree;
    } catch (e) {
      setListsError(invokeErrorMessage(e));
      return null;
    }
  }, []);

  useEffect(() => {
    setBranchListFilter("");
  }, [repo?.path]);

  useEffect(() => {
    setBranchContextMenu(null);
    setStashContextMenu(null);
  }, [repo?.path]);

  useEffect(() => {
    if (!branchContextMenu && !stashContextMenu) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setBranchContextMenu(null);
        setStashContextMenu(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [branchContextMenu, stashContextMenu]);

  useEffect(() => {
    setGraphBranchVisible((prev) => {
      const next = { ...prev };
      const valid = new Set<string>();
      for (const b of localBranches) {
        const k = `local:${b.name}`;
        valid.add(k);
        if (!(k in next)) next[k] = true;
      }
      for (const r of remoteBranches) {
        const k = `remote:${r.name}`;
        valid.add(k);
        if (!(k in next)) next[k] = true;
      }
      for (const key of Object.keys(next)) {
        if (!valid.has(key)) delete next[key];
      }
      return next;
    });
  }, [localBranches, remoteBranches]);

  const graphRefs = useMemo(() => {
    const refs: string[] = [];
    for (const b of localBranches) {
      if (graphBranchVisible[`local:${b.name}`] !== false) refs.push(b.name);
    }
    for (const r of remoteBranches) {
      if (graphBranchVisible[`remote:${r.name}`] !== false) refs.push(r.name);
    }
    return refs;
  }, [localBranches, remoteBranches, graphBranchVisible]);

  const graphRefsKey = useMemo(() => graphRefs.join("\0"), [graphRefs]);

  const commitBrowseMeta = useMemo(
    () => (commitBrowseHash ? commits.find((c) => c.hash === commitBrowseHash) : undefined),
    [commits, commitBrowseHash],
  );

  useEffect(() => {
    if (!repo?.path || repo.error) return;
    let cancelled = false;
    void (async () => {
      try {
        const page = await invoke<GraphCommitsPage>("list_graph_commits", {
          path: repo.path,
          refs: graphRefs,
          skip: 0,
        });
        if (!cancelled) {
          setCommits(page.commits);
          setGraphCommitsHasMore(page.hasMore);
          setListsError(null);
        }
      } catch (e) {
        if (!cancelled) setListsError(invokeErrorMessage(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [repo?.path, repo?.error, graphRefsKey, graphRefs]);

  const loadMoreGraphCommits = useCallback(async () => {
    if (!repo?.path || repo.error || !graphCommitsHasMore || loadingMoreGraphCommits) return;
    setLoadingMoreGraphCommits(true);
    try {
      const page = await invoke<GraphCommitsPage>("list_graph_commits", {
        path: repo.path,
        refs: graphRefs,
        skip: commits.length,
      });
      setCommits((prev) => [...prev, ...page.commits]);
      setGraphCommitsHasMore(page.hasMore);
    } catch (e) {
      setListsError(invokeErrorMessage(e));
    } finally {
      setLoadingMoreGraphCommits(false);
    }
  }, [
    repo?.path,
    repo?.error,
    graphCommitsHasMore,
    loadingMoreGraphCommits,
    graphRefs,
    commits.length,
  ]);

  const branchGraphControls: BranchGraphControls = useMemo(
    () => ({
      graphVisibleLocal: (name) => graphBranchVisible[`local:${name}`] !== false,
      toggleGraphLocal: (name) => {
        const k = `local:${name}`;
        setGraphBranchVisible((prev) => ({ ...prev, [k]: !(prev[k] !== false) }));
      },
      graphFolderAnyVisibleLocal: (node) => {
        const names = collectLocalBranchNamesInSubtree(node);
        return names.some((n) => graphBranchVisible[`local:${n}`] !== false);
      },
      toggleGraphLocalFolder: (node) => {
        const names = collectLocalBranchNamesInSubtree(node);
        if (names.length === 0) return;
        const anyVisible = names.some((n) => graphBranchVisible[`local:${n}`] !== false);
        const nextVal = !anyVisible;
        setGraphBranchVisible((prev) => {
          const next = { ...prev };
          for (const n of names) {
            next[`local:${n}`] = nextVal;
          }
          return next;
        });
      },
      graphVisibleRemote: (name) => graphBranchVisible[`remote:${name}`] !== false,
      toggleGraphRemote: (name) => {
        const k = `remote:${name}`;
        setGraphBranchVisible((prev) => ({ ...prev, [k]: !(prev[k] !== false) }));
      },
      graphFolderAnyVisibleRemote: (node) => {
        const refs = collectRemoteRefsInSubtree(node);
        return refs.some((r) => graphBranchVisible[`remote:${r}`] !== false);
      },
      toggleGraphRemoteFolder: (node) => {
        const refs = collectRemoteRefsInSubtree(node);
        if (refs.length === 0) return;
        const anyVisible = refs.some((r) => graphBranchVisible[`remote:${r}`] !== false);
        const nextVal = !anyVisible;
        setGraphBranchVisible((prev) => {
          const next = { ...prev };
          for (const r of refs) {
            next[`remote:${r}`] = nextVal;
          }
          return next;
        });
      },
    }),
    [graphBranchVisible],
  );

  const graphBranchTips = useMemo((): BranchTip[] => {
    const tips: BranchTip[] = [];
    for (const b of localBranches) {
      if (graphBranchVisible[`local:${b.name}`] !== false) {
        tips.push({ name: b.name, tipHash: b.tipHash });
      }
    }
    for (const r of remoteBranches) {
      if (graphBranchVisible[`remote:${r.name}`] !== false) {
        tips.push({ name: r.name, tipHash: r.tipHash });
      }
    }
    tips.sort((a, b) => a.name.localeCompare(b.name));
    return tips;
  }, [localBranches, remoteBranches, graphBranchVisible]);

  const clearCommitBrowse = useCallback(() => {
    setCommitBrowseHash(null);
    setCommitBrowseFiles([]);
    setCommitBrowseLoading(false);
    setCommitBrowseError(null);
    setCommitSignature({ loading: false, verified: null });
    setCommitDiffPath(null);
    setCommitDiffText(null);
    setCommitDiffLoading(false);
    setCommitDiffError(null);
  }, []);

  const loadDiffForFile = useCallback(
    async (f: WorkingTreeFile, side: "unstaged" | "staged") => {
      if (!repo?.path || repo.error) return;
      if (side === "unstaged" && !f.unstaged) return;
      if (side === "staged" && !f.staged) return;
      clearCommitBrowse();
      setSelectedDiffPath(f.path);
      setSelectedDiffSide(side);
      setDiffLoading(true);
      setDiffError(null);
      setDiffStagedText(null);
      setDiffUnstagedText(null);
      try {
        if (side === "unstaged") {
          const unstaged = await invoke<string>("get_unstaged_diff", {
            path: repo.path,
            filePath: f.path,
          });
          setDiffUnstagedText(unstaged);
        } else {
          const staged = await invoke<string>("get_staged_diff", {
            path: repo.path,
            filePath: f.path,
          });
          setDiffStagedText(staged);
        }
      } catch (e) {
        setDiffError(invokeErrorMessage(e));
      } finally {
        setDiffLoading(false);
      }
    },
    [repo, clearCommitBrowse],
  );

  const selectCommit = useCallback(
    async (hash: string) => {
      if (!repo?.path || repo.error) return;
      setSelectedDiffPath(null);
      setSelectedDiffSide(null);
      setDiffStagedText(null);
      setDiffUnstagedText(null);
      setDiffError(null);
      setCommitBrowseHash(hash);
      setCommitBrowseFiles([]);
      setCommitDiffPath(null);
      setCommitDiffText(null);
      setCommitDiffError(null);
      setCommitBrowseLoading(true);
      setCommitBrowseError(null);
      setCommitSignature({ loading: true, verified: null });
      const [filesSettled, sigSettled] = await Promise.allSettled([
        invoke<CommitFileEntry[]>("list_commit_files", {
          path: repo.path,
          commitHash: hash,
        }),
        invoke<CommitSignatureStatus>("get_commit_signature_status", {
          path: repo.path,
          commitHash: hash,
        }),
      ]);

      if (filesSettled.status === "fulfilled") {
        setCommitBrowseFiles(filesSettled.value);
      } else {
        setCommitBrowseFiles([]);
        setCommitBrowseError(invokeErrorMessage(filesSettled.reason));
      }

      let verified: boolean | null = null;
      if (sigSettled.status === "fulfilled") {
        verified = sigSettled.value.verified ?? null;
      }
      setCommitSignature({ loading: false, verified });
      setCommitBrowseLoading(false);
    },
    [repo],
  );

  const loadCommitFileDiff = useCallback(
    async (filePath: string, commitHash: string) => {
      if (!repo?.path || repo.error || !commitHash.trim()) return;
      setCommitDiffPath(filePath);
      setCommitDiffLoading(true);
      setCommitDiffError(null);
      setCommitDiffText(null);
      try {
        const text = await invoke<string>("get_commit_file_diff", {
          path: repo.path,
          commitHash,
          filePath,
        });
        setCommitDiffText(text);
      } catch (e) {
        setCommitDiffError(invokeErrorMessage(e));
      } finally {
        setCommitDiffLoading(false);
      }
    },
    [repo],
  );

  const backFromCommitFileDiff = useCallback(() => {
    setCommitDiffPath(null);
    setCommitDiffText(null);
    setCommitDiffError(null);
    setCommitDiffLoading(false);
  }, []);

  const clearDiffSelection = useCallback(() => {
    setSelectedDiffPath(null);
    setSelectedDiffSide(null);
    setDiffStagedText(null);
    setDiffUnstagedText(null);
    setDiffError(null);
    setDiffLoading(false);
  }, []);

  const loadRepo = useCallback(
    async (selected: string) => {
      setLoading(true);
      setLoadError(null);
      setOperationError(null);
      clearCommitBrowse();
      setSelectedDiffPath(null);
      setSelectedDiffSide(null);
      setDiffStagedText(null);
      setDiffUnstagedText(null);
      setDiffError(null);
      try {
        const meta = await invoke<RepoMetadata>("get_repo_metadata", {
          path: selected,
        });
        setRepo(meta);
        if (!meta.error) {
          await invoke("set_last_repo_path", { path: selected });
          await refreshLists(selected);
          lastFullBranchListRefreshAtRef.current = Date.now();
        } else {
          setLocalBranches([]);
          setRemoteBranches([]);
          setStashes([]);
          setCommits([]);
          setGraphCommitsHasMore(false);
          setWorkingTreeFiles([]);
        }
      } catch (e) {
        setRepo(null);
        setLocalBranches([]);
        setRemoteBranches([]);
        setStashes([]);
        setCommits([]);
        setGraphCommitsHasMore(false);
        setWorkingTreeFiles([]);
        setLoadError(invokeErrorMessage(e));
        void invoke("reset_main_window_title").catch(() => {});
      } finally {
        setLoading(false);
      }
    },
    [refreshLists, clearCommitBrowse],
  );

  const refreshAfterMutation = useCallback(
    async (options?: { fromFocus?: boolean }) => {
      const fromFocus = options?.fromFocus ?? false;
      if (!repo?.path || repo.error) return;
      const prevBranch = repo.branch;
      const prevDetached = repo.detached;
      try {
        const meta = await invoke<RepoMetadata>("get_repo_metadata", {
          path: repo.path,
        });
        const branchContextChanged = meta.branch !== prevBranch || meta.detached !== prevDetached;
        setRepo(meta);
        if (!meta.error) {
          if (branchContextChanged) {
            clearCommitBrowse();
          }

          let files: WorkingTreeFile[] | null = null;

          if (!fromFocus) {
            lastFullBranchListRefreshAtRef.current = Date.now();
            files = await refreshLists(repo.path);
          } else {
            const now = Date.now();
            const needFullBranchList =
              branchContextChanged ||
              now - lastFullBranchListRefreshAtRef.current >= BRANCH_LIST_FULL_REFRESH_INTERVAL_MS;
            if (needFullBranchList) {
              lastFullBranchListRefreshAtRef.current = Date.now();
              files = await refreshLists(repo.path);
            } else {
              try {
                const [worktree, stashList] = await Promise.all([
                  invoke<WorkingTreeFile[]>("list_working_tree_files", {
                    path: repo.path,
                  }),
                  invoke<StashEntry[]>("list_stashes", { path: repo.path }),
                ]);
                setWorkingTreeFiles(worktree);
                setStashes(stashList);
                setListsError(null);
                files = worktree;
              } catch (e) {
                setListsError(invokeErrorMessage(e));
                files = null;
              }
            }
          }

          if (selectedDiffPath && files) {
            const next = files.find((w) => w.path === selectedDiffPath);
            if (next && (next.staged || next.unstaged)) {
              const preferredSide = selectedDiffSide ?? (next.unstaged ? "unstaged" : "staged");
              if (preferredSide === "unstaged" && next.unstaged) {
                void loadDiffForFile(next, "unstaged");
              } else if (preferredSide === "staged" && next.staged) {
                void loadDiffForFile(next, "staged");
              } else if (next.unstaged) {
                void loadDiffForFile(next, "unstaged");
              } else if (next.staged) {
                void loadDiffForFile(next, "staged");
              } else {
                setSelectedDiffPath(null);
                setSelectedDiffSide(null);
                setDiffStagedText(null);
                setDiffUnstagedText(null);
                setDiffError(null);
              }
            } else {
              setSelectedDiffPath(null);
              setSelectedDiffSide(null);
              setDiffStagedText(null);
              setDiffUnstagedText(null);
              setDiffError(null);
            }
          }
        }
      } catch (e) {
        setOperationError(invokeErrorMessage(e));
      }
    },
    [repo, refreshLists, selectedDiffPath, selectedDiffSide, loadDiffForFile, clearCommitBrowse],
  );

  const deleteLocalBranch = useCallback(
    async (branchName: string, force: boolean) => {
      if (!repo?.path || repo.error) return;
      const ok = await ask(
        force
          ? `Force-delete local branch "${branchName}"? Unmerged work on this branch will be lost.`
          : `Delete local branch "${branchName}"?`,
        { title: "Garlic", kind: "warning" },
      );
      if (!ok) return;
      setBranchBusy(`delete:${branchName}`);
      setOperationError(null);
      try {
        await invoke("delete_local_branch", {
          path: repo.path,
          branch: branchName,
          force,
        });
        await refreshAfterMutation();
      } catch (e) {
        setOperationError(invokeErrorMessage(e));
      } finally {
        setBranchBusy(null);
      }
    },
    [repo, refreshAfterMutation],
  );

  useEffect(() => {
    const promise = Promise.all([
      listen("open-repo-request", () => {
        void (async () => {
          const selected = await open({
            directory: true,
            multiple: false,
            title: "Open repository",
          });
          if (selected === null || Array.isArray(selected)) return;
          await loadRepo(selected);
        })();
      }),
      listen<string>("open-recent-repo", (e) => {
        const path = e.payload.trim();
        if (path) void loadRepo(path);
      }),
      listen<{ theme: string }>("theme-changed", (e) => {
        const pref = e.payload.theme;
        setThemePreference(pref);
        document.documentElement.setAttribute("data-theme", resolveThemePreference(pref));
      }),
      listen("window-focused", () => {
        if (focusRefreshDebounceRef.current !== null) {
          clearTimeout(focusRefreshDebounceRef.current);
        }
        focusRefreshDebounceRef.current = setTimeout(() => {
          focusRefreshDebounceRef.current = null;
          const run = () => {
            void refreshAfterMutation({ fromFocus: true });
          };
          if (typeof requestIdleCallback !== "undefined") {
            requestIdleCallback(run, { timeout: 600 });
          } else {
            setTimeout(run, 0);
          }
        }, FOCUS_REFRESH_DEBOUNCE_MS);
      }),
    ]);

    return () => {
      if (focusRefreshDebounceRef.current !== null) {
        clearTimeout(focusRefreshDebounceRef.current);
        focusRefreshDebounceRef.current = null;
      }
      void promise.then((listeners) => {
        for (const u of listeners) {
          u();
        }
      });
    };
  }, [loadRepo, refreshAfterMutation]);

  useEffect(() => {
    if (themePreference !== "auto") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      document.documentElement.setAttribute("data-theme", mq.matches ? "dark" : "light");
    };
    apply();
    mq.addEventListener("change", apply);
    return () => {
      mq.removeEventListener("change", apply);
    };
  }, [themePreference]);

  async function onCheckoutLocal(branch: string) {
    if (!repo?.path || repo.error) return;
    setBranchBusy(`local:${branch}`);
    setOperationError(null);
    try {
      await invoke("checkout_local_branch", {
        path: repo.path,
        branch,
      });
      await refreshAfterMutation();
    } catch (e) {
      setOperationError(invokeErrorMessage(e));
    } finally {
      setBranchBusy(null);
    }
  }

  function openCreateBranchDialog() {
    setNewBranchName("");
    setCreateBranchFieldError(null);
    setOperationError(null);
    createBranchDialogRef.current?.showModal();
    requestAnimationFrame(() => {
      newBranchInputRef.current?.focus();
    });
  }

  async function submitCreateBranch() {
    const trimmed = newBranchName.trim();
    if (!repo?.path || repo.error) return;
    if (!trimmed) {
      setCreateBranchFieldError("Enter a branch name.");
      return;
    }
    const nameErr = branchNameValidationError(trimmed);
    if (nameErr) {
      setCreateBranchFieldError(nameErr);
      return;
    }
    setCreateBranchFieldError(null);
    setBranchBusy("create");
    setOperationError(null);
    try {
      await invoke("create_local_branch", {
        path: repo.path,
        branch: trimmed,
      });
      createBranchDialogRef.current?.close();
      await refreshAfterMutation();
    } catch (e) {
      setOperationError(invokeErrorMessage(e));
    } finally {
      setBranchBusy(null);
    }
  }

  async function onCreateFromRemote(remoteRef: string) {
    if (!repo?.path || repo.error) return;
    setBranchBusy(`remote:${remoteRef}`);
    setOperationError(null);
    try {
      await invoke("create_branch_from_remote", {
        path: repo.path,
        remoteRef,
      });
      await refreshAfterMutation();
    } catch (e) {
      setOperationError(invokeErrorMessage(e));
    } finally {
      setBranchBusy(null);
    }
  }

  async function onStashPush() {
    if (!repo?.path || repo.error) return;
    setStashBusy("push");
    setOperationError(null);
    try {
      await invoke("stash_push", { path: repo.path, message: null });
      await refreshAfterMutation();
    } catch (e) {
      setOperationError(invokeErrorMessage(e));
    } finally {
      setStashBusy(null);
    }
  }

  async function onStashPop(stashRef: string) {
    if (!repo?.path || repo.error) return;
    const ok = await ask(`Pop ${stashRef} and apply its changes to the working tree?`, {
      title: "Garlic",
      kind: "warning",
    });
    if (!ok) return;
    setStashBusy(`pop:${stashRef}`);
    setOperationError(null);
    try {
      await invoke("stash_pop", { path: repo.path, stashRef });
      await refreshAfterMutation();
    } catch (e) {
      setOperationError(invokeErrorMessage(e));
    } finally {
      setStashBusy(null);
    }
  }

  async function onStashDrop(stashRef: string) {
    if (!repo?.path || repo.error) return;
    const ok = await ask(`Drop ${stashRef} permanently? This cannot be undone.`, {
      title: "Garlic",
      kind: "warning",
    });
    if (!ok) return;
    setStashBusy(`drop:${stashRef}`);
    setOperationError(null);
    try {
      await invoke("stash_drop", { path: repo.path, stashRef });
      await refreshAfterMutation();
    } catch (e) {
      setOperationError(invokeErrorMessage(e));
    } finally {
      setStashBusy(null);
    }
  }

  async function onStagePaths(paths: string[]) {
    if (!repo?.path || repo.error || paths.length === 0) return;
    setStageCommitBusy(true);
    setOperationError(null);
    try {
      await invoke("stage_paths", { path: repo.path, paths });
      await refreshAfterMutation();
    } catch (e) {
      setOperationError(invokeErrorMessage(e));
    } finally {
      setStageCommitBusy(false);
    }
  }

  async function onUnstagePaths(paths: string[]) {
    if (!repo?.path || repo.error || paths.length === 0) return;
    setStageCommitBusy(true);
    setOperationError(null);
    try {
      await invoke("unstage_paths", { path: repo.path, paths });
      await refreshAfterMutation();
    } catch (e) {
      setOperationError(invokeErrorMessage(e));
    } finally {
      setStageCommitBusy(false);
    }
  }

  async function onCommit() {
    if (!repo?.path || repo.error) return;
    const msg = commitMessage.trim();
    if (!msg) return;
    setStageCommitBusy(true);
    setOperationError(null);
    try {
      await invoke("commit_staged", { path: repo.path, message: msg });
      setCommitMessage("");
      await refreshAfterMutation();
    } catch (e) {
      setOperationError(invokeErrorMessage(e));
    } finally {
      setStageCommitBusy(false);
    }
  }

  async function onPushToOrigin() {
    if (!repo?.path || repo.error) return;
    setPushBusy(true);
    setOperationError(null);
    try {
      await invoke("push_to_origin", { path: repo.path });
      await refreshAfterMutation();
    } catch (e) {
      setOperationError(invokeErrorMessage(e));
    } finally {
      setPushBusy(false);
    }
  }

  async function onCommitAndPush() {
    if (!repo?.path || repo.error || repo.detached) return;
    const msg = commitMessage.trim();
    if (!msg) return;
    if (!workingTreeFiles.some((f) => f.staged)) return;
    setCommitPushBusy(true);
    setOperationError(null);
    try {
      await invoke("commit_staged", { path: repo.path, message: msg });
      setCommitMessage("");
      await invoke("push_to_origin", { path: repo.path });
      await refreshAfterMutation();
    } catch (e) {
      setOperationError(invokeErrorMessage(e));
      void refreshAfterMutation();
    } finally {
      setCommitPushBusy(false);
    }
  }

  const canShowBranches = Boolean(repo && !repo.error && !loading);
  const currentBranchName = repo?.detached ? null : (repo?.branch ?? null);
  const commitsSectionTitle =
    currentBranchName ??
    (repo?.detached
      ? repo.headShort
        ? `Detached (${repo.headShort})`
        : "Detached HEAD"
      : (repo?.headShort ?? "Current branch"));

  const hasStagedFiles = workingTreeFiles.some((f) => f.staged);
  const unstagedFiles = workingTreeFiles.filter((f) => f.unstaged);
  const stagedFiles = workingTreeFiles.filter((f) => f.staged);
  const unstagedPaths = unstagedFiles.map((f) => f.path);
  const stagedPaths = stagedFiles.map((f) => f.path);
  const canCommit =
    Boolean(repo?.path && !repo.error && !loading) &&
    hasStagedFiles &&
    commitMessage.trim().length > 0 &&
    !stageCommitBusy &&
    !commitPushBusy;
  const canPush =
    Boolean(repo?.path && !repo.error && !loading) &&
    !repo?.detached &&
    !stageCommitBusy &&
    !commitPushBusy &&
    !pushBusy;
  const canCommitAndPush = canCommit && !repo?.detached && !pushBusy;

  const newBranchTrimmed = newBranchName.trim();
  const newBranchNameInvalid =
    newBranchTrimmed.length > 0 && branchNameValidationError(newBranchTrimmed) !== null;
  const canSubmitNewBranch =
    newBranchTrimmed.length > 0 && !newBranchNameInvalid && branchBusy !== "create";

  const showExpandedDiff =
    Boolean(selectedDiffPath || commitDiffPath) && !listsError && Boolean(repo && !repo.error);

  const branchFilterNorm = branchListFilter.trim().toLowerCase();
  const filteredLocalBranches = useMemo(() => {
    if (!branchFilterNorm) return localBranches;
    return localBranches.filter((b) => b.name.toLowerCase().includes(branchFilterNorm));
  }, [localBranches, branchFilterNorm]);
  const filteredRemoteBranches = useMemo(() => {
    if (!branchFilterNorm) return remoteBranches;
    return remoteBranches.filter((r) => r.name.toLowerCase().includes(branchFilterNorm));
  }, [remoteBranches, branchFilterNorm]);

  const localBranchTrieRoot = useMemo(
    () => buildLocalBranchTrie(filteredLocalBranches),
    [filteredLocalBranches],
  );
  const remoteBranchTrieRoot = useMemo(
    () => buildRemoteBranchTrie(filteredRemoteBranches),
    [filteredRemoteBranches],
  );

  const localBranchesEmptyHint =
    localBranches.length === 0 ? "No local branches" : "No branches match filter";
  const remoteBranchesEmptyHint =
    remoteBranches.length === 0 ? "No remote-tracking branches" : "No branches match filter";

  const commitGraphLayout = useMemo(
    () =>
      computeCommitGraphLayout(
        commits.map((c) => ({ hash: c.hash, parentHashes: c.parentHashes })),
        graphBranchTips,
        currentBranchName,
      ),
    [commits, graphBranchTips, currentBranchName],
  );

  return (
    <main className="box-border flex min-h-screen flex-col bg-base-200 px-4 pt-6 pb-8 text-base-content antialiased [font-synthesis:none]">
      <div
        className="grid min-h-0 min-w-0 flex-1 grid-cols-12 gap-4 lg:min-h-[calc(100vh-5rem)] lg:items-stretch"
        aria-live="polite"
        aria-busy={loading}
      >
        <aside className="col-span-12 flex min-h-0 min-w-0 flex-col gap-3 lg:sticky lg:top-6 lg:col-span-3">
          <dialog
            ref={createBranchDialogRef}
            className="modal"
            onClick={(e) => {
              if (e.target === e.currentTarget) {
                e.currentTarget.close();
              }
            }}
            onClose={() => {
              setNewBranchName("");
              setCreateBranchFieldError(null);
            }}
          >
            <div
              className="modal-box"
              onClick={(e) => {
                e.stopPropagation();
              }}
            >
              <h3 className="m-0 text-lg font-bold">New local branch</h3>
              <p className="mt-1 mb-0 text-sm text-base-content/70">
                Creates a branch from the current commit and switches to it.
              </p>
              <label className="form-control mt-4 w-full">
                <span className="label-text mb-1">Branch name</span>
                <input
                  ref={newBranchInputRef}
                  type="text"
                  className="input-bordered input w-full font-mono text-sm"
                  value={newBranchName}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={branchBusy === "create"}
                  onChange={(e) => {
                    setNewBranchName(e.target.value);
                    if (createBranchFieldError) setCreateBranchFieldError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === " ") {
                      e.preventDefault();
                    }
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void submitCreateBranch();
                    }
                  }}
                />
                {createBranchFieldError ? (
                  <span className="label-text-alt text-error">{createBranchFieldError}</span>
                ) : newBranchNameInvalid ? (
                  <span className="label-text-alt text-error">
                    {branchNameValidationError(newBranchTrimmed)}
                  </span>
                ) : null}
              </label>
              <div className="modal-action">
                <button
                  type="button"
                  className="btn"
                  disabled={branchBusy === "create"}
                  onClick={() => createBranchDialogRef.current?.close()}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={!canSubmitNewBranch}
                  onClick={() => void submitCreateBranch()}
                >
                  {branchBusy === "create" ? (
                    <span className="loading loading-sm loading-spinner" />
                  ) : (
                    "Create"
                  )}
                </button>
              </div>
            </div>
          </dialog>

          {canShowBranches ? (
            <label className="form-control w-full shrink-0">
              <span className="label-text mb-1 text-xs font-semibold tracking-wide uppercase opacity-70">
                Filter branches
              </span>
              <input
                type="search"
                className="input-bordered input input-sm w-full font-mono text-sm"
                value={branchListFilter}
                onChange={(e) => {
                  setBranchListFilter(e.target.value);
                }}
                placeholder="Filter by name…"
                autoComplete="off"
                spellCheck={false}
                aria-label="Filter branch lists by name"
              />
            </label>
          ) : null}

          <BranchPanel
            title="Local branches"
            empty={canShowBranches && filteredLocalBranches.length === 0}
            emptyHint={localBranchesEmptyHint}
            headerRight={
              canShowBranches ? (
                <button
                  type="button"
                  className="btn btn-ghost btn-xs"
                  disabled={Boolean(branchBusy)}
                  onClick={() => {
                    openCreateBranchDialog();
                  }}
                >
                  New branch
                </button>
              ) : null
            }
          >
            {canShowBranches ? (
              <ul className="menu w-full menu-sm rounded-md bg-transparent p-0">
                {renderLocalBranchTrieChildren(
                  localBranchTrieRoot,
                  currentBranchName,
                  branchBusy,
                  (name) => {
                    void onCheckoutLocal(name);
                  },
                  (branchName, clientX, clientY) => {
                    setStashContextMenu(null);
                    setBranchContextMenu({ branchName, x: clientX, y: clientY });
                  },
                  branchGraphControls,
                )}
              </ul>
            ) : null}
          </BranchPanel>

          <BranchPanel
            title="Remote branches"
            empty={canShowBranches && filteredRemoteBranches.length === 0}
            emptyHint={remoteBranchesEmptyHint}
          >
            {canShowBranches ? (
              <ul className="menu w-full menu-sm rounded-md bg-transparent p-0">
                {renderRemoteBranchTrieChildren(
                  remoteBranchTrieRoot,
                  branchBusy,
                  (remoteRef) => {
                    void onCreateFromRemote(remoteRef);
                  },
                  branchGraphControls,
                )}
              </ul>
            ) : null}
          </BranchPanel>

          <BranchPanel
            title="Stashes"
            empty={canShowBranches && stashes.length === 0}
            emptyHint="No stashes"
            headerRight={
              canShowBranches ? (
                <button
                  type="button"
                  className="btn btn-ghost btn-xs"
                  disabled={Boolean(branchBusy) || stashBusy !== null}
                  onClick={() => {
                    void onStashPush();
                  }}
                >
                  {stashBusy === "push" ? "…" : "Stash"}
                </button>
              ) : null
            }
          >
            {canShowBranches ? (
              <ul className="menu w-full menu-sm rounded-md bg-transparent p-0">
                {stashes.map((s) => {
                  const popping = stashBusy === `pop:${s.refName}`;
                  const stashRowBusy = Boolean(branchBusy) || stashBusy !== null;
                  return (
                    <li key={s.refName}>
                      <div
                        className="flex w-full min-w-0 items-stretch gap-0"
                        onContextMenu={(e) => {
                          if (stashRowBusy) return;
                          e.preventDefault();
                          setBranchContextMenu(null);
                          setStashContextMenu({
                            stashRef: s.refName,
                            x: e.clientX,
                            y: e.clientY,
                          });
                        }}
                      >
                        <span
                          className="flex min-h-0 min-w-0 flex-1 flex-col justify-center gap-0.5 py-2 pr-1 pl-2 text-left"
                          title={`${s.refName}: ${s.message}`}
                        >
                          <span className="font-mono text-[0.65rem] leading-none opacity-70">
                            {s.refName}
                          </span>
                          <span className="truncate text-[0.8125rem] leading-snug">
                            {s.message}
                          </span>
                        </span>
                        <button
                          type="button"
                          className="btn shrink-0 self-stretch rounded-none px-2 btn-ghost btn-xs"
                          title="Pop stash"
                          disabled={stashRowBusy}
                          onClick={() => {
                            void onStashPop(s.refName);
                          }}
                        >
                          {popping ? "…" : "Pop"}
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </BranchPanel>
        </aside>

        <div
          className={`col-span-12 flex min-w-0 flex-col gap-4 lg:col-span-6 ${
            showExpandedDiff ? "min-h-0 min-w-0 lg:flex lg:h-full lg:flex-col" : ""
          }`}
        >
          <section
            className={`card w-full min-w-0 border-base-300 bg-base-100 shadow-md ${
              showExpandedDiff ? "flex min-h-0 min-w-0 flex-1 flex-col" : ""
            }`}
          >
            <div
              className={`card-body px-6 py-5 ${
                showExpandedDiff ? "flex min-h-0 min-w-0 flex-1 flex-col gap-0" : ""
              }`}
            >
              {loading ? (
                <div className="flex flex-col items-center justify-center gap-3 py-4">
                  <span className="loading loading-md loading-spinner text-primary" />
                  <p className="m-0 text-center text-[0.9375rem] text-base-content/80">
                    Loading repository…
                  </p>
                </div>
              ) : loadError ? (
                <div role="alert" className="alert text-sm alert-error">
                  <span>{loadError}</span>
                </div>
              ) : repo ? (
                <>
                  {repo.error ? (
                    <>
                      <div role="status" className="alert text-sm alert-warning">
                        <span>{repo.error}</span>
                      </div>
                      <dl className="m-0 mt-4 flex flex-col gap-2.5">
                        <MetaRow label="Path">{repo.path}</MetaRow>
                      </dl>
                    </>
                  ) : (
                    <>
                      {listsError ? (
                        <div role="alert" className="mb-3 alert text-sm alert-error">
                          <span>{listsError}</span>
                        </div>
                      ) : null}
                      {operationError ? (
                        <div role="alert" className="mb-3 alert text-sm alert-error">
                          <span className="wrap-break-word whitespace-pre-wrap">
                            {operationError}
                          </span>
                        </div>
                      ) : null}

                      {!listsError && selectedDiffPath ? (
                        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
                          <div className="flex shrink-0 flex-wrap items-start justify-between gap-3 border-b border-base-300 pb-3">
                            <div className="min-w-0">
                              <h2 className="m-0 font-mono text-sm font-semibold tracking-wide text-base-content opacity-90">
                                Diff
                              </h2>
                              <code className="mt-1 block font-mono text-xs wrap-break-word text-base-content/80">
                                {selectedDiffPath}
                              </code>
                              {selectedDiffSide ? (
                                <p className="mt-1 mb-0 text-xs text-base-content/65">
                                  {selectedDiffSide === "staged"
                                    ? "Staged changes"
                                    : "Unstaged changes"}
                                </p>
                              ) : null}
                            </div>
                            <button
                              type="button"
                              className="btn shrink-0 btn-sm btn-primary"
                              onClick={clearDiffSelection}
                            >
                              Back to commits
                            </button>
                          </div>
                          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                            {diffLoading ? (
                              <div className="flex flex-1 flex-col items-center justify-center gap-3 py-20">
                                <span className="loading loading-md loading-spinner text-primary" />
                                <p className="m-0 text-sm text-base-content/70">Loading diff…</p>
                              </div>
                            ) : diffError ? (
                              <div role="alert" className="alert text-sm alert-error">
                                <span className="wrap-break-word">{diffError}</span>
                              </div>
                            ) : (
                              <div className="min-h-0 w-full min-w-0 flex-1 overflow-auto rounded-lg border border-base-300 bg-base-200/40 p-4">
                                {diffStagedText !== null ? (
                                  <div className="mb-8 last:mb-0">
                                    <div className="m-0 mb-2 text-xs font-semibold tracking-wide uppercase opacity-70">
                                      Staged
                                    </div>
                                    <UnifiedDiff
                                      text={diffStagedText}
                                      emptyLabel="(no staged diff)"
                                    />
                                  </div>
                                ) : null}
                                {diffUnstagedText !== null ? (
                                  <div>
                                    <div className="m-0 mb-2 text-xs font-semibold tracking-wide uppercase opacity-70">
                                      Unstaged
                                    </div>
                                    <UnifiedDiff
                                      text={diffUnstagedText}
                                      emptyLabel="(no unstaged diff)"
                                    />
                                  </div>
                                ) : null}
                              </div>
                            )}
                          </div>
                        </div>
                      ) : !listsError && commitDiffPath && commitBrowseHash ? (
                        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
                          <div className="flex shrink-0 flex-wrap items-start justify-between gap-2 border-b border-base-300 pb-1.5">
                            <button
                              type="button"
                              className="btn shrink-0 btn-xs btn-primary"
                              onClick={backFromCommitFileDiff}
                            >
                              Back to files
                            </button>
                            <div className="min-w-0 flex-1 text-right">
                              <h2 className="m-0 text-[0.65rem] font-semibold tracking-wide text-base-content/50 uppercase">
                                Commit diff
                              </h2>
                              <code className="mt-0.5 block font-mono text-[0.65rem] leading-tight wrap-break-word text-base-content/85">
                                {commitDiffPath}
                              </code>
                              <p className="mt-0.5 mb-0 font-mono text-[0.6rem] text-base-content/50">
                                {commits.find((x) => x.hash === commitBrowseHash)?.shortHash ??
                                  commitBrowseHash.slice(0, 7)}
                              </p>
                            </div>
                          </div>
                          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                            {commitDiffLoading ? (
                              <div className="flex flex-1 flex-col items-center justify-center gap-2 py-12">
                                <span className="loading loading-md loading-spinner text-primary" />
                                <p className="m-0 text-xs text-base-content/70">Loading diff…</p>
                              </div>
                            ) : commitDiffError ? (
                              <div role="alert" className="alert py-2 text-xs alert-error">
                                <span className="wrap-break-word">{commitDiffError}</span>
                              </div>
                            ) : (
                              <div className="min-h-0 w-full min-w-0 flex-1 overflow-auto rounded border border-base-300/80 bg-base-200/30 p-2">
                                <div className="m-0 mb-1.5 text-[0.6rem] font-semibold tracking-wide text-base-content/45 uppercase">
                                  Patch
                                </div>
                                <UnifiedDiff
                                  text={commitDiffText ?? ""}
                                  emptyLabel="(no diff for this file)"
                                />
                              </div>
                            )}
                          </div>
                        </div>
                      ) : !listsError && commitBrowseHash ? (
                        <div className="mb-4 flex min-h-0 min-w-0 flex-col gap-2">
                          <div className="flex shrink-0 flex-wrap items-start justify-between gap-2">
                            <button
                              type="button"
                              className="btn shrink-0 btn-xs btn-primary"
                              onClick={clearCommitBrowse}
                            >
                              Back to commits
                            </button>
                            <div className="max-w-[min(100%,20rem)] min-w-0 flex-1 text-right">
                              {commitBrowseMeta?.author.trim() ? (
                                <p className="m-0 text-[0.7rem] leading-snug font-medium text-base-content/90">
                                  {commitBrowseMeta.author.trim()}
                                </p>
                              ) : null}
                              {commitBrowseMeta?.authorEmail.trim() ? (
                                <code className="mt-0.5 block font-mono text-[0.6rem] leading-snug wrap-break-word text-base-content/65">
                                  {commitBrowseMeta.authorEmail.trim()}
                                </code>
                              ) : null}
                              {commitSignature.loading ? (
                                <p
                                  className={`mb-0 text-[0.6rem] text-base-content/50 ${
                                    commitBrowseMeta?.author.trim() ||
                                    commitBrowseMeta?.authorEmail.trim()
                                      ? "mt-1"
                                      : "mt-0"
                                  }`}
                                >
                                  Signature: checking…
                                </p>
                              ) : (
                                <p
                                  className={`mb-0 text-[0.6rem] text-base-content/60 ${
                                    commitBrowseMeta?.author.trim() ||
                                    commitBrowseMeta?.authorEmail.trim()
                                      ? "mt-1"
                                      : "mt-0"
                                  }`}
                                >
                                  Signature:{" "}
                                  {commitSignature.verified === true ? (
                                    <span className="text-success">verified</span>
                                  ) : commitSignature.verified === false ? (
                                    <span className="text-base-content/70">not verified</span>
                                  ) : (
                                    <span className="text-base-content/50">unknown</span>
                                  )}
                                </p>
                              )}
                            </div>
                          </div>
                          <div className="shrink-0 border-b border-base-300 pb-1.5">
                            <div className="min-w-0">
                              <h2 className="m-0 text-[0.65rem] font-semibold tracking-wide text-base-content/50 uppercase">
                                Files in commit
                              </h2>
                              <p className="mt-0.5 mb-0 truncate font-mono text-[0.65rem] leading-tight text-base-content/80">
                                {commitBrowseMeta?.subject ?? commitBrowseHash.slice(0, 7)}
                              </p>
                            </div>
                          </div>
                          {commitBrowseLoading ? (
                            <div className="flex flex-col items-center justify-center gap-2 py-8">
                              <span className="loading loading-md loading-spinner text-primary" />
                              <p className="m-0 text-xs text-base-content/70">Loading files…</p>
                            </div>
                          ) : commitBrowseError ? (
                            <div role="alert" className="alert py-2 text-xs alert-error">
                              <span className="wrap-break-word">{commitBrowseError}</span>
                            </div>
                          ) : commitBrowseFiles.length === 0 ? (
                            <p className="m-0 text-center text-xs text-base-content/60">
                              No files changed in this commit
                            </p>
                          ) : (
                            <ul className="m-0 flex max-h-[min(52vh,28rem)] list-none flex-col gap-2 overflow-y-auto py-1 pr-0.5">
                              {commitBrowseFiles.map((entry) => (
                                <li key={entry.path}>
                                  <button
                                    type="button"
                                    className="flex min-h-10 w-full items-center gap-2 rounded-lg border border-base-300/40 bg-base-200/50 px-3 py-2.5 text-left text-sm leading-snug transition-colors hover:border-base-300 hover:bg-base-300/45 active:bg-base-300/55"
                                    onClick={() =>
                                      void loadCommitFileDiff(entry.path, commitBrowseHash ?? "")
                                    }
                                  >
                                    <code className="min-w-0 flex-1 font-mono wrap-break-word text-base-content/95">
                                      {entry.path}
                                    </code>
                                    <DiffLineStatBadge stat={entry.stats} />
                                  </button>
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      ) : (
                        <div className="mb-4 min-w-0">
                          <h2 className="m-0 mb-1.5 flex flex-wrap items-baseline gap-x-2 gap-y-0 border-b border-base-300 pb-1.5 text-[0.65rem] font-semibold tracking-wide text-base-content/50 uppercase">
                            <span>Commits</span>
                            <span className="font-mono text-[0.6rem] font-normal tracking-normal text-base-content/55 normal-case">
                              {commits.length}
                              {graphCommitsHasMore ? "+" : ""}
                            </span>
                          </h2>
                          {commits.length === 0 ? (
                            <p className="m-0 text-center text-xs text-base-content/60">
                              No commits to show
                            </p>
                          ) : (
                            <>
                              <div
                                className="mb-0.5 grid items-center gap-x-1.5 border-b border-base-300/80 px-1 pb-0.5 text-[0.6rem] font-semibold tracking-wide text-base-content/45 uppercase"
                                style={{
                                  gridTemplateColumns: `minmax(0, 6.75rem) ${commitGraphLayout.graphWidthPx}px minmax(0, 1fr) minmax(0, 6.5rem) minmax(0, 3.25rem)`,
                                }}
                              >
                                <span className="truncate">Branch</span>
                                <span className="text-center text-[0.55rem] opacity-70">Graph</span>
                                <span className="min-w-0 truncate">Commit message</span>
                                <span className="min-w-0 truncate">Author</span>
                                <span className="text-right">When</span>
                              </div>
                              <div
                                className="grid w-full min-w-0 gap-x-1.5"
                                style={{
                                  gridTemplateColumns: `minmax(0, 6.75rem) ${commitGraphLayout.graphWidthPx}px minmax(0, 1fr) minmax(0, 6.5rem) minmax(0, 3.25rem)`,
                                  gridTemplateRows: `repeat(${commits.length}, ${COMMIT_GRAPH_ROW_HEIGHT}px)`,
                                }}
                              >
                                {commits.map((c, idx) => {
                                  const stashRef = c.stashRef?.trim() || null;
                                  const visibleLocalTips = localBranches.filter(
                                    (b) =>
                                      graphBranchVisible[`local:${b.name}`] !== false &&
                                      b.tipHash === c.hash,
                                  );
                                  const visibleRemoteTips = remoteBranches.filter(
                                    (r) =>
                                      graphBranchVisible[`remote:${r.name}`] !== false &&
                                      r.tipHash === c.hash,
                                  );
                                  const sortedNames = commitGraphLayout.branchNamesSorted;
                                  const tipsHereNames = [
                                    ...visibleLocalTips.map((b) => b.name),
                                    ...visibleRemoteTips.map((r) => r.name),
                                  ];
                                  const firstTipName = sortedNames.find((n) =>
                                    tipsHereNames.includes(n),
                                  );
                                  const laneIdx = firstTipName
                                    ? sortedNames.indexOf(firstTipName)
                                    : -1;
                                  const laneColor =
                                    laneIdx >= 0
                                      ? commitGraphLayout.laneColors[
                                          laneIdx % commitGraphLayout.laneColors.length
                                        ]
                                      : undefined;
                                  const hasBranchTips =
                                    visibleLocalTips.length > 0 || visibleRemoteTips.length > 0;
                                  const branchCell = hasBranchTips ? (
                                    <span
                                      className="flex min-w-0 flex-wrap items-center gap-x-1 gap-y-0.5 text-[0.62rem] leading-tight text-base-content"
                                      title={tipsHereNames.join(", ")}
                                      style={
                                        laneColor
                                          ? {
                                              borderLeft: `2px solid ${laneColor}`,
                                              paddingLeft: 4,
                                            }
                                          : undefined
                                      }
                                    >
                                      {visibleLocalTips.some(
                                        (b) => b.name === currentBranchName,
                                      ) ? (
                                        <span className="shrink-0 text-primary" aria-hidden>
                                          ✓
                                        </span>
                                      ) : null}
                                      {visibleLocalTips.map((b) => (
                                        <span
                                          key={`l:${b.name}`}
                                          className="max-w-full min-w-0 truncate font-medium"
                                        >
                                          {b.name}
                                        </span>
                                      ))}
                                      {visibleLocalTips.length > 0 &&
                                      visibleRemoteTips.length > 0 ? (
                                        <span
                                          className="shrink-0 text-[0.55rem] text-base-content/45"
                                          aria-hidden
                                        >
                                          ·
                                        </span>
                                      ) : null}
                                      {visibleRemoteTips.map((r) => (
                                        <span
                                          key={`r:${r.name}`}
                                          className="max-w-full min-w-0 truncate font-medium text-secondary"
                                        >
                                          {r.name}
                                        </span>
                                      ))}
                                    </span>
                                  ) : stashRef ? (
                                    <span
                                      className="flex min-w-0 flex-wrap items-center gap-1 text-[0.62rem] leading-tight text-base-content"
                                      title={`Stash ${stashRef}`}
                                    >
                                      <span className="badge shrink-0 font-mono badge-xs badge-warning">
                                        {stashRef}
                                      </span>
                                    </span>
                                  ) : idx === 0 ? (
                                    <span
                                      className="flex min-w-0 items-center gap-0.5 truncate text-[0.65rem] leading-tight text-base-content/85"
                                      title={commitsSectionTitle}
                                    >
                                      <span className="shrink-0 text-primary" aria-hidden>
                                        ✓
                                      </span>
                                      <span className="min-w-0 truncate font-medium">
                                        {commitsSectionTitle}
                                      </span>
                                    </span>
                                  ) : null;
                                  const isBrowsing = commitBrowseHash === c.hash;
                                  const rel = formatRelativeShort(c.date);
                                  const fullTitle = [
                                    stashRef
                                      ? `${stashRef} — ${c.shortHash} — ${c.subject}`
                                      : `${c.shortHash} — ${c.subject}`,
                                    c.author,
                                    formatDate(c.date) ?? undefined,
                                  ]
                                    .filter(Boolean)
                                    .join("\n");
                                  const rowRule =
                                    idx < commits.length - 1 ? "border-b border-base-300/40" : "";
                                  return (
                                    <Fragment key={c.hash}>
                                      <div
                                        className={`flex min-h-0 min-w-0 items-center px-0.5 ${rowRule}`}
                                        style={{ gridColumn: 1, gridRow: idx + 1 }}
                                      >
                                        {branchCell}
                                      </div>
                                      <button
                                        type="button"
                                        title={fullTitle}
                                        className={`grid h-full min-h-0 w-full grid-cols-[minmax(0,1fr)_minmax(0,6.5rem)_minmax(0,3.25rem)] items-center gap-x-1.5 px-1 text-left text-[0.6875rem] leading-tight transition-colors ${rowRule} ${
                                          isBrowsing
                                            ? "bg-primary/20 ring-1 ring-primary/35 ring-inset"
                                            : "hover:bg-base-300/40"
                                        }`}
                                        style={{ gridColumn: "3 / 6", gridRow: idx + 1 }}
                                        onClick={() => void selectCommit(c.hash)}
                                      >
                                        <span className="min-w-0 truncate text-base-content/90">
                                          {c.subject}
                                        </span>
                                        <span
                                          className="min-w-0 truncate text-[0.62rem] text-base-content/55"
                                          title={c.author.trim() || undefined}
                                        >
                                          {formatAuthorDisplay(c.author) || "—"}
                                        </span>
                                        <span
                                          className="shrink-0 text-right text-[0.6rem] text-base-content/45 tabular-nums"
                                          title={formatDate(c.date) ?? undefined}
                                        >
                                          {rel ?? "—"}
                                        </span>
                                      </button>
                                    </Fragment>
                                  );
                                })}
                                <div
                                  className="flex min-h-0 items-start justify-center self-stretch"
                                  style={{
                                    gridColumn: 2,
                                    gridRow: `1 / span ${commits.length}`,
                                  }}
                                >
                                  <CommitGraphColumn
                                    layout={commitGraphLayout}
                                    commitCount={commits.length}
                                  />
                                </div>
                              </div>
                              {graphCommitsHasMore ? (
                                <div className="mt-2 flex justify-center border-t border-base-300/50 pt-2">
                                  <button
                                    type="button"
                                    className="btn btn-outline btn-sm"
                                    disabled={loadingMoreGraphCommits}
                                    onClick={() => void loadMoreGraphCommits()}
                                  >
                                    {loadingMoreGraphCommits ? (
                                      <>
                                        <span className="loading loading-xs loading-spinner" />
                                        Loading…
                                      </>
                                    ) : (
                                      "Load more commits"
                                    )}
                                  </button>
                                </div>
                              ) : null}
                            </>
                          )}
                        </div>
                      )}
                    </>
                  )}
                </>
              ) : (
                <p className="m-0 text-center text-[0.9375rem] text-base-content/60">
                  No repository open
                </p>
              )}
            </div>
          </section>
        </div>

        <aside className="col-span-12 flex min-h-0 min-w-0 flex-col gap-3 lg:sticky lg:top-6 lg:col-span-3 lg:h-full lg:max-h-[calc(100vh-5rem)] lg:min-h-0">
          <div className="card flex min-h-0 min-w-0 flex-1 flex-col border-base-300 bg-base-100 shadow-sm">
            <div className="card-body flex min-h-0 flex-1 flex-col gap-0 p-0">
              <section
                className="flex min-h-0 flex-[1_1_0%] flex-col border-b border-base-300"
                aria-labelledby="sidebar-unstaged-heading"
              >
                <div className="flex shrink-0 items-center justify-between gap-2 border-b border-base-300/80 px-3 py-2">
                  <h2
                    id="sidebar-unstaged-heading"
                    className="m-0 min-w-0 flex-1 text-xs font-semibold tracking-wide uppercase opacity-80"
                  >
                    Unstaged files ({unstagedFiles.length})
                  </h2>
                  {canShowBranches && unstagedPaths.length > 0 ? (
                    <button
                      type="button"
                      className="btn shrink-0 btn-outline btn-xs btn-success"
                      disabled={stageCommitBusy}
                      onClick={() => void onStagePaths(unstagedPaths)}
                    >
                      Stage all
                    </button>
                  ) : null}
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto p-2">
                  {!canShowBranches ? (
                    <p className="m-0 py-2 text-center text-xs text-base-content/50">
                      Open a repository to manage changes
                    </p>
                  ) : unstagedFiles.length === 0 ? (
                    <p className="m-0 py-2 text-center text-xs text-base-content/50">
                      {workingTreeFiles.length === 0 ? "No pending changes" : "No unstaged changes"}
                    </p>
                  ) : (
                    <ul className="m-0 flex list-none flex-col gap-1 p-0">
                      {unstagedFiles.map((f) => (
                        <StagePanelFileRow
                          key={f.path}
                          f={f}
                          variant="unstaged"
                          selected={selectedDiffPath === f.path && selectedDiffSide === "unstaged"}
                          busy={stageCommitBusy}
                          onSelect={() => void loadDiffForFile(f, "unstaged")}
                          onStage={() => void onStagePaths([f.path])}
                          onUnstage={() => void onUnstagePaths([f.path])}
                        />
                      ))}
                    </ul>
                  )}
                </div>
              </section>

              <section
                className="flex min-h-0 flex-[1_1_0%] flex-col border-b border-base-300"
                aria-labelledby="sidebar-staged-heading"
              >
                <div className="flex shrink-0 items-center justify-between gap-2 border-b border-base-300/80 px-3 py-2">
                  <h2
                    id="sidebar-staged-heading"
                    className="m-0 min-w-0 flex-1 text-xs font-semibold tracking-wide uppercase opacity-80"
                  >
                    Staged files ({stagedFiles.length})
                  </h2>
                  {canShowBranches && stagedPaths.length > 0 ? (
                    <button
                      type="button"
                      className="btn shrink-0 btn-outline btn-xs btn-error"
                      disabled={stageCommitBusy || commitPushBusy}
                      onClick={() => void onUnstagePaths(stagedPaths)}
                    >
                      Unstage all
                    </button>
                  ) : null}
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto p-2">
                  {!canShowBranches ? (
                    <p className="m-0 py-2 text-center text-xs text-base-content/50">
                      Open a repository to manage changes
                    </p>
                  ) : stagedFiles.length === 0 ? (
                    <p className="m-0 py-2 text-center text-xs text-base-content/50">
                      No staged changes
                    </p>
                  ) : (
                    <ul className="m-0 flex list-none flex-col gap-1 p-0">
                      {stagedFiles.map((f) => (
                        <StagePanelFileRow
                          key={f.path}
                          f={f}
                          variant="staged"
                          selected={selectedDiffPath === f.path && selectedDiffSide === "staged"}
                          busy={stageCommitBusy}
                          onSelect={() => void loadDiffForFile(f, "staged")}
                          onStage={() => void onStagePaths([f.path])}
                          onUnstage={() => void onUnstagePaths([f.path])}
                        />
                      ))}
                    </ul>
                  )}
                </div>
              </section>

              <section
                className="shrink-0 border-t border-base-300 bg-base-100 p-3"
                aria-labelledby="sidebar-commit-heading"
              >
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <h2
                    id="sidebar-commit-heading"
                    className="m-0 text-xs font-semibold tracking-wide uppercase opacity-80"
                  >
                    Commit
                  </h2>
                  <span className="ml-auto flex flex-wrap items-center gap-1.5">
                    <button
                      type="button"
                      className="btn gap-1 px-2 btn-ghost btn-xs"
                      disabled={!canPush}
                      title="Push the current branch to origin"
                      onClick={() => void onPushToOrigin()}
                    >
                      {pushBusy ? (
                        <span className="loading loading-xs loading-spinner" />
                      ) : (
                        <>
                          <span aria-hidden>↑</span>
                          <span className="hidden sm:inline">Push</span>
                        </>
                      )}
                    </button>
                  </span>
                </div>
                <label className="form-control w-full">
                  <span className="label-text mb-1 text-xs font-medium">Message</span>
                  <textarea
                    className="textarea-bordered textarea min-h-18 w-full resize-y font-sans text-sm textarea-sm"
                    placeholder="Describe your changes…"
                    value={commitMessage}
                    disabled={!canShowBranches || stageCommitBusy || commitPushBusy}
                    onChange={(e) => {
                      setCommitMessage(e.target.value);
                    }}
                    rows={3}
                  />
                </label>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    className="btn btn-outline btn-sm"
                    disabled={!canCommitAndPush}
                    title="Create the commit, then push the branch to origin"
                    onClick={() => void onCommitAndPush()}
                  >
                    {commitPushBusy ? (
                      <span className="loading loading-xs loading-spinner" />
                    ) : (
                      "Commit & Push"
                    )}
                  </button>
                  <button
                    type="button"
                    className="btn ml-auto btn-sm btn-primary"
                    disabled={!canCommit}
                    onClick={() => void onCommit()}
                  >
                    {stageCommitBusy ? (
                      <span className="loading loading-xs loading-spinner" />
                    ) : (
                      "Commit"
                    )}
                  </button>
                </div>
              </section>
            </div>
          </div>
        </aside>
      </div>
      {branchContextMenu || stashContextMenu ? (
        <>
          <div
            className="fixed inset-0 z-[100]"
            role="presentation"
            onClick={() => {
              setBranchContextMenu(null);
              setStashContextMenu(null);
            }}
          />
          {branchContextMenu ? (
            <ul
              role="menu"
              className="menu fixed z-[101] min-w-[13rem] rounded-box border border-base-300 bg-base-100 p-1 shadow-lg"
              style={{
                left: Math.min(Math.max(8, branchContextMenu.x), window.innerWidth - 228),
                top: Math.min(Math.max(8, branchContextMenu.y), window.innerHeight - 148),
              }}
            >
              <li role="none">
                <button
                  type="button"
                  role="menuitem"
                  className="rounded"
                  disabled={Boolean(branchBusy)}
                  onClick={() => {
                    const name = branchContextMenu.branchName;
                    setBranchContextMenu(null);
                    void deleteLocalBranch(name, false);
                  }}
                >
                  Delete branch…
                </button>
              </li>
              <li role="none">
                <button
                  type="button"
                  role="menuitem"
                  className="rounded text-error"
                  disabled={Boolean(branchBusy)}
                  onClick={() => {
                    const name = branchContextMenu.branchName;
                    setBranchContextMenu(null);
                    void deleteLocalBranch(name, true);
                  }}
                >
                  Force delete…
                </button>
              </li>
            </ul>
          ) : null}
          {stashContextMenu ? (
            <ul
              role="menu"
              className="menu fixed z-[101] min-w-[13rem] rounded-box border border-base-300 bg-base-100 p-1 shadow-lg"
              style={{
                left: Math.min(Math.max(8, stashContextMenu.x), window.innerWidth - 228),
                top: Math.min(Math.max(8, stashContextMenu.y), window.innerHeight - 120),
              }}
            >
              <li role="none">
                <button
                  type="button"
                  role="menuitem"
                  className="rounded text-error"
                  disabled={Boolean(branchBusy) || stashBusy !== null}
                  onClick={() => {
                    const ref = stashContextMenu.stashRef;
                    setStashContextMenu(null);
                    void onStashDrop(ref);
                  }}
                >
                  Delete stash…
                </button>
              </li>
            </ul>
          ) : null}
        </>
      ) : null}
    </main>
  );
}
