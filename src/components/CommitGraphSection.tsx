import { useVirtualizer } from "@tanstack/react-virtual";
import { memo, useMemo, useRef } from "react";
import { formatAuthorDisplay, formatDate, formatRelativeShort } from "../appFormat";
import { CommitGraphColumn } from "./CommitGraphColumn";
import { COMMIT_GRAPH_ROW_HEIGHT, type CommitGraphLayout } from "../commitGraphLayout";
import { nativeContextMenusAvailable } from "../nativeContextMenu";
import type { CommitEntry, LocalBranchEntry, RemoteBranchEntry } from "../repoTypes";

const GRAPH_GAP_PX = 6;
const BRANCH_COL = "6.75rem";

export interface CommitGraphSectionProps {
  commits: CommitEntry[];
  commitGraphLayout: CommitGraphLayout;
  localBranches: LocalBranchEntry[];
  remoteBranches: RemoteBranchEntry[];
  graphBranchVisible: Record<string, boolean>;
  currentBranchName: string | null;
  currentBranchTipHash: string | null;
  commitBrowseHash: string | null;
  branchBusy: string | null;
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
}

type TipsAtHash = { locals: LocalBranchEntry[]; remotes: RemoteBranchEntry[] };

function buildTipsByHash(
  localBranches: LocalBranchEntry[],
  remoteBranches: RemoteBranchEntry[],
  graphBranchVisible: Record<string, boolean>,
): Map<string, TipsAtHash> {
  const map = new Map<string, TipsAtHash>();
  for (const b of localBranches) {
    if (graphBranchVisible[`local:${b.name}`] === false) continue;
    let e = map.get(b.tipHash);
    if (!e) {
      e = { locals: [], remotes: [] };
      map.set(b.tipHash, e);
    }
    e.locals.push(b);
  }
  for (const r of remoteBranches) {
    if (graphBranchVisible[`remote:${r.name}`] === false) continue;
    let e = map.get(r.tipHash);
    if (!e) {
      e = { locals: [], remotes: [] };
      map.set(r.tipHash, e);
    }
    e.remotes.push(r);
  }
  return map;
}

type RowLaneMeta = {
  laneColor: string | undefined;
  visibleLocalTips: LocalBranchEntry[];
  visibleRemoteTips: RemoteBranchEntry[];
};

function computeRowLaneMeta(layout: CommitGraphLayout, tips: TipsAtHash | undefined): RowLaneMeta {
  if (!tips) {
    return { laneColor: undefined, visibleLocalTips: [], visibleRemoteTips: [] };
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
  };
}

type VirtualRowProps = {
  c: CommitEntry;
  idx: number;
  commitsLength: number;
  graphWidthPx: number;
  laneMeta: RowLaneMeta;
  commitBrowseHash: string | null;
  currentBranchTipHash: string | null;
  currentBranchName: string | null;
  branchBusy: string | null;
  stashBusy: string | null;
  commitsSectionTitle: string;
  onRowCommitSelect: (hash: string) => void;
  openGraphBranchLocalMenu: (branchName: string, clientX: number, clientY: number) => void;
  openGraphBranchRemoteMenu: (fullRef: string, clientX: number, clientY: number) => void;
  openGraphStashMenu: (stashRef: string, clientX: number, clientY: number) => void;
  openGraphCommitMenu: (hash: string, clientX: number, clientY: number) => void;
};

