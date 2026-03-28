import {
  memo,
  type MouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { BranchSidebarSectionsState } from "./repoTypes";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ask, open, save } from "@tauri-apps/plugin-dialog";
import { formatAuthorDisplay, formatDate, formatRelativeShort } from "./appFormat";
import { collectLocalBranchNamesInSubtree, collectRemoteRefsInSubtree } from "./branchTrie";
import { BranchSidebar, type BranchGraphControls } from "./components/BranchSidebar";
import { CommitComposer } from "./components/CommitComposer";
import { CommitGraphSection } from "./components/CommitGraphSection";
import { GitCommandPanel } from "./components/GitCommandPanel";
import { OpenAiSettingsDialog } from "./components/OpenAiSettingsDialog";
import {
  UnifiedDiff,
  type BinaryImagePreview,
  type HunkAction,
  type PartialDiffAction,
} from "./components/UnifiedDiff";
import {
  computeCommitGraphLayout,
  type BranchTip,
  type CommitGraphLayout,
} from "./commitGraphLayout";
import { base64ToObjectUrl, mimeTypeForImagePath, pathLooksLikeRenderableImage } from "./diffImage";
import {
  nativeContextMenusAvailable,
  popupBranchContextMenu,
  popupFileRowContextMenu,
  popupGraphCommitContextMenu,
  popupGraphTagContextMenu,
  popupStashContextMenu,
  popupTagSidebarMenu,
  popupWorktreeContextMenu,
} from "./nativeContextMenu";
import type {
  CommitEntry,
  LocalBranchEntry,
  RemoteBranchEntry,
  StashEntry,
  TagEntry,
  TagOriginStatus,
  WorktreeEntry,
} from "./repoTypes";
import { DEFAULT_OPENAI_MODEL } from "./generateCommitMessage";
import { resolveThemePreference } from "./theme";
import {
  buildGraphExportDefaultFilename,
  filterGraphCommits,
  formatCommitsExportTxt,
  reachableCommitHashesFromHead,
} from "./graphCommitFilters";

export type {
  BranchSidebarSectionsState,
  CommitEntry,
  LocalBranchEntry,
  RemoteBranchEntry,
  StashEntry,
  TagEntry,
  TagOriginStatus,
  WorktreeEntry,
} from "./repoTypes";

/** How long to wait after `window-focused` before starting refresh (avoids stacking work on focus). */
const WINDOW_FOCUS_REFRESH_DELAY_MS = 250;

/** Initial row height for virtualized “files in commit” list (`measureElement` refines). */
const COMMIT_BROWSE_FILE_ROW_ESTIMATE_PX = 44;
/**
 * On window focus, skip `list_local_branches` / `list_remote_branches` unless HEAD changed or this
 * many ms have passed since the last full branch list refresh (reduces subprocess churn).
 */
const BRANCH_LIST_FULL_REFRESH_INTERVAL_MS = 45_000;

/** Remote name before `remote/branch` (e.g. `origin/main` → `origin`). */
function remoteNameFromRemoteRef(fullRef: string): string | null {
  const i = fullRef.indexOf("/");
  if (i <= 0) return null;
  return fullRef.slice(0, i);
}

/** Close only when mousedown and mouseup both happen on the backdrop (not after text-selection drags). */
function useDialogBackdropClose() {
  const downOnBackdrop = useRef(false);
  const onMouseDown = useCallback((e: MouseEvent<HTMLDialogElement>) => {
    downOnBackdrop.current = e.target === e.currentTarget;
  }, []);
  const onMouseUp = useCallback((e: MouseEvent<HTMLDialogElement>) => {
    if (e.target === e.currentTarget && downOnBackdrop.current) {
      e.currentTarget.close();
    }
    downOnBackdrop.current = false;
  }, []);
  return { onMouseDown, onMouseUp };
}

function useLatest<T>(value: T) {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  }, [value]);
  return ref;
}

interface RemoteEntry {
  name: string;
  fetchUrl: string;
}

interface RepoMetadata {
  path: string;
  name: string;
  gitRoot: string | null;
  error: string | null;
  branch: string | null;
  /** Full `HEAD` OID; used to scope export to the checked-out branch. */
  headHash?: string | null;
  headShort: string | null;
  headSubject: string | null;
  headAuthor: string | null;
  headDate: string | null;
  detached: boolean;
  remotes: RemoteEntry[];
  workingTreeClean: boolean | null;
  ahead: number | null;
  behind: number | null;
}

interface GraphCommitsPage {
  commits: CommitEntry[];
  hasMore: boolean;
}

/** Emitted during `start_clone_repository` (`git clone --progress` stderr). */
interface CloneProgressPayload {
  sessionId: number;
  message: string;
  percent?: number | null;
}

/** Emitted when a background clone finishes (`start_clone_repository`). */
interface CloneDonePayload {
  sessionId: number;
  path?: string | null;
  error?: string | null;
}

/** Largest `NN%` in a line (matches Rust `parse_git_clone_progress_percent`). */
function parseGitCloneProgressPercent(line: string): number | null {
  let best: number | null = null;
  for (const token of line.split(/\s+/)) {
    const t = token.replace(/[,;).]+$/, "");
    if (t.endsWith("%")) {
      const n = Number.parseInt(t.slice(0, -1), 10);
      if (!Number.isNaN(n)) {
        const v = Math.min(100, Math.max(0, n));
        best = best === null ? v : Math.max(best, v);
      }
    }
  }
  return best;
}

/** Emitted after `start_commit_signature_check` (Rust thread; does not block invoke). */
interface CommitSignatureResultPayload {
  path: string;
  commitHash: string;
  requestId: number;
  verified: boolean | null;
}

/** Hook-heavy git subprocess (`run_git_streaming`): command line + live stdout/stderr. */
interface GitCommandStreamStartedPayload {
  sessionId: number;
  repoPath: string;
  operation: string;
  commandLine: string;
}

interface GitCommandStreamLinePayload {
  sessionId: number;
  repoPath: string;
  operation: string;
  stream: string;
  line: string;
}

interface GitCommandStreamFinishedPayload {
  sessionId: number;
  repoPath: string;
  operation: string;
  success: boolean;
  error?: string | null;
}

/** Line counts from `git diff --numstat` / `--cached` (or file read for untracked). */
export interface LineStat {
  additions: number;
  deletions: number;
  isBinary: boolean;
}

/** One file changed in a commit from `list_commit_files`. */
export interface CommitFileEntry {
  path: string;
  stats: LineStat;
}

interface CommitCoAuthor {
  name: string;
  email: string;
}

interface CommitDetails {
  hash: string;
  shortHash: string;
  subject: string;
  body: string;
  author: string;
  authorEmail: string;
  authorDate: string;
  committer: string;
  committerEmail: string;
  committerDate: string;
  parentHashes: string[];
  coAuthors: CommitCoAuthor[];
}

/** Raw bytes for diff image preview (`get_*_file_blob_pair`). */
interface FileBlobPair {
  beforeBase64: string | null;
  afterBase64: string | null;
}

function blobPairToPreviewUrls(
  pair: FileBlobPair,
  filePath: string,
): {
  before: string | null;
  after: string | null;
} {
  const mime = mimeTypeForImagePath(filePath);
  return {
    before: base64ToObjectUrl(pair.beforeBase64, mime),
    after: base64ToObjectUrl(pair.afterBase64, mime),
  };
}

/** One path in the working tree from `list_working_tree_files` / bootstrap. */
export interface WorkingTreeFile {
  path: string;
  renameFrom?: string | null;
  staged: boolean;
  unstaged: boolean;
  stagedStats?: LineStat;
  unstagedStats?: LineStat;
}

/** Repo snapshot from `restore_app_bootstrap` (`repo` field). */
export interface RestoreLastRepo {
  loadError: string | null;
  metadata: RepoMetadata | null;
  localBranches: LocalBranchEntry[];
  remoteBranches: RemoteBranchEntry[];
  worktrees: WorktreeEntry[];
  tags: TagEntry[];
  stashes: StashEntry[];
  commits: CommitEntry[];
  graphCommitsHasMore: boolean;
  workingTreeFiles: WorkingTreeFile[];
  listsError: string | null;
}

/** Rules aligned with `git check-ref-format --branch` for short branch names. */
function branchNameValidationError(name: string): string | null {
  if (name.length === 0) return null;
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    if (c <= 0x20 || c === 0x7f) {
      return "Branch names cannot contain spaces or control characters.";
    }
  }
  if (/[~^:?*[\]\\]/.test(name)) {
    return "Branch names cannot contain ~ ^ : ? * [ ] \\.";
  }
  if (name.includes("..")) {
    return 'Branch names cannot contain "..".';
  }
  if (name.includes("@{")) {
    return 'Branch names cannot contain "@{".';
  }
  if (name.startsWith("/") || name.endsWith("/")) {
    return 'Branch names cannot start or end with "/".';
  }
  if (name.includes("//")) {
    return 'Branch names cannot contain "//".';
  }
  if (name.endsWith(".lock")) {
    return 'Branch names cannot end with ".lock".';
  }
  if (name.endsWith(".")) {
    return 'Branch names cannot end with ".".';
  }
  if (name.startsWith(".")) {
    return 'Branch names cannot start with ".".';
  }
  if (name.startsWith("-")) {
    return 'Branch names cannot start with "-".';
  }
  return null;
}

function tagNameValidationError(name: string): string | null {
  const err = branchNameValidationError(name);
  if (err === null) return null;
  return err.replace(/Branch names/g, "Tag names");
}

