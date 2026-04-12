/**
 * Single source of truth for which repo data to reload after a Git command or external event.
 * Search tags: repo refresh state machine, invalidate snapshot, reload lists.
 */
import type { QueryClient } from "@tanstack/react-query";
import type { RepoMetadata, WorkingTreeFile } from "./gitTypes";
import { withWorkingTreeFiles } from "./gitTypes";
import { invoke } from "./tauriBridgeDebug";
import {
  emptyRepoSnapshot,
  getRepoSnapshot,
  loadRepoLists,
  loadRepoSnapshot,
  mergeRepoLists,
  mergeRepoSnapshotAfterCheckout,
  setRepoSnapshot,
  type RepoListSelection,
} from "./repoQuery";

/** Every `useRepoCommandMutation` registers exactly one op; maps to `planFor` below. */
export const RepoGitRefreshOp = {
  StashPush: "stashPush",
  SetRemoteUrl: "setRemoteUrl",
  PullLocalBranch: "pullLocalBranch",
  DeleteLocalBranch: "deleteLocalBranch",
  DeleteRemoteBranch: "deleteRemoteBranch",
  RebaseCurrentBranchOnto: "rebaseCurrentBranchOnto",
  ResetCurrentBranchToCommit: "resetCurrentBranchToCommit",
  MergeBranch: "mergeBranch",
  RemoveWorktree: "removeWorktree",
  CheckoutLocalBranch: "checkoutLocalBranch",
  CreateBranchFromRemote: "createBranchFromRemote",
  CherryPickCommit: "cherryPickCommit",
  DropCommit: "dropCommit",
  SquashCommits: "squashCommits",
  DiscardPathChanges: "discardPathChanges",
  DiscardPathsChanges: "discardPathsChanges",
  PushTagToOrigin: "pushTagToOrigin",
  CreateBranchAtCommit: "createBranchAtCommit",
  CreateLocalBranch: "createLocalBranch",
  CreateTag: "createTag",
  StashPop: "stashPop",
  StashDrop: "stashDrop",
  DeleteTag: "deleteTag",
  DeleteRemoteTag: "deleteRemoteTag",
  StagePaths: "stagePaths",
  StageAll: "stageAll",
  UnstagePaths: "unstagePaths",
  StagePatch: "stagePatch",
  UnstagePatch: "unstagePatch",
  ResolveConflictChoice: "resolveConflictChoice",
  ResolveConflictText: "resolveConflictText",
  DiscardPatch: "discardPatch",
  AmendLastCommit: "amendLastCommit",
  RewordCommit: "rewordCommit",
  CommitStaged: "commitStaged",
  PushToOrigin: "pushToOrigin",
  ForcePushToOrigin: "forcePushToOrigin",
  ContinueRepoOperation: "continueRepoOperation",
  AbortRepoOperation: "abortRepoOperation",
  SkipRepoOperation: "skipRepoOperation",
} as const;

export type RepoGitRefreshOp = (typeof RepoGitRefreshOp)[keyof typeof RepoGitRefreshOp];

export type RepoRefreshPlan =
  | { kind: "none" }
  | { kind: "checkout" }
  | { kind: "full" }
  | { kind: "metadataOnly" }
  | { kind: "lists"; metadata: boolean; selection: RepoListSelection };

const WORKTREE_ONLY: RepoListSelection = {
  localBranches: false,
  remoteBranches: false,
  worktrees: false,
  tags: false,
  stashes: false,
  workingTreeFiles: true,
};

const LOCAL_BRANCHES_ONLY: RepoListSelection = {
  localBranches: true,
  remoteBranches: false,
  worktrees: false,
  tags: false,
  stashes: false,
  workingTreeFiles: false,
};

const REMOTE_BRANCHES_ONLY: RepoListSelection = {
  localBranches: false,
  remoteBranches: true,
  worktrees: false,
  tags: false,
  stashes: false,
  workingTreeFiles: false,
};

const WORKTREES_ONLY: RepoListSelection = {
  localBranches: false,
  remoteBranches: false,
  worktrees: true,
  tags: false,
  stashes: false,
  workingTreeFiles: false,
};

const TAGS_ONLY: RepoListSelection = {
  localBranches: false,
  remoteBranches: false,
  worktrees: false,
  tags: true,
  stashes: false,
  workingTreeFiles: false,
};

const STASHES_AND_WORKTREE: RepoListSelection = {
  localBranches: false,
  remoteBranches: false,
  worktrees: false,
  tags: false,
  stashes: true,
  workingTreeFiles: true,
};

const LOCAL_REMOTE_BRANCHES_ONLY: RepoListSelection = {
  localBranches: true,
  remoteBranches: true,
  worktrees: false,
  tags: false,
  stashes: false,
  workingTreeFiles: false,
};

const LOCAL_BRANCHES_AND_WORKTREE: RepoListSelection = {
  localBranches: true,
  remoteBranches: false,
  worktrees: false,
  tags: false,
  stashes: false,
  workingTreeFiles: true,
};

