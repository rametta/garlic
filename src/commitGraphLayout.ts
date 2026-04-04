/** Layout constants for the commit DAG column. */

export const COMMIT_GRAPH_ROW_HEIGHT = 28;

/** Default commit subject font size in the main graph (px); matches previous `text-[0.6875rem]` at 16px root. */
export const DEFAULT_GRAPH_COMMIT_TITLE_FONT_SIZE_PX = 11;
export const GRAPH_COMMIT_TITLE_FONT_SIZE_MIN = 9;
export const GRAPH_COMMIT_TITLE_FONT_SIZE_MAX = 20;

export function clampGraphCommitTitleFontSizePx(px: number): number {
  const n = Math.round(px);
  return Math.min(GRAPH_COMMIT_TITLE_FONT_SIZE_MAX, Math.max(GRAPH_COMMIT_TITLE_FONT_SIZE_MIN, n));
}

/** Row height for the virtualized graph from the commit-title font size (keeps density similar to the default). */
export function commitGraphRowHeightPx(titleFontSizePx: number): number {
  const fs = clampGraphCommitTitleFontSizePx(titleFontSizePx);
  return Math.min(
    44,
    Math.max(
      24,
      Math.round((fs * COMMIT_GRAPH_ROW_HEIGHT) / DEFAULT_GRAPH_COMMIT_TITLE_FONT_SIZE_PX),
    ),
  );
}
export const COMMIT_GRAPH_LANE_WIDTH = 14;
export const COMMIT_GRAPH_PAD_X = 6;

export interface CommitGraphCommit {
  hash: string;
  parentHashes: string[];
  stashRef?: string | null;
}

export interface BranchTip {
  name: string;
  tipHash: string;
}

export interface CommitGraphLayout {
  laneCount: number;
  graphWidthPx: number;
  /** Lane index per row (same order as `commits`, newest first). */
  lanes: number[];
  /** Stroke/fill color per row's logical branch segment (same order as `commits`). */
  rowColors: string[];
  /** True for rows that render a stash WIP commit (`stash@{n}`). */
  stashRows: boolean[];
  /** Local branch names (sorted) for labels; not 1:1 with lane indices when lanes > branches. */
  branchNamesSorted: string[];
  /** Stroke color per lane index. */
  laneColors: string[];
  /** SVG path `d` for each edge (parent is older = lower on screen = larger row index). */
  edgePaths: {
    d: string;
    color: string;
    fromHash: string;
    toHash: string;
    firstParent: boolean;
    dashed?: boolean;
  }[];
}

function branchLaneHue(index: number): string {
  const h = (index * 47 + 200) % 360;
  return `hsl(${h} 58% 52%)`;
}

/**
 * Prefer `main` / `master` so the trunk stays left, not the oldest sibling at a fork.
 */
function pickMainlineTipHash(tips: BranchTip[], currentBranchName: string | null): string | null {
  if (tips.length === 0) return null;
  const byName = new Map(tips.map((t) => [t.name, t.tipHash] as const));

  for (const name of ["main", "master", "trunk"]) {
    const h = byName.get(name);
    if (h !== undefined) return h;
  }
  for (const name of ["origin/main", "origin/master"]) {
    const h = byName.get(name);
    if (h !== undefined) return h;
  }

  if (currentBranchName) {
    const h = byName.get(currentBranchName);
    if (h !== undefined) return h;
  }

  const locals = tips.filter((t) => !t.name.includes("/"));
  if (locals.length > 0) {
    locals.sort((a, b) => a.name.localeCompare(b.name));
    return locals[0].tipHash;
  }

  const sorted = [...tips].sort((a, b) => a.name.localeCompare(b.name));
  return sorted[0].tipHash;
}

/** First-parent chain from a branch tip (Git mainline through merges). */
function buildMainlineHashes(
  commits: CommitGraphCommit[],
  hashSet: Set<string>,
  tipHash: string | null,
): Set<string> {
  const mainline = new Set<string>();
  if (tipHash === null || !hashSet.has(tipHash)) {
    return mainline;
  }
  const byHash = new Map(commits.map((c) => [c.hash, c] as const));
  let h: string | undefined = tipHash;
  while (h !== undefined && hashSet.has(h)) {
    mainline.add(h);
    const c = byHash.get(h);
    if (!c || c.parentHashes.length === 0) break;
    const fp = c.parentHashes[0];
    if (hashSet.has(fp)) {
      h = fp;
    } else {
      const fpInGraph = c.parentHashes.find((p) => hashSet.has(p));
      if (fpInGraph === undefined) break;
      h = fpInGraph;
    }
  }
  return mainline;
}

/**
 * Assign a lane index to each commit from the DAG only (forks open new columns to the right;
 * merges connect lanes; first parent is the mainline through a merge).
 *
 * `commits` must be git-log–ordered newest-first (e.g. `--date-order`; row 0 = newest).
 * `mainlineHashes`: commits on the first-parent path from the chosen trunk tip (`main`), so that
 * path keeps lane 0 instead of the oldest sibling at each fork.
 */
