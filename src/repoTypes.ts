/** One commit row from `list_graph_commits` / bootstrap. */
export interface CommitEntry {
  hash: string;
  shortHash: string;
  subject: string;
  author: string;
  authorEmail: string;
  date: string;
  parentHashes: string[];
  /** Set when this row is a stash WIP commit (`stash@{n}`). */
  stashRef?: string | null;
}

/** Local branch row from `list_local_branches` / bootstrap. */
export interface LocalBranchEntry {
  name: string;
  /** Tip commit OID for this branch. */
  tipHash: string;
  /** Remote-tracking upstream ref (e.g. origin/main); null if not configured. */
  upstreamName: string | null;
  /** Commits on this branch not on upstream; null if no upstream. */
  ahead: number | null;
  /** Commits on upstream not on this branch; null if no upstream. */
  behind: number | null;
}

/** Remote-tracking branch from `list_remote_branches`. */
export interface RemoteBranchEntry {
  name: string;
  tipHash: string;
}

/** Tag from `list_tags` (peeled commit OID for annotated tags). */
export interface TagEntry {
  name: string;
  tipHash: string;
}

/** From `tag_origin_status`: presence of `origin` and whether the tag exists there. */
export type TagOriginStatus = {
  hasOrigin: boolean;
  onOrigin: boolean;
};

/** One stash from `list_stashes` / bootstrap. */
export interface StashEntry {
  refName: string;
  message: string;
  /** Tip commit OID for this stash (W commit). */
  commitHash: string;
}

/** One linked checkout from `list_worktrees`. */
export interface WorktreeEntry {
  path: string;
  branch: string | null;
  headHash: string | null;
  headShort: string | null;
  detached: boolean;
  isCurrent: boolean;
  changedFileCount: number;
  stagedFileCount: number;
  unstagedFileCount: number;
  untrackedFileCount: number;
  lockedReason?: string | null;
  prunableReason?: string | null;
}

/** Which branch-sidebar panels are expanded (persisted in settings.json). */
export type BranchSidebarSectionsState = {
  localOpen: boolean;
  remoteOpen: boolean;
  worktreesOpen: boolean;
  tagsOpen: boolean;
  stashOpen: boolean;
};
