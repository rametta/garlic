import { type ReactNode, useEffect, useMemo, useState } from "react";
import type { BranchTrieNode, RemoteTrieNode } from "../branchTrie";
import { nativeContextMenusAvailable } from "../nativeContextMenu";
import type {
  BranchSidebarSectionsState,
  LocalBranchEntry,
  RemoteBranchEntry,
  StashEntry,
  TagEntry,
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

function localBranchUpstreamLabel(ahead: number | null, behind: number | null): string | null {
  if (ahead === null || behind === null) return null;
  return `↑${ahead} ↓${behind}`;
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
}) {
  return (
    <div
      className={`flex min-h-0 min-w-0 flex-col ${
        open ? "min-h-0 flex-1" : "shrink-0"
      } ${isLastSection ? "" : "border-b border-base-300"}`}
    >
      <div
        className={`collapse-arrow collapse border-0 bg-transparent shadow-none ${
          open ? "min-h-0 flex-1" : ""
        }`}
      >
        <input
          type="checkbox"
          checked={open}
          onChange={(e) => {
            onOpenChange(e.target.checked);
          }}
          aria-label={`Show or hide ${title}`}
        />
        <div className="collapse-title !block min-h-0 min-w-0 border-b border-base-300/80 !px-3 !py-2 !pr-9 !text-left">
          <h2 className="m-0 card-title text-xs font-semibold tracking-wide uppercase opacity-70">
            {title} <span className="tabular-nums opacity-90">({entityCount})</span>
          </h2>
        </div>
        <div className="collapse-content !flex !min-h-0 flex-col gap-0 !overflow-hidden !px-0 !pb-0">
          {belowHeader ? (
            <div className="shrink-0 border-b border-base-300">{belowHeader}</div>
          ) : null}
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2">
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
  const busy =
    branchBusy === `local:${branch.name}` ||
    branchBusy === `delete:${branch.name}` ||
    branchBusy === `pull:${branch.name}` ||
    branchBusy === "rebase";
  const upstreamLabel = localBranchUpstreamLabel(branch.ahead, branch.behind);
  const graphVisible = graph.graphVisibleLocal(branch.name);

  return (
    <li className={isCurrent ? "menu-active" : ""}>
      <div
        className="flex w-full min-w-0 items-center gap-0"
        onContextMenu={(e) => {
          if (busy) return;
          if (!nativeContextMenusAvailable()) return;
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
          disabled={busy || isCurrent}
          onClick={() => {
            onCheckoutLocal(branch.name);
          }}
          className={`flex h-auto min-h-0 min-w-0 flex-1 flex-row items-center justify-between gap-2 py-2 pr-2 pl-1 text-left ${busy ? "opacity-60" : ""}`}
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
          <summary className="grid min-w-0 cursor-pointer grid-cols-[2.25rem_minmax(0,1fr)_auto] items-center gap-0 font-mono text-[0.8125rem]">
            <button
              type="button"
              className="btn inline-flex h-auto min-h-0 w-9 shrink-0 items-center justify-center self-center rounded-none px-0 py-2 opacity-90 btn-ghost btn-xs"
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
                <IconEye className="text-success opacity-95" />
              ) : (
                <IconEyeOff className="text-success/45" />
              )}
            </button>
            <span className="min-w-0 py-2 pr-2 pl-1 wrap-break-word">{segment}</span>
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
  onRemoteBranchContextMenu,
  graph,
}: {
  fullRef: string;
  branchBusy: string | null;
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
    <li>
      <div
        className="flex w-full min-w-0 items-center gap-0"
        onContextMenu={(e) => {
          if (busy) return;
          if (!nativeContextMenusAvailable()) return;
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
            onCreateFromRemote(fullRef);
          }}
          className={`flex h-auto min-h-0 min-w-0 flex-1 justify-start py-2 pr-2 pl-1 text-left font-mono text-[0.8125rem] whitespace-normal ${busy ? "opacity-60" : ""}`}
        >
          {busy ? "Creating…" : fullRef}
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
  onRemoteBranchContextMenu: (remoteRef: string, clientX: number, clientY: number) => void,
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
          onRemoteBranchContextMenu={onRemoteBranchContextMenu}
          graph={graph}
        />
      );
    }
    const folderGraphVisible = graph.graphFolderAnyVisibleRemote(child);
    return (
      <li key={segment}>
        <details open>
          <summary className="grid min-w-0 cursor-pointer grid-cols-[2.25rem_minmax(0,1fr)_auto] items-center gap-0 font-mono text-[0.8125rem]">
            <button
              type="button"
              className="btn inline-flex h-auto min-h-0 w-9 shrink-0 items-center justify-center self-center rounded-none px-0 py-2 opacity-90 btn-ghost btn-xs"
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
                <IconEye className="text-success opacity-95" />
              ) : (
                <IconEyeOff className="text-success/45" />
              )}
            </button>
            <span className="min-w-0 py-2 pr-2 pl-1 wrap-break-word">{segment}</span>
          </summary>
          <ul>
            {child.refHere ? (
              <RemoteBranchRow
                fullRef={child.refHere}
                branchBusy={branchBusy}
                onCreateFromRemote={onCreateFromRemote}
                onRemoteBranchContextMenu={onRemoteBranchContextMenu}
                graph={graph}
              />
            ) : null}
            {renderRemoteBranchTrieChildren(
              child,
              branchBusy,
              onCreateFromRemote,
              graph,
              onRemoteBranchContextMenu,
            )}
          </ul>
        </details>
      </li>
    );
  });
}

