import { useVirtualizer } from "@tanstack/react-virtual";
import { memo, type ReactNode, type Ref, useEffect, useMemo, useRef, useState } from "react";
import type { BranchTrieNode, RemoteTrieNode } from "../branchTrie";
import type {
  BranchSidebarSectionsState,
  LocalBranchEntry,
  RemoteBranchEntry,
  StashEntry,
  TagEntry,
  WorktreeEntry,
} from "../repoTypes";

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

function IconChevronRight({ className }: { className?: string }) {
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
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}

function localBranchUpstreamLabel(ahead: number | null, behind: number | null): string | null {
  if (ahead === null || behind === null) return null;
  return `↑${ahead} ↓${behind}`;
}

const BRANCH_TREE_INDENT_PX = 20;
const BRANCH_ROW_ESTIMATE_PX = 36;
const TAG_ROW_ESTIMATE_PX = 40;

function togglePathInSet(current: ReadonlySet<string>, path: string): Set<string> {
  const next = new Set(current);
  if (next.has(path)) {
    next.delete(path);
  } else {
    next.add(path);
  }
  return next;
}

function BranchPanel({
  title,
  entityCount,
  open,
  onOpenChange,
  empty,
  emptyHint,
  belowHeader,
  children,
  isLastSection,
  contentScrollRef,
}: {
  title: string;
  entityCount: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  empty: boolean;
  emptyHint: string;
  belowHeader?: ReactNode;
  children: ReactNode;
  isLastSection: boolean;
  contentScrollRef?: Ref<HTMLDivElement>;
}) {
  return (
    <div
      className={`flex min-h-0 min-w-0 flex-col ${
        open ? "min-h-0 flex-1" : "shrink-0"
      } ${isLastSection ? "" : "border-b border-base-300"}`}
    >
      <div
        className={`collapse border-0 bg-transparent shadow-none ${open ? "min-h-0 flex-1" : ""}`}
      >
        <input
          type="checkbox"
          checked={open}
          onChange={(e) => {
            onOpenChange(e.target.checked);
          }}
          aria-label={`Show or hide ${title}`}
        />
        <div
          className={`collapse-title block! min-h-0 min-w-0 px-3! py-2! text-left! ${
            open ? "border-b border-base-300/80" : ""
          }`}
        >
          <div className="flex min-w-0 items-center justify-between gap-2">
            <h2 className="m-0 card-title min-w-0 text-xs font-semibold tracking-wide uppercase opacity-70">
              {title} <span className="tabular-nums opacity-90">({entityCount})</span>
            </h2>
            <IconChevronRight
              className={`h-4 w-4 shrink-0 opacity-60 transition-transform ${open ? "rotate-90" : ""}`}
            />
          </div>
        </div>
        <div className="collapse-content flex! min-h-0! flex-col gap-0 overflow-hidden! px-0! pb-0!">
          {belowHeader ? (
            <div className="shrink-0 border-b border-base-300">{belowHeader}</div>
          ) : null}
          <div ref={contentScrollRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            {empty ? (
              <p className="m-0 py-2 text-center text-xs text-base-content/50">{emptyHint}</p>
            ) : (
              children
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

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

export type BranchGraphControls = {
  graphVisibleLocal: (name: string) => boolean;
  toggleGraphLocal: (name: string) => void;
  graphFolderAnyVisibleLocal: (node: BranchTrieNode) => boolean;
  toggleGraphLocalFolder: (node: BranchTrieNode) => void;
  graphVisibleRemote: (name: string) => boolean;
  toggleGraphRemote: (name: string) => void;
  graphFolderAnyVisibleRemote: (node: RemoteTrieNode) => boolean;
  toggleGraphRemoteFolder: (node: RemoteTrieNode) => void;
};

type LocalBranchListRow =
  | {
      kind: "folder";
      key: string;
      path: string;
      depth: number;
      label: string;
      node: BranchTrieNode;
      expanded: boolean;
    }
  | {
      kind: "branch";
      key: string;
      depth: number;
      branch: LocalBranchEntry;
      label: string;
    };

type RemoteBranchListRow =
  | {
      kind: "folder";
      key: string;
      path: string;
      depth: number;
      label: string;
      node: RemoteTrieNode;
      expanded: boolean;
    }
  | {
      kind: "branch";
      key: string;
      depth: number;
      fullRef: string;
      label: string;
    };

function flattenLocalBranchRows(
  node: BranchTrieNode,
  collapsedPaths: ReadonlySet<string>,
  forceExpand: boolean,
  depth = 0,
  prefix = "",
): LocalBranchListRow[] {
  const rows: LocalBranchListRow[] = [];
  const sorted = [...node.children.entries()].sort((a, b) =>
    a[0].localeCompare(b[0], undefined, { sensitivity: "base" }),
  );
  for (const [segment, child] of sorted) {
    const path = prefix ? `${prefix}/${segment}` : segment;
    const branchHere = child.branchHere;
    const leafOnly = child.children.size === 0 && branchHere !== null;
    if (leafOnly) {
      rows.push({
        kind: "branch",
        key: `branch:${branchHere.name}`,
        depth,
        branch: branchHere,
        label: segment,
      });
      continue;
    }
    const expanded = forceExpand || !collapsedPaths.has(path);
    rows.push({
      kind: "folder",
      key: `folder:${path}`,
      path,
      depth,
      label: segment,
      node: child,
      expanded,
    });
    if (expanded && branchHere) {
      rows.push({
        kind: "branch",
        key: `branch:${branchHere.name}`,
        depth: depth + 1,
        branch: branchHere,
        label: segment,
      });
    }
    if (expanded) {
      rows.push(...flattenLocalBranchRows(child, collapsedPaths, forceExpand, depth + 1, path));
    }
  }
  return rows;
}

function flattenRemoteBranchRows(
  node: RemoteTrieNode,
  collapsedPaths: ReadonlySet<string>,
  forceExpand: boolean,
  depth = 0,
  prefix = "",
): RemoteBranchListRow[] {
  const rows: RemoteBranchListRow[] = [];
  const sorted = [...node.children.entries()].sort((a, b) =>
    a[0].localeCompare(b[0], undefined, { sensitivity: "base" }),
  );
  for (const [segment, child] of sorted) {
    const path = prefix ? `${prefix}/${segment}` : segment;
    const refHere = child.refHere;
    const leafOnly = child.children.size === 0 && refHere !== null;
    if (leafOnly) {
      rows.push({
        kind: "branch",
        key: `remote:${refHere}`,
        depth,
        fullRef: refHere,
        label: segment,
      });
      continue;
    }
    const expanded = forceExpand || !collapsedPaths.has(path);
    rows.push({
      kind: "folder",
      key: `folder:${path}`,
      path,
      depth,
      label: segment,
      node: child,
      expanded,
    });
    if (expanded && refHere) {
      rows.push({
        kind: "branch",
        key: `remote:${refHere}`,
        depth: depth + 1,
        fullRef: refHere,
        label: segment,
      });
    }
    if (expanded) {
      rows.push(...flattenRemoteBranchRows(child, collapsedPaths, forceExpand, depth + 1, path));
    }
  }
  return rows;
}

function LocalBranchFolderRow({
  label,
  node,
  depth,
  expanded,
  onToggle,
  graph,
}: {
  label: string;
  node: BranchTrieNode;
  depth: number;
  expanded: boolean;
  onToggle: () => void;
  graph: BranchGraphControls;
}) {
  const folderGraphVisible = graph.graphFolderAnyVisibleLocal(node);
  return (
    <div
      className="min-w-0"
      style={{
        paddingLeft: `${depth * BRANCH_TREE_INDENT_PX}px`,
      }}
    >
      <div className="flex w-full min-w-0 items-center gap-0">
        <button
          type="button"
          className="flex h-9 w-5 shrink-0 items-center justify-center opacity-40 transition-transform hover:opacity-65"
          aria-label={`${expanded ? "Collapse" : "Expand"} ${label} folder`}
          aria-expanded={expanded}
          onClick={onToggle}
        >
          <IconChevronRight
            className={`h-3.5 w-3.5 transition-transform ${expanded ? "rotate-90" : ""}`}
          />
        </button>
        <button
          type="button"
          className="btn inline-flex h-auto min-h-0 w-9 shrink-0 items-center justify-center rounded-none px-0 py-2 opacity-90 btn-ghost btn-xs"
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
            graph.toggleGraphLocalFolder(node);
          }}
        >
          {folderGraphVisible ? (
            <IconEye className="text-success opacity-95" />
          ) : (
            <IconEyeOff className="text-success/45" />
          )}
        </button>
        <button
          type="button"
          className="min-w-0 flex-1 py-2 pr-2 pl-1 text-left font-mono text-[0.8125rem] wrap-break-word transition-colors hover:bg-base-200/50"
          aria-label={`${expanded ? "Collapse" : "Expand"} ${label} folder`}
          aria-expanded={expanded}
          onClick={onToggle}
        >
          {label}
        </button>
      </div>
    </div>
  );
}

function LocalBranchRow({
  branch,
  label,
  currentBranchName,
  branchBusy,
  depth = 0,
  onSelectLocalTip,
  onCheckoutLocal,
  onLocalBranchContextMenu,
  graph,
}: {
  branch: LocalBranchEntry;
  label: string;
  currentBranchName: string | null;
  branchBusy: string | null;
  depth?: number;
  /** Single click: highlight branch tip in graph (does not check out). */
  onSelectLocalTip: (name: string) => void;
  /** Double click or context menu: check out. */
  onCheckoutLocal: (name: string) => void;
  onLocalBranchContextMenu: (branchName: string, clientX: number, clientY: number) => void;
  graph: BranchGraphControls;
}) {
  const isCurrent = currentBranchName === branch.name;
  const busy =
    branchBusy === `local:${branch.name}` ||
    branchBusy === `delete:${branch.name}` ||
    branchBusy === `pull:${branch.name}` ||
    branchBusy === "rebase";
  const upstreamLabel = localBranchUpstreamLabel(branch.ahead, branch.behind);
  const graphVisible = graph.graphVisibleLocal(branch.name);

  return (
    <div
      className={isCurrent ? "bg-base-200/50" : ""}
      style={{
        paddingLeft: `${depth * BRANCH_TREE_INDENT_PX}px`,
      }}
    >
      <div
        className="flex w-full min-w-0 items-center gap-0"
        onContextMenu={(e) => {
          if (busy) return;
          e.preventDefault();
          onLocalBranchContextMenu(branch.name, e.clientX, e.clientY);
        }}
      >
        <button
          type="button"
          className="btn inline-flex h-auto min-h-0 w-9 shrink-0 items-center justify-center rounded-none px-0 py-2 opacity-90 btn-ghost btn-xs"
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
            <IconEye className="text-success opacity-95" />
          ) : (
            <IconEyeOff className="text-success/45" />
          )}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            onSelectLocalTip(branch.name);
          }}
          onDoubleClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            if (busy || isCurrent) return;
            onCheckoutLocal(branch.name);
          }}
          className={`flex h-auto min-h-0 min-w-0 flex-1 flex-row items-center justify-between gap-2 py-2 pr-2 pl-1 text-left transition-colors hover:bg-base-200/50 ${busy ? "opacity-60" : ""}`}
        >
          <span
            className="min-w-0 flex-1 truncate text-[0.8125rem] leading-snug"
            title={busy ? undefined : branch.name}
          >
            {label}
            {isCurrent && !busy ? (
              <span className="ml-1.5 text-xs font-normal opacity-70">(current)</span>
            ) : null}
          </span>
          {busy ? (
            <span className="loading loading-xs shrink-0 loading-spinner text-base-content/60" />
          ) : upstreamLabel ? (
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
      </div>
    </div>
  );
}

