/**
 * Builds minimal patch text for staging or discarding individual hunks/blocks from parsed diffs.
 * Search tags: patch builder, hunk patch, zero-context patch, partial stage, partial discard.
 */
import { getChangeKey, isDelete, isInsert, type ChangeData, type HunkData } from "react-diff-view";

function normalizePatchLine(change: ChangeData): string {
  if (patchEndsWithNoNewlineMarker(change)) {
    return change.content;
  }
  const prefix = isInsert(change) ? "+" : isDelete(change) ? "-" : " ";
  return `${prefix}${change.content}`;
}

function patchEndsWithNoNewlineMarker(change: ChangeData): boolean {
  return change.content.startsWith("\\");
}

function formatRange(start: number, count: number): string {
  if (count === 1) return String(start);
  return `${start},${count}`;
}

function formatZeroContextHunkHeader(
  oldStart: number,
  oldCount: number,
  newStart: number,
  newCount: number,
): string {
  return `@@ -${formatRange(oldStart, oldCount)} +${formatRange(newStart, newCount)} @@`;
}

function joinPatch(headerLines: readonly string[], hunkLines: readonly string[]): string | null {
  if (headerLines.length === 0 || hunkLines.length === 0) return null;
  return `${[...headerLines, ...hunkLines].join("\n")}\n`;
}

export function extractPatchHeaderLines(text: string): string[] {
  const normalized = text.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const firstHunkIndex = lines.findIndex((line: string) => line.startsWith("@@ "));
  if (firstHunkIndex === -1) {
    return lines.filter((line: string) => line.length > 0);
  }
  return lines.slice(0, firstHunkIndex);
}

export function buildHunkPatch(headerLines: readonly string[], hunk: HunkData): string | null {
  const hunkLines = [hunk.content, ...hunk.changes.map((change) => normalizePatchLine(change))];
  return joinPatch(headerLines, hunkLines);
}

export function buildChangeBlockPatchMap(
  headerLines: readonly string[],
  hunk: HunkData,
): Map<string, string> {
  const patches = new Map<string, string>();
  let oldCursor = hunk.oldStart;
  let newCursor = hunk.newStart;
  let current: {
    changeKeys: string[];
    lines: string[];
    oldStartCursor: number;
    newStartCursor: number;
    oldCount: number;
    newCount: number;
  } | null = null;

  const flushCurrent = () => {
    if (!current) return;
    if (current.oldCount === 0 && current.newCount === 0) {
      current = null;
      return;
    }
    const oldStart = Math.max(
      0,
      current.oldCount === 0 ? current.oldStartCursor - 1 : current.oldStartCursor,
    );
    const newStart = Math.max(
      0,
      current.newCount === 0 ? current.newStartCursor - 1 : current.newStartCursor,
    );
    const patch = joinPatch(headerLines, [
      formatZeroContextHunkHeader(oldStart, current.oldCount, newStart, current.newCount),
      ...current.lines,
    ]);
    if (patch) {
      for (const key of current.changeKeys) {
        patches.set(key, patch);
      }
    }
    current = null;
  };

  for (const change of hunk.changes) {
    const insert = isInsert(change);
    const del = isDelete(change);
    if (!insert && !del) {
      if (patchEndsWithNoNewlineMarker(change) && current) {
        current.lines.push(normalizePatchLine(change));
        continue;
      }
      flushCurrent();
      oldCursor += 1;
      newCursor += 1;
      continue;
    }
    // One patch per changed line so line-level stage/unstage buttons do not apply whole runs.
    flushCurrent();
    current = {
      changeKeys: [getChangeKey(change)],
      lines: [normalizePatchLine(change)],
      oldStartCursor: oldCursor,
      newStartCursor: newCursor,
      oldCount: del ? 1 : 0,
      newCount: insert ? 1 : 0,
    };
    if (del) oldCursor += 1;
    if (insert) newCursor += 1;
  }

  flushCurrent();
  return patches;
}
