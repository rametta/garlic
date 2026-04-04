import { useVirtualizer } from "@tanstack/react-virtual";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { formatAuthorDisplay, formatDate, formatRelativeShort } from "../appFormat";
import { CommitGraphColumn } from "./CommitGraphColumn";
import {
  COMMIT_GRAPH_LANE_WIDTH,
  COMMIT_GRAPH_PAD_X,
  commitGraphRowHeightPx,
  type CommitGraphLayout,
} from "../commitGraphLayout";
import {
  clampGraphCommitsPageSize,
  GRAPH_COMMITS_PAGE_SIZE_MAX,
  GRAPH_COMMITS_PAGE_SIZE_MIN,
} from "../gitTypes";
import { buildGravatarUrlCandidates } from "../gravatar";
import type { CommitEntry, LocalBranchEntry, RemoteBranchEntry, TagEntry } from "../repoTypes";

const GRAPH_GAP_PX = 6;
const BRANCH_COL = "6.75rem";

function IconPull({ className }: { className?: string }) {
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
      <path d="M12 4v10" />
      <path d="m8 10 4 4 4-4" />
      <path d="M5 20h14" />
    </svg>
  );
}

function IconPush({ className }: { className?: string }) {
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
      <path d="M12 20V10" />
      <path d="m8 14 4-4 4 4" />
      <path d="M5 4h14" />
    </svg>
  );
}

function IconBranch({ className }: { className?: string }) {
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
      <circle cx="6" cy="6" r="2" />
      <circle cx="18" cy="6" r="2" />
      <circle cx="18" cy="18" r="2" />
      <path d="M8 6h4a4 4 0 0 1 4 4v6" />
    </svg>
  );
}

function IconStash({ className }: { className?: string }) {
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
      <path d="M5 7h14l-1 11H6L5 7Z" />
      <path d="M8 7 9 4h6l1 3" />
      <path d="M9 11h6" />
    </svg>
  );
}

function IconPop({ className }: { className?: string }) {
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
      <path d="M5 11h14l-1 8H6l-1-8Z" />
      <path d="M12 15V4" />
      <path d="m8 8 4-4 4 4" />
    </svg>
  );
}

function IconExport({ className }: { className?: string }) {
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
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" />
      <path d="M14 3v5h5" />
      <path d="M12 11v6" />
      <path d="m9.5 14.5 2.5 2.5 2.5-2.5" />
    </svg>
  );
}

export interface CommitGraphSectionProps {
  commits: CommitEntry[];
  commitGraphLayout: CommitGraphLayout;
  localBranches: LocalBranchEntry[];
  remoteBranches: RemoteBranchEntry[];
  tags: TagEntry[];
  graphBranchVisible: Record<string, boolean>;
  remoteGraphDefaultVisible: boolean;
  currentBranchName: string | null;
  currentBranchTipHash: string | null;
  activeFirstParentHashes: ReadonlySet<string>;
  highlightActiveBranchRows: boolean;
  commitBrowseHash: string | null;
  /** Highlights a commit row without opening browse (e.g. branch tip or stash). */
  graphFocusHash: string | null;
  /** Increment to scroll the graph so `graphFocusHash` is in view. */
  graphScrollNonce: number;
  branchBusy: string | null;
  /** True while a push (branch or tag) is in progress. */
  pushBusy: boolean;
  stashBusy: string | null;
  commitsSectionTitle: string;
  /** Shown when `commits.length === 0` (e.g. filters excluded every row). */
  emptyMessage?: string;
  graphCommitsHasMore: boolean;
  loadingMoreGraphCommits: boolean;
  loadMoreGraphCommits: () => void;
  selectedCommitHashes: ReadonlySet<string>;
  onRowCommitSelect: (
    hash: string,
    options: { toggleSelection: boolean; rangeSelection: boolean },
  ) => void;
  openGraphBranchLocalMenu: (branchName: string, clientX: number, clientY: number) => void;
  openGraphBranchRemoteMenu: (fullRef: string, clientX: number, clientY: number) => void;
  openGraphStashMenu: (stashRef: string, clientX: number, clientY: number) => void;
  openGraphWipMenu: (clientX: number, clientY: number) => void;
  openGraphCommitMenu: (hash: string, clientX: number, clientY: number) => void;
  openGraphTagMenu: (tagName: string, clientX: number, clientY: number) => void;
  graphAuthorFilter: string;
  onGraphAuthorFilterChange: (value: string) => void;
  graphDateFrom: string;
  graphDateTo: string;
  onGraphDateFromChange: (value: string) => void;
  onGraphDateToChange: (value: string) => void;
  graphExportIncludeHash: boolean;
  onGraphExportIncludeHashChange: (value: boolean) => void;
  graphExportIncludeMergeCommits: boolean;
  onGraphExportIncludeMergeCommitsChange: (value: boolean) => void;
  graphExportIncludeAuthor: boolean;
  onGraphExportIncludeAuthorChange: (value: boolean) => void;
  graphFiltersActive: boolean;
  onClearGraphFilters: () => void;
  onExportGraphCommits: () => void;
  exportGraphCommitsDisabled: boolean;
  /** Count of paths with staged or unstaged changes; when &gt; 0, a WIP row is shown above the graph. */
  wipChangedFileCount: number;
  /** Opens the first available working-tree diff when the WIP row is activated. */
  onWipSelect?: () => void;
  /** True while React is deferring a heavy graph layout pass (concurrent rendering). */
  graphLayoutDeferredPending?: boolean;
  /** `git log -n` page size for each graph fetch (persisted app setting). */
  graphCommitsPageSize: number;
  onGraphCommitsPageSizeChange: (value: number) => void;
  /** Commit subject font size in the main graph (persisted app setting, px). */
  graphCommitTitleFontSizePx: number;
  pullActionDisabled: boolean;
  onPullAction: () => void;
  pushActionDisabled: boolean;
  onPushAction: () => void;
  onPushActionContextMenu: (clientX: number, clientY: number) => void;
  branchActionDisabled: boolean;
  branchActionTargetLabel: string | null;
  onBranchAction: () => void;
  stashActionDisabled: boolean;
  onStashAction: () => void;
  popActionDisabled: boolean;
  latestStashRef: string | null;
  onPopAction: () => void;
}

