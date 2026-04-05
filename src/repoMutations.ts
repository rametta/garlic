import { useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  BranchSidebarSectionsState,
  LocalBranchEntry,
  RemoteBranchEntry,
  TagEntry,
} from "./repoTypes";
import {
  applyOptimisticDiscardPathChange,
  applyOptimisticStageChange,
  clearStagedWorkingTreeFiles,
  type RepoMetadata,
  type RepoSnapshot,
  withWorkingTreeFiles,
} from "./gitTypes";
import { getRepoSnapshot, repoQueryKeys, setRepoSnapshot } from "./repoQuery";
import { invoke } from "./tauriBridgeDebug";

type RepoMutationVariables = {
  path: string;
};

type RepoMutationContext = {
  previousSnapshot?: RepoSnapshot;
};

type RepoMutationOptions<TVariables extends RepoMutationVariables> = {
  mutationFn: (variables: TVariables) => Promise<void>;
  optimisticUpdate?: (snapshot: RepoSnapshot, variables: TVariables) => RepoSnapshot;
  successUpdate?: (snapshot: RepoSnapshot, variables: TVariables) => RepoSnapshot;
  invalidateSnapshotOnSettled?: boolean;
};

function sortByName<T extends { name: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => a.name.localeCompare(b.name));
}

function updateMetadata(
  snapshot: RepoSnapshot,
  updater: (metadata: RepoMetadata) => RepoMetadata,
): RepoSnapshot {
  if (!snapshot.metadata) return snapshot;
  return {
    ...snapshot,
    metadata: updater(snapshot.metadata),
  };
}

function updateLocalBranch(
  snapshot: RepoSnapshot,
  branchName: string,
  updater: (branch: LocalBranchEntry) => LocalBranchEntry,
): RepoSnapshot {
  return {
    ...snapshot,
    localBranches: snapshot.localBranches.map((branch) =>
      branch.name === branchName ? updater(branch) : branch,
    ),
  };
}

function currentBranchName(snapshot: RepoSnapshot): string | null {
  if (!snapshot.metadata || snapshot.metadata.detached) return null;
  return snapshot.metadata.branch ?? null;
}

function withCurrentBranchAhead(snapshot: RepoSnapshot, nextAhead: number | null): RepoSnapshot {
  const branchName = currentBranchName(snapshot);
  let nextSnapshot = snapshot;

  if (branchName) {
    nextSnapshot = updateLocalBranch(snapshot, branchName, (branch) => ({
      ...branch,
      ahead: branch.ahead === null ? branch.ahead : nextAhead,
    }));
  }

  return updateMetadata(nextSnapshot, (metadata) => ({
    ...metadata,
    ahead: metadata.ahead === null ? metadata.ahead : nextAhead,
  }));
}

function withCurrentBranchAheadBumped(snapshot: RepoSnapshot): RepoSnapshot {
  const branchName = currentBranchName(snapshot);
  let nextSnapshot = snapshot;

  if (branchName) {
    nextSnapshot = updateLocalBranch(snapshot, branchName, (branch) => ({
      ...branch,
      ahead: branch.ahead === null ? branch.ahead : branch.ahead + 1,
    }));
  }

  return updateMetadata(nextSnapshot, (metadata) => ({
    ...metadata,
    ahead: metadata.ahead === null ? metadata.ahead : metadata.ahead + 1,
  }));
}

function withCurrentBranchPushedToOrigin(snapshot: RepoSnapshot): RepoSnapshot {
  const branchName = currentBranchName(snapshot);
  const headHash = snapshot.metadata?.headHash?.trim() ?? "";
  if (!branchName) return withCurrentBranchAhead(snapshot, 0);

  const upstreamName = `origin/${branchName}`;
  const localBranches = snapshot.localBranches.map((branch) =>
    branch.name === branchName
      ? {
          ...branch,
          tipHash: headHash || branch.tipHash,
          upstreamName,
          ahead: 0,
          behind: 0,
        }
      : branch,
  );
  const nextRemoteBranch: RemoteBranchEntry = {
    name: upstreamName,
    tipHash: headHash,
  };
  const remoteBranches = headHash
    ? sortByName(
        snapshot.remoteBranches.some((branch) => branch.name === upstreamName)
          ? snapshot.remoteBranches.map((branch) =>
              branch.name === upstreamName ? nextRemoteBranch : branch,
            )
          : snapshot.remoteBranches.concat(nextRemoteBranch),
      )
    : snapshot.remoteBranches;

  return updateMetadata(
    {
      ...snapshot,
      localBranches,
      remoteBranches,
    },
    (metadata) => ({
      ...metadata,
      ahead: metadata.ahead === null ? metadata.ahead : 0,
      behind: metadata.behind === null ? metadata.behind : 0,
    }),
  );
}

