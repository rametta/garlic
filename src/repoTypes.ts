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

/** One stash from `list_stashes` / bootstrap. */
export interface StashEntry {
  refName: string;
  message: string;
}
