import {
  memo,
  type MouseEvent,
  type ReactNode,
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { BranchSidebarSectionsState } from "./repoTypes";
import { listen } from "@tauri-apps/api/event";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ask, message, open, save } from "@tauri-apps/plugin-dialog";
import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";
import { formatAuthorDisplay, formatDate, formatRelativeShort } from "./appFormat";
import { collectLocalBranchNamesInSubtree, collectRemoteRefsInSubtree } from "./branchTrie";
import { BranchSidebar, type BranchGraphControls } from "./components/BranchSidebar";
import { CommitComposer } from "./components/CommitComposer";
import { CommitGraphSection } from "./components/CommitGraphSection";
import { ConflictVersionPanel } from "./components/ConflictVersionPanel";
import { GitCommandPanel } from "./components/GitCommandPanel";
import { SettingsPage } from "./components/SettingsPage";
import {
  UnifiedDiff,
  type BinaryImagePreview,
  type HunkAction,
  type PartialDiffAction,
} from "./components/UnifiedDiff";
import {
  clampGraphCommitTitleFontSizePx,
  commitGraphRowHeightPx,
  computeCommitGraphLayout,
  type BranchTip,
  type CommitGraphLayout,
} from "./commitGraphLayout";
import { base64ToObjectUrl, mimeTypeForImagePath, pathLooksLikeRenderableImage } from "./diffImage";
import {
  popupBranchContextMenu,
  popupFileRowContextMenu,
  popupGraphCommitContextMenu,
  popupGraphPushContextMenu,
  popupGraphTagContextMenu,
  popupRemoteFolderContextMenu,
  popupStashContextMenu,
  popupTagSidebarMenu,
  popupWipContextMenu,
  popupWorktreeContextMenu,
} from "./nativeContextMenu";
import type {
  CommitEntry,
  StashEntry,
  TagEntry,
  TagOriginStatus,
  WireCommitEntry,
  WorktreeEntry,
} from "./repoTypes";
import { normalizeCommitEntries } from "./repoTypes";
import { DEFAULT_OPENAI_MODEL } from "./generateCommitMessage";
import { resolveThemePreference } from "./theme";
import {
  buildGraphExportDefaultFilename,
  filterGraphCommits,
  type GraphCommitExportOptions,
  formatCommitsExportTxt,
} from "./graphCommitFilters";
import {
  combineLineStats,
  clampGraphCommitsPageSize,
  type ConflictFileDetails as RepoConflictFileDetails,
  type LineStat,
  type RepoMetadata,
  repoSnapshotFromStartup,
  type RestoreLastRepo,
  type WorkingTreeFile,
} from "./gitTypes";
import {
  ResetMode,
  ResolveConflictChoice,
  useAmendLastCommitMutation,
  useAbortRepoOperationMutation,
  useCheckoutLocalBranchMutation,
  useCherryPickCommitMutation,
  useCommitStagedMutation,
  useContinueRepoOperationMutation,
  useCreateBranchAtCommitMutation,
  useCreateBranchFromRemoteMutation,
  useCreateLocalBranchMutation,
  useCreateTagMutation,
  useDeleteLocalBranchMutation,
  useDeleteRemoteBranchMutation,
  useDeleteRemoteTagMutation,
  useDeleteTagMutation,
  useDropCommitMutation,
  useDiscardPatchMutation,
  useDiscardPathsChangesMutation,
  useForcePushToOriginMutation,
  useMergeBranchMutation,
  usePullLocalBranchMutation,
  usePushTagToOriginMutation,
  usePushToOriginMutation,
  useRebaseCurrentBranchOntoMutation,
  useResolveConflictChoiceMutation,
  useResetCurrentBranchToCommitMutation,
  useRewordCommitMutation,
  useRemoveWorktreeMutation,
  useSetBranchSidebarSectionsMutation,
  useSetGraphBranchVisibilityMutation,
  useSetRemoteUrlMutation,
  useSkipRepoOperationMutation,
  useStageAllMutation,
  useStagePatchMutation,
  useStagePathsMutation,
  useStashDropMutation,
  useStashPopMutation,
  useStashPushMutation,
  useSquashCommitsMutation,
  useUnstagePatchMutation,
  useUnstagePathsMutation,
} from "./repoMutations";
import {
  type RepoListSelection,
  emptyRepoSnapshot,
  getRepoSnapshot,
  loadRepoLists,
  loadRepoSnapshot,
  mergeRepoLists,
  repoQueryKeys,
  setRepoSnapshot,
  updateRepoSnapshot,
  withRepoLists,
} from "./repoQuery";
import { invoke } from "./tauriBridgeDebug";

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
export type { LineStat, RepoMetadata, RestoreLastRepo, WorkingTreeFile } from "./gitTypes";

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

/** Top-level remote folder name for sidebar paths like `origin/feature/foo`. */
function remoteNameFromSidebarPath(remotePath: string): string | null {
  const [remoteName] = remotePath.split("/", 1);
  return remoteName || null;
}

function graphLocalVisible(graphBranchVisible: Record<string, boolean>, name: string): boolean {
  return graphBranchVisible[`local:${name}`] !== false;
}

function graphRemoteVisible(
  graphBranchVisible: Record<string, boolean>,
  name: string,
  defaultVisible: boolean,
): boolean {
  const value = graphBranchVisible[`remote:${name}`];
  return value ?? defaultVisible;
}

/** Close only when mousedown and mouseup both happen on the backdrop (not after text-selection drags). */
function useDialogBackdropClose(onBackdropClose: () => void) {
  const downOnBackdrop = useRef(false);
  const onMouseDown = useCallback((e: MouseEvent<HTMLDialogElement>) => {
    downOnBackdrop.current = e.target === e.currentTarget;
  }, []);
  const onMouseUp = useCallback(
    (e: MouseEvent<HTMLDialogElement>) => {
      if (e.target === e.currentTarget && downOnBackdrop.current) {
        onBackdropClose();
      }
      downOnBackdrop.current = false;
    },
    [onBackdropClose],
  );
  return { onMouseDown, onMouseUp };
}

function useLatest<T>(value: T) {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  }, [value]);
  return ref;
}

