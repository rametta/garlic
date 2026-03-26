import type { CommitGraphLayout } from "../commitGraphLayout";
import {
  COMMIT_GRAPH_LANE_WIDTH,
  COMMIT_GRAPH_PAD_X,
  COMMIT_GRAPH_ROW_HEIGHT,
} from "../commitGraphLayout";

interface CommitGraphColumnProps {
  layout: CommitGraphLayout;
  commitCount: number;
  /** Extra row above the DAG for uncommitted working-tree changes (GitKraken-style WIP). */
  wipRowAbove?: boolean;
}

/** SVG DAG column: edges and commit nodes aligned to `COMMIT_GRAPH_ROW_HEIGHT` rows. */
export function CommitGraphColumn({
  layout,
  commitCount,
  wipRowAbove = false,
}: CommitGraphColumnProps) {
  const rowH = COMMIT_GRAPH_ROW_HEIGHT;
  const laneW = COMMIT_GRAPH_LANE_WIDTH;
  const pad = COMMIT_GRAPH_PAD_X;
  const rowShift = wipRowAbove ? 1 : 0;
  const h = (commitCount + rowShift) * rowH;
  const w = layout.graphWidthPx;

  const cx = (lane: number) => pad + lane * laneW + laneW / 2;
  const cy = (row: number) => row * rowH + rowH / 2;
  const wipLane = commitCount > 0 ? (layout.lanes[0] ?? 0) : 0;
  const wipColor = layout.laneColors[wipLane % layout.laneColors.length];

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
          <path
            key={`e-${i}`}
            d={e.d}
            fill="none"
            stroke={e.color}
            strokeOpacity={0.85}
            strokeWidth={1.75}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ))}
        {layout.lanes.map((lane, row) => (
          <circle
            key={`n-${row}`}
            cx={cx(lane)}
            cy={cy(row)}
            r={4.25}
            className="fill-base-100 stroke-[1.5]"
            style={{ stroke: layout.laneColors[lane % layout.laneColors.length] }}
          />
        ))}
      </g>
    </svg>
  );
}