type TipsAtHash = {
  locals: LocalBranchEntry[];
  remotes: RemoteBranchEntry[];
  tagTips: TagEntry[];
};

function buildTipsByHash(
  localBranches: LocalBranchEntry[],
  remoteBranches: RemoteBranchEntry[],
  tags: TagEntry[],
  graphBranchVisible: Record<string, boolean>,
  remoteGraphDefaultVisible: boolean,
  commitHashes: ReadonlySet<string>,
): Map<string, TipsAtHash> {
  const map = new Map<string, TipsAtHash>();
  for (const b of localBranches) {
    if (graphBranchVisible[`local:${b.name}`] === false) continue;
    if (!commitHashes.has(b.tipHash)) continue;
    let e = map.get(b.tipHash);
    if (!e) {
      e = { locals: [], remotes: [], tagTips: [] };
      map.set(b.tipHash, e);
    }
    e.locals.push(b);
  }
  for (const r of remoteBranches) {
    const visible = graphBranchVisible[`remote:${r.name}`] ?? remoteGraphDefaultVisible;
    if (!visible) continue;
    if (!commitHashes.has(r.tipHash)) continue;
    let e = map.get(r.tipHash);
    if (!e) {
      e = { locals: [], remotes: [], tagTips: [] };
      map.set(r.tipHash, e);
    }
    e.remotes.push(r);
  }
  for (const t of tags) {
    if (!commitHashes.has(t.tipHash)) continue;
    let e = map.get(t.tipHash);
    if (!e) {
      e = { locals: [], remotes: [], tagTips: [] };
      map.set(t.tipHash, e);
    }
    e.tagTips.push(t);
  }
  for (const e of map.values()) {
    e.tagTips.sort((a, b) => a.name.localeCompare(b.name));
  }
  return map;
}

type RowLaneMeta = {
  laneColor: string | undefined;
  visibleLocalTips: LocalBranchEntry[];
  visibleRemoteTips: RemoteBranchEntry[];
  visibleTags: TagEntry[];
};

function computeRowLaneMeta(
  layout: CommitGraphLayout,
  rowIndex: number,
  tips: TipsAtHash | undefined,
): RowLaneMeta {
  if (!tips) {
    return {
      laneColor: undefined,
      visibleLocalTips: [],
      visibleRemoteTips: [],
      visibleTags: [],
    };
  }
  const laneColor = layout.rowColors[rowIndex];
  return {
    laneColor,
    visibleLocalTips: tips.locals,
    visibleRemoteTips: tips.remotes,
    visibleTags: tips.tagTips,
  };
}

function getGraphRowBackgroundClass(args: {
  isBrowsing: boolean;
  isSelected: boolean;
  isGraphFocus: boolean;
  isHeadBranchTipRow: boolean;
  isActiveBranchCommitRow: boolean;
}): string {
  if (args.isBrowsing) return "bg-primary/20";
  if (args.isSelected) return "bg-secondary/12";
  if (args.isGraphFocus) return "bg-accent/15";
  if (args.isHeadBranchTipRow) return "bg-primary/15";
  if (args.isActiveBranchCommitRow) return "bg-primary/8";
  return "";
}

function graphLaneCenterPx(lane: number): number {
  return COMMIT_GRAPH_PAD_X + lane * COMMIT_GRAPH_LANE_WIDTH + COMMIT_GRAPH_LANE_WIDTH / 2;
}

function graphCommitNodeSizePx(isActiveBranchCommit: boolean, isActiveTip: boolean): number {
  if (isActiveTip) return 24;
  if (isActiveBranchCommit) return 22;
  return 20;
}

type GraphCommitNodeAvatarProps = {
  leftPx: number;
  email: string;
  nodeColor: string;
  isActiveBranchCommit: boolean;
  isActiveTip: boolean;
  isStashRow: boolean;
  rowHeightPx: number;
};

const GraphCommitNodeAvatar = memo(function GraphCommitNodeAvatar({
  leftPx,
  email,
  nodeColor,
  isActiveBranchCommit,
  isActiveTip,
  isStashRow,
  rowHeightPx,
}: GraphCommitNodeAvatarProps) {
  const [candidateUrls, setCandidateUrls] = useState<string[]>([]);
  const [candidateIndex, setCandidateIndex] = useState(0);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setCandidateUrls([]);
    setCandidateIndex(0);
    setLoadFailed(false);
    void buildGravatarUrlCandidates(email, 64).then((urls) => {
      if (cancelled) return;
      setCandidateUrls(urls);
    });
    return () => {
      cancelled = true;
    };
  }, [email]);

  const src = candidateUrls[candidateIndex] ?? null;

  const sizePx = graphCommitNodeSizePx(isActiveBranchCommit, isActiveTip);
  const ringWidth = isActiveBranchCommit ? 2.1 : 1.5;
  const fallbackClassName = isActiveBranchCommit ? "" : "bg-base-100";

  return (
    <span
      className="pointer-events-none absolute rounded-full"
      style={{
        left: leftPx - sizePx / 2,
        top: (rowHeightPx - sizePx) / 2,
        width: sizePx,
        height: sizePx,
      }}
      aria-hidden
    >
      {isActiveBranchCommit ? (
        <span
          className="absolute inset-0 rounded-full"
          style={{
            backgroundColor: nodeColor,
            opacity: isActiveTip ? 0.24 : 0.18,
            transform: "scale(1.32)",
          }}
        />
      ) : null}
      {src && !loadFailed ? (
        <img
          src={src}
          alt=""
          className="absolute inset-0 h-full w-full rounded-full bg-base-100 object-cover"
          loading="lazy"
          decoding="async"
          draggable={false}
          referrerPolicy="no-referrer"
          onError={() => {
            const nextIndex = candidateIndex + 1;
            if (nextIndex < candidateUrls.length) {
              setCandidateIndex(nextIndex);
              return;
            }
            setLoadFailed(true);
          }}
        />
      ) : (
        <span
          className={`absolute inset-0 rounded-full ${fallbackClassName}`}
          style={{
            backgroundColor: isActiveBranchCommit ? nodeColor : undefined,
            opacity: isActiveBranchCommit ? (isActiveTip ? 0.98 : 0.88) : undefined,
          }}
        />
      )}
      <span
        className={`absolute inset-0 rounded-full border ${isStashRow ? "border-dashed" : ""}`}
        style={{
          borderColor: nodeColor,
          borderWidth: ringWidth,
        }}
      />
    </span>
  );
});