interface GraphCommitsPage {
  commits: WireCommitEntry[];
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

/** One file changed in a commit from `list_commit_files`. */
export interface CommitFileEntry {
  path: string;
  stats: LineStat;
  /** Muted directory segment from Rust (`list_commit_files`). */
  pathDisplayDir: string | null;
  pathDisplayBase: string;
  pathDisplayTitle: string | null;
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

function fileBlobPairKey(pair: FileBlobPair): string {
  return `${pair.beforeBase64 ?? ""}\0${pair.afterBase64 ?? ""}`;
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

function buildDefaultSquashCommitMessage(commitsNewestFirst: CommitEntry[]): string {
  const newest = commitsNewestFirst[0];
  if (!newest) return "";
  if (commitsNewestFirst.length === 1) return newest.subject;
  return [
    newest.subject,
    "",
    "Squashed commits:",
    ...[...commitsNewestFirst].reverse().map((commit) => `- ${commit.shortHash} ${commit.subject}`),
  ].join("\n");
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

function composeCommitMessage(title: string, description: string): string {
  const trimmedTitle = title.trim();
  const trimmedDescription = description.trim();
  if (!trimmedTitle) return trimmedDescription;
  if (!trimmedDescription) return trimmedTitle;
  return `${trimmedTitle}\n\n${trimmedDescription}`;
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

function worktreeFileMutationPaths(file: Pick<WorkingTreeFile, "path" | "renameFrom">): string[] {
  const renameFrom = file.renameFrom?.trim();
  return renameFrom && renameFrom !== file.path ? [file.path, renameFrom] : [file.path];
}

function worktreeFilesMutationPaths(
  files: readonly Pick<WorkingTreeFile, "path" | "renameFrom">[],
): string[] {
  const paths = new Set<string>();
  for (const file of files) {
    for (const path of worktreeFileMutationPaths(file)) {
      paths.add(path);
    }
  }
  return [...paths];
}

function worktreeFileBusy(
  syncingStagePaths: ReadonlySet<string>,
  file: Pick<WorkingTreeFile, "path" | "renameFrom">,
): boolean {
  return worktreeFileMutationPaths(file).some((path) => syncingStagePaths.has(path));
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
    file: WorkingTreeFile,
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
              e.preventDefault();
              e.stopPropagation();
              onFileContextMenu(f, variant, e.clientX, e.clientY);
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
              className="btn btn-square px-0 font-mono text-sm leading-none btn-xs btn-primary"
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
              className="btn btn-square px-0 font-mono text-sm leading-none btn-ghost btn-xs"
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

const ConflictPanelFileRow = memo(function ConflictPanelFileRow({
  f,
  selected,
  onSelect,
}: {
  f: WorkingTreeFile;
  selected: boolean;
  onSelect: () => void;
}) {
  const conflict = f.conflict;
  if (!conflict) return null;
  return (
    <li
      role="button"
      tabIndex={0}
      className={`rounded-md border bg-base-200/80 px-2 py-1 transition-colors hover:bg-base-300/50 ${
        selected ? "border-warning ring-1 ring-warning/40" : "border-base-300"
      }`}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
    >
      <div className="flex min-h-7 items-start gap-2">
        <div className="min-w-0 flex-1">
          <code className="block font-mono text-[0.7rem] leading-snug wrap-break-word text-base-content">
            {f.renameFrom ? `${f.renameFrom} → ${f.path}` : f.path}
          </code>
          <div className="mt-1 text-[0.65rem] leading-snug text-warning">{conflict.summary}</div>
        </div>
        <span className="badge shrink-0 badge-outline badge-warning">conflict</span>
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
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-start justify-between gap-2 border-b border-base-300 p-3">
        <div className="min-w-0">
          <h2 className="m-0 font-mono text-sm font-semibold tracking-wide text-base-content opacity-90">
            {path}
          </h2>
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
          <div className="flex flex-1 flex-col items-center justify-center gap-2 py-20">
            <span className="loading loading-md loading-spinner text-primary" />
            <p className="m-0 text-sm text-base-content/70">Loading diff…</p>
          </div>
        ) : diffError ? (
          <DismissibleAlert className="alert text-sm alert-error" onDismiss={onDismissDiffError}>
            <span className="wrap-break-word">{diffError}</span>
          </DismissibleAlert>
        ) : (
          <div className="min-h-0 w-full min-w-0 flex-1 overflow-auto bg-base-200/40">
            {stagedText !== null ? (
              <UnifiedDiff
                text={stagedText}
                emptyLabel="(no staged diff)"
                binaryImagePreview={stagedImagePreview}
                partialAction={stagedAction}
              />
            ) : null}
            {unstagedText !== null ? (
              <UnifiedDiff
                text={unstagedText}
                emptyLabel="(no unstaged diff)"
                binaryImagePreview={unstagedImagePreview}
                partialAction={unstagedAction}
                secondaryHunkAction={discardAction}
              />
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
});

const ConflictResolutionPane = memo(function ConflictResolutionPane({
  path,
  repoOperationLabel,
  loading,
  error,
  details,
  busy,
  oursLabel,
  theirsLabel,
  canChooseOurs,
  canChooseTheirs,
  onChooseOurs,
  onChooseTheirs,
  onChooseBoth,
  onOpenInCursor,
  onBack,
  onDismissError,
}: {
  path: string;
  repoOperationLabel: string | null;
  loading: boolean;
  error: string | null;
  details: RepoConflictFileDetails | null;
  busy: boolean;
  oursLabel: string;
  theirsLabel: string;
  canChooseOurs: boolean;
  canChooseTheirs: boolean;
  onChooseOurs: () => void;
  onChooseTheirs: () => void;
  onChooseBoth: () => void;
  onOpenInCursor: () => void;
  onBack: () => void;
  onDismissError: () => void;
}) {
  const canChooseBoth =
    details !== null &&
    details.worktreeText != null &&
    !details.ours.deleted &&
    !details.theirs.deleted &&
    !details.ours.isBinary &&
    !details.theirs.isBinary;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-start justify-between gap-2 border-b border-base-300 p-3">
        <div className="min-w-0">
          <h2 className="m-0 font-mono text-sm font-semibold tracking-wide text-base-content opacity-90">
            {path}
          </h2>
          <p className="mt-1 mb-0 text-xs text-base-content/65">
            {details?.summary ?? "Conflicted file"}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <button type="button" className="btn btn-ghost btn-sm" onClick={onOpenInCursor}>
            Open in Cursor
          </button>
          <button type="button" className="btn btn-sm btn-primary" onClick={onBack}>
            Back to commits
          </button>
        </div>
      </div>
      <div className="shrink-0 border-b border-base-300/80 bg-base-200/30 p-3">
        <p className="m-0 text-xs leading-relaxed text-base-content/70">
          Choose the result to stage. Garlic will mark the file as resolved with your selection.
          {repoOperationLabel ? ` ${repoOperationLabel}.` : ""}
        </p>
        {canChooseBoth ? (
          <div className="mt-3">
            <button
              type="button"
              className="btn btn-outline btn-sm"
              disabled={busy}
              onClick={onChooseBoth}
            >
              Select both
            </button>
          </div>
        ) : null}
      </div>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {loading ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 py-20">
            <span className="loading loading-md loading-spinner text-primary" />
            <p className="m-0 text-sm text-base-content/70">Loading conflict choices...</p>
          </div>
        ) : error ? (
          <DismissibleAlert className="alert text-sm alert-error" onDismiss={onDismissError}>
            <span className="wrap-break-word">{error}</span>
          </DismissibleAlert>
        ) : details ? (
          <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-auto bg-base-200/40 p-3 xl:grid-cols-2">
            <ConflictVersionPanel
              path={path}
              preview={details.ours}
              ranges={details.conflictRanges.ours}
              actionLabel={canChooseOurs ? oursLabel : undefined}
              actionKind="primary"
              busy={busy}
              onAction={canChooseOurs ? onChooseOurs : undefined}
            />
            <ConflictVersionPanel
              path={path}
              preview={details.theirs}
              ranges={details.conflictRanges.theirs}
              actionLabel={canChooseTheirs ? theirsLabel : undefined}
              actionKind="outline"
              busy={busy}
              onAction={canChooseTheirs ? onChooseTheirs : undefined}
            />
          </div>
        ) : (
          <div className="flex flex-1 items-center justify-center px-4 py-10">
            <p className="m-0 text-sm text-base-content/60">No conflict details loaded.</p>
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
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-start justify-between gap-2 border-b border-base-300 p-3">
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
          <div className="flex flex-1 flex-col items-center justify-center gap-2 py-20">
            <span className="loading loading-md loading-spinner text-primary" />
            <p className="m-0 text-sm text-base-content/70">Loading blame…</p>
          </div>
        ) : error ? (
          <DismissibleAlert className="alert text-sm alert-error" onDismiss={onDismissError}>
            <span className="wrap-break-word">{error}</span>
          </DismissibleAlert>
        ) : (
          <pre className="min-h-0 w-full min-w-0 flex-1 overflow-auto bg-base-200/40 p-3 font-mono text-[0.7rem] leading-snug wrap-break-word whitespace-pre">
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
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-start justify-between gap-2 p-3">
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
          <div className="flex flex-1 flex-col items-center justify-center gap-2 py-20">
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
                  className="flex w-full flex-col gap-0.5 border-y border-base-300/50 bg-base-200/40 px-3 py-2 text-left transition-colors hover:border-base-300 hover:bg-base-300/35"
                  onClick={() => {
                    onPickCommit(commit.hash);
                  }}
                >
                  <span className="font-mono text-[0.65rem] text-base-content/70">
                    {commit.shortHash}
                    {formatAuthorDisplay(commit.author)} ·{" "}
                    {formatRelativeShort(commit.authorTime) ?? formatDate(commit.authorTime) ?? "—"}
                  </span>

                  <span className="text-sm leading-snug text-base-content/95">
                    {commit.subject}
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
  initialGraphBranchVisible,
  highlightActiveBranchRows: initialHighlightActiveBranchRows,
  graphCommitsPageSize: initialGraphCommitsPageSize,
  graphCommitTitleFontSizePx: initialGraphCommitTitleFontSizePx,
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
  /** Per-repo branch visibility overrides for the commit graph. */
  initialGraphBranchVisible: Record<string, boolean>;
  /** Whether active-branch commits get a tinted row background in the graph. */
  highlightActiveBranchRows: boolean;
  /** Commits per `git log` page for the main graph (default 500). */
  graphCommitsPageSize: number;
  /** Commit subject font size in the main graph (px). */
  graphCommitTitleFontSizePx: number;
}) {
  const [themePreference, setThemePreference] = useState(initialThemePreference);
  const [branchSidebarSections, setBranchSidebarSections] = useState<BranchSidebarSectionsState>(
    () => ({ ...initialBranchSidebarSections }),
  );
  const [highlightActiveBranchRows, setHighlightActiveBranchRows] = useState(
    initialHighlightActiveBranchRows,
  );
  const [graphCommitsPageSize, setGraphCommitsPageSize] = useState(() =>
    clampGraphCommitsPageSize(initialGraphCommitsPageSize),
  );
  const [graphCommitTitleFontSizePx, setGraphCommitTitleFontSizePx] = useState(() =>
    clampGraphCommitTitleFontSizePx(initialGraphCommitTitleFontSizePx),
  );
  const queryClient = useQueryClient();
  const [currentRepoPath, setCurrentRepoPath] = useState<string | null>(
    () => startup.metadata?.path ?? null,
  );
  const startupRepoSnapshot = useMemo(() => repoSnapshotFromStartup(startup), [startup]);
  const repoSnapshotQuery = useQuery({
    queryKey: currentRepoPath
      ? repoQueryKeys.snapshot(currentRepoPath)
      : ["repo", "inactive", "snapshot"],
    queryFn: () => loadRepoSnapshot(currentRepoPath!),
    enabled: currentRepoPath !== null,
    initialData:
      currentRepoPath !== null && currentRepoPath === startup.metadata?.path
        ? startupRepoSnapshot
        : undefined,
  });
  const repoSnapshot = repoSnapshotQuery.data ?? emptyRepoSnapshot();
  const repo = repoSnapshot.metadata;
  const localBranches = repoSnapshot.localBranches;
  const remoteBranches = repoSnapshot.remoteBranches;
  const worktrees = repoSnapshot.worktrees;
  const tags = repoSnapshot.tags;
  const stashes = repoSnapshot.stashes;
  const workingTreeFiles = repoSnapshot.workingTreeFiles;
  /** Guards async work: ignore results if `repo.path` changed while awaiting (e.g. refresh vs. open other repo). */
  const activeRepoPathRef = useRef<string | null>(null);
  activeRepoPathRef.current = repo?.path ?? null;
  const graphRefsRef = useRef<string[]>([]);
  /** Latest `loadRepo` target; supersede in-flight loads when opening another path. */
  const pendingLoadRepoRef = useRef<string | null>(null);
  /** Collapse bursts of filesystem watch events into one in-flight refresh plus one queued rerun. */
  const repoMutationRefreshInFlightRef = useRef(false);
  const repoMutationRefreshPendingRef = useRef(false);
  /** Avoid duplicate graph reloads when multiple state updates describe the same graph request. */
  const lastGraphReloadKeyRef = useRef<string | null>(null);
  /** Prevents overlapping updater checks from repeated native menu clicks. */
  const updateCheckInFlightRef = useRef(false);
  /** Bumps when clearing browse or starting a new commit selection — drops stale `selectCommit` completions. */
  const selectCommitSeqRef = useRef(0);
  /** Bumps when working-tree diff selection changes — drops stale diff completions. */
  const diffLoadSeqRef = useRef(0);
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
  const updateCurrentRepoSnapshot = useCallback(
    (updater: Parameters<typeof updateRepoSnapshot>[2]) => {
      if (!currentRepoPath) return;
      updateRepoSnapshot(queryClient, currentRepoPath, updater);
    },
    [currentRepoPath, queryClient],
  );
  const cloneLogLinesRef = useRef<string[]>([]);
  const cloneProgressMaxPercentRef = useRef<number | null>(null);
  const cloneProgressRafRef = useRef<number | null>(null);
  const cloneLogScrollRef = useRef<HTMLDivElement | null>(null);
  const [commits, setCommits] = useState<CommitEntry[]>(() => startup.commits);
  const [graphCommitsHasMore, setGraphCommitsHasMore] = useState(() => startup.graphCommitsHasMore);
  const [loadingMoreGraphCommits, setLoadingMoreGraphCommits] = useState(false);
  /** `local:name` / `remote:name` → visible in commit graph (default true when key missing). */
  const [graphBranchVisible, setGraphBranchVisibleState] = useState<Record<string, boolean>>(
    () => ({ ...initialGraphBranchVisible }),
  );
  const graphBranchVisibleRef = useRef(graphBranchVisible);
  /** Graph list filters (client-side; does not change loaded commit pages). */
  const [graphAuthorFilter, setGraphAuthorFilter] = useState("");
  const [graphDateFrom, setGraphDateFrom] = useState("");
  const [graphDateTo, setGraphDateTo] = useState("");
  const [graphExportIncludeHash, setGraphExportIncludeHash] = useState(true);
  const [graphExportIncludeMergeCommits, setGraphExportIncludeMergeCommits] = useState(true);
  const [graphExportIncludeAuthor, setGraphExportIncludeAuthor] = useState(true);
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
  const [conflictDetails, setConflictDetails] = useState<RepoConflictFileDetails | null>(null);
  const [conflictLoading, setConflictLoading] = useState(false);
  const [conflictError, setConflictError] = useState<string | null>(null);
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
  const selectedDiffPathRef = useRef<string | null>(selectedDiffPath);
  selectedDiffPathRef.current = selectedDiffPath;
  const selectedDiffSideRef = useRef<"unstaged" | "staged" | null>(selectedDiffSide);
  selectedDiffSideRef.current = selectedDiffSide;
  const selectedDiffRepoPathRef = useRef<string | null>(selectedDiffRepoPath);
  selectedDiffRepoPathRef.current = selectedDiffRepoPath;
  const diffStagedTextRef = useRef<string | null>(diffStagedText);
  diffStagedTextRef.current = diffStagedText;
  const diffUnstagedTextRef = useRef<string | null>(diffUnstagedText);
  diffUnstagedTextRef.current = diffUnstagedText;
  const conflictDetailsRef = useRef<RepoConflictFileDetails | null>(conflictDetails);
  conflictDetailsRef.current = conflictDetails;
  const diffImagePreviewKeyRef = useRef<string | null>(null);
  const [stageCommitBusy, setStageCommitBusy] = useState(false);
  const [syncingStagePaths, setSyncingStagePaths] = useState<Set<string>>(() => new Set());
  const [pushBusy, setPushBusy] = useState(false);
  const [commitPushBusy, setCommitPushBusy] = useState(false);
  /** Skip local Git hooks (e.g. pre-push) for push actions. */
  const [graphFocusHash, setGraphFocusHash] = useState<string | null>(null);
  const [graphScrollNonce, setGraphScrollNonce] = useState(0);
  const [selectedGraphCommitHashes, setSelectedGraphCommitHashes] = useState<string[]>([]);
  const [graphSelectionAnchorHash, setGraphSelectionAnchorHash] = useState<string | null>(null);
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
  const [createBranchDialogOpen, setCreateBranchDialogOpen] = useState(false);
  const [amendCommitDialogOpen, setAmendCommitDialogOpen] = useState(false);
  const [amendCommitHash, setAmendCommitHash] = useState<string | null>(null);
  const [amendCommitTitle, setAmendCommitTitle] = useState("");
  const [amendCommitBody, setAmendCommitBody] = useState("");
  const [amendCommitOriginalMessage, setAmendCommitOriginalMessage] = useState("");
  const [amendCommitFieldError, setAmendCommitFieldError] = useState<string | null>(null);
  const [squashDialogOpen, setSquashDialogOpen] = useState(false);
  const [squashCommitMessage, setSquashCommitMessage] = useState("");
  const [squashCommitFieldError, setSquashCommitFieldError] = useState<string | null>(null);
  const commitBrowseFileListScrollRef = useRef<HTMLDivElement>(null);
  const commitBrowseFileVirtualizer = useVirtualizer({
    count: inspectorFileCount,
    getScrollElement: () => commitBrowseFileListScrollRef.current,
    estimateSize: () => COMMIT_BROWSE_FILE_ROW_ESTIMATE_PX,
    overscan: 12,
  });
  const [cloneRepoDialogOpen, setCloneRepoDialogOpen] = useState(false);
  const [cloneRepoUrlDraft, setCloneRepoUrlDraft] = useState("https://github.com/");
  const [editOriginUrlDialogOpen, setEditOriginUrlDialogOpen] = useState(false);
  const [openaiApiKey, setOpenaiApiKey] = useState(() => initialOpenaiApiKey?.trim() ?? "");
  const [openaiModel, setOpenaiModel] = useState(
    () => initialOpenaiModel.trim() || DEFAULT_OPENAI_MODEL,
  );
  const [appSettingsOpen, setAppSettingsOpen] = useState(false);
  const stashPushMutation = useStashPushMutation();
  const setBranchSidebarSectionsMutation = useSetBranchSidebarSectionsMutation();
  const setGraphBranchVisibilityMutation = useSetGraphBranchVisibilityMutation();
  const setRemoteUrlMutation = useSetRemoteUrlMutation();
  const pullLocalBranchMutation = usePullLocalBranchMutation();
  const deleteLocalBranchMutation = useDeleteLocalBranchMutation();
  const deleteRemoteBranchMutation = useDeleteRemoteBranchMutation();
  const rebaseCurrentBranchOntoMutation = useRebaseCurrentBranchOntoMutation();
  const continueRepoOperationMutation = useContinueRepoOperationMutation();
  const abortRepoOperationMutation = useAbortRepoOperationMutation();
  const skipRepoOperationMutation = useSkipRepoOperationMutation();
  const resetCurrentBranchToCommitMutation = useResetCurrentBranchToCommitMutation();
  const mergeBranchMutation = useMergeBranchMutation();
  const removeWorktreeMutation = useRemoveWorktreeMutation();
  const checkoutLocalBranchMutation = useCheckoutLocalBranchMutation();
  const createBranchFromRemoteMutation = useCreateBranchFromRemoteMutation();
  const cherryPickCommitMutation = useCherryPickCommitMutation();
  const dropCommitMutation = useDropCommitMutation();
  const squashCommitsMutation = useSquashCommitsMutation();
  const discardPathsChangesMutation = useDiscardPathsChangesMutation();
  const pushTagToOriginMutation = usePushTagToOriginMutation();
  const createBranchAtCommitMutation = useCreateBranchAtCommitMutation();
  const createLocalBranchMutation = useCreateLocalBranchMutation();
  const createTagMutation = useCreateTagMutation();
  const stashPopMutation = useStashPopMutation();
  const stashDropMutation = useStashDropMutation();
  const deleteTagMutation = useDeleteTagMutation();
  const deleteRemoteTagMutation = useDeleteRemoteTagMutation();
  const stageAllMutation = useStageAllMutation();
  const stagePathsMutation = useStagePathsMutation();
  const unstagePathsMutation = useUnstagePathsMutation();
  const stagePatchMutation = useStagePatchMutation();
  const unstagePatchMutation = useUnstagePatchMutation();
  const resolveConflictChoiceMutation = useResolveConflictChoiceMutation();
  const discardPatchMutation = useDiscardPatchMutation();
  const amendLastCommitMutation = useAmendLastCommitMutation();
  const commitStagedMutation = useCommitStagedMutation();
  const pushToOriginMutation = usePushToOriginMutation();
  const forcePushToOriginMutation = useForcePushToOriginMutation();
  const rewordCommitMutation = useRewordCommitMutation();
  const replaceGraphBranchVisible = useCallback((next: Record<string, boolean>) => {
    graphBranchVisibleRef.current = next;
    setGraphBranchVisibleState(next);
  }, []);
  const persistGraphBranchVisible = useCallback(
    (visibility: Record<string, boolean>) => {
      const path = activeRepoPathRef.current;
      if (!path) return;
      void setGraphBranchVisibilityMutation.mutateAsync({ path, visibility }).catch(() => {});
    },
    [setGraphBranchVisibilityMutation],
  );
  const updateGraphBranchVisible = useCallback(
    (updater: (prev: Record<string, boolean>) => Record<string, boolean>) => {
      const prev = graphBranchVisibleRef.current;
      const next = updater(prev);
      if (next === prev) return;
      replaceGraphBranchVisible(next);
      persistGraphBranchVisible(next);
    },
    [persistGraphBranchVisible, replaceGraphBranchVisible],
  );
  const openAppSettings = useCallback(() => {
    setAppSettingsOpen(true);
  }, []);
  const closeAppSettings = useCallback(() => {
    setAppSettingsOpen(false);
  }, []);
  const [editOriginUrl, setEditOriginUrl] = useState("");
  /** Last time we ran full local+remote branch listing (used to lighten focus refreshes). */
  const lastFullBranchListRefreshAtRef = useRef(0);
  const [newBranchName, setNewBranchName] = useState("");
  const [createBranchFieldError, setCreateBranchFieldError] = useState<string | null>(null);
  /** When set, the create-branch dialog starts the branch at this commit instead of HEAD. */
  const [createBranchStartCommit, setCreateBranchStartCommit] = useState<string | null>(null);
  const [createTagDialogOpen, setCreateTagDialogOpen] = useState(false);
  const [createTagCommit, setCreateTagCommit] = useState<string | null>(null);
  const [newTagName, setNewTagName] = useState("");
  const [createTagMessage, setCreateTagMessage] = useState("");
  const [createTagFieldError, setCreateTagFieldError] = useState<string | null>(null);
  const [createTagSubmitAction, setCreateTagSubmitAction] = useState<
    "create" | "create-and-push" | null
  >(null);
  const refreshLists = useCallback(
    async (
      repoPath: string,
      selection: RepoListSelection = {},
    ): Promise<WorkingTreeFile[] | null> => {
      setListsError(null);
      try {
        const lists = await loadRepoLists(repoPath, selection);
        if (activeRepoPathRef.current !== repoPath) return null;
        updateRepoSnapshot(queryClient, repoPath, (snapshot) =>
          mergeRepoLists(snapshot, lists, selection),
        );
        return selection.workingTreeFiles === false ? null : lists.workingTreeFiles;
      } catch (e) {
        setListsError(invokeErrorMessage(e));
        return null;
      }
    },
    [queryClient],
  );
  const clearDiffImagePreview = useCallback(() => {
    diffImagePreviewKeyRef.current = null;
    setDiffImagePreview(null);
  }, []);
  const clearSelectedDiffContent = useCallback(() => {
    setDiffStagedText(null);
    setDiffUnstagedText(null);
    setDiffError(null);
    setConflictDetails(null);
    setConflictError(null);
    setConflictLoading(false);
    clearDiffImagePreview();
  }, [clearDiffImagePreview]);

  useEffect(() => {
    if (!repo?.path || repo.error) return;
    void invoke("start_repo_watch", { path: repo.path }).catch(() => {});
  }, [repo?.path, repo?.error]);

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
    const valid = new Set<string>();
    for (const b of localBranches) valid.add(`local:${b.name}`);
    for (const r of remoteBranches) valid.add(`remote:${r.name}`);
    updateGraphBranchVisible((prev) => {
      let changed = false;
      const next: Record<string, boolean> = {};
      for (const [key, value] of Object.entries(prev)) {
        if (!valid.has(key)) {
          changed = true;
          continue;
        }
        next[key] = value;
      }
      return changed ? next : prev;
    });
  }, [localBranches, remoteBranches, updateGraphBranchVisible]);

  const remoteGraphDefaultsVisible = true;

  const hiddenGraphRefs = useMemo(() => {
    const refs: string[] = [];
    for (const b of localBranches) {
      if (!graphLocalVisible(graphBranchVisible, b.name)) refs.push(b.name);
    }
    for (const r of remoteBranches) {
      if (!graphRemoteVisible(graphBranchVisible, r.name, remoteGraphDefaultsVisible)) {
        refs.push(r.name);
      }
    }
    return refs;
  }, [localBranches, remoteBranches, graphBranchVisible, remoteGraphDefaultsVisible]);

  const hiddenGraphRefsKey = useMemo(() => hiddenGraphRefs.join("\0"), [hiddenGraphRefs]);
  graphRefsRef.current = hiddenGraphRefs;
  const stashRefsKey = useMemo(
    () => stashes.map((stash) => `${stash.refName}:${stash.commitHash}`).join("\0"),
    [stashes],
  );

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
    const graphReloadKey = [
      pathAtStart,
      repo.headHash ?? "",
      hiddenGraphRefsKey,
      stashRefsKey,
      graphCommitsPageSize,
    ].join("\0");
    if (lastGraphReloadKeyRef.current === graphReloadKey) return;
    lastGraphReloadKeyRef.current = graphReloadKey;
    let cancelled = false;
    void (async () => {
      try {
        const page = await invoke<GraphCommitsPage>("list_graph_commits", {
          path: pathAtStart,
          hiddenRefs: graphRefsRef.current,
          skip: 0,
          pageSize: graphCommitsPageSize,
        });
        if (cancelled || activeRepoPathRef.current !== pathAtStart) return;
        setCommits(normalizeCommitEntries(page.commits));
        setGraphCommitsHasMore(page.hasMore);
        setListsError(null);
      } catch (e) {
        if (cancelled || activeRepoPathRef.current !== pathAtStart) return;
        if (lastGraphReloadKeyRef.current === graphReloadKey) {
          lastGraphReloadKeyRef.current = null;
        }
        setListsError(invokeErrorMessage(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    repo?.path,
    repo?.error,
    repo?.headHash,
    hiddenGraphRefsKey,
    stashRefsKey,
    graphCommitsPageSize,
  ]);

  const handleGraphCommitsPageSizeChange = useCallback((next: number) => {
    const clamped = clampGraphCommitsPageSize(next);
    setGraphCommitsPageSize(clamped);
    void invoke("set_graph_commits_page_size", { pageSize: clamped }).catch(() => {});
  }, []);

  const loadMoreGraphCommits = useCallback(async () => {
    if (!repo?.path || repo.error || !graphCommitsHasMore || loadingMoreGraphCommits) return;
    const pathAtStart = repo.path;
    const skip = commits.length;
    setLoadingMoreGraphCommits(true);
    try {
      const page = await invoke<GraphCommitsPage>("list_graph_commits", {
        path: pathAtStart,
        hiddenRefs: hiddenGraphRefs,
        skip,
        pageSize: graphCommitsPageSize,
      });
      if (activeRepoPathRef.current !== pathAtStart) return;
      setCommits((prev) => [...prev, ...normalizeCommitEntries(page.commits)]);
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
    hiddenGraphRefs,
    commits.length,
    graphCommitsPageSize,
  ]);

  const branchGraphControls: BranchGraphControls = useMemo(
    () => ({
      graphVisibleLocal: (name) => graphLocalVisible(graphBranchVisible, name),
      toggleGraphLocal: (name) => {
        const k = `local:${name}`;
        updateGraphBranchVisible((prev) => {
          const nextVisible = !graphLocalVisible(prev, name);
          const next = { ...prev };
          if (nextVisible) delete next[k];
          else next[k] = false;
          return next;
        });
      },
      graphFolderAnyVisibleLocal: (node) => {
        const names = collectLocalBranchNamesInSubtree(node);
        return names.some((n) => graphLocalVisible(graphBranchVisible, n));
      },
      toggleGraphLocalFolder: (node) => {
        const names = collectLocalBranchNamesInSubtree(node);
        if (names.length === 0) return;
        const anyVisible = names.some((n) => graphLocalVisible(graphBranchVisible, n));
        const nextVal = !anyVisible;
        updateGraphBranchVisible((prev) => {
          const next = { ...prev };
          for (const n of names) {
            const k = `local:${n}`;
            if (nextVal) delete next[k];
            else next[k] = false;
          }
          return next;
        });
      },
      graphVisibleRemote: (name) =>
        graphRemoteVisible(graphBranchVisible, name, remoteGraphDefaultsVisible),
      toggleGraphRemote: (name) => {
        const k = `remote:${name}`;
        updateGraphBranchVisible((prev) => {
          const nextVisible = !graphRemoteVisible(prev, name, remoteGraphDefaultsVisible);
          const next = { ...prev };
          if (nextVisible === remoteGraphDefaultsVisible) delete next[k];
          else next[k] = nextVisible;
          return next;
        });
      },
      graphFolderAnyVisibleRemote: (node) => {
        const refs = collectRemoteRefsInSubtree(node);
        return refs.some((r) =>
          graphRemoteVisible(graphBranchVisible, r, remoteGraphDefaultsVisible),
        );
      },
      toggleGraphRemoteFolder: (node) => {
        const refs = collectRemoteRefsInSubtree(node);
        if (refs.length === 0) return;
        const anyVisible = refs.some((r) =>
          graphRemoteVisible(graphBranchVisible, r, remoteGraphDefaultsVisible),
        );
        const nextVal = !anyVisible;
        updateGraphBranchVisible((prev) => {
          const next = { ...prev };
          for (const r of refs) {
            const k = `remote:${r}`;
            if (nextVal === remoteGraphDefaultsVisible) delete next[k];
            else next[k] = nextVal;
          }
          return next;
        });
      },
    }),
    [graphBranchVisible, remoteGraphDefaultsVisible, updateGraphBranchVisible],
  );

  const graphBranchTips = useMemo((): BranchTip[] => {
    const tips: BranchTip[] = [];
    for (const b of localBranches) {
      if (graphLocalVisible(graphBranchVisible, b.name)) {
        tips.push({ name: b.name, tipHash: b.tipHash });
      }
    }
    for (const r of remoteBranches) {
      if (graphRemoteVisible(graphBranchVisible, r.name, remoteGraphDefaultsVisible)) {
        tips.push({ name: r.name, tipHash: r.tipHash });
      }
    }
    tips.sort((a, b) => a.name.localeCompare(b.name));
    return tips;
  }, [localBranches, remoteBranches, graphBranchVisible, remoteGraphDefaultsVisible]);

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

  /** Lets the UI stay responsive while layout runs on large graphs (React concurrent feature). */
  const deferredGraphDisplayCommits = useDeferredValue(graphDisplayCommits);
  /** While a deferred update is in flight, `useDeferredValue` keeps the previous array; when caught up it returns the same reference as `graphDisplayCommits` (not a deep compare). O(1); avoids scanning thousands of hashes. */
  const graphLayoutDeferredPending = deferredGraphDisplayCommits !== graphDisplayCommits;

  const graphCommitFiltersActive =
    graphAuthorFilter.trim().length > 0 ||
    graphDateFrom.trim().length > 0 ||
    graphDateTo.trim().length > 0;

  const selectedGraphCommitHashSet = useMemo(
    () => new Set(selectedGraphCommitHashes),
    [selectedGraphCommitHashes],
  );
  const selectedGraphCommitEntries = useMemo(
    () =>
      deferredGraphDisplayCommits.filter((commit) => selectedGraphCommitHashSet.has(commit.hash)),
    [deferredGraphDisplayCommits, selectedGraphCommitHashSet],
  );
  const graphDisplayIndexByHash = useMemo(
    () =>
      new Map(deferredGraphDisplayCommits.map((commit, index) => [commit.hash, index] as const)),
    [deferredGraphDisplayCommits],
  );
  const graphHeadFirstParentOrder = useMemo(() => {
    const ordered: string[] = [];
    if (!repo?.headHash) return ordered;
    const byHash = new Map(commits.map((commit) => [commit.hash, commit] as const));
    let next: string | undefined = repo.headHash;
    while (next) {
      ordered.push(next);
      const commit = byHash.get(next);
      if (!commit) break;
      next = commit.parentHashes[0];
    }
    return ordered;
  }, [commits, repo?.headHash]);
  const graphHeadFirstParentIndexByHash = useMemo(
    () => new Map(graphHeadFirstParentOrder.map((hash, index) => [hash, index] as const)),
    [graphHeadFirstParentOrder],
  );
  const graphHeadFirstParentHashes = useMemo(() => {
    const hashes = new Set<string>();
    for (const hash of graphHeadFirstParentOrder) {
      hashes.add(hash);
    }
    return hashes;
  }, [graphHeadFirstParentOrder]);

  const selectedGraphSquashState = useMemo(() => {
    const empty = {
      canSquash: false,
      reason:
        selectedGraphCommitHashes.length === 0 ? null : "Select at least two commits to squash.",
      orderedEntries: [] as CommitEntry[],
      defaultMessage: "",
    };
    if (selectedGraphCommitHashes.length === 0) return empty;
    if (repo?.detached) {
      return {
        ...empty,
        reason: "Squashing commits requires the current branch to be checked out.",
      };
    }
    const byHash = new Map(commits.map((commit) => [commit.hash, commit] as const));
    const ordered: { index: number; commit: CommitEntry }[] = [];
    for (const hash of selectedGraphCommitHashes) {
      const commit = byHash.get(hash);
      if (!commit) {
        return {
          ...empty,
          reason: "Some selected commits are no longer loaded in the graph.",
        };
      }
      if (commit.stashRef?.trim()) {
        return {
          ...empty,
          reason: "Stash entries cannot be squashed.",
        };
      }
      if (commit.parentHashes.length === 0) {
        return {
          ...empty,
          reason: "Squashing the root commit is not supported yet.",
        };
      }
      if (commit.parentHashes.length > 1) {
        return {
          ...empty,
          reason: "Merge commits cannot be squashed yet.",
        };
      }
      const index = graphHeadFirstParentIndexByHash.get(hash);
      if (index === undefined) {
        return {
          ...empty,
          reason: "Only commits on the current branch's primary history can be squashed.",
        };
      }
      ordered.push({ index, commit });
    }
    ordered.sort((a, b) => a.index - b.index);
    for (let i = 1; i < ordered.length; i += 1) {
      if (ordered[i]?.index !== ordered[i - 1]?.index + 1) {
        return {
          ...empty,
          orderedEntries: ordered.map((entry) => entry.commit),
          reason: "Selected commits must be consecutive on the current branch's primary history.",
        };
      }
    }
    if (ordered.length < 2) {
      return {
        ...empty,
        orderedEntries: ordered.map((entry) => entry.commit),
      };
    }
    const orderedEntries = ordered.map((entry) => entry.commit);
    return {
      canSquash: true,
      reason: null,
      orderedEntries,
      defaultMessage: buildDefaultSquashCommitMessage(orderedEntries),
    };
  }, [commits, graphHeadFirstParentIndexByHash, repo?.detached, selectedGraphCommitHashes]);

  const graphExportListCommits = useMemo(
    () =>
      graphExportIncludeMergeCommits
        ? graphDisplayCommits
        : graphDisplayCommits.filter((commit) => commit.parentHashes.length < 2),
    [graphDisplayCommits, graphExportIncludeMergeCommits],
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
    const visibleHashes = new Set(graphDisplayCommits.map((commit) => commit.hash));
    setSelectedGraphCommitHashes((prev) => {
      const next = prev.filter((hash) => visibleHashes.has(hash));
      return next.length === prev.length ? prev : next;
    });
    setGraphSelectionAnchorHash((prev) => (prev && visibleHashes.has(prev) ? prev : null));
  }, [graphDisplayCommits]);

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
    if (graphExportListCommits.length === 0) return;
    setOperationError(null);
    try {
      const repoExportLabel = repo.name.trim() || repo.path;
      const exportOptions: GraphCommitExportOptions = {
        includeHash: graphExportIncludeHash,
        includeAuthor: graphExportIncludeAuthor,
        includeMergeCommits: graphExportIncludeMergeCommits,
      };
      const path = await save({
        defaultPath: buildGraphExportDefaultFilename(
          repoExportLabel,
          graphAuthorFilter,
          graphDateFrom,
          graphDateTo,
        ),
        filters: [{ name: "Text", extensions: ["txt"] }],
      });
      if (path == null) return;
      const checkoutExportLabel = repo.detached
        ? repo.headShort
          ? `Detached (${repo.headShort})`
          : "Detached HEAD"
        : (repo.branch ?? "—");
      const text = formatCommitsExportTxt(
        graphExportListCommits,
        repoExportLabel,
        checkoutExportLabel,
        graphAuthorFilter,
        graphDateFrom,
        graphDateTo,
        exportOptions,
      );
      await invoke("write_export_text_file", { path, contents: text });
    } catch (e) {
      setOperationError(invokeErrorMessage(e));
    }
  }, [
    repo,
    graphExportListCommits,
    graphAuthorFilter,
    graphDateFrom,
    graphDateTo,
    graphExportIncludeHash,
    graphExportIncludeAuthor,
    graphExportIncludeMergeCommits,
  ]);

  const loadConflictForFile = useCallback(
    async (
      f: WorkingTreeFile,
      options?: { repoPath?: string; clearCommitBrowse?: boolean; preserveExisting?: boolean },
    ) => {
      const pathAtStart = options?.repoPath ?? repo?.path ?? null;
      const guardActiveRepo = options?.repoPath == null;
      if (!pathAtStart || !f.conflict) return;
      const preserveExisting = Boolean(
        options?.preserveExisting &&
        selectedDiffRepoPathRef.current === pathAtStart &&
        selectedDiffPathRef.current === f.path &&
        selectedDiffSideRef.current === null &&
        conflictDetailsRef.current !== null,
      );
      const seq = ++diffLoadSeqRef.current;
      const isCurrentDiffRequest = () =>
        seq === diffLoadSeqRef.current &&
        (!guardActiveRepo || activeRepoPathRef.current === pathAtStart);
      if (options?.clearCommitBrowse ?? true) {
        clearCommitBrowse();
      }
      setSelectedDiffPath(f.path);
      setSelectedDiffSide(null);
      setSelectedDiffRepoPath(pathAtStart);
      setDiffError(null);
      setConflictError(null);
      if (!preserveExisting) {
        clearSelectedDiffContent();
        setDiffLoading(false);
        setConflictLoading(true);
      }
      try {
        const details = await invoke<RepoConflictFileDetails>("get_conflict_file_details", {
          path: pathAtStart,
          filePath: f.path,
        });
        if (!isCurrentDiffRequest()) return;
        setConflictDetails(details);
      } catch (e) {
        if (isCurrentDiffRequest()) {
          setConflictError(invokeErrorMessage(e));
        }
      } finally {
        if (isCurrentDiffRequest()) {
          setConflictLoading(false);
        }
      }
    },
    [repo?.path, clearCommitBrowse, clearSelectedDiffContent],
  );

  const loadDiffForFile = useCallback(
    async (
      f: WorkingTreeFile,
      side: "unstaged" | "staged",
      options?: { repoPath?: string; clearCommitBrowse?: boolean; preserveExisting?: boolean },
    ) => {
      const pathAtStart = options?.repoPath ?? repo?.path ?? null;
      const guardActiveRepo = options?.repoPath == null;
      if (!pathAtStart) return;
      if (f.conflict) {
        await loadConflictForFile(f, options);
        return;
      }
      if (side === "unstaged" && !f.unstaged) return;
      if (side === "staged" && !f.staged) return;
      const preserveExisting = Boolean(
        options?.preserveExisting &&
        selectedDiffRepoPathRef.current === pathAtStart &&
        selectedDiffPathRef.current === f.path &&
        selectedDiffSideRef.current === side &&
        (side === "unstaged"
          ? diffUnstagedTextRef.current !== null
          : diffStagedTextRef.current !== null),
      );
      const seq = ++diffLoadSeqRef.current;
      const isCurrentDiffRequest = () =>
        seq === diffLoadSeqRef.current &&
        (!guardActiveRepo || activeRepoPathRef.current === pathAtStart);
      if (options?.clearCommitBrowse ?? true) {
        clearCommitBrowse();
      }
      setSelectedDiffPath(f.path);
      setSelectedDiffSide(side);
      setSelectedDiffRepoPath(pathAtStart);
      setDiffError(null);
      if (!preserveExisting) {
        setDiffLoading(true);
        clearSelectedDiffContent();
      }
      try {
        if (side === "unstaged") {
          const unstaged = await invoke<string>("get_unstaged_diff", {
            path: pathAtStart,
            filePath: f.path,
            renameFrom: f.renameFrom ?? null,
          });
          if (!isCurrentDiffRequest()) return;
          setDiffUnstagedText(unstaged);
          if (pathLooksLikeRenderableImage(f.path)) {
            try {
              const pair = await invoke<FileBlobPair>("get_unstaged_file_blob_pair", {
                path: pathAtStart,
                filePath: f.path,
                renameFrom: f.renameFrom ?? null,
              });
              if (!isCurrentDiffRequest()) return;
              const previewKey = fileBlobPairKey(pair);
              if (diffImagePreviewKeyRef.current !== previewKey) {
                diffImagePreviewKeyRef.current = previewKey;
                setDiffImagePreview(blobPairToPreviewUrls(pair, f.path));
              }
            } catch {
              if (isCurrentDiffRequest()) {
                clearDiffImagePreview();
              }
            }
          }
        } else {
          const staged = await invoke<string>("get_staged_diff", {
            path: pathAtStart,
            filePath: f.path,
            renameFrom: f.renameFrom ?? null,
          });
          if (!isCurrentDiffRequest()) return;
          setDiffStagedText(staged);
          if (pathLooksLikeRenderableImage(f.path)) {
            try {
              const pair = await invoke<FileBlobPair>("get_staged_file_blob_pair", {
                path: pathAtStart,
                filePath: f.path,
                renameFrom: f.renameFrom ?? null,
              });
              if (!isCurrentDiffRequest()) return;
              const previewKey = fileBlobPairKey(pair);
              if (diffImagePreviewKeyRef.current !== previewKey) {
                diffImagePreviewKeyRef.current = previewKey;
                setDiffImagePreview(blobPairToPreviewUrls(pair, f.path));
              }
            } catch {
              if (isCurrentDiffRequest()) {
                clearDiffImagePreview();
              }
            }
          }
        }
      } catch (e) {
        if (isCurrentDiffRequest()) {
          setDiffError(invokeErrorMessage(e));
        }
      } finally {
        if (isCurrentDiffRequest()) {
          setDiffLoading(false);
        }
      }
    },
    [
      repo?.path,
      clearCommitBrowse,
      clearDiffImagePreview,
      clearSelectedDiffContent,
      loadConflictForFile,
    ],
  );

  const openWorktreeBrowse = useCallback(
    async (worktree: WorktreeEntry) => {
      clearCommitBrowse();
      clearFileToolView();
      setGraphFocusHash(null);
      diffLoadSeqRef.current += 1;
      setSelectedDiffPath(null);
      setSelectedDiffSide(null);
      setSelectedDiffRepoPath(null);
      clearSelectedDiffContent();
      setDiffLoading(false);
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
        const first =
          files.find((f) => f.conflict) ??
          files.find((f) => f.unstaged) ??
          files.find((f) => f.staged) ??
          null;
        if (first) {
          if (first.conflict) {
            void loadConflictForFile(first, {
              repoPath: worktree.path,
              clearCommitBrowse: false,
            });
          } else {
            void loadDiffForFile(first, first.unstaged ? "unstaged" : "staged", {
              repoPath: worktree.path,
              clearCommitBrowse: false,
            });
          }
        }
      } catch (e) {
        setWorktreeBrowseFiles([]);
        setWorktreeBrowseError(invokeErrorMessage(e));
      } finally {
        setWorktreeBrowseLoading(false);
      }
    },
    [
      clearCommitBrowse,
      clearFileToolView,
      loadConflictForFile,
      loadDiffForFile,
      clearSelectedDiffContent,
      repo?.path,
      workingTreeFiles,
    ],
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
      diffLoadSeqRef.current += 1;
      setSelectedDiffPath(null);
      setSelectedDiffSide(null);
      setSelectedDiffRepoPath(null);
      clearSelectedDiffContent();
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
      setCommitSignature({ loading: false, verified: null });

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
    },
    [repo, clearFileToolView, loadCommitFileDiff, clearSelectedDiffContent, clearWorktreeBrowse],
  );

  const clearDiffSelection = useCallback(() => {
    diffLoadSeqRef.current += 1;
    setSelectedDiffPath(null);
    setSelectedDiffSide(null);
    setSelectedDiffRepoPath(null);
    clearSelectedDiffContent();
    setDiffLoading(false);
    setConflictLoading(false);
    clearFileToolView();
  }, [clearFileToolView, clearSelectedDiffContent]);

  const previousRepoContextRef = useRef<{
    path: string | null;
    branch: string | null;
    detached: boolean;
  }>({
    path: repo?.path ?? null,
    branch: repo?.branch ?? null,
    detached: repo?.detached ?? false,
  });

  useEffect(() => {
    const previous = previousRepoContextRef.current;
    if (
      repo?.path &&
      previous.path === repo.path &&
      (previous.branch !== repo.branch || previous.detached !== repo.detached)
    ) {
      clearCommitBrowse();
    }

    previousRepoContextRef.current = {
      path: repo?.path ?? null,
      branch: repo?.branch ?? null,
      detached: repo?.detached ?? false,
    };
  }, [repo?.branch, repo?.detached, repo?.path, clearCommitBrowse]);

  useEffect(() => {
    if (!repo?.path || selectedDiffRepoPath !== repo.path || !selectedDiffPath) return;

    const next = workingTreeFiles.find((file) => file.path === selectedDiffPath);
    if (!next || (!next.staged && !next.unstaged && !next.conflict)) {
      diffLoadSeqRef.current += 1;
      setSelectedDiffPath(null);
      setSelectedDiffSide(null);
      setSelectedDiffRepoPath(null);
      clearSelectedDiffContent();
      setDiffLoading(false);
      setConflictLoading(false);
      return;
    }

    if (next.conflict) {
      if (conflictDetails === null) {
        void loadConflictForFile(next, { clearCommitBrowse: false });
      }
      return;
    }

    const preferredSide = selectedDiffSide ?? (next.unstaged ? "unstaged" : "staged");
    if (preferredSide === "unstaged" && next.unstaged) {
      if (diffUnstagedText === null) {
        void loadDiffForFile(next, "unstaged", { clearCommitBrowse: false });
      }
      return;
    }
    if (preferredSide === "staged" && next.staged) {
      if (diffStagedText === null) {
        void loadDiffForFile(next, "staged", { clearCommitBrowse: false });
      }
      return;
    }
    if (next.unstaged) {
      void loadDiffForFile(next, "unstaged", { clearCommitBrowse: false });
      return;
    }
    if (next.staged) {
      void loadDiffForFile(next, "staged", { clearCommitBrowse: false });
    }
  }, [
    clearSelectedDiffContent,
    diffStagedText,
    diffUnstagedText,
    conflictDetails,
    repo?.path,
    workingTreeFiles,
    selectedDiffPath,
    selectedDiffSide,
    selectedDiffRepoPath,
    loadConflictForFile,
    loadDiffForFile,
  ]);

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
      diffLoadSeqRef.current += 1;
      setSelectedDiffPath(null);
      setSelectedDiffSide(null);
      setSelectedDiffRepoPath(null);
      clearSelectedDiffContent();
      setDiffLoading(false);
      try {
        const [snapshot, savedGraphBranchVisible] = await Promise.all([
          loadRepoSnapshot(target),
          invoke<Record<string, boolean>>("get_graph_branch_visibility", { path: target }).catch(
            () => ({}),
          ),
        ]);
        if (pendingLoadRepoRef.current !== target) return;
        setRepoSnapshot(queryClient, target, snapshot);
        setCurrentRepoPath(target);
        replaceGraphBranchVisible(savedGraphBranchVisible);
        if (!snapshot.metadata?.error) {
          await invoke("set_last_repo_path", { path: target });
          if (pendingLoadRepoRef.current !== target) return;
          lastFullBranchListRefreshAtRef.current = Date.now();
        } else {
          setCommits([]);
          setGraphCommitsHasMore(false);
        }
      } catch (e) {
        if (pendingLoadRepoRef.current !== target) return;
        setCurrentRepoPath(null);
        replaceGraphBranchVisible({});
        setCommits([]);
        setGraphCommitsHasMore(false);
        setLoadError(invokeErrorMessage(e));
        void invoke("reset_main_window_title").catch(() => {});
      } finally {
        if (pendingLoadRepoRef.current === target) {
          setLoading(false);
        }
      }
    },
    [
      clearCommitBrowse,
      clearSelectedDiffContent,
      clearWorktreeBrowse,
      queryClient,
      replaceGraphBranchVisible,
    ],
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

  const openCloneRepoDialog = useCallback(() => {
    setCloneRepoUrlDraft("https://github.com/");
    setOperationError(null);
    setCloneRepoDialogOpen(true);
  }, []);

  const closeCloneRepoDialog = useCallback(() => {
    setCloneRepoDialogOpen(false);
    setCloneRepoUrlDraft("https://github.com/");
  }, []);

  const submitCloneRepository = useCallback(async () => {
    const trimmed = cloneRepoUrlDraft.trim();
    if (!trimmed) return;
    closeCloneRepoDialog();
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
  }, [cloneRepoUrlDraft, closeCloneRepoDialog, handleCloneCompletePayload]);

  const closeCreateTagDialog = useCallback(() => {
    setCreateTagDialogOpen(false);
    setNewTagName("");
    setCreateTagMessage("");
    setCreateTagFieldError(null);
    setCreateTagSubmitAction(null);
    setCreateTagCommit(null);
  }, []);

  const closeAmendCommitDialog = useCallback(() => {
    setAmendCommitDialogOpen(false);
    setAmendCommitHash(null);
    setAmendCommitTitle("");
    setAmendCommitBody("");
    setAmendCommitOriginalMessage("");
    setAmendCommitFieldError(null);
  }, []);

  const clearGraphCommitSelection = useCallback(() => {
    setSelectedGraphCommitHashes([]);
    setGraphSelectionAnchorHash(null);
  }, []);

  const closeSquashDialog = useCallback(() => {
    setSquashDialogOpen(false);
    setSquashCommitMessage("");
    setSquashCommitFieldError(null);
  }, []);

  const openSquashDialog = useCallback(() => {
    if (!selectedGraphSquashState.canSquash) return;
    setOperationError(null);
    setSquashCommitMessage(selectedGraphSquashState.defaultMessage);
    setSquashCommitFieldError(null);
    setSquashDialogOpen(true);
  }, [selectedGraphSquashState]);

  useEffect(() => {
    if (!squashDialogOpen) return;
    if (selectedGraphSquashState.canSquash) return;
    closeSquashDialog();
  }, [closeSquashDialog, selectedGraphSquashState.canSquash, squashDialogOpen]);

  const refreshAfterMutation = useCallback(
    async (options?: { fromFocus?: boolean; fromWatcher?: boolean }) => {
      const fromFocus = options?.fromFocus ?? false;
      const fromWatcher = options?.fromWatcher ?? false;
      if (!repo?.path || repo.error) return;
      const pathAtStart = repo.path;
      const prevBranch = repo.branch;
      const prevDetached = repo.detached;
      const prevHeadHash = repo.headHash ?? null;
      const prevAhead = repo.ahead ?? null;
      const prevBehind = repo.behind ?? null;
      try {
        const meta = await invoke<RepoMetadata>("get_repo_metadata", {
          path: pathAtStart,
        });
        if (activeRepoPathRef.current !== pathAtStart) return;
        const branchContextChanged = meta.branch !== prevBranch || meta.detached !== prevDetached;
        const headChanged = (meta.headHash ?? null) !== prevHeadHash;
        const upstreamCountsChanged =
          (meta.ahead ?? null) !== prevAhead || (meta.behind ?? null) !== prevBehind;
        updateRepoSnapshot(queryClient, pathAtStart, (snapshot) => ({
          ...snapshot,
          metadata: meta,
        }));
        if (!meta.error) {
          if (branchContextChanged) {
            clearCommitBrowse();
          }

          let files: WorkingTreeFile[] | null = null;

          if (fromWatcher && !branchContextChanged && !headChanged && !upstreamCountsChanged) {
            try {
              const worktree = await invoke<WorkingTreeFile[]>("list_working_tree_files", {
                path: pathAtStart,
              });
              if (activeRepoPathRef.current !== pathAtStart) return;
              updateRepoSnapshot(queryClient, pathAtStart, (snapshot) => ({
                ...snapshot,
                workingTreeFiles: worktree,
              }));
              setListsError(null);
              files = worktree;
            } catch (e) {
              if (activeRepoPathRef.current === pathAtStart) {
                setListsError(invokeErrorMessage(e));
              }
              files = null;
            }
          } else if (!fromFocus) {
            lastFullBranchListRefreshAtRef.current = Date.now();
            files = await refreshLists(pathAtStart, {
              localBranches: true,
              remoteBranches: true,
              workingTreeFiles: true,
              worktrees: false,
              tags: false,
              stashes: false,
            });
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
                const lists = await loadRepoLists(pathAtStart);
                if (activeRepoPathRef.current !== pathAtStart) return;
                updateRepoSnapshot(queryClient, pathAtStart, (snapshot) =>
                  withRepoLists(snapshot, lists),
                );
                setListsError(null);
                files = lists.workingTreeFiles;
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
            if (next && (next.staged || next.unstaged || next.conflict)) {
              if (next.conflict) {
                void loadConflictForFile(next, {
                  clearCommitBrowse: false,
                  preserveExisting: true,
                });
              } else {
                const preferredSide = selectedDiffSide ?? (next.unstaged ? "unstaged" : "staged");
                if (preferredSide === "unstaged" && next.unstaged) {
                  void loadDiffForFile(next, "unstaged", {
                    clearCommitBrowse: false,
                    preserveExisting: true,
                  });
                } else if (preferredSide === "staged" && next.staged) {
                  void loadDiffForFile(next, "staged", {
                    clearCommitBrowse: false,
                    preserveExisting: true,
                  });
                } else if (next.unstaged) {
                  void loadDiffForFile(next, "unstaged", { clearCommitBrowse: false });
                } else if (next.staged) {
                  void loadDiffForFile(next, "staged", { clearCommitBrowse: false });
                } else {
                  diffLoadSeqRef.current += 1;
                  setSelectedDiffPath(null);
                  setSelectedDiffSide(null);
                  setSelectedDiffRepoPath(null);
                  clearSelectedDiffContent();
                  setDiffLoading(false);
                }
              }
            } else {
              diffLoadSeqRef.current += 1;
              setSelectedDiffPath(null);
              setSelectedDiffSide(null);
              setSelectedDiffRepoPath(null);
              clearSelectedDiffContent();
              setDiffLoading(false);
              setConflictLoading(false);
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
      loadConflictForFile,
      loadDiffForFile,
      clearSelectedDiffContent,
      clearCommitBrowse,
      queryClient,
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
    setCreateBranchDialogOpen(true);
  }, []);

  const openCreateBranchDialogAtCommit = useCallback((hash: string) => {
    setCreateBranchStartCommit(hash);
    setNewBranchName("");
    setCreateBranchFieldError(null);
    setOperationError(null);
    setCreateBranchDialogOpen(true);
  }, []);

  const closeCreateBranchDialog = useCallback(() => {
    setCreateBranchDialogOpen(false);
    setNewBranchName("");
    setCreateBranchFieldError(null);
    setCreateBranchStartCommit(null);
  }, []);

  const openAmendCommitDialog = useCallback(
    async (hash: string) => {
      if (!repo?.path || repo.error) return;
      const pathAtStart = repo.path;
      setOperationError(null);
      try {
        const details = await invoke<CommitDetails>("get_commit_details", {
          path: pathAtStart,
          commitHash: hash,
        });
        if (activeRepoPathRef.current !== pathAtStart) return;
        setAmendCommitHash(hash);
        setAmendCommitTitle(details.subject);
        setAmendCommitBody(details.body);
        setAmendCommitOriginalMessage(composeCommitMessage(details.subject, details.body));
        setAmendCommitFieldError(null);
        setAmendCommitDialogOpen(true);
      } catch (e) {
        if (activeRepoPathRef.current !== pathAtStart) return;
        setOperationError(invokeErrorMessage(e));
      }
    },
    [repo],
  );

  const onStashPush = useCallback(async () => {
    if (!repo?.path || repo.error) return;
    setStashBusy("push");
    setOperationError(null);
    try {
      await stashPushMutation.mutateAsync({ path: repo.path, message: null });
    } catch (e) {
      setOperationError(invokeErrorMessage(e));
    } finally {
      setStashBusy(null);
    }
  }, [repo, stashPushMutation]);

  const persistBranchSidebarSections = useCallback(
    (next: BranchSidebarSectionsState) => {
      setBranchSidebarSections(next);
      void setBranchSidebarSectionsMutation.mutateAsync({ sections: next }).catch((e: unknown) => {
        console.error("set_branch_sidebar_sections failed", e);
      });
    },
    [setBranchSidebarSectionsMutation],
  );

  const openEditOriginUrlDialog = useCallback(async () => {
    if (!repo?.path || repo.error) return;
    setOperationError(null);
    try {
      const url = await invoke<string>("get_remote_url", {
        path: repo.path,
        remoteName: "origin",
      });
      setEditOriginUrl(url);
      setEditOriginUrlDialogOpen(true);
    } catch (e) {
      setOperationError(invokeErrorMessage(e));
    }
  }, [repo]);

  const closeEditOriginUrlDialog = useCallback(() => {
    setEditOriginUrlDialogOpen(false);
    setEditOriginUrl("");
  }, []);

  const cloneRepoDialogBackdropClose = useDialogBackdropClose(closeCloneRepoDialog);
  const createBranchDialogBackdropClose = useDialogBackdropClose(closeCreateBranchDialog);
  const amendCommitDialogBackdropClose = useDialogBackdropClose(closeAmendCommitDialog);
  const squashDialogBackdropClose = useDialogBackdropClose(closeSquashDialog);
  const createTagDialogBackdropClose = useDialogBackdropClose(closeCreateTagDialog);
  const editOriginUrlDialogBackdropClose = useDialogBackdropClose(closeEditOriginUrlDialog);

  const submitEditOriginUrl = useCallback(async () => {
    if (!repo?.path || repo.error) return;
    const trimmed = editOriginUrl.trim();
    if (!trimmed) return;
    setBranchBusy("remote-url");
    setOperationError(null);
    try {
      await setRemoteUrlMutation.mutateAsync({
        path: repo.path,
        remoteName: "origin",
        url: trimmed,
      });
      closeEditOriginUrlDialog();
    } catch (e) {
      setOperationError(invokeErrorMessage(e));
    } finally {
      setBranchBusy(null);
    }
  }, [repo, editOriginUrl, closeEditOriginUrlDialog, setRemoteUrlMutation]);

  const pullLocalBranch = useCallback(
    async (branchName: string) => {
      if (!repo?.path || repo.error) return;
      const pathAtStart = repo.path;
      const shouldFocusCurrentHead = !repo.detached && repo.branch === branchName;
      setBranchBusy(`pull:${branchName}`);
      setOperationError(null);
      try {
        await pullLocalBranchMutation.mutateAsync({
          path: pathAtStart,
          branch: branchName,
        });
        await refreshAfterMutation();
        if (shouldFocusCurrentHead) {
          const headHash =
            getRepoSnapshot(queryClient, pathAtStart)?.metadata?.headHash?.trim() || null;
          if (activeRepoPathRef.current === pathAtStart && headHash) {
            focusGraphOnCommitHash(headHash);
          }
        }
      } catch (e) {
        setOperationError(invokeErrorMessage(e));
      } finally {
        setBranchBusy(null);
      }
    },
    [repo, pullLocalBranchMutation, refreshAfterMutation, queryClient, focusGraphOnCommitHash],
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
        await deleteLocalBranchMutation.mutateAsync({
          path: repo.path,
          branch: branchName,
          force,
        });
      } catch (e) {
        setOperationError(invokeErrorMessage(e));
      } finally {
        setBranchBusy(null);
      }
    },
    [repo, deleteLocalBranchMutation],
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
        await deleteRemoteBranchMutation.mutateAsync({
          path: repo.path,
          remoteRef: fullRef,
        });
      } catch (e) {
        setOperationError(invokeErrorMessage(e));
      } finally {
        setBranchBusy(null);
      }
    },
    [repo, deleteRemoteBranchMutation],
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
        await rebaseCurrentBranchOntoMutation.mutateAsync({
          path: repo.path,
          onto,
          interactive,
        });
      } catch (e) {
        setOperationError(invokeErrorMessage(e));
      } finally {
        setBranchBusy(null);
      }
    },
    [repo, rebaseCurrentBranchOntoMutation],
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
        await mergeBranchMutation.mutateAsync({
          path: repo.path,
          branchOrRef: onto,
        });
      } catch (e) {
        setOperationError(invokeErrorMessage(e));
      } finally {
        setBranchBusy(null);
      }
    },
    [repo, mergeBranchMutation],
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
        await removeWorktreeMutation.mutateAsync({
          path: repo.path,
          worktreePath: worktree.path,
          force: hasLocalChanges,
        });
        if (worktreeBrowseTarget?.path === worktree.path) {
          clearWorktreeBrowse();
          clearDiffSelection();
        }
      } catch (e) {
        setOperationError(invokeErrorMessage(e));
      } finally {
        setBranchBusy(null);
      }
    },
    [
      repo,
      removeWorktreeMutation,
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
      const pathAtStart = repo.path;
      setBranchBusy(`local:${branch}`);
      setOperationError(null);
      try {
        await checkoutLocalBranchMutation.mutateAsync({
          path: pathAtStart,
          branch,
        });
        await refreshAfterMutation();
      } catch (e) {
        setOperationError(invokeErrorMessage(e));
      } finally {
        setBranchBusy(null);
      }
    },
    [repo, checkoutLocalBranchMutation, refreshAfterMutation],
  );