const CommitGraphVirtualRow = memo(function CommitGraphVirtualRow({
  c,
  idx,
  commitsLength,
  graphWidthPx,
  laneMeta,
  commitBrowseHash,
  currentBranchTipHash,
  currentBranchName,
  branchBusy,
  stashBusy,
  commitsSectionTitle,
  onRowCommitSelect,
  openGraphBranchLocalMenu,
  openGraphBranchRemoteMenu,
  openGraphStashMenu,
  openGraphCommitMenu,
}: VirtualRowProps) {
  const stashRef = c.stashRef?.trim() || null;
  const { laneColor, visibleLocalTips, visibleRemoteTips } = laneMeta;
  const tipsHereNames = [
    ...visibleLocalTips.map((b) => b.name),
    ...visibleRemoteTips.map((r) => r.name),
  ];
  const hasBranchTips = visibleLocalTips.length > 0 || visibleRemoteTips.length > 0;

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
  const isHeadBranchTipRow = currentBranchTipHash !== null && c.hash === currentBranchTipHash;
  const rel = formatRelativeShort(c.date);
  const fullTitle = [
    stashRef ? `${stashRef} — ${c.shortHash} — ${c.subject}` : `${c.shortHash} — ${c.subject}`,
    c.author,
    formatDate(c.date) ?? undefined,
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
            : isHeadBranchTipRow
              ? "bg-primary/12 hover:bg-primary/18"
              : "hover:bg-base-300/40"
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
        <span className="min-w-0 truncate text-base-content/90">{c.subject}</span>
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

export function CommitGraphSection({
  commits,
  commitGraphLayout,
  localBranches,
  remoteBranches,
  graphBranchVisible,
  currentBranchName,
  currentBranchTipHash,
  commitBrowseHash,
  branchBusy,
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
}: CommitGraphSectionProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  const tipsByHash = useMemo(
    () => buildTipsByHash(localBranches, remoteBranches, graphBranchVisible),
    [localBranches, remoteBranches, graphBranchVisible],
  );

  const rowLaneMetas = useMemo(() => {
    return commits.map((c) => computeRowLaneMeta(commitGraphLayout, tipsByHash.get(c.hash)));
  }, [commits, commitGraphLayout, tipsByHash]);

  const rowVirtualizer = useVirtualizer({
    count: commits.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => COMMIT_GRAPH_ROW_HEIGHT,
    overscan: VIRTUAL_OVERSCAN,
  });

  const totalHeight = rowVirtualizer.getTotalSize();
  const graphWidthPx = commitGraphLayout.graphWidthPx;
  const gridTemplateColumns = `minmax(0, ${BRANCH_COL}) ${graphWidthPx}px minmax(0, 1fr) minmax(0, 6.5rem) minmax(0, 3.25rem)`;

  if (commits.length === 0) {
    return (
      <p className="m-0 flex flex-1 items-center justify-center px-3 text-center text-xs text-base-content/60">
        {emptyMessage}
      </p>
    );
  }

  const graphLeft = `calc(${BRANCH_COL} + ${GRAPH_GAP_PX}px)`;
  const virtualRows = rowVirtualizer.getVirtualItems();

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <h2 className="m-0 mb-1.5 flex shrink-0 flex-wrap items-baseline gap-x-2 gap-y-0 border-b border-base-300 px-3 pt-2 pb-1.5 text-[0.65rem] font-semibold tracking-wide text-base-content/50 uppercase">
        <span>Commits</span>
        <span className="font-mono text-[0.6rem] font-normal tracking-normal text-base-content/55 normal-case">
          {commits.length}
          {graphCommitsHasMore ? "+" : ""}
        </span>
      </h2>
      <div
        className="sticky top-0 z-10 mb-0.5 grid shrink-0 items-center gap-x-1.5 border-b border-base-300/80 bg-base-100 pb-0.5 text-[0.6rem] font-semibold tracking-wide text-base-content/45 uppercase"
        style={{ gridTemplateColumns }}
      >
        <span className="truncate pl-3">Branch</span>
        <span className="min-w-0 truncate">Graph</span>
        <span className="min-w-0 truncate">Commit message</span>
        <span className="min-w-0 truncate">Author</span>
        <span className="pr-3 text-right">When</span>
      </div>
      <div ref={scrollRef} className="min-h-0 min-w-0 flex-1 overflow-x-auto overflow-y-auto">
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
              const c = commits[v.index];
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
            <div className="relative z-[1]">
              <CommitGraphColumn layout={commitGraphLayout} commitCount={commits.length} />
            </div>
          </div>
          {virtualRows.map((v) => {
            const c = commits[v.index];
            return (
              <div
                key={`graph-ctx-${c.hash}`}
                role="presentation"
                className="absolute z-[2] cursor-context-menu"
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
            const idx = v.index;
            const c = commits[idx];
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
                  idx={idx}
                  commitsLength={commits.length}
                  graphWidthPx={graphWidthPx}
                  laneMeta={rowLaneMetas[idx]}
                  commitBrowseHash={commitBrowseHash}
                  currentBranchTipHash={currentBranchTipHash}
                  currentBranchName={currentBranchName}
                  branchBusy={branchBusy}
                  stashBusy={stashBusy}
                  commitsSectionTitle={commitsSectionTitle}
                  onRowCommitSelect={onRowCommitSelect}
                  openGraphBranchLocalMenu={openGraphBranchLocalMenu}
                  openGraphBranchRemoteMenu={openGraphBranchRemoteMenu}
                  openGraphStashMenu={openGraphStashMenu}
                  openGraphCommitMenu={openGraphCommitMenu}
                />
              </div>
            );
          })}
        </div>
        {graphCommitsHasMore ? (
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
        ) : null}
      </div>
    </div>
  );
}
