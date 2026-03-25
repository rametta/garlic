import { useMemo, type ReactNode } from "react";
import {
  computeNewLineNumber,
  computeOldLineNumber,
  getChangeKey,
  isDelete,
  isInsert,
  parseDiff,
  type ChangeData,
  type FileData,
  type HunkData,
} from "react-diff-view";

function fileKey(file: FileData, index: number): string {
  return `${file.oldRevision}-${file.newRevision}-${file.newPath || file.oldPath}-${index}`;
}

function hunkKey(hunk: HunkData, fileIndex: number, hunkIndex: number): string {
  return `${fileIndex}-${hunkIndex}-${hunk.oldStart}-${hunk.newStart}`;
}

function gutterKind(change: ChangeData): "insert" | "delete" | "normal" {
  if (isInsert(change)) return "insert";
  if (isDelete(change)) return "delete";
  return "normal";
}

function DiffGridRow({ change }: { change: ChangeData }) {
  const oldN = computeOldLineNumber(change);
  const newN = computeNewLineNumber(change);
  const oldText = oldN === -1 ? "" : String(oldN);
  const newText = newN === -1 ? "" : String(newN);
  const kind = gutterKind(change);

  const gutterClass =
    kind === "insert"
      ? "diff-gutter-insert"
      : kind === "delete"
        ? "diff-gutter-delete"
        : "diff-gutter-normal";

  const codeClass =
    kind === "insert"
      ? "diff-code-insert"
      : kind === "delete"
        ? "diff-code-delete"
        : "diff-code-normal";

  return (
    <div
      className="diff-grid-row grid w-full min-w-0 grid-cols-[minmax(4ch,7ch)_minmax(4ch,7ch)_minmax(0,1fr)] font-mono text-[0.8125rem] leading-relaxed text-(--diff-text-color)"
      data-change-key={getChangeKey(change)}
    >
      <div
        className={`diff-gutter diff-line px-1 py-0 text-right select-none ${gutterClass}`}
        aria-hidden
      >
        {oldText}
      </div>
      <div
        className={`diff-gutter diff-line px-1 py-0 text-right select-none ${gutterClass}`}
        aria-hidden
      >
        {newText}
      </div>
      <pre
        className={`diff-line diff-code m-0 min-h-0 min-w-0 overflow-x-auto border-0 py-0 pr-2 pl-2 [word-break:break-word] whitespace-pre-wrap ${codeClass}`}
      >
        {change.content.length === 0 ? " " : change.content}
      </pre>
    </div>
  );
}

function UnifiedDiffFile({ file, fileIndex }: { file: FileData; fileIndex: number }) {
  return (
    <div className="unified-diff-file flex min-w-0 flex-col gap-0">
      {file.hunks.map((hunk, hi) => (
        <div key={hunkKey(hunk, fileIndex, hi)} className="flex min-w-0 flex-col">
          <div
            className="diff-hunk-meta border-b border-base-300/80 px-2 py-1 font-mono text-[0.65rem] text-base-content/60 select-none"
            aria-hidden
          >
            {hunk.content.trim()}
          </div>
          {hunk.changes.map((change) => (
            <DiffGridRow key={getChangeKey(change)} change={change} />
          ))}
        </div>
      ))}
    </div>
  );
}

export function UnifiedDiff({
  text,
  emptyLabel,
}: {
  text: string;
  emptyLabel: ReactNode;
}): ReactNode {
  const parsed = useMemo(() => {
    const trimmed = text.trim();
    if (!trimmed) {
      return { kind: "empty" as const };
    }
    try {
      const files = parseDiff(text);
      const withHunks = files.filter((f) => f.hunks.length > 0);
      if (withHunks.length > 0) {
        return { kind: "ok" as const, files: withHunks };
      }
      return { kind: "raw" as const };
    } catch {
      return { kind: "raw" as const };
    }
  }, [text]);

  if (parsed.kind === "empty") {
    return <span className="text-base-content/50">{emptyLabel}</span>;
  }

  if (parsed.kind === "raw") {
    return (
      <pre className="m-0 font-mono text-[0.8125rem] leading-relaxed wrap-break-word whitespace-pre-wrap text-base-content">
        {text || emptyLabel}
      </pre>
    );
  }

  return (
    <div className="unified-diff-panel unified-diff-grid block w-full min-w-0">
      <div className="w-full max-w-full min-w-0 overflow-x-auto">
        {parsed.files.map((file, i) => (
          <UnifiedDiffFile key={fileKey(file, i)} file={file} fileIndex={i} />
        ))}
      </div>
    </div>
  );
}