function RemoteBranchFolderRow({
  path,
  label,
  node,
  depth,
  expanded,
  branchBusy,
  onToggle,
  onRemoteFolderContextMenu,
  graph,
}: {
  path: string;
  label: string;
  node: RemoteTrieNode;
  depth: number;
  expanded: boolean;
  branchBusy: string | null;
  onToggle: () => void;
  onRemoteFolderContextMenu: (remotePath: string, clientX: number, clientY: number) => void;
  graph: BranchGraphControls;
}) {
  const busy = branchBusy !== null;
  const folderGraphVisible = graph.graphFolderAnyVisibleRemote(node);
  return (
    <div
      className="min-w-0"
      style={{
        paddingLeft: `${depth * BRANCH_TREE_INDENT_PX}px`,
      }}
    >
      <div
        className="flex w-full min-w-0 items-center gap-0"
        onContextMenu={(e) => {
          if (busy) return;
          e.preventDefault();
          onRemoteFolderContextMenu(path, e.clientX, e.clientY);
        }}
      >
        <button
          type="button"
          className="flex h-9 w-5 shrink-0 items-center justify-center opacity-40 transition-transform hover:opacity-65"
          aria-label={`${expanded ? "Collapse" : "Expand"} ${label} folder`}
          aria-expanded={expanded}
          onClick={onToggle}
        >
          <IconChevronRight
            className={`h-3.5 w-3.5 transition-transform ${expanded ? "rotate-90" : ""}`}
          />
        </button>
        <button
          type="button"
          className="btn inline-flex h-auto min-h-0 w-9 shrink-0 items-center justify-center rounded-none px-0 py-2 opacity-90 btn-ghost btn-xs"
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
            graph.toggleGraphRemoteFolder(node);
          }}
        >
          {folderGraphVisible ? (
            <IconEye className="text-success opacity-95" />
          ) : (
            <IconEyeOff className="text-success/45" />
          )}
        </button>
        <button
          type="button"
          className="min-w-0 flex-1 py-2 pr-2 pl-1 text-left font-mono text-[0.8125rem] wrap-break-word transition-colors hover:bg-base-200/50"
          aria-label={`${expanded ? "Collapse" : "Expand"} ${label} folder`}
          aria-expanded={expanded}
          onClick={onToggle}
        >
          {label}
        </button>
      </div>
    </div>
  );
}