function useRepoCommandMutation<TVariables extends RepoMutationVariables>({
  mutationFn,
  optimisticUpdate,
  successUpdate,
  invalidateSnapshotOnSettled = true,
}: RepoMutationOptions<TVariables>) {
  const queryClient = useQueryClient();

  return useMutation<void, unknown, TVariables, RepoMutationContext>({
    mutationFn,
    onMutate: async (variables) => {
      await queryClient.cancelQueries({
        queryKey: repoQueryKeys.root(variables.path),
      });

      const previousSnapshot = getRepoSnapshot(queryClient, variables.path);
      if (previousSnapshot && optimisticUpdate) {
        setRepoSnapshot(queryClient, variables.path, optimisticUpdate(previousSnapshot, variables));
      }

      return { previousSnapshot };
    },
    onError: (_error, variables, context) => {
      if (context?.previousSnapshot) {
        setRepoSnapshot(queryClient, variables.path, context.previousSnapshot);
      }
    },
    onSuccess: (_data, variables) => {
      const snapshot = getRepoSnapshot(queryClient, variables.path);
      if (snapshot && successUpdate) {
        setRepoSnapshot(queryClient, variables.path, successUpdate(snapshot, variables));
      }
    },
    onSettled: (_data, _error, variables) => {
      if (!invalidateSnapshotOnSettled) return;
      void queryClient.invalidateQueries({
        queryKey: repoQueryKeys.root(variables.path),
      });
    },
  });
}

async function invokeRepoMutation(command: string, variables: RepoMutationVariables) {
  await invoke(command, variables);
}

export function useSetBranchSidebarSectionsMutation() {
  return useMutation<void, unknown, { sections: BranchSidebarSectionsState }>({
    mutationFn: async (variables) => {
      await invoke("set_branch_sidebar_sections", variables);
    },
  });
}

export function useSetGraphBranchVisibilityMutation() {
  return useMutation<void, unknown, { path: string; visibility: Record<string, boolean> }>({
    mutationFn: async (variables) => {
      await invoke("set_graph_branch_visibility", variables);
    },
  });
}

export function useSetOpenAiSettingsMutation() {
  return useMutation<void, unknown, { key: string | null; model: string | null }>({
    mutationFn: async (variables) => {
      await invoke("set_openai_settings", variables);
    },
  });
}

export function useSetThemeMutation() {
  return useMutation<void, unknown, string>({
    mutationFn: async (theme) => {
      await invoke("set_theme", { theme });
    },
  });
}

export function useSetGraphCommitTitleFontSizeMutation() {
  return useMutation<void, unknown, number>({
    mutationFn: async (fontSizePx) => {
      await invoke("set_graph_commit_title_font_size", { fontSizePx });
    },
  });
}

export function useStashPushMutation() {
  return useRepoCommandMutation({
    mutationFn: (variables: { path: string; message: string | null }) =>
      invokeRepoMutation("stash_push", variables),
    optimisticUpdate: (snapshot) => withWorkingTreeFiles(snapshot, []),
  });
}

export function useSetRemoteUrlMutation() {
  return useRepoCommandMutation({
    mutationFn: (variables: { path: string; remoteName: string; url: string }) =>
      invokeRepoMutation("set_remote_url", variables),
    optimisticUpdate: (snapshot, variables) =>
      updateMetadata(snapshot, (metadata) => {
        const remotes = metadata.remotes.filter((remote) => remote.name !== variables.remoteName);
        remotes.push({ name: variables.remoteName, fetchUrl: variables.url });
        remotes.sort((a, b) => a.name.localeCompare(b.name));
        return { ...metadata, remotes };
      }),
  });
}

export function usePullLocalBranchMutation() {
  return useRepoCommandMutation({
    mutationFn: (variables: { path: string; branch: string }) =>
      invokeRepoMutation("pull_local_branch", variables),
    optimisticUpdate: (snapshot, variables) => {
      let nextSnapshot = updateLocalBranch(snapshot, variables.branch, (branch) => ({
        ...branch,
        ahead: 0,
        behind: 0,
      }));

      if (currentBranchName(snapshot) === variables.branch) {
        nextSnapshot = updateMetadata(nextSnapshot, (metadata) => ({
          ...metadata,
          ahead: metadata.ahead === null ? metadata.ahead : 0,
          behind: metadata.behind === null ? metadata.behind : 0,
        }));
      }

      return nextSnapshot;
    },
    invalidateSnapshotOnSettled: false,
  });
}