type VirtualRowProps = {
  c: CommitEntry;
  idx: number;
  commitsLength: number;
  graphWidthPx: number;
  laneMeta: RowLaneMeta;
  currentBranchLabelVisibleInRows: boolean;
  commitBrowseHash: string | null;
  isSelected: boolean;
  graphFocusHash: string | null;
  currentBranchTipHash: string | null;
  currentBranchName: string | null;
  activeFirstParentHashes: ReadonlySet<string>;
  highlightActiveBranchRows: boolean;
  branchBusy: string | null;
  pushBusy: boolean;
  stashBusy: string | null;
  commitsSectionTitle: string;
  onRowCommitSelect: (
    hash: string,
    options: { toggleSelection: boolean; rangeSelection: boolean },
  ) => void;
  openGraphBranchLocalMenu: (branchName: string, clientX: number, clientY: number) => void;
  openGraphBranchRemoteMenu: (fullRef: string, clientX: number, clientY: number) => void;
  openGraphStashMenu: (stashRef: string, clientX: number, clientY: number) => void;
  openGraphCommitMenu: (hash: string, clientX: number, clientY: number) => void;
  openGraphTagMenu: (tagName: string, clientX: number, clientY: number) => void;
  commitTitleFontSizePx: number;
};

const CommitGraphVirtualRow = memo(function CommitGraphVirtualRow({
  c,
  idx,
  commitsLength,
  graphWidthPx,
  laneMeta,
  currentBranchLabelVisibleInRows,
  commitBrowseHash,
  isSelected,
  graphFocusHash,
  currentBranchTipHash,
  currentBranchName,
  activeFirstParentHashes,
  highlightActiveBranchRows,
  branchBusy,
  pushBusy,
  stashBusy,
  commitsSectionTitle,
  onRowCommitSelect,
  openGraphBranchLocalMenu,
  openGraphBranchRemoteMenu,
  openGraphStashMenu,
  openGraphCommitMenu,
  openGraphTagMenu,
  commitTitleFontSizePx,
}: VirtualRowProps) {
  const stashRef = c.stashRef?.trim() || null;
  const { laneColor, visibleLocalTips, visibleRemoteTips, visibleTags } = laneMeta;
  const hasBranchTips = visibleLocalTips.length > 0 || visibleRemoteTips.length > 0;
  const tipsHereNames = [
    ...visibleLocalTips.map((b) => b.name),
    ...visibleRemoteTips.map((r) => r.name),
  ];

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
      {visibleLocalTips.some((b) => b.name === currentBranchName) ? (
        <span className="shrink-0 text-primary" aria-hidden>
          ✓
        </span>
      ) : null}
      {visibleLocalTips.map((b) => (
        <span
          key={`l:${b.name}`}
          className={`max-w-full min-w-0 cursor-context-menu truncate font-medium ${
            b.name === currentBranchName ? "rounded-sm bg-primary/14 px-1 text-primary" : ""
          }`}
          onContextMenu={(e) => {
            if (branchBusy) return;
            e.preventDefault();
            e.stopPropagation();
            openGraphBranchLocalMenu(b.name, e.clientX, e.clientY);
          }}
        >
          {b.name}
        </span>
      ))}
      {visibleLocalTips.length > 0 && visibleRemoteTips.length > 0 ? (
        <span className="shrink-0 text-[0.55rem] text-base-content/45" aria-hidden />
      ) : null}
      {visibleRemoteTips.map((r) => (
        <span
          key={`r:${r.name}`}
          className="max-w-full min-w-0 cursor-context-menu truncate font-medium text-secondary"
          onContextMenu={(e) => {
            if (branchBusy) return;
            e.preventDefault();
            e.stopPropagation();
            openGraphBranchRemoteMenu(r.name, e.clientX, e.clientY);
          }}
        >
          {r.name}
        </span>
      ))}
    </span>
  ) : stashRef ? (
    <span
      className="flex min-w-0 cursor-context-menu flex-wrap items-center gap-1 text-[0.62rem] leading-tight text-base-content"
      title={`Stash ${stashRef}`}
      onContextMenu={(e) => {
        if (branchBusy || stashBusy !== null) return;
        e.preventDefault();
        e.stopPropagation();
        openGraphStashMenu(stashRef, e.clientX, e.clientY);
      }}
    >
      <span className="badge shrink-0 font-mono badge-xs badge-warning">{stashRef}</span>
    </span>
  ) : idx === 0 && !currentBranchLabelVisibleInRows ? (
    <span
      className="flex min-w-0 cursor-context-menu items-center gap-0.5 truncate text-[0.65rem] leading-tight text-base-content/85"
      title={commitsSectionTitle}
      onContextMenu={(e) => {
        if (branchBusy || !currentBranchName) return;
        e.preventDefault();
        e.stopPropagation();
        openGraphBranchLocalMenu(currentBranchName, e.clientX, e.clientY);
      }}
    >
      <span className="shrink-0 text-primary" aria-hidden>
        ✓
      </span>
      <span className="min-w-0 truncate font-medium">{commitsSectionTitle}</span>
    </span>
  ) : null;

  const isBrowsing = commitBrowseHash === c.hash;
  const isGraphFocus = graphFocusHash !== null && c.hash === graphFocusHash && !isBrowsing;
  const isHeadBranchTipRow = currentBranchTipHash !== null && c.hash === currentBranchTipHash;
  const isActiveBranchCommitRow =
    highlightActiveBranchRows && currentBranchName !== null && activeFirstParentHashes.has(c.hash);
  const rel = formatRelativeShort(c.date);
  const fullTitle = [
    stashRef ? `${stashRef} — ${c.shortHash} — ${c.subject}` : `${c.shortHash} — ${c.subject}`,
    c.author,
    formatDate(c.date) ?? undefined,
    visibleTags.length > 0 ? `Tags: ${visibleTags.map((t) => t.name).join(", ")}` : undefined,
  ]
    .filter(Boolean)
    .join("\n");
  const rowRule = idx < commitsLength - 1 ? "border-b border-base-300/40" : "";
  const rowBackgroundClass = getGraphRowBackgroundClass({
    isBrowsing,
    isSelected,
    isGraphFocus,
    isHeadBranchTipRow,
    isActiveBranchCommitRow,
  });

  return (
    <>
      <div
        className={`flex min-h-0 min-w-0 shrink-0 items-center px-0.5 ${rowRule} ${rowBackgroundClass}`}
        style={{ width: BRANCH_COL, maxWidth: BRANCH_COL }}
      >
        {branchCell}
      </div>
      <div className="shrink-0" style={{ width: graphWidthPx }} aria-hidden />
      <button
        type="button"
        title={fullTitle}
        className={`grid h-full min-h-0 min-w-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(0,6.5rem)_minmax(0,3.25rem)] items-center gap-x-1.5 px-1 text-left leading-tight transition-colors ${rowRule} ${
          isBrowsing
            ? "bg-primary/20 ring-1 ring-primary/35 ring-inset"
            : isSelected
              ? "bg-secondary/12 ring-1 ring-secondary/18 ring-inset hover:bg-secondary/18"
              : isGraphFocus
                ? "bg-accent/15 ring-1 ring-accent/30 ring-inset"
                : isHeadBranchTipRow
                  ? "bg-primary/15 hover:bg-primary/24 hover:ring-1 hover:ring-primary/22 hover:ring-inset"
                  : isActiveBranchCommitRow
                    ? "bg-primary/8 hover:bg-primary/14 hover:ring-1 hover:ring-primary/16 hover:ring-inset"
                    : "hover:bg-base-300/70 hover:ring-1 hover:ring-base-content/10 hover:ring-inset"
        }`}
        onClick={(e) => {
          onRowCommitSelect(c.hash, {
            toggleSelection: e.metaKey || e.ctrlKey,
            rangeSelection: e.shiftKey,
          });
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          openGraphCommitMenu(c.hash, e.clientX, e.clientY);
        }}
      >
        <span className="flex min-w-0 items-center gap-x-1.5">
          <span
            className="min-w-0 flex-1 truncate text-base-content/90"
            style={{ fontSize: commitTitleFontSizePx }}
          >
            {c.subject}
          </span>
          {visibleTags.length > 0 ? (
            <span className="flex shrink-0 items-center gap-1">
              {visibleTags.map((t) => (
                <span
                  key={`tag:${t.name}`}
                  className="badge inline-flex max-w-28 min-w-0 shrink-0 cursor-context-menu truncate badge-ghost font-mono badge-xs text-[0.6rem] text-accent"
                  title={t.name}
                  onContextMenu={(e) => {
                    if (branchBusy || pushBusy) return;
                    e.preventDefault();
                    e.stopPropagation();
                    openGraphTagMenu(t.name, e.clientX, e.clientY);
                  }}
                >
                  {t.name}
                </span>
              ))}
            </span>
          ) : null}
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
    </>
  );
});