  const onCreateFromRemote = useCallback(
    async (remoteRef: string) => {
      if (!repo?.path || repo.error) return;
      setBranchBusy(`remote:${remoteRef}`);
      setOperationError(null);
      try {
        await createBranchFromRemoteMutation.mutateAsync({
          path: repo.path,
          remoteRef,
        });
      } catch (e) {
        setOperationError(invokeErrorMessage(e));
      } finally {
        setBranchBusy(null);
      }
    },
    [repo, createBranchFromRemoteMutation],
  );

  const runBranchSidebarContextMenu = useCallback(
    (
      spec: { kind: "local"; branchName: string } | { kind: "remote"; fullRef: string },
      clientX: number,
      clientY: number,
    ) => {
      const localBranch =
        spec.kind === "local"
          ? (localBranches.find((branch) => branch.name === spec.branchName) ?? null)
          : null;
      void popupBranchContextMenu(clientX, clientY, {
        kind: spec.kind,
        branchName: spec.kind === "local" ? spec.branchName : undefined,
        fullRef: spec.kind === "remote" ? spec.fullRef : undefined,
        currentBranchName: repo?.detached ? null : (repo?.branch ?? null),
        repoDetached: Boolean(repo?.detached),
        branchBusy: Boolean(branchBusy),
        canPull: localBranch?.upstreamName != null,
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
      localBranches,
      openEditOriginUrlDialog,
      onCheckoutLocal,
      onCreateFromRemote,
    ],
  );

  const openRemoteFolderContextMenu = useCallback(
    (remotePath: string, clientX: number, clientY: number) => {
      if (remoteNameFromSidebarPath(remotePath) !== "origin") return;
      void popupRemoteFolderContextMenu(clientX, clientY, {
        remoteName: "origin",
        disabled: Boolean(branchBusy),
        onEditRemoteUrl: () => {
          void openEditOriginUrlDialog();
        },
      });
    },
    [branchBusy, openEditOriginUrlDialog],
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
        await cherryPickCommitMutation.mutateAsync({
          path: repo.path,
          commitHash: hash,
        });
      } catch (e) {
        setOperationError(invokeErrorMessage(e));
      } finally {
        setBranchBusy(null);
      }
    },
    [repo, commits, cherryPickCommitMutation],
  );

