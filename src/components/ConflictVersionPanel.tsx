/**
 * Conflict-side preview panel that highlights the chosen version around merge/rebase conflicts.
 * Search tags: conflict preview, ours vs theirs, conflict ranges, shiki conflict snippet.
 */
import { getTokenStyleObject } from "@shikijs/core";
import { memo, useMemo, type CSSProperties } from "react";
import type { BundledLanguage, Highlighter } from "shiki";

import { pathToShikiLang } from "../diffLanguage";
import { useDiffShikiTheme, useShikiHighlighter } from "../diffShiki";
import type { ConflictRange, ConflictVersionPreview } from "../gitTypes";

type ConflictSnippetRow = {
  key: string;
  lineNumber: number | null;
  text: string;
  highlighted: boolean;
  placeholder?: boolean;
};

type ConflictSnippet = {
  conflictIndex: number;
  hiddenBefore: number;
  hiddenAfter: number;
  lineLabel: string;
  rows: ConflictSnippetRow[];
};

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

function splitLines(text: string): string[] {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

function buildConflictSnippets(
  text: string,
  ranges: ConflictRange[],
  contextLines = 3,
): ConflictSnippet[] {
  const lines = splitLines(text);
  return ranges.map((range) => {
    const visibleAnchor =
      lines.length === 0 ? 1 : Math.min(Math.max(range.startLine, 1), Math.max(lines.length, 1));
    const highlightStart = range.isEmpty ? visibleAnchor : range.startLine;
    const highlightEnd = range.isEmpty ? visibleAnchor : range.endLine;
    const sliceStart = lines.length === 0 ? 1 : Math.max(1, highlightStart - contextLines);
    const sliceEnd = lines.length === 0 ? 0 : Math.min(lines.length, highlightEnd + contextLines);
    const rows: ConflictSnippetRow[] = [];

    if (lines.length === 0) {
      rows.push({
        key: `conflict-${range.conflictIndex}-empty-file`,
        lineNumber: null,
        text: "This version is empty.",
        highlighted: true,
        placeholder: true,
      });
    } else {
      for (let lineNumber = sliceStart; lineNumber <= sliceEnd; lineNumber += 1) {
        const textLine = lines[lineNumber - 1] ?? "";
        const highlighted =
          !range.isEmpty && lineNumber >= range.startLine && lineNumber <= range.endLine;
        rows.push({
          key: `conflict-${range.conflictIndex}-line-${lineNumber}`,
          lineNumber,
          text: textLine,
          highlighted,
        });
      }

      if (range.isEmpty) {
        const insertIndex = Math.max(
          0,
          Math.min(rows.length, visibleAnchor > sliceStart ? visibleAnchor - sliceStart : 0),
        );
        rows.splice(insertIndex, 0, {
          key: `conflict-${range.conflictIndex}-empty-range`,
          lineNumber: null,
          text: "This side has no lines in this conflict block.",
          highlighted: true,
          placeholder: true,
        });
      }
    }

    const lineLabel = range.isEmpty
      ? "No lines on this side"
      : range.startLine === range.endLine
        ? `Line ${range.startLine}`
        : `Lines ${range.startLine}-${range.endLine}`;

    return {
      conflictIndex: range.conflictIndex,
      hiddenBefore: lines.length === 0 ? 0 : Math.max(0, sliceStart - 1),
      hiddenAfter: lines.length === 0 ? 0 : Math.max(0, lines.length - sliceEnd),
      lineLabel,
      rows,
    };
  });
}

function ConflictCodeRow({
  row,
  lang,
  highlighter,
  shikiTheme,
}: {
  row: ConflictSnippetRow;
  lang: string | null;
  highlighter: Highlighter | null;
  shikiTheme: "github-light" | "github-dark";
}) {
  const lineTokens = useMemo(() => {
    if (row.placeholder || !highlighter || !lang) return null;
    try {
      const tokenRow = highlighter.codeToTokens(row.text.length === 0 ? " " : row.text, {
        lang: lang as BundledLanguage,
        theme: shikiTheme,
        tokenizeMaxLineLength: 12000,
      }).tokens[0];
      return tokenRow?.length ? tokenRow : null;
    } catch {
      return null;
    }
  }, [highlighter, lang, row.placeholder, row.text, shikiTheme]);

  return (
    <div className="grid w-full min-w-0 grid-cols-[minmax(4ch,7ch)_minmax(0,1fr)] font-mono text-[0.8125rem] leading-relaxed text-(--diff-text-color)">
      <div
        className={`diff-gutter diff-line px-1 py-0 text-right select-none ${
          row.highlighted ? "diff-gutter-selected" : ""
        }`}
        aria-hidden
      >
        {row.lineNumber ?? ""}
      </div>
      <pre
        className={`diff-line m-0 min-h-0 min-w-0 overflow-x-auto border-0 py-0 pr-2 pl-2 [word-break:break-word] whitespace-pre-wrap ${
          row.highlighted ? "diff-code-selected" : "diff-code-normal"
        } ${row.placeholder ? "text-base-content/70 italic" : ""}`}
      >
        {row.placeholder
          ? row.text
          : lineTokens
            ? lineTokens.map((tok, index) => (
                <span key={index} style={shikiTokenStyleToReact(getTokenStyleObject(tok))}>
                  {tok.content}
                </span>
              ))
            : row.text.length === 0
              ? " "
              : row.text}
      </pre>
    </div>
  );
}

function ConflictSnippetCard({
  snippet,
  lang,
  highlighter,
  shikiTheme,
}: {
  snippet: ConflictSnippet;
  lang: string | null;
  highlighter: Highlighter | null;
  shikiTheme: "github-light" | "github-dark";
}) {
  return (
    <section className="overflow-hidden rounded-lg border border-base-300/80 bg-base-100/40">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-base-300/80 bg-base-200/60 px-3 py-2">
        <div className="text-[0.68rem] font-semibold tracking-wide text-base-content/65 uppercase">
          Conflict {snippet.conflictIndex}
        </div>
        <div className="text-[0.7rem] text-base-content/55">{snippet.lineLabel}</div>
      </div>
      {snippet.hiddenBefore > 0 ? (
        <div className="border-b border-base-300/60 px-3 py-1 text-[0.68rem] text-base-content/50">
          {snippet.hiddenBefore} unchanged line{snippet.hiddenBefore === 1 ? "" : "s"} above
        </div>
      ) : null}
      <div className="unified-diff-panel unified-diff-grid">
        {snippet.rows.map((row) => (
          <ConflictCodeRow
            key={row.key}
            row={row}
            lang={lang}
            highlighter={highlighter}
            shikiTheme={shikiTheme}
          />
        ))}
      </div>
      {snippet.hiddenAfter > 0 ? (
        <div className="border-t border-base-300/60 px-3 py-1 text-[0.68rem] text-base-content/50">
          {snippet.hiddenAfter} unchanged line{snippet.hiddenAfter === 1 ? "" : "s"} below
        </div>
      ) : null}
    </section>
  );
}

export const ConflictVersionPanel = memo(function ConflictVersionPanel({
  path,
  preview,
  ranges,
  actionLabel,
  actionKind = "outline",
  busy = false,
  onAction,
}: {
  path: string;
  preview: ConflictVersionPreview;
  ranges: ConflictRange[];
  actionLabel?: string;
  actionKind?: "primary" | "outline";
  busy?: boolean;
  onAction?: () => void;
}) {
  const highlighter = useShikiHighlighter();
  const shikiTheme = useDiffShikiTheme();
  const lang = useMemo(() => pathToShikiLang(path), [path]);
  const snippets = useMemo(() => {
    if (!preview.text || ranges.length === 0) return [];
    return buildConflictSnippets(preview.text, ranges);
  }, [preview.text, ranges]);

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-base-300/80 bg-base-200/35">
      <div className="flex items-start justify-between gap-2 border-b border-base-300/80 px-3 py-2">
        <div className="min-w-0">
          <div className="text-[0.65rem] font-semibold tracking-wide text-base-content/60 uppercase">
            {preview.label}
          </div>
          {!preview.deleted && !preview.isBinary && snippets.length > 0 ? (
            <p className="mt-1 mb-0 text-[0.72rem] text-base-content/55">
              Highlighting {snippets.length} conflict block{snippets.length === 1 ? "" : "s"} with
              nearby context.
            </p>
          ) : null}
        </div>
        {actionLabel && onAction ? (
          <button
            type="button"
            className={`btn btn-xs ${actionKind === "primary" ? "btn-primary" : "btn-outline"}`}
            disabled={busy}
            onClick={onAction}
          >
            {actionLabel}
          </button>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {preview.deleted ? (
          <p className="m-0 text-sm text-base-content/60">This choice deletes the file.</p>
        ) : preview.isBinary ? (
          <p className="m-0 text-sm text-base-content/60">
            Binary file preview is not available here.
          </p>
        ) : snippets.length > 0 ? (
          <div className="flex min-h-0 min-w-0 flex-col gap-3">
            {snippets.map((snippet) => (
              <ConflictSnippetCard
                key={`${preview.label}-${snippet.conflictIndex}`}
                snippet={snippet}
                lang={lang}
                highlighter={highlighter}
                shikiTheme={shikiTheme}
              />
            ))}
          </div>
        ) : (
          <div className="flex min-h-0 min-w-0 flex-col gap-3">
            <p className="m-0 text-xs leading-relaxed text-base-content/60">
              Inline conflict markers were not available for this file, so Garlic is showing the
              full version instead.
            </p>
            <pre className="m-0 font-mono text-[0.78rem] leading-relaxed wrap-break-word whitespace-pre-wrap text-base-content">
              {preview.text ?? ""}
            </pre>
          </div>
        )}
      </div>
    </section>
  );
});
