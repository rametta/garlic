/**
 * Tree helpers for grouping slash-delimited branch and remote names in the sidebar.
 * Search tags: branch trie, remote trie, grouped sidebar branches, subtree collection.
 */
import type { LocalBranchEntry } from "./repoTypes";

export type BranchTrieNode = {
  branchHere: LocalBranchEntry | null;
  children: Map<string, BranchTrieNode>;
};

export type RemoteTrieNode = {
  refHere: string | null;
  children: Map<string, RemoteTrieNode>;
};

export function collectLocalBranchNamesInSubtree(node: BranchTrieNode): string[] {
  const out: string[] = [];
  if (node.branchHere) {
    out.push(node.branchHere.name);
  }
  for (const child of node.children.values()) {
    out.push(...collectLocalBranchNamesInSubtree(child));
  }
  return out;
}

export function collectRemoteRefsInSubtree(node: RemoteTrieNode): string[] {
  const out: string[] = [];
  if (node.refHere) {
    out.push(node.refHere);
  }
  for (const child of node.children.values()) {
    out.push(...collectRemoteRefsInSubtree(child));
  }
  return out;
}