const VIRTUAL_OVERSCAN = 12;

const WipGraphRow = memo(function WipGraphRow({
  changedFileCount,
  graphWidthPx,
}: {
  changedFileCount: number;
  graphWidthPx: number;
}) {
  const rowRule = "border-b border-base-300/40";
  return (
    <>
      <div
        className={`flex min-h-0 min-w-0 shrink-0 items-center px-0.5 ${rowRule}`}
        style={{ width: BRANCH_COL, maxWidth: BRANCH_COL }}
        aria-hidden
      />
      <div className="shrink-0" style={{ width: graphWidthPx }} aria-hidden />
      <div
        className={`grid h-full min-h-0 min-w-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(0,6.5rem)_minmax(0,3.25rem)] items-center gap-x-1.5 px-1 text-left text-[0.6875rem] leading-tight ${rowRule} text-base-content/80`}
      >
        <span
          className="min-w-0 truncate font-mono text-base-content/90"
          title="Uncommitted changes"
        >
          // WIP
        </span>
        <span className="min-w-0 truncate text-[0.62rem] text-base-content/45">—</span>
        <span className="flex shrink-0 items-center justify-end gap-1 text-right text-[0.6rem] text-base-content/55 tabular-nums">
          <svg
            className="h-3.5 w-3.5 shrink-0 opacity-80"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M12 20h9" />
            <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
          </svg>
          <span>{changedFileCount}</span>
        </span>
      </div>
    </>
  );
});