function RemoteBranchRow({
  fullRef,
  label,
  branchBusy,
  depth = 0,
  onSelectRemoteTip,
  onCreateFromRemote,
  onRemoteBranchContextMenu,
  graph,
}: {
  fullRef: string;
  label: string;
  branchBusy: string | null;
  depth?: number;
  onSelectRemoteTip: (remoteRef: string) => void;
  onCreateFromRemote: (remoteRef: string) => void;
  onRemoteBranchContextMenu: (remoteRef: string, clientX: number, clientY: number) => void;
  graph: BranchGraphControls;
}) {
  const busy =
    branchBusy === `remote:${fullRef}` ||
    branchBusy === `delete-remote:${fullRef}` ||
    branchBusy === "rebase";
  const graphVisible = graph.graphVisibleRemote(fullRef);

  return (
    <div
      style={{
        paddingLeft: `${depth * BRANCH_TREE_INDENT_PX}px`,
      }}
    >
      <div
        className="flex w-full min-w-0 items-center gap-0"
        onContextMenu={(e) => {
          if (busy) return;
          e.preventDefault();
          onRemoteBranchContextMenu(fullRef, e.clientX, e.clientY);
        }}
      >
        <button
          type="button"
          className="btn inline-flex h-auto min-h-0 w-9 shrink-0 items-center justify-center rounded-none px-0 py-2 opacity-90 btn-ghost btn-xs"
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
            <IconEye className="text-success opacity-95" />
          ) : (
            <IconEyeOff className="text-success/45" />
          )}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            onSelectRemoteTip(fullRef);
          }}
          onDoubleClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            if (busy) return;
            onCreateFromRemote(fullRef);
          }}
          className={`flex h-auto min-h-0 min-w-0 flex-1 justify-start rounded-md py-2 pr-2 pl-1 text-left font-mono text-[0.8125rem] whitespace-normal transition-colors hover:bg-base-200/50 ${busy ? "opacity-60" : ""}`}
          title={busy ? undefined : fullRef}
        >
          {busy ? "Creating…" : label}
        </button>
      </div>
    </div>
  );
}

