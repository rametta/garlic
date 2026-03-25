/** Layout constants for the commit DAG column (GitKraken-style lanes). */

export const COMMIT_GRAPH_ROW_HEIGHT = 28;
export const COMMIT_GRAPH_LANE_WIDTH = 14;
export const COMMIT_GRAPH_PAD_X = 6;

export interface CommitGraphCommit {
  hash: string;
  parentHashes: string[];
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
  /** Local branch names (sorted) for labels; not 1:1 with lane indices when lanes > branches. */
  branchNamesSorted: string[];
  /** Stroke color per lane index. */
  laneColors: string[];
  /** SVG path `d` for each edge (parent is older = lower on screen = larger row index). */
  edgePaths: { d: string; color: string }[];
}

function branchLaneHue(index: number): string {
  const h = (index * 47 + 200) % 360;
  return `hsl(${h} 58% 52%)`;
}

/**
 * Assign a lane index to each commit from the DAG only (forks open new columns to the right;
 * merges connect lanes; first parent is the mainline through a merge).
 *
 * `commits` must be topo-ordered newest-first (row 0 = newest).
 */
function assignLanesFromDag(commits: CommitGraphCommit[]): Map<string, number> {
  const hashSet = new Set(commits.map((c) => c.hash));
  const indexByHash = new Map(commits.map((c, i) => [c.hash, i] as const));

  const children = new Map<string, string[]>();
  for (const c of commits) {
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

  // Oldest sibling first (larger row index in newest-first list) continues the parent's lane.
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

    // Merge commit (2+ parents in Git): lane follows first parent that appears in this window.
    if (c.parentHashes.length >= 2) {
      const firstParentInGraph = c.parentHashes.find((p) => hashSet.has(p));
      if (firstParentInGraph !== undefined) {
        laneByHash.set(c.hash, laneByHash.get(firstParentInGraph) ?? 0);
      } else {
        laneByHash.set(c.hash, 0);
      }
      continue;
    }

    // Single parent: fork if this is not the oldest child of that parent (side-by-side rails).
    const p = parentsInGraph[0];
    const laneP = laneByHash.get(p) ?? 0;
    const sibs = children.get(p) ?? [];
    const continuesParentLane = sibs.length === 0 || sibs[0] === c.hash;
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
    for (const ph of c.parentHashes) {
      const j = indexByHash.get(ph);
      if (j === undefined || j <= i) continue; // parent must be older (lower in list)
      const mid = Math.floor((i + j) / 2);
      const li = logicalLanes[i] ?? 0;
      const lj = logicalLanes[j] ?? 0;
      extend(li, i, mid);
      extend(lj, mid, j);
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
  _currentBranchName: string | null,
): CommitGraphLayout {
  const branchNamesSorted = [...new Set(tips.map((t) => t.name))].sort((a, b) =>
    a.localeCompare(b),
  );

  const laneByHash = commits.length === 0 ? new Map<string, number>() : assignLanesFromDag(commits);

  const logicalLanes: number[] = commits.map((c) => laneByHash.get(c.hash) ?? 0);
  const indexByHash = new Map(commits.map((c, i) => [c.hash, i] as const));

  const intervals =
    commits.length === 0
      ? new Map<number, { min: number; max: number }>()
      : logicalLaneRowIntervals(commits, logicalLanes, indexByHash);

  const { compact: lanes, columnCount } = compactLogicalLanes(logicalLanes, intervals);
  const laneCount = columnCount;

  const laneColors = Array.from({ length: laneCount }, (_, i) => branchLaneHue(i));

  const rowH = COMMIT_GRAPH_ROW_HEIGHT;
  const laneW = COMMIT_GRAPH_LANE_WIDTH;
  const pad = COMMIT_GRAPH_PAD_X;
  const graphWidthPx = pad * 2 + laneCount * laneW;

  const cx = (lane: number) => pad + lane * laneW + laneW / 2;
  const cy = (row: number) => row * rowH + rowH / 2;

  const edgePaths: { d: string; color: string }[] = [];

  for (let i = 0; i < commits.length; i++) {
    const c = commits[i];
    const y1 = cy(i);
    const x1 = cx(lanes[i] ?? 0);
    let pi = 0;
    for (const p of c.parentHashes) {
      const j = indexByHash.get(p);
      if (j === undefined || j <= i) continue;
      const y2 = cy(j);
      const x2 = cx(lanes[j] ?? 0);
      const yMid = (y1 + y2) / 2;
      const d = `M ${x1} ${y1} L ${x1} ${yMid} L ${x2} ${yMid} L ${x2} ${y2}`;
      const color =
        pi === 0
          ? laneColors[(lanes[i] ?? 0) % laneColors.length]
          : laneColors[(lanes[j] ?? 0) % laneColors.length];
      edgePaths.push({ d, color });
      pi += 1;
    }
  }

  return {
    laneCount,
    graphWidthPx,
    lanes,
    branchNamesSorted,
    laneColors,
    edgePaths,
  };
}