export const CommitGraphSection = memo(function CommitGraphSection({
  commits,
  commitGraphLayout,
  localBranches,
  remoteBranches,
  tags,
  graphBranchVisible,
  remoteGraphDefaultVisible,
  currentBranchName,
  currentBranchTipHash,
  activeFirstParentHashes,
  highlightActiveBranchRows,
  commitBrowseHash,
  graphFocusHash,
  graphScrollNonce,
  branchBusy,
  pushBusy,
  stashBusy,
  commitsSectionTitle,
  emptyMessage = "No commits to show",
  graphCommitsHasMore,
  loadingMoreGraphCommits,
  loadMoreGraphCommits,
  selectedCommitHashes,
  onRowCommitSelect,
  openGraphBranchLocalMenu,
  openGraphBranchRemoteMenu,
  openGraphStashMenu,
  openGraphCommitMenu,
  openGraphTagMenu,
  graphAuthorFilter,
  onGraphAuthorFilterChange,
  graphDateFrom,
  graphDateTo,
  onGraphDateFromChange,
  onGraphDateToChange,
  graphExportIncludeHash,
  onGraphExportIncludeHashChange,
  graphExportIncludeMergeCommits,
  onGraphExportIncludeMergeCommitsChange,
  graphExportIncludeAuthor,
  onGraphExportIncludeAuthorChange,
  graphFiltersActive,
  onClearGraphFilters,
  onExportGraphCommits,
  exportGraphCommitsDisabled,
  wipChangedFileCount,
  onWipSelect,
  openGraphWipMenu,
  graphLayoutDeferredPending = false,
  graphCommitsPageSize,
  onGraphCommitsPageSizeChange,
  graphCommitTitleFontSizePx,
  pullActionDisabled,
  onPullAction,
  pushActionDisabled,
  onPushAction,
  onPushActionContextMenu,
  branchActionDisabled,
  branchActionTargetLabel,
  onBranchAction,
  stashActionDisabled,
  onStashAction,
  popActionDisabled,
  latestStashRef,
  onPopAction,
}: CommitGraphSectionProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const authorFilterWrapRef = useRef<HTMLDivElement>(null);
  const whenFilterWrapRef = useRef<HTMLDivElement>(null);
  const [authorFilterOpen, setAuthorFilterOpen] = useState(false);
  const [whenFilterOpen, setWhenFilterOpen] = useState(false);
  const [pageSizeDraft, setPageSizeDraft] = useState(() => String(graphCommitsPageSize));

  useEffect(() => {
    setPageSizeDraft(String(graphCommitsPageSize));
  }, [graphCommitsPageSize]);

  const graphRowHeightPx = commitGraphRowHeightPx(graphCommitTitleFontSizePx);

  useEffect(() => {
    if (!authorFilterOpen && !whenFilterOpen) return;
    function onDocMouseDown(e: MouseEvent) {
      const t = e.target as Node;
      if (authorFilterWrapRef.current?.contains(t)) return;
      if (whenFilterWrapRef.current?.contains(t)) return;
      setAuthorFilterOpen(false);
      setWhenFilterOpen(false);
    }
    document.addEventListener("mousedown", onDocMouseDown);
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown);
    };
  }, [authorFilterOpen, whenFilterOpen]);

  const commitRowHashes = useMemo(() => commits.map((commit) => commit.hash), [commits]);
  const commitHashes = useMemo(() => new Set(commitRowHashes), [commitRowHashes]);

  const tipsByHash = useMemo(
    () =>
      buildTipsByHash(
        localBranches,
        remoteBranches,
        tags,
        graphBranchVisible,
        remoteGraphDefaultVisible,
        commitHashes,
      ),
    [
      localBranches,
      remoteBranches,
      tags,
      graphBranchVisible,
      remoteGraphDefaultVisible,
      commitHashes,
    ],
  );

  const rowLaneMetas = useMemo(() => {
    return commits.map((c, idx) =>
      computeRowLaneMeta(commitGraphLayout, idx, tipsByHash.get(c.hash)),
    );
  }, [commits, commitGraphLayout, tipsByHash]);
  const currentBranchLabelVisibleInRows = useMemo(() => {
    if (!currentBranchName) return false;
    return commits.some((commit) =>
      (tipsByHash.get(commit.hash)?.locals ?? []).some(
        (branch) => branch.name === currentBranchName,
      ),
    );
  }, [commits, currentBranchName, tipsByHash]);

  const showWipRow = wipChangedFileCount > 0;
  const wipOffset = showWipRow ? 1 : 0;
  const virtualRowCount = commits.length + wipOffset;

  const rowVirtualizer = useVirtualizer({
    count: virtualRowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => graphRowHeightPx,
    overscan: VIRTUAL_OVERSCAN,
  });

  useEffect(() => {
    rowVirtualizer.measure();
  }, [graphRowHeightPx, rowVirtualizer]);

  useEffect(() => {
    if (!graphFocusHash) return;
    const idx = commits.findIndex((c) => c.hash === graphFocusHash);
    if (idx < 0) return;
    const virIndex = idx + wipOffset;
    rowVirtualizer.scrollToIndex(virIndex, { align: "center" });
  }, [graphFocusHash, graphScrollNonce, commits, wipOffset, rowVirtualizer]);

  const totalHeight = rowVirtualizer.getTotalSize();
  const graphWidthPx = commitGraphLayout.graphWidthPx;
  const gridTemplateColumns = `minmax(0, ${BRANCH_COL}) ${graphWidthPx}px minmax(0, 1fr) minmax(0, 6.5rem) minmax(0, 3.25rem)`;

  const graphLeft = `calc(${BRANCH_COL} + ${GRAPH_GAP_PX}px)`;
  const virtualRows = rowVirtualizer.getVirtualItems();
  const pullBusy = currentBranchName !== null && branchBusy === `pull:${currentBranchName}`;
  const createBranchBusy = branchBusy === "create";
  const stashPushBusy = stashBusy === "push";
  const stashPopBusy = stashBusy?.startsWith("pop:") ?? false;

  const graphFooter = (
    <div className="mt-2 flex flex-wrap items-center justify-center gap-2 border-t border-base-300/50 pt-2">
      <label className="flex items-center gap-2 text-[0.7rem] text-base-content/70">
        <span className="shrink-0">Commits per page</span>
        <input
          type="number"
          min={GRAPH_COMMITS_PAGE_SIZE_MIN}
          max={GRAPH_COMMITS_PAGE_SIZE_MAX}
          step={1}
          className="input-bordered input input-xs w-18 font-mono tabular-nums"
          aria-label="Commits loaded per graph log request"
          value={pageSizeDraft}
          onChange={(e) => {
            setPageSizeDraft(e.target.value);
          }}
          onBlur={() => {
            const n = parseInt(pageSizeDraft, 10);
            if (!Number.isFinite(n)) {
              setPageSizeDraft(String(graphCommitsPageSize));
              return;
            }
            onGraphCommitsPageSizeChange(clampGraphCommitsPageSize(n));
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              (e.target as HTMLInputElement).blur();
            }
          }}
        />
      </label>
      {graphCommitsHasMore ? (
        <button
          type="button"
          className="btn btn-outline btn-sm"
          disabled={loadingMoreGraphCommits}
          onClick={() => {
            loadMoreGraphCommits();
          }}
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
      ) : null}
    </div>
  );

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex shrink-0 justify-center border-b border-base-300/80 px-3 py-2">
        <ul
          className="menu menu-horizontal flex-wrap items-center justify-center menu-xs rounded-box bg-base-200/70 p-1"
          aria-label="Graph actions"
        >
          <li className={pullActionDisabled ? "menu-disabled" : undefined}>
            <button
              type="button"
              className="flex items-center gap-1.5"
              disabled={pullActionDisabled}
              title={
                currentBranchName ? `Pull the current branch (${currentBranchName})` : undefined
              }
              onClick={onPullAction}
            >
              {pullBusy ? (
                <span className="loading loading-xs shrink-0 loading-spinner" />
              ) : (
                <IconPull className="h-3.5 w-3.5 shrink-0" />
              )}
              <span>Pull</span>
            </button>
          </li>
          <li className={pushActionDisabled ? "menu-disabled" : undefined}>
            <button
              type="button"
              className="flex items-center gap-1.5"
              disabled={pushActionDisabled}
              title="Push the current branch to origin. Right-click for force push."
              onClick={onPushAction}
              onContextMenu={(e) => {
                if (pushActionDisabled) return;
                e.preventDefault();
                e.stopPropagation();
                onPushActionContextMenu(e.clientX, e.clientY);
              }}
            >
              {pushBusy ? (
                <span className="loading loading-xs shrink-0 loading-spinner" />
              ) : (
                <IconPush className="h-3.5 w-3.5 shrink-0" />
              )}
              <span>Push</span>
            </button>
          </li>
          <li className={branchActionDisabled ? "menu-disabled" : undefined}>
            <button
              type="button"
              className="flex items-center gap-1.5"
              disabled={branchActionDisabled}
              title={
                branchActionTargetLabel
                  ? `Create a branch from ${branchActionTargetLabel}`
                  : "Create a branch from the current graph position"
              }
              onClick={onBranchAction}
            >
              {createBranchBusy ? (
                <span className="loading loading-xs shrink-0 loading-spinner" />
              ) : (
                <IconBranch className="h-3.5 w-3.5 shrink-0" />
              )}
              <span>Branch</span>
            </button>
          </li>
          <li className={stashActionDisabled ? "menu-disabled" : undefined}>
            <button
              type="button"
              className="flex items-center gap-1.5"
              disabled={stashActionDisabled}
              title={
                wipChangedFileCount > 0
                  ? "Stash working tree changes"
                  : "No working tree changes to stash"
              }
              onClick={onStashAction}
            >
              {stashPushBusy ? (
                <span className="loading loading-xs shrink-0 loading-spinner" />
              ) : (
                <IconStash className="h-3.5 w-3.5 shrink-0" />
              )}
              <span>Stash</span>
            </button>
          </li>
          <li className={popActionDisabled ? "menu-disabled" : undefined}>
            <button
              type="button"
              className="flex items-center gap-1.5"
              disabled={popActionDisabled}
              title={latestStashRef ? `Pop ${latestStashRef}` : "No stashes available to pop"}
              onClick={onPopAction}
            >
              {stashPopBusy ? (
                <span className="loading loading-xs shrink-0 loading-spinner" />
              ) : (
                <IconPop className="h-3.5 w-3.5 shrink-0" />
              )}
              <span>Pop</span>
            </button>
          </li>
          <li className={exportGraphCommitsDisabled ? "menu-disabled" : undefined}>
            <button
              type="button"
              className="flex items-center gap-1.5"
              disabled={exportGraphCommitsDisabled}
              title="Export the list of commits currently shown in the graph"
              onClick={onExportGraphCommits}
            >
              <IconExport className="h-3.5 w-3.5 shrink-0" />
              <span>Export</span>
            </button>
          </li>
        </ul>
      </div>
      <div
        className="sticky top-0 z-10 mb-0.5 grid shrink-0 items-center gap-x-1.5 border-b border-base-300/80 bg-base-100 pb-0.5 text-[0.6rem] font-semibold tracking-wide text-base-content/45 uppercase"
        style={{ gridTemplateColumns }}
      >
        <span className="truncate pl-3">Branch</span>
        <span className="min-w-0 truncate">Graph</span>
        <span className="min-w-0 truncate">Commit message</span>
        <div
          ref={authorFilterWrapRef}
          className={`dropdown dropdown-end min-w-0 justify-self-stretch ${authorFilterOpen ? "dropdown-open" : ""}`}
        >
          <button
            type="button"
            className="btn h-6 min-h-0 w-full max-w-full justify-start gap-1 px-1 font-sans text-[0.6rem] font-semibold tracking-wide normal-case opacity-100 btn-ghost btn-xs"
            aria-expanded={authorFilterOpen}
            aria-haspopup="dialog"
            title="Filter by author"
            onClick={(e) => {
              e.stopPropagation();
              setWhenFilterOpen(false);
              setAuthorFilterOpen((o) => !o);
            }}
          >
            <span className="truncate uppercase">Author</span>
            {graphAuthorFilter.trim() ? (
              <span className="badge shrink-0 badge-xs badge-primary" title="Filter active" />
            ) : null}
          </button>
          <div
            className="dropdown-content z-100 mt-0 w-64 max-w-[min(100vw-2rem,18rem)] rounded-box border border-base-300 bg-base-100 p-3"
            onMouseDown={(e) => {
              e.stopPropagation();
            }}
          >
            <label className="form-control w-full">
              <span className="label-text text-[0.65rem] font-medium uppercase opacity-70">
                Name or email
              </span>
              <input
                type="text"
                className="input-bordered input input-xs w-full font-mono text-xs"
                placeholder="Contains…"
                autoComplete="off"
                spellCheck={false}
                value={graphAuthorFilter}
                onChange={(e) => {
                  onGraphAuthorFilterChange(e.target.value);
                }}
              />
            </label>
            {graphFiltersActive ? (
              <button
                type="button"
                className="btn mt-2 w-full btn-ghost btn-xs"
                onClick={() => {
                  onClearGraphFilters();
                  setAuthorFilterOpen(false);
                }}
              >
                Clear all filters
              </button>
            ) : null}
          </div>
        </div>
        <div
          ref={whenFilterWrapRef}
          className={`dropdown dropdown-end min-w-0 justify-self-end pr-2 ${whenFilterOpen ? "dropdown-open" : ""}`}
        >
          <button
            type="button"
            className="btn h-6 min-h-0 gap-1 px-1 font-sans text-[0.6rem] font-semibold tracking-wide normal-case opacity-100 btn-ghost btn-xs"
            aria-expanded={whenFilterOpen}
            aria-haspopup="dialog"
            title="Filter by date"
            onClick={(e) => {
              e.stopPropagation();
              setAuthorFilterOpen(false);
              setWhenFilterOpen((o) => !o);
            }}
          >
            <span className="uppercase">When</span>
            {graphDateFrom.trim() || graphDateTo.trim() ? (
              <span className="badge shrink-0 badge-xs badge-primary" title="Filter active" />
            ) : null}
          </button>
          <div
            className="dropdown-content dropdown-end z-100 mt-0 w-64 max-w-[min(100vw-2rem,18rem)] rounded-box border border-base-300 bg-base-100 p-3"
            onMouseDown={(e) => {
              e.stopPropagation();
            }}
          >
            <label className="form-control w-full">
              <span className="label-text text-[0.65rem] font-medium uppercase opacity-70">
                From
              </span>
              <input
                type="date"
                className="input-bordered input input-xs w-full font-mono text-xs"
                value={graphDateFrom}
                onChange={(e) => {
                  onGraphDateFromChange(e.target.value);
                }}
              />
            </label>
            <label className="form-control mt-2 w-full">
              <span className="label-text text-[0.65rem] font-medium uppercase opacity-70">To</span>
              <input
                type="date"
                className="input-bordered input input-xs w-full font-mono text-xs"
                value={graphDateTo}
                onChange={(e) => {
                  onGraphDateToChange(e.target.value);
                }}
              />
            </label>
            <div className="mt-3 flex flex-col gap-1.5">
              <span className="label-text text-[0.65rem] font-medium uppercase opacity-70">
                Export
              </span>
              <label className="label cursor-pointer justify-start gap-2 py-0">
                <input
                  type="checkbox"
                  className="checkbox checkbox-xs"
                  checked={graphExportIncludeHash}
                  onChange={(e) => {
                    onGraphExportIncludeHashChange(e.target.checked);
                  }}
                />
                <span className="label-text text-[0.7rem] leading-tight">Include hash</span>
              </label>
              <label className="label cursor-pointer justify-start gap-2 py-0">
                <input
                  type="checkbox"
                  className="checkbox checkbox-xs"
                  checked={graphExportIncludeMergeCommits}
                  onChange={(e) => {
                    onGraphExportIncludeMergeCommitsChange(e.target.checked);
                  }}
                />
                <span className="label-text text-[0.7rem] leading-tight">
                  Include merge commits
                </span>
              </label>
              <label className="label cursor-pointer justify-start gap-2 py-0">
                <input
                  type="checkbox"
                  className="checkbox checkbox-xs"
                  checked={graphExportIncludeAuthor}
                  onChange={(e) => {
                    onGraphExportIncludeAuthorChange(e.target.checked);
                  }}
                />
                <span className="label-text text-[0.7rem] leading-tight">Include author</span>
              </label>
            </div>
            <button
              type="button"
              className="btn mt-2 w-full btn-outline btn-xs"
              disabled={exportGraphCommitsDisabled}
              onClick={() => {
                onExportGraphCommits();
              }}
            >
              Export list…
            </button>
            {graphFiltersActive ? (
              <button
                type="button"
                className="btn mt-1 w-full btn-ghost btn-xs"
                onClick={() => {
                  onClearGraphFilters();
                  setWhenFilterOpen(false);
                }}
              >
                Clear all filters
              </button>
            ) : null}
          </div>
        </div>
      </div>
      <div
        ref={scrollRef}
        className={`min-h-0 min-w-0 flex-1 overflow-x-auto overflow-y-auto transition-opacity duration-150 ${
          graphLayoutDeferredPending ? "opacity-[0.93]" : ""
        }`}
        aria-busy={graphLayoutDeferredPending}
      >
        {commits.length === 0 && !showWipRow ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex min-h-40 flex-1 flex-col items-center justify-center px-3 py-8">
              <p className="m-0 max-w-md text-center text-xs text-base-content/60">
                {emptyMessage}
              </p>
            </div>
            {graphFooter}
          </div>
        ) : (
          <>
            <div
              className="relative w-full min-w-0"
              style={{
                height: totalHeight,
                minHeight: totalHeight,
              }}
            >
              <div
                className="pointer-events-none absolute z-0"
                style={{
                  left: graphLeft,
                  width: graphWidthPx,
                  top: 0,
                  height: totalHeight,
                }}
              >
                {virtualRows.map((v) => {
                  if (showWipRow && v.index === 0) {
                    return (
                      <div
                        key="graph-bg-wip"
                        className="absolute right-0 left-0 z-0"
                        style={{ top: v.start, height: v.size }}
                        aria-hidden
                      />
                    );
                  }
                  const commitIdx = v.index - wipOffset;
                  const c = commits[commitIdx];
                  if (!c) return null;
                  const isBrowsing = commitBrowseHash === c.hash;
                  const isGraphFocus =
                    graphFocusHash !== null && c.hash === graphFocusHash && !isBrowsing;
                  const isSelected = selectedCommitHashes.has(c.hash);
                  const isHeadBranchTipRow =
                    currentBranchTipHash !== null && c.hash === currentBranchTipHash;
                  const isActiveBranchCommitRow =
                    highlightActiveBranchRows &&
                    currentBranchName !== null &&
                    activeFirstParentHashes.has(c.hash);
                  const rowBackgroundClass = getGraphRowBackgroundClass({
                    isBrowsing,
                    isSelected,
                    isGraphFocus,
                    isHeadBranchTipRow,
                    isActiveBranchCommitRow,
                  });
                  return (
                    <div
                      key={`graph-bg-${c.hash}`}
                      className={`absolute right-0 left-0 z-0 ${rowBackgroundClass}`}
                      style={{ top: v.start, height: v.size }}
                      aria-hidden
                    />
                  );
                })}
                <div className="relative z-1">
                  <CommitGraphColumn
                    layout={commitGraphLayout}
                    commitHashes={commitRowHashes}
                    activeFirstParentHashes={activeFirstParentHashes}
                    currentBranchTipHash={currentBranchTipHash}
                    wipRowAbove={showWipRow}
                    rowHeightPx={graphRowHeightPx}
                  />
                </div>
              </div>
              {virtualRows.map((v) => {
                if (showWipRow && v.index === 0) {
                  return (
                    <div
                      key="graph-ctx-wip"
                      role="presentation"
                      className="absolute z-2"
                      style={{
                        left: graphLeft,
                        width: graphWidthPx,
                        top: v.start,
                        height: v.size,
                      }}
                    />
                  );
                }
                const commitIdx = v.index - wipOffset;
                const c = commits[commitIdx];
                if (!c) return null;
                const lane = commitGraphLayout.lanes[commitIdx] ?? 0;
                const nodeColor =
                  commitGraphLayout.rowColors[commitIdx] ??
                  commitGraphLayout.laneColors[lane % commitGraphLayout.laneColors.length] ??
                  "currentColor";
                const isActiveBranchCommit =
                  currentBranchTipHash !== null && activeFirstParentHashes.has(c.hash);
                const isActiveTip =
                  currentBranchTipHash !== null && c.hash === currentBranchTipHash;
                return (
                  <div
                    key={`graph-ctx-${c.hash}`}
                    role="presentation"
                    className="absolute z-2 cursor-context-menu"
                    style={{
                      left: graphLeft,
                      width: graphWidthPx,
                      top: v.start,
                      height: v.size,
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      openGraphCommitMenu(c.hash, e.clientX, e.clientY);
                    }}
                  >
                    <GraphCommitNodeAvatar
                      leftPx={graphLaneCenterPx(lane)}
                      email={c.authorEmail}
                      nodeColor={nodeColor}
                      isActiveBranchCommit={isActiveBranchCommit}
                      isActiveTip={isActiveTip}
                      isStashRow={Boolean(commitGraphLayout.stashRows[commitIdx])}
                      rowHeightPx={graphRowHeightPx}
                    />
                  </div>
                );
              })}
              {virtualRows.map((v) => {
                if (showWipRow && v.index === 0) {
                  const wipInteractive = typeof onWipSelect === "function";
                  return (
                    <div
                      key="graph-row-wip"
                      role={wipInteractive ? "button" : undefined}
                      tabIndex={wipInteractive ? 0 : undefined}
                      aria-label={wipInteractive ? "Open first working tree diff" : undefined}
                      className={`absolute top-0 right-0 left-0 flex gap-x-1.5 px-0.5 ${
                        wipInteractive
                          ? "cursor-pointer transition-colors hover:bg-base-300/60 hover:ring-1 hover:ring-base-content/10 hover:ring-inset focus-visible:ring-1 focus-visible:ring-primary/40 focus-visible:outline-none"
                          : ""
                      }`}
                      style={{
                        top: v.start,
                        height: v.size,
                      }}
                      onClick={
                        wipInteractive
                          ? () => {
                              onWipSelect();
                            }
                          : undefined
                      }
                      onKeyDown={
                        wipInteractive
                          ? (e) => {
                              if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault();
                                onWipSelect();
                              }
                            }
                          : undefined
                      }
                      onContextMenu={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        openGraphWipMenu(e.clientX, e.clientY);
                      }}
                    >
                      <WipGraphRow
                        changedFileCount={wipChangedFileCount}
                        graphWidthPx={graphWidthPx}
                      />
                    </div>
                  );
                }
                const commitIdx = v.index - wipOffset;
                const c = commits[commitIdx];
                if (!c) return null;
                return (
                  <div
                    key={v.key}
                    className="absolute top-0 right-0 left-0 flex gap-x-1.5 px-0.5"
                    style={{
                      top: v.start,
                      height: v.size,
                    }}
                  >
                    <CommitGraphVirtualRow
                      c={c}
                      idx={commitIdx}
                      commitsLength={commits.length}
                      graphWidthPx={graphWidthPx}
                      laneMeta={rowLaneMetas[commitIdx]}
                      currentBranchLabelVisibleInRows={currentBranchLabelVisibleInRows}
                      commitBrowseHash={commitBrowseHash}
                      isSelected={selectedCommitHashes.has(c.hash)}
                      graphFocusHash={graphFocusHash}
                      currentBranchTipHash={currentBranchTipHash}
                      currentBranchName={currentBranchName}
                      activeFirstParentHashes={activeFirstParentHashes}
                      highlightActiveBranchRows={highlightActiveBranchRows}
                      branchBusy={branchBusy}
                      pushBusy={pushBusy}
                      stashBusy={stashBusy}
                      commitsSectionTitle={commitsSectionTitle}
                      onRowCommitSelect={onRowCommitSelect}
                      openGraphBranchLocalMenu={openGraphBranchLocalMenu}
                      openGraphBranchRemoteMenu={openGraphBranchRemoteMenu}
                      openGraphStashMenu={openGraphStashMenu}
                      openGraphCommitMenu={openGraphCommitMenu}
                      openGraphTagMenu={openGraphTagMenu}
                      commitTitleFontSizePx={graphCommitTitleFontSizePx}
                    />
                  </div>
                );
              })}
            </div>
            {graphFooter}
          </>
        )}
      </div>
    </div>
  );
});