const METADATA_AND_WORKTREE: RepoListSelection = {
  localBranches: false,
  remoteBranches: false,
  worktrees: false,
  tags: false,
  stashes: false,
  workingTreeFiles: true,
};

const LOCAL_REMOTE_BRANCHES_AND_WORKTREE: RepoListSelection = {
  localBranches: true,
  remoteBranches: true,
  worktrees: false,
  tags: false,
  stashes: false,
  workingTreeFiles: true,
};

function headMatchesCommit(metadata: RepoMetadata | null | undefined, commit: string): boolean {
  const h = metadata?.headHash?.trim();
  const c = commit.trim();
  if (!h || !c) return false;
  return h === c || h.startsWith(c) || c.startsWith(h);
}

type PlanContext<TVariables extends { path: string } = { path: string }> = {
  queryClient: QueryClient;
  variables: TVariables;
};

/**
 * Deterministic refresh plan after a Git command. Prefer the smallest repo slice that can fully
 * reconcile the UI for that operation; reserve `full` for exceptional cases only.
 */
export function planFor<TVariables extends { path: string }>(
  op: RepoGitRefreshOp,
  ctx: PlanContext<TVariables>,
): RepoRefreshPlan {
  switch (op) {
    case RepoGitRefreshOp.PullLocalBranch:
      return { kind: "lists", metadata: true, selection: LOCAL_REMOTE_BRANCHES_AND_WORKTREE };

    case RepoGitRefreshOp.DeleteLocalBranch:
      return { kind: "lists", metadata: false, selection: LOCAL_BRANCHES_ONLY };

    case RepoGitRefreshOp.DeleteRemoteBranch:
      return { kind: "lists", metadata: true, selection: REMOTE_BRANCHES_ONLY };

    case RepoGitRefreshOp.RebaseCurrentBranchOnto:
    case RepoGitRefreshOp.ResetCurrentBranchToCommit:
    case RepoGitRefreshOp.MergeBranch:
    case RepoGitRefreshOp.CherryPickCommit:
    case RepoGitRefreshOp.DropCommit:
    case RepoGitRefreshOp.SquashCommits:
    case RepoGitRefreshOp.AmendLastCommit:
    case RepoGitRefreshOp.RewordCommit:
    case RepoGitRefreshOp.CommitStaged:
    case RepoGitRefreshOp.ContinueRepoOperation:
    case RepoGitRefreshOp.AbortRepoOperation:
    case RepoGitRefreshOp.SkipRepoOperation:
      return { kind: "lists", metadata: true, selection: LOCAL_BRANCHES_AND_WORKTREE };

    case RepoGitRefreshOp.RemoveWorktree:
      return { kind: "lists", metadata: false, selection: WORKTREES_ONLY };

    case RepoGitRefreshOp.SetRemoteUrl:
      return { kind: "metadataOnly" };

    case RepoGitRefreshOp.CheckoutLocalBranch:
    case RepoGitRefreshOp.CreateBranchFromRemote:
      return { kind: "checkout" };

    case RepoGitRefreshOp.CreateLocalBranch:
      return { kind: "none" };

    case RepoGitRefreshOp.CreateBranchAtCommit: {
      const v = ctx.variables as unknown as { path: string; commit: string };
      const snap = getRepoSnapshot(ctx.queryClient, v.path);
      if (!snap?.metadata) return { kind: "full" };
      if (headMatchesCommit(snap.metadata, v.commit)) return { kind: "none" };
      return { kind: "checkout" };
    }

    case RepoGitRefreshOp.CreateTag:
    case RepoGitRefreshOp.DeleteTag:
      return { kind: "lists", metadata: false, selection: TAGS_ONLY };

    case RepoGitRefreshOp.PushTagToOrigin:
    case RepoGitRefreshOp.DeleteRemoteTag:
      return { kind: "none" };

    case RepoGitRefreshOp.StashPush:
    case RepoGitRefreshOp.StashPop:
    case RepoGitRefreshOp.StashDrop:
      return { kind: "lists", metadata: true, selection: STASHES_AND_WORKTREE };

    case RepoGitRefreshOp.ResolveConflictChoice:
    case RepoGitRefreshOp.ResolveConflictText:
      return { kind: "lists", metadata: true, selection: METADATA_AND_WORKTREE };

    case RepoGitRefreshOp.PushToOrigin:
    case RepoGitRefreshOp.ForcePushToOrigin:
      return { kind: "lists", metadata: true, selection: LOCAL_REMOTE_BRANCHES_ONLY };

    case RepoGitRefreshOp.DiscardPathChanges:
    case RepoGitRefreshOp.DiscardPathsChanges:
    case RepoGitRefreshOp.StagePaths:
    case RepoGitRefreshOp.StageAll:
    case RepoGitRefreshOp.UnstagePaths:
    case RepoGitRefreshOp.StagePatch:
    case RepoGitRefreshOp.UnstagePatch:
    case RepoGitRefreshOp.DiscardPatch:
      return { kind: "lists", metadata: false, selection: WORKTREE_ONLY };
  }
}

let gitOperationDepth = 0;

export function beginGitOperation(): void {
  gitOperationDepth += 1;
}

