import type { CommitGraphLayout } from "../commitGraphLayout";
import {
  COMMIT_GRAPH_LANE_WIDTH,
  COMMIT_GRAPH_PAD_X,
  COMMIT_GRAPH_ROW_HEIGHT,
} from "../commitGraphLayout";

interface CommitGraphColumnProps {
  layout: CommitGraphLayout;
  commitHashes: string[];
  activeFirstParentHashes: ReadonlySet<string>;
  currentBranchTipHash: string | null;
  /** Extra row above the DAG for uncommitted working-tree changes (GitKraken-style WIP). */
  wipRowAbove?: boolean;
}

/** SVG DAG column: edges aligned to `COMMIT_GRAPH_ROW_HEIGHT` rows. */
export function CommitGraphColumn({
  layout,
  commitHashes,
  activeFirstParentHashes,
  currentBranchTipHash,
  wipRowAbove = false,
}: CommitGraphColumnProps) {
  const commitCount = commitHashes.length;
  const rowH = COMMIT_GRAPH_ROW_HEIGHT;
  const laneW = COMMIT_GRAPH_LANE_WIDTH;
  const pad = COMMIT_GRAPH_PAD_X;
  const rowShift = wipRowAbove ? 1 : 0;
  const h = (commitCount + rowShift) * rowH;
  const w = layout.graphWidthPx;
  const showActiveBranch = currentBranchTipHash !== null;

  const cx = (lane: number) => pad + lane * laneW + laneW / 2;
  const cy = (row: number) => row * rowH + rowH / 2;
  const activeTipRow =
    currentBranchTipHash !== null ? commitHashes.indexOf(currentBranchTipHash) : -1;
  const firstVisibleActiveBranchRow =
    activeTipRow >= 0
      ? activeTipRow
      : commitHashes.findIndex((hash) => activeFirstParentHashes.has(hash));
  const wipTargetCommitRow =
    firstVisibleActiveBranchRow >= 0 ? firstVisibleActiveBranchRow : commitCount > 0 ? 0 : null;
  const wipLane = wipTargetCommitRow !== null ? (layout.lanes[wipTargetCommitRow] ?? 0) : 0;
  const wipColor =
    (wipTargetCommitRow !== null ? layout.rowColors[wipTargetCommitRow] : undefined) ??
    layout.laneColors[wipLane % layout.laneColors.length] ??
    "currentColor";

  return (
    <svg
      className="pointer-events-none shrink-0 text-base-content/35"
      width={w}
      height={h}
      aria-hidden
    >
      {wipRowAbove ? (
        <g aria-hidden>
          {wipTargetCommitRow !== null ? (
            <line
              x1={cx(wipLane)}
              y1={cy(0)}
              x2={cx(wipLane)}
              y2={cy(wipTargetCommitRow + rowShift)}
              stroke={wipColor}
              strokeOpacity={0.85}
              strokeWidth={1.75}
              strokeLinecap="round"
              strokeDasharray="3 3"
            />
          ) : null}
          <circle
            cx={cx(wipLane)}
            cy={cy(0)}
            r={4.25}
            fill="none"
            stroke={wipColor}
            strokeOpacity={0.9}
            strokeWidth={1.5}
            strokeDasharray="3 3"
          />
        </g>
      ) : null}
      <g transform={wipRowAbove ? `translate(0, ${rowH})` : undefined}>
        {layout.edgePaths.map((e, i) => (
          <g key={`e-${i}`}>
            {showActiveBranch &&
            e.firstParent &&
            activeFirstParentHashes.has(e.fromHash) &&
            activeFirstParentHashes.has(e.toHash) ? (
              <path
                d={e.d}
                fill="none"
                stroke={e.color}
                strokeOpacity={0.22}
                strokeWidth={5.25}
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeDasharray={e.dashed ? "2 3" : undefined}
              />
            ) : null}
            <path
              d={e.d}
              fill="none"
              stroke={e.color}
              strokeOpacity={
                showActiveBranch &&
                e.firstParent &&
                activeFirstParentHashes.has(e.fromHash) &&
                activeFirstParentHashes.has(e.toHash)
                  ? 1
                  : 0.85
              }
              strokeWidth={
                showActiveBranch &&
                e.firstParent &&
                activeFirstParentHashes.has(e.fromHash) &&
                activeFirstParentHashes.has(e.toHash)
                  ? 2.4
                  : 1.75
              }
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeDasharray={e.dashed ? "2 3" : undefined}
            />
          </g>
        ))}
      </g>
    </svg>
  );
}
