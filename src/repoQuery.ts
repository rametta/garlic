import { type QueryClient } from "@tanstack/react-query";
import type {
  LocalBranchEntry,
  RemoteBranchEntry,
  StashEntry,
  TagEntry,
  WorktreeEntry,
} from "./repoTypes";
import { invoke } from "./tauriBridgeDebug";
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

export interface RepoListSelection {
  localBranches?: boolean;
  remoteBranches?: boolean;
  worktrees?: boolean;
  tags?: boolean;
  stashes?: boolean;
  workingTreeFiles?: boolean;
}

export const ALL_REPO_LISTS: Required<RepoListSelection> = {
  localBranches: true,
  remoteBranches: true,
  worktrees: true,
  tags: true,
  stashes: true,
  workingTreeFiles: true,
};

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

export function mergeRepoLists(
  snapshot: RepoSnapshot,
  lists: RepoLists,
  selection: RepoListSelection = ALL_REPO_LISTS,
): RepoSnapshot {
  return {
    ...snapshot,
    ...(selection.localBranches !== false ? { localBranches: lists.localBranches } : {}),
    ...(selection.remoteBranches !== false ? { remoteBranches: lists.remoteBranches } : {}),
    ...(selection.worktrees !== false ? { worktrees: lists.worktrees } : {}),
    ...(selection.tags !== false ? { tags: lists.tags } : {}),
    ...(selection.stashes !== false ? { stashes: lists.stashes } : {}),
    ...(selection.workingTreeFiles !== false ? { workingTreeFiles: lists.workingTreeFiles } : {}),
  };
}

export async function loadRepoLists(
  path: string,
  selection: RepoListSelection = ALL_REPO_LISTS,
): Promise<RepoLists> {
  const requested = { ...ALL_REPO_LISTS, ...selection };
  const requests: Promise<unknown>[] = [];

  if (requested.localBranches) {
    requests.push(invoke<LocalBranchEntry[]>("list_local_branches", { path }));
  }
  if (requested.remoteBranches) {
    requests.push(invoke<RemoteBranchEntry[]>("list_remote_branches", { path }));
  }
  if (requested.worktrees) {
    requests.push(invoke<WorktreeEntry[]>("list_worktrees", { path }));
  }
  if (requested.tags) {
    requests.push(invoke<TagEntry[]>("list_tags", { path }));
  }
  if (requested.workingTreeFiles) {
    requests.push(invoke<WorkingTreeFile[]>("list_working_tree_files", { path }));
  }
  if (requested.stashes) {
    requests.push(invoke<StashEntry[]>("list_stashes", { path }));
  }

  const results = await Promise.all(requests);
  let offset = 0;
  const take = <T>(enabled: boolean, fallback: T): T => {
    if (!enabled) return fallback;
    const value = results[offset] as T;
    offset += 1;
    return value;
  };

  return {
    localBranches: take(requested.localBranches, []),
    remoteBranches: take(requested.remoteBranches, []),
    worktrees: take(requested.worktrees, []),
    tags: take(requested.tags, []),
    workingTreeFiles: take(requested.workingTreeFiles, []),
    stashes: take(requested.stashes, []),
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