export function endGitOperation(): void {
  gitOperationDepth = Math.max(0, gitOperationDepth - 1);
}

export function isGitOperationInFlight(): boolean {
  return gitOperationDepth > 0;
}

export async function applyRepoRefreshPlan(
  queryClient: QueryClient,
  path: string,
  plan: RepoRefreshPlan,
): Promise<void> {
  switch (plan.kind) {
    case "none":
      return;
    case "checkout":
      await mergeRepoSnapshotAfterCheckout(queryClient, path);
      return;
    case "full": {
      const snapshot = await loadRepoSnapshot(path);
      setRepoSnapshot(queryClient, path, snapshot);
      return;
    }
    case "metadataOnly": {
      const prev = getRepoSnapshot(queryClient, path);
      const meta: RepoMetadata = await invoke<RepoMetadata>("get_repo_metadata", { path });
      if (!prev) return;
      if (meta.error) {
        setRepoSnapshot(queryClient, path, emptyRepoSnapshot(meta));
        return;
      }
      setRepoSnapshot(queryClient, path, { ...prev, metadata: meta });
      return;
    }
    case "lists": {
      const prev = getRepoSnapshot(queryClient, path);
      if (!prev) return;
      if (plan.metadata) {
        const [metadataResult, lists] = await Promise.all([
          invoke<RepoMetadata>("get_repo_metadata", { path }),
          loadRepoLists(path, plan.selection),
        ]);
        if (metadataResult.error) {
          setRepoSnapshot(queryClient, path, emptyRepoSnapshot(metadataResult));
          return;
        }
        const merged = mergeRepoLists({ ...prev, metadata: metadataResult }, lists, plan.selection);
        setRepoSnapshot(queryClient, path, merged);
      } else {
        const lists = await loadRepoLists(path, plan.selection);
        let merged = mergeRepoLists(prev, lists, plan.selection);
        if (plan.selection.workingTreeFiles !== false) {
          merged = withWorkingTreeFiles(merged, lists.workingTreeFiles);
        }
        setRepoSnapshot(queryClient, path, merged);
      }
      return;
    }
    default: {
      const _exhaustive: never = plan;
      return _exhaustive;
    }
  }
}

/** Window focus: working tree only (matches prior `fromFocus` behavior). */
export async function applyFocusWorktreeRefresh(
  queryClient: QueryClient,
  path: string,
): Promise<WorkingTreeFile[]> {
  const files = await invoke<WorkingTreeFile[]>("list_working_tree_files", { path });
  const prev = getRepoSnapshot(queryClient, path);
  if (!prev) return files;
  const merged = withWorkingTreeFiles({ ...prev, workingTreeFiles: files }, files);
  setRepoSnapshot(queryClient, path, merged);
  return files;
}

export type WatcherPreviousHead = {
  branch: string | null;
  detached: boolean;
  headHash: string | null;
  ahead: number | null;
  behind: number | null;
};

const WATCHER_WIDE_LISTS: RepoListSelection = {
  localBranches: true,
  remoteBranches: true,
  worktrees: false,
  tags: false,
  stashes: false,
  workingTreeFiles: true,
};

/**
 * Filesystem / debounced watcher: metadata first, then narrow vs wide list reload.
 * Returns updated files (if any list load ran) and whether branch context changed.
 */
export async function applyFilesystemWatcherRepoRefresh(
  queryClient: QueryClient,
  path: string,
  previous: WatcherPreviousHead,
): Promise<{ files: WorkingTreeFile[] | null; branchContextChanged: boolean }> {
  const meta = await invoke<RepoMetadata>("get_repo_metadata", { path });
  const prevSnap = getRepoSnapshot(queryClient, path);
  if (!prevSnap) {
    return { files: null, branchContextChanged: false };
  }

  setRepoSnapshot(queryClient, path, { ...prevSnap, metadata: meta });

  if (meta.error) {
    return { files: null, branchContextChanged: false };
  }

  const branchContextChanged =
    meta.branch !== previous.branch || meta.detached !== previous.detached;
  const headChanged = (meta.headHash ?? null) !== previous.headHash;
  const upstreamCountsChanged =
    (meta.ahead ?? null) !== previous.ahead || (meta.behind ?? null) !== previous.behind;

  if (!branchContextChanged && !headChanged && !upstreamCountsChanged) {
    const lists = await loadRepoLists(path, WORKTREE_ONLY);
    const merged = mergeRepoLists({ ...prevSnap, metadata: meta }, lists, WORKTREE_ONLY);
    const withClean = withWorkingTreeFiles(merged, lists.workingTreeFiles);
    setRepoSnapshot(queryClient, path, withClean);
    return { files: lists.workingTreeFiles, branchContextChanged: false };
  }

  const lists = await loadRepoLists(path, WATCHER_WIDE_LISTS);
  const merged = mergeRepoLists({ ...prevSnap, metadata: meta }, lists, WATCHER_WIDE_LISTS);
  setRepoSnapshot(queryClient, path, merged);
  return { files: lists.workingTreeFiles, branchContextChanged };
}
