import { useVirtualizer } from "@tanstack/react-virtual";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { formatAuthorDisplay, formatDate, formatRelativeShort } from "../appFormat";
import { CommitGraphColumn } from "./CommitGraphColumn";
import { COMMIT_GRAPH_ROW_HEIGHT, type CommitGraphLayout } from "../commitGraphLayout";
import { nativeContextMenusAvailable } from "../nativeContextMenu";
import type { CommitEntry, LocalBranchEntry, RemoteBranchEntry, TagEntry } from "../repoTypes";

const GRAPH_GAP_PX = 6;
const BRANCH_COL = "6.75rem";

export interface CommitGraphSectionProps {
  commits: CommitEntry[];
  commitGraphLayout: CommitGraphLayout;
  localBranches: LocalBranchEntry[];
  remoteBranches: RemoteBranchEntry[];
  tags: TagEntry[];
  graphBranchVisible: Record<string, boolean>;
  currentBranchName: string | null;
  currentBranchTipHash: string | null;
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
  onRowCommitSelect: (hash: string) => void;
  openGraphBranchLocalMenu: (branchName: string, clientX: number, clientY: number) => void;
  openGraphBranchRemoteMenu: (fullRef: string, clientX: number, clientY: number) => void;
  openGraphStashMenu: (stashRef: string, clientX: number, clientY: number) => void;
  openGraphCommitMenu: (hash: string, clientX: number, clientY: number) => void;
  openGraphTagMenu: (tagName: string, clientX: number, clientY: number) => void;
  graphAuthorFilter: string;
  onGraphAuthorFilterChange: (value: string) => void;
  graphDateFrom: string;
  graphDateTo: string;
  onGraphDateFromChange: (value: string) => void;
  onGraphDateToChange: (value: string) => void;
  graphFiltersActive: boolean;
  onClearGraphFilters: () => void;
  onExportGraphCommits: () => void;
  exportGraphCommitsDisabled: boolean;
  /** Count of paths with staged or unstaged changes; when &gt; 0, a WIP row is shown above the graph. */
  wipChangedFileCount: number;
  /** Opens the first available working-tree diff when the WIP row is activated. */
  onWipSelect?: () => void;
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
): Map<string, TipsAtHash> {
  const map = new Map<string, TipsAtHash>();
  for (const b of localBranches) {
    if (graphBranchVisible[`local:${b.name}`] === false) continue;
    let e = map.get(b.tipHash);
    if (!e) {
      e = { locals: [], remotes: [], tagTips: [] };
      map.set(b.tipHash, e);
    }
    e.locals.push(b);
  }
  for (const r of remoteBranches) {
    if (graphBranchVisible[`remote:${r.name}`] === false) continue;
    let e = map.get(r.tipHash);
    if (!e) {
      e = { locals: [], remotes: [], tagTips: [] };
      map.set(r.tipHash, e);
    }
    e.remotes.push(r);
  }
  for (const t of tags) {
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

function computeRowLaneMeta(layout: CommitGraphLayout, tips: TipsAtHash | undefined): RowLaneMeta {
  if (!tips) {
    return {
      laneColor: undefined,
      visibleLocalTips: [],
      visibleRemoteTips: [],
      visibleTags: [],
    };
  }
  const sortedNames = layout.branchNamesSorted;
  const tipsHereNames = [...tips.locals.map((b) => b.name), ...tips.remotes.map((r) => r.name)];
  const firstTipName = sortedNames.find((n) => tipsHereNames.includes(n));
  const laneIdx = firstTipName ? sortedNames.indexOf(firstTipName) : -1;
  const laneColor =
    laneIdx >= 0 ? layout.laneColors[laneIdx % layout.laneColors.length] : undefined;
  return {
    laneColor,
    visibleLocalTips: tips.locals,
    visibleRemoteTips: tips.remotes,
    visibleTags: tips.tagTips,
  };
}

type VirtualRowProps = {
  c: CommitEntry;
  idx: number;
  commitsLength: number;
  graphWidthPx: number;
  laneMeta: RowLaneMeta;
  commitBrowseHash: string | null;
  graphFocusHash: string | null;
  currentBranchTipHash: string | null;
  currentBranchName: string | null;
  branchBusy: string | null;
  pushBusy: boolean;
  stashBusy: string | null;
  commitsSectionTitle: string;
  onRowCommitSelect: (hash: string) => void;
  openGraphBranchLocalMenu: (branchName: string, clientX: number, clientY: number) => void;
  openGraphBranchRemoteMenu: (fullRef: string, clientX: number, clientY: number) => void;
  openGraphStashMenu: (stashRef: string, clientX: number, clientY: number) => void;
  openGraphCommitMenu: (hash: string, clientX: number, clientY: number) => void;
  openGraphTagMenu: (tagName: string, clientX: number, clientY: number) => void;
};

const CommitGraphVirtualRow = memo(function CommitGraphVirtualRow({
  c,
  idx,
  commitsLength,
  graphWidthPx,
  laneMeta,
  commitBrowseHash,
  graphFocusHash,
  currentBranchTipHash,
  currentBranchName,
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
          className="max-w-full min-w-0 cursor-context-menu truncate font-medium"
          onContextMenu={(e) => {
            if (branchBusy) return;
            if (!nativeContextMenusAvailable()) return;
            e.preventDefault();
            e.stopPropagation();
            openGraphBranchLocalMenu(b.name, e.clientX, e.clientY);
          }}
        >
          {b.name}
        </span>
      ))}
      {visibleLocalTips.length > 0 && visibleRemoteTips.length > 0 ? (
        <span className="shrink-0 text-[0.55rem] text-base-content/45" aria-hidden>
          ·
        </span>
      ) : null}
      {visibleRemoteTips.map((r) => (
        <span
          key={`r:${r.name}`}
          className="max-w-full min-w-0 cursor-context-menu truncate font-medium text-secondary"
          onContextMenu={(e) => {
            if (branchBusy) return;
            if (!nativeContextMenusAvailable()) return;
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
        if (!nativeContextMenusAvailable()) return;
        e.preventDefault();
        e.stopPropagation();
        openGraphStashMenu(stashRef, e.clientX, e.clientY);
      }}
    >
      <span className="badge shrink-0 font-mono badge-xs badge-warning">{stashRef}</span>
    </span>
  ) : idx === 0 ? (
    <span
      className="flex min-w-0 cursor-context-menu items-center gap-0.5 truncate text-[0.65rem] leading-tight text-base-content/85"
      title={commitsSectionTitle}
      onContextMenu={(e) => {
        if (branchBusy || !currentBranchName) return;
        if (!nativeContextMenusAvailable()) return;
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

  return (
    <>
      <div
        className={`flex min-h-0 min-w-0 shrink-0 items-center px-0.5 ${rowRule} ${
          isHeadBranchTipRow ? "bg-primary/12" : ""
        }`}
        style={{ width: BRANCH_COL, maxWidth: BRANCH_COL }}
      >
        {branchCell}
      </div>
      <div className="shrink-0" style={{ width: graphWidthPx }} aria-hidden />
      <button
        type="button"
        title={fullTitle}
        className={`grid h-full min-h-0 min-w-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(0,6.5rem)_minmax(0,3.25rem)] items-center gap-x-1.5 px-1 text-left text-[0.6875rem] leading-tight transition-colors ${rowRule} ${
          isBrowsing
            ? "bg-primary/20 ring-1 ring-primary/35 ring-inset"
            : isGraphFocus
              ? "bg-accent/15 ring-1 ring-accent/30 ring-inset"
              : isHeadBranchTipRow
                ? "bg-primary/12 hover:bg-primary/26 hover:ring-1 hover:ring-primary/20 hover:ring-inset"
                : "hover:bg-base-300/70 hover:ring-1 hover:ring-base-content/10 hover:ring-inset"
        }`}
        onClick={() => {
          onRowCommitSelect(c.hash);
        }}
        onContextMenu={(e) => {
          if (!nativeContextMenusAvailable()) return;
          e.preventDefault();
          e.stopPropagation();
          openGraphCommitMenu(c.hash, e.clientX, e.clientY);
        }}
      >
        <span className="flex min-w-0 items-center gap-x-1.5">
          <span className="min-w-0 flex-1 truncate text-base-content/90">{c.subject}</span>
          {visibleTags.length > 0 ? (
            <span className="flex shrink-0 items-center gap-1">
              {visibleTags.map((t) => (
                <span
                  key={`tag:${t.name}`}
                  className="badge inline-flex max-w-28 min-w-0 shrink-0 cursor-context-menu truncate badge-ghost font-mono badge-xs text-[0.6rem] text-accent"
                  title={t.name}
                  onContextMenu={(e) => {
                    if (branchBusy || pushBusy) return;
                    if (!nativeContextMenusAvailable()) return;
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

export function CommitGraphSection({
  commits,
  commitGraphLayout,
  localBranches,
  remoteBranches,
  tags,
  graphBranchVisible,
  currentBranchName,
  currentBranchTipHash,
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
  graphFiltersActive,
  onClearGraphFilters,
  onExportGraphCommits,
  exportGraphCommitsDisabled,
  wipChangedFileCount,
  onWipSelect,
}: CommitGraphSectionProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const authorFilterWrapRef = useRef<HTMLDivElement>(null);
  const whenFilterWrapRef = useRef<HTMLDivElement>(null);
  const [authorFilterOpen, setAuthorFilterOpen] = useState(false);
  const [whenFilterOpen, setWhenFilterOpen] = useState(false);

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

  const tipsByHash = useMemo(
    () => buildTipsByHash(localBranches, remoteBranches, tags, graphBranchVisible),
    [localBranches, remoteBranches, tags, graphBranchVisible],
  );

  const rowLaneMetas = useMemo(() => {
    return commits.map((c) => computeRowLaneMeta(commitGraphLayout, tipsByHash.get(c.hash)));
  }, [commits, commitGraphLayout, tipsByHash]);

  const showWipRow = wipChangedFileCount > 0;
  const wipOffset = showWipRow ? 1 : 0;
  const virtualRowCount = commits.length + wipOffset;

  const rowVirtualizer = useVirtualizer({
    count: virtualRowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => COMMIT_GRAPH_ROW_HEIGHT,
    overscan: VIRTUAL_OVERSCAN,
  });

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

  const loadMoreFooter = graphCommitsHasMore ? (
    <div className="mt-2 flex justify-center border-t border-base-300/50 pt-2">
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
    </div>
  ) : null;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
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
            className="dropdown-content z-100 mt-0 w-64 max-w-[min(100vw-2rem,18rem)] rounded-box border border-base-300 bg-base-100 p-3 shadow-lg"
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
            className="dropdown-content dropdown-end z-100 mt-0 w-64 max-w-[min(100vw-2rem,18rem)] rounded-box border border-base-300 bg-base-100 p-3 shadow-lg"
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
            <button
              type="button"
              className="btn mt-3 w-full btn-outline btn-xs"
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
      <div ref={scrollRef} className="min-h-0 min-w-0 flex-1 overflow-x-auto overflow-y-auto">
        {commits.length === 0 && !showWipRow ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex min-h-40 flex-1 flex-col items-center justify-center px-3 py-8">
              <p className="m-0 max-w-md text-center text-xs text-base-content/60">
                {emptyMessage}
              </p>
            </div>
            {loadMoreFooter}
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
                  return (
                    <div
                      key={`graph-bg-${c.hash}`}
                      className={`absolute right-0 left-0 z-0 ${
                        currentBranchTipHash === c.hash ? "bg-primary/12" : ""
                      }`}
                      style={{ top: v.start, height: v.size }}
                      aria-hidden
                    />
                  );
                })}
                <div className="relative z-1">
                  <CommitGraphColumn
                    layout={commitGraphLayout}
                    commitCount={commits.length}
                    wipRowAbove={showWipRow}
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
                      if (!nativeContextMenusAvailable()) return;
                      e.preventDefault();
                      e.stopPropagation();
                      openGraphCommitMenu(c.hash, e.clientX, e.clientY);
                    }}
                  />
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
                      onClick={wipInteractive ? () => onWipSelect() : undefined}
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
                      commitBrowseHash={commitBrowseHash}
                      graphFocusHash={graphFocusHash}
                      currentBranchTipHash={currentBranchTipHash}
                      currentBranchName={currentBranchName}
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
                    />
                  </div>
                );
              })}
            </div>
            {loadMoreFooter}
          </>
        )}
      </div>
    </div>
  );
}