export type BranchSidebarProps = {
  repoPath: string | null;
  canShowBranches: boolean;
  localBranches: LocalBranchEntry[];
  remoteBranches: RemoteBranchEntry[];
  tags: TagEntry[];
  stashes: StashEntry[];
  branchBusy: string | null;
  stashBusy: string | null;
  pushBusy: boolean;
  branchGraphControls: BranchGraphControls;
  currentBranchName: string | null;
  onCheckoutLocal: (name: string) => void;
  onCreateFromRemote: (remoteRef: string) => void;
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

export function BranchSidebar({
  repoPath,
  canShowBranches,
  localBranches,
  remoteBranches,
  tags,
  stashes,
  branchBusy,
  stashBusy,
  pushBusy,
  branchGraphControls,
  currentBranchName,
  onCheckoutLocal,
  onCreateFromRemote,
  runBranchSidebarContextMenu,
  openGraphStashMenu,
  openTagSidebarMenu,
  branchSidebarSections,
  onBranchSidebarSectionsChange,
}: BranchSidebarProps) {
  const [localBranchListFilter, setLocalBranchListFilter] = useState("");
  const [remoteBranchListFilter, setRemoteBranchListFilter] = useState("");
  const [tagListFilter, setTagListFilter] = useState("");
  const [stashListFilter, setStashListFilter] = useState("");

  useEffect(() => {
    setLocalBranchListFilter("");
    setRemoteBranchListFilter("");
    setTagListFilter("");
    setStashListFilter("");
  }, [repoPath]);

  const localBranchFilterNorm = localBranchListFilter.trim().toLowerCase();
  const remoteBranchFilterNorm = remoteBranchListFilter.trim().toLowerCase();
  const tagFilterNorm = tagListFilter.trim().toLowerCase();
  const stashFilterNorm = stashListFilter.trim().toLowerCase();

  const filteredLocalBranches = useMemo(() => {
    if (!localBranchFilterNorm) return localBranches;
    return localBranches.filter((b) => b.name.toLowerCase().includes(localBranchFilterNorm));
  }, [localBranches, localBranchFilterNorm]);

  const filteredRemoteBranches = useMemo(() => {
    if (!remoteBranchFilterNorm) return remoteBranches;
    return remoteBranches.filter((r) => r.name.toLowerCase().includes(remoteBranchFilterNorm));
  }, [remoteBranches, remoteBranchFilterNorm]);

  const filteredTags = useMemo(() => {
    if (!tagFilterNorm) return tags;
    return tags.filter((t) => t.name.toLowerCase().includes(tagFilterNorm));
  }, [tags, tagFilterNorm]);

  const filteredStashes = useMemo(() => {
    if (!stashFilterNorm) return stashes;
    return stashes.filter(
      (s) =>
        s.refName.toLowerCase().includes(stashFilterNorm) ||
        s.message.toLowerCase().includes(stashFilterNorm),
    );
  }, [stashes, stashFilterNorm]);

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
  const tagsEmptyHint = tags.length === 0 ? "No tags" : "No tags match filter";
  const stashesEmptyHint = stashes.length === 0 ? "No stashes" : "No stashes match filter";

  return (
    <div className="card flex min-h-0 min-w-0 flex-1 flex-col border-base-300 bg-base-100 shadow-sm lg:min-h-0">
      <div className="card-body flex min-h-0 flex-1 flex-col gap-0 p-0">
        <BranchPanel
          title="Local branches"
          entityCount={localBranches.length}
          open={branchSidebarSections.localOpen}
          onOpenChange={(next) => {
            onBranchSidebarSectionsChange({ ...branchSidebarSections, localOpen: next });
          }}
          empty={canShowBranches && filteredLocalBranches.length === 0}
          emptyHint={localBranchesEmptyHint}
          isLastSection={false}
          belowHeader={
            canShowBranches ? (
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
          {canShowBranches ? (
            <ul className="menu w-full menu-sm rounded-md bg-transparent p-0">
              {renderLocalBranchTrieChildren(
                localBranchTrieRoot,
                currentBranchName,
                branchBusy,
                onCheckoutLocal,
                (name, clientX, clientY) => {
                  runBranchSidebarContextMenu(
                    { kind: "local", branchName: name },
                    clientX,
                    clientY,
                  );
                },
                branchGraphControls,
              )}
            </ul>
          ) : null}
        </BranchPanel>

        <BranchPanel
          title="Remote branches"
          entityCount={remoteBranches.length}
          open={branchSidebarSections.remoteOpen}
          onOpenChange={(next) => {
            onBranchSidebarSectionsChange({ ...branchSidebarSections, remoteOpen: next });
          }}
          empty={canShowBranches && filteredRemoteBranches.length === 0}
          emptyHint={remoteBranchesEmptyHint}
          isLastSection={false}
          belowHeader={
            canShowBranches ? (
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
          {canShowBranches ? (
            <ul className="menu w-full menu-sm rounded-md bg-transparent p-0">
              {renderRemoteBranchTrieChildren(
                remoteBranchTrieRoot,
                branchBusy,
                onCreateFromRemote,
                branchGraphControls,
                (fullRef, clientX, clientY) => {
                  runBranchSidebarContextMenu({ kind: "remote", fullRef }, clientX, clientY);
                },
              )}
            </ul>
          ) : null}
        </BranchPanel>

        <BranchPanel
          title="Tags"
          entityCount={tags.length}
          open={branchSidebarSections.tagsOpen}
          onOpenChange={(next) => {
            onBranchSidebarSectionsChange({ ...branchSidebarSections, tagsOpen: next });
          }}
          empty={canShowBranches && filteredTags.length === 0}
          emptyHint={tagsEmptyHint}
          isLastSection={false}
          belowHeader={
            canShowBranches ? (
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
          {canShowBranches ? (
            <ul className="m-0 w-full min-w-0 list-none rounded-md bg-transparent p-0">
              {filteredTags.map((t) => {
                const tagRowBusy = Boolean(branchBusy) || stashBusy !== null || pushBusy;
                const shortTip = t.tipHash.length >= 7 ? t.tipHash.slice(0, 7) : t.tipHash;
                return (
                  <li key={t.name} className="min-w-0">
                    <div
                      className="flex w-full min-w-0 cursor-context-menu flex-col gap-0.5 px-2 py-2 text-left wrap-break-word hover:bg-base-200/50"
                      title={`${t.name} → ${t.tipHash}`}
                      onContextMenu={(e) => {
                        if (tagRowBusy) return;
                        if (!nativeContextMenusAvailable()) return;
                        e.preventDefault();
                        void openTagSidebarMenu(t.name, e.clientX, e.clientY);
                      }}
                    >
                      <div className="flex min-w-0 items-baseline justify-between gap-2">
                        <span className="min-w-0 flex-1 font-mono text-[0.8125rem] leading-snug wrap-break-word">
                          {t.name}
                        </span>
                        <span className="shrink-0 font-mono text-[0.65rem] leading-none tracking-tight opacity-60">
                          {shortTip}
                        </span>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </BranchPanel>

        <BranchPanel
          title="Stashes"
          entityCount={stashes.length}
          open={branchSidebarSections.stashOpen}
          onOpenChange={(next) => {
            onBranchSidebarSectionsChange({ ...branchSidebarSections, stashOpen: next });
          }}
          empty={canShowBranches && filteredStashes.length === 0}
          emptyHint={stashesEmptyHint}
          isLastSection
          belowHeader={
            canShowBranches ? (
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
          {canShowBranches ? (
            <ul className="m-0 w-full min-w-0 list-none rounded-md bg-transparent p-0">
              {filteredStashes.map((s) => {
                const stashRowBusy = Boolean(branchBusy) || stashBusy !== null;
                return (
                  <li key={s.refName} className="min-w-0">
                    <div
                      className="flex w-full min-w-0 flex-col gap-0.5 px-2 py-2 text-left wrap-break-word hover:bg-base-200/50"
                      title={`${s.refName}: ${s.message}`}
                      onContextMenu={(e) => {
                        if (stashRowBusy) return;
                        if (!nativeContextMenusAvailable()) return;
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
}