function TagRow({
  tag,
  branchBusy,
  stashBusy,
  pushBusy,
  onTagClick,
  openTagSidebarMenu,
}: {
  tag: TagEntry;
  branchBusy: string | null;
  stashBusy: string | null;
  pushBusy: boolean;
  onTagClick: (tag: TagEntry) => void;
  openTagSidebarMenu: (tagName: string, clientX: number, clientY: number) => void | Promise<void>;
}) {
  const tagRowBusy = Boolean(branchBusy) || stashBusy !== null || pushBusy;
  const shortTip = tag.tipHash.length >= 7 ? tag.tipHash.slice(0, 7) : tag.tipHash;
  return (
    <div className="min-w-0">
      <div
        role="button"
        tabIndex={0}
        className="flex w-full min-w-0 cursor-pointer flex-col gap-0.5 px-3 py-2 text-left wrap-break-word hover:bg-base-200/50"
        title={`${tag.name} → ${tag.tipHash}`}
        onClick={() => {
          if (tagRowBusy) return;
          onTagClick(tag);
        }}
        onKeyDown={(e) => {
          if (tagRowBusy) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onTagClick(tag);
          }
        }}
        onContextMenu={(e) => {
          if (tagRowBusy) return;
          e.preventDefault();
          void openTagSidebarMenu(tag.name, e.clientX, e.clientY);
        }}
      >
        <div className="flex min-w-0 items-baseline justify-between gap-2">
          <span className="min-w-0 flex-1 font-mono text-[0.8125rem] leading-snug wrap-break-word">
            {tag.name}
          </span>
          <span className="shrink-0 font-mono text-[0.65rem] leading-none tracking-tight opacity-60">
            {shortTip}
          </span>
        </div>
      </div>
    </div>
  );
}

function worktreePrimaryLabel(worktree: WorktreeEntry): string {
  if (worktree.branch) return worktree.branch;
  if (worktree.detached) {
    return worktree.headShort ? `Detached (${worktree.headShort})` : "Detached HEAD";
  }
  const parts = worktree.path.split(/[\\/]/).filter((part) => part.length > 0);
  return parts.length > 0 ? parts[parts.length - 1] : worktree.path;
}

function WorktreeRow({
  worktree,
  onOpenWorktree,
  onPreviewWorktreeDiff,
  onWorktreeContextMenu,
}: {
  worktree: WorktreeEntry;
  onOpenWorktree: (path: string) => void;
  onPreviewWorktreeDiff: (worktree: WorktreeEntry) => void;
  onWorktreeContextMenu: (worktree: WorktreeEntry, clientX: number, clientY: number) => void;
}) {
  const summaryLabel =
    worktree.changedFileCount === 0
      ? "Clean"
      : worktree.changedFileCount === 1
        ? "1 changed"
        : `${worktree.changedFileCount} changed`;
  const detailBits = [
    worktree.stagedFileCount > 0 ? `${worktree.stagedFileCount} staged` : null,
    worktree.unstagedFileCount > 0 ? `${worktree.unstagedFileCount} unstaged` : null,
    worktree.untrackedFileCount > 0 ? `${worktree.untrackedFileCount} untracked` : null,
    worktree.lockedReason ? `Locked ${worktree.lockedReason}` : null,
    worktree.prunableReason ? `Prunable ${worktree.prunableReason}` : null,
  ].filter((value): value is string => value !== null);

  return (
    <li
      className={worktree.isCurrent ? "bg-base-200/50 ring-1 ring-base-300/60 ring-inset" : ""}
      onContextMenu={(e) => {
        e.preventDefault();
        onWorktreeContextMenu(worktree, e.clientX, e.clientY);
      }}
    >
      <div className="flex min-w-0 flex-col gap-2 px-2 py-2">
        <div className="flex min-w-0 items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              <span className="max-w-full min-w-0 font-mono text-[0.8125rem] leading-snug wrap-break-word">
                {worktreePrimaryLabel(worktree)}
              </span>
              {worktree.isCurrent ? (
                <span className="badge h-auto badge-outline px-1.5 py-0.5 text-[0.6rem] badge-primary">
                  current
                </span>
              ) : null}
              {worktree.headShort ? (
                <span className="badge h-auto badge-ghost px-1.5 py-0.5 font-mono text-[0.6rem]">
                  {worktree.headShort}
                </span>
              ) : null}
            </div>
            <div
              className="mt-1 font-mono text-[0.65rem] leading-snug break-all text-base-content/60"
              title={worktree.path}
            >
              {worktree.path}
            </div>
          </div>
          <span
            className={`badge h-auto px-1.5 py-0.5 text-[0.6rem] ${
              worktree.changedFileCount === 0 ? "badge-ghost" : "badge-outline badge-warning"
            }`}
          >
            {summaryLabel}
          </span>
        </div>
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
          <span className="min-w-0 flex-1 text-[0.65rem] leading-snug wrap-break-word text-base-content/55">
            {detailBits.length > 0 ? detailBits.join(" | ") : "No local changes"}
          </span>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              className="btn btn-ghost btn-xs"
              disabled={worktree.isCurrent}
              onClick={() => {
                onOpenWorktree(worktree.path);
              }}
            >
              Open
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-xs"
              disabled={worktree.changedFileCount === 0}
              onClick={() => {
                onPreviewWorktreeDiff(worktree);
              }}
            >
              Diff
            </button>
          </div>
        </div>
      </div>
    </li>
  );
}

