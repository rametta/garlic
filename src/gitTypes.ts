/**
 * Shared frontend types and snapshot helpers for repository state returned by Tauri commands.
 * Search tags: repo metadata, working tree files, conflict details, bootstrap snapshot, optimistic updates.
 */
import type {
  CommitEntry,
  LocalBranchEntry,
  RemoteBranchEntry,
  StashEntry,
  TagEntry,
  WireCommitEntry,
  WorktreeEntry,
} from "./repoTypes";
import { normalizeCommitEntries } from "./repoTypes";

export interface RemoteEntry {
  name: string;
  fetchUrl: string;
}

export interface RepoMetadata {
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
  detached: boolean;
  remotes: RemoteEntry[];
  workingTreeClean: boolean | null;
  ahead: number | null;
  behind: number | null;
  operationState?: RepoOperationState | null;
}

/** Line counts from `git diff --numstat` / `--cached` (or file read for untracked). */
export interface LineStat {
  additions: number;
  deletions: number;
  isBinary: boolean;
}

export interface ConflictState {
  statusCode: string;
  summary: string;
  canChooseOurs: boolean;
  canChooseTheirs: boolean;
  oursLabel: string;
  theirsLabel: string;
}

export interface RepoOperationState {
  kind: "merge" | "rebase" | "cherryPick";
  label: string;
  canContinue: boolean;
  canAbort: boolean;
  canSkip: boolean;
}

export interface ConflictVersionPreview {
  label: string;
  deleted: boolean;
  isBinary: boolean;
  text?: string | null;
}

export interface ConflictRange {
  conflictIndex: number;
  startLine: number;
  endLine: number;
  isEmpty: boolean;
}

export interface ConflictRangesBySide {
  ours: ConflictRange[];
  theirs: ConflictRange[];
}

export interface ConflictFileDetails {
  statusCode: string;
  summary: string;
  ours: ConflictVersionPreview;
  theirs: ConflictVersionPreview;
  conflictRanges: ConflictRangesBySide;
  worktreeText?: string | null;
}

/** One path in the working tree from `list_working_tree_files` / bootstrap. */
export interface WorkingTreeFile {
  path: string;
  renameFrom?: string | null;
  staged: boolean;
  unstaged: boolean;
  stagedStats?: LineStat;
  unstagedStats?: LineStat;
  conflict?: ConflictState | null;
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

export interface WireRestoreLastRepo extends Omit<RestoreLastRepo, "commits"> {
  commits: WireCommitEntry[];
}

export interface RepoSnapshot {
  metadata: RepoMetadata | null;
  localBranches: LocalBranchEntry[];
  remoteBranches: RemoteBranchEntry[];
  worktrees: WorktreeEntry[];
  tags: TagEntry[];
  stashes: StashEntry[];
  workingTreeFiles: WorkingTreeFile[];
}

export const EMPTY_REPO_SNAPSHOT: RepoSnapshot = {
  metadata: null,
  localBranches: [],
  remoteBranches: [],
  worktrees: [],
  tags: [],
  stashes: [],
  workingTreeFiles: [],
};

export function repoSnapshotFromStartup(startup: RestoreLastRepo): RepoSnapshot {
  return {
    metadata: startup.metadata ?? null,
    localBranches: startup.localBranches,
    remoteBranches: startup.remoteBranches,
    worktrees: startup.worktrees,
    tags: startup.tags,
    stashes: startup.stashes,
    workingTreeFiles: startup.workingTreeFiles,
  };
}

export function normalizeRestoreLastRepo(startup: WireRestoreLastRepo): RestoreLastRepo {
  return {
    ...startup,
    commits: normalizeCommitEntries(startup.commits),
  };
}

/** Matches `git.rs` clamp for graph commit listing. */
export const GRAPH_COMMITS_PAGE_SIZE_MIN = 10;
export const GRAPH_COMMITS_PAGE_SIZE_MAX = 10000;
export const DEFAULT_GRAPH_COMMITS_PAGE_SIZE = 500;

export function clampGraphCommitsPageSize(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_GRAPH_COMMITS_PAGE_SIZE;
  return Math.min(
    GRAPH_COMMITS_PAGE_SIZE_MAX,
    Math.max(GRAPH_COMMITS_PAGE_SIZE_MIN, Math.round(n)),
  );
}

export function combineLineStats(a?: LineStat, b?: LineStat): LineStat | undefined {
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

export function workingTreeCleanFromFiles(files: readonly WorkingTreeFile[]): boolean {
  return files.every((file) => !file.staged && !file.unstaged && !file.conflict);
}

export function withWorkingTreeFiles(
  snapshot: RepoSnapshot,
  workingTreeFiles: WorkingTreeFile[],
): RepoSnapshot {
  return {
    ...snapshot,
    metadata: snapshot.metadata
      ? {
          ...snapshot.metadata,
          workingTreeClean: workingTreeCleanFromFiles(workingTreeFiles),
        }
      : snapshot.metadata,
    workingTreeFiles,
  };
}

export function applyOptimisticStageChange(
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

export function applyOptimisticDiscardPathChange(
  files: WorkingTreeFile[],
  filePath: string,
  fromUnstaged: boolean,
): WorkingTreeFile[] {
  return files.flatMap((file) => {
    if (file.path !== filePath) return [file];
    if (fromUnstaged) {
      if (!file.staged) return [];
      return [
        {
          ...file,
          unstaged: false,
          unstagedStats: undefined,
        },
      ];
    }
    return [];
  });
}

export function clearStagedWorkingTreeFiles(files: WorkingTreeFile[]): WorkingTreeFile[] {
  return files.flatMap((file) => {
    if (!file.staged) return [file];
    if (!file.unstaged) return [];
    return [
      {
        ...file,
        staged: false,
        stagedStats: undefined,
      },
    ];
  });
}

export function stageAllWorkingTreeFiles(files: WorkingTreeFile[]): WorkingTreeFile[] {
  return files.map((file) => {
    if (!file.unstaged) return file;
    return {
      ...file,
      staged: true,
      unstaged: false,
      stagedStats: combineLineStats(file.stagedStats, file.unstagedStats),
      unstagedStats: undefined,
    };
  });
}