export function useDeleteLocalBranchMutation() {
  return useRepoCommandMutation({
    mutationFn: (variables: { path: string; branch: string; force: boolean }) =>
      invokeRepoMutation("delete_local_branch", variables),
    optimisticUpdate: (snapshot, variables) => ({
      ...snapshot,
      localBranches: snapshot.localBranches.filter((branch) => branch.name !== variables.branch),
    }),
  });
}

export function useDeleteRemoteBranchMutation() {
  return useRepoCommandMutation({
    mutationFn: (variables: { path: string; remoteRef: string }) =>
      invokeRepoMutation("delete_remote_branch", variables),
    optimisticUpdate: (snapshot, variables) => ({
      ...snapshot,
      remoteBranches: snapshot.remoteBranches.filter(
        (branch) => branch.name !== variables.remoteRef,
      ),
    }),
  });
}

export function useRebaseCurrentBranchOntoMutation() {
  return useRepoCommandMutation({
    mutationFn: (variables: { path: string; onto: string; interactive: boolean }) =>
      invokeRepoMutation("rebase_current_branch_onto", variables),
  });
}

export enum ResetMode {
  Soft,
  Hard,
}

/** Matches `ResolveConflictChoice` in `git.rs` (`#[repr(u8)]`). */
export enum ResolveConflictChoice {
  Ours = 0,
  Theirs = 1,
  Both = 2,
}

export function useResetCurrentBranchToCommitMutation() {
  return useRepoCommandMutation({
    mutationFn: (variables: { path: string; commitHash: string; mode: ResetMode }) =>
      invokeRepoMutation("reset_current_branch_to_commit", variables),
  });
}

export function useMergeBranchMutation() {
  return useRepoCommandMutation({
    mutationFn: (variables: { path: string; branchOrRef: string }) =>
      invokeRepoMutation("merge_branch", variables),
  });
}

export function useRemoveWorktreeMutation() {
  return useRepoCommandMutation({
    mutationFn: (variables: { path: string; worktreePath: string; force: boolean }) =>
      invokeRepoMutation("remove_worktree", variables),
    optimisticUpdate: (snapshot, variables) => ({
      ...snapshot,
      worktrees: snapshot.worktrees.filter((worktree) => worktree.path !== variables.worktreePath),
    }),
  });
}

export function useCheckoutLocalBranchMutation() {
  return useRepoCommandMutation({
    mutationFn: (variables: { path: string; branch: string }) =>
      invokeRepoMutation("checkout_local_branch", variables),
    optimisticUpdate: (snapshot, variables) =>
      updateMetadata(snapshot, (metadata) => ({
        ...metadata,
        branch: variables.branch,
        detached: false,
        error: null,
      })),
    invalidateSnapshotOnSettled: false,
  });
}

export function useCreateBranchFromRemoteMutation() {
  return useRepoCommandMutation({
    mutationFn: (variables: { path: string; remoteRef: string }) =>
      invokeRepoMutation("create_branch_from_remote", variables),
    optimisticUpdate: (snapshot, variables) => {
      const slashIndex = variables.remoteRef.indexOf("/");
      const branchName =
        slashIndex >= 0 ? variables.remoteRef.slice(slashIndex + 1) : variables.remoteRef;
      const tipHash =
        snapshot.remoteBranches.find((branch) => branch.name === variables.remoteRef)?.tipHash ??
        snapshot.metadata?.headHash ??
        "";
      const nextBranch: LocalBranchEntry = {
        name: branchName,
        tipHash,
        upstreamName: variables.remoteRef,
        ahead: 0,
        behind: 0,
      };
      return {
        ...snapshot,
        localBranches: sortByName(
          snapshot.localBranches.filter((branch) => branch.name !== branchName).concat(nextBranch),
        ),
      };
    },
  });
}

export function useCherryPickCommitMutation() {
  return useRepoCommandMutation({
    mutationFn: (variables: { path: string; commitHash: string }) =>
      invokeRepoMutation("cherry_pick_commit", variables),
  });
}

export function useDropCommitMutation() {
  return useRepoCommandMutation({
    mutationFn: (variables: { path: string; commitHash: string }) =>
      invokeRepoMutation("drop_commit", variables),
  });
}

export function useSquashCommitsMutation() {
  return useRepoCommandMutation({
    mutationFn: (variables: { path: string; commitHashes: string[]; message: string }) =>
      invokeRepoMutation("squash_commits", variables),
  });
}

