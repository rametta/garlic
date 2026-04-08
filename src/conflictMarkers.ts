/**
 * Parse text merge markers into selectable conflict blocks and rebuild a resolved file preview.
 * Search tags: conflict markers, custom conflict resolution, ours theirs, resolved preview.
 */

export type ConflictResolutionSide = "ours" | "theirs";

export type ConflictBlockLine = {
  lineNumber: number;
  text: string;
};

export type ConflictContextSegment = {
  type: "context";
  lines: string[];
};

export type ConflictBlockSegment = {
  type: "conflict";
  conflictIndex: number;
  oursLines: ConflictBlockLine[];
  theirsLines: ConflictBlockLine[];
};

export type ConflictWorktreeSegment = ConflictContextSegment | ConflictBlockSegment;

export type ParsedConflictWorktree = {
  segments: ConflictWorktreeSegment[];
  conflicts: ConflictBlockSegment[];
  eol: "\n" | "\r\n";
  hasTrailingNewline: boolean;
};

export type ConflictBlockSelectionDraft = {
  oursLineNumbers: number[];
  theirsLineNumbers: number[];
  resolvedAsEmpty: boolean;
};

function sortNumbers(values: number[]): number[] {
  return [...values].sort((a, b) => a - b);
}

function splitConflictText(text: string): {
  lines: string[];
  eol: "\n" | "\r\n";
  hasTrailingNewline: boolean;
} {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const hasTrailingNewline = /(?:\r\n|\r|\n)$/.test(text);
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  if (hasTrailingNewline && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return { lines, eol, hasTrailingNewline };
}

export function createEmptyConflictSelectionDraft(): ConflictBlockSelectionDraft {
  return {
    oursLineNumbers: [],
    theirsLineNumbers: [],
    resolvedAsEmpty: false,
  };
}

export function parseConflictWorktreeText(text: string): ParsedConflictWorktree | null {
  const { lines, eol, hasTrailingNewline } = splitConflictText(text);
  const segments: ConflictWorktreeSegment[] = [];
  const conflicts: ConflictBlockSegment[] = [];
  let contextLines: string[] = [];
  let oursLineNumber = 1;
  let theirsLineNumber = 1;
  let conflictIndex = 0;
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!line.startsWith("<<<<<<< ")) {
      contextLines.push(line);
      oursLineNumber += 1;
      theirsLineNumber += 1;
      index += 1;
      continue;
    }

    if (contextLines.length > 0) {
      segments.push({ type: "context", lines: contextLines });
      contextLines = [];
    }

    conflictIndex += 1;
    index += 1;

    const oursLines: ConflictBlockLine[] = [];
    while (index < lines.length) {
      const nextLine = lines[index] ?? "";
      if (nextLine.startsWith("=======") || nextLine.startsWith("||||||| ")) {
        break;
      }
      oursLines.push({ lineNumber: oursLineNumber, text: nextLine });
      oursLineNumber += 1;
      index += 1;
    }

    if ((lines[index] ?? "").startsWith("||||||| ")) {
      index += 1;
      while (index < lines.length && !(lines[index] ?? "").startsWith("=======")) {
        index += 1;
      }
    }

    if (!(lines[index] ?? "").startsWith("=======")) {
      return null;
    }
    index += 1;

    const theirsLines: ConflictBlockLine[] = [];
    while (index < lines.length) {
      const nextLine = lines[index] ?? "";
      if (nextLine.startsWith(">>>>>>> ")) {
        break;
      }
      theirsLines.push({ lineNumber: theirsLineNumber, text: nextLine });
      theirsLineNumber += 1;
      index += 1;
    }

    if (!(lines[index] ?? "").startsWith(">>>>>>> ")) {
      return null;
    }
    index += 1;

    const conflict: ConflictBlockSegment = {
      type: "conflict",
      conflictIndex,
      oursLines,
      theirsLines,
    };
    segments.push(conflict);
    conflicts.push(conflict);
  }

  if (contextLines.length > 0) {
    segments.push({ type: "context", lines: contextLines });
  }

  return {
    segments,
    conflicts,
    eol,
    hasTrailingNewline,
  };
}

export function isConflictBlockResolved(
  selection: ConflictBlockSelectionDraft | null | undefined,
): boolean {
  return Boolean(
    selection &&
    (selection.resolvedAsEmpty ||
      selection.oursLineNumbers.length > 0 ||
      selection.theirsLineNumbers.length > 0),
  );
}

export function selectedLineCount(
  selection: ConflictBlockSelectionDraft | null | undefined,
  side: ConflictResolutionSide,
): number {
  if (!selection) return 0;
  return side === "ours" ? selection.oursLineNumbers.length : selection.theirsLineNumbers.length;
}

export function buildResolvedConflictText(
  parsed: ParsedConflictWorktree,
  selections: Record<number, ConflictBlockSelectionDraft>,
): string | null {
  const outputLines: string[] = [];

  for (const segment of parsed.segments) {
    if (segment.type === "context") {
      outputLines.push(...segment.lines);
      continue;
    }

    const selection = selections[segment.conflictIndex];
    if (!isConflictBlockResolved(selection)) {
      return null;
    }
    if (selection?.resolvedAsEmpty) {
      continue;
    }

    const oursSet = new Set(selection?.oursLineNumbers ?? []);
    const theirsSet = new Set(selection?.theirsLineNumbers ?? []);

    outputLines.push(
      ...segment.oursLines.filter((line) => oursSet.has(line.lineNumber)).map((line) => line.text),
    );
    outputLines.push(
      ...segment.theirsLines
        .filter((line) => theirsSet.has(line.lineNumber))
        .map((line) => line.text),
    );
  }

  const resolved = outputLines.join(parsed.eol);
  return parsed.hasTrailingNewline ? `${resolved}${parsed.eol}` : resolved;
}

export function withResolvedEmptySelection(): ConflictBlockSelectionDraft {
  return {
    oursLineNumbers: [],
    theirsLineNumbers: [],
    resolvedAsEmpty: true,
  };
}

export function withSortedSelection(
  selection: ConflictBlockSelectionDraft,
): ConflictBlockSelectionDraft {
  return {
    oursLineNumbers: sortNumbers(selection.oursLineNumbers),
    theirsLineNumbers: sortNumbers(selection.theirsLineNumbers),
    resolvedAsEmpty: selection.resolvedAsEmpty,
  };
}
