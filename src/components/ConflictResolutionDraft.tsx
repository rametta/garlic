/**
 * Draftable conflict resolver for text conflicts with line- and block-level selection.
 * Search tags: custom conflict resolution, ours/theirs picker, resolved preview.
 */
import { getTokenStyleObject } from "@shikijs/core";
import { memo, useCallback, useMemo, useState, type CSSProperties } from "react";
import type { BundledLanguage } from "shiki";

import {
  buildResolvedConflictLines,
  createEmptyConflictSelectionDraft,
  isConflictBlockResolved,
  parseConflictWorktreeText,
  selectedLineCount,
  type ConflictBlockSelectionDraft,
  type ConflictResolutionSide,
  type ResolvedPreviewLine,
  withResolvedEmptySelection,
  withSortedSelection,
} from "../conflictMarkers";
import { pathToShikiLang } from "../diffLanguage";
import { useDiffShikiTheme, useShikiHighlighter } from "../diffShiki";
import type { ConflictFileDetails as RepoConflictFileDetails } from "../gitTypes";
import { ConflictVersionPanel, type ConflictSelectionControls } from "./ConflictVersionPanel";

function shikiTokenStyleToReact(style: Record<string, string>): CSSProperties {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(style)) {
    const reactKey = key.includes("-")
      ? key.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
      : key;
    out[reactKey] = value;
  }
  return out as CSSProperties;
}

function resolvedRowDiffClasses(source: ResolvedPreviewLine["source"]): {
  gutter: string;
  code: string;
  title: string;
} {
  switch (source) {
    case "ours":
      return {
        gutter: "diff-gutter-insert",
        code: "diff-code-insert",
        title: "Line taken from ours in this merge",
      };
    case "theirs":
      return {
        gutter: "diff-gutter-selected",
        code: "diff-code-selected",
        title: "Line taken from theirs in this merge",
      };
    default:
      return {
        gutter: "",
        code: "diff-code-normal",
        title: "Unchanged context (outside conflict choices)",
      };
  }
}

const ResolvedTextHighlight = memo(function ResolvedTextHighlight({
  path,
  lines,
}: {
  path: string;
  lines: readonly ResolvedPreviewLine[];
}) {
  const highlighter = useShikiHighlighter();
  const shikiTheme = useDiffShikiTheme();
  const lang = useMemo(() => pathToShikiLang(path), [path]);
  const textLines = useMemo(() => lines.map((l) => l.text), [lines]);

  const tokenRows = useMemo(() => {
    if (!highlighter || !lang) return null;
    return textLines.map((line) => {
      try {
        const tokenRow = highlighter.codeToTokens(line.length === 0 ? " " : line, {
          lang: lang as BundledLanguage,
          theme: shikiTheme,
          tokenizeMaxLineLength: 12000,
        }).tokens[0];
        return tokenRow?.length ? tokenRow : null;
      } catch {
        return null;
      }
    });
  }, [highlighter, lang, shikiTheme, textLines]);

  return (
    <div className="unified-diff-panel unified-diff-grid pb-3">
      {lines.map((row, lineIndex) => {
        const { gutter: gutterExtra, code: codeClass, title } = resolvedRowDiffClasses(row.source);
        const lineText = row.text;
        const tokenRow = tokenRows?.[lineIndex];
        return (
          <div
            key={lineIndex}
            title={title}
            className="grid w-full min-w-0 grid-cols-[minmax(4ch,7ch)_minmax(0,1fr)] font-mono text-[0.78rem] leading-relaxed text-(--diff-text-color)"
          >
            <div
              className={`diff-gutter diff-line px-1 py-0 text-right select-none ${gutterExtra}`}
              aria-hidden
            >
              {lineIndex + 1}
            </div>
            <pre
              className={`diff-line m-0 min-h-0 min-w-0 overflow-x-auto border-0 py-0 pr-2 pl-2 [word-break:break-word] whitespace-pre-wrap ${codeClass}`}
            >
              {!highlighter || !lang
                ? lineText.length === 0
                  ? " "
                  : lineText
                : tokenRow
                  ? tokenRow.map((tok, j) => (
                      <span key={j} style={shikiTokenStyleToReact(getTokenStyleObject(tok))}>
                        {tok.content}
                      </span>
                    ))
                  : lineText.length === 0
                    ? " "
                    : lineText}
            </pre>
          </div>
        );
      })}
    </div>
  );
});

type ConflictResolutionDraftProps = {
  path: string;
  details: RepoConflictFileDetails;
  busy?: boolean;
  onStageResolved: (resolvedText: string) => void;
};

function sameDraft(a: ConflictBlockSelectionDraft, b: ConflictBlockSelectionDraft): boolean {
  return (
    a.resolvedAsEmpty === b.resolvedAsEmpty &&
    a.oursLineNumbers.length === b.oursLineNumbers.length &&
    a.theirsLineNumbers.length === b.theirsLineNumbers.length &&
    a.oursLineNumbers.every((value, index) => value === b.oursLineNumbers[index]) &&
    a.theirsLineNumbers.every((value, index) => value === b.theirsLineNumbers[index])
  );
}