/** Tauri `invoke` may reject with a string or a non-Error object; normalize for display. */
function invokeErrorMessage(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  if (e !== null && typeof e === "object" && "message" in e) {
    const m = (e as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  return String(e);
}

function stripCoAuthorTrailers(body: string): string {
  const lines = body.split(/\r?\n/);
  const kept = lines.filter((line) => !line.trim().startsWith("Co-authored-by:"));
  while (kept.length > 0 && kept[kept.length - 1]?.trim() === "") kept.pop();
  return kept.join("\n").trim();
}

function DismissibleAlert({
  role = "alert",
  className,
  children,
  onDismiss,
}: {
  role?: "alert" | "status";
  className: string;
  children: ReactNode;
  onDismiss: () => void;
}) {
  return (
    <div role={role} className={`${className} flex flex-row items-start gap-2`}>
      <div className="min-w-0 flex-1">{children}</div>
      <button
        type="button"
        className="btn btn-square shrink-0 opacity-80 btn-ghost btn-sm hover:opacity-100"
        aria-label="Dismiss"
        onClick={onDismiss}
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          className="h-4 w-4"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}

function DiffLineStatBadge({ stat }: { stat: LineStat }) {
  if (stat.isBinary) {
    return (
      <span className="shrink-0 text-[0.65rem] text-base-content/50 tabular-nums">binary</span>
    );
  }
  return (
    <span
      className="shrink-0 text-[0.65rem] leading-none tabular-nums"
      title={`${stat.additions} insertions, ${stat.deletions} deletions`}
    >
      <span className="text-success">+{stat.additions}</span>{" "}
      <span className="text-error">−{stat.deletions}</span>
    </span>
  );
}

function combineLineStats(a?: LineStat, b?: LineStat): LineStat | undefined {
  if (!a) return b ? { ...b } : undefined;
  if (!b) return { ...a };
  if (a.isBinary || b.isBinary) {
    return { additions: 0, deletions: 0, isBinary: true };
  }
  return {
    additions: a.additions + b.additions,
    deletions: a.deletions + b.deletions,
    isBinary: false,
  };
}

function applyOptimisticStageChange(
  files: WorkingTreeFile[],
  paths: readonly string[],
  direction: "stage" | "unstage",
): WorkingTreeFile[] {
  const pathSet = new Set(paths);
  return files.map((file) => {
    if (!pathSet.has(file.path)) return file;
    if (direction === "stage") {
      return {
        ...file,
        staged: file.staged || file.unstaged,
        unstaged: false,
        stagedStats: file.unstaged
          ? combineLineStats(file.stagedStats, file.unstagedStats)
          : file.stagedStats,
        unstagedStats: undefined,
      };
    }
    return {
      ...file,
      staged: false,
      unstaged: file.unstaged || file.staged,
      stagedStats: undefined,
      unstagedStats: file.staged
        ? combineLineStats(file.unstagedStats, file.stagedStats)
        : file.unstagedStats,
    };
  });
}

function StagePanelLineStats({
  variant,
  f,
}: {
  variant: "unstaged" | "staged";
  f: WorkingTreeFile;
}) {
  const s = variant === "unstaged" ? f.unstagedStats : f.stagedStats;
  if (!s) return null;
  return <DiffLineStatBadge stat={s} />;
}

const StagePanelFileRow = memo(function StagePanelFileRow({
  f,
  selected,
  busy,
  variant,
  onSelect,
  onStage,
  onUnstage,
  onFileContextMenu,
}: {
  f: WorkingTreeFile;
  selected: boolean;
  busy: boolean;
  variant: "unstaged" | "staged";
  onSelect: () => void;
  onStage: () => void;
  onUnstage: () => void;
  /** Right-click: history / blame / discard (worktree). */
  onFileContextMenu?: (
    path: string,
    variant: "staged" | "unstaged",
    clientX: number,
    clientY: number,
  ) => void;
}) {
  const selectable = f.staged || f.unstaged;
  return (
    <li
      role={selectable ? "button" : undefined}
      tabIndex={selectable ? 0 : undefined}
      className={`rounded-md border bg-base-200/80 px-2 py-1 ${
        selectable
          ? `cursor-pointer transition-colors hover:bg-base-300/50 ${
              selected ? "border-primary ring-1 ring-primary/40" : "border-base-300"
            }`
          : "border-base-300"
      }`}
      onClick={() => {
        if (!selectable) return;
        onSelect();
      }}
      onKeyDown={(e) => {
        if (!selectable) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      onContextMenu={
        onFileContextMenu
          ? (e) => {
              if (!nativeContextMenusAvailable()) return;
              e.preventDefault();
              e.stopPropagation();
              onFileContextMenu(f.path, variant, e.clientX, e.clientY);
            }
          : undefined
      }
    >
      <div className="flex min-h-7 items-center gap-2">
        <code className="min-w-0 flex-1 font-mono text-[0.7rem] leading-snug wrap-break-word text-base-content">
          {f.renameFrom ? `${f.renameFrom} → ${f.path}` : f.path}
        </code>
        <StagePanelLineStats variant={variant} f={f} />
        <div className="flex shrink-0 items-center gap-0.5">
          {variant === "unstaged" && f.unstaged ? (
            <button
              type="button"
              className="btn btn-square min-h-7 min-w-7 px-0 font-mono text-sm leading-none btn-xs btn-primary"
              disabled={busy}
              aria-label={`Stage ${f.path}`}
              title="Stage"
              onClick={(e) => {
                e.stopPropagation();
                onStage();
              }}
            >
              +
            </button>
          ) : null}
          {variant === "staged" && f.staged ? (
            <button
              type="button"
              className="btn btn-square min-h-7 min-w-7 px-0 font-mono text-sm leading-none btn-ghost btn-xs"
              disabled={busy}
              aria-label={`Unstage ${f.path}`}
              title="Unstage"
              onClick={(e) => {
                e.stopPropagation();
                onUnstage();
              }}
            >
              −
            </button>
          ) : null}
        </div>
      </div>
    </li>
  );
});

function MetaRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[8.5rem_1fr] items-baseline gap-x-4 gap-y-2 text-sm">
      <dt className="m-0 font-semibold text-base-content/70">{label}</dt>
      <dd className="m-0 min-w-0 wrap-break-word text-base-content">{children}</dd>
    </div>
  );
}

const StandaloneDiffPane = memo(function StandaloneDiffPane({
  path,
  side,
  diffLoading,
  diffError,
  onDismissDiffError,
  onBack,
  stagedText,
  unstagedText,
  stagedImagePreview,
  unstagedImagePreview,
  stagedAction,
  unstagedAction,
  discardAction,
}: {
  path: string;
  side: "unstaged" | "staged" | null;
  diffLoading: boolean;
  diffError: string | null;
  onDismissDiffError: () => void;
  onBack: () => void;
  stagedText: string | null;
  unstagedText: string | null;
  stagedImagePreview: BinaryImagePreview | null;
  unstagedImagePreview: BinaryImagePreview | null;
  stagedAction: PartialDiffAction | null;
  unstagedAction: PartialDiffAction | null;
  discardAction: HunkAction | null;
}) {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 px-4 pt-3 pb-4">
      <div className="flex shrink-0 flex-wrap items-start justify-between gap-3 border-b border-base-300 pb-3">
        <div className="min-w-0">
          <h2 className="m-0 font-mono text-sm font-semibold tracking-wide text-base-content opacity-90">
            Diff
          </h2>
          <code className="mt-1 block font-mono text-xs wrap-break-word text-base-content/80">
            {path}
          </code>
          {side ? (
            <p className="mt-1 mb-0 text-xs text-base-content/65">
              {side === "staged" ? "Staged changes" : "Unstaged changes"}
            </p>
          ) : null}
        </div>
        <button type="button" className="btn shrink-0 btn-sm btn-primary" onClick={onBack}>
          Back to commits
        </button>
      </div>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {diffLoading ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 py-20">
            <span className="loading loading-md loading-spinner text-primary" />
            <p className="m-0 text-sm text-base-content/70">Loading diff…</p>
          </div>
        ) : diffError ? (
          <DismissibleAlert className="alert text-sm alert-error" onDismiss={onDismissDiffError}>
            <span className="wrap-break-word">{diffError}</span>
          </DismissibleAlert>
        ) : (
          <div className="min-h-0 w-full min-w-0 flex-1 overflow-auto rounded-lg border border-base-300 bg-base-200/40 p-4">
            {stagedText !== null ? (
              <div className="mb-8 last:mb-0">
                <div className="m-0 mb-2 text-xs font-semibold tracking-wide uppercase opacity-70">
                  Staged
                </div>
                <UnifiedDiff
                  text={stagedText}
                  emptyLabel="(no staged diff)"
                  binaryImagePreview={stagedImagePreview}
                  partialAction={stagedAction}
                />
              </div>
            ) : null}
            {unstagedText !== null ? (
              <div>
                <div className="m-0 mb-2 text-xs font-semibold tracking-wide uppercase opacity-70">
                  Unstaged
                </div>
                <UnifiedDiff
                  text={unstagedText}
                  emptyLabel="(no unstaged diff)"
                  binaryImagePreview={unstagedImagePreview}
                  partialAction={unstagedAction}
                  secondaryHunkAction={discardAction}
                />
              </div>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
});

const FileBlamePane = memo(function FileBlamePane({
  path,
  loading,
  error,
  text,
  onBack,
  onDismissError,
}: {
  path: string;
  loading: boolean;
  error: string | null;
  text: string | null;
  onBack: () => void;
  onDismissError: () => void;
}) {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 px-4 pt-3 pb-4">
      <div className="flex shrink-0 flex-wrap items-start justify-between gap-3 border-b border-base-300 pb-3">
        <div className="min-w-0">
          <h2 className="m-0 text-[0.65rem] font-semibold tracking-wide text-base-content/50 uppercase">
            Blame
          </h2>
          <code className="mt-1 block font-mono text-xs wrap-break-word text-base-content/85">
            {path}
          </code>
        </div>
        <button type="button" className="btn shrink-0 btn-sm btn-primary" onClick={onBack}>
          Back to commits
        </button>
      </div>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {loading ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 py-20">
            <span className="loading loading-md loading-spinner text-primary" />
            <p className="m-0 text-sm text-base-content/70">Loading blame…</p>
          </div>
        ) : error ? (
          <DismissibleAlert className="alert text-sm alert-error" onDismiss={onDismissError}>
            <span className="wrap-break-word">{error}</span>
          </DismissibleAlert>
        ) : (
          <pre className="min-h-0 w-full min-w-0 flex-1 overflow-auto rounded-lg border border-base-300 bg-base-200/40 p-3 font-mono text-[0.7rem] leading-snug wrap-break-word whitespace-pre">
            {text ?? ""}
          </pre>
        )}
      </div>
    </div>
  );
});

const FileHistoryPane = memo(function FileHistoryPane({
  path,
  loading,
  error,
  commits,
  onBack,
  onDismissError,
  onPickCommit,
}: {
  path: string;
  loading: boolean;
  error: string | null;
  commits: CommitEntry[];
  onBack: () => void;
  onDismissError: () => void;
  onPickCommit: (hash: string) => void;
}) {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 px-4 pt-3 pb-4">
      <div className="flex shrink-0 flex-wrap items-start justify-between gap-3 border-b border-base-300 pb-3">
        <div className="min-w-0">
          <h2 className="m-0 text-[0.65rem] font-semibold tracking-wide text-base-content/50 uppercase">
            File history
          </h2>
          <code className="mt-1 block font-mono text-xs wrap-break-word text-base-content/85">
            {path}
          </code>
          <p className="mt-1 mb-0 text-xs text-base-content/60">
            Commits that touched this path (newest first). Click a row to open the diff for that
            revision.
          </p>
        </div>
        <button type="button" className="btn shrink-0 btn-sm btn-primary" onClick={onBack}>
          Back to commits
        </button>
      </div>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {loading ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 py-20">
            <span className="loading loading-md loading-spinner text-primary" />
            <p className="m-0 text-sm text-base-content/70">Loading history…</p>
          </div>
        ) : error ? (
          <DismissibleAlert className="alert text-sm alert-error" onDismiss={onDismissError}>
            <span className="wrap-break-word">{error}</span>
          </DismissibleAlert>
        ) : commits.length === 0 ? (
          <p className="m-0 text-center text-sm text-base-content/60">
            No commits found for this file
          </p>
        ) : (
          <ul className="m-0 flex min-h-0 flex-1 list-none flex-col gap-1.5 overflow-y-auto pr-0.5">
            {commits.map((commit) => (
              <li key={commit.hash}>
                <button
                  type="button"
                  className="flex w-full flex-col gap-0.5 rounded-lg border border-base-300/50 bg-base-200/40 px-3 py-2 text-left transition-colors hover:border-base-300 hover:bg-base-300/35"
                  onClick={() => {
                    onPickCommit(commit.hash);
                  }}
                >
                  <span className="font-mono text-[0.65rem] text-base-content/70">
                    {commit.shortHash}
                  </span>
                  <span className="text-sm leading-snug text-base-content/95">
                    {commit.subject}
                  </span>
                  <span className="text-[0.65rem] text-base-content/55">
                    {formatAuthorDisplay(commit.author)} ·{" "}
                    {formatRelativeShort(commit.date) ?? formatDate(commit.date) ?? "—"}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
});

export default function App({
  startup,
  themePreference: initialThemePreference,
  openaiApiKey: initialOpenaiApiKey,
  openaiModel: initialOpenaiModel,
  branchSidebarSections: initialBranchSidebarSections,
}: {
  startup: RestoreLastRepo;
  /** Persisted value: `auto` or a DaisyUI theme name. */
  themePreference: string;
  /** Saved OpenAI API key for AI commit messages (may be empty). */
  openaiApiKey: string | null;
  /** OpenAI model id for commit suggestions (defaults to `gpt-5.4-mini`). */
  openaiModel: string;
  /** Which branch-sidebar panels are expanded (persisted in settings). */
  branchSidebarSections: BranchSidebarSectionsState;
}) {
  const [themePreference, setThemePreference] = useState(initialThemePreference);
  const [branchSidebarSections, setBranchSidebarSections] = useState<BranchSidebarSectionsState>(
    () => ({ ...initialBranchSidebarSections }),
  );
  const [repo, setRepo] = useState<RepoMetadata | null>(() => startup.metadata ?? null);
  /** Guards async work: ignore results if `repo.path` changed while awaiting (e.g. refresh vs. open other repo). */
  const activeRepoPathRef = useRef<string | null>(null);
  activeRepoPathRef.current = repo?.path ?? null;
  /** Latest `loadRepo` target; supersede in-flight loads when opening another path. */
  const pendingLoadRepoRef = useRef<string | null>(null);
  /** Bumps when clearing browse or starting a new commit selection — drops stale `selectCommit` completions. */
  const selectCommitSeqRef = useRef(0);
  const [loadError, setLoadError] = useState<string | null>(() => startup.loadError ?? null);
  /** Mutations (checkout, commit, refresh, …) while a repo is open — shown inline, not as a full-panel error. */
  const [operationError, setOperationError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  /** Set while a clone runs; `listen("clone-progress")` updates this for the progress bar. */
  const [cloneProgress, setCloneProgress] = useState<{
    message: string;
    percent: number | null;
  } | null>(null);
  /** Lines shown in the fixed-height clone log (throttled updates). */
  const [cloneLogLines, setCloneLogLines] = useState<string[]>([]);
  /** Set when a clone succeeds; user must click Open before `loadRepo` runs. */
  const [cloneReadyPath, setCloneReadyPath] = useState<string | null>(null);
  /** Matches `start_clone_repository` return value; filters `clone-progress` / `clone-complete`. */
  const pendingCloneSessionRef = useRef<number | null>(null);
  /** `clone-complete` can arrive before `invoke` resolves; flush after session id is known. */
  const cloneCompleteQueuedRef = useRef<CloneDonePayload | null>(null);
  const cloneLogLinesRef = useRef<string[]>([]);
  const cloneProgressMaxPercentRef = useRef<number | null>(null);
  const cloneProgressRafRef = useRef<number | null>(null);
  const cloneLogScrollRef = useRef<HTMLDivElement | null>(null);
  /** Live output from `run_git_streaming` (commit, push, hooks, etc.). */
  const [gitCommandStream, setGitCommandStream] = useState<{
    sessionId: number;
    operation: string;
    commandLine: string;
    lines: { stream: string; text: string }[];
    finished: boolean;
    success: boolean | null;
    error: string | null;
  } | null>(null);
  const gitCommandStreamScrollRef = useRef<HTMLDivElement | null>(null);
  const gitStreamSessionRef = useRef<number | null>(null);
  const [localBranches, setLocalBranches] = useState<LocalBranchEntry[]>(
    () => startup.localBranches,
  );
  const [remoteBranches, setRemoteBranches] = useState<RemoteBranchEntry[]>(
    () => startup.remoteBranches,
  );
  const [worktrees, setWorktrees] = useState<WorktreeEntry[]>(() => startup.worktrees);
  const [tags, setTags] = useState<TagEntry[]>(() => startup.tags);
  const [stashes, setStashes] = useState<StashEntry[]>(() => startup.stashes);
  const [commits, setCommits] = useState<CommitEntry[]>(() => startup.commits);
  const [graphCommitsHasMore, setGraphCommitsHasMore] = useState(() => startup.graphCommitsHasMore);
  const [loadingMoreGraphCommits, setLoadingMoreGraphCommits] = useState(false);
  /** `local:name` / `remote:name` → visible in commit graph (default true when key missing). */
  const [graphBranchVisible, setGraphBranchVisible] = useState<Record<string, boolean>>({});
  /** Graph list filters (client-side; does not change loaded commit pages). */
  const [graphAuthorFilter, setGraphAuthorFilter] = useState("");
  const [graphDateFrom, setGraphDateFrom] = useState("");
  const [graphDateTo, setGraphDateTo] = useState("");
  const [workingTreeFiles, setWorkingTreeFiles] = useState<WorkingTreeFile[]>(
    () => startup.workingTreeFiles,
  );
  const [branchBusy, setBranchBusy] = useState<string | null>(null);
  /** `push` or `pop:<ref>` while a stash command runs. */
  const [stashBusy, setStashBusy] = useState<string | null>(null);
  const [listsError, setListsError] = useState<string | null>(() => startup.listsError ?? null);
  const [selectedDiffPath, setSelectedDiffPath] = useState<string | null>(null);
  /** Which sidebar list opened the diff (staged vs unstaged); matters when both apply to the same path. */
  const [selectedDiffSide, setSelectedDiffSide] = useState<"unstaged" | "staged" | null>(null);
  const [selectedDiffRepoPath, setSelectedDiffRepoPath] = useState<string | null>(null);
  const [diffStagedText, setDiffStagedText] = useState<string | null>(null);
  const [diffUnstagedText, setDiffUnstagedText] = useState<string | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [worktreeBrowseTarget, setWorktreeBrowseTarget] = useState<WorktreeEntry | null>(null);
  const [worktreeBrowseFiles, setWorktreeBrowseFiles] = useState<WorkingTreeFile[]>([]);
  const [worktreeBrowseLoading, setWorktreeBrowseLoading] = useState(false);
  const [worktreeBrowseError, setWorktreeBrowseError] = useState<string | null>(null);
  const [commitBrowseHash, setCommitBrowseHash] = useState<string | null>(null);
  const [commitBrowseFiles, setCommitBrowseFiles] = useState<CommitFileEntry[]>([]);
  const [commitBrowseLoading, setCommitBrowseLoading] = useState(false);
  const [commitBrowseError, setCommitBrowseError] = useState<string | null>(null);
  const [commitDetails, setCommitDetails] = useState<CommitDetails | null>(null);
  const [commitDetailsLoading, setCommitDetailsLoading] = useState(false);
  const [commitDetailsError, setCommitDetailsError] = useState<string | null>(null);
  const [commitDetailsExpanded, setCommitDetailsExpanded] = useState(false);
  const [commitSignature, setCommitSignature] = useState<{
    loading: boolean;
    verified: boolean | null;
  }>({ loading: false, verified: null });
  const [commitDiffPath, setCommitDiffPath] = useState<string | null>(null);
  const [commitDiffText, setCommitDiffText] = useState<string | null>(null);
  const [commitDiffLoading, setCommitDiffLoading] = useState(false);
  const [commitDiffError, setCommitDiffError] = useState<string | null>(null);
  /** Object URLs for binary image preview in commit diff (revoked on change). */
  const [commitDiffImagePreview, setCommitDiffImagePreview] = useState<{
    before: string | null;
    after: string | null;
  } | null>(null);
  /** Object URLs for staged/unstaged image preview. */
  const [diffImagePreview, setDiffImagePreview] = useState<{
    before: string | null;
    after: string | null;
  } | null>(null);
  const [stageCommitBusy, setStageCommitBusy] = useState(false);
  const [syncingStagePaths, setSyncingStagePaths] = useState<Set<string>>(() => new Set());
  const [pushBusy, setPushBusy] = useState(false);
  const [commitPushBusy, setCommitPushBusy] = useState(false);
  /** Skip local Git hooks (e.g. pre-push) for push actions. */
  const [graphFocusHash, setGraphFocusHash] = useState<string | null>(null);
  const [graphScrollNonce, setGraphScrollNonce] = useState(0);
  const [fileHistoryPath, setFileHistoryPath] = useState<string | null>(null);
  const [fileHistoryCommits, setFileHistoryCommits] = useState<CommitEntry[]>([]);
  const [fileHistoryLoading, setFileHistoryLoading] = useState(false);
  const [fileHistoryError, setFileHistoryError] = useState<string | null>(null);
  const [fileBlamePath, setFileBlamePath] = useState<string | null>(null);
  const [fileBlameText, setFileBlameText] = useState<string | null>(null);
  const [fileBlameLoading, setFileBlameLoading] = useState(false);
  const [fileBlameError, setFileBlameError] = useState<string | null>(null);
  const inspectorFileCount = worktreeBrowseTarget
    ? worktreeBrowseFiles.length
    : commitBrowseFiles.length;
  const createBranchDialogRef = useRef<HTMLDialogElement>(null);
  const commitBrowseFileListScrollRef = useRef<HTMLDivElement>(null);
  const commitBrowseFileVirtualizer = useVirtualizer({
    count: inspectorFileCount,
    getScrollElement: () => commitBrowseFileListScrollRef.current,
    estimateSize: () => COMMIT_BROWSE_FILE_ROW_ESTIMATE_PX,
    overscan: 12,
  });
  const cloneRepoDialogRef = useRef<HTMLDialogElement>(null);
  const cloneRepoUrlInputRef = useRef<HTMLInputElement>(null);
  const [cloneRepoUrlDraft, setCloneRepoUrlDraft] = useState("https://github.com/");
  const newBranchInputRef = useRef<HTMLInputElement>(null);
  const editOriginUrlDialogRef = useRef<HTMLDialogElement>(null);
  const editOriginUrlInputRef = useRef<HTMLInputElement>(null);
  const [openaiApiKey, setOpenaiApiKey] = useState(() => initialOpenaiApiKey?.trim() ?? "");
  const [openaiModel, setOpenaiModel] = useState(
    () => initialOpenaiModel.trim() || DEFAULT_OPENAI_MODEL,
  );
  const [openaiSettingsOpen, setOpenaiSettingsOpen] = useState(false);
  const closeOpenAiSettingsDialog = useCallback(() => {
    setOpenaiSettingsOpen(false);
  }, []);

  const openOpenAiSettingsDialog = useCallback(() => {
    setOpenaiSettingsOpen(true);
  }, []);
  const [editOriginUrl, setEditOriginUrl] = useState("");
  /** Last time we ran full local+remote branch listing (used to lighten focus refreshes). */
  const lastFullBranchListRefreshAtRef = useRef(0);
  const [newBranchName, setNewBranchName] = useState("");
  const [createBranchFieldError, setCreateBranchFieldError] = useState<string | null>(null);
  /** When set, the create-branch dialog starts the branch at this commit instead of HEAD. */
  const [createBranchStartCommit, setCreateBranchStartCommit] = useState<string | null>(null);
  const createTagDialogRef = useRef<HTMLDialogElement>(null);
  const createTagNameInputRef = useRef<HTMLInputElement>(null);
  const [createTagCommit, setCreateTagCommit] = useState<string | null>(null);
  const [newTagName, setNewTagName] = useState("");
  const [createTagMessage, setCreateTagMessage] = useState("");
  const [createTagFieldError, setCreateTagFieldError] = useState<string | null>(null);
  const refreshLists = useCallback(async (repoPath: string): Promise<WorkingTreeFile[] | null> => {
    setListsError(null);
    try {
      const [locals, remotes, worktreeList, tagList, worktree, stashList] = await Promise.all([
        invoke<LocalBranchEntry[]>("list_local_branches", { path: repoPath }),
        invoke<RemoteBranchEntry[]>("list_remote_branches", { path: repoPath }),
        invoke<WorktreeEntry[]>("list_worktrees", { path: repoPath }),
        invoke<TagEntry[]>("list_tags", { path: repoPath }),
        invoke<WorkingTreeFile[]>("list_working_tree_files", { path: repoPath }),
        invoke<StashEntry[]>("list_stashes", { path: repoPath }),
      ]);
      setLocalBranches(locals);
      setRemoteBranches(remotes);
      setWorktrees(worktreeList);
      setTags(tagList);
      setWorkingTreeFiles(worktree);
      setStashes(stashList);
      return worktree;
    } catch (e) {
      setListsError(invokeErrorMessage(e));
      return null;
    }
  }, []);

  useEffect(() => {
    return () => {
      if (commitDiffImagePreview?.before) URL.revokeObjectURL(commitDiffImagePreview.before);
      if (commitDiffImagePreview?.after) URL.revokeObjectURL(commitDiffImagePreview.after);
    };
  }, [commitDiffImagePreview]);

  useEffect(() => {
    return () => {
      if (diffImagePreview?.before) URL.revokeObjectURL(diffImagePreview.before);
      if (diffImagePreview?.after) URL.revokeObjectURL(diffImagePreview.after);
    };
  }, [diffImagePreview]);

  useEffect(() => {
    setGraphBranchVisible((prev) => {
      const next = { ...prev };
      const valid = new Set<string>();
      for (const b of localBranches) {
        const k = `local:${b.name}`;
        valid.add(k);
        if (!(k in next)) next[k] = true;
      }
      for (const r of remoteBranches) {
        const k = `remote:${r.name}`;
        valid.add(k);
        if (!(k in next)) next[k] = true;
      }
      for (const key of Object.keys(next)) {
        if (!valid.has(key)) delete next[key];
      }
      return next;
    });
  }, [localBranches, remoteBranches]);

  const graphRefs = useMemo(() => {
    const refs: string[] = [];
    for (const b of localBranches) {
      if (graphBranchVisible[`local:${b.name}`] !== false) refs.push(b.name);
    }
    for (const r of remoteBranches) {
      if (graphBranchVisible[`remote:${r.name}`] !== false) refs.push(r.name);
    }
    return refs;
  }, [localBranches, remoteBranches, graphBranchVisible]);

  const graphRefsKey = useMemo(() => graphRefs.join("\0"), [graphRefs]);

  const commitBrowseMeta = useMemo(
    () => (commitBrowseHash ? commits.find((c) => c.hash === commitBrowseHash) : undefined),
    [commits, commitBrowseHash],
  );
  const commitDescription = useMemo(
    () => (commitDetails ? stripCoAuthorTrailers(commitDetails.body) : ""),
    [commitDetails],
  );

  useEffect(() => {
    if (!repo?.path || repo.error) return;
    const pathAtStart = repo.path;
    let cancelled = false;
    void (async () => {
      try {
        const page = await invoke<GraphCommitsPage>("list_graph_commits", {
          path: pathAtStart,
          refs: graphRefs,
          skip: 0,
        });
        if (cancelled || activeRepoPathRef.current !== pathAtStart) return;
        setCommits(page.commits);
        setGraphCommitsHasMore(page.hasMore);
        setListsError(null);
      } catch (e) {
        if (cancelled || activeRepoPathRef.current !== pathAtStart) return;
        setListsError(invokeErrorMessage(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [repo?.path, repo?.error, graphRefsKey, graphRefs]);

  const loadMoreGraphCommits = useCallback(async () => {
    if (!repo?.path || repo.error || !graphCommitsHasMore || loadingMoreGraphCommits) return;
    const pathAtStart = repo.path;
    const skip = commits.length;
    setLoadingMoreGraphCommits(true);
    try {
      const page = await invoke<GraphCommitsPage>("list_graph_commits", {
        path: pathAtStart,
        refs: graphRefs,
        skip,
      });
      if (activeRepoPathRef.current !== pathAtStart) return;
      setCommits((prev) => [...prev, ...page.commits]);
      setGraphCommitsHasMore(page.hasMore);
    } catch (e) {
      if (activeRepoPathRef.current === pathAtStart) {
        setListsError(invokeErrorMessage(e));
      }
    } finally {
      setLoadingMoreGraphCommits(false);
    }
  }, [
    repo?.path,
    repo?.error,
    graphCommitsHasMore,
    loadingMoreGraphCommits,
    graphRefs,
    commits.length,
  ]);

  const branchGraphControls: BranchGraphControls = useMemo(
    () => ({
      graphVisibleLocal: (name) => graphBranchVisible[`local:${name}`] !== false,
      toggleGraphLocal: (name) => {
        const k = `local:${name}`;
        setGraphBranchVisible((prev) => ({ ...prev, [k]: !(prev[k] !== false) }));
      },
      graphFolderAnyVisibleLocal: (node) => {
        const names = collectLocalBranchNamesInSubtree(node);
        return names.some((n) => graphBranchVisible[`local:${n}`] !== false);
      },
      toggleGraphLocalFolder: (node) => {
        const names = collectLocalBranchNamesInSubtree(node);
        if (names.length === 0) return;
        const anyVisible = names.some((n) => graphBranchVisible[`local:${n}`] !== false);
        const nextVal = !anyVisible;
        setGraphBranchVisible((prev) => {
          const next = { ...prev };
          for (const n of names) {
            next[`local:${n}`] = nextVal;
          }
          return next;
        });
      },
      graphVisibleRemote: (name) => graphBranchVisible[`remote:${name}`] !== false,
      toggleGraphRemote: (name) => {
        const k = `remote:${name}`;
        setGraphBranchVisible((prev) => ({ ...prev, [k]: !(prev[k] !== false) }));
      },
      graphFolderAnyVisibleRemote: (node) => {
        const refs = collectRemoteRefsInSubtree(node);
        return refs.some((r) => graphBranchVisible[`remote:${r}`] !== false);
      },
      toggleGraphRemoteFolder: (node) => {
        const refs = collectRemoteRefsInSubtree(node);
        if (refs.length === 0) return;
        const anyVisible = refs.some((r) => graphBranchVisible[`remote:${r}`] !== false);
        const nextVal = !anyVisible;
        setGraphBranchVisible((prev) => {
          const next = { ...prev };
          for (const r of refs) {
            next[`remote:${r}`] = nextVal;
          }
          return next;
        });
      },
    }),
    [graphBranchVisible],
  );

  const graphBranchTips = useMemo((): BranchTip[] => {
    const tips: BranchTip[] = [];
    for (const b of localBranches) {
      if (graphBranchVisible[`local:${b.name}`] !== false) {
        tips.push({ name: b.name, tipHash: b.tipHash });
      }
    }
    for (const r of remoteBranches) {
      if (graphBranchVisible[`remote:${r.name}`] !== false) {
        tips.push({ name: r.name, tipHash: r.tipHash });
      }
    }
    tips.sort((a, b) => a.name.localeCompare(b.name));
    return tips;
  }, [localBranches, remoteBranches, graphBranchVisible]);

  const graphFilteredCommits = useMemo(
    () => filterGraphCommits(commits, graphAuthorFilter, graphDateFrom, graphDateTo),
    [commits, graphAuthorFilter, graphDateFrom, graphDateTo],
  );
  const graphDisplayCommits = useMemo(() => {
    const hiddenHashes = new Set<string>();
    const filteredHashes = new Set(graphFilteredCommits.map((c) => c.hash));
    for (const c of graphFilteredCommits) {
      if (!c.stashRef?.trim()) continue;
      for (const helperHash of c.parentHashes.slice(1)) {
        if (filteredHashes.has(helperHash)) {
          hiddenHashes.add(helperHash);
        }
      }
    }
    return graphFilteredCommits.filter((c) => !hiddenHashes.has(c.hash));
  }, [graphFilteredCommits]);

  const graphCommitFiltersActive =
    graphAuthorFilter.trim().length > 0 ||
    graphDateFrom.trim().length > 0 ||
    graphDateTo.trim().length > 0;

  const graphCommitsReachableFromHead = useMemo(
    () => reachableCommitHashesFromHead(commits, repo?.headHash ?? null),
    [commits, repo?.headHash],
  );

  const graphExportCommits = useMemo(
    () => graphFilteredCommits.filter((c) => graphCommitsReachableFromHead.has(c.hash)),
    [graphFilteredCommits, graphCommitsReachableFromHead],
  );

  const clearFileToolView = useCallback(() => {
    setFileHistoryPath(null);
    setFileHistoryCommits([]);
    setFileHistoryLoading(false);
    setFileHistoryError(null);
    setFileBlamePath(null);
    setFileBlameText(null);
    setFileBlameLoading(false);
    setFileBlameError(null);
  }, []);

  const clearCommitBrowse = useCallback(() => {
    selectCommitSeqRef.current += 1;
    setCommitBrowseHash(null);
    setCommitBrowseFiles([]);
    setCommitBrowseLoading(false);
    setCommitBrowseError(null);
    setCommitDetails(null);
    setCommitDetailsLoading(false);
    setCommitDetailsError(null);
    setCommitDetailsExpanded(false);
    setCommitSignature({ loading: false, verified: null });
    setCommitDiffPath(null);
    setCommitDiffText(null);
    setCommitDiffLoading(false);
    setCommitDiffError(null);
    setCommitDiffImagePreview(null);
    clearFileToolView();
  }, [clearFileToolView]);

  const clearWorktreeBrowse = useCallback(() => {
    setWorktreeBrowseTarget(null);
    setWorktreeBrowseFiles([]);
    setWorktreeBrowseLoading(false);
    setWorktreeBrowseError(null);
  }, []);

  const focusGraphOnCommitHash = useCallback(
    (hash: string) => {
      clearWorktreeBrowse();
      clearCommitBrowse();
      setGraphFocusHash(hash);
      setGraphScrollNonce((n) => n + 1);
    },
    [clearCommitBrowse, clearWorktreeBrowse],
  );

  const onSelectLocalBranchTip = useCallback(
    (name: string) => {
      const b = localBranches.find((x) => x.name === name);
      if (!b) return;
      focusGraphOnCommitHash(b.tipHash);
    },
    [localBranches, focusGraphOnCommitHash],
  );

  const onSelectRemoteBranchTip = useCallback(
    (fullRef: string) => {
      const r = remoteBranches.find((x) => x.name === fullRef);
      if (!r) return;
      focusGraphOnCommitHash(r.tipHash);
    },
    [remoteBranches, focusGraphOnCommitHash],
  );

  const onStashSidebarClick = useCallback(
    (s: StashEntry) => {
      const h = s.commitHash?.trim();
      if (h) focusGraphOnCommitHash(h);
    },
    [focusGraphOnCommitHash],
  );

  const onTagSidebarClick = useCallback(
    (t: TagEntry) => {
      const h = t.tipHash?.trim();
      if (h) focusGraphOnCommitHash(h);
    },
    [focusGraphOnCommitHash],
  );

  useEffect(() => {
    if (!commitBrowseHash) return;
    if (!graphFilteredCommits.some((c) => c.hash === commitBrowseHash)) {
      clearCommitBrowse();
    }
  }, [graphFilteredCommits, commitBrowseHash, clearCommitBrowse]);

  useEffect(() => {
    if (!worktreeBrowseTarget) return;
    const nextTarget = worktrees.find((entry) => entry.path === worktreeBrowseTarget.path) ?? null;
    if (nextTarget) {
      setWorktreeBrowseTarget(nextTarget);
    }
    if (repo?.path === worktreeBrowseTarget.path) {
      setWorktreeBrowseFiles(workingTreeFiles);
    }
  }, [worktreeBrowseTarget, worktrees, repo?.path, workingTreeFiles]);

  useEffect(() => {
    commitBrowseFileListScrollRef.current?.scrollTo(0, 0);
  }, [commitBrowseHash, worktreeBrowseTarget?.path]);

  const exportFilteredCommitsList = useCallback(async () => {
    if (!repo?.path || repo.error) return;
    if (graphExportCommits.length === 0) return;
    setOperationError(null);
    try {
      const path = await save({
        defaultPath: buildGraphExportDefaultFilename(graphAuthorFilter, graphDateFrom, graphDateTo),
        filters: [{ name: "Text", extensions: ["txt"] }],
      });
      if (path == null) return;
      const checkoutExportLabel = repo.detached
        ? repo.headShort
          ? `Detached (${repo.headShort})`
          : "Detached HEAD"
        : (repo.branch ?? "—");
      const text = formatCommitsExportTxt(
        graphExportCommits,
        repo.name.trim() || repo.path,
        checkoutExportLabel,
        graphAuthorFilter,
        graphDateFrom,
        graphDateTo,
      );
      await invoke("write_export_text_file", { path, contents: text });
    } catch (e) {
      setOperationError(invokeErrorMessage(e));
    }
  }, [repo, graphExportCommits, graphAuthorFilter, graphDateFrom, graphDateTo]);

  const loadDiffForFile = useCallback(
    async (
      f: WorkingTreeFile,
      side: "unstaged" | "staged",
      options?: { repoPath?: string; clearCommitBrowse?: boolean },
    ) => {
      const pathAtStart = options?.repoPath ?? repo?.path ?? null;
      const guardActiveRepo = options?.repoPath == null;
      if (!pathAtStart) return;
      if (side === "unstaged" && !f.unstaged) return;
      if (side === "staged" && !f.staged) return;
      if (options?.clearCommitBrowse ?? true) {
        clearCommitBrowse();
      }
      setSelectedDiffPath(f.path);
      setSelectedDiffSide(side);
      setSelectedDiffRepoPath(pathAtStart);
      setDiffLoading(true);
      setDiffError(null);
      setDiffStagedText(null);
      setDiffUnstagedText(null);
      setDiffImagePreview(null);
      try {
        if (side === "unstaged") {
          const unstaged = await invoke<string>("get_unstaged_diff", {
            path: pathAtStart,
            filePath: f.path,
          });
          if (guardActiveRepo && activeRepoPathRef.current !== pathAtStart) return;
          setDiffUnstagedText(unstaged);
          if (pathLooksLikeRenderableImage(f.path)) {
            try {
              const pair = await invoke<FileBlobPair>("get_unstaged_file_blob_pair", {
                path: pathAtStart,
                filePath: f.path,
              });
              if (guardActiveRepo && activeRepoPathRef.current !== pathAtStart) return;
              setDiffImagePreview(blobPairToPreviewUrls(pair, f.path));
            } catch {
              if (!guardActiveRepo || activeRepoPathRef.current === pathAtStart) {
                setDiffImagePreview(null);
              }
            }
          }
        } else {
          const staged = await invoke<string>("get_staged_diff", {
            path: pathAtStart,
            filePath: f.path,
          });
          if (guardActiveRepo && activeRepoPathRef.current !== pathAtStart) return;
          setDiffStagedText(staged);
          if (pathLooksLikeRenderableImage(f.path)) {
            try {
              const pair = await invoke<FileBlobPair>("get_staged_file_blob_pair", {
                path: pathAtStart,
                filePath: f.path,
              });
              if (guardActiveRepo && activeRepoPathRef.current !== pathAtStart) return;
              setDiffImagePreview(blobPairToPreviewUrls(pair, f.path));
            } catch {
              if (!guardActiveRepo || activeRepoPathRef.current === pathAtStart) {
                setDiffImagePreview(null);
              }
            }
          }
        }
      } catch (e) {
        if (!guardActiveRepo || activeRepoPathRef.current === pathAtStart) {
          setDiffError(invokeErrorMessage(e));
        }
      } finally {
        if (!guardActiveRepo || activeRepoPathRef.current === pathAtStart) {
          setDiffLoading(false);
        }
      }
    },
    [repo?.path, clearCommitBrowse],
  );

  const openWorktreeBrowse = useCallback(
    async (worktree: WorktreeEntry) => {
      clearCommitBrowse();
      clearFileToolView();
      setGraphFocusHash(null);
      setSelectedDiffPath(null);
      setSelectedDiffSide(null);
      setSelectedDiffRepoPath(null);
      setDiffStagedText(null);
      setDiffUnstagedText(null);
      setDiffError(null);
      setDiffLoading(false);
      setDiffImagePreview(null);
      setWorktreeBrowseTarget(worktree);
      setWorktreeBrowseError(null);
      setWorktreeBrowseLoading(true);
      try {
        const files =
          repo?.path === worktree.path
            ? workingTreeFiles
            : await invoke<WorkingTreeFile[]>("list_working_tree_files", {
                path: worktree.path,
              });
        setWorktreeBrowseFiles(files);
        const first = files.find((f) => f.unstaged) ?? files.find((f) => f.staged) ?? null;
        if (first) {
          void loadDiffForFile(first, first.unstaged ? "unstaged" : "staged", {
            repoPath: worktree.path,
            clearCommitBrowse: false,
          });
        }
      } catch (e) {
        setWorktreeBrowseFiles([]);
        setWorktreeBrowseError(invokeErrorMessage(e));
      } finally {
        setWorktreeBrowseLoading(false);
      }
    },
    [clearCommitBrowse, clearFileToolView, loadDiffForFile, repo?.path, workingTreeFiles],
  );

  const loadCommitFileDiff = useCallback(
    async (filePath: string, commitHash: string) => {
      if (!repo?.path || repo.error || !commitHash.trim()) return;
      const pathAtStart = repo.path;
      setCommitDiffPath(filePath);
      setCommitDiffLoading(true);
      setCommitDiffError(null);
      setCommitDiffText(null);
      setCommitDiffImagePreview(null);
      try {
        const text = await invoke<string>("get_commit_file_diff", {
          path: pathAtStart,
          commitHash,
          filePath,
        });
        if (activeRepoPathRef.current !== pathAtStart) return;
        setCommitDiffText(text);
        if (pathLooksLikeRenderableImage(filePath)) {
          try {
            const pair = await invoke<FileBlobPair>("get_commit_file_blob_pair", {
              path: pathAtStart,
              commitHash,
              filePath,
            });
            if (activeRepoPathRef.current !== pathAtStart) return;
            setCommitDiffImagePreview(blobPairToPreviewUrls(pair, filePath));
          } catch {
            if (activeRepoPathRef.current === pathAtStart) {
              setCommitDiffImagePreview(null);
            }
          }
        }
      } catch (e) {
        if (activeRepoPathRef.current === pathAtStart) {
          setCommitDiffError(invokeErrorMessage(e));
        }
      } finally {
        if (activeRepoPathRef.current === pathAtStart) {
          setCommitDiffLoading(false);
        }
      }
    },
    [repo],
  );

  const selectCommit = useCallback(
    async (hash: string) => {
      if (!repo?.path || repo.error) return;
      const pathAtStart = repo.path;
      const seq = ++selectCommitSeqRef.current;
      setGraphFocusHash(null);
      clearWorktreeBrowse();
      clearFileToolView();
      setSelectedDiffPath(null);
      setSelectedDiffSide(null);
      setSelectedDiffRepoPath(null);
      setDiffStagedText(null);
      setDiffUnstagedText(null);
      setDiffError(null);
      setCommitBrowseHash(hash);
      setCommitBrowseFiles([]);
      setCommitDiffPath(null);
      setCommitDiffText(null);
      setCommitDiffError(null);
      setCommitDiffImagePreview(null);
      setCommitDetails(null);
      setCommitDetailsLoading(true);
      setCommitDetailsError(null);
      setCommitDetailsExpanded(false);
      setCommitBrowseLoading(true);
      setCommitBrowseError(null);
      setCommitSignature({ loading: true, verified: null });

      void invoke<CommitDetails>("get_commit_details", {
        path: pathAtStart,
        commitHash: hash,
      })
        .then((details) => {
          if (activeRepoPathRef.current !== pathAtStart || seq !== selectCommitSeqRef.current)
            return;
          setCommitDetails(details);
          setCommitDetailsError(null);
        })
        .catch((e: unknown) => {
          if (activeRepoPathRef.current !== pathAtStart || seq !== selectCommitSeqRef.current)
            return;
          setCommitDetails(null);
          setCommitDetailsError(invokeErrorMessage(e));
        })
        .finally(() => {
          if (activeRepoPathRef.current === pathAtStart && seq === selectCommitSeqRef.current) {
            setCommitDetailsLoading(false);
          }
        });

      try {
        const files = await invoke<CommitFileEntry[]>("list_commit_files", {
          path: pathAtStart,
          commitHash: hash,
        });
        if (activeRepoPathRef.current !== pathAtStart || seq !== selectCommitSeqRef.current) return;
        setCommitBrowseFiles(files);
        setCommitBrowseError(null);
        if (files.length > 0) {
          void loadCommitFileDiff(files[0].path, hash);
        }
      } catch (e) {
        if (activeRepoPathRef.current !== pathAtStart || seq !== selectCommitSeqRef.current) return;
        setCommitBrowseFiles([]);
        setCommitBrowseError(invokeErrorMessage(e));
      } finally {
        if (activeRepoPathRef.current === pathAtStart && seq === selectCommitSeqRef.current) {
          setCommitBrowseLoading(false);
        }
      }

      void invoke("start_commit_signature_check", {
        path: pathAtStart,
        commitHash: hash,
        requestId: seq,
      }).catch(() => {});
    },
    [repo, clearFileToolView, loadCommitFileDiff, clearWorktreeBrowse],
  );

  const clearDiffSelection = useCallback(() => {
    setSelectedDiffPath(null);
    setSelectedDiffSide(null);
    setSelectedDiffRepoPath(null);
    setDiffStagedText(null);
    setDiffUnstagedText(null);
    setDiffError(null);
    setDiffLoading(false);
    setDiffImagePreview(null);
    clearFileToolView();
  }, [clearFileToolView]);

  const loadRepo = useCallback(
    async (selected: string) => {
      const target = selected.trim();
      if (!target) {
        setLoading(false);
        return;
      }
      pendingLoadRepoRef.current = target;
      setLoading(true);
      setLoadError(null);
      setOperationError(null);
      clearWorktreeBrowse();
      clearCommitBrowse();
      setSelectedDiffPath(null);
      setSelectedDiffSide(null);
      setSelectedDiffRepoPath(null);
      setDiffStagedText(null);
      setDiffUnstagedText(null);
      setDiffError(null);
      setDiffLoading(false);
      try {
        const meta = await invoke<RepoMetadata>("get_repo_metadata", {
          path: target,
        });
        if (pendingLoadRepoRef.current !== target) return;
        setRepo(meta);
        if (!meta.error) {
          await invoke("set_last_repo_path", { path: target });
          if (pendingLoadRepoRef.current !== target) return;
          await refreshLists(target);
          if (pendingLoadRepoRef.current !== target) return;
          void invoke("start_repo_watch", { path: target }).catch(() => {});
          lastFullBranchListRefreshAtRef.current = Date.now();
        } else {
          setLocalBranches([]);
          setRemoteBranches([]);
          setWorktrees([]);
          setTags([]);
          setStashes([]);
          setCommits([]);
          setGraphCommitsHasMore(false);
          setWorkingTreeFiles([]);
        }
      } catch (e) {
        if (pendingLoadRepoRef.current !== target) return;
        setRepo(null);
        setLocalBranches([]);
        setRemoteBranches([]);
        setWorktrees([]);
        setTags([]);
        setStashes([]);
        setCommits([]);
        setGraphCommitsHasMore(false);
        setWorkingTreeFiles([]);
        setLoadError(invokeErrorMessage(e));
        void invoke("reset_main_window_title").catch(() => {});
      } finally {
        if (pendingLoadRepoRef.current === target) {
          setLoading(false);
        }
      }
    },
    [refreshLists, clearCommitBrowse, clearWorktreeBrowse],
  );

  /** Coalesce rapid `clone-progress` events to one React update per frame (avoids UI freeze). */
  const scheduleCloneProgressUiFlush = useCallback(() => {
    if (cloneProgressRafRef.current != null) return;
    cloneProgressRafRef.current = requestAnimationFrame(() => {
      cloneProgressRafRef.current = null;
      const lines = cloneLogLinesRef.current;
      const maxPct = cloneProgressMaxPercentRef.current;
      const lastMsg = lines.length > 0 ? lines[lines.length - 1] : "";
      setCloneProgress({ message: lastMsg, percent: maxPct });
      setCloneLogLines(lines.slice());
    });
  }, []);

  const handleCloneCompletePayload = useCallback((p: CloneDonePayload) => {
    if (cloneProgressRafRef.current != null) {
      cancelAnimationFrame(cloneProgressRafRef.current);
      cloneProgressRafRef.current = null;
    }
    cloneLogLinesRef.current = [];
    cloneProgressMaxPercentRef.current = null;
    pendingCloneSessionRef.current = null;
    setCloneLogLines([]);
    if (p.error) {
      setCloneProgress(null);
      setOperationError(p.error);
      setLoading(false);
      return;
    }
    const path = p.path?.trim();
    if (!path) {
      setCloneProgress(null);
      setOperationError("Clone finished without a path.");
      setLoading(false);
      return;
    }
    setCloneProgress(null);
    setCloneReadyPath(path);
    setLoading(false);
  }, []);

  const openClonedRepository = useCallback(() => {
    const path = cloneReadyPath?.trim();
    if (!path) return;
    setCloneReadyPath(null);
    void loadRepo(path);
  }, [cloneReadyPath, loadRepo]);

  useLayoutEffect(() => {
    if (!cloneProgress || cloneLogLines.length === 0) return;
    const el = cloneLogScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [cloneLogLines, cloneProgress]);

  useEffect(() => {
    setGitCommandStream(null);
    gitStreamSessionRef.current = null;
  }, [repo?.path]);

  useLayoutEffect(() => {
    if (!gitCommandStream) return;
    const el = gitCommandStreamScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [gitCommandStream]);

  const openCloneRepoDialog = useCallback(() => {
    setCloneRepoUrlDraft("https://github.com/");
    setOperationError(null);
    cloneRepoDialogRef.current?.showModal();
    requestAnimationFrame(() => {
      const el = cloneRepoUrlInputRef.current;
      if (el) {
        el.focus();
        el.select();
      }
    });
  }, []);

  const submitCloneRepository = useCallback(async () => {
    const trimmed = cloneRepoUrlDraft.trim();
    if (!trimmed) return;
    cloneRepoDialogRef.current?.close();
    const parent = await open({
      directory: true,
      multiple: false,
      title: "Choose folder to clone into",
    });
    if (parent === null || Array.isArray(parent)) return;
    pendingCloneSessionRef.current = null;
    cloneCompleteQueuedRef.current = null;
    setCloneReadyPath(null);
    if (cloneProgressRafRef.current != null) {
      cancelAnimationFrame(cloneProgressRafRef.current);
      cloneProgressRafRef.current = null;
    }
    cloneLogLinesRef.current = ["Starting clone…"];
    cloneProgressMaxPercentRef.current = null;
    setCloneLogLines(["Starting clone…"]);
    setCloneProgress({ message: "Starting clone…", percent: null });
    setLoading(true);
    setLoadError(null);
    setOperationError(null);
    try {
      const startSessionId = await invoke<number>("start_clone_repository", {
        parentPath: parent,
        remoteUrl: trimmed,
      });
      pendingCloneSessionRef.current = startSessionId;
      const queued = cloneCompleteQueuedRef.current as CloneDonePayload | null;
      if (queued !== null && queued.sessionId === startSessionId) {
        cloneCompleteQueuedRef.current = null;
        handleCloneCompletePayload(queued);
      }
    } catch (e) {
      pendingCloneSessionRef.current = null;
      cloneCompleteQueuedRef.current = null;
      if (cloneProgressRafRef.current != null) {
        cancelAnimationFrame(cloneProgressRafRef.current);
        cloneProgressRafRef.current = null;
      }
      cloneLogLinesRef.current = [];
      cloneProgressMaxPercentRef.current = null;
      setCloneLogLines([]);
      setCloneProgress(null);
      setOperationError(invokeErrorMessage(e));
      setLoading(false);
    }
  }, [cloneRepoUrlDraft, handleCloneCompletePayload]);

  const cloneRepoDialogBackdropClose = useDialogBackdropClose();
  const createBranchDialogBackdropClose = useDialogBackdropClose();
  const createTagDialogBackdropClose = useDialogBackdropClose();
  const editOriginUrlDialogBackdropClose = useDialogBackdropClose();

  const refreshAfterMutation = useCallback(
    async (options?: { fromFocus?: boolean }) => {
      const fromFocus = options?.fromFocus ?? false;
      if (!repo?.path || repo.error) return;
      const pathAtStart = repo.path;
      const prevBranch = repo.branch;
      const prevDetached = repo.detached;
      try {
        const meta = await invoke<RepoMetadata>("get_repo_metadata", {
          path: pathAtStart,
        });
        if (activeRepoPathRef.current !== pathAtStart) return;
        const branchContextChanged = meta.branch !== prevBranch || meta.detached !== prevDetached;
        setRepo(meta);
        if (!meta.error) {
          if (branchContextChanged) {
            clearCommitBrowse();
          }

          let files: WorkingTreeFile[] | null = null;

          if (!fromFocus) {
            lastFullBranchListRefreshAtRef.current = Date.now();
            files = await refreshLists(pathAtStart);
          } else {
            const now = Date.now();
            const needFullBranchList =
              branchContextChanged ||
              now - lastFullBranchListRefreshAtRef.current >= BRANCH_LIST_FULL_REFRESH_INTERVAL_MS;
            if (needFullBranchList) {
              lastFullBranchListRefreshAtRef.current = Date.now();
              files = await refreshLists(pathAtStart);
            } else {
              try {
                // Focus refreshes still need to pick up external ref-only changes
                // like new tags or branches created outside Garlic.
                const [locals, remotes, worktreeList, tagList, worktree, stashList] =
                  await Promise.all([
                    invoke<LocalBranchEntry[]>("list_local_branches", {
                      path: pathAtStart,
                    }),
                    invoke<RemoteBranchEntry[]>("list_remote_branches", {
                      path: pathAtStart,
                    }),
                    invoke<WorktreeEntry[]>("list_worktrees", {
                      path: pathAtStart,
                    }),
                    invoke<TagEntry[]>("list_tags", { path: pathAtStart }),
                    invoke<WorkingTreeFile[]>("list_working_tree_files", {
                      path: pathAtStart,
                    }),
                    invoke<StashEntry[]>("list_stashes", { path: pathAtStart }),
                  ]);
                if (activeRepoPathRef.current !== pathAtStart) return;
                setLocalBranches(locals);
                setRemoteBranches(remotes);
                setWorktrees(worktreeList);
                setTags(tagList);
                setWorkingTreeFiles(worktree);
                setStashes(stashList);
                setListsError(null);
                files = worktree;
              } catch (e) {
                if (activeRepoPathRef.current === pathAtStart) {
                  setListsError(invokeErrorMessage(e));
                }
                files = null;
              }
            }
          }

          if (activeRepoPathRef.current !== pathAtStart) return;

          if (selectedDiffRepoPath === pathAtStart && selectedDiffPath && files) {
            const next = files.find((w) => w.path === selectedDiffPath);
            if (next && (next.staged || next.unstaged)) {
              const preferredSide = selectedDiffSide ?? (next.unstaged ? "unstaged" : "staged");
              if (preferredSide === "unstaged" && next.unstaged) {
                void loadDiffForFile(next, "unstaged");
              } else if (preferredSide === "staged" && next.staged) {
                void loadDiffForFile(next, "staged");
              } else if (next.unstaged) {
                void loadDiffForFile(next, "unstaged");
              } else if (next.staged) {
                void loadDiffForFile(next, "staged");
              } else {
                setSelectedDiffPath(null);
                setSelectedDiffSide(null);
                setDiffStagedText(null);
                setDiffUnstagedText(null);
                setDiffError(null);
              }
            } else {
              setSelectedDiffPath(null);
              setSelectedDiffSide(null);
              setDiffStagedText(null);
              setDiffUnstagedText(null);
              setDiffError(null);
            }
          }
        }
      } catch (e) {
        if (activeRepoPathRef.current === pathAtStart) {
          setOperationError(invokeErrorMessage(e));
        }
      }
    },
    [
      repo,
      refreshLists,
      selectedDiffPath,
      selectedDiffRepoPath,
      selectedDiffSide,
      loadDiffForFile,
      clearCommitBrowse,
    ],
  );

  useEffect(() => {
    if (!repo?.path || repo.error || loading) return;
    let timeoutId: number | null = null;
    const scheduleRefresh = () => {
      if (document.visibilityState !== "visible") return;
      if (timeoutId !== null) window.clearTimeout(timeoutId);
      timeoutId = window.setTimeout(() => {
        void refreshAfterMutation({ fromFocus: true });
      }, WINDOW_FOCUS_REFRESH_DELAY_MS);
    };
    window.addEventListener("focus", scheduleRefresh);
    return () => {
      if (timeoutId !== null) window.clearTimeout(timeoutId);
      window.removeEventListener("focus", scheduleRefresh);
    };
  }, [repo?.path, repo?.error, loading, refreshAfterMutation]);

  const openCreateBranchDialog = useCallback(() => {
    setCreateBranchStartCommit(null);
    setNewBranchName("");
    setCreateBranchFieldError(null);
    setOperationError(null);
    createBranchDialogRef.current?.showModal();
    requestAnimationFrame(() => {
      newBranchInputRef.current?.focus();
    });
  }, []);

  const onStashPush = useCallback(async () => {
    if (!repo?.path || repo.error) return;
    setStashBusy("push");
    setOperationError(null);
    try {
      await invoke("stash_push", { path: repo.path, message: null });
      await refreshAfterMutation();
    } catch (e) {
      setOperationError(invokeErrorMessage(e));
    } finally {
      setStashBusy(null);
    }
  }, [repo, refreshAfterMutation]);

  const persistBranchSidebarSections = useCallback((next: BranchSidebarSectionsState) => {
    setBranchSidebarSections(next);
    void invoke("set_branch_sidebar_sections", { sections: next }).catch((e: unknown) => {
      console.error("set_branch_sidebar_sections failed", e);
    });
  }, []);

  const openEditOriginUrlDialog = useCallback(async () => {
    if (!repo?.path || repo.error) return;
    setOperationError(null);
    try {
      const url = await invoke<string>("get_remote_url", {
        path: repo.path,
        remoteName: "origin",
      });
      setEditOriginUrl(url);
      editOriginUrlDialogRef.current?.showModal();
      queueMicrotask(() => {
        const el = editOriginUrlInputRef.current;
        if (el) {
          el.focus();
          el.select();
        }
      });
    } catch (e) {
      setOperationError(invokeErrorMessage(e));
    }
  }, [repo]);

  const submitEditOriginUrl = useCallback(async () => {
    if (!repo?.path || repo.error) return;
    const trimmed = editOriginUrl.trim();
    if (!trimmed) return;
    setBranchBusy("remote-url");
    setOperationError(null);
    try {
      await invoke("set_remote_url", {
        path: repo.path,
        remoteName: "origin",
        url: trimmed,
      });
      editOriginUrlDialogRef.current?.close();
      setEditOriginUrl("");
      await refreshAfterMutation();
    } catch (e) {
      setOperationError(invokeErrorMessage(e));
    } finally {
      setBranchBusy(null);
    }
  }, [repo, editOriginUrl, refreshAfterMutation]);

  const pullLocalBranch = useCallback(
    async (branchName: string) => {
      if (!repo?.path || repo.error) return;
      setBranchBusy(`pull:${branchName}`);
      setOperationError(null);
      try {
        await invoke("pull_local_branch", {
          path: repo.path,
          branch: branchName,
        });
        await refreshAfterMutation();
      } catch (e) {
        setOperationError(invokeErrorMessage(e));
      } finally {
        setBranchBusy(null);
      }
    },
    [repo, refreshAfterMutation],
  );

  const deleteLocalBranch = useCallback(
    async (branchName: string, force: boolean) => {
      if (!repo?.path || repo.error) return;
      let ok = false;
      try {
        ok = await ask(
          force
            ? `Force-delete local branch "${branchName}"? Unmerged work on this branch will be lost.`
            : `Delete local branch "${branchName}"?`,
          { title: "Garlic", kind: "warning" },
        );
      } catch (e) {
        setOperationError(invokeErrorMessage(e));
        return;
      }
      if (!ok) return;
      setBranchBusy(`delete:${branchName}`);
      setOperationError(null);
      try {
        await invoke("delete_local_branch", {
          path: repo.path,
          branch: branchName,
          force,
        });
        await refreshAfterMutation();
      } catch (e) {
        setOperationError(invokeErrorMessage(e));
      } finally {
        setBranchBusy(null);
      }
    },
    [repo, refreshAfterMutation],
  );

  const deleteRemoteBranch = useCallback(
    async (fullRef: string) => {
      if (!repo?.path || repo.error) return;
      let ok = false;
      try {
        ok = await ask(
          `Delete remote branch "${fullRef}"? This runs git push --delete on the server.`,
          { title: "Garlic", kind: "warning" },
        );
      } catch (e) {
        setOperationError(invokeErrorMessage(e));
        return;
      }
      if (!ok) return;
      setBranchBusy(`delete-remote:${fullRef}`);
      setOperationError(null);
      try {
        await invoke("delete_remote_branch", {
          path: repo.path,
          remoteRef: fullRef,
        });
        await refreshAfterMutation();
      } catch (e) {
        setOperationError(invokeErrorMessage(e));
      } finally {
        setBranchBusy(null);
      }
    },
    [repo, refreshAfterMutation],
  );

  const rebaseCurrentBranchOnto = useCallback(
    async (onto: string, interactive: boolean) => {
      if (!repo?.path || repo.error) return;
      const ok = await ask(
        interactive
          ? `Interactive rebase the current branch onto "${onto}"? Your Git editor (sequence.editor or core.editor) will open for the rebase todo list.`
          : `Rebase the current branch onto "${onto}"?`,
        { title: "Garlic", kind: "warning" },
      );
      if (!ok) return;
      setBranchBusy("rebase");
      setOperationError(null);
      try {
        await invoke("rebase_current_branch_onto", {
          path: repo.path,
          onto,
          interactive,
        });
        await refreshAfterMutation();
      } catch (e) {
        setOperationError(invokeErrorMessage(e));
      } finally {
        setBranchBusy(null);
      }
    },
    [repo, refreshAfterMutation],
  );

  const mergeBranchIntoCurrent = useCallback(
    async (onto: string) => {
      if (!repo?.path || repo.error || repo.detached) return;
      const ok = await ask(`Merge "${onto}" into the current branch?`, {
        title: "Garlic",
        kind: "warning",
      });
      if (!ok) return;
      setBranchBusy(`merge:${onto}`);
      setOperationError(null);
      try {
        await invoke("merge_branch", {
          path: repo.path,
          branchOrRef: onto,
        });
        await refreshAfterMutation();
      } catch (e) {
        setOperationError(invokeErrorMessage(e));
      } finally {
        setBranchBusy(null);
      }
    },
    [repo, refreshAfterMutation],
  );

  const removeLinkedWorktree = useCallback(
    async (worktree: WorktreeEntry) => {
      if (!repo?.path || repo.error || worktree.isCurrent) return;
      const hasLocalChanges = worktree.changedFileCount > 0;
      const ok = await ask(
        hasLocalChanges
          ? `Delete worktree "${worktree.path}"? This worktree has local changes that will be lost.`
          : `Delete worktree "${worktree.path}"?`,
        { title: "Garlic", kind: "warning" },
      );
      if (!ok) return;
      setBranchBusy(`worktree-remove:${worktree.path}`);
      setOperationError(null);
      try {
        await invoke("remove_worktree", {
          path: repo.path,
          worktreePath: worktree.path,
          force: hasLocalChanges,
        });
        if (worktreeBrowseTarget?.path === worktree.path) {
          clearWorktreeBrowse();
          clearDiffSelection();
        }
        await refreshAfterMutation();
      } catch (e) {
        setOperationError(invokeErrorMessage(e));
      } finally {
        setBranchBusy(null);
      }
    },
    [
      repo,
      refreshAfterMutation,
      worktreeBrowseTarget?.path,
      clearWorktreeBrowse,
      clearDiffSelection,
    ],
  );

  const runWorktreeSidebarContextMenu = useCallback(
    (worktree: WorktreeEntry, clientX: number, clientY: number) => {
      const sameBranch =
        !repo?.detached && !!repo?.branch && !!worktree.branch && repo.branch === worktree.branch;
      const canApply =
        !worktree.isCurrent && !repo?.detached && !!worktree.branch && !sameBranch && !branchBusy;
      void popupWorktreeContextMenu(clientX, clientY, {
        disabled: Boolean(branchBusy),
        canOpen: !worktree.isCurrent,
        canBrowse: worktree.changedFileCount > 0 || Boolean(worktree.branch),
        canApply,
        canDelete: !worktree.isCurrent,
        onOpen: () => {
          void loadRepo(worktree.path);
        },
        onBrowse: () => {
          void openWorktreeBrowse(worktree);
        },
        onApply: () => {
          if (!worktree.branch) return;
          void mergeBranchIntoCurrent(worktree.branch);
        },
        onDelete: () => {
          void removeLinkedWorktree(worktree);
        },
      });
    },
    [repo, branchBusy, loadRepo, openWorktreeBrowse, mergeBranchIntoCurrent, removeLinkedWorktree],
  );

  const onCheckoutLocal = useCallback(
    async (branch: string) => {
      if (!repo?.path || repo.error) return;
      setBranchBusy(`local:${branch}`);
      setOperationError(null);
      try {
        await invoke("checkout_local_branch", {
          path: repo.path,
          branch,
        });
        await refreshAfterMutation();
      } catch (e) {
        setOperationError(invokeErrorMessage(e));
      } finally {
        setBranchBusy(null);
      }
    },
    [repo, refreshAfterMutation],
  );

  const onCreateFromRemote = useCallback(
    async (remoteRef: string) => {
      if (!repo?.path || repo.error) return;
      setBranchBusy(`remote:${remoteRef}`);
      setOperationError(null);
      try {
        await invoke("create_branch_from_remote", {
          path: repo.path,
          remoteRef,
        });
        await refreshAfterMutation();
      } catch (e) {
        setOperationError(invokeErrorMessage(e));
      } finally {
        setBranchBusy(null);
      }
    },
    [repo, refreshAfterMutation],
  );

  const runBranchSidebarContextMenu = useCallback(
    (
      spec: { kind: "local"; branchName: string } | { kind: "remote"; fullRef: string },
      clientX: number,
      clientY: number,
    ) => {
      void popupBranchContextMenu(clientX, clientY, {
        kind: spec.kind,
        branchName: spec.kind === "local" ? spec.branchName : undefined,
        fullRef: spec.kind === "remote" ? spec.fullRef : undefined,
        currentBranchName: repo?.detached ? null : (repo?.branch ?? null),
        repoDetached: Boolean(repo?.detached),
        branchBusy: Boolean(branchBusy),
        onCheckout:
          spec.kind === "local"
            ? () => void onCheckoutLocal(spec.branchName)
            : () => void onCreateFromRemote(spec.fullRef),
        onPull: () => void pullLocalBranch(spec.kind === "local" ? spec.branchName : ""),
        onMerge: () =>
          void mergeBranchIntoCurrent(spec.kind === "local" ? spec.branchName : spec.fullRef),
        onRebase: () =>
          void rebaseCurrentBranchOnto(
            spec.kind === "local" ? spec.branchName : spec.fullRef,
            false,
          ),
        onRebaseInteractive: () =>
          void rebaseCurrentBranchOnto(
            spec.kind === "local" ? spec.branchName : spec.fullRef,
            true,
          ),
        onDelete: () => {
          if (spec.kind !== "local") return;
          void deleteLocalBranch(spec.branchName, false);
        },
        onForceDelete: () => {
          if (spec.kind !== "local") return;
          void deleteLocalBranch(spec.branchName, true);
        },
        onDeleteRemote:
          spec.kind === "remote" ? () => void deleteRemoteBranch(spec.fullRef) : undefined,
        onEditOriginUrl:
          spec.kind === "remote" && remoteNameFromRemoteRef(spec.fullRef) === "origin"
            ? () => void openEditOriginUrlDialog()
            : undefined,
      });
    },
    [
      repo,
      branchBusy,
      pullLocalBranch,
      mergeBranchIntoCurrent,
      rebaseCurrentBranchOnto,
      deleteLocalBranch,
      deleteRemoteBranch,
      openEditOriginUrlDialog,
      onCheckoutLocal,
      onCreateFromRemote,
    ],
  );

  const cherryPickCommit = useCallback(
    async (hash: string) => {
      if (!repo?.path || repo.error || repo.detached) return;
      const short = commits.find((c) => c.hash === hash)?.shortHash ?? hash.slice(0, 7);
      const ok = await ask(`Cherry-pick commit ${short} onto the current branch?`, {
        title: "Garlic",
        kind: "warning",
      });
      if (!ok) return;
      setBranchBusy("cherry-pick");
      setOperationError(null);
      try {
        await invoke("cherry_pick_commit", {
          path: repo.path,
          commitHash: hash,
        });
        await refreshAfterMutation();
      } catch (e) {
        setOperationError(invokeErrorMessage(e));
      } finally {
        setBranchBusy(null);
      }
    },
    [repo, commits, refreshAfterMutation],
  );

  const rebaseCurrentBranchOntoCommit = useCallback(
    async (hash: string) => {
      if (!repo?.path || repo.error || repo.detached) return;
      const short = commits.find((c) => c.hash === hash)?.shortHash ?? hash.slice(0, 7);
      const ok = await ask(
        `Rebase the current branch onto ${short}? Your commits will be replayed on top of this commit.`,
        { title: "Garlic", kind: "warning" },
      );
      if (!ok) return;
      setBranchBusy("rebase");
      setOperationError(null);
      try {
        await invoke("rebase_current_branch_onto", {
          path: repo.path,
          onto: hash,
          interactive: false,
        });
        await refreshAfterMutation();
      } catch (e) {
        setOperationError(invokeErrorMessage(e));
      } finally {
        setBranchBusy(null);
      }
    },
    [repo, commits, refreshAfterMutation],
  );

  const discardPathChanges = useCallback(
    async (filePath: string, fromUnstaged: boolean) => {
      if (!repo?.path || repo.error) return;
      const ok = await ask(
        fromUnstaged
          ? `Discard unstaged changes for "${filePath}"? Untracked files will be permanently deleted.`
          : `Discard staged changes for "${filePath}" and restore this path to the last commit?`,
        { title: "Garlic", kind: "warning" },
      );
      if (!ok) return;
      setStageCommitBusy(true);
      setOperationError(null);
      try {
        await invoke("discard_path_changes", {
          path: repo.path,
          filePath,
          fromUnstaged,
        });
        await refreshAfterMutation();
      } catch (e) {
        setOperationError(invokeErrorMessage(e));
      } finally {
        setStageCommitBusy(false);
      }
    },
    [repo, refreshAfterMutation],
  );

  const openFileHistory = useCallback(
    async (filePath: string) => {
      if (!repo?.path || repo.error) return;
      clearDiffSelection();
      setFileHistoryPath(filePath);
      setFileHistoryLoading(true);
      setFileHistoryError(null);
      setFileHistoryCommits([]);
      try {
        const rows = await invoke<CommitEntry[]>("list_file_history", {
          path: repo.path,
          filePath,
          limit: 200,
        });
        setFileHistoryCommits(rows);
      } catch (e) {
        setFileHistoryError(invokeErrorMessage(e));
      } finally {
        setFileHistoryLoading(false);
      }
    },
    [repo, clearDiffSelection],
  );

  const openFileBlame = useCallback(
    async (filePath: string) => {
      if (!repo?.path || repo.error) return;
      clearDiffSelection();
      setFileBlamePath(filePath);
      setFileBlameLoading(true);
      setFileBlameError(null);
      setFileBlameText(null);
      try {
        const text = await invoke<string>("get_file_blame", {
          path: repo.path,
          filePath,
        });
        setFileBlameText(text);
      } catch (e) {
        setFileBlameError(invokeErrorMessage(e));
      } finally {
        setFileBlameLoading(false);
      }
    },
    [repo, clearDiffSelection],
  );

  const openFileRowMenu = useCallback(
    (
      path: string,
      clientX: number,
      clientY: number,
      opts?: { source: "worktree"; variant: "staged" | "unstaged" } | { source: "commitBrowse" },
    ) => {
      const source = opts ?? { source: "commitBrowse" as const };
      if (source.source === "worktree") {
        void popupFileRowContextMenu(clientX, clientY, {
          source: "worktree",
          variant: source.variant,
          branchBusy: Boolean(branchBusy),
          stageCommitBusy: Boolean(stageCommitBusy || commitPushBusy || syncingStagePaths.size > 0),
          discardLabel:
            source.variant === "unstaged" ? "Discard unstaged changes…" : "Discard staged changes…",
          onHistory: () => void openFileHistory(path),
          onBlame: () => void openFileBlame(path),
          onOpenInCursor: () => {
            void (async () => {
              if (!repo?.path || repo.error) return;
              try {
                await invoke("open_in_cursor", { path: repo.path, filePath: path });
              } catch (e) {
                setOperationError(invokeErrorMessage(e));
              }
            })();
          },
          onDiscard: () => void discardPathChanges(path, source.variant === "unstaged"),
        });
      } else {
        void popupFileRowContextMenu(clientX, clientY, {
          source: "commitBrowse",
          branchBusy: Boolean(branchBusy),
          onHistory: () => void openFileHistory(path),
          onBlame: () => void openFileBlame(path),
        });
      }
    },
    [
      branchBusy,
      stageCommitBusy,
      commitPushBusy,
      syncingStagePaths,
      openFileHistory,
      openFileBlame,
      discardPathChanges,
      repo,
    ],
  );

  const onPickFileHistoryCommit = useCallback(
    async (hash: string) => {
      const rel = fileHistoryPath;
      if (!repo?.path || repo.error || !rel) return;
      await selectCommit(hash);
      await loadCommitFileDiff(rel, hash);
    },
    [repo, fileHistoryPath, selectCommit, loadCommitFileDiff],
  );

  const openGraphBranchLocalMenu = useCallback(
    (branchName: string, clientX: number, clientY: number) => {
      runBranchSidebarContextMenu({ kind: "local", branchName }, clientX, clientY);
    },
    [runBranchSidebarContextMenu],
  );

  const openGraphBranchRemoteMenu = useCallback(
    (fullRef: string, clientX: number, clientY: number) => {
      runBranchSidebarContextMenu({ kind: "remote", fullRef }, clientX, clientY);
    },
    [runBranchSidebarContextMenu],
  );

  const openGraphCommitMenu = useCallback(
    (hash: string, clientX: number, clientY: number) => {
      const entry = commits.find((x) => x.hash === hash);
      const shortHash = entry?.shortHash ?? hash.slice(0, 7);
      void popupGraphCommitContextMenu(clientX, clientY, {
        branchBusy: Boolean(branchBusy),
        cherryPickDisabled:
          Boolean(branchBusy) || Boolean(repo?.detached) || Boolean(entry?.stashRef),
        rebaseOntoDisabled:
          Boolean(branchBusy) ||
          Boolean(repo?.detached) ||
          Boolean(repo?.headHash && repo.headHash === hash),
        onBrowse: () => void selectCommit(hash),
        onCherryPick: () => void cherryPickCommit(hash),
        onRebaseCurrentOnto: () => void rebaseCurrentBranchOntoCommit(hash),
        onCreateBranch: () => {
          setCreateBranchStartCommit(hash);
          setNewBranchName("");
          setCreateBranchFieldError(null);
          setOperationError(null);
          createBranchDialogRef.current?.showModal();
          requestAnimationFrame(() => {
            newBranchInputRef.current?.focus();
          });
        },
        onCreateTag: () => {
          setCreateTagCommit(hash);
          setNewTagName("");
          setCreateTagMessage("");
          setCreateTagFieldError(null);
          setOperationError(null);
          createTagDialogRef.current?.showModal();
          requestAnimationFrame(() => {
            createTagNameInputRef.current?.focus();
          });
        },
        onCopyFull: () => void navigator.clipboard.writeText(hash),
        onCopyShort: () => void navigator.clipboard.writeText(shortHash),
      });
    },
    [branchBusy, repo, commits, selectCommit, cherryPickCommit, rebaseCurrentBranchOntoCommit],
  );

  const runPushTagToOrigin = useCallback(
    async (tagName: string) => {
      if (!repo?.path || repo.error) return;
      setPushBusy(true);
      setOperationError(null);
      try {
        await invoke("push_tag_to_origin", { path: repo.path, tag: tagName });
        await refreshAfterMutation();
      } catch (e) {
        setOperationError(invokeErrorMessage(e));
      } finally {
        setPushBusy(false);
      }
    },
    [repo, refreshAfterMutation],
  );

  const openGraphTagMenu = useCallback(
    (tagName: string, clientX: number, clientY: number) => {
      if (branchBusy || pushBusy) return;
      void popupGraphTagContextMenu(clientX, clientY, {
        pushDisabled: !repo?.path || Boolean(repo?.error),
        onPushToOrigin: () => {
          void runPushTagToOrigin(tagName);
        },
      });
    },
    [branchBusy, pushBusy, repo, runPushTagToOrigin],
  );

  const loadRepoListenerRef = useLatest(loadRepo);
  const onStashPushListenerRef = useLatest(onStashPush);
  const openCreateBranchDialogListenerRef = useLatest(openCreateBranchDialog);
  const openOpenAiSettingsDialogListenerRef = useLatest(openOpenAiSettingsDialog);
  const refreshAfterMutationListenerRef = useLatest(refreshAfterMutation);
  const handleCloneCompletePayloadListenerRef = useLatest(handleCloneCompletePayload);
  const openCloneRepoDialogListenerRef = useLatest(openCloneRepoDialog);
  const scheduleCloneProgressUiFlushListenerRef = useLatest(scheduleCloneProgressUiFlush);

  useEffect(() => {
    const promise = Promise.all([
      listen("open-openai-settings", () => {
        openOpenAiSettingsDialogListenerRef.current();
      }),
      listen("open-repo-request", () => {
        void (async () => {
          const selected = await open({
            directory: true,
            multiple: false,
            title: "Open repository",
          });
          if (selected === null || Array.isArray(selected)) return;
          await loadRepoListenerRef.current(selected);
        })();
      }),
      listen("clone-repo-request", () => {
        openCloneRepoDialogListenerRef.current();
      }),
      listen<string>("open-recent-repo", (e) => {
        const path = e.payload.trim();
        if (path) void loadRepoListenerRef.current(path);
      }),
      listen("new-branch-request", () => {
        openCreateBranchDialogListenerRef.current();
      }),
      listen("stash-push-request", () => {
        void onStashPushListenerRef.current();
      }),
      listen<{ theme: string }>("theme-changed", (e) => {
        const pref = e.payload.theme;
        setThemePreference(pref);
        document.documentElement.setAttribute("data-theme", resolveThemePreference(pref));
      }),
      listen("repository-mutated", () => {
        void refreshAfterMutationListenerRef.current();
      }),
      listen<CommitSignatureResultPayload>("commit-signature-result", (e) => {
        const p = e.payload;
        if (activeRepoPathRef.current !== p.path) return;
        if (p.requestId !== selectCommitSeqRef.current) return;
        setCommitSignature({ loading: false, verified: p.verified });
      }),
      listen<CloneProgressPayload>("clone-progress", (e) => {
        const p = e.payload;
        if (
          pendingCloneSessionRef.current !== null &&
          pendingCloneSessionRef.current !== p.sessionId
        ) {
          return;
        }
        pendingCloneSessionRef.current = p.sessionId;
        const segments = p.message
          .split(/\r/)
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        if (segments.length === 0) return;
        const pctFromPayload =
          p.percent !== undefined && p.percent !== null && !Number.isNaN(p.percent)
            ? Math.min(100, Math.max(0, Math.round(p.percent)))
            : null;
        for (const segment of segments) {
          const segPct = parseGitCloneProgressPercent(segment);
          const pctRaw = segPct ?? (segments.length === 1 ? pctFromPayload : null);
          if (pctRaw != null) {
            cloneProgressMaxPercentRef.current = Math.max(
              cloneProgressMaxPercentRef.current ?? 0,
              pctRaw,
            );
          }
          const lines = cloneLogLinesRef.current;
          const last = lines.length > 0 ? lines[lines.length - 1] : "";
          if (last !== segment) {
            cloneLogLinesRef.current = [...lines, segment].slice(-200);
          }
        }
        scheduleCloneProgressUiFlushListenerRef.current();
      }),
      listen<CloneDonePayload>("clone-complete", (e) => {
        const p = e.payload;
        if (
          pendingCloneSessionRef.current !== null &&
          pendingCloneSessionRef.current !== p.sessionId
        ) {
          return;
        }
        if (pendingCloneSessionRef.current === null) {
          cloneCompleteQueuedRef.current = p;
          return;
        }
        handleCloneCompletePayloadListenerRef.current(p);
      }),
      listen<GitCommandStreamStartedPayload>("git-command-stream-started", (e) => {
        const p = e.payload;
        if (activeRepoPathRef.current !== p.repoPath) return;
        gitStreamSessionRef.current = p.sessionId;
        setGitCommandStream({
          sessionId: p.sessionId,
          operation: p.operation,
          commandLine: p.commandLine,
          lines: [],
          finished: false,
          success: null,
          error: null,
        });
      }),
      listen<GitCommandStreamLinePayload>("git-command-stream-line", (e) => {
        const p = e.payload;
        if (activeRepoPathRef.current !== p.repoPath) return;
        if (gitStreamSessionRef.current !== p.sessionId) return;
        setGitCommandStream((prev) => {
          if (!prev || prev.sessionId !== p.sessionId) return prev;
          const next = [...prev.lines, { stream: p.stream, text: p.line }].slice(-400);
          return { ...prev, lines: next };
        });
      }),
      listen<GitCommandStreamFinishedPayload>("git-command-stream-finished", (e) => {
        const p = e.payload;
        if (activeRepoPathRef.current !== p.repoPath) return;
        if (gitStreamSessionRef.current !== p.sessionId) return;
        setGitCommandStream((prev) => {
          if (!prev || prev.sessionId !== p.sessionId) return prev;
          return {
            ...prev,
            finished: true,
            success: p.success,
            error: p.error ?? null,
          };
        });
      }),
    ]);

    return () => {
      void promise.then((unlisteners) => {
        for (const unlisten of unlisteners) {
          try {
            const p = (unlisten as () => Promise<void>)();
            void p.catch(() => {});
          } catch {
            /* stale registry after HMR / reload */
          }
        }
      });
    };
  }, [
    handleCloneCompletePayloadListenerRef,
    loadRepoListenerRef,
    onStashPushListenerRef,
    openCloneRepoDialogListenerRef,
    openCreateBranchDialogListenerRef,
    openOpenAiSettingsDialogListenerRef,
    refreshAfterMutationListenerRef,
    scheduleCloneProgressUiFlushListenerRef,
  ]);

  useEffect(() => {
    if (themePreference !== "auto") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      document.documentElement.setAttribute("data-theme", mq.matches ? "dark" : "light");
    };
    apply();
    mq.addEventListener("change", apply);
    return () => {
      mq.removeEventListener("change", apply);
    };
  }, [themePreference]);

  async function submitCreateBranch() {
    const trimmed = newBranchName.trim();
    if (!repo?.path || repo.error) return;
    if (!trimmed) {
      setCreateBranchFieldError("Enter a branch name.");
      return;
    }
    const nameErr = branchNameValidationError(trimmed);
    if (nameErr) {
      setCreateBranchFieldError(nameErr);
      return;
    }
    setCreateBranchFieldError(null);
    setBranchBusy("create");
    setOperationError(null);
    try {
      if (createBranchStartCommit) {
        await invoke("create_branch_at_commit", {
          path: repo.path,
          branch: trimmed,
          commit: createBranchStartCommit,
        });
      } else {
        await invoke("create_local_branch", {
          path: repo.path,
          branch: trimmed,
        });
      }
      createBranchDialogRef.current?.close();
      await refreshAfterMutation();
    } catch (e) {
      setOperationError(invokeErrorMessage(e));
    } finally {
      setBranchBusy(null);
    }
  }

  async function submitCreateTag() {
    const trimmed = newTagName.trim();
    if (!repo?.path || repo.error) return;
    if (!createTagCommit) return;
    if (!trimmed) {
      setCreateTagFieldError("Enter a tag name.");
      return;
    }
    const nameErr = tagNameValidationError(trimmed);
    if (nameErr) {
      setCreateTagFieldError(nameErr);
      return;
    }
    setCreateTagFieldError(null);
    setBranchBusy("tag");
    setOperationError(null);
    try {
      const msg = createTagMessage.trim();
      await invoke("create_tag", {
        path: repo.path,
        tag: trimmed,
        commit: createTagCommit,
        message: msg.length > 0 ? msg : null,
      });
      createTagDialogRef.current?.close();
      await refreshAfterMutation();
    } catch (e) {
      setOperationError(invokeErrorMessage(e));
    } finally {
      setBranchBusy(null);
    }
  }

  async function onStashPop(stashRef: string) {
    if (!repo?.path || repo.error) return;
    const ok = await ask(`Pop ${stashRef} and apply its changes to the working tree?`, {
      title: "Garlic",
      kind: "warning",
    });
    if (!ok) return;
    setStashBusy(`pop:${stashRef}`);
    setOperationError(null);
    try {
      await invoke("stash_pop", { path: repo.path, stashRef });
      await refreshAfterMutation();
    } catch (e) {
      setOperationError(invokeErrorMessage(e));
    } finally {
      setStashBusy(null);
    }
  }

  async function onStashDrop(stashRef: string) {
    if (!repo?.path || repo.error) return;
    const ok = await ask(`Drop ${stashRef} permanently? This cannot be undone.`, {
      title: "Garlic",
      kind: "warning",
    });
    if (!ok) return;
    setStashBusy(`drop:${stashRef}`);
    setOperationError(null);
    try {
      await invoke("stash_drop", { path: repo.path, stashRef });
      await refreshAfterMutation();
    } catch (e) {
      setOperationError(invokeErrorMessage(e));
    } finally {
      setStashBusy(null);
    }
  }

  function openGraphStashMenu(stashRef: string, clientX: number, clientY: number) {
    void popupStashContextMenu(clientX, clientY, {
      disabled: Boolean(branchBusy) || stashBusy !== null,
      onPop: () => void onStashPop(stashRef),
      onDrop: () => void onStashDrop(stashRef),
    });
  }

  async function onDeleteTag(tagName: string) {
    if (!repo?.path || repo.error) return;
    const ok = await ask(
      `Delete local tag "${tagName}"? This does not remove the tag on origin (use “Delete tag on origin” if needed).`,
      { title: "Garlic", kind: "warning" },
    );
    if (!ok) return;
    setBranchBusy(`delete-tag:${tagName}`);
    setOperationError(null);
    try {
      await invoke("delete_tag", { path: repo.path, tag: tagName });
      await refreshAfterMutation();
    } catch (e) {
      setOperationError(invokeErrorMessage(e));
    } finally {
      setBranchBusy(null);
    }
  }

  async function onDeleteRemoteTag(tagName: string) {
    if (!repo?.path || repo.error) return;
    const ok = await ask(
      `Delete tag "${tagName}" from origin? This does not remove your local tag.`,
      { title: "Garlic", kind: "warning" },
    );
    if (!ok) return;
    setBranchBusy(`delete-remote-tag:${tagName}`);
    setOperationError(null);
    try {
      await invoke("delete_remote_tag", { path: repo.path, tag: tagName });
      await refreshAfterMutation();
    } catch (e) {
      setOperationError(invokeErrorMessage(e));
    } finally {
      setBranchBusy(null);
    }
  }

  async function openTagSidebarMenu(tagName: string, clientX: number, clientY: number) {
    if (!repo?.path || repo.error) return;
    if (branchBusy || stashBusy !== null || pushBusy) return;
    let status: TagOriginStatus = { hasOrigin: false, onOrigin: false };
    try {
      status = await invoke<TagOriginStatus>("tag_origin_status", {
        path: repo.path,
        tag: tagName,
      });
    } catch {
      // e.g. ls-remote failed while offline
    }
    void popupTagSidebarMenu(clientX, clientY, {
      disabled: Boolean(branchBusy) || stashBusy !== null || pushBusy,
      hasOrigin: status.hasOrigin,
      onOrigin: status.onOrigin,
      onDeleteLocal: () => void onDeleteTag(tagName),
      onDeleteRemote: () => void onDeleteRemoteTag(tagName),
      onPushToOrigin: () => void runPushTagToOrigin(tagName),
    });
  }

  async function onStagePaths(paths: string[]) {
    if (!repo?.path || repo.error || paths.length === 0) return;
    const nextPaths = [...new Set(paths)].filter((path) => !syncingStagePaths.has(path));
    if (nextPaths.length === 0) return;
    setOperationError(null);
    setSyncingStagePaths((prev) => {
      const next = new Set(prev);
      for (const path of nextPaths) next.add(path);
      return next;
    });
    setWorkingTreeFiles((prev) => applyOptimisticStageChange(prev, nextPaths, "stage"));
    if (
      selectedDiffRepoPath === repo.path &&
      selectedDiffPath !== null &&
      nextPaths.includes(selectedDiffPath) &&
      selectedDiffSide === "unstaged"
    ) {
      setSelectedDiffSide("staged");
      setDiffStagedText(null);
      setDiffUnstagedText(null);
      setDiffError(null);
    }
    try {
      await invoke("stage_paths", { path: repo.path, paths: nextPaths });
      await refreshAfterMutation();
    } catch (e) {
      setOperationError(invokeErrorMessage(e));
      await refreshAfterMutation();
    } finally {
      setSyncingStagePaths((prev) => {
        const next = new Set(prev);
        for (const path of nextPaths) next.delete(path);
        return next;
      });
    }
  }

  async function onUnstagePaths(paths: string[]) {
    if (!repo?.path || repo.error || paths.length === 0) return;
    const nextPaths = [...new Set(paths)].filter((path) => !syncingStagePaths.has(path));
    if (nextPaths.length === 0) return;
    setOperationError(null);
    setSyncingStagePaths((prev) => {
      const next = new Set(prev);
      for (const path of nextPaths) next.add(path);
      return next;
    });
    setWorkingTreeFiles((prev) => applyOptimisticStageChange(prev, nextPaths, "unstage"));
    if (
      selectedDiffRepoPath === repo.path &&
      selectedDiffPath !== null &&
      nextPaths.includes(selectedDiffPath) &&
      selectedDiffSide === "staged"
    ) {
      setSelectedDiffSide("unstaged");
      setDiffStagedText(null);
      setDiffUnstagedText(null);
      setDiffError(null);
    }
    try {
      await invoke("unstage_paths", { path: repo.path, paths: nextPaths });
      await refreshAfterMutation();
    } catch (e) {
      setOperationError(invokeErrorMessage(e));
      await refreshAfterMutation();
    } finally {
      setSyncingStagePaths((prev) => {
        const next = new Set(prev);
        for (const path of nextPaths) next.delete(path);
        return next;
      });
    }
  }

  const runPartialStagePatch = useCallback(
    async (filePath: string, mode: "stage" | "unstage", patch: string) => {
      if (!repo?.path || repo.error || !filePath.trim() || !patch.trim()) return;
      if (syncingStagePaths.has(filePath)) return;
      setOperationError(null);
      setSyncingStagePaths((prev) => {
        const next = new Set(prev);
        next.add(filePath);
        return next;
      });
      try {
        if (mode === "stage") {
          await invoke("stage_patch", { path: repo.path, patch });
        } else {
          await invoke("unstage_patch", { path: repo.path, patch });
        }
        await refreshAfterMutation();
      } catch (e) {
        setOperationError(invokeErrorMessage(e));
        await refreshAfterMutation();
      } finally {
        setSyncingStagePaths((prev) => {
          const next = new Set(prev);
          next.delete(filePath);
          return next;
        });
      }
    },
    [repo, syncingStagePaths, refreshAfterMutation],
  );

  const runDiscardHunkPatch = useCallback(
    async (filePath: string, patch: string) => {
      if (!repo?.path || repo.error || !filePath.trim() || !patch.trim()) return;
      if (syncingStagePaths.has(filePath)) return;
      setOperationError(null);
      setSyncingStagePaths((prev) => {
        const next = new Set(prev);
        next.add(filePath);
        return next;
      });
      try {
        await invoke("discard_patch", { path: repo.path, patch });
        await refreshAfterMutation();
      } catch (e) {
        setOperationError(invokeErrorMessage(e));
        await refreshAfterMutation();
      } finally {
        setSyncingStagePaths((prev) => {
          const next = new Set(prev);
          next.delete(filePath);
          return next;
        });
      }
    },
    [repo, syncingStagePaths, refreshAfterMutation],
  );

  const canShowBranches = Boolean(repo && !repo.error && !loading);
  const currentBranchName = repo?.detached ? null : (repo?.branch ?? null);
  const commitsSectionTitle =
    currentBranchName ??
    (repo?.detached
      ? repo.headShort
        ? `Detached (${repo.headShort})`
        : "Detached HEAD"
      : (repo?.headShort ?? "Current branch"));

  const unstagedFiles = useMemo(
    () => workingTreeFiles.filter((file) => file.unstaged),
    [workingTreeFiles],
  );
  const stagedFiles = useMemo(
    () => workingTreeFiles.filter((file) => file.staged),
    [workingTreeFiles],
  );
  const hasStagedFiles = stagedFiles.length > 0;
  const unstagedPaths = useMemo(() => unstagedFiles.map((file) => file.path), [unstagedFiles]);
  const stagedPaths = useMemo(() => stagedFiles.map((file) => file.path), [stagedFiles]);
  const wipChangedFileCount = useMemo(() => {
    const paths = new Set<string>();
    for (const f of workingTreeFiles) {
      if (f.staged || f.unstaged) paths.add(f.path);
    }
    return paths.size;
  }, [workingTreeFiles]);
  const preferredWipFile = useMemo(
    () => unstagedFiles[0] ?? stagedFiles[0] ?? null,
    [stagedFiles, unstagedFiles],
  );
  const stageSyncBusy = syncingStagePaths.size > 0;

  const newBranchTrimmed = newBranchName.trim();
  const newBranchNameInvalid =
    newBranchTrimmed.length > 0 && branchNameValidationError(newBranchTrimmed) !== null;
  const canSubmitNewBranch =
    newBranchTrimmed.length > 0 && !newBranchNameInvalid && branchBusy !== "create";

  const newTagTrimmed = newTagName.trim();
  const newTagNameInvalid =
    newTagTrimmed.length > 0 && tagNameValidationError(newTagTrimmed) !== null;
  const canSubmitNewTag = newTagTrimmed.length > 0 && !newTagNameInvalid && branchBusy !== "tag";

  const createBranchStartEntry = useMemo(() => {
    if (!createBranchStartCommit) return null;
    return commits.find((c) => c.hash === createBranchStartCommit) ?? null;
  }, [commits, createBranchStartCommit]);

  const createTagStartEntry = useMemo(() => {
    if (!createTagCommit) return null;
    return commits.find((c) => c.hash === createTagCommit) ?? null;
  }, [commits, createTagCommit]);

  const worktreeBrowseFileEntries = useMemo(
    () =>
      worktreeBrowseFiles.map((file) => ({
        file,
        stats: combineLineStats(file.stagedStats, file.unstagedStats) ?? {
          additions: 0,
          deletions: 0,
          isBinary: false,
        },
      })),
    [worktreeBrowseFiles],
  );
  const browsingCurrentRepoWorktree = worktreeBrowseTarget?.path === repo?.path;
  const canEditSelectedDiff = selectedDiffRepoPath === repo?.path;
  const selectedDiffBusy =
    selectedDiffPath !== null &&
    (stageCommitBusy || commitPushBusy || syncingStagePaths.has(selectedDiffPath));
  const stagedSelectedDiffImagePreview = useMemo(() => {
    if (
      selectedDiffSide !== "staged" ||
      !diffImagePreview ||
      !selectedDiffPath ||
      !pathLooksLikeRenderableImage(selectedDiffPath) ||
      (!diffImagePreview.before && !diffImagePreview.after)
    ) {
      return null;
    }
    return {
      beforeUrl: diffImagePreview.before,
      afterUrl: diffImagePreview.after,
      fileLabel: selectedDiffPath,
    };
  }, [diffImagePreview, selectedDiffPath, selectedDiffSide]);
  const unstagedSelectedDiffImagePreview = useMemo(() => {
    if (
      selectedDiffSide !== "unstaged" ||
      !diffImagePreview ||
      !selectedDiffPath ||
      !pathLooksLikeRenderableImage(selectedDiffPath) ||
      (!diffImagePreview.before && !diffImagePreview.after)
    ) {
      return null;
    }
    return {
      beforeUrl: diffImagePreview.before,
      afterUrl: diffImagePreview.after,
      fileLabel: selectedDiffPath,
    };
  }, [diffImagePreview, selectedDiffPath, selectedDiffSide]);
  const applySelectedStagedPatch = useCallback(
    (patch: string) => {
      if (!selectedDiffPath) return;
      void runPartialStagePatch(selectedDiffPath, "unstage", patch);
    },
    [runPartialStagePatch, selectedDiffPath],
  );
  const applySelectedUnstagedPatch = useCallback(
    (patch: string) => {
      if (!selectedDiffPath) return;
      void runPartialStagePatch(selectedDiffPath, "stage", patch);
    },
    [runPartialStagePatch, selectedDiffPath],
  );
  const discardSelectedUnstagedPatch = useCallback(
    (patch: string) => {
      if (!selectedDiffPath) return;
      void runDiscardHunkPatch(selectedDiffPath, patch);
    },
    [runDiscardHunkPatch, selectedDiffPath],
  );
  const stagedSelectedDiffAction = useMemo(() => {
    if (!canEditSelectedDiff || selectedDiffSide !== "staged" || !selectedDiffPath) return null;
    return {
      kind: "unstage" as const,
      busy: selectedDiffBusy,
      onApplyPatch: applySelectedStagedPatch,
    };
  }, [
    applySelectedStagedPatch,
    canEditSelectedDiff,
    selectedDiffBusy,
    selectedDiffPath,
    selectedDiffSide,
  ]);
  const unstagedSelectedDiffAction = useMemo(() => {
    if (!canEditSelectedDiff || selectedDiffSide !== "unstaged" || !selectedDiffPath) return null;
    return {
      kind: "stage" as const,
      busy: selectedDiffBusy,
      onApplyPatch: applySelectedUnstagedPatch,
    };
  }, [
    applySelectedUnstagedPatch,
    canEditSelectedDiff,
    selectedDiffBusy,
    selectedDiffPath,
    selectedDiffSide,
  ]);
  const discardSelectedDiffAction = useMemo(() => {
    if (!canEditSelectedDiff || selectedDiffSide !== "unstaged" || !selectedDiffPath) return null;
    return {
      label: "Discard hunk",
      buttonClassName: "btn-error",
      busy: selectedDiffBusy,
      onApplyPatch: discardSelectedUnstagedPatch,
    };
  }, [
    canEditSelectedDiff,
    discardSelectedUnstagedPatch,
    selectedDiffBusy,
    selectedDiffPath,
    selectedDiffSide,
  ]);
  const commitDiffBinaryImagePreview = useMemo(() => {
    if (
      !commitDiffImagePreview ||
      !commitDiffPath ||
      !pathLooksLikeRenderableImage(commitDiffPath) ||
      (!commitDiffImagePreview.before && !commitDiffImagePreview.after)
    ) {
      return null;
    }
    return {
      beforeUrl: commitDiffImagePreview.before,
      afterUrl: commitDiffImagePreview.after,
      fileLabel: commitDiffPath,
    };
  }, [commitDiffImagePreview, commitDiffPath]);
  const clearGraphFilters = useCallback(() => {
    setGraphAuthorFilter("");
    setGraphDateFrom("");
    setGraphDateTo("");
  }, []);
  const handleLoadMoreGraphCommits = useCallback(() => {
    void loadMoreGraphCommits();
  }, [loadMoreGraphCommits]);
  const handleGraphRowCommitSelect = useCallback(
    (hash: string) => {
      void selectCommit(hash);
    },
    [selectCommit],
  );
  const handleExportGraphCommits = useCallback(() => {
    void exportFilteredCommitsList();
  }, [exportFilteredCommitsList]);
  const handleSelectWipRow = useCallback(() => {
    if (!preferredWipFile) return;
    void loadDiffForFile(preferredWipFile, preferredWipFile.unstaged ? "unstaged" : "staged");
  }, [loadDiffForFile, preferredWipFile]);
  const clearGitCommandStream = useCallback(() => {
    setGitCommandStream(null);
    gitStreamSessionRef.current = null;
  }, []);
  const handleCheckoutLocal = useCallback(
    (branchName: string) => {
      void onCheckoutLocal(branchName);
    },
    [onCheckoutLocal],
  );
  const handleCreateFromRemote = useCallback(
    (remoteRef: string) => {
      void onCreateFromRemote(remoteRef);
    },
    [onCreateFromRemote],
  );
  const handleOpenWorktree = useCallback(
    (path: string) => {
      void loadRepo(path);
    },
    [loadRepo],
  );
  const handlePreviewWorktreeDiff = useCallback(
    (worktree: WorktreeEntry) => {
      void openWorktreeBrowse(worktree);
    },
    [openWorktreeBrowse],
  );
  const submitCommit = useCallback(
    async ({ message, amendLastCommit }: { message: string; amendLastCommit: boolean }) => {
      if (!repo?.path || repo.error) return false;
      if (!amendLastCommit && !message) return false;
      if (amendLastCommit && message.length === 0 && !hasStagedFiles) return false;
      setStageCommitBusy(true);
      setOperationError(null);
      try {
        if (amendLastCommit) {
          await invoke("amend_last_commit", {
            path: repo.path,
            message: message.length > 0 ? message : null,
          });
        } else {
          await invoke("commit_staged", { path: repo.path, message });
        }
        await refreshAfterMutation();
        return true;
      } catch (e) {
        setOperationError(invokeErrorMessage(e));
        return false;
      } finally {
        setStageCommitBusy(false);
      }
    },
    [hasStagedFiles, refreshAfterMutation, repo],
  );
  const pushCurrentBranchToOrigin = useCallback(
    async ({ skipHooks }: { skipHooks: boolean }) => {
      if (!repo?.path || repo.error) return;
      setPushBusy(true);
      setOperationError(null);
      try {
        await invoke("push_to_origin", {
          path: repo.path,
          skipHooks,
        });
        await refreshAfterMutation();
      } catch (e) {
        setOperationError(invokeErrorMessage(e));
      } finally {
        setPushBusy(false);
      }
    },
    [refreshAfterMutation, repo],
  );
  const submitCommitAndPush = useCallback(
    async ({ message, skipHooks }: { message: string; skipHooks: boolean }) => {
      if (!repo?.path || repo.error || repo.detached || !message || !hasStagedFiles) return false;
      setCommitPushBusy(true);
      setOperationError(null);
      let committed = false;
      try {
        await invoke("commit_staged", { path: repo.path, message });
        committed = true;
        await invoke("push_to_origin", {
          path: repo.path,
          skipHooks,
        });
        await refreshAfterMutation();
        return true;
      } catch (e) {
        setOperationError(invokeErrorMessage(e));
        void refreshAfterMutation();
        return committed;
      } finally {
        setCommitPushBusy(false);
      }
    },
    [hasStagedFiles, refreshAfterMutation, repo],
  );

  /** Branch/stash sidebar hidden; main column spans 9 — when viewing a commit, file diff, history, or blame. */
  const showExpandedDiff =
    Boolean(
      worktreeBrowseTarget ||
      commitBrowseHash ||
      selectedDiffPath ||
      commitDiffPath ||
      fileHistoryPath ||
      fileBlamePath,
    ) &&
    !listsError &&
    Boolean(repo && !repo.error);

  const commitGraphLayout = useMemo((): CommitGraphLayout | null => {
    if (
      worktreeBrowseTarget ||
      commitBrowseHash ||
      selectedDiffPath ||
      fileBlamePath ||
      fileHistoryPath
    ) {
      return null;
    }
    return computeCommitGraphLayout(
      graphDisplayCommits.map((c) => ({
        hash: c.hash,
        parentHashes: c.parentHashes,
        stashRef: c.stashRef,
      })),
      graphBranchTips,
      currentBranchName,
    );
  }, [
    worktreeBrowseTarget,
    commitBrowseHash,
    selectedDiffPath,
    fileBlamePath,
    fileHistoryPath,
    graphDisplayCommits,
    graphBranchTips,
    currentBranchName,
  ]);

  /** Tip commit of the checked-out branch — used to highlight that row in the graph. */
  const currentBranchTipHash = useMemo(() => {
    if (!currentBranchName) return null;
    return localBranches.find((b) => b.name === currentBranchName)?.tipHash ?? null;
  }, [currentBranchName, localBranches]);

  return (
    <main className="box-border flex min-h-0 flex-1 flex-col overflow-hidden bg-base-200 px-4 pt-4 pb-4 text-base-content antialiased [font-synthesis:none]">
      <div
        className="grid min-h-0 min-w-0 flex-1 grid-cols-12 gap-4 lg:min-h-0 lg:grid-rows-1 lg:items-stretch"
        aria-live="polite"
        aria-busy={loading}
      >
        <aside
          className={`col-span-12 flex min-h-0 min-w-0 flex-col gap-3 lg:col-span-3 lg:h-full lg:min-h-0 ${
            showExpandedDiff ? "hidden" : ""
          }`}
        >
          <dialog
            ref={cloneRepoDialogRef}
            className="modal"
            onMouseDown={cloneRepoDialogBackdropClose.onMouseDown}
            onMouseUp={cloneRepoDialogBackdropClose.onMouseUp}
            onClose={() => {
              setCloneRepoUrlDraft("https://github.com/");
            }}
          >
            <div
              className="modal-box"
              onClick={(e) => {
                e.stopPropagation();
              }}
            >
              <h3 className="m-0 text-lg font-bold">Clone repository</h3>
              <p className="mt-1 mb-0 text-sm text-base-content/70">
                Enter the remote URL, then choose a folder where the new repository directory should
                be created.
              </p>
              <label className="form-control mt-4 block w-full">
                <span className="label-text mb-1">Remote URL</span>
                <input
                  ref={cloneRepoUrlInputRef}
                  type="text"
                  inputMode="url"
                  className="input-bordered input w-full font-mono text-sm"
                  value={cloneRepoUrlDraft}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(e) => {
                    setCloneRepoUrlDraft(e.target.value);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void submitCloneRepository();
                    }
                  }}
                />
              </label>
              <div className="modal-action">
                <button
                  type="button"
                  className="btn"
                  onClick={() => cloneRepoDialogRef.current?.close()}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={!cloneRepoUrlDraft.trim()}
                  onClick={() => void submitCloneRepository()}
                >
                  Continue
                </button>
              </div>
            </div>
          </dialog>

          <dialog
            ref={createBranchDialogRef}
            className="modal"
            onMouseDown={createBranchDialogBackdropClose.onMouseDown}
            onMouseUp={createBranchDialogBackdropClose.onMouseUp}
            onClose={() => {
              setNewBranchName("");
              setCreateBranchFieldError(null);
              setCreateBranchStartCommit(null);
            }}
          >
            <div
              className="modal-box"
              onClick={(e) => {
                e.stopPropagation();
              }}
            >
              <h3 className="m-0 text-lg font-bold">New local branch</h3>
              <p className="mt-1 mb-0 text-sm text-base-content/70">
                {createBranchStartCommit
                  ? "Creates a branch starting at the chosen commit and switches to it."
                  : "Creates a branch from the current commit and switches to it."}
              </p>
              {createBranchStartCommit ? (
                <p className="mt-2 mb-0 text-xs text-base-content/70">
                  <span className="font-mono text-base-content/80">
                    {createBranchStartEntry?.shortHash ?? createBranchStartCommit.slice(0, 7)}
                  </span>
                  {createBranchStartEntry?.subject ? (
                    <span className="block truncate pt-0.5">{createBranchStartEntry.subject}</span>
                  ) : null}
                </p>
              ) : null}
              <label className="form-control mt-4 block w-full">
                <span className="label-text mb-1">Branch name</span>
                <input
                  ref={newBranchInputRef}
                  type="text"
                  className="input-bordered input w-full font-mono text-sm"
                  value={newBranchName}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={branchBusy === "create"}
                  onChange={(e) => {
                    setNewBranchName(e.target.value);
                    if (createBranchFieldError) setCreateBranchFieldError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === " ") {
                      e.preventDefault();
                    }
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void submitCreateBranch();
                    }
                  }}
                />
                {createBranchFieldError ? (
                  <span className="label-text-alt mt-1 block w-full text-error">
                    {createBranchFieldError}
                  </span>
                ) : newBranchNameInvalid ? (
                  <span className="label-text-alt mt-1 block w-full text-error">
                    {branchNameValidationError(newBranchTrimmed)}
                  </span>
                ) : null}
              </label>
              <div className="modal-action">
                <button
                  type="button"
                  className="btn"
                  disabled={branchBusy === "create"}
                  onClick={() => createBranchDialogRef.current?.close()}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={!canSubmitNewBranch}
                  onClick={() => void submitCreateBranch()}
                >
                  {branchBusy === "create" ? (
                    <span className="loading loading-sm loading-spinner" />
                  ) : (
                    "Create"
                  )}
                </button>
              </div>
            </div>
          </dialog>

          <dialog
            ref={createTagDialogRef}
            className="modal"
            onMouseDown={createTagDialogBackdropClose.onMouseDown}
            onMouseUp={createTagDialogBackdropClose.onMouseUp}
            onClose={() => {
              setNewTagName("");
              setCreateTagMessage("");
              setCreateTagFieldError(null);
              setCreateTagCommit(null);
            }}
          >
            <div
              className="modal-box"
              onClick={(e) => {
                e.stopPropagation();
              }}
            >
              <h3 className="m-0 text-lg font-bold">Create tag</h3>
              <p className="mt-1 mb-0 text-sm text-base-content/70">
                Creates a lightweight tag at this commit. Add an optional message to create an
                annotated tag instead.
              </p>
              {createTagCommit ? (
                <p className="mt-2 mb-0 text-xs text-base-content/70">
                  <span className="font-mono text-base-content/80">
                    {createTagStartEntry?.shortHash ?? createTagCommit.slice(0, 7)}
                  </span>
                  {createTagStartEntry?.subject ? (
                    <span className="block truncate pt-0.5">{createTagStartEntry.subject}</span>
                  ) : null}
                </p>
              ) : null}
              <label className="form-control mt-4 block w-full">
                <span className="label-text mb-1">Tag name</span>
                <input
                  ref={createTagNameInputRef}
                  type="text"
                  className="input-bordered input w-full font-mono text-sm"
                  value={newTagName}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={branchBusy === "tag"}
                  onChange={(e) => {
                    setNewTagName(e.target.value);
                    if (createTagFieldError) setCreateTagFieldError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void submitCreateTag();
                    }
                  }}
                />
                {createTagFieldError ? (
                  <span className="label-text-alt mt-1 block w-full text-error">
                    {createTagFieldError}
                  </span>
                ) : newTagNameInvalid ? (
                  <span className="label-text-alt mt-1 block w-full text-error">
                    {tagNameValidationError(newTagTrimmed)}
                  </span>
                ) : null}
              </label>
              <label className="form-control mt-3 block w-full">
                <span className="label-text mb-1">Annotation message (optional)</span>
                <textarea
                  className="textarea-bordered textarea min-h-18 w-full font-mono text-sm textarea-sm"
                  value={createTagMessage}
                  placeholder="Leave empty for a lightweight tag"
                  disabled={branchBusy === "tag"}
                  onChange={(e) => {
                    setCreateTagMessage(e.target.value);
                  }}
                />
              </label>
              <div className="modal-action">
                <button
                  type="button"
                  className="btn"
                  disabled={branchBusy === "tag"}
                  onClick={() => createTagDialogRef.current?.close()}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={!canSubmitNewTag}
                  onClick={() => void submitCreateTag()}
                >
                  {branchBusy === "tag" ? (
                    <span className="loading loading-sm loading-spinner" />
                  ) : (
                    "Create tag"
                  )}
                </button>
              </div>
            </div>
          </dialog>

          <dialog
            ref={editOriginUrlDialogRef}
            className="modal"
            onMouseDown={editOriginUrlDialogBackdropClose.onMouseDown}
            onMouseUp={editOriginUrlDialogBackdropClose.onMouseUp}
            onClose={() => {
              setEditOriginUrl("");
            }}
          >
            <div
              className="modal-box"
              onClick={(e) => {
                e.stopPropagation();
              }}
            >
              <h3 className="m-0 text-lg font-bold">Edit origin URL</h3>
              <p className="mt-1 mb-0 text-sm text-base-content/70">
                Updates where Git fetches from and pushes to for the{" "}
                <span className="font-mono">origin</span> remote.
              </p>
              <label className="form-control mt-4 w-full">
                <span className="label-text mb-1">Remote URL</span>
                <input
                  ref={editOriginUrlInputRef}
                  type="text"
                  className="input-bordered input w-full font-mono text-sm"
                  value={editOriginUrl}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={branchBusy === "remote-url"}
                  onChange={(e) => {
                    setEditOriginUrl(e.target.value);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void submitEditOriginUrl();
                    }
                  }}
                />
              </label>
              <div className="modal-action">
                <button
                  type="button"
                  className="btn"
                  disabled={branchBusy === "remote-url"}
                  onClick={() => editOriginUrlDialogRef.current?.close()}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={branchBusy === "remote-url" || !editOriginUrl.trim()}
                  onClick={() => void submitEditOriginUrl()}
                >
                  {branchBusy === "remote-url" ? (
                    <span className="loading loading-sm loading-spinner" />
                  ) : (
                    "Save"
                  )}
                </button>
              </div>
            </div>
          </dialog>

          <BranchSidebar
            repoPath={repo?.path ?? null}
            canShowBranches={canShowBranches}
            localBranches={localBranches}
            remoteBranches={remoteBranches}
            worktrees={worktrees}
            tags={tags}
            stashes={stashes}
            branchBusy={branchBusy}
            stashBusy={stashBusy}
            pushBusy={pushBusy}
            branchGraphControls={branchGraphControls}
            currentBranchName={currentBranchName}
            branchSidebarSections={branchSidebarSections}
            onBranchSidebarSectionsChange={persistBranchSidebarSections}
            onSelectLocalBranchTip={onSelectLocalBranchTip}
            onCheckoutLocal={handleCheckoutLocal}
            onSelectRemoteBranchTip={onSelectRemoteBranchTip}
            onCreateFromRemote={handleCreateFromRemote}
            onOpenWorktree={handleOpenWorktree}
            onPreviewWorktreeDiff={handlePreviewWorktreeDiff}
            onWorktreeContextMenu={runWorktreeSidebarContextMenu}
            onStashClick={onStashSidebarClick}
            onTagClick={onTagSidebarClick}
            runBranchSidebarContextMenu={runBranchSidebarContextMenu}
            openGraphStashMenu={openGraphStashMenu}
            openTagSidebarMenu={openTagSidebarMenu}
          />
          <GitCommandPanel
            repoPath={repo?.path ?? null}
            gitCommandStream={gitCommandStream}
            scrollRef={gitCommandStreamScrollRef}
            onClear={clearGitCommandStream}
          />
        </aside>

        <div
          className={`col-span-12 flex min-h-0 min-w-0 flex-col gap-4 lg:h-full lg:min-h-0 ${
            showExpandedDiff ? "lg:col-span-9" : "lg:col-span-6"
          }`}
        >
          <section className="card flex min-h-0 w-full min-w-0 flex-1 flex-col border-base-300 bg-base-100 shadow-md">
            <div className="card-body flex min-h-0 flex-1 flex-col gap-0 p-0">
              {loading ? (
                <div className="flex min-h-0 flex-1 flex-col justify-start gap-4 px-6 py-6">
                  {cloneProgress ? (
                    <>
                      <div className="mx-auto flex w-full max-w-lg shrink-0 flex-col gap-3">
                        <p className="m-0 text-center text-[0.9375rem] font-medium text-base-content/90">
                          Cloning repository…
                        </p>
                        {cloneProgress.percent != null ? (
                          <progress
                            className="progress h-3 w-full progress-primary"
                            value={cloneProgress.percent}
                            max={100}
                            aria-valuenow={cloneProgress.percent}
                            aria-valuemin={0}
                            aria-valuemax={100}
                          />
                        ) : (
                          <progress
                            className="progress h-3 w-full progress-primary"
                            max={100}
                            aria-busy="true"
                          />
                        )}
                      </div>
                      <div
                        ref={cloneLogScrollRef}
                        className="mx-auto h-[min(14rem,40vh)] min-h-24 w-full max-w-lg shrink-0 overflow-x-hidden overflow-y-auto rounded-lg border border-base-300 bg-base-200/40 px-3 py-2 font-mono text-[11px] leading-snug wrap-anywhere text-base-content/80 [scrollbar-gutter:stable]"
                        aria-live="polite"
                      >
                        {cloneLogLines.map((line, i) => (
                          <div key={i}>{line}</div>
                        ))}
                      </div>
                    </>
                  ) : (
                    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3">
                      <span className="loading loading-md loading-spinner text-primary" />
                      <p className="m-0 text-center text-[0.9375rem] text-base-content/80">
                        Loading repository…
                      </p>
                    </div>
                  )}
                </div>
              ) : loadError ? (
                <div className="p-4">
                  <DismissibleAlert
                    className="alert text-sm alert-error"
                    onDismiss={() => {
                      setLoadError(null);
                    }}
                  >
                    <span>{loadError}</span>
                  </DismissibleAlert>
                </div>
              ) : (
                <>
                  {cloneReadyPath && repo ? (
                    <div className="shrink-0 border-b border-base-300 bg-success/10 px-4 py-3">
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                        <div className="min-w-0 flex-1">
                          <p className="m-0 text-sm font-medium text-base-content">
                            Clone finished
                          </p>
                          <code className="mt-1 block truncate font-mono text-xs text-base-content/80">
                            {cloneReadyPath}
                          </code>
                        </div>
                        <div className="flex shrink-0 flex-wrap gap-2">
                          <button
                            type="button"
                            className="btn btn-sm btn-primary"
                            onClick={() => {
                              openClonedRepository();
                            }}
                          >
                            Open repository
                          </button>
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            onClick={() => {
                              setCloneReadyPath(null);
                            }}
                          >
                            Dismiss
                          </button>
                        </div>
                      </div>
                    </div>
                  ) : null}
                  {repo ? (
                    <>
                      {repo.error ? (
                        <div className="px-4 pt-4 pb-4">
                          <DismissibleAlert
                            role="status"
                            className="alert text-sm alert-warning"
                            onDismiss={() => {
                              setRepo((r) => (r ? { ...r, error: null } : null));
                            }}
                          >
                            <span>{repo.error}</span>
                          </DismissibleAlert>
                          <dl className="m-0 mt-4 flex flex-col gap-2.5">
                            <MetaRow label="Path">{repo.path}</MetaRow>
                          </dl>
                        </div>
                      ) : (
                        <div className="flex min-h-0 flex-1 flex-col">
                          {listsError || operationError ? (
                            <div className="shrink-0 space-y-2 px-3 pt-3">
                              {listsError ? (
                                <DismissibleAlert
                                  className="alert text-sm alert-error"
                                  onDismiss={() => {
                                    setListsError(null);
                                  }}
                                >
                                  <span>{listsError}</span>
                                </DismissibleAlert>
                              ) : null}
                              {operationError ? (
                                <DismissibleAlert
                                  className="alert text-sm alert-error"
                                  onDismiss={() => {
                                    setOperationError(null);
                                  }}
                                >
                                  <span className="wrap-break-word whitespace-pre-wrap">
                                    {operationError}
                                  </span>
                                </DismissibleAlert>
                              ) : null}
                            </div>
                          ) : null}

                          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                            {!listsError && worktreeBrowseTarget ? (
                              <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2 overflow-hidden px-4 pt-3 pb-4">
                                <div className="shrink-0 rounded-xl border border-base-300/80 bg-base-200/35 p-3">
                                  <div className="flex flex-wrap items-start justify-between gap-2">
                                    <button
                                      type="button"
                                      className="btn shrink-0 btn-xs btn-primary"
                                      onClick={() => {
                                        clearWorktreeBrowse();
                                        clearDiffSelection();
                                      }}
                                    >
                                      Back to commits
                                    </button>
                                    <div className="min-w-0 text-right">
                                      <p className="m-0 font-mono text-[0.65rem] text-base-content/60">
                                        {worktreeBrowseTarget.headShort ??
                                          (worktreeBrowseTarget.detached
                                            ? "detached"
                                            : (worktreeBrowseTarget.branch ?? "worktree"))}
                                      </p>
                                      <p className="mt-0.5 mb-0 text-[0.65rem] text-base-content/55">
                                        {worktreeBrowseTarget.changedFileCount} changed file
                                        {worktreeBrowseTarget.changedFileCount === 1 ? "" : "s"}
                                      </p>
                                    </div>
                                  </div>
                                  <div className="mt-2 flex items-center justify-between gap-2">
                                    <div className="min-w-0">
                                      <p className="m-0 text-[0.68rem] text-base-content/55">
                                        {worktreeBrowseTarget.branch
                                          ? `Worktree: ${worktreeBrowseTarget.branch}`
                                          : worktreeBrowseTarget.detached
                                            ? "Worktree: Detached HEAD"
                                            : "Worktree"}
                                      </p>
                                      <code className="mt-1 block font-mono text-[0.65rem] wrap-break-word text-base-content/60">
                                        {worktreeBrowseTarget.path}
                                      </code>
                                    </div>
                                    {!worktreeBrowseTarget.isCurrent ? (
                                      <button
                                        type="button"
                                        className="btn btn-ghost btn-xs"
                                        onClick={() => {
                                          void loadRepo(worktreeBrowseTarget.path);
                                        }}
                                      >
                                        Open worktree
                                      </button>
                                    ) : null}
                                  </div>
                                </div>
                                <div className="flex min-h-0 min-w-0 flex-1 flex-row gap-3 overflow-hidden">
                                  <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
                                    {!selectedDiffPath ||
                                    selectedDiffRepoPath !== worktreeBrowseTarget.path ? (
                                      <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-2 py-10">
                                        <p className="m-0 text-center text-xs text-base-content/55">
                                          Select a file to view its diff
                                        </p>
                                      </div>
                                    ) : (
                                      <div className="flex min-h-0 min-w-0 flex-1 flex-col pt-2">
                                        {diffLoading ? (
                                          <div className="flex flex-1 flex-col items-center justify-center gap-3 py-20">
                                            <span className="loading loading-md loading-spinner text-primary" />
                                            <p className="m-0 text-sm text-base-content/70">
                                              Loading diff...
                                            </p>
                                          </div>
                                        ) : diffError ? (
                                          <DismissibleAlert
                                            className="alert text-sm alert-error"
                                            onDismiss={() => {
                                              setDiffError(null);
                                            }}
                                          >
                                            <span className="wrap-break-word">{diffError}</span>
                                          </DismissibleAlert>
                                        ) : (
                                          <div className="min-h-0 w-full min-w-0 flex-1 overflow-auto rounded border border-base-300/80 bg-base-200/30 p-2">
                                            <div className="m-0 mb-1.5 text-[0.6rem] font-semibold tracking-wide text-base-content/45 uppercase">
                                              Patch
                                            </div>
                                            {diffStagedText !== null ? (
                                              <div className="mb-8 last:mb-0">
                                                <div className="m-0 mb-2 text-xs font-semibold tracking-wide uppercase opacity-70">
                                                  Staged
                                                </div>
                                                <UnifiedDiff
                                                  text={diffStagedText}
                                                  emptyLabel="(no staged diff)"
                                                  binaryImagePreview={
                                                    stagedSelectedDiffImagePreview
                                                  }
                                                  partialAction={stagedSelectedDiffAction}
                                                />
                                              </div>
                                            ) : null}
                                            {diffUnstagedText !== null ? (
                                              <div>
                                                <div className="m-0 mb-2 text-xs font-semibold tracking-wide uppercase opacity-70">
                                                  Unstaged
                                                </div>
                                                <UnifiedDiff
                                                  text={diffUnstagedText}
                                                  emptyLabel="(no unstaged diff)"
                                                  binaryImagePreview={
                                                    unstagedSelectedDiffImagePreview
                                                  }
                                                  partialAction={unstagedSelectedDiffAction}
                                                  secondaryHunkAction={discardSelectedDiffAction}
                                                />
                                              </div>
                                            ) : null}
                                          </div>
                                        )}
                                      </div>
                                    )}
                                  </div>
                                  <div className="flex w-[min(15rem,34vw)] min-w-0 shrink-0 flex-col border-l border-base-300/80 pl-2">
                                    <div className="shrink-0 border-b border-base-300/80 pb-2">
                                      <h2 className="m-0 flex flex-wrap items-baseline gap-x-1.5 gap-y-0 text-[0.65rem] font-semibold tracking-wide text-base-content/50 uppercase">
                                        <span>Files</span>
                                        {!worktreeBrowseLoading ? (
                                          <span className="font-mono text-[0.65rem] font-normal tracking-normal text-base-content/45 normal-case tabular-nums">
                                            ({worktreeBrowseFileEntries.length})
                                          </span>
                                        ) : null}
                                      </h2>
                                    </div>
                                    <div className="flex min-h-0 flex-1 flex-col pt-2">
                                      {worktreeBrowseLoading ? (
                                        <div className="flex flex-col items-center justify-center gap-2 py-8">
                                          <span className="loading loading-md loading-spinner text-primary" />
                                          <p className="m-0 text-xs text-base-content/70">
                                            Loading files...
                                          </p>
                                        </div>
                                      ) : worktreeBrowseError ? (
                                        <DismissibleAlert
                                          className="alert py-2 text-xs alert-error"
                                          onDismiss={() => {
                                            setWorktreeBrowseError(null);
                                          }}
                                        >
                                          <span className="wrap-break-word">
                                            {worktreeBrowseError}
                                          </span>
                                        </DismissibleAlert>
                                      ) : worktreeBrowseFileEntries.length === 0 ? (
                                        <p className="m-0 text-center text-xs text-base-content/60">
                                          No files changed in this worktree
                                        </p>
                                      ) : (
                                        <div
                                          ref={commitBrowseFileListScrollRef}
                                          className="m-0 min-h-0 flex-1 overflow-y-auto py-1 pr-0.5"
                                        >
                                          <div
                                            className="relative w-full"
                                            style={{
                                              height: commitBrowseFileVirtualizer.getTotalSize(),
                                            }}
                                          >
                                            {commitBrowseFileVirtualizer
                                              .getVirtualItems()
                                              .map((virtualRow) => {
                                                const entry =
                                                  worktreeBrowseFileEntries[virtualRow.index];
                                                if (!entry) return null;
                                                const preferredSide = entry.file.unstaged
                                                  ? "unstaged"
                                                  : "staged";
                                                const selected =
                                                  selectedDiffRepoPath ===
                                                    worktreeBrowseTarget.path &&
                                                  selectedDiffPath === entry.file.path;
                                                return (
                                                  <div
                                                    key={virtualRow.key}
                                                    data-index={virtualRow.index}
                                                    ref={commitBrowseFileVirtualizer.measureElement}
                                                    className="absolute top-0 left-0 w-full pb-2"
                                                    style={{
                                                      transform: `translateY(${virtualRow.start}px)`,
                                                    }}
                                                  >
                                                    <button
                                                      type="button"
                                                      className={`flex min-h-10 w-full items-center gap-2 rounded-lg border px-2 py-2 text-left text-[0.8125rem] leading-snug transition-colors ${
                                                        selected
                                                          ? "border-primary/50 bg-primary/10 ring-1 ring-primary/25"
                                                          : "border-base-300/40 bg-base-200/50 hover:border-base-300 hover:bg-base-300/45 active:bg-base-300/55"
                                                      }`}
                                                      onClick={() => {
                                                        void loadDiffForFile(
                                                          entry.file,
                                                          preferredSide,
                                                          {
                                                            repoPath: worktreeBrowseTarget.path,
                                                            clearCommitBrowse: false,
                                                          },
                                                        );
                                                      }}
                                                      onContextMenu={
                                                        browsingCurrentRepoWorktree
                                                          ? (e) => {
                                                              if (!nativeContextMenusAvailable())
                                                                return;
                                                              e.preventDefault();
                                                              e.stopPropagation();
                                                              openFileRowMenu(
                                                                entry.file.path,
                                                                e.clientX,
                                                                e.clientY,
                                                                {
                                                                  source: "worktree",
                                                                  variant: preferredSide,
                                                                },
                                                              );
                                                            }
                                                          : undefined
                                                      }
                                                    >
                                                      <code className="min-w-0 flex-1 font-mono wrap-break-word text-base-content/95">
                                                        {entry.file.path}
                                                      </code>
                                                      <DiffLineStatBadge stat={entry.stats} />
                                                    </button>
                                                  </div>
                                                );
                                              })}
                                          </div>
                                        </div>
                                      )}
                                    </div>
                                  </div>
                                </div>
                              </div>
                            ) : !listsError && selectedDiffPath ? (
                              <StandaloneDiffPane
                                path={selectedDiffPath}
                                side={selectedDiffSide}
                                diffLoading={diffLoading}
                                diffError={diffError}
                                onDismissDiffError={() => {
                                  setDiffError(null);
                                }}
                                onBack={clearDiffSelection}
                                stagedText={diffStagedText}
                                unstagedText={diffUnstagedText}
                                stagedImagePreview={stagedSelectedDiffImagePreview}
                                unstagedImagePreview={unstagedSelectedDiffImagePreview}
                                stagedAction={stagedSelectedDiffAction}
                                unstagedAction={unstagedSelectedDiffAction}
                                discardAction={discardSelectedDiffAction}
                              />
                            ) : !listsError && fileBlamePath ? (
                              <FileBlamePane
                                path={fileBlamePath}
                                loading={fileBlameLoading}
                                error={fileBlameError}
                                text={fileBlameText}
                                onBack={clearFileToolView}
                                onDismissError={() => {
                                  setFileBlameError(null);
                                }}
                              />
                            ) : !listsError && fileHistoryPath ? (
                              <FileHistoryPane
                                path={fileHistoryPath}
                                loading={fileHistoryLoading}
                                error={fileHistoryError}
                                commits={fileHistoryCommits}
                                onBack={clearFileToolView}
                                onDismissError={() => {
                                  setFileHistoryError(null);
                                }}
                                onPickCommit={(hash) => {
                                  void onPickFileHistoryCommit(hash);
                                }}
                              />
                            ) : !listsError && commitBrowseHash ? (
                              <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2 overflow-hidden px-4 pt-3 pb-4">
                                <div className="shrink-0 rounded-xl border border-base-300/80 bg-base-200/35 p-3">
                                  <div className="flex flex-wrap items-start justify-between gap-2">
                                    <button
                                      type="button"
                                      className="btn shrink-0 btn-xs btn-primary"
                                      onClick={clearCommitBrowse}
                                    >
                                      Back to commits
                                    </button>
                                    <div className="min-w-0 text-right">
                                      <p className="m-0 font-mono text-[0.65rem] text-base-content/60">
                                        {commitDetails?.shortHash ??
                                          commitBrowseMeta?.shortHash ??
                                          commitBrowseHash.slice(0, 7)}
                                      </p>
                                      <p className="mt-0.5 mb-0 text-[0.65rem] text-base-content/55">
                                        Signature:{" "}
                                        {commitSignature.loading ? (
                                          <span className="text-base-content/50">checking…</span>
                                        ) : commitSignature.verified === true ? (
                                          <span className="text-success">verified</span>
                                        ) : commitSignature.verified === false ? (
                                          <span className="text-base-content/70">not verified</span>
                                        ) : (
                                          <span className="text-base-content/50">unknown</span>
                                        )}
                                      </p>
                                    </div>
                                  </div>
                                  <div className="mt-2 flex items-center justify-between gap-2">
                                    <p className="m-0 text-[0.68rem] text-base-content/55">
                                      {commitDetails?.subject ??
                                        commitBrowseMeta?.subject ??
                                        commitBrowseHash.slice(0, 7)}
                                    </p>
                                    <button
                                      type="button"
                                      className="btn btn-ghost btn-xs"
                                      aria-expanded={commitDetailsExpanded}
                                      onClick={() => {
                                        setCommitDetailsExpanded((expanded) => !expanded);
                                      }}
                                    >
                                      {commitDetailsExpanded ? "Hide details" : "Show details"}
                                    </button>
                                  </div>
                                  {commitDetailsLoading ? (
                                    <p className="mt-2 mb-0 text-xs text-base-content/60">
                                      Loading commit details…
                                    </p>
                                  ) : commitDetailsError ? (
                                    <DismissibleAlert
                                      className="mt-3 alert py-2 text-xs alert-error"
                                      onDismiss={() => {
                                        setCommitDetailsError(null);
                                      }}
                                    >
                                      <span className="wrap-break-word">{commitDetailsError}</span>
                                    </DismissibleAlert>
                                  ) : commitDetailsExpanded ? (
                                    <>
                                      {commitDescription ? (
                                        <pre className="mt-2 mb-0 overflow-x-auto font-sans text-xs leading-relaxed whitespace-pre-wrap text-base-content/80">
                                          {commitDescription}
                                        </pre>
                                      ) : null}
                                      <div className="mt-3 grid gap-2 text-[0.68rem] leading-snug text-base-content/70 md:grid-cols-2">
                                        <div className="min-w-0">
                                          <div className="font-semibold tracking-wide text-base-content/45 uppercase">
                                            Author
                                          </div>
                                          <div className="mt-0.5 text-base-content/90">
                                            {commitDetails?.author.trim() ||
                                              commitBrowseMeta?.author.trim() ||
                                              "—"}
                                          </div>
                                          <code className="mt-0.5 block font-mono wrap-break-word text-base-content/60">
                                            {commitDetails?.authorEmail.trim() ||
                                              commitBrowseMeta?.authorEmail.trim() ||
                                              "—"}
                                          </code>
                                          <div className="mt-0.5">
                                            {formatDate(
                                              commitDetails?.authorDate ??
                                                commitBrowseMeta?.date ??
                                                null,
                                            ) ?? "—"}
                                          </div>
                                        </div>
                                        <div className="min-w-0">
                                          <div className="font-semibold tracking-wide text-base-content/45 uppercase">
                                            Committer
                                          </div>
                                          <div className="mt-0.5 text-base-content/90">
                                            {commitDetails?.committer.trim() ||
                                              commitDetails?.author.trim() ||
                                              commitBrowseMeta?.author.trim() ||
                                              "—"}
                                          </div>
                                          <code className="mt-0.5 block font-mono wrap-break-word text-base-content/60">
                                            {commitDetails?.committerEmail.trim() ||
                                              commitDetails?.authorEmail.trim() ||
                                              commitBrowseMeta?.authorEmail.trim() ||
                                              "—"}
                                          </code>
                                          <div className="mt-0.5">
                                            {formatDate(
                                              commitDetails?.committerDate ??
                                                commitDetails?.authorDate ??
                                                commitBrowseMeta?.date ??
                                                null,
                                            ) ?? "—"}
                                          </div>
                                        </div>
                                        <div className="min-w-0 md:col-span-2">
                                          <div className="font-semibold tracking-wide text-base-content/45 uppercase">
                                            Metadata
                                          </div>
                                          <div className="mt-1 flex flex-wrap gap-1.5">
                                            <span className="badge badge-ghost font-mono badge-sm">
                                              {commitDetails?.hash ?? commitBrowseHash}
                                            </span>
                                            <span className="badge badge-ghost badge-sm">
                                              {commitDetails?.parentHashes.length ??
                                                commitBrowseMeta?.parentHashes.length ??
                                                0}{" "}
                                              parent
                                              {(commitDetails?.parentHashes.length ??
                                                commitBrowseMeta?.parentHashes.length ??
                                                0) === 1
                                                ? ""
                                                : "s"}
                                            </span>
                                            {commitDetails?.coAuthors.length ? (
                                              <span className="badge badge-ghost badge-sm">
                                                {commitDetails.coAuthors.length} co-author
                                                {commitDetails.coAuthors.length === 1 ? "" : "s"}
                                              </span>
                                            ) : null}
                                          </div>
                                          {commitDetails?.parentHashes.length ? (
                                            <code className="mt-1 block font-mono text-[0.62rem] wrap-break-word text-base-content/55">
                                              Parents: {commitDetails.parentHashes.join(", ")}
                                            </code>
                                          ) : null}
                                          {commitDetails?.coAuthors.length ? (
                                            <div className="mt-2 flex flex-col gap-1">
                                              {commitDetails.coAuthors.map((coAuthor) => (
                                                <div key={`${coAuthor.name}<${coAuthor.email}>`}>
                                                  <span className="text-base-content/85">
                                                    {coAuthor.name || "Unknown co-author"}
                                                  </span>
                                                  {coAuthor.email ? (
                                                    <code className="ml-1 font-mono text-base-content/55">
                                                      {`<${coAuthor.email}>`}
                                                    </code>
                                                  ) : null}
                                                </div>
                                              ))}
                                            </div>
                                          ) : null}
                                        </div>
                                      </div>
                                    </>
                                  ) : null}
                                </div>
                                <div className="flex min-h-0 min-w-0 flex-1 flex-row gap-3 overflow-hidden">
                                  <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
                                    {!commitDiffPath ? (
                                      <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-2 py-10">
                                        <p className="m-0 text-center text-xs text-base-content/55">
                                          Select a file to view its diff
                                        </p>
                                      </div>
                                    ) : (
                                      <div className="flex min-h-0 min-w-0 flex-1 flex-col pt-2">
                                        {commitDiffLoading ? (
                                          <div className="flex flex-1 flex-col items-center justify-center gap-2 py-12">
                                            <span className="loading loading-md loading-spinner text-primary" />
                                            <p className="m-0 text-xs text-base-content/70">
                                              Loading diff…
                                            </p>
                                          </div>
                                        ) : commitDiffError ? (
                                          <DismissibleAlert
                                            className="alert py-2 text-xs alert-error"
                                            onDismiss={() => {
                                              setCommitDiffError(null);
                                            }}
                                          >
                                            <span className="wrap-break-word">
                                              {commitDiffError}
                                            </span>
                                          </DismissibleAlert>
                                        ) : (
                                          <div className="min-h-0 w-full min-w-0 flex-1 overflow-auto rounded border border-base-300/80 bg-base-200/30 p-2">
                                            <div className="m-0 mb-1.5 text-[0.6rem] font-semibold tracking-wide text-base-content/45 uppercase">
                                              Patch
                                            </div>
                                            <UnifiedDiff
                                              text={commitDiffText ?? ""}
                                              emptyLabel="(no diff for this file)"
                                              binaryImagePreview={commitDiffBinaryImagePreview}
                                            />
                                          </div>
                                        )}
                                      </div>
                                    )}
                                  </div>
                                  <div className="flex w-[min(15rem,34vw)] min-w-0 shrink-0 flex-col border-l border-base-300/80 pl-2">
                                    <div className="shrink-0 border-b border-base-300/80 pb-2">
                                      <h2 className="m-0 flex flex-wrap items-baseline gap-x-1.5 gap-y-0 text-[0.65rem] font-semibold tracking-wide text-base-content/50 uppercase">
                                        <span>Files</span>
                                        {!commitBrowseLoading ? (
                                          <span className="font-mono text-[0.65rem] font-normal tracking-normal text-base-content/45 normal-case tabular-nums">
                                            ({commitBrowseFiles.length})
                                          </span>
                                        ) : null}
                                      </h2>
                                    </div>
                                    <div className="flex min-h-0 flex-1 flex-col pt-2">
                                      {commitBrowseLoading ? (
                                        <div className="flex flex-col items-center justify-center gap-2 py-8">
                                          <span className="loading loading-md loading-spinner text-primary" />
                                          <p className="m-0 text-xs text-base-content/70">
                                            Loading files…
                                          </p>
                                        </div>
                                      ) : commitBrowseError ? (
                                        <DismissibleAlert
                                          className="alert py-2 text-xs alert-error"
                                          onDismiss={() => {
                                            setCommitBrowseError(null);
                                          }}
                                        >
                                          <span className="wrap-break-word">
                                            {commitBrowseError}
                                          </span>
                                        </DismissibleAlert>
                                      ) : commitBrowseFiles.length === 0 ? (
                                        <p className="m-0 text-center text-xs text-base-content/60">
                                          No files changed in this commit
                                        </p>
                                      ) : (
                                        <div
                                          ref={commitBrowseFileListScrollRef}
                                          className="m-0 min-h-0 flex-1 overflow-y-auto py-1 pr-0.5"
                                        >
                                          <div
                                            className="relative w-full"
                                            style={{
                                              height: commitBrowseFileVirtualizer.getTotalSize(),
                                            }}
                                          >
                                            {commitBrowseFileVirtualizer
                                              .getVirtualItems()
                                              .map((virtualRow) => {
                                                const entry = commitBrowseFiles[virtualRow.index];
                                                if (!entry) return null;
                                                const selected = commitDiffPath === entry.path;
                                                return (
                                                  <div
                                                    key={virtualRow.key}
                                                    data-index={virtualRow.index}
                                                    ref={commitBrowseFileVirtualizer.measureElement}
                                                    className="absolute top-0 left-0 w-full pb-2"
                                                    style={{
                                                      transform: `translateY(${virtualRow.start}px)`,
                                                    }}
                                                  >
                                                    <button
                                                      type="button"
                                                      className={`flex min-h-10 w-full items-center gap-2 rounded-lg border px-2 py-2 text-left text-[0.8125rem] leading-snug transition-colors ${
                                                        selected
                                                          ? "border-primary/50 bg-primary/10 ring-1 ring-primary/25"
                                                          : "border-base-300/40 bg-base-200/50 hover:border-base-300 hover:bg-base-300/45 active:bg-base-300/55"
                                                      }`}
                                                      onClick={() =>
                                                        void loadCommitFileDiff(
                                                          entry.path,
                                                          commitBrowseHash ?? "",
                                                        )
                                                      }
                                                      onContextMenu={(e) => {
                                                        if (!nativeContextMenusAvailable()) return;
                                                        e.preventDefault();
                                                        e.stopPropagation();
                                                        openFileRowMenu(
                                                          entry.path,
                                                          e.clientX,
                                                          e.clientY,
                                                        );
                                                      }}
                                                    >
                                                      <code className="min-w-0 flex-1 font-mono wrap-break-word text-base-content/95">
                                                        {entry.path}
                                                      </code>
                                                      <DiffLineStatBadge stat={entry.stats} />
                                                    </button>
                                                  </div>
                                                );
                                              })}
                                          </div>
                                        </div>
                                      )}
                                    </div>
                                  </div>
                                </div>
                              </div>
                            ) : (
                              <CommitGraphSection
                                commits={graphDisplayCommits}
                                commitGraphLayout={commitGraphLayout!}
                                localBranches={localBranches}
                                remoteBranches={remoteBranches}
                                tags={tags}
                                graphBranchVisible={graphBranchVisible}
                                currentBranchName={currentBranchName}
                                currentBranchTipHash={currentBranchTipHash}
                                commitBrowseHash={commitBrowseHash}
                                graphFocusHash={graphFocusHash}
                                graphScrollNonce={graphScrollNonce}
                                branchBusy={branchBusy}
                                stashBusy={stashBusy}
                                commitsSectionTitle={commitsSectionTitle}
                                emptyMessage={
                                  commits.length === 0
                                    ? "No commits to show"
                                    : "No commits match the current filters"
                                }
                                graphCommitsHasMore={graphCommitsHasMore}
                                loadingMoreGraphCommits={loadingMoreGraphCommits}
                                loadMoreGraphCommits={handleLoadMoreGraphCommits}
                                onRowCommitSelect={handleGraphRowCommitSelect}
                                openGraphBranchLocalMenu={openGraphBranchLocalMenu}
                                openGraphBranchRemoteMenu={openGraphBranchRemoteMenu}
                                openGraphStashMenu={openGraphStashMenu}
                                openGraphCommitMenu={openGraphCommitMenu}
                                openGraphTagMenu={openGraphTagMenu}
                                pushBusy={pushBusy}
                                graphAuthorFilter={graphAuthorFilter}
                                onGraphAuthorFilterChange={setGraphAuthorFilter}
                                graphDateFrom={graphDateFrom}
                                graphDateTo={graphDateTo}
                                onGraphDateFromChange={setGraphDateFrom}
                                onGraphDateToChange={setGraphDateTo}
                                graphFiltersActive={graphCommitFiltersActive}
                                onClearGraphFilters={clearGraphFilters}
                                onExportGraphCommits={handleExportGraphCommits}
                                exportGraphCommitsDisabled={graphExportCommits.length === 0}
                                wipChangedFileCount={wipChangedFileCount}
                                onWipSelect={handleSelectWipRow}
                              />
                            )}
                          </div>
                        </div>
                      )}
                    </>
                  ) : cloneReadyPath ? (
                    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 px-6 py-10">
                      <p className="m-0 text-center text-[0.9375rem] font-medium text-base-content/90">
                        Repository cloned
                      </p>
                      <code className="max-w-full truncate px-2 text-center font-mono text-sm text-base-content/80">
                        {cloneReadyPath}
                      </code>
                      <div className="flex flex-wrap items-center justify-center gap-2">
                        <button
                          type="button"
                          className="btn btn-primary"
                          onClick={() => {
                            openClonedRepository();
                          }}
                        >
                          Open repository
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost"
                          onClick={() => {
                            setCloneReadyPath(null);
                          }}
                        >
                          Dismiss
                        </button>
                      </div>
                    </div>
                  ) : (
                    <p className="m-0 flex min-h-0 flex-1 items-center justify-center text-center text-[0.9375rem] text-base-content/60">
                      No repository open
                    </p>
                  )}
                </>
              )}
            </div>
          </section>
        </div>

        <aside className="col-span-12 flex min-h-0 min-w-0 flex-col gap-3 lg:col-span-3 lg:h-full lg:min-h-0">
          <div className="card flex min-h-0 min-w-0 flex-1 flex-col border-base-300 bg-base-100 shadow-sm">
            <div className="card-body flex min-h-0 flex-1 flex-col gap-0 p-0">
              <section
                className="flex min-h-0 flex-[1_1_0%] flex-col border-b border-base-300"
                aria-labelledby="sidebar-unstaged-heading"
              >
                <div className="flex shrink-0 items-center justify-between gap-2 border-b border-base-300/80 px-3 py-2">
                  <h2
                    id="sidebar-unstaged-heading"
                    className="m-0 min-w-0 flex-1 text-xs font-semibold tracking-wide uppercase opacity-80"
                  >
                    Unstaged files ({unstagedFiles.length})
                  </h2>
                  {canShowBranches && unstagedPaths.length > 0 ? (
                    <button
                      type="button"
                      className="btn shrink-0 btn-outline btn-xs btn-success"
                      disabled={stageSyncBusy || stageCommitBusy || commitPushBusy}
                      onClick={() => void onStagePaths(unstagedPaths)}
                    >
                      Stage all
                    </button>
                  ) : null}
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto p-2">
                  {!canShowBranches ? (
                    <p className="m-0 py-2 text-center text-xs text-base-content/50">
                      Open a repository to manage changes
                    </p>
                  ) : unstagedFiles.length === 0 ? (
                    <p className="m-0 py-2 text-center text-xs text-base-content/50">
                      {workingTreeFiles.length === 0 ? "No pending changes" : "No unstaged changes"}
                    </p>
                  ) : (
                    <ul className="m-0 flex list-none flex-col gap-1 p-0">
                      {unstagedFiles.map((f) => (
                        <StagePanelFileRow
                          key={f.path}
                          f={f}
                          variant="unstaged"
                          selected={selectedDiffPath === f.path && selectedDiffSide === "unstaged"}
                          busy={stageCommitBusy || commitPushBusy || syncingStagePaths.has(f.path)}
                          onSelect={() => void loadDiffForFile(f, "unstaged")}
                          onStage={() => void onStagePaths([f.path])}
                          onUnstage={() => void onUnstagePaths([f.path])}
                          onFileContextMenu={
                            canShowBranches
                              ? (path, variant, x, y) => {
                                  openFileRowMenu(path, x, y, { source: "worktree", variant });
                                }
                              : undefined
                          }
                        />
                      ))}
                    </ul>
                  )}
                </div>
              </section>

              <section
                className="flex min-h-0 flex-[1_1_0%] flex-col border-b border-base-300"
                aria-labelledby="sidebar-staged-heading"
              >
                <div className="flex shrink-0 items-center justify-between gap-2 border-b border-base-300/80 px-3 py-2">
                  <h2
                    id="sidebar-staged-heading"
                    className="m-0 min-w-0 flex-1 text-xs font-semibold tracking-wide uppercase opacity-80"
                  >
                    Staged files ({stagedFiles.length})
                  </h2>
                  {canShowBranches && stagedPaths.length > 0 ? (
                    <button
                      type="button"
                      className="btn shrink-0 btn-outline btn-xs btn-error"
                      disabled={stageSyncBusy || stageCommitBusy || commitPushBusy}
                      onClick={() => void onUnstagePaths(stagedPaths)}
                    >
                      Unstage all
                    </button>
                  ) : null}
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto p-2">
                  {!canShowBranches ? (
                    <p className="m-0 py-2 text-center text-xs text-base-content/50">
                      Open a repository to manage changes
                    </p>
                  ) : stagedFiles.length === 0 ? (
                    <p className="m-0 py-2 text-center text-xs text-base-content/50">
                      No staged changes
                    </p>
                  ) : (
                    <ul className="m-0 flex list-none flex-col gap-1 p-0">
                      {stagedFiles.map((f) => (
                        <StagePanelFileRow
                          key={f.path}
                          f={f}
                          variant="staged"
                          selected={selectedDiffPath === f.path && selectedDiffSide === "staged"}
                          busy={stageCommitBusy || commitPushBusy || syncingStagePaths.has(f.path)}
                          onSelect={() => void loadDiffForFile(f, "staged")}
                          onStage={() => void onStagePaths([f.path])}
                          onUnstage={() => void onUnstagePaths([f.path])}
                          onFileContextMenu={
                            canShowBranches
                              ? (path, variant, x, y) => {
                                  openFileRowMenu(path, x, y, { source: "worktree", variant });
                                }
                              : undefined
                          }
                        />
                      ))}
                    </ul>
                  )}
                </div>
              </section>

              <CommitComposer
                repoPath={repo?.path ?? null}
                repoDetached={Boolean(repo?.detached)}
                canShowBranches={canShowBranches}
                hasStagedFiles={hasStagedFiles}
                stageSyncBusy={stageSyncBusy}
                stageCommitBusy={stageCommitBusy}
                commitPushBusy={commitPushBusy}
                pushBusy={pushBusy}
                openaiApiKey={openaiApiKey}
                openaiModel={openaiModel}
                onCommit={submitCommit}
                onCommitAndPush={submitCommitAndPush}
                onPushToOrigin={pushCurrentBranchToOrigin}
                onOperationError={setOperationError}
              />
            </div>
          </div>
        </aside>
      </div>
      {openaiSettingsOpen ? (
        <OpenAiSettingsDialog
          isOpen
          apiKey={openaiApiKey}
          model={openaiModel}
          onClose={closeOpenAiSettingsDialog}
          onSaved={({ apiKey, model }) => {
            setOpenaiApiKey(apiKey);
            setOpenaiModel(model);
          }}
          onError={setOperationError}
        />
      ) : null}
    </main>
  );
}