export function useDiscardPathChangesMutation() {
  return useRepoCommandMutation({
    mutationFn: (variables: {
      path: string;
      filePath: string;
      fromUnstaged: boolean;
      renameFrom?: string | null;
    }) => invokeRepoMutation("discard_path_changes", variables),
    optimisticUpdate: (snapshot, variables) =>
      withWorkingTreeFiles(
        snapshot,
        applyOptimisticDiscardPathChange(
          snapshot.workingTreeFiles,
          variables.filePath,
          variables.fromUnstaged,
        ),
      ),
    invalidateSnapshotOnSettled: false,
  });
}

export function useDiscardPathsChangesMutation() {
  return useRepoCommandMutation({
    mutationFn: (variables: {
      path: string;
      files: { filePath: string; renameFrom?: string | null }[];
      fromUnstaged: boolean;
    }) => invokeRepoMutation("discard_paths_changes", variables),
    optimisticUpdate: (snapshot, variables) =>
      withWorkingTreeFiles(
        snapshot,
        variables.files.reduce(
          (files, file) =>
            applyOptimisticDiscardPathChange(files, file.filePath, variables.fromUnstaged),
          snapshot.workingTreeFiles,
        ),
      ),
    invalidateSnapshotOnSettled: false,
  });
}

export function usePushTagToOriginMutation() {
  return useRepoCommandMutation({
    mutationFn: (variables: { path: string; tag: string }) =>
      invokeRepoMutation("push_tag_to_origin", variables),
  });
}

export function useCreateBranchAtCommitMutation() {
  return useRepoCommandMutation({
    mutationFn: (variables: { path: string; branch: string; commit: string }) =>
      invokeRepoMutation("create_branch_at_commit", variables),
    optimisticUpdate: (snapshot, variables) => {
      const nextBranch: LocalBranchEntry = {
        name: variables.branch,
        tipHash: variables.commit,
        upstreamName: null,
        ahead: null,
        behind: null,
      };
      return {
        ...snapshot,
        localBranches: sortByName(
          snapshot.localBranches
            .filter((branch) => branch.name !== variables.branch)
            .concat(nextBranch),
        ),
      };
    },
  });
}

export function useCreateLocalBranchMutation() {
  return useRepoCommandMutation({
    mutationFn: (variables: { path: string; branch: string }) =>
      invokeRepoMutation("create_local_branch", variables),
    optimisticUpdate: (snapshot, variables) => {
      const nextBranch: LocalBranchEntry = {
        name: variables.branch,
        tipHash: snapshot.metadata?.headHash ?? "",
        upstreamName: null,
        ahead: null,
        behind: null,
      };
      return {
        ...snapshot,
        localBranches: sortByName(
          snapshot.localBranches
            .filter((branch) => branch.name !== variables.branch)
            .concat(nextBranch),
        ),
      };
    },
  });
}

export function useCreateTagMutation() {
  return useRepoCommandMutation({
    mutationFn: (variables: {
      path: string;
      tag: string;
      commit: string;
      message: string | null;
    }) => invokeRepoMutation("create_tag", variables),
    optimisticUpdate: (snapshot, variables) => {
      const nextTag: TagEntry = {
        name: variables.tag,
        tipHash: variables.commit,
      };
      return {
        ...snapshot,
        tags: sortByName(snapshot.tags.filter((tag) => tag.name !== variables.tag).concat(nextTag)),
      };
    },
  });
}

export function useStashPopMutation() {
  return useRepoCommandMutation({
    mutationFn: (variables: { path: string; stashRef: string }) =>
      invokeRepoMutation("stash_pop", variables),
    optimisticUpdate: (snapshot, variables) => ({
      ...snapshot,
      stashes: snapshot.stashes.filter((stash) => stash.refName !== variables.stashRef),
    }),
  });
}

export function useStashDropMutation() {
  return useRepoCommandMutation({
    mutationFn: (variables: { path: string; stashRef: string }) =>
      invokeRepoMutation("stash_drop", variables),
    optimisticUpdate: (snapshot, variables) => ({
      ...snapshot,
      stashes: snapshot.stashes.filter((stash) => stash.refName !== variables.stashRef),
    }),
  });
}

export function useDeleteTagMutation() {
  return useRepoCommandMutation({
    mutationFn: (variables: { path: string; tag: string }) =>
      invokeRepoMutation("delete_tag", variables),
    optimisticUpdate: (snapshot, variables) => ({
      ...snapshot,
      tags: snapshot.tags.filter((tag) => tag.name !== variables.tag),
    }),
  });
}

export function useDeleteRemoteTagMutation() {
  return useRepoCommandMutation({
    mutationFn: (variables: { path: string; tag: string }) =>
      invokeRepoMutation("delete_remote_tag", variables),
  });
}