export type BranchSidebarProps = {
  repoPath: string | null;
  canShowBranches: boolean;
  localBranches: LocalBranchEntry[];
  remoteBranches: RemoteBranchEntry[];
  worktrees: WorktreeEntry[];
  tags: TagEntry[];
  stashes: StashEntry[];
  branchBusy: string | null;
  stashBusy: string | null;
  pushBusy: boolean;
  branchGraphControls: BranchGraphControls;
  currentBranchName: string | null;
  onSelectLocalBranchTip: (name: string) => void;
  onCheckoutLocal: (name: string) => void;
  onSelectRemoteBranchTip: (fullRef: string) => void;
  onCreateFromRemote: (remoteRef: string) => void;
  onRemoteFolderContextMenu: (remotePath: string, clientX: number, clientY: number) => void;
  onOpenWorktree: (path: string) => void;
  onPreviewWorktreeDiff: (worktree: WorktreeEntry) => void;
  onWorktreeContextMenu: (worktree: WorktreeEntry, clientX: number, clientY: number) => void;
  onStashClick: (stash: StashEntry) => void;
  onTagClick: (tag: TagEntry) => void;
  runBranchSidebarContextMenu: (
    target: { kind: "local"; branchName: string } | { kind: "remote"; fullRef: string },
    clientX: number,
    clientY: number,
  ) => void;
  openGraphStashMenu: (stashRef: string, clientX: number, clientY: number) => void;
  openTagSidebarMenu: (tagName: string, clientX: number, clientY: number) => void | Promise<void>;
  branchSidebarSections: BranchSidebarSectionsState;
  onBranchSidebarSectionsChange: (next: BranchSidebarSectionsState) => void;
};