  const continueRepoOperation = useCallback(async () => {
    if (!repo?.path || repo.error || !repo.operationState) return;
    setBranchBusy("continue-operation");
    setOperationError(null);
    try {
      await continueRepoOperationMutation.mutateAsync({ path: repo.path });
    } catch (e) {
      setOperationError(invokeErrorMessage(e));
    } finally {
      setBranchBusy(null);
    }
  }, [repo, continueRepoOperationMutation]);

  const abortRepoOperation = useCallback(async () => {
    if (!repo?.path || repo.error || !repo.operationState) return;
    setBranchBusy("abort-operation");
    setOperationError(null);
    try {
      await abortRepoOperationMutation.mutateAsync({ path: repo.path });
    } catch (e) {
      setOperationError(invokeErrorMessage(e));
    } finally {
      setBranchBusy(null);
    }
  }, [repo, abortRepoOperationMutation]);

  const skipRepoOperation = useCallback(async () => {
    if (!repo?.path || repo.error || !repo.operationState?.canSkip) return;
    setBranchBusy("skip-operation");
    setOperationError(null);
    try {
      await skipRepoOperationMutation.mutateAsync({ path: repo.path });
    } catch (e) {
      setOperationError(invokeErrorMessage(e));
    } finally {
      setBranchBusy(null);
    }
  }, [repo, skipRepoOperationMutation]);