function assignLanesFromDag(
  commits: CommitGraphCommit[],
  mainlineHashes: Set<string>,
): Map<string, number> {
  const hashSet = new Set(commits.map((c) => c.hash));
  const indexByHash = new Map(commits.map((c, i) => [c.hash, i] as const));
  const isStashCommit = (c: CommitGraphCommit) => Boolean(c.stashRef?.trim());

  const children = new Map<string, string[]>();
  for (const c of commits) {
    if (isStashCommit(c)) continue;
    for (const p of c.parentHashes) {
      if (!hashSet.has(p)) continue;
      let list = children.get(p);
      if (!list) {
        list = [];
        children.set(p, list);
      }
      list.push(c.hash);
    }
  }

  // Oldest sibling first (larger row index in newest-first list) — fallback when no mainline.
  for (const list of children.values()) {
    list.sort((a, b) => (indexByHash.get(b) ?? 0) - (indexByHash.get(a) ?? 0));
  }

  const laneByHash = new Map<string, number>();
  let nextLane = 1;

  for (let k = commits.length - 1; k >= 0; k--) {
    const c = commits[k];
    const parentsInGraph = c.parentHashes.filter((p) => hashSet.has(p));

    if (parentsInGraph.length === 0) {
      laneByHash.set(c.hash, 0);
      continue;
    }

    // Stashes should read like detached side markers, not branch-mainline history.
    if (isStashCommit(c)) {
      laneByHash.set(c.hash, nextLane);
      nextLane += 1;
      continue;
    }

    // Merge commit (2+ parents in Git): lane follows first parent in this window.
    if (c.parentHashes.length >= 2) {
      const fp = c.parentHashes[0];
      const firstParentInGraph = hashSet.has(fp) ? fp : c.parentHashes.find((p) => hashSet.has(p));
      if (firstParentInGraph !== undefined) {
        laneByHash.set(c.hash, laneByHash.get(firstParentInGraph) ?? 0);
      } else {
        laneByHash.set(c.hash, 0);
      }
      continue;
    }

    // Single parent: fork if this is not the child that continues the parent's lane.
    const p = parentsInGraph[0];
    const laneP = laneByHash.get(p) ?? 0;
    const sibs = children.get(p) ?? [];
    const mainlineChild = sibs.find((h) => mainlineHashes.has(h));
    const continuesParentLane =
      sibs.length === 0 ||
      (mainlineHashes.size > 0 && mainlineChild !== undefined
        ? c.hash === mainlineChild
        : sibs[0] === c.hash);
    if (continuesParentLane) {
      laneByHash.set(c.hash, laneP);
    } else {
      laneByHash.set(c.hash, nextLane);
      nextLane += 1;
    }
  }

  return laneByHash;
}

/** Row span [min, max] inclusive where a logical lane draws a node or vertical segment. */
function logicalLaneRowIntervals(
  commits: CommitGraphCommit[],
  logicalLanes: number[],
  indexByHash: Map<string, number>,
): Map<number, { min: number; max: number }> {
  const intervals = new Map<number, { min: number; max: number }>();

  const extend = (L: number, r0: number, r1: number) => {
    const lo = Math.min(r0, r1);
    const hi = Math.max(r0, r1);
    const cur = intervals.get(L);
    if (!cur) {
      intervals.set(L, { min: lo, max: hi });
    } else {
      cur.min = Math.min(cur.min, lo);
      cur.max = Math.max(cur.max, hi);
    }
  };

  for (let i = 0; i < commits.length; i++) {
    extend(logicalLanes[i] ?? 0, i, i);
  }

  for (let i = 0; i < commits.length; i++) {
    const c = commits[i];
    for (let pi = 0; pi < c.parentHashes.length; pi++) {
      const ph = c.parentHashes[pi];
      const j = indexByHash.get(ph);
      if (j === undefined || j <= i) continue; // parent must be older (lower in list)
      const li = logicalLanes[i] ?? 0;
      const lj = logicalLanes[j] ?? 0;
      if (li === lj) {
        extend(li, i, j);
        continue;
      }
      if (pi === 0) {
        const childSpanEnd = Math.max(i, j - 1);
        extend(li, i, childSpanEnd);
        extend(lj, childSpanEnd, j);
      } else {
        const parentSpanStart = Math.min(j, i + 1);
        extend(li, i, parentSpanStart);
        extend(lj, parentSpanStart, j);
      }
    }
  }

  return intervals;
}

function intervalsOverlap(
  a: { min: number; max: number },
  b: { min: number; max: number },
): boolean {
  return a.min <= b.max && b.min <= a.max;
}

/**
 * Map logical lane ids (possibly many) to compact column indices so lanes whose row spans
 * do not overlap can share the same horizontal column (reuse rails).
 */
