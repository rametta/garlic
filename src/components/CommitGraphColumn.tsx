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

/** SVG DAG column: edges and commit nodes aligned to `COMMIT_GRAPH_ROW_HEIGHT` rows. */
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
  const wipLane = commitCount > 0 ? (layout.lanes[0] ?? 0) : 0;
  const wipColor =
    layout.rowColors[0] ?? layout.laneColors[wipLane % layout.laneColors.length] ?? "currentColor";

  return (
    <svg
      className="pointer-events-none shrink-0 text-base-content/35"
      width={w}
      height={h}
      aria-hidden
    >
      {wipRowAbove ? (
        <g aria-hidden>
          <line
            x1={cx(wipLane)}
            y1={cy(0)}
            x2={cx(wipLane)}
            y2={cy(1)}
            stroke={wipColor}
            strokeOpacity={0.85}
            strokeWidth={1.75}
            strokeLinecap="round"
          />
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
        {layout.lanes.map((lane, row) => {
          const hash = commitHashes[row];
          const nodeColor =
            layout.rowColors[row] ??
            layout.laneColors[lane % layout.laneColors.length] ??
            "currentColor";
          const isActiveBranchCommit =
            showActiveBranch && hash ? activeFirstParentHashes.has(hash) : false;
          const isActiveTip = hash !== undefined && hash === currentBranchTipHash;
          return (
            <g key={`n-${row}`}>
              {isActiveBranchCommit ? (
                <circle
                  cx={cx(lane)}
                  cy={cy(row)}
                  r={isActiveTip ? 6.5 : 5.6}
                  fill={nodeColor}
                  fillOpacity={0.18}
                />
              ) : null}
              <circle
                cx={cx(lane)}
                cy={cy(row)}
                r={isActiveTip ? 4.95 : isActiveBranchCommit ? 4.55 : 4.25}
                className={isActiveBranchCommit ? undefined : "fill-base-100"}
                fill={isActiveBranchCommit ? nodeColor : undefined}
                fillOpacity={isActiveBranchCommit ? (isActiveTip ? 0.98 : 0.88) : undefined}
                stroke={nodeColor}
                strokeWidth={isActiveBranchCommit ? 2.1 : 1.5}
                strokeDasharray={layout.stashRows[row] ? "2 3" : undefined}
              />
              {isActiveBranchCommit ? (
                <circle
                  cx={cx(lane)}
                  cy={cy(row)}
                  r={isActiveTip ? 1.55 : 1.3}
                  className="fill-base-100"
                />
              ) : null}
            </g>
          );
        })}
      </g>
    </svg>
  );
}