export const BranchSidebar = memo(function BranchSidebar({
  repoPath,
  canShowBranches,
  localBranches,
  remoteBranches,
  worktrees,
  tags,
  stashes,
  branchBusy,
  stashBusy,
  pushBusy,
  branchGraphControls,
  currentBranchName,
  onSelectLocalBranchTip,
  onCheckoutLocal,
  onSelectRemoteBranchTip,
  onCreateFromRemote,
  onRemoteFolderContextMenu,
  onOpenWorktree,
  onPreviewWorktreeDiff,
  onWorktreeContextMenu,
  onStashClick,
  onTagClick,
  runBranchSidebarContextMenu,
  openGraphStashMenu,
  openTagSidebarMenu,
  branchSidebarSections,
  onBranchSidebarSectionsChange,
}: BranchSidebarProps) {
  const [localBranchListFilter, setLocalBranchListFilter] = useState("");
  const [remoteBranchListFilter, setRemoteBranchListFilter] = useState("");
  const [collapsedLocalBranchFolders, setCollapsedLocalBranchFolders] = useState<Set<string>>(
    () => new Set(),
  );
  const [collapsedRemoteBranchFolders, setCollapsedRemoteBranchFolders] = useState<Set<string>>(
    () => new Set(),
  );
  const [worktreeListFilter, setWorktreeListFilter] = useState("");
  const [tagListFilter, setTagListFilter] = useState("");
  const [stashListFilter, setStashListFilter] = useState("");

  useEffect(() => {
    setLocalBranchListFilter("");
    setRemoteBranchListFilter("");
    setCollapsedLocalBranchFolders(new Set());
    setCollapsedRemoteBranchFolders(new Set());
    setWorktreeListFilter("");
    setTagListFilter("");
    setStashListFilter("");
  }, [repoPath]);

  const localBranchFilterNorm = localBranchListFilter.trim().toLowerCase();
  const remoteBranchFilterNorm = remoteBranchListFilter.trim().toLowerCase();
  const worktreeFilterNorm = worktreeListFilter.trim().toLowerCase();
  const tagFilterNorm = tagListFilter.trim().toLowerCase();
  const stashFilterNorm = stashListFilter.trim().toLowerCase();
  const showLocalBranchRows = canShowBranches && branchSidebarSections.localOpen;
  const showRemoteBranchRows = canShowBranches && branchSidebarSections.remoteOpen;
  const showWorktreeRows = canShowBranches && branchSidebarSections.worktreesOpen;
  const showTagRows = canShowBranches && branchSidebarSections.tagsOpen;
  const showStashRows = canShowBranches && branchSidebarSections.stashOpen;
  const forceExpandLocalFolders = localBranchFilterNorm.length > 0;
  const forceExpandRemoteFolders = remoteBranchFilterNorm.length > 0;
  const localBranchScrollRef = useRef<HTMLDivElement | null>(null);
  const remoteBranchScrollRef = useRef<HTMLDivElement | null>(null);
  const tagScrollRef = useRef<HTMLDivElement | null>(null);

  const filteredLocalBranches = useMemo(() => {
    if (!showLocalBranchRows) return [];
    if (!localBranchFilterNorm) return localBranches;
    return localBranches.filter((b) => b.name.toLowerCase().includes(localBranchFilterNorm));
  }, [localBranches, localBranchFilterNorm, showLocalBranchRows]);

  const filteredRemoteBranches = useMemo(() => {
    if (!showRemoteBranchRows) return [];
    if (!remoteBranchFilterNorm) return remoteBranches;
    return remoteBranches.filter((r) => r.name.toLowerCase().includes(remoteBranchFilterNorm));
  }, [remoteBranches, remoteBranchFilterNorm, showRemoteBranchRows]);

  const filteredWorktrees = useMemo(() => {
    if (!showWorktreeRows) return [];
    const sorted = [...worktrees].sort((a, b) => {
      const aLabel = `${a.branch ?? ""}\0${a.path}`.toLowerCase();
      const bLabel = `${b.branch ?? ""}\0${b.path}`.toLowerCase();
      return Number(b.isCurrent) - Number(a.isCurrent) || aLabel.localeCompare(bLabel);
    });
    if (!worktreeFilterNorm) return sorted;
    return sorted.filter((worktree) => {
      const haystack =
        `${worktree.branch ?? ""}\n${worktree.path}\n${worktree.headShort ?? ""}`.toLowerCase();
      return haystack.includes(worktreeFilterNorm);
    });
  }, [worktrees, worktreeFilterNorm, showWorktreeRows]);

  const filteredTags = useMemo(() => {
    if (!showTagRows) return [];
    if (!tagFilterNorm) return tags;
    return tags.filter((t) => t.name.toLowerCase().includes(tagFilterNorm));
  }, [tags, tagFilterNorm, showTagRows]);

  const filteredStashes = useMemo(() => {
    if (!showStashRows) return [];
    if (!stashFilterNorm) return stashes;
    return stashes.filter(
      (s) =>
        s.refName.toLowerCase().includes(stashFilterNorm) ||
        s.message.toLowerCase().includes(stashFilterNorm),
    );
  }, [stashes, stashFilterNorm, showStashRows]);

  const localBranchTrieRoot = useMemo(
    () =>
      showLocalBranchRows ? buildLocalBranchTrie(filteredLocalBranches) : emptyBranchTrieNode(),
    [filteredLocalBranches, showLocalBranchRows],
  );
  const remoteBranchTrieRoot = useMemo(
    () =>
      showRemoteBranchRows ? buildRemoteBranchTrie(filteredRemoteBranches) : emptyRemoteTrieNode(),
    [filteredRemoteBranches, showRemoteBranchRows],
  );
  const localBranchRows = useMemo(
    () =>
      showLocalBranchRows
        ? flattenLocalBranchRows(
            localBranchTrieRoot,
            collapsedLocalBranchFolders,
            forceExpandLocalFolders,
          )
        : [],
    [
      collapsedLocalBranchFolders,
      forceExpandLocalFolders,
      localBranchTrieRoot,
      showLocalBranchRows,
    ],
  );
  const remoteBranchRows = useMemo(
    () =>
      showRemoteBranchRows
        ? flattenRemoteBranchRows(
            remoteBranchTrieRoot,
            collapsedRemoteBranchFolders,
            forceExpandRemoteFolders,
          )
        : [],
    [
      collapsedRemoteBranchFolders,
      forceExpandRemoteFolders,
      remoteBranchTrieRoot,
      showRemoteBranchRows,
    ],
  );

  const localBranchVirtualizer = useVirtualizer({
    count: localBranchRows.length,
    getScrollElement: () => localBranchScrollRef.current,
    estimateSize: () => BRANCH_ROW_ESTIMATE_PX,
    overscan: 14,
    getItemKey: (index) => localBranchRows[index]?.key ?? index,
  });
  const remoteBranchVirtualizer = useVirtualizer({
    count: remoteBranchRows.length,
    getScrollElement: () => remoteBranchScrollRef.current,
    estimateSize: () => BRANCH_ROW_ESTIMATE_PX,
    overscan: 14,
    getItemKey: (index) => remoteBranchRows[index]?.key ?? index,
  });
  const tagVirtualizer = useVirtualizer({
    count: filteredTags.length,
    getScrollElement: () => tagScrollRef.current,
    estimateSize: () => TAG_ROW_ESTIMATE_PX,
    overscan: 14,
    getItemKey: (index) => filteredTags[index]?.name ?? index,
  });

  useEffect(() => {
    localBranchScrollRef.current?.scrollTo({ top: 0 });
  }, [repoPath, localBranchFilterNorm, showLocalBranchRows]);

  useEffect(() => {
    remoteBranchScrollRef.current?.scrollTo({ top: 0 });
  }, [repoPath, remoteBranchFilterNorm, showRemoteBranchRows]);

  useEffect(() => {
    tagScrollRef.current?.scrollTo({ top: 0 });
  }, [repoPath, tagFilterNorm, showTagRows]);

  const localBranchesEmptyHint =
    localBranches.length === 0 ? "No local branches" : "No branches match filter";
  const remoteBranchesEmptyHint =
    remoteBranches.length === 0 ? "No remote-tracking branches" : "No branches match filter";
  const worktreesEmptyHint = worktrees.length === 0 ? "No worktrees" : "No worktrees match filter";
  const tagsEmptyHint = tags.length === 0 ? "No tags" : "No tags match filter";
  const stashesEmptyHint = stashes.length === 0 ? "No stashes" : "No stashes match filter";

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col border-base-300 bg-base-100 lg:min-h-0">
      <div className="card-body min-h-0 gap-0 p-0">
        <BranchPanel
          title="Local branches"
          entityCount={localBranches.length}
          open={branchSidebarSections.localOpen}
          onOpenChange={(next) => {
            onBranchSidebarSectionsChange({ ...branchSidebarSections, localOpen: next });
          }}
          empty={showLocalBranchRows && filteredLocalBranches.length === 0}
          emptyHint={localBranchesEmptyHint}
          isLastSection={false}
          contentScrollRef={localBranchScrollRef}
          belowHeader={
            showLocalBranchRows ? (
              <input
                type="search"
                className="input input-sm w-full rounded-none border-0 bg-transparent font-mono text-sm shadow-none ring-0 transition-colors outline-none focus-visible:bg-base-200/40"
                value={localBranchListFilter}
                onChange={(e) => {
                  setLocalBranchListFilter(e.target.value);
                }}
                placeholder="Filter local branches…"
                autoComplete="off"
                spellCheck={false}
                aria-label="Filter local branches by name"
              />
            ) : null
          }
        >
          {showLocalBranchRows ? (
            <div
              className="relative w-full"
              style={{ height: localBranchVirtualizer.getTotalSize() }}
            >
              {localBranchVirtualizer.getVirtualItems().map((virtualRow) => {
                const row = localBranchRows[virtualRow.index];
                if (!row) return null;
                return (
                  <div
                    key={virtualRow.key}
                    data-index={virtualRow.index}
                    ref={localBranchVirtualizer.measureElement}
                    className="absolute top-0 left-0 w-full"
                    style={{ transform: `translateY(${virtualRow.start}px)` }}
                  >
                    {row.kind === "folder" ? (
                      <LocalBranchFolderRow
                        label={row.label}
                        node={row.node}
                        depth={row.depth}
                        expanded={row.expanded}
                        onToggle={() => {
                          setCollapsedLocalBranchFolders((current) =>
                            togglePathInSet(current, row.path),
                          );
                        }}
                        graph={branchGraphControls}
                      />
                    ) : (
                      <LocalBranchRow
                        branch={row.branch}
                        label={row.label}
                        depth={row.depth}
                        currentBranchName={currentBranchName}
                        branchBusy={branchBusy}
                        onSelectLocalTip={onSelectLocalBranchTip}
                        onCheckoutLocal={onCheckoutLocal}
                        onLocalBranchContextMenu={(name, clientX, clientY) => {
                          runBranchSidebarContextMenu(
                            { kind: "local", branchName: name },
                            clientX,
                            clientY,
                          );
                        }}
                        graph={branchGraphControls}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          ) : null}
        </BranchPanel>

        <BranchPanel
          title="Remote branches"
          entityCount={remoteBranches.length}
          open={branchSidebarSections.remoteOpen}
          onOpenChange={(next) => {
            onBranchSidebarSectionsChange({ ...branchSidebarSections, remoteOpen: next });
          }}
          empty={showRemoteBranchRows && filteredRemoteBranches.length === 0}
          emptyHint={remoteBranchesEmptyHint}
          isLastSection={false}
          contentScrollRef={remoteBranchScrollRef}
          belowHeader={
            showRemoteBranchRows ? (
              <input
                type="search"
                className="input input-sm w-full rounded-none border-0 bg-transparent font-mono text-sm shadow-none ring-0 transition-colors outline-none focus-visible:bg-base-200/40"
                value={remoteBranchListFilter}
                onChange={(e) => {
                  setRemoteBranchListFilter(e.target.value);
                }}
                placeholder="Filter remote branches…"
                autoComplete="off"
                spellCheck={false}
                aria-label="Filter remote-tracking branches by name"
              />
            ) : null
          }
        >
          {showRemoteBranchRows ? (
            <div
              className="relative w-full"
              style={{ height: remoteBranchVirtualizer.getTotalSize() }}
            >
              {remoteBranchVirtualizer.getVirtualItems().map((virtualRow) => {
                const row = remoteBranchRows[virtualRow.index];
                if (!row) return null;
                return (
                  <div
                    key={virtualRow.key}
                    data-index={virtualRow.index}
                    ref={remoteBranchVirtualizer.measureElement}
                    className="absolute top-0 left-0 w-full"
                    style={{ transform: `translateY(${virtualRow.start}px)` }}
                  >
                    {row.kind === "folder" ? (
                      <RemoteBranchFolderRow
                        path={row.path}
                        label={row.label}
                        node={row.node}
                        depth={row.depth}
                        expanded={row.expanded}
                        branchBusy={branchBusy}
                        onToggle={() => {
                          setCollapsedRemoteBranchFolders((current) =>
                            togglePathInSet(current, row.path),
                          );
                        }}
                        onRemoteFolderContextMenu={onRemoteFolderContextMenu}
                        graph={branchGraphControls}
                      />
                    ) : (
                      <RemoteBranchRow
                        fullRef={row.fullRef}
                        label={row.label}
                        depth={row.depth}
                        branchBusy={branchBusy}
                        onSelectRemoteTip={onSelectRemoteBranchTip}
                        onCreateFromRemote={onCreateFromRemote}
                        onRemoteBranchContextMenu={(fullRef, clientX, clientY) => {
                          runBranchSidebarContextMenu(
                            { kind: "remote", fullRef },
                            clientX,
                            clientY,
                          );
                        }}
                        graph={branchGraphControls}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          ) : null}
        </BranchPanel>

        {worktrees.length > 1 ? (
          <BranchPanel
            title="Worktrees"
            entityCount={worktrees.length}
            open={branchSidebarSections.worktreesOpen}
            onOpenChange={(next) => {
              onBranchSidebarSectionsChange({ ...branchSidebarSections, worktreesOpen: next });
            }}
            empty={showWorktreeRows && filteredWorktrees.length === 0}
            emptyHint={worktreesEmptyHint}
            isLastSection={false}
            belowHeader={
              showWorktreeRows ? (
                <input
                  type="search"
                  className="input input-sm w-full rounded-none border-0 bg-transparent font-mono text-sm shadow-none ring-0 transition-colors outline-none focus-visible:bg-base-200/40"
                  value={worktreeListFilter}
                  onChange={(e) => {
                    setWorktreeListFilter(e.target.value);
                  }}
                  placeholder="Filter worktrees…"
                  autoComplete="off"
                  spellCheck={false}
                  aria-label="Filter worktrees by branch or path"
                />
              ) : null
            }
          >
            {showWorktreeRows ? (
              <ul className="m-0 w-full min-w-0 list-none rounded-md bg-transparent p-0">
                {filteredWorktrees.map((worktree) => (
                  <WorktreeRow
                    key={worktree.path}
                    worktree={worktree}
                    onOpenWorktree={onOpenWorktree}
                    onPreviewWorktreeDiff={onPreviewWorktreeDiff}
                    onWorktreeContextMenu={onWorktreeContextMenu}
                  />
                ))}
              </ul>
            ) : null}
          </BranchPanel>
        ) : null}

        <BranchPanel
          title="Tags"
          entityCount={tags.length}
          open={branchSidebarSections.tagsOpen}
          onOpenChange={(next) => {
            onBranchSidebarSectionsChange({ ...branchSidebarSections, tagsOpen: next });
          }}
          empty={showTagRows && filteredTags.length === 0}
          emptyHint={tagsEmptyHint}
          isLastSection={false}
          contentScrollRef={tagScrollRef}
          belowHeader={
            showTagRows ? (
              <input
                type="search"
                className="input input-sm w-full rounded-none border-0 bg-transparent font-mono text-sm shadow-none ring-0 transition-colors outline-none focus-visible:bg-base-200/40"
                value={tagListFilter}
                onChange={(e) => {
                  setTagListFilter(e.target.value);
                }}
                placeholder="Filter tags…"
                autoComplete="off"
                spellCheck={false}
                aria-label="Filter tags by name"
              />
            ) : null
          }
        >
          {showTagRows ? (
            <div className="relative w-full" style={{ height: tagVirtualizer.getTotalSize() }}>
              {tagVirtualizer.getVirtualItems().map((virtualRow) => {
                const tag = filteredTags[virtualRow.index];
                if (!tag) return null;
                return (
                  <div
                    key={virtualRow.key}
                    data-index={virtualRow.index}
                    ref={tagVirtualizer.measureElement}
                    className="absolute top-0 left-0 w-full"
                    style={{ transform: `translateY(${virtualRow.start}px)` }}
                  >
                    <TagRow
                      tag={tag}
                      branchBusy={branchBusy}
                      stashBusy={stashBusy}
                      pushBusy={pushBusy}
                      onTagClick={onTagClick}
                      openTagSidebarMenu={openTagSidebarMenu}
                    />
                  </div>
                );
              })}
            </div>
          ) : null}
        </BranchPanel>

        <BranchPanel
          title="Stashes"
          entityCount={stashes.length}
          open={branchSidebarSections.stashOpen}
          onOpenChange={(next) => {
            onBranchSidebarSectionsChange({ ...branchSidebarSections, stashOpen: next });
          }}
          empty={showStashRows && filteredStashes.length === 0}
          emptyHint={stashesEmptyHint}
          isLastSection
          belowHeader={
            showStashRows ? (
              <input
                type="search"
                className="input input-sm w-full rounded-none border-0 bg-transparent font-mono text-sm shadow-none ring-0 transition-colors outline-none focus-visible:bg-base-200/40"
                value={stashListFilter}
                onChange={(e) => {
                  setStashListFilter(e.target.value);
                }}
                placeholder="Filter by ref or message…"
                autoComplete="off"
                spellCheck={false}
                aria-label="Filter stashes by ref name or message"
              />
            ) : null
          }
        >
          {showStashRows ? (
            <ul className="m-0 w-full min-w-0 list-none rounded-md bg-transparent p-0">
              {filteredStashes.map((s) => {
                const stashRowBusy = Boolean(branchBusy) || stashBusy !== null;
                return (
                  <li key={s.refName} className="min-w-0">
                    <div
                      role="button"
                      tabIndex={0}
                      className="flex w-full min-w-0 cursor-pointer flex-col gap-0.5 px-3 py-2 text-left wrap-break-word hover:bg-base-200/50"
                      title={`${s.refName}: ${s.message}`}
                      onClick={() => {
                        if (stashRowBusy) return;
                        onStashClick(s);
                      }}
                      onKeyDown={(e) => {
                        if (stashRowBusy) return;
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          onStashClick(s);
                        }
                      }}
                      onContextMenu={(e) => {
                        if (stashRowBusy) return;
                        e.preventDefault();
                        openGraphStashMenu(s.refName, e.clientX, e.clientY);
                      }}
                    >
                      <span className="font-mono text-[0.65rem] leading-snug break-all opacity-70">
                        {s.refName}
                      </span>
                      <span className="text-[0.8125rem] leading-snug wrap-break-word">
                        {s.message}
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </BranchPanel>
      </div>
    </div>
  );
});
