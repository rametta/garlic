import type { CommitGraphLayout } from "../commitGraphLayout";
import {
  COMMIT_GRAPH_LANE_WIDTH,
  COMMIT_GRAPH_PAD_X,
  COMMIT_GRAPH_ROW_HEIGHT,
} from "../commitGraphLayout";

interface CommitGraphColumnProps {
  layout: CommitGraphLayout;
  commitCount: number;
}

/** SVG DAG column: edges and commit nodes aligned to `COMMIT_GRAPH_ROW_HEIGHT` rows. */
export function CommitGraphColumn({ layout, commitCount }: CommitGraphColumnProps) {
  const rowH = COMMIT_GRAPH_ROW_HEIGHT;
  const laneW = COMMIT_GRAPH_LANE_WIDTH;
  const pad = COMMIT_GRAPH_PAD_X;
  const h = commitCount * rowH;
  const w = layout.graphWidthPx;

  const cx = (lane: number) => pad + lane * laneW + laneW / 2;
  const cy = (row: number) => row * rowH + rowH / 2;

  return (
    <svg
      className="pointer-events-none shrink-0 text-base-content/35"
      width={w}
      height={h}
      aria-hidden
    >
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
    </svg>
  );
}