export function useStagePathsMutation() {
  return useRepoCommandMutation({
    mutationFn: (variables: { path: string; paths: string[] }) =>
      invokeRepoMutation("stage_paths", variables),
    optimisticUpdate: (snapshot, variables) =>
      withWorkingTreeFiles(
        snapshot,
        applyOptimisticStageChange(snapshot.workingTreeFiles, variables.paths, "stage"),
      ),
    invalidateSnapshotOnSettled: false,
  });
}

export function useUnstagePathsMutation() {
  return useRepoCommandMutation({
    mutationFn: (variables: { path: string; paths: string[] }) =>
      invokeRepoMutation("unstage_paths", variables),
    optimisticUpdate: (snapshot, variables) =>
      withWorkingTreeFiles(
        snapshot,
        applyOptimisticStageChange(snapshot.workingTreeFiles, variables.paths, "unstage"),
      ),
    invalidateSnapshotOnSettled: false,
  });
}

export function useStagePatchMutation() {
  return useRepoCommandMutation({
    mutationFn: (variables: { path: string; patch: string }) =>
      invokeRepoMutation("stage_patch", variables),
    invalidateSnapshotOnSettled: false,
  });
}

export function useUnstagePatchMutation() {
  return useRepoCommandMutation({
    mutationFn: (variables: { path: string; patch: string }) =>
      invokeRepoMutation("unstage_patch", variables),
    invalidateSnapshotOnSettled: false,
  });
}

export function useResolveConflictChoiceMutation() {
  return useRepoCommandMutation({
    mutationFn: (variables: { path: string; filePath: string; choice: ResolveConflictChoice }) =>
      invokeRepoMutation("resolve_conflict_choice", variables),
  });
}

export function useDiscardPatchMutation() {
  return useRepoCommandMutation({
    mutationFn: (variables: { path: string; patch: string }) =>
      invokeRepoMutation("discard_patch", variables),
    invalidateSnapshotOnSettled: false,
  });
}

export function useAmendLastCommitMutation() {
  return useRepoCommandMutation({
    mutationFn: (variables: { path: string; message: string | null }) =>
      invokeRepoMutation("amend_last_commit", variables),
    optimisticUpdate: (snapshot) =>
      withWorkingTreeFiles(snapshot, clearStagedWorkingTreeFiles(snapshot.workingTreeFiles)),
    invalidateSnapshotOnSettled: false,
  });
}

export function useRewordCommitMutation() {
  return useRepoCommandMutation({
    mutationFn: (variables: { path: string; commitHash: string; message: string }) =>
      invokeRepoMutation("reword_commit", variables),
  });
}

export function useCommitStagedMutation() {
  return useRepoCommandMutation({
    mutationFn: (variables: { path: string; message: string }) =>
      invokeRepoMutation("commit_staged", variables),
    optimisticUpdate: (snapshot) =>
      withCurrentBranchAheadBumped(
        withWorkingTreeFiles(snapshot, clearStagedWorkingTreeFiles(snapshot.workingTreeFiles)),
      ),
    invalidateSnapshotOnSettled: false,
  });
}

export function usePushToOriginMutation() {
  return useRepoCommandMutation({
    mutationFn: (variables: { path: string; skipHooks: boolean }) =>
      invokeRepoMutation("push_to_origin", variables),
    optimisticUpdate: (snapshot) => withCurrentBranchAhead(snapshot, 0),
    successUpdate: (snapshot) => withCurrentBranchPushedToOrigin(snapshot),
    invalidateSnapshotOnSettled: false,
  });
}

export function useForcePushToOriginMutation() {
  return useRepoCommandMutation({
    mutationFn: (variables: { path: string; skipHooks: boolean }) =>
      invokeRepoMutation("force_push_to_origin", variables),
    optimisticUpdate: (snapshot) => withCurrentBranchAhead(snapshot, 0),
    successUpdate: (snapshot) => withCurrentBranchPushedToOrigin(snapshot),
    invalidateSnapshotOnSettled: false,
  });
}

export function useContinueRepoOperationMutation() {
  return useRepoCommandMutation({
    mutationFn: (variables: { path: string }) =>
      invokeRepoMutation("continue_repo_operation", variables),
  });
}

export function useAbortRepoOperationMutation() {
  return useRepoCommandMutation({
    mutationFn: (variables: { path: string }) =>
      invokeRepoMutation("abort_repo_operation", variables),
  });
}

export function useSkipRepoOperationMutation() {
  return useRepoCommandMutation({
    mutationFn: (variables: { path: string }) =>
      invokeRepoMutation("skip_repo_operation", variables),
  });
}