  const resolveConflictChoice = useCallback(
    async (filePath: string, choice: ResolveConflictChoice) => {
      if (!repo?.path || repo.error) return;
      if (syncingStagePaths.has(filePath)) return;
      setOperationError(null);
      setSyncingStagePaths((prev) => {
        const next = new Set(prev);
        next.add(filePath);
        return next;
      });
      clearSelectedDiffContent();
      setConflictLoading(true);
      try {
        await resolveConflictChoiceMutation.mutateAsync({ path: repo.path, filePath, choice });
      } catch (e) {
        setOperationError(invokeErrorMessage(e));
      } finally {
        setSyncingStagePaths((prev) => {
          const next = new Set(prev);
          next.delete(filePath);
          return next;
        });
        setConflictLoading(false);
      }
    },
    [repo, syncingStagePaths, clearSelectedDiffContent, resolveConflictChoiceMutation],
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
        await rebaseCurrentBranchOntoMutation.mutateAsync({
          path: repo.path,
          onto: hash,
          interactive: false,
        });
      } catch (e) {
        setOperationError(invokeErrorMessage(e));
      } finally {
        setBranchBusy(null);
      }
    },
    [repo, commits, rebaseCurrentBranchOntoMutation],
  );

  const resetCurrentBranchToCommit = useCallback(
    async (hash: string, mode: ResetMode) => {
      if (!repo?.path || repo.error || repo.detached) return;
      const short = commits.find((c) => c.hash === hash)?.shortHash ?? hash.slice(0, 7);
      const ok =
        mode === ResetMode.Soft
          ? await ask(
              `Soft reset the current branch to ${short}? This rewrites this branch and keeps the resulting changes staged.`,
              { title: "Garlic", kind: "warning" },
            )
          : await ask(
              `Hard reset the current branch to ${short}? This rewrites this branch and discards staged and unstaged tracked changes.`,
              { title: "Garlic", kind: "warning" },
            );
      if (!ok) return;
      setBranchBusy("reset");
      setOperationError(null);
      try {
        await resetCurrentBranchToCommitMutation.mutateAsync({
          path: repo.path,
          commitHash: hash,
          mode,
        });
      } catch (e) {
        setOperationError(invokeErrorMessage(e));
      } finally {
        setBranchBusy(null);
      }
    },
    [repo, commits, resetCurrentBranchToCommitMutation],
  );

  const dropCommit = useCallback(
    async (hash: string) => {
      if (!repo?.path || repo.error || repo.detached) return;
      const short = commits.find((c) => c.hash === hash)?.shortHash ?? hash.slice(0, 7);
      const ok = await ask(
        `Drop commit ${short} from the current branch? This rewrites this branch's history.`,
        { title: "Garlic", kind: "warning" },
      );
      if (!ok) return;
      setBranchBusy("rebase");
      setOperationError(null);
      try {
        await dropCommitMutation.mutateAsync({
          path: repo.path,
          commitHash: hash,
        });
      } catch (e) {
        setOperationError(invokeErrorMessage(e));
      } finally {
        setBranchBusy(null);
      }
    },
    [repo, commits, dropCommitMutation],
  );

  const discardPathChanges = useCallback(
    async (filePath: string, fromUnstaged: boolean, renameFrom?: string | null) => {
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
        await discardPathsChangesMutation.mutateAsync({
          path: repo.path,
          files: [{ filePath, renameFrom: renameFrom ?? null }],
          fromUnstaged,
        });
      } catch (e) {
        setOperationError(invokeErrorMessage(e));
      } finally {
        setStageCommitBusy(false);
      }
    },
    [repo, discardPathsChangesMutation],
  );

  const discardAllUnstagedFiles = useCallback(
    async (files: readonly Pick<WorkingTreeFile, "path" | "renameFrom">[]) => {
      if (!repo?.path || repo.error || files.length === 0) return;
      const ok = await ask(
        `Discard unstaged changes for all ${
          files.length === 1 ? "1 file" : `${files.length} files`
        }? Untracked files will be permanently deleted.`,
        { title: "Garlic", kind: "warning" },
      );
      if (!ok) return;
      setStageCommitBusy(true);
      setOperationError(null);
      try {
        await discardPathsChangesMutation.mutateAsync({
          path: repo.path,
          files: files.map((file) => ({
            filePath: file.path,
            renameFrom: file.renameFrom ?? null,
          })),
          fromUnstaged: true,
        });
      } catch (e) {
        setOperationError(invokeErrorMessage(e));
      } finally {
        setStageCommitBusy(false);
      }
    },
    [repo, discardPathsChangesMutation],
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
      opts?:
        | {
            source: "worktree";
            variant: "staged" | "unstaged";
            renameFrom?: string | null;
          }
        | { source: "commitBrowse" },
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
          onDiscard: () =>
            void discardPathChanges(path, source.variant === "unstaged", source.renameFrom),
        });
      } else {
        void popupFileRowContextMenu(clientX, clientY, {
          source: "commitBrowse",
          branchBusy: Boolean(branchBusy),
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
      const mergeBranchItems = [
        ...localBranches
          .filter(
            (branch) =>
              branch.tipHash === hash && graphBranchVisible[`local:${branch.name}`] !== false,
          )
          .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))
          .map((branch, index) => ({
            id: `commit_merge_local_${index}`,
            text: `Merge "${branch.name}" into current branch`,
            enabled:
              !branchBusy && !repo?.detached && (!repo?.branch || branch.name !== repo.branch),
            action: () => {
              void mergeBranchIntoCurrent(branch.name);
            },
          })),
        ...remoteBranches
          .filter((branch) => {
            if (branch.tipHash !== hash) return false;
            return graphBranchVisible[`remote:${branch.name}`] ?? remoteGraphDefaultsVisible;
          })
          .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))
          .map((branch, index) => ({
            id: `commit_merge_remote_${index}`,
            text: `Merge "${branch.name}" into current branch`,
            enabled: !branchBusy && !repo?.detached,
            action: () => {
              void mergeBranchIntoCurrent(branch.name);
            },
          })),
      ];
      const amendDisabled =
        Boolean(branchBusy) ||
        Boolean(repo?.detached) ||
        Boolean(entry?.stashRef) ||
        !graphHeadFirstParentHashes.has(hash) ||
        (Boolean(repo?.headHash && repo.headHash !== hash) && entry?.parentHashes.length !== 1);
      void popupGraphCommitContextMenu(clientX, clientY, {
        amendDisabled,
        branchBusy: Boolean(branchBusy),
        cherryPickDisabled:
          Boolean(branchBusy) || Boolean(repo?.detached) || Boolean(entry?.stashRef),
        dropCommitDisabled:
          Boolean(branchBusy) ||
          Boolean(repo?.detached) ||
          Boolean(entry?.stashRef) ||
          entry?.parentHashes.length !== 1 ||
          !graphHeadFirstParentHashes.has(hash),
        resetDisabled:
          Boolean(branchBusy) ||
          Boolean(repo?.detached) ||
          Boolean(entry?.stashRef) ||
          Boolean(repo?.headHash && repo.headHash === hash),
        rebaseOntoDisabled:
          Boolean(branchBusy) ||
          Boolean(repo?.detached) ||
          Boolean(repo?.headHash && repo.headHash === hash),
        onAmend: () => {
          void openAmendCommitDialog(hash);
        },
        onBrowse: () => {
          clearGraphCommitSelection();
          void selectCommit(hash);
        },
        onCherryPick: () => void cherryPickCommit(hash),
        onDropCommit: () => void dropCommit(hash),
        onHardReset: () => void resetCurrentBranchToCommit(hash, ResetMode.Hard),
        onRebaseCurrentOnto: () => void rebaseCurrentBranchOntoCommit(hash),
        onSoftReset: () => void resetCurrentBranchToCommit(hash, ResetMode.Soft),
        onCreateBranch: () => {
          openCreateBranchDialogAtCommit(hash);
        },
        onCreateTag: () => {
          setCreateTagCommit(hash);
          setNewTagName("");
          setCreateTagMessage("");
          setCreateTagFieldError(null);
          setOperationError(null);
          setCreateTagDialogOpen(true);
        },
        onCopyFull: () => void navigator.clipboard.writeText(hash),
        onCopyShort: () => void navigator.clipboard.writeText(shortHash),
        mergeBranchItems,
      });
    },
    [
      branchBusy,
      repo,
      commits,
      localBranches,
      remoteBranches,
      graphBranchVisible,
      remoteGraphDefaultsVisible,
      graphHeadFirstParentHashes,
      openAmendCommitDialog,
      clearGraphCommitSelection,
      selectCommit,
      cherryPickCommit,
      dropCommit,
      mergeBranchIntoCurrent,
      openCreateBranchDialogAtCommit,
      rebaseCurrentBranchOntoCommit,
      resetCurrentBranchToCommit,
    ],
  );

  const runPushTagToOrigin = useCallback(
    async (tagName: string) => {
      if (!repo?.path || repo.error) return;
      setPushBusy(true);
      setOperationError(null);
      try {
        await pushTagToOriginMutation.mutateAsync({ path: repo.path, tag: tagName });
      } catch (e) {
        setOperationError(invokeErrorMessage(e));
      } finally {
        setPushBusy(false);
      }
    },
    [repo, pushTagToOriginMutation],
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
  const openAppSettingsListenerRef = useLatest(openAppSettings);
  const refreshAfterMutationListenerRef = useLatest(refreshAfterMutation);
  const handleCloneCompletePayloadListenerRef = useLatest(handleCloneCompletePayload);
  const openCloneRepoDialogListenerRef = useLatest(openCloneRepoDialog);
  const scheduleCloneProgressUiFlushListenerRef = useLatest(scheduleCloneProgressUiFlush);
  const scheduleRepositoryMutationRefresh = useCallback(() => {
    if (repoMutationRefreshInFlightRef.current) {
      repoMutationRefreshPendingRef.current = true;
      return;
    }
    repoMutationRefreshInFlightRef.current = true;
    void (async () => {
      try {
        do {
          repoMutationRefreshPendingRef.current = false;
          await refreshAfterMutationListenerRef.current({ fromWatcher: true });
        } while (repoMutationRefreshPendingRef.current);
      } finally {
        repoMutationRefreshInFlightRef.current = false;
      }
    })();
  }, [refreshAfterMutationListenerRef]);

  const runCheckForUpdates = useCallback(async () => {
    if (updateCheckInFlightRef.current) return;
    updateCheckInFlightRef.current = true;
    try {
      const update = await check();
      if (!update) {
        await message("You already have the latest Garlic release installed.", {
          title: "Garlic",
          kind: "info",
        });
        return;
      }
      const notes = update.body?.trim();
      const ok = await ask(
        notes
          ? `Garlic ${update.version} is available.\n\nRelease notes:\n${notes}\n\nDownload and install it now? Garlic will restart automatically when the update is ready.`
          : `Garlic ${update.version} is available.\n\nDownload and install it now? Garlic will restart automatically when the update is ready.`,
        { title: "Update Available", kind: "info" },
      );
      if (!ok) return;
      await update.downloadAndInstall();
      await relaunch();
    } catch (e) {
      await message(invokeErrorMessage(e), {
        title: "Unable to check for updates",
        kind: "error",
      });
    } finally {
      updateCheckInFlightRef.current = false;
    }
  }, []);
  const runCheckForUpdatesListenerRef = useLatest(runCheckForUpdates);

  useEffect(() => {
    const promise = Promise.all([
      listen("open-app-settings", () => {
        openAppSettingsListenerRef.current();
      }),
      listen("check-for-updates-request", () => {
        void runCheckForUpdatesListenerRef.current();
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
      listen<{ enabled: boolean }>("graph-active-branch-row-background-changed", (e) => {
        setHighlightActiveBranchRows(Boolean(e.payload.enabled));
      }),
      listen("repository-mutated", () => {
        scheduleRepositoryMutationRefresh();
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
    openAppSettingsListenerRef,
    runCheckForUpdatesListenerRef,
    scheduleRepositoryMutationRefresh,
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
        await createBranchAtCommitMutation.mutateAsync({
          path: repo.path,
          branch: trimmed,
          commit: createBranchStartCommit,
        });
      } else {
        await createLocalBranchMutation.mutateAsync({
          path: repo.path,
          branch: trimmed,
        });
      }
      closeCreateBranchDialog();
    } catch (e) {
      setOperationError(invokeErrorMessage(e));
    } finally {
      setBranchBusy(null);
    }
  }

  async function submitCreateTag({ pushToOrigin }: { pushToOrigin: boolean }) {
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
    setCreateTagSubmitAction(pushToOrigin ? "create-and-push" : "create");
    setBranchBusy("tag");
    setOperationError(null);
    let tagCreatedLocally = false;
    let startedPush = false;
    try {
      const msg = createTagMessage.trim();
      await createTagMutation.mutateAsync({
        path: repo.path,
        tag: trimmed,
        commit: createTagCommit,
        message: msg.length > 0 ? msg : null,
      });
      tagCreatedLocally = true;
      if (pushToOrigin) {
        setBranchBusy(null);
        startedPush = true;
        setPushBusy(true);
        await pushTagToOriginMutation.mutateAsync({ path: repo.path, tag: trimmed });
      }
      closeCreateTagDialog();
    } catch (e) {
      if (tagCreatedLocally && pushToOrigin) {
        closeCreateTagDialog();
        setOperationError(
          `Tag created locally, but pushing it to origin failed.\n\n${invokeErrorMessage(e)}`,
        );
      } else {
        setOperationError(invokeErrorMessage(e));
      }
    } finally {
      setBranchBusy(null);
      if (startedPush) setPushBusy(false);
      setCreateTagSubmitAction(null);
    }
  }

  async function submitAmendCommit() {
    const trimmed = composeCommitMessage(amendCommitTitle, amendCommitBody).trim();
    if (!repo?.path || repo.error || !amendCommitHash) return;
    if (amendCommitTitle.trim().length === 0 && amendCommitBody.trim().length > 0) {
      setAmendCommitFieldError("Add a commit title before the description.");
      return;
    }
    if (!trimmed) {
      setAmendCommitFieldError("Enter a commit message.");
      return;
    }
    setAmendCommitFieldError(null);
    setBranchBusy("reword");
    setOperationError(null);
    try {
      await rewordCommitMutation.mutateAsync({
        path: repo.path,
        commitHash: amendCommitHash,
        message: trimmed,
      });
      clearGraphCommitSelection();
      closeAmendCommitDialog();
    } catch (e) {
      setOperationError(invokeErrorMessage(e));
    } finally {
      setBranchBusy(null);
    }
  }

  async function submitSquashSelectedCommits() {
    const trimmed = squashCommitMessage.trim();
    if (!repo?.path || repo.error) return;
    if (!selectedGraphSquashState.canSquash) return;
    if (!trimmed) {
      setSquashCommitFieldError("Enter a commit message.");
      return;
    }
    setSquashCommitFieldError(null);
    setBranchBusy("squash");
    setOperationError(null);
    try {
      await squashCommitsMutation.mutateAsync({
        path: repo.path,
        commitHashes: selectedGraphSquashState.orderedEntries.map((commit) => commit.hash),
        message: trimmed,
      });
      clearGraphCommitSelection();
      closeSquashDialog();
    } catch (e) {
      setOperationError(invokeErrorMessage(e));
    } finally {
      setBranchBusy(null);
    }
  }

  const pruneStashFromLoadedGraph = useCallback((stashRef: string) => {
    const normalizedStashRef = stashRef.trim();
    if (!normalizedStashRef) return;
    setCommits((prev) => {
      const removedHashes = new Set<string>();
      for (const commit of prev) {
        if (commit.stashRef?.trim() !== normalizedStashRef) continue;
        removedHashes.add(commit.hash);
        for (const helperHash of commit.parentHashes.slice(1)) {
          removedHashes.add(helperHash);
        }
      }
      if (removedHashes.size === 0) return prev;
      return prev.filter((commit) => !removedHashes.has(commit.hash));
    });
  }, []);

  const onStashPop = useCallback(
    async (stashRef: string) => {
      if (!repo?.path || repo.error) return;
      const ok = await ask(`Pop ${stashRef} and apply its changes to the working tree?`, {
        title: "Garlic",
        kind: "warning",
      });
      if (!ok) return;
      setStashBusy(`pop:${stashRef}`);
      setOperationError(null);
      try {
        await stashPopMutation.mutateAsync({ path: repo.path, stashRef });
        pruneStashFromLoadedGraph(stashRef);
      } catch (e) {
        setOperationError(invokeErrorMessage(e));
      } finally {
        setStashBusy(null);
      }
    },
    [pruneStashFromLoadedGraph, repo, stashPopMutation],
  );

  const onStashDrop = useCallback(
    async (stashRef: string) => {
      if (!repo?.path || repo.error) return;
      const ok = await ask(`Drop ${stashRef} permanently? This cannot be undone.`, {
        title: "Garlic",
        kind: "warning",
      });
      if (!ok) return;
      setStashBusy(`drop:${stashRef}`);
      setOperationError(null);
      try {
        await stashDropMutation.mutateAsync({ path: repo.path, stashRef });
        pruneStashFromLoadedGraph(stashRef);
      } catch (e) {
        setOperationError(invokeErrorMessage(e));
      } finally {
        setStashBusy(null);
      }
    },
    [pruneStashFromLoadedGraph, repo, stashDropMutation],
  );

  function openGraphStashMenu(stashRef: string, clientX: number, clientY: number) {
    void popupStashContextMenu(clientX, clientY, {
      disabled: Boolean(branchBusy) || stashBusy !== null,
      onPop: () => void onStashPop(stashRef),
      onDrop: () => void onStashDrop(stashRef),
    });
  }

  function openGraphWipMenu(clientX: number, clientY: number) {
    void popupWipContextMenu(clientX, clientY, {
      disabled: Boolean(branchBusy) || stashBusy !== null,
      onStash: () => void onStashPush(),
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
      await deleteTagMutation.mutateAsync({ path: repo.path, tag: tagName });
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
      await deleteRemoteTagMutation.mutateAsync({ path: repo.path, tag: tagName });
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
    if (
      selectedDiffRepoPath === repo.path &&
      selectedDiffPath !== null &&
      nextPaths.includes(selectedDiffPath) &&
      selectedDiffSide === "unstaged"
    ) {
      diffLoadSeqRef.current += 1;
      setSelectedDiffSide("staged");
      clearSelectedDiffContent();
    }
    try {
      await stagePathsMutation.mutateAsync({ path: repo.path, paths: nextPaths });
    } catch (e) {
      setOperationError(invokeErrorMessage(e));
    } finally {
      setSyncingStagePaths((prev) => {
        const next = new Set(prev);
        for (const path of nextPaths) next.delete(path);
        return next;
      });
    }
  }

  async function onStageAll() {
    if (!repo?.path || repo.error) return;
    const nextPaths = unstagedPaths.filter((path) => !syncingStagePaths.has(path));
    if (nextPaths.length === 0) return;
    setOperationError(null);
    setSyncingStagePaths((prev) => {
      const next = new Set(prev);
      for (const path of nextPaths) next.add(path);
      return next;
    });
    if (
      selectedDiffRepoPath === repo.path &&
      selectedDiffPath !== null &&
      nextPaths.includes(selectedDiffPath) &&
      selectedDiffSide === "unstaged"
    ) {
      diffLoadSeqRef.current += 1;
      setSelectedDiffSide("staged");
      clearSelectedDiffContent();
    }
    try {
      await stageAllMutation.mutateAsync({ path: repo.path });
    } catch (e) {
      setOperationError(invokeErrorMessage(e));
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
    if (
      selectedDiffRepoPath === repo.path &&
      selectedDiffPath !== null &&
      nextPaths.includes(selectedDiffPath) &&
      selectedDiffSide === "staged"
    ) {
      diffLoadSeqRef.current += 1;
      setSelectedDiffSide("unstaged");
      clearSelectedDiffContent();
    }
    try {
      await unstagePathsMutation.mutateAsync({ path: repo.path, paths: nextPaths });
    } catch (e) {
      setOperationError(invokeErrorMessage(e));
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
          await stagePatchMutation.mutateAsync({ path: repo.path, patch });
        } else {
          await unstagePatchMutation.mutateAsync({ path: repo.path, patch });
        }
      } catch (e) {
        setOperationError(invokeErrorMessage(e));
      } finally {
        setSyncingStagePaths((prev) => {
          const next = new Set(prev);
          next.delete(filePath);
          return next;
        });
      }
    },
    [repo, syncingStagePaths, stagePatchMutation, unstagePatchMutation],
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
        await discardPatchMutation.mutateAsync({ path: repo.path, patch });
      } catch (e) {
        setOperationError(invokeErrorMessage(e));
      } finally {
        setSyncingStagePaths((prev) => {
          const next = new Set(prev);
          next.delete(filePath);
          return next;
        });
      }
    },
    [discardPatchMutation, repo, syncingStagePaths],
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

  const conflictedFiles = useMemo(
    () => workingTreeFiles.filter((file) => file.conflict),
    [workingTreeFiles],
  );
  const unstagedFiles = useMemo(
    () => workingTreeFiles.filter((file) => file.unstaged && !file.conflict),
    [workingTreeFiles],
  );
  const stagedFiles = useMemo(
    () => workingTreeFiles.filter((file) => file.staged && !file.conflict),
    [workingTreeFiles],
  );
  const hasConflictedFiles = conflictedFiles.length > 0;
  const showOperationErrorAlert = Boolean(operationError && !repo?.operationState);
  const hasStagedFiles = stagedFiles.length > 0;
  const unstagedPaths = useMemo(() => worktreeFilesMutationPaths(unstagedFiles), [unstagedFiles]);
  const stagedPaths = useMemo(() => worktreeFilesMutationPaths(stagedFiles), [stagedFiles]);
  const wipChangedFileCount = useMemo(() => {
    const paths = new Set<string>();
    for (const f of workingTreeFiles) {
      if (f.staged || f.unstaged || f.conflict) paths.add(f.path);
    }
    return paths.size;
  }, [workingTreeFiles]);
  const preferredWipFile = useMemo(
    () => conflictedFiles[0] ?? unstagedFiles[0] ?? stagedFiles[0] ?? null,
    [conflictedFiles, stagedFiles, unstagedFiles],
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
  const createTagDialogBusy = branchBusy === "tag" || pushBusy;
  const canSubmitNewTag = newTagTrimmed.length > 0 && !newTagNameInvalid && !createTagDialogBusy;
  const createTagBusy = createTagSubmitAction === "create" && createTagDialogBusy;
  const createAndPushTagBusy = createTagSubmitAction === "create-and-push" && createTagDialogBusy;
  const amendCommitMessage = useMemo(
    () => composeCommitMessage(amendCommitTitle, amendCommitBody),
    [amendCommitBody, amendCommitTitle],
  );
  const amendCommitTitleTrimmed = amendCommitTitle.trim();
  const amendCommitBodyTrimmed = amendCommitBody.trim();
  const amendCommitDraftInvalid =
    amendCommitTitleTrimmed.length === 0 && amendCommitBodyTrimmed.length > 0;
  const amendCommitDialogBusy = branchBusy === "reword";
  const amendCommitTrimmed = amendCommitMessage.trim();
  const amendCommitUnchanged =
    amendCommitTrimmed.length > 0 && amendCommitTrimmed === amendCommitOriginalMessage.trim();
  const canSubmitAmendCommit =
    amendCommitHash !== null &&
    amendCommitTrimmed.length > 0 &&
    !amendCommitDraftInvalid &&
    !amendCommitUnchanged &&
    !amendCommitDialogBusy;

  const createBranchStartEntry = useMemo(() => {
    if (!createBranchStartCommit) return null;
    return commits.find((c) => c.hash === createBranchStartCommit) ?? null;
  }, [commits, createBranchStartCommit]);

  const createTagStartEntry = useMemo(() => {
    if (!createTagCommit) return null;
    return commits.find((c) => c.hash === createTagCommit) ?? null;
  }, [commits, createTagCommit]);

  const amendCommitEntry = useMemo(() => {
    if (!amendCommitHash) return null;
    return commits.find((c) => c.hash === amendCommitHash) ?? null;
  }, [commits, amendCommitHash]);

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
  const selectedConflictFile = useMemo(() => {
    if (!selectedDiffPath) return null;
    const sourceFiles =
      selectedDiffRepoPath === repo?.path
        ? workingTreeFiles
        : selectedDiffRepoPath === worktreeBrowseTarget?.path
          ? worktreeBrowseFiles
          : [];
    return sourceFiles.find((file) => file.path === selectedDiffPath && file.conflict) ?? null;
  }, [
    repo?.path,
    selectedDiffPath,
    selectedDiffRepoPath,
    workingTreeFiles,
    worktreeBrowseFiles,
    worktreeBrowseTarget?.path,
  ]);
  const openSelectedDiffInCursor = useCallback(async () => {
    if (!selectedDiffRepoPath || !selectedDiffPath) return;
    try {
      await invoke("open_in_cursor", { path: selectedDiffRepoPath, filePath: selectedDiffPath });
    } catch (e) {
      setOperationError(invokeErrorMessage(e));
    }
  }, [selectedDiffPath, selectedDiffRepoPath]);
  const selectedDiffBusy =
    selectedDiffPath !== null &&
    (stageCommitBusy || commitPushBusy || syncingStagePaths.has(selectedDiffPath));
  const operationActionBusy =
    branchBusy === "continue-operation" ||
    branchBusy === "abort-operation" ||
    branchBusy === "skip-operation";
  const operationContinueDisabled =
    operationActionBusy ||
    Boolean(branchBusy && !branchBusy.endsWith("-operation")) ||
    hasConflictedFiles;
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
    (hash: string, options: { toggleSelection: boolean; rangeSelection: boolean }) => {
      if (options.rangeSelection) {
        const anchorHash = graphSelectionAnchorHash ?? hash;
        const anchorIndex = graphDisplayIndexByHash.get(anchorHash);
        const targetIndex = graphDisplayIndexByHash.get(hash);
        if (anchorIndex === undefined || targetIndex === undefined) {
          setSelectedGraphCommitHashes([hash]);
          setGraphSelectionAnchorHash(hash);
          return;
        }
        const start = Math.min(anchorIndex, targetIndex);
        const end = Math.max(anchorIndex, targetIndex);
        const nextSelection = deferredGraphDisplayCommits
          .slice(start, end + 1)
          .map((commit) => commit.hash);
        setSelectedGraphCommitHashes(nextSelection);
        setGraphSelectionAnchorHash(anchorHash);
        return;
      }
      if (options.toggleSelection) {
        setSelectedGraphCommitHashes((prev) =>
          prev.includes(hash) ? prev.filter((entry) => entry !== hash) : [...prev, hash],
        );
        setGraphSelectionAnchorHash(hash);
        return;
      }
      clearGraphCommitSelection();
      setGraphSelectionAnchorHash(hash);
      void selectCommit(hash);
    },
    [
      clearGraphCommitSelection,
      deferredGraphDisplayCommits,
      graphDisplayIndexByHash,
      graphSelectionAnchorHash,
      selectCommit,
    ],
  );
  const handleExportGraphCommits = useCallback(() => {
    void exportFilteredCommitsList();
  }, [exportFilteredCommitsList]);
  const handleSelectWipRow = useCallback(() => {
    if (!preferredWipFile) return;
    void loadDiffForFile(preferredWipFile, preferredWipFile.unstaged ? "unstaged" : "staged");
  }, [loadDiffForFile, preferredWipFile]);
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
          await amendLastCommitMutation.mutateAsync({
            path: repo.path,
            message: message.length > 0 ? message : null,
          });
        } else {
          await commitStagedMutation.mutateAsync({ path: repo.path, message });
        }
        return true;
      } catch (e) {
        setOperationError(invokeErrorMessage(e));
        return false;
      } finally {
        setStageCommitBusy(false);
      }
    },
    [amendLastCommitMutation, commitStagedMutation, hasStagedFiles, repo],
  );
  const pushCurrentBranchToOrigin = useCallback(
    async ({ skipHooks }: { skipHooks: boolean }) => {
      if (!repo?.path || repo.error) return;
      setPushBusy(true);
      setOperationError(null);
      try {
        await pushToOriginMutation.mutateAsync({
          path: repo.path,
          skipHooks,
        });
      } catch (e) {
        setOperationError(invokeErrorMessage(e));
      } finally {
        setPushBusy(false);
      }
    },
    [pushToOriginMutation, repo],
  );
  const forcePushCurrentBranchToOrigin = useCallback(async () => {
    if (!repo?.path || repo.error || repo.detached) return;
    const branchName = repo.branch?.trim();
    if (!branchName) return;
    const ok = await ask(
      `Force push "${branchName}" to origin? This runs git push --force-with-lease: the remote branch will be updated to match your local tip, but only if the remote has not received new commits (otherwise the push is rejected).`,
      { title: "Garlic", kind: "warning" },
    );
    if (!ok) return;
    setPushBusy(true);
    setOperationError(null);
    try {
      await forcePushToOriginMutation.mutateAsync({
        path: repo.path,
        skipHooks: false,
      });
    } catch (e) {
      setOperationError(invokeErrorMessage(e));
    } finally {
      setPushBusy(false);
    }
  }, [forcePushToOriginMutation, repo]);
  const openGraphPushActionMenu = useCallback(
    (clientX: number, clientY: number) => {
      if (!repo?.path || repo.error || repo.detached) return;
      if (branchBusy || pushBusy || stashBusy !== null) return;
      void popupGraphPushContextMenu(clientX, clientY, {
        disabled: false,
        onForcePush: () => {
          void forcePushCurrentBranchToOrigin();
        },
      });
    },
    [branchBusy, forcePushCurrentBranchToOrigin, pushBusy, repo, stashBusy],
  );
  const submitCommitAndPush = useCallback(
    async ({ message, skipHooks }: { message: string; skipHooks: boolean }) => {
      if (!repo?.path || repo.error || repo.detached || !message || !hasStagedFiles) return false;
      setCommitPushBusy(true);
      setOperationError(null);
      let committed = false;
      try {
        await commitStagedMutation.mutateAsync({ path: repo.path, message });
        committed = true;
        await pushToOriginMutation.mutateAsync({
          path: repo.path,
          skipHooks,
        });
        return true;
      } catch (e) {
        setOperationError(invokeErrorMessage(e));
        return committed;
      } finally {
        setCommitPushBusy(false);
      }
    },
    [commitStagedMutation, hasStagedFiles, pushToOriginMutation, repo],
  );

  /** Branch/stash sidebar hidden; main column expands while viewing a commit, file diff, history, or blame. */
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
  /** Selected graph commit browsing takes the full 12-column layout. */
  const showFullWidthCommitBrowse =
    Boolean(commitBrowseHash) && !listsError && Boolean(repo && !repo.error);

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
      deferredGraphDisplayCommits.map((c) => ({
        hash: c.hash,
        parentHashes: c.parentHashes,
        stashRef: c.stashRef,
      })),
      graphBranchTips,
      currentBranchName,
      commitGraphRowHeightPx(graphCommitTitleFontSizePx),
    );
  }, [
    worktreeBrowseTarget,
    commitBrowseHash,
    selectedDiffPath,
    fileBlamePath,
    fileHistoryPath,
    deferredGraphDisplayCommits,
    graphBranchTips,
    currentBranchName,
    graphCommitTitleFontSizePx,
  ]);

  /** Tip commit of the checked-out branch — used to highlight that row in the graph. */
  const currentBranchTipHash = useMemo(() => {
    if (!currentBranchName) return null;
    return localBranches.find((b) => b.name === currentBranchName)?.tipHash ?? null;
  }, [currentBranchName, localBranches]);
  const graphToolbarBranchTargetHash = useMemo(() => {
    if (selectedGraphCommitHashes.length === 1) {
      return selectedGraphCommitHashes[0] ?? null;
    }
    if (graphFocusHash) return graphFocusHash;
    return currentBranchTipHash ?? (repo?.headHash?.trim() || null);
  }, [currentBranchTipHash, graphFocusHash, repo?.headHash, selectedGraphCommitHashes]);
  const graphToolbarBranchTargetLabel = useMemo(() => {
    if (!graphToolbarBranchTargetHash) return null;
    return (
      commits.find((commit) => commit.hash === graphToolbarBranchTargetHash)?.shortHash ??
      graphToolbarBranchTargetHash.slice(0, 7)
    );
  }, [commits, graphToolbarBranchTargetHash]);
  const latestStashRef = stashes[0]?.refName ?? null;
  const graphToolbarActionBusy = Boolean(branchBusy) || pushBusy || stashBusy !== null;
  const pullActionDisabled = graphToolbarActionBusy || currentBranchName === null;
  const pushActionDisabled =
    graphToolbarActionBusy || !repo?.path || Boolean(repo.error) || Boolean(repo.detached);
  const branchActionDisabled = graphToolbarActionBusy || graphToolbarBranchTargetHash === null;
  const stashActionDisabled = graphToolbarActionBusy || wipChangedFileCount === 0;
  const popActionDisabled = graphToolbarActionBusy || latestStashRef === null;
  const handleGraphPullAction = useCallback(() => {
    if (!currentBranchName) return;
    void pullLocalBranch(currentBranchName);
  }, [currentBranchName, pullLocalBranch]);
  const handleGraphPushAction = useCallback(() => {
    void pushCurrentBranchToOrigin({ skipHooks: false });
  }, [pushCurrentBranchToOrigin]);
  const handleGraphBranchAction = useCallback(() => {
    if (!graphToolbarBranchTargetHash) return;
    openCreateBranchDialogAtCommit(graphToolbarBranchTargetHash);
  }, [graphToolbarBranchTargetHash, openCreateBranchDialogAtCommit]);
  const handleGraphStashAction = useCallback(() => {
    void onStashPush();
  }, [onStashPush]);
  const handleGraphPopAction = useCallback(() => {
    if (!latestStashRef) return;
    void onStashPop(latestStashRef);
  }, [latestStashRef, onStashPop]);

  return (
    <main className="relative box-border flex min-h-0 flex-1 flex-col overflow-hidden bg-base-200 text-base-content antialiased [font-synthesis:none]">
      <div
        className="grid min-h-0 min-w-0 flex-1 grid-cols-12 border-t border-base-300 lg:min-h-0 lg:grid-rows-1 lg:items-stretch"
        aria-live="polite"
        aria-busy={loading}
      >
        <aside
          className={`col-span-12 flex min-h-0 min-w-0 flex-col gap-2 lg:col-span-3 lg:h-full lg:min-h-0 ${
            showExpandedDiff ? "hidden" : ""
          }`}
        >
          {cloneRepoDialogOpen ? (
            <dialog
              open
              className="modal"
              onCancel={(e) => {
                e.preventDefault();
                closeCloneRepoDialog();
              }}
              onMouseDown={cloneRepoDialogBackdropClose.onMouseDown}
              onMouseUp={cloneRepoDialogBackdropClose.onMouseUp}
            >
              <div
                className="modal-box"
                onClick={(e) => {
                  e.stopPropagation();
                }}
              >
                <h3 className="m-0 text-lg font-bold">Clone repository</h3>
                <p className="mt-1 mb-0 text-sm text-base-content/70">
                  Enter the remote URL, then choose a folder where the new repository directory
                  should be created.
                </p>
                <label className="form-control mt-4 block w-full">
                  <span className="label-text mb-1">Remote URL</span>
                  <input
                    type="text"
                    autoFocus
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
                  <button type="button" className="btn" onClick={closeCloneRepoDialog}>
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
          ) : null}

          {createBranchDialogOpen ? (
            <dialog
              open
              className="modal"
              onCancel={(e) => {
                e.preventDefault();
                closeCreateBranchDialog();
              }}
              onMouseDown={createBranchDialogBackdropClose.onMouseDown}
              onMouseUp={createBranchDialogBackdropClose.onMouseUp}
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
                      <span className="block truncate pt-0.5">
                        {createBranchStartEntry.subject}
                      </span>
                    ) : null}
                  </p>
                ) : null}
                <label className="form-control mt-4 block w-full">
                  <span className="label-text mb-1">Branch name</span>
                  <input
                    type="text"
                    autoFocus
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
                    onClick={closeCreateBranchDialog}
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
          ) : null}

          {amendCommitDialogOpen ? (
            <dialog
              open
              className="modal"
              onCancel={(e) => {
                e.preventDefault();
                closeAmendCommitDialog();
              }}
              onMouseDown={amendCommitDialogBackdropClose.onMouseDown}
              onMouseUp={amendCommitDialogBackdropClose.onMouseUp}
            >
              <div
                className="modal-box"
                onClick={(e) => {
                  e.stopPropagation();
                }}
              >
                <h3 className="m-0 text-lg font-bold">Edit Commit Message</h3>
                <p className="mt-1 mb-0 text-sm text-base-content/70">
                  Rewrites this commit message and updates any newer commits on this branch if
                  needed.
                </p>
                {amendCommitHash ? (
                  <p className="mt-2 mb-0 text-xs text-base-content/70">
                    <span className="font-mono text-base-content/80">
                      {amendCommitEntry?.shortHash ?? amendCommitHash.slice(0, 7)}
                    </span>
                    {amendCommitEntry?.subject ? (
                      <span className="block truncate pt-0.5">{amendCommitEntry.subject}</span>
                    ) : null}
                  </p>
                ) : null}
                <label className="form-control mt-4 block w-full">
                  <span className="label-text mb-1">Title</span>
                  <input
                    type="text"
                    autoFocus
                    className="input-bordered input w-full font-sans text-sm"
                    value={amendCommitTitle}
                    autoComplete="off"
                    spellCheck={false}
                    disabled={amendCommitDialogBusy}
                    onChange={(e) => {
                      setAmendCommitTitle(e.target.value);
                      if (amendCommitFieldError) setAmendCommitFieldError(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                        e.preventDefault();
                        void submitAmendCommit();
                      }
                    }}
                  />
                </label>
                <label className="form-control mt-3 block w-full">
                  <span className="label-text mb-1">Description</span>
                  <textarea
                    className="textarea-bordered textarea min-h-28 w-full font-sans text-sm"
                    value={amendCommitBody}
                    disabled={amendCommitDialogBusy}
                    onChange={(e) => {
                      setAmendCommitBody(e.target.value);
                      if (amendCommitFieldError) setAmendCommitFieldError(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                        e.preventDefault();
                        void submitAmendCommit();
                      }
                    }}
                  />
                  {amendCommitFieldError ? (
                    <span className="label-text-alt mt-1 block w-full text-error">
                      {amendCommitFieldError}
                    </span>
                  ) : amendCommitDraftInvalid ? (
                    <span className="label-text-alt mt-1 block w-full text-error">
                      Add a commit title before the description.
                    </span>
                  ) : null}
                </label>
                <div className="modal-action">
                  <button
                    type="button"
                    className="btn"
                    disabled={amendCommitDialogBusy}
                    onClick={closeAmendCommitDialog}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={!canSubmitAmendCommit}
                    onClick={() => void submitAmendCommit()}
                  >
                    {amendCommitDialogBusy ? (
                      <span className="loading loading-sm loading-spinner" />
                    ) : (
                      "Amend"
                    )}
                  </button>
                </div>
              </div>
            </dialog>
          ) : null}

          {squashDialogOpen ? (
            <dialog
              open
              className="modal"
              onCancel={(e) => {
                e.preventDefault();
                closeSquashDialog();
              }}
              onMouseDown={squashDialogBackdropClose.onMouseDown}
              onMouseUp={squashDialogBackdropClose.onMouseUp}
            >
              <div
                className="modal-box max-w-2xl"
                onClick={(e) => {
                  e.stopPropagation();
                }}
              >
                <h3 className="m-0 text-lg font-bold">Squash selected commits</h3>
                <p className="mt-1 mb-0 text-sm text-base-content/70">
                  Combines the selected commits into one commit and rewrites this branch&apos;s
                  history.
                </p>
                <div className="mt-4 rounded-box border border-base-300/80 bg-base-200/50">
                  <div className="border-b border-base-300/80 px-3 py-2 text-[0.65rem] font-semibold tracking-wide text-base-content/55 uppercase">
                    Selected commits
                  </div>
                  <div className="max-h-40 overflow-y-auto px-3 py-2">
                    <ul className="m-0 flex list-none flex-col gap-1 p-0">
                      {[...selectedGraphSquashState.orderedEntries].reverse().map((commit) => (
                        <li
                          key={commit.hash}
                          className="flex items-start gap-2 rounded-md px-2 py-1.5 text-sm text-base-content/80"
                        >
                          <code className="shrink-0 text-[0.72rem] text-base-content/55">
                            {commit.shortHash}
                          </code>
                          <span className="min-w-0 truncate">{commit.subject}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
                <label className="form-control mt-4 block w-full">
                  <span className="label-text mb-1">New commit message</span>
                  <textarea
                    autoFocus
                    className="textarea-bordered textarea min-h-40 w-full font-mono text-sm"
                    value={squashCommitMessage}
                    disabled={branchBusy === "squash"}
                    onChange={(e) => {
                      setSquashCommitMessage(e.target.value);
                      if (squashCommitFieldError) setSquashCommitFieldError(null);
                    }}
                    onKeyDown={(e) => {
                      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                        e.preventDefault();
                        void submitSquashSelectedCommits();
                      }
                    }}
                  />
                  {squashCommitFieldError ? (
                    <span className="label-text-alt mt-1 block w-full text-error">
                      {squashCommitFieldError}
                    </span>
                  ) : null}
                </label>
                <div className="modal-action">
                  <button
                    type="button"
                    className="btn"
                    disabled={branchBusy === "squash"}
                    onClick={closeSquashDialog}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={branchBusy === "squash" || !selectedGraphSquashState.canSquash}
                    onClick={() => void submitSquashSelectedCommits()}
                  >
                    {branchBusy === "squash" ? (
                      <>
                        <span className="loading loading-sm loading-spinner" />
                        Squashing...
                      </>
                    ) : (
                      "Squash commits"
                    )}
                  </button>
                </div>
              </div>
            </dialog>
          ) : null}

          {createTagDialogOpen ? (
            <dialog
              open
              className="modal"
              onCancel={(e) => {
                e.preventDefault();
                closeCreateTagDialog();
              }}
              onMouseDown={createTagDialogBackdropClose.onMouseDown}
              onMouseUp={createTagDialogBackdropClose.onMouseUp}
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
                    type="text"
                    autoFocus
                    className="input-bordered input w-full font-mono text-sm"
                    value={newTagName}
                    autoComplete="off"
                    spellCheck={false}
                    disabled={createTagDialogBusy}
                    onChange={(e) => {
                      setNewTagName(e.target.value);
                      if (createTagFieldError) setCreateTagFieldError(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void submitCreateTag({ pushToOrigin: false });
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
                    disabled={createTagDialogBusy}
                    onChange={(e) => {
                      setCreateTagMessage(e.target.value);
                    }}
                  />
                </label>
                <div className="modal-action">
                  <button
                    type="button"
                    className="btn"
                    disabled={createTagDialogBusy}
                    onClick={closeCreateTagDialog}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="btn"
                    disabled={!canSubmitNewTag}
                    onClick={() => void submitCreateTag({ pushToOrigin: false })}
                  >
                    {createTagBusy ? (
                      <>
                        <span className="loading loading-sm loading-spinner" />
                        Creating...
                      </>
                    ) : (
                      "Create tag"
                    )}
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={!canSubmitNewTag}
                    onClick={() => void submitCreateTag({ pushToOrigin: true })}
                  >
                    {createAndPushTagBusy ? (
                      <>
                        <span className="loading loading-sm loading-spinner" />
                        {pushBusy ? "Pushing..." : "Creating..."}
                      </>
                    ) : (
                      "Create tag and push"
                    )}
                  </button>
                </div>
              </div>
            </dialog>
          ) : null}

          {editOriginUrlDialogOpen ? (
            <dialog
              open
              className="modal"
              onCancel={(e) => {
                e.preventDefault();
                closeEditOriginUrlDialog();
              }}
              onMouseDown={editOriginUrlDialogBackdropClose.onMouseDown}
              onMouseUp={editOriginUrlDialogBackdropClose.onMouseUp}
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
                    type="text"
                    autoFocus
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
                    onClick={closeEditOriginUrlDialog}
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
          ) : null}

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
            onRemoteFolderContextMenu={openRemoteFolderContextMenu}
            onOpenWorktree={handleOpenWorktree}
            onPreviewWorktreeDiff={handlePreviewWorktreeDiff}
            onWorktreeContextMenu={runWorktreeSidebarContextMenu}
            onStashClick={onStashSidebarClick}
            onTagClick={onTagSidebarClick}
            runBranchSidebarContextMenu={runBranchSidebarContextMenu}
            openGraphStashMenu={openGraphStashMenu}
            openTagSidebarMenu={openTagSidebarMenu}
          />
          <GitCommandPanel repoPath={repo?.path ?? null} />
        </aside>

        <div
          className={`col-span-12 flex min-h-0 min-w-0 flex-col gap-2 lg:h-full lg:min-h-0 ${
            showFullWidthCommitBrowse
              ? "lg:col-span-12"
              : showExpandedDiff
                ? "lg:col-span-9"
                : "lg:col-span-6"
          }`}
        >
          <section className="flex min-h-0 w-full min-w-0 flex-1 flex-col border-x border-base-300 bg-base-100">
            <div className="card-body flex min-h-0 flex-1 flex-col gap-0 p-0">
              {loading ? (
                <div className="2 flex min-h-0 flex-1 flex-col justify-start px-6 py-6">
                  {cloneProgress ? (
                    <>
                      <div className="mx-auto flex w-full max-w-lg shrink-0 flex-col gap-2">
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
                    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2">
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
                              updateCurrentRepoSnapshot((snapshot) => ({
                                ...snapshot,
                                metadata: snapshot.metadata
                                  ? { ...snapshot.metadata, error: null }
                                  : snapshot.metadata,
                              }));
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
                          {listsError || showOperationErrorAlert ? (
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
                              {showOperationErrorAlert ? (
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
                          {repo?.operationState ? (
                            <div className="shrink-0 p-3">
                              <div className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-warning/40 bg-warning/10 px-3 py-3">
                                <div className="min-w-0 flex-1">
                                  <p className="m-0 text-sm font-semibold text-base-content">
                                    {repo.operationState.label}
                                  </p>
                                  <p className="mt-1 mb-0 text-xs leading-relaxed text-base-content/70">
                                    {hasConflictedFiles
                                      ? `Resolve ${conflictedFiles.length} conflicted file${conflictedFiles.length === 1 ? "" : "s"}, then continue.`
                                      : "Continue, skip, or abort this operation."}
                                  </p>
                                </div>
                                <div className="flex shrink-0 flex-wrap items-center gap-2">
                                  {repo.operationState.canAbort ? (
                                    <button
                                      type="button"
                                      className="btn btn-outline btn-sm"
                                      disabled={operationActionBusy}
                                      onClick={() => {
                                        void abortRepoOperation();
                                      }}
                                    >
                                      {branchBusy === "abort-operation" ? (
                                        <span className="loading loading-xs loading-spinner" />
                                      ) : (
                                        "Abort"
                                      )}
                                    </button>
                                  ) : null}
                                  {repo.operationState.canSkip ? (
                                    <button
                                      type="button"
                                      className="btn btn-ghost btn-sm"
                                      disabled={operationActionBusy}
                                      onClick={() => {
                                        void skipRepoOperation();
                                      }}
                                    >
                                      {branchBusy === "skip-operation" ? (
                                        <span className="loading loading-xs loading-spinner" />
                                      ) : (
                                        "Skip"
                                      )}
                                    </button>
                                  ) : null}
                                  {repo.operationState.canContinue ? (
                                    <button
                                      type="button"
                                      className="btn btn-sm btn-primary"
                                      disabled={operationContinueDisabled}
                                      onClick={() => {
                                        void continueRepoOperation();
                                      }}
                                    >
                                      {branchBusy === "continue-operation" ? (
                                        <span className="loading loading-xs loading-spinner" />
                                      ) : (
                                        "Continue"
                                      )}
                                    </button>
                                  ) : null}
                                </div>
                              </div>
                            </div>
                          ) : null}

                          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                            {!listsError && worktreeBrowseTarget ? (
                              <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden px-4 pt-3 pb-4">
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
                                <div className="flex min-h-0 min-w-0 flex-1 flex-row overflow-hidden">
                                  <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
                                    {!selectedDiffPath ||
                                    selectedDiffRepoPath !== worktreeBrowseTarget.path ? (
                                      <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-2 py-10">
                                        <p className="m-0 text-center text-xs text-base-content/55">
                                          Select a file to view its diff
                                        </p>
                                      </div>
                                    ) : (
                                      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                                        {selectedConflictFile ? (
                                          <ConflictResolutionPane
                                            path={selectedConflictFile.path}
                                            repoOperationLabel={repo?.operationState?.label ?? null}
                                            loading={conflictLoading}
                                            error={conflictError}
                                            details={conflictDetails}
                                            busy={!canEditSelectedDiff || selectedDiffBusy}
                                            oursLabel={
                                              selectedConflictFile.conflict?.oursLabel ??
                                              "Keep ours"
                                            }
                                            theirsLabel={
                                              selectedConflictFile.conflict?.theirsLabel ??
                                              "Keep theirs"
                                            }
                                            canChooseOurs={
                                              selectedConflictFile.conflict?.canChooseOurs ?? false
                                            }
                                            canChooseTheirs={
                                              selectedConflictFile.conflict?.canChooseTheirs ??
                                              false
                                            }
                                            onChooseOurs={() => {
                                              void resolveConflictChoice(
                                                selectedConflictFile.path,
                                                ResolveConflictChoice.Ours,
                                              );
                                            }}
                                            onChooseTheirs={() => {
                                              void resolveConflictChoice(
                                                selectedConflictFile.path,
                                                ResolveConflictChoice.Theirs,
                                              );
                                            }}
                                            onChooseBoth={() => {
                                              void resolveConflictChoice(
                                                selectedConflictFile.path,
                                                ResolveConflictChoice.Both,
                                              );
                                            }}
                                            onOpenInCursor={() => {
                                              void openSelectedDiffInCursor();
                                            }}
                                            onBack={clearDiffSelection}
                                            onDismissError={() => {
                                              setConflictError(null);
                                            }}
                                          />
                                        ) : diffLoading ? (
                                          <div className="flex flex-1 flex-col items-center justify-center gap-2 py-20">
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
                                  <div className="flex w-[min(15rem,34vw)] min-w-0 shrink-0 flex-col border-t border-base-300/80">
                                    <div className="shrink-0 border-b border-base-300/80 py-2">
                                      <h2 className="m-0 flex flex-wrap items-baseline gap-x-1.5 gap-y-0 text-[0.65rem] font-semibold tracking-wide text-base-content/50 uppercase">
                                        <span>Files</span>
                                        {!worktreeBrowseLoading ? (
                                          <span className="font-mono text-[0.65rem] font-normal tracking-normal text-base-content/45 normal-case tabular-nums">
                                            ({worktreeBrowseFileEntries.length})
                                          </span>
                                        ) : null}
                                      </h2>
                                    </div>
                                    <div className="flex min-h-0 flex-1 flex-col">
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
                                          className="m-0 min-h-0 flex-1 overflow-y-auto"
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
                                                const conflicted = Boolean(entry.file.conflict);
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
                                                      className={`flex min-h-10 w-full items-center gap-2 rounded-lg border px-0 py-2 text-left text-[0.8125rem] leading-snug transition-colors ${
                                                        selected
                                                          ? "border-primary/50 bg-primary/10 ring-1 ring-primary/25"
                                                          : "border-base-300/40 bg-base-200/50 hover:border-base-300 hover:bg-base-300/45 active:bg-base-300/55"
                                                      }`}
                                                      onClick={() => {
                                                        if (conflicted) {
                                                          void loadConflictForFile(entry.file, {
                                                            repoPath: worktreeBrowseTarget.path,
                                                            clearCommitBrowse: false,
                                                          });
                                                          return;
                                                        }
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
                                                        browsingCurrentRepoWorktree && !conflicted
                                                          ? (e) => {
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
                                                      {conflicted ? (
                                                        <span className="badge shrink-0 badge-outline badge-warning">
                                                          conflict
                                                        </span>
                                                      ) : null}
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
                              selectedConflictFile ? (
                                <ConflictResolutionPane
                                  path={selectedDiffPath}
                                  repoOperationLabel={repo?.operationState?.label ?? null}
                                  loading={conflictLoading}
                                  error={conflictError}
                                  details={conflictDetails}
                                  busy={!canEditSelectedDiff || selectedDiffBusy}
                                  oursLabel={
                                    selectedConflictFile.conflict?.oursLabel ?? "Keep ours"
                                  }
                                  theirsLabel={
                                    selectedConflictFile.conflict?.theirsLabel ?? "Keep theirs"
                                  }
                                  canChooseOurs={
                                    selectedConflictFile.conflict?.canChooseOurs ?? false
                                  }
                                  canChooseTheirs={
                                    selectedConflictFile.conflict?.canChooseTheirs ?? false
                                  }
                                  onChooseOurs={() => {
                                    void resolveConflictChoice(
                                      selectedDiffPath,
                                      ResolveConflictChoice.Ours,
                                    );
                                  }}
                                  onChooseTheirs={() => {
                                    void resolveConflictChoice(
                                      selectedDiffPath,
                                      ResolveConflictChoice.Theirs,
                                    );
                                  }}
                                  onChooseBoth={() => {
                                    void resolveConflictChoice(
                                      selectedDiffPath,
                                      ResolveConflictChoice.Both,
                                    );
                                  }}
                                  onOpenInCursor={() => {
                                    void openSelectedDiffInCursor();
                                  }}
                                  onBack={clearDiffSelection}
                                  onDismissError={() => {
                                    setConflictError(null);
                                  }}
                                />
                              ) : (
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
                              )
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
                              <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
                                <div className="flex min-h-0 min-w-0 flex-1 flex-row overflow-hidden">
                                  <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
                                    {!commitDiffPath ? (
                                      <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-2 py-10">
                                        <p className="m-0 text-center text-xs text-base-content/55">
                                          Select a file to view its diff
                                        </p>
                                      </div>
                                    ) : (
                                      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
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
                                          <div className="flex-1 overflow-auto border-t border-base-300/80 bg-base-200/30 p-2">
                                            <div className="m-0 mb-1.5 text-[0.6rem] font-semibold tracking-wide text-base-content/45 uppercase">
                                              <button
                                                type="button"
                                                className="btn shrink-0 btn-xs btn-primary"
                                                onClick={clearCommitBrowse}
                                              >
                                                Back to commits
                                              </button>
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
                                  <div className="flex w-96 min-w-0 shrink-0 flex-col border-t border-l border-base-300/80">
                                    <div className="shrink-0 border-b border-base-300/80 bg-base-200 px-3 py-3">
                                      <div className="flex items-baseline justify-between gap-3">
                                        <p className="m-0 font-mono text-[0.65rem] text-base-content/50">
                                          {formatDate(
                                            commitDetails?.authorDate ??
                                              commitBrowseMeta?.authorTime ??
                                              null,
                                          ) ?? "—"}
                                        </p>
                                        <button
                                          type="button"
                                          className="btn shrink-0 btn-ghost btn-xs"
                                          aria-expanded={commitDetailsExpanded}
                                          onClick={() => {
                                            const nextExpanded = !commitDetailsExpanded;
                                            setCommitDetailsExpanded(nextExpanded);
                                            if (
                                              !nextExpanded ||
                                              !repo?.path ||
                                              !commitBrowseHash ||
                                              commitSignature.loading ||
                                              commitSignature.verified !== null
                                            ) {
                                              return;
                                            }
                                            const pathAtStart = repo.path;
                                            const seq = selectCommitSeqRef.current;
                                            setCommitSignature({ loading: true, verified: null });
                                            void invoke("start_commit_signature_check", {
                                              path: pathAtStart,
                                              commitHash: commitBrowseHash,
                                              requestId: seq,
                                            }).catch(() => {
                                              if (
                                                activeRepoPathRef.current !== pathAtStart ||
                                                seq !== selectCommitSeqRef.current
                                              ) {
                                                return;
                                              }
                                              setCommitSignature({
                                                loading: false,
                                                verified: null,
                                              });
                                            });
                                          }}
                                        >
                                          {commitDetailsExpanded ? "Collapse" : "Expand"}
                                        </button>
                                      </div>
                                      <h2 className="mt-2 mb-0 text-base leading-snug font-semibold text-base-content">
                                        {commitDetails?.subject ??
                                          commitBrowseMeta?.subject ??
                                          commitBrowseHash.slice(0, 7)}
                                      </h2>
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
                                          <span className="wrap-break-word">
                                            {commitDetailsError}
                                          </span>
                                        </DismissibleAlert>
                                      ) : (
                                        <div className="mt-3 text-xs leading-relaxed">
                                          <div className="min-w-0">
                                            <div className="text-base-content/90">
                                              {commitDetails?.author.trim() ||
                                                commitBrowseMeta?.author.trim() ||
                                                "—"}
                                              {" — "}
                                              <code className="font-mono text-[0.7rem] wrap-break-word text-base-content/55">
                                                {commitDetails?.authorEmail.trim() ||
                                                  commitBrowseMeta?.authorEmail.trim() ||
                                                  "—"}
                                              </code>
                                            </div>
                                          </div>
                                          {commitDetailsExpanded ? (
                                            <div className="mt-3 space-y-3">
                                              {commitDescription ? (
                                                <pre className="m-0 overflow-x-auto font-sans text-xs leading-relaxed whitespace-pre-wrap text-base-content/75">
                                                  {commitDescription}
                                                </pre>
                                              ) : null}
                                              <div className="flex items-start justify-between gap-3">
                                                <div>
                                                  <div className="text-[0.65rem] font-semibold tracking-wide text-base-content/45 uppercase">
                                                    Signature
                                                  </div>
                                                  <div className="mt-0.5 text-[0.7rem]">
                                                    {commitSignature.loading ? (
                                                      <span className="text-base-content/50">
                                                        checking…
                                                      </span>
                                                    ) : commitSignature.verified === true ? (
                                                      <span className="text-success">signed ⛨</span>
                                                    ) : commitSignature.verified === false ? (
                                                      <span className="text-base-content/70">
                                                        unsigned
                                                      </span>
                                                    ) : (
                                                      <span className="text-base-content/50">
                                                        unknown
                                                      </span>
                                                    )}
                                                  </div>
                                                </div>
                                              </div>
                                              {commitDetails?.coAuthors.length ? (
                                                <div>
                                                  <div className="text-[0.65rem] font-semibold tracking-wide text-base-content/45 uppercase">
                                                    Co-authors
                                                  </div>
                                                  <div className="mt-1 space-y-1 text-base-content/75">
                                                    {commitDetails.coAuthors.map((coAuthor) => (
                                                      <div
                                                        key={`${coAuthor.name}<${coAuthor.email}>`}
                                                        className="wrap-break-word"
                                                      >
                                                        <span>
                                                          {coAuthor.name || "Unknown co-author"}
                                                        </span>
                                                        {coAuthor.email ? (
                                                          <code className="ml-1 font-mono text-[0.7rem] text-base-content/55">
                                                            {`<${coAuthor.email}>`}
                                                          </code>
                                                        ) : null}
                                                      </div>
                                                    ))}
                                                  </div>
                                                </div>
                                              ) : null}
                                              <div className="grid gap-2 text-[0.7rem] text-base-content/65">
                                                <div>
                                                  <div className="font-semibold tracking-wide text-base-content/45 uppercase">
                                                    Parent
                                                  </div>
                                                  {commitDetails?.parentHashes.length ? (
                                                    <div className="mt-1 space-y-1">
                                                      {commitDetails.parentHashes.map(
                                                        (parentHash) => (
                                                          <code
                                                            key={parentHash}
                                                            className="block font-mono wrap-break-word"
                                                          >
                                                            {parentHash}
                                                          </code>
                                                        ),
                                                      )}
                                                    </div>
                                                  ) : (
                                                    <div className="mt-1">None</div>
                                                  )}
                                                </div>
                                                <div>
                                                  <div className="font-semibold tracking-wide text-base-content/45 uppercase">
                                                    Hashes
                                                  </div>
                                                  <div className="mt-1 space-y-1">
                                                    <div>
                                                      <span className="text-base-content/45">
                                                        Short:
                                                      </span>{" "}
                                                      <code className="font-mono">
                                                        {commitDetails?.shortHash ??
                                                          commitBrowseMeta?.shortHash ??
                                                          commitBrowseHash.slice(0, 7)}
                                                      </code>
                                                    </div>
                                                    <div>
                                                      <span className="text-base-content/45">
                                                        Full:
                                                      </span>{" "}
                                                      <code className="font-mono wrap-break-word">
                                                        {commitDetails?.hash ?? commitBrowseHash}
                                                      </code>
                                                    </div>
                                                  </div>
                                                </div>
                                              </div>
                                            </div>
                                          ) : null}
                                        </div>
                                      )}
                                    </div>
                                    <div className="shrink-0 border-b border-base-300/80 px-3 py-2">
                                      <h2 className="m-0 flex flex-wrap items-baseline gap-x-1.5 gap-y-0 text-[0.65rem] font-semibold tracking-wide text-base-content/50 uppercase">
                                        <span>Files</span>
                                        {!commitBrowseLoading ? (
                                          <span className="font-mono text-[0.65rem] font-normal tracking-normal text-base-content/45 normal-case tabular-nums">
                                            ({commitBrowseFiles.length})
                                          </span>
                                        ) : null}
                                      </h2>
                                    </div>
                                    <div className="flex min-h-0 flex-1 flex-col">
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
                                          className="m-0 min-h-0 flex-1 overflow-y-auto"
                                        >
                                          <ul
                                            className="list relative m-0 w-full list-none p-0"
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
                                                  <li
                                                    key={virtualRow.key}
                                                    data-index={virtualRow.index}
                                                    ref={commitBrowseFileVirtualizer.measureElement}
                                                    className="absolute top-0 left-0 m-0 w-full p-0"
                                                    style={{
                                                      transform: `translateY(${virtualRow.start}px)`,
                                                    }}
                                                  >
                                                    <div
                                                      role="button"
                                                      tabIndex={0}
                                                      className={`list-row cursor-pointer rounded-none! px-1! py-2! text-xs leading-snug transition-colors ${
                                                        selected
                                                          ? "bg-primary/10 ring-1 ring-primary/25"
                                                          : "bg-base-200/50 hover:bg-base-300/45 active:bg-base-300/55"
                                                      }`}
                                                      onClick={() => {
                                                        void loadCommitFileDiff(
                                                          entry.path,
                                                          commitBrowseHash ?? "",
                                                        );
                                                      }}
                                                      onKeyDown={(e) => {
                                                        if (e.key !== "Enter" && e.key !== " ")
                                                          return;
                                                        e.preventDefault();
                                                        void loadCommitFileDiff(
                                                          entry.path,
                                                          commitBrowseHash ?? "",
                                                        );
                                                      }}
                                                      onContextMenu={(e) => {
                                                        e.preventDefault();
                                                        e.stopPropagation();
                                                        openFileRowMenu(
                                                          entry.path,
                                                          e.clientX,
                                                          e.clientY,
                                                        );
                                                      }}
                                                    >
                                                      <code
                                                        className="list-col-grow min-w-0 font-mono wrap-break-word"
                                                        title={entry.pathDisplayTitle ?? undefined}
                                                      >
                                                        {entry.pathDisplayDir ? (
                                                          <>
                                                            <span className="text-base-content/45">
                                                              {entry.pathDisplayDir}
                                                            </span>
                                                            <span className="text-base-content">
                                                              {entry.pathDisplayBase}
                                                            </span>
                                                          </>
                                                        ) : (
                                                          <span className="text-base-content">
                                                            {entry.pathDisplayBase}
                                                          </span>
                                                        )}
                                                      </code>
                                                      <DiffLineStatBadge stat={entry.stats} />
                                                    </div>
                                                  </li>
                                                );
                                              })}
                                          </ul>
                                        </div>
                                      )}
                                    </div>
                                  </div>
                                </div>
                              </div>
                            ) : (
                              <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                                {selectedGraphCommitEntries.length > 0 ? (
                                  <div className="mx-3 mt-2 mb-0 flex flex-wrap items-center gap-2 rounded-box border border-base-300/80 bg-base-200/60 px-3 py-2 text-xs text-base-content/75">
                                    <span className="font-medium text-base-content/85">
                                      {selectedGraphCommitEntries.length} commit
                                      {selectedGraphCommitEntries.length === 1 ? "" : "s"} selected
                                    </span>
                                    <span className="text-base-content/55">
                                      Use Cmd/Ctrl-click or Shift-click to adjust the selection.
                                    </span>
                                    {selectedGraphSquashState.reason ? (
                                      <span className="text-warning">
                                        {selectedGraphSquashState.reason}
                                      </span>
                                    ) : null}
                                    <div className="ml-auto flex items-center gap-2">
                                      <button
                                        type="button"
                                        className="btn btn-ghost btn-xs"
                                        onClick={clearGraphCommitSelection}
                                      >
                                        Clear
                                      </button>
                                      <button
                                        type="button"
                                        className="btn btn-xs btn-primary"
                                        disabled={
                                          Boolean(branchBusy) || !selectedGraphSquashState.canSquash
                                        }
                                        onClick={openSquashDialog}
                                      >
                                        Squash selected...
                                      </button>
                                    </div>
                                  </div>
                                ) : null}
                                <CommitGraphSection
                                  commits={deferredGraphDisplayCommits}
                                  graphLayoutDeferredPending={graphLayoutDeferredPending}
                                  commitGraphLayout={commitGraphLayout!}
                                  localBranches={localBranches}
                                  remoteBranches={remoteBranches}
                                  tags={tags}
                                  graphBranchVisible={graphBranchVisible}
                                  remoteGraphDefaultVisible={remoteGraphDefaultsVisible}
                                  currentBranchName={currentBranchName}
                                  currentBranchTipHash={currentBranchTipHash}
                                  activeFirstParentHashes={graphHeadFirstParentHashes}
                                  highlightActiveBranchRows={highlightActiveBranchRows}
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
                                  selectedCommitHashes={selectedGraphCommitHashSet}
                                  onRowCommitSelect={handleGraphRowCommitSelect}
                                  openGraphBranchLocalMenu={openGraphBranchLocalMenu}
                                  openGraphBranchRemoteMenu={openGraphBranchRemoteMenu}
                                  openGraphStashMenu={openGraphStashMenu}
                                  openGraphWipMenu={openGraphWipMenu}
                                  openGraphCommitMenu={openGraphCommitMenu}
                                  openGraphTagMenu={openGraphTagMenu}
                                  pushBusy={pushBusy}
                                  graphAuthorFilter={graphAuthorFilter}
                                  onGraphAuthorFilterChange={setGraphAuthorFilter}
                                  graphDateFrom={graphDateFrom}
                                  graphDateTo={graphDateTo}
                                  onGraphDateFromChange={setGraphDateFrom}
                                  onGraphDateToChange={setGraphDateTo}
                                  graphExportIncludeHash={graphExportIncludeHash}
                                  onGraphExportIncludeHashChange={setGraphExportIncludeHash}
                                  graphExportIncludeMergeCommits={graphExportIncludeMergeCommits}
                                  onGraphExportIncludeMergeCommitsChange={
                                    setGraphExportIncludeMergeCommits
                                  }
                                  graphExportIncludeAuthor={graphExportIncludeAuthor}
                                  onGraphExportIncludeAuthorChange={setGraphExportIncludeAuthor}
                                  graphFiltersActive={graphCommitFiltersActive}
                                  onClearGraphFilters={clearGraphFilters}
                                  onExportGraphCommits={handleExportGraphCommits}
                                  exportGraphCommitsDisabled={graphExportListCommits.length === 0}
                                  onOpenAppSettings={openAppSettings}
                                  wipChangedFileCount={wipChangedFileCount}
                                  onWipSelect={handleSelectWipRow}
                                  graphCommitsPageSize={graphCommitsPageSize}
                                  onGraphCommitsPageSizeChange={handleGraphCommitsPageSizeChange}
                                  graphCommitTitleFontSizePx={graphCommitTitleFontSizePx}
                                  pullActionDisabled={pullActionDisabled}
                                  onPullAction={handleGraphPullAction}
                                  pushActionDisabled={pushActionDisabled}
                                  onPushAction={handleGraphPushAction}
                                  onPushActionContextMenu={openGraphPushActionMenu}
                                  branchActionDisabled={branchActionDisabled}
                                  branchActionTargetLabel={graphToolbarBranchTargetLabel}
                                  onBranchAction={handleGraphBranchAction}
                                  stashActionDisabled={stashActionDisabled}
                                  onStashAction={handleGraphStashAction}
                                  popActionDisabled={popActionDisabled}
                                  latestStashRef={latestStashRef}
                                  onPopAction={handleGraphPopAction}
                                />
                              </div>
                            )}
                          </div>
                        </div>
                      )}
                    </>
                  ) : cloneReadyPath ? (
                    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 py-10">
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

        <aside
          className={`col-span-12 flex min-h-0 min-w-0 lg:col-span-3 lg:h-full lg:min-h-0 ${
            showFullWidthCommitBrowse ? "hidden" : ""
          }`}
        >
          <div className="flex min-h-0 min-w-0 flex-1 flex-col border-base-300 bg-base-100">
            <div className="card-body min-h-0 gap-0 p-0">
              {conflictedFiles.length > 0 ? (
                <section
                  className="flex min-h-0 flex-[0_0_auto] flex-col border-b border-base-300"
                  aria-labelledby="sidebar-conflicts-heading"
                >
                  <div className="flex shrink-0 items-center justify-between gap-2 border-b border-base-300/80 px-3 py-2">
                    <h2
                      id="sidebar-conflicts-heading"
                      className="m-0 min-w-0 flex-1 text-xs font-semibold tracking-wide uppercase opacity-80"
                    >
                      Conflicts ({conflictedFiles.length})
                    </h2>
                  </div>
                  <div className="max-h-52 overflow-y-auto p-2">
                    {!canShowBranches ? (
                      <p className="m-0 py-2 text-center text-xs text-base-content/50">
                        Open a repository to manage conflicts
                      </p>
                    ) : (
                      <ul className="m-0 flex list-none flex-col gap-1 p-0">
                        {conflictedFiles.map((f) => (
                          <ConflictPanelFileRow
                            key={f.path}
                            f={f}
                            selected={selectedDiffPath === f.path && selectedDiffSide === null}
                            onSelect={() => {
                              void loadConflictForFile(f);
                            }}
                          />
                        ))}
                      </ul>
                    )}
                  </div>
                </section>
              ) : null}

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
                    <div className="flex shrink-0 items-center gap-2">
                      <button
                        type="button"
                        className="btn shrink-0 btn-outline btn-xs btn-error"
                        disabled={stageSyncBusy || stageCommitBusy || commitPushBusy}
                        onClick={() => void discardAllUnstagedFiles(unstagedFiles)}
                      >
                        Discard all
                      </button>
                      <button
                        type="button"
                        className="btn shrink-0 btn-outline btn-xs btn-success"
                        disabled={stageSyncBusy || stageCommitBusy || commitPushBusy}
                        onClick={() => void onStageAll()}
                      >
                        Stage all
                      </button>
                    </div>
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
                          busy={
                            stageCommitBusy ||
                            commitPushBusy ||
                            worktreeFileBusy(syncingStagePaths, f)
                          }
                          onSelect={() => void loadDiffForFile(f, "unstaged")}
                          onStage={() => void onStagePaths(worktreeFileMutationPaths(f))}
                          onUnstage={() => void onUnstagePaths(worktreeFileMutationPaths(f))}
                          onFileContextMenu={
                            canShowBranches
                              ? (file, variant, x, y) => {
                                  openFileRowMenu(file.path, x, y, {
                                    source: "worktree",
                                    variant,
                                    renameFrom: file.renameFrom ?? null,
                                  });
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
                          busy={
                            stageCommitBusy ||
                            commitPushBusy ||
                            worktreeFileBusy(syncingStagePaths, f)
                          }
                          onSelect={() => void loadDiffForFile(f, "staged")}
                          onStage={() => void onStagePaths(worktreeFileMutationPaths(f))}
                          onUnstage={() => void onUnstagePaths(worktreeFileMutationPaths(f))}
                          onFileContextMenu={
                            canShowBranches
                              ? (file, variant, x, y) => {
                                  openFileRowMenu(file.path, x, y, {
                                    source: "worktree",
                                    variant,
                                    renameFrom: file.renameFrom ?? null,
                                  });
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
                hasConflictedFiles={hasConflictedFiles}
                stageSyncBusy={stageSyncBusy}
                stageCommitBusy={stageCommitBusy}
                commitPushBusy={commitPushBusy}
                pushBusy={pushBusy}
                repoOperationLabel={repo?.operationState?.label ?? null}
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
      {appSettingsOpen ? (
        <div className="absolute inset-0 z-50 flex min-h-0 flex-col bg-base-200">
          <SettingsPage
            onClose={closeAppSettings}
            themePreference={themePreference}
            onThemePreferenceChange={setThemePreference}
            openaiApiKey={openaiApiKey}
            openaiModel={openaiModel}
            onOpenAiChange={({ apiKey, model }) => {
              setOpenaiApiKey(apiKey);
              setOpenaiModel(model);
            }}
            graphCommitTitleFontSizePx={graphCommitTitleFontSizePx}
            onGraphCommitTitleFontSizeChange={setGraphCommitTitleFontSizePx}
            onError={setOperationError}
          />
        </div>
      ) : null}
    </main>
  );
}
