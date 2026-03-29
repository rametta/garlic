import { type QueryClient } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import type {
  LocalBranchEntry,
  RemoteBranchEntry,
  StashEntry,
  TagEntry,
  WorktreeEntry,
} from "./repoTypes";
import {
  EMPTY_REPO_SNAPSHOT,
  type RepoMetadata,
  type RepoSnapshot,
  type WorkingTreeFile,
} from "./gitTypes";

export interface RepoLists {
  localBranches: LocalBranchEntry[];
  remoteBranches: RemoteBranchEntry[];
  worktrees: WorktreeEntry[];
  tags: TagEntry[];
  stashes: StashEntry[];
  workingTreeFiles: WorkingTreeFile[];
}

export const repoQueryKeys = {
  root: (repoPath: string) => ["repo", repoPath] as const,
  snapshot: (repoPath: string) => ["repo", repoPath, "snapshot"] as const,
};

export function emptyRepoSnapshot(metadata: RepoMetadata | null = null): RepoSnapshot {
  return {
    ...EMPTY_REPO_SNAPSHOT,
    metadata,
  };
}

export function withRepoLists(snapshot: RepoSnapshot, lists: RepoLists): RepoSnapshot {
  return {
    ...snapshot,
    localBranches: lists.localBranches,
    remoteBranches: lists.remoteBranches,
    worktrees: lists.worktrees,
    tags: lists.tags,
    stashes: lists.stashes,
    workingTreeFiles: lists.workingTreeFiles,
  };
}

export async function loadRepoLists(path: string): Promise<RepoLists> {
  const [localBranches, remoteBranches, worktrees, tags, workingTreeFiles, stashes] =
    await Promise.all([
      invoke<LocalBranchEntry[]>("list_local_branches", { path }),
      invoke<RemoteBranchEntry[]>("list_remote_branches", { path }),
      invoke<WorktreeEntry[]>("list_worktrees", { path }),
      invoke<TagEntry[]>("list_tags", { path }),
      invoke<WorkingTreeFile[]>("list_working_tree_files", { path }),
      invoke<StashEntry[]>("list_stashes", { path }),
    ]);

  return {
    localBranches,
    remoteBranches,
    worktrees,
    tags,
    stashes,
    workingTreeFiles,
  };
}

export async function loadRepoSnapshot(path: string): Promise<RepoSnapshot> {
  const metadata = await invoke<RepoMetadata>("get_repo_metadata", { path });
  if (metadata.error) {
    return emptyRepoSnapshot(metadata);
  }
  const lists = await loadRepoLists(path);
  return withRepoLists(emptyRepoSnapshot(metadata), lists);
}

export function getRepoSnapshot(
  queryClient: QueryClient,
  repoPath: string,
): RepoSnapshot | undefined {
  return queryClient.getQueryData<RepoSnapshot>(repoQueryKeys.snapshot(repoPath));
}

export function setRepoSnapshot(
  queryClient: QueryClient,
  repoPath: string,
  snapshot: RepoSnapshot,
) {
  queryClient.setQueryData(repoQueryKeys.snapshot(repoPath), snapshot);
}

export function updateRepoSnapshot(
  queryClient: QueryClient,
  repoPath: string,
  updater: (snapshot: RepoSnapshot) => RepoSnapshot,
) {
  queryClient.setQueryData<RepoSnapshot>(repoQueryKeys.snapshot(repoPath), (previous) =>
    updater(previous ?? emptyRepoSnapshot()),
  );
}
