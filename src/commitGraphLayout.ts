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
  /** Lane index per row (same order as `commits`). */
  lanes: number[];
  /** Sorted branch names used as lanes (same order as lane indices). */
  branchNamesSorted: string[];
  /** Stroke color per lane index. */
  laneColors: string[];
  /** SVG path `d` for each edge (parent below child in list). */
  edgePaths: { d: string; color: string }[];
}

function branchLaneHue(index: number): string {
  const h = (index * 47 + 200) % 360;
  return `hsl(${h} 58% 52%)`;
}

/** Walk parents from each branch tip to mark which branches contain each commit in the loaded window. */
function branchNamesByCommit(
  commits: CommitGraphCommit[],
  tips: BranchTip[],
): Map<string, string[]> {
  const hashSet = new Set(commits.map((c) => c.hash));
  const byHash = new Map(commits.map((c) => [c.hash, c] as const));
  const branchByCommit = new Map<string, string[]>();

  const sortedTips = [...tips].sort((a, b) => a.name.localeCompare(b.name));

  for (const tip of sortedTips) {
    if (!hashSet.has(tip.tipHash)) continue;
    const stack = [tip.tipHash];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const h = stack.pop()!;
      if (seen.has(h)) continue;
      seen.add(h);
      if (!hashSet.has(h)) continue;
      const cur = branchByCommit.get(h) ?? [];
      if (!cur.includes(tip.name)) {
        cur.push(tip.name);
        cur.sort((a, b) => a.localeCompare(b));
        branchByCommit.set(h, cur);
      }
      const c = byHash.get(h);
      if (!c) continue;
      for (const p of c.parentHashes) {
        if (hashSet.has(p)) stack.push(p);
      }
    }
  }

  return branchByCommit;
}

function primaryBranchName(branches: string[], currentBranchName: string | null): string | null {
  if (branches.length === 0) return null;
  if (currentBranchName && branches.includes(currentBranchName)) {
    return currentBranchName;
  }
  return branches[0] ?? null;
}

export function computeCommitGraphLayout(
  commits: CommitGraphCommit[],
  tips: BranchTip[],
  currentBranchName: string | null,
): CommitGraphLayout {
  const branchNamesSorted = [...new Set(tips.map((t) => t.name))].sort((a, b) =>
    a.localeCompare(b),
  );
  const laneCount = Math.max(1, branchNamesSorted.length);
  const branchToLane = new Map<string, number>();
  branchNamesSorted.forEach((n, i) => branchToLane.set(n, i));

  const branchesAt = branchNamesByCommit(commits, tips);

  const lanes: number[] = commits.map((c) => {
    const names = branchesAt.get(c.hash) ?? [];
    const primary = primaryBranchName(names, currentBranchName);
    if (primary === null) return 0;
    return branchToLane.get(primary) ?? 0;
  });

  const laneColors = Array.from({ length: laneCount }, (_, i) => branchLaneHue(i));

  const indexByHash = new Map(commits.map((c, i) => [c.hash, i] as const));

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
    const x1 = cx(lanes[i]);
    for (const p of c.parentHashes) {
      const j = indexByHash.get(p);
      if (j === undefined) continue;
      const y2 = cy(j);
      const x2 = cx(lanes[j]);
      const yMid = (y1 + y2) / 2;
      const d = `M ${x1} ${y1} L ${x1} ${yMid} L ${x2} ${yMid} L ${x2} ${y2}`;
      const color = laneColors[lanes[j] % laneColors.length] ?? branchLaneHue(0);
      edgePaths.push({ d, color });
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
