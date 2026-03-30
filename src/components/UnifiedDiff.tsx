import { getTokenStyleObject } from "@shikijs/core";
import { memo, useMemo, type CSSProperties, type ReactNode } from "react";
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
import type { BundledLanguage, Highlighter } from "shiki";

import { diffFileDisplayPath, pathToShikiLang } from "../diffLanguage";
import { buildChangeBlockPatchMap, buildHunkPatch, extractPatchHeaderLines } from "../diffPatch";
import { useDiffShikiTheme, useShikiHighlighter } from "../diffShiki";

/** Shiki returns CSS kebab-case keys; React `style` expects camelCase. */
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

export type BinaryImagePreview = {
  beforeUrl: string | null;
  afterUrl: string | null;
  fileLabel: string;
};

export type PartialDiffAction = {
  kind: "stage" | "unstage";
  busy?: boolean;
  onApplyPatch: (patch: string) => void;
};

export type HunkAction = {
  label: string;
  busy?: boolean;
  buttonClassName?: string;
  onApplyPatch: (patch: string) => void;
};

function BinaryImagePreview({ beforeUrl, afterUrl, fileLabel }: BinaryImagePreview) {
  return (
    <div className="unified-diff-binary-preview mb-3 flex min-w-0 flex-col gap-2 overflow-hidden border border-base-300/80 bg-base-200/30 p-2">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[0.65rem] text-base-content/60">
        <span className="font-mono wrap-break-word">{fileLabel}</span>
        <span className="shrink-0 tracking-wide uppercase opacity-60">Image preview</span>
      </div>
      <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="flex min-h-0 min-w-0 flex-col gap-1">
          <span className="text-[0.65rem] font-semibold tracking-wide text-base-content/50 uppercase">
            Before
          </span>
          <div className="flex max-h-[min(50vh,420px)] min-h-[120px] min-w-0 items-center justify-center overflow-auto bg-base-300/20 p-2">
            {beforeUrl ? (
              <img src={beforeUrl} alt="" className="max-h-full max-w-full object-contain" />
            ) : (
              <span className="text-xs text-base-content/40">—</span>
            )}
          </div>
        </div>
        <div className="flex min-h-0 min-w-0 flex-col gap-1">
          <span className="text-[0.65rem] font-semibold tracking-wide text-base-content/50 uppercase">
            After
          </span>
          <div className="flex max-h-[min(50vh,420px)] min-h-[120px] min-w-0 items-center justify-center overflow-auto bg-base-300/20 p-2">
            {afterUrl ? (
              <img src={afterUrl} alt="" className="max-h-full max-w-full object-contain" />
            ) : (
              <span className="text-xs text-base-content/40">—</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Git omits `---`/`+++` for some binary patches (e.g. new file). `gitdiff-parser` then never sets
 * `isBinary` (its outer `Binary files` handler never runs). Mark those files from the patch text.
 */
function enrichBinaryFilesFromGitBinaryMarker(files: FileData[], text: string): FileData[] {
  if (!/\bBinary files\b/.test(text)) return files;
  return files.map((f) => {
    if (f.isBinary === true || f.hunks.length > 0) return f;
    const path = diffFileDisplayPath(f);
    if (path) {
      const norm = path.replace(/\\/g, "/");
      const binaryIdx = text.indexOf("Binary files");
      if (binaryIdx >= 0) {
        const tail = text.slice(binaryIdx).replace(/\\/g, "/");
        if (tail.includes(norm) || tail.includes(`b/${norm}`) || tail.includes(`a/${norm}`)) {
          return { ...f, isBinary: true };
        }
      }
    }
    if (files.length === 1) {
      return { ...f, isBinary: true };
    }
    return f;
  });
}

/** Last resort when parse still yields nothing for a Git binary patch. */
function syntheticBinaryFileFromPatch(text: string): FileData {
  const m = /^diff --git a\/(.+?) b\/(.+?)$/m.exec(text);
  const newPath = m ? m[2].trim() : "";
  const oldPath = m ? m[1].trim() : "";
  return {
    type: "modify",
    hunks: [],
    isBinary: true,
    oldPath,
    newPath,
    oldRevision: "",
    newRevision: "",
    oldEndingNewLine: true,
    newEndingNewLine: true,
    oldMode: "",
    newMode: "",
  };
}

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

function DiffGridRow({
  change,
  lang,
  binary,
  highlighter,
  shikiTheme,
  partialAction,
  partialPatch,
}: {
  change: ChangeData;
  lang: string | null;
  binary: boolean;
  highlighter: Highlighter | null;
  shikiTheme: "github-light" | "github-dark";
  partialAction?: PartialDiffAction | null;
  partialPatch?: string | null;
}) {
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

  const content = change.content.length === 0 ? " " : change.content;
  const canApplyPartialPatch = Boolean(
    partialAction && partialPatch && (isInsert(change) || isDelete(change)),
  );
  const partialActionLabel = partialAction?.kind === "unstage" ? "−" : "+";
  const partialActionTitle =
    partialAction?.kind === "unstage" ? "Unstage this changed block" : "Stage this changed block";

  const lineTokens = useMemo(() => {
    if (binary || !highlighter || !lang) return null;
    try {
      const row = highlighter.codeToTokens(content, {
        lang: lang as BundledLanguage,
        theme: shikiTheme,
        tokenizeMaxLineLength: 12000,
      }).tokens[0];
      return row?.length ? row : null;
    } catch {
      return null;
    }
  }, [binary, content, highlighter, lang, shikiTheme]);

  return (
    <div
      className={`diff-grid-row grid w-full min-w-0 font-mono text-[0.8125rem] leading-relaxed text-(--diff-text-color) ${
        partialAction
          ? "grid-cols-[minmax(4ch,7ch)_minmax(4ch,7ch)_minmax(0,1fr)_2.25rem]"
          : "grid-cols-[minmax(4ch,7ch)_minmax(4ch,7ch)_minmax(0,1fr)]"
      }`}
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
        {lineTokens
          ? lineTokens.map((tok, i) => (
              <span key={i} style={shikiTokenStyleToReact(getTokenStyleObject(tok))}>
                {tok.content}
              </span>
            ))
          : content}
      </pre>
      {partialAction ? (
        <div className="flex items-start justify-center px-1 py-0.5">
          {canApplyPartialPatch ? (
            <button
              type="button"
              className="btn btn-square min-h-6 min-w-6 px-0 font-mono text-sm leading-none btn-ghost btn-xs"
              disabled={partialAction.busy}
              aria-label={partialActionTitle}
              title={partialActionTitle}
              onClick={() => {
                if (!partialPatch) return;
                partialAction.onApplyPatch(partialPatch);
              }}
            >
              {partialActionLabel}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function UnifiedDiffHunk({
  hunk,
  fileIndex,
  hunkIndex,
  lang,
  binary,
  headerLines,
  highlighter,
  shikiTheme,
  partialAction,
  secondaryHunkAction,
}: {
  hunk: HunkData;
  fileIndex: number;
  hunkIndex: number;
  lang: string | null;
  binary: boolean;
  headerLines: string[];
  highlighter: Highlighter | null;
  shikiTheme: "github-light" | "github-dark";
  partialAction?: PartialDiffAction | null;
  secondaryHunkAction?: HunkAction | null;
}) {
  const hunkPatch = useMemo(
    () => (!binary && partialAction ? buildHunkPatch(headerLines, hunk) : null),
    [binary, partialAction, headerLines, hunk],
  );
  const changeBlockPatches = useMemo(
    () => (!binary && partialAction ? buildChangeBlockPatchMap(headerLines, hunk) : new Map()),
    [binary, partialAction, headerLines, hunk],
  );
  const patchActionLabel = partialAction?.kind === "unstage" ? "Unstage hunk" : "Stage hunk";

  return (
    <div key={hunkKey(hunk, fileIndex, hunkIndex)} className="flex min-w-0 flex-col">
      <div className="diff-hunk-meta flex items-center justify-between gap-2 border-b border-base-300/80 px-2 py-1 font-mono text-[0.65rem] text-base-content/60 select-none">
        <span className="min-w-0 flex-1 truncate">{hunk.content.trim()}</span>
        {!binary && hunkPatch && (partialAction || secondaryHunkAction) ? (
          <div className="flex shrink-0 items-center gap-1">
            {secondaryHunkAction ? (
              <button
                type="button"
                className={`btn h-auto min-h-6 px-2 font-sans text-[0.65rem] tracking-normal btn-outline btn-xs ${
                  secondaryHunkAction.buttonClassName ?? "btn-ghost"
                }`}
                disabled={secondaryHunkAction.busy}
                onClick={() => {
                  secondaryHunkAction.onApplyPatch(hunkPatch);
                }}
              >
                {secondaryHunkAction.label}
              </button>
            ) : null}
            {partialAction ? (
              <button
                type="button"
                className={`btn h-auto min-h-6 px-2 font-sans text-[0.65rem] tracking-normal btn-outline btn-xs ${
                  partialAction.kind === "stage" ? "btn-success" : "btn-ghost"
                }`}
                disabled={partialAction.busy}
                onClick={() => {
                  partialAction.onApplyPatch(hunkPatch);
                }}
              >
                {patchActionLabel}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
      {hunk.changes.map((change) => {
        const partialPatchValue = (changeBlockPatches as Map<string, unknown>).get(
          getChangeKey(change),
        );
        return (
          <DiffGridRow
            key={getChangeKey(change)}
            change={change}
            lang={lang}
            binary={binary}
            highlighter={highlighter}
            shikiTheme={shikiTheme}
            partialAction={partialAction}
            partialPatch={typeof partialPatchValue === "string" ? partialPatchValue : null}
          />
        );
      })}
    </div>
  );
}

function UnifiedDiffFile({
  file,
  fileIndex,
  headerLines,
  highlighter,
  shikiTheme,
  hideBinaryEmptyHunkPlaceholder,
  partialAction,
  secondaryHunkAction,
}: {
  file: FileData;
  fileIndex: number;
  headerLines: string[];
  highlighter: Highlighter | null;
  shikiTheme: "github-light" | "github-dark";
  hideBinaryEmptyHunkPlaceholder: boolean;
  partialAction?: PartialDiffAction | null;
  secondaryHunkAction?: HunkAction | null;
}) {
  const path = diffFileDisplayPath(file);
  const lang = useMemo(() => pathToShikiLang(path), [path]);
  const binary = file.isBinary === true;

  if (file.isBinary === true && file.hunks.length === 0) {
    if (hideBinaryEmptyHunkPlaceholder) {
      return null;
    }
    return (
      <div className="unified-diff-file flex min-w-0 flex-col gap-0">
        <p className="m-0 px-2 py-1 text-xs text-base-content/60">
          Binary file (no line-by-line diff)
        </p>
      </div>
    );
  }

  return (
    <div className="unified-diff-file flex min-w-0 flex-col gap-0">
      {file.hunks.map((hunk, hi) => (
        <UnifiedDiffHunk
          key={hunkKey(hunk, fileIndex, hi)}
          hunk={hunk}
          fileIndex={fileIndex}
          hunkIndex={hi}
          lang={lang}
          binary={binary}
          headerLines={headerLines}
          highlighter={highlighter}
          shikiTheme={shikiTheme}
          partialAction={partialAction}
          secondaryHunkAction={secondaryHunkAction}
        />
      ))}
    </div>
  );
}

export const UnifiedDiff = memo(function UnifiedDiff({
  text,
  emptyLabel,
  binaryImagePreview,
  partialAction,
  secondaryHunkAction,
}: {
  text: string;
  emptyLabel: ReactNode;
  binaryImagePreview?: BinaryImagePreview | null;
  partialAction?: PartialDiffAction | null;
  secondaryHunkAction?: HunkAction | null;
}): ReactNode {
  const headerLines = useMemo(() => extractPatchHeaderLines(text), [text]);
  const parsed = useMemo(() => {
    const trimmed = text.trim();
    if (!trimmed) {
      return { kind: "empty" as const };
    }
    try {
      const files = parseDiff(text);
      const enriched = enrichBinaryFilesFromGitBinaryMarker(files, text);
      let withDiff = enriched.filter((f) => f.hunks.length > 0 || f.isBinary === true);
      if (withDiff.length === 0 && /\bBinary files\b/.test(text)) {
        withDiff = [syntheticBinaryFileFromPatch(text)];
      }
      if (withDiff.length > 0) {
        return { kind: "ok" as const, files: withDiff };
      }
      return { kind: "raw" as const };
    } catch {
      return { kind: "raw" as const };
    }
  }, [text]);

  if (parsed.kind === "empty") {
    return <span className="text-base-content/50">{emptyLabel}</span>;
  }

  const showImagePreview =
    binaryImagePreview &&
    (binaryImagePreview.beforeUrl != null || binaryImagePreview.afterUrl != null);

  if (parsed.kind === "raw") {
    if (showImagePreview) {
      return (
        <div className="w-full min-w-0">
          <BinaryImagePreview {...binaryImagePreview} />
          <p className="m-0 text-xs text-base-content/50">Binary file (no line diff)</p>
        </div>
      );
    }
    return (
      <pre className="m-0 font-mono text-[0.8125rem] leading-relaxed wrap-break-word whitespace-pre-wrap text-base-content">
        {text || emptyLabel}
      </pre>
    );
  }

  return (
    <div className="w-full min-w-0">
      {showImagePreview ? <BinaryImagePreview {...binaryImagePreview} /> : null}
      <UnifiedDiffWithHighlight
        parsedFiles={parsed.files}
        headerLines={headerLines}
        hideBinaryEmptyHunkPlaceholder={Boolean(showImagePreview)}
        partialAction={partialAction}
        secondaryHunkAction={secondaryHunkAction}
      />
    </div>
  );
});

function UnifiedDiffWithHighlight({
  parsedFiles,
  headerLines,
  hideBinaryEmptyHunkPlaceholder,
  partialAction,
  secondaryHunkAction,
}: {
  parsedFiles: FileData[];
  headerLines: string[];
  hideBinaryEmptyHunkPlaceholder: boolean;
  partialAction?: PartialDiffAction | null;
  secondaryHunkAction?: HunkAction | null;
}) {
  const highlighter = useShikiHighlighter();
  const shikiTheme = useDiffShikiTheme();

  return (
    <div className="unified-diff-panel unified-diff-grid block w-full min-w-0">
      <div className="w-full max-w-full min-w-0 overflow-x-auto">
        {parsedFiles.map((file, i) => (
          <UnifiedDiffFile
            key={fileKey(file, i)}
            file={file}
            fileIndex={i}
            headerLines={headerLines}
            highlighter={highlighter}
            shikiTheme={shikiTheme}
            hideBinaryEmptyHunkPlaceholder={hideBinaryEmptyHunkPlaceholder}
            partialAction={partialAction}
            secondaryHunkAction={secondaryHunkAction}
          />
        ))}
      </div>
    </div>
  );
}