function updateDrafts(
  current: Record<number, ConflictBlockSelectionDraft>,
  conflictIndex: number,
  updater: (draft: ConflictBlockSelectionDraft) => ConflictBlockSelectionDraft,
) {
  const nextDraft = withSortedSelection(
    updater(current[conflictIndex] ?? createEmptyConflictSelectionDraft()),
  );
  const previousDraft = current[conflictIndex] ?? createEmptyConflictSelectionDraft();
  if (sameDraft(previousDraft, nextDraft)) {
    return current;
  }
  return { ...current, [conflictIndex]: nextDraft };
}

export const ConflictResolutionDraft = memo(function ConflictResolutionDraft({
  path,
  details,
  busy = false,
  onStageResolved,
}: ConflictResolutionDraftProps) {
  const parsed = useMemo(
    () => (details.worktreeText ? parseConflictWorktreeText(details.worktreeText) : null),
    [details.worktreeText],
  );
  const [drafts, setDrafts] = useState<Record<number, ConflictBlockSelectionDraft>>({});

  const toggleLineSelection = useCallback(
    (side: ConflictResolutionSide, conflictIndex: number, lineNumber: number) => {
      setDrafts((current) =>
        updateDrafts(current, conflictIndex, (draft) => {
          const key = side === "ours" ? "oursLineNumbers" : "theirsLineNumbers";
          const values = new Set(draft[key]);
          if (values.has(lineNumber)) {
            values.delete(lineNumber);
          } else {
            values.add(lineNumber);
          }
          return {
            ...draft,
            [key]: [...values],
            resolvedAsEmpty: false,
          };
        }),
      );
    },
    [],
  );

  const toggleBlockSelection = useCallback(
    (side: ConflictResolutionSide, conflictIndex: number, lineNumbers: readonly number[]) => {
      setDrafts((current) =>
        updateDrafts(current, conflictIndex, (draft) => {
          if (lineNumbers.length === 0) {
            return draft.resolvedAsEmpty &&
              draft.oursLineNumbers.length === 0 &&
              draft.theirsLineNumbers.length === 0
              ? createEmptyConflictSelectionDraft()
              : withResolvedEmptySelection();
          }
          const key = side === "ours" ? "oursLineNumbers" : "theirsLineNumbers";
          const values = new Set(draft[key]);
          const allSelected = lineNumbers.every((lineNumber) => values.has(lineNumber));
          for (const lineNumber of lineNumbers) {
            if (allSelected) {
              values.delete(lineNumber);
            } else {
              values.add(lineNumber);
            }
          }
          return {
            ...draft,
            [key]: [...values],
            resolvedAsEmpty: false,
          };
        }),
      );
    },
    [],
  );

  const clearConflictSelection = useCallback((conflictIndex: number) => {
    setDrafts((current) =>
      updateDrafts(current, conflictIndex, () => createEmptyConflictSelectionDraft()),
    );
  }, []);

  const oursSelectionControls = useMemo<ConflictSelectionControls>(
    () => ({
      blockActionLabel: "Take block",
      isLineSelected: (conflictIndex, lineNumber) =>
        (drafts[conflictIndex]?.oursLineNumbers ?? []).includes(lineNumber),
      isBlockSelected: (conflictIndex, lineNumbers) =>
        lineNumbers.length === 0
          ? Boolean(drafts[conflictIndex]?.resolvedAsEmpty)
          : lineNumbers.every((lineNumber) =>
              (drafts[conflictIndex]?.oursLineNumbers ?? []).includes(lineNumber),
            ),
      onToggleLine: (conflictIndex, lineNumber) => {
        toggleLineSelection("ours", conflictIndex, lineNumber);
      },
      onToggleBlock: (conflictIndex, lineNumbers) => {
        toggleBlockSelection("ours", conflictIndex, lineNumbers);
      },
    }),
    [drafts, toggleBlockSelection, toggleLineSelection],
  );

  const theirsSelectionControls = useMemo<ConflictSelectionControls>(
    () => ({
      blockActionLabel: "Take block",
      isLineSelected: (conflictIndex, lineNumber) =>
        (drafts[conflictIndex]?.theirsLineNumbers ?? []).includes(lineNumber),
      isBlockSelected: (conflictIndex, lineNumbers) =>
        lineNumbers.length === 0
          ? Boolean(drafts[conflictIndex]?.resolvedAsEmpty)
          : lineNumbers.every((lineNumber) =>
              (drafts[conflictIndex]?.theirsLineNumbers ?? []).includes(lineNumber),
            ),
      onToggleLine: (conflictIndex, lineNumber) => {
        toggleLineSelection("theirs", conflictIndex, lineNumber);
      },
      onToggleBlock: (conflictIndex, lineNumbers) => {
        toggleBlockSelection("theirs", conflictIndex, lineNumbers);
      },
    }),
    [drafts, toggleBlockSelection, toggleLineSelection],
  );

  const conflictSummaries = useMemo(() => {
    if (!parsed) return [];
    return parsed.conflicts.map((conflict) => {
      const selection = drafts[conflict.conflictIndex];
      return {
        conflictIndex: conflict.conflictIndex,
        resolved: isConflictBlockResolved(selection),
        oursSelected: selectedLineCount(selection, "ours"),
        theirsSelected: selectedLineCount(selection, "theirs"),
        resolvedAsEmpty: Boolean(selection?.resolvedAsEmpty),
      };
    });
  }, [drafts, parsed]);

  const resolvedConflictCount = conflictSummaries.filter((summary) => summary.resolved).length;
  const resolvedAssembly = useMemo(() => {
    if (!parsed)
      return { text: null as string | null, lines: null as ResolvedPreviewLine[] | null };
    const lines = buildResolvedConflictLines(parsed, drafts);
    if (lines === null) return { text: null, lines: null };
    const outputLines = lines.map((l) => l.text);
    const resolved = outputLines.join(parsed.eol);
    const text = parsed.hasTrailingNewline ? `${resolved}${parsed.eol}` : resolved;
    return { text, lines };
  }, [drafts, parsed]);
  const resolvedText = resolvedAssembly.text;
  const resolvedPreviewLines = resolvedAssembly.lines;

  if (!parsed || parsed.conflicts.length === 0) {
    return null;
  }

  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 overflow-auto bg-base-200/40 2xl:grid-cols-3">
      <ConflictVersionPanel
        path={path}
        preview={details.ours}
        ranges={details.conflictRanges.ours}
        busy={busy}
        selectionControls={oursSelectionControls}
      />
      <ConflictVersionPanel
        path={path}
        preview={details.theirs}
        ranges={details.conflictRanges.theirs}
        busy={busy}
        selectionControls={theirsSelectionControls}
      />
      <section className="flex min-h-0 min-w-0 flex-col overflow-hidden bg-base-200/35">
        <div className="flex items-start justify-between gap-3 border-b border-base-300/80 px-3 py-2">
          <div className="min-w-0">
            <div className="text-[0.65rem] font-semibold tracking-wide text-base-content/60 uppercase">
              Resolution
            </div>
            <p className="mt-1 mb-0 text-[0.72rem] leading-relaxed text-base-content/55">
              Take whole conflict blocks or individual lines, then stage the assembled result.
            </p>
          </div>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            disabled={busy || resolvedText === null}
            onClick={() => {
              if (resolvedText === null) return;
              onStageResolved(resolvedText);
            }}
          >
            Stage resolved selection
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          <div className="mb-3 bg-base-100/40 px-3 py-2 text-xs text-base-content/65">
            Resolved {resolvedConflictCount} of {parsed.conflicts.length} conflict block
            {parsed.conflicts.length === 1 ? "" : "s"}.
          </div>
          <div className="flex flex-col gap-2">
            {conflictSummaries.map((summary) => (
              <div
                key={summary.conflictIndex}
                className="flex items-center justify-between gap-3 border-y border-base-300/70 bg-base-100/40 px-3 py-2"
              >
                <div className="min-w-0">
                  <div className="text-[0.7rem] font-semibold tracking-wide text-base-content/65 uppercase">
                    Conflict {summary.conflictIndex}
                  </div>
                  <div className="mt-1 text-xs text-base-content/60">
                    {summary.resolved
                      ? summary.resolvedAsEmpty
                        ? "Resolved as empty output."
                        : `${summary.oursSelected} ours, ${summary.theirsSelected} theirs selected.`
                      : "Waiting for a block or line selection."}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span
                    className={`badge badge-sm ${
                      summary.resolved ? "badge-outline badge-success" : "badge-ghost"
                    }`}
                  >
                    {summary.resolved ? "resolved" : "pending"}
                  </span>
                  <button
                    type="button"
                    className="btn btn-ghost btn-xs"
                    disabled={busy}
                    onClick={() => {
                      clearConflictSelection(summary.conflictIndex);
                    }}
                  >
                    Clear
                  </button>
                </div>
              </div>
            ))}
          </div>
          {resolvedText === null ? (
            <div className="border-y border-dashed border-base-300/80 bg-base-100/20 px-4 py-5 text-sm leading-relaxed text-base-content/60">
              Preview appears once every conflict block has a selection. Use the block buttons for
              quick picks, then fine-tune with the per-line `+` buttons.
            </div>
          ) : (
            <ResolvedTextHighlight path={path} lines={resolvedPreviewLines ?? []} />
          )}
        </div>
      </section>
    </div>
  );
});