function compactLogicalLanes(
  logicalLanes: number[],
  intervals: Map<number, { min: number; max: number }>,
): { compact: number[]; columnCount: number } {
  const n = logicalLanes.length;
  if (n === 0) {
    return { compact: [], columnCount: 1 };
  }

  const sortedByStart = [...new Set(logicalLanes)].sort((a, b) => {
    const ia = intervals.get(a) ?? { min: 0, max: 0 };
    const ib = intervals.get(b) ?? { min: 0, max: 0 };
    if (ia.min !== ib.min) return ia.min - ib.min;
    return ia.max - ib.max;
  });

  const logicalToCompact = new Map<number, number>();
  const columns: { min: number; max: number }[][] = [];

  for (const L of sortedByStart) {
    const span = intervals.get(L) ?? { min: 0, max: 0 };
    let placed = false;
    for (let c = 0; c < columns.length; c++) {
      const col = columns[c];
      if (col === undefined) continue;
      const clashes = col.some((s) => intervalsOverlap(s, span));
      if (!clashes) {
        col.push(span);
        logicalToCompact.set(L, c);
        placed = true;
        break;
      }
    }
    if (!placed) {
      const c = columns.length;
      columns.push([span]);
      logicalToCompact.set(L, c);
    }
  }

  const columnCount = Math.max(1, columns.length);
  const compact = logicalLanes.map((L) => logicalToCompact.get(L) ?? 0);

  return { compact, columnCount };
}

export function computeCommitGraphLayout(
  commits: CommitGraphCommit[],
  tips: BranchTip[],
  currentBranchName: string | null,
  rowHeightPx: number = COMMIT_GRAPH_ROW_HEIGHT,
): CommitGraphLayout {
  const branchNamesSorted = [...new Set(tips.map((t) => t.name))].sort((a, b) =>
    a.localeCompare(b),
  );

  const hashSet = new Set(commits.map((c) => c.hash));
  const mainlineTip = pickMainlineTipHash(tips, currentBranchName);
  const mainlineHashes = buildMainlineHashes(commits, hashSet, mainlineTip);

  const laneByHash =
    commits.length === 0 ? new Map<string, number>() : assignLanesFromDag(commits, mainlineHashes);

  const logicalLanes: number[] = commits.map((c) => laneByHash.get(c.hash) ?? 0);
  const logicalLaneCount =
    logicalLanes.length > 0 ? Math.max(...logicalLanes.map((lane) => lane + 1)) : 1;
  const logicalLaneColors = Array.from({ length: logicalLaneCount }, (_, i) => branchLaneHue(i));
  const rowColors = logicalLanes.map(
    (lane) => logicalLaneColors[lane % logicalLaneColors.length] ?? branchLaneHue(0),
  );
  const stashRows = commits.map((c) => Boolean(c.stashRef?.trim()));
  const indexByHash = new Map(commits.map((c, i) => [c.hash, i] as const));

  const intervals =
    commits.length === 0
      ? new Map<number, { min: number; max: number }>()
      : logicalLaneRowIntervals(commits, logicalLanes, indexByHash);

  const { compact: lanes, columnCount } = compactLogicalLanes(logicalLanes, intervals);
  const laneCount = columnCount;

  const laneColors = Array.from({ length: laneCount }, (_, i) => branchLaneHue(i));

  const rowH = rowHeightPx;
  const laneW = COMMIT_GRAPH_LANE_WIDTH;
  const pad = COMMIT_GRAPH_PAD_X;
  const graphWidthPx = pad * 2 + laneCount * laneW;

  const cx = (lane: number) => pad + lane * laneW + laneW / 2;
  const cy = (row: number) => row * rowH + rowH / 2;
  const rowTop = (row: number) => row * rowH;
  const rowBottom = (row: number) => (row + 1) * rowH;

  const edgePaths: CommitGraphLayout["edgePaths"] = [];

  for (let i = 0; i < commits.length; i++) {
    const c = commits[i];
    const y1 = cy(i);
    const x1 = cx(lanes[i] ?? 0);
    const rowColor = rowColors[i] ?? laneColors[(lanes[i] ?? 0) % laneColors.length];
    let pi = 0;
    for (const p of c.parentHashes) {
      const j = indexByHash.get(p);
      if (j === undefined || j <= i) continue;
      const y2 = cy(j);
      const x2 = cx(lanes[j] ?? 0);
      const parentRowColor = rowColors[j] ?? laneColors[(lanes[j] ?? 0) % laneColors.length];
      const isFirstParent = pi === 0;
      const sameLane = x1 === x2;
      const yJoin = sameLane ? y2 : isFirstParent ? rowTop(j) : rowBottom(i);
      const d = sameLane
        ? `M ${x1} ${y1} L ${x2} ${y2}`
        : `M ${x1} ${y1} L ${x1} ${yJoin} L ${x2} ${yJoin} L ${x2} ${y2}`;
      const color = pi === 0 ? rowColor : parentRowColor;
      edgePaths.push({
        d,
        color,
        fromHash: c.hash,
        toHash: p,
        firstParent: isFirstParent,
        dashed: stashRows[i],
      });
      pi += 1;
    }
  }

  return {
    laneCount,
    graphWidthPx,
    lanes,
    rowColors,
    stashRows,
    branchNamesSorted,
    laneColors,
    edgePaths,
  };
}
