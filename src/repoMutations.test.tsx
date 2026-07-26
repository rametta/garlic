import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { describe, expect, it } from "vitest";

import type { RepoMetadata, RepoSnapshot, WorkingTreeFile } from "./gitTypes";
import { useRebaseCurrentBranchOntoMutation } from "./repoMutations";
import { repoQueryKeys } from "./repoQuery";
import { setTauriInvokeHandler } from "./test/tauriTestRuntime";

const path = "/tmp/rebase-conflict";

function metadata(operationState: RepoMetadata["operationState"]): RepoMetadata {
  return {
    path,
    name: "rebase-conflict",
    gitRoot: path,
    error: null,
    branch: "feature",
    headHash: "2222222",
    headShort: "2222222",
    headSubject: "Conflicting commit",
    headAuthor: "Test User",
    detached: false,
    remotes: [],
    workingTreeClean: false,
    ahead: null,
    behind: null,
    operationState,
  };
}

describe("repository mutation reconciliation", () => {
  it("refreshes rebase state when Git stops with a conflict", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const initialSnapshot: RepoSnapshot = {
      metadata: metadata(null),
      localBranches: [],
      remoteBranches: [],
      worktrees: [],
      tags: [],
      stashes: [],
      workingTreeFiles: [],
    };
    const conflictedFile: WorkingTreeFile = {
      path: "conflict.txt",
      pathDisplayDir: null,
      pathDisplayBase: "conflict.txt",
      pathDisplayTitle: null,
      staged: true,
      unstaged: true,
      conflict: {
        statusCode: "UU",
        summary: "Both sides modified this file",
        canChooseOurs: true,
        canChooseTheirs: true,
        oursLabel: "Keep ours",
        theirsLabel: "Keep theirs",
      },
    };
    queryClient.setQueryData(repoQueryKeys.snapshot(path), initialSnapshot);

    setTauriInvokeHandler(async (command) => {
      switch (command) {
        case "rebase_current_branch_onto":
          throw new Error("rebase stopped because of conflicts");
        case "get_repo_metadata":
          return metadata({
            kind: "rebase",
            label: "Rebase in progress (1 of 2)",
            canContinue: true,
            canAbort: true,
            canSkip: true,
          });
        case "list_local_branches":
          return [];
        case "list_working_tree_files":
          return [conflictedFile];
        default:
          throw new Error(`Unexpected command: ${command}`);
      }
    });

    const wrapper = ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useRebaseCurrentBranchOntoMutation(), { wrapper });

    await expect(
      result.current.mutateAsync({ path, onto: "main", interactive: false }),
    ).rejects.toThrow("rebase stopped because of conflicts");

    await waitFor(() => {
      const snapshot = queryClient.getQueryData<RepoSnapshot>(repoQueryKeys.snapshot(path));
      expect(snapshot?.metadata?.operationState?.kind).toBe("rebase");
      expect(snapshot?.workingTreeFiles).toEqual([conflictedFile]);
    });
  });
});
