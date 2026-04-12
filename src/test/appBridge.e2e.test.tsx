import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { getTauriBridgeLogs, clearTauriBridgeLogs } from "../tauriBridgeDebug";
import { createGitBridgeHarness, type GitBridgeHarness } from "./gitBridgeHarness";
import { renderAppHarness } from "./renderAppHarness";
import { emitTauriEvent, setTauriInvokeHandler } from "./tauriTestRuntime";

function bridgeLogsAsc() {
  return [...getTauriBridgeLogs()].sort((a, b) => a.id - b.id);
}

async function waitForInitialBridgeActivity() {
  await waitFor(() => {
    const logs = bridgeLogsAsc();
    expect(logs.map((entry) => entry.command)).toEqual(["start_repo_watch", "list_graph_commits"]);
    expect(logs.every((entry) => entry.status === "success")).toBe(true);
  });
  clearTauriBridgeLogs();
}

function isGraphPageResult(value: unknown): value is { commits: unknown[]; hasMore: boolean } {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { commits?: unknown; hasMore?: unknown };
  return Array.isArray(candidate.commits) && typeof candidate.hasMore === "boolean";
}

function expectGraphReloadResult(result: unknown) {
  expect(isGraphPageResult(result)).toBe(true);
  if (!isGraphPageResult(result)) {
    throw new Error("Expected graph reload result.");
  }
  expect(result.hasMore).toBe(false);
}

const harnessesToCleanup: GitBridgeHarness[] = [];

afterEach(async () => {
  while (harnessesToCleanup.length > 0) {
    const harness = harnessesToCleanup.pop();
    if (!harness) continue;
    await harness.cleanup();
  }
});

describe("App bridge contract", () => {
  it("stages all unstaged files through the bridge against a real git repo", async () => {
    const harness = await createGitBridgeHarness({ withUntrackedFile: true });
    harnessesToCleanup.push(harness);
    setTauriInvokeHandler((command, args) => harness.dispatch(command, args));

    renderAppHarness(await harness.buildStartup());
    await waitForInitialBridgeActivity();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Stage all" }));

    await waitFor(() => {
      const logs = bridgeLogsAsc();
      expect(logs.map((entry) => entry.command)).toEqual(["stage_all", "list_working_tree_files"]);
      expect(logs.every((entry) => entry.status === "success")).toBe(true);
    });

    const [stageAllLog, listFilesLog] = bridgeLogsAsc();
    expect(stageAllLog?.args).toBeUndefined();
    expect(listFilesLog?.args).toEqual({ path: harness.repoPath });
    expect(listFilesLog?.result).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "notes.txt",
          staged: true,
          unstaged: false,
        }),
      ]),
    );
    expect(harness.statusPorcelain()).toContain("A  notes.txt");
  });

  it("creates a local branch from the UI and sends only the expected bridge command", async () => {
    const harness = await createGitBridgeHarness();
    harnessesToCleanup.push(harness);
    setTauriInvokeHandler((command, args) => harness.dispatch(command, args));

    renderAppHarness(await harness.buildStartup());
    await waitForInitialBridgeActivity();

    const user = userEvent.setup();
    emitTauriEvent("new-branch-request", undefined);
    await screen.findByText("New local branch");
    await user.type(screen.getByLabelText("Branch name"), "feature-two");
    await user.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(screen.queryByText("New local branch")).not.toBeInTheDocument();
      const logs = bridgeLogsAsc();
      expect(logs.map((entry) => entry.command)).toEqual(["create_local_branch"]);
      expect(logs.every((entry) => entry.status === "success")).toBe(true);
    });

    const [createBranchLog] = bridgeLogsAsc();
    expect(createBranchLog?.args).toEqual({
      path: harness.repoPath,
      branch: "feature-two",
    });
    expect(createBranchLog?.result).toBeUndefined();
    expect(harness.currentBranch()).toBe("feature-two");
  });

  it("checks out an existing local branch and performs the expected checkout refresh calls", async () => {
    const harness = await createGitBridgeHarness({ withFeatureBranch: true });
    harnessesToCleanup.push(harness);
    setTauriInvokeHandler((command, args) => harness.dispatch(command, args));

    renderAppHarness(await harness.buildStartup());
    await waitForInitialBridgeActivity();

    fireEvent.doubleClick(screen.getByRole("button", { name: /^feature$/ }));

    await waitFor(() => {
      const logs = bridgeLogsAsc();
      expect(logs.map((entry) => entry.command)).toEqual([
        "checkout_local_branch",
        "get_repo_metadata",
        "list_local_branches",
        "list_working_tree_files",
      ]);
      expect(logs.every((entry) => entry.status === "success")).toBe(true);
    });

    const [checkoutLog, metadataLog, branchesLog, filesLog] = bridgeLogsAsc();
    expect(checkoutLog?.args).toEqual({
      path: harness.repoPath,
      branch: "feature",
    });
    expect(metadataLog?.args).toEqual({ path: harness.repoPath });
    expect(metadataLog?.result).toEqual(
      expect.objectContaining({
        path: harness.repoPath,
        branch: "feature",
        detached: false,
      }),
    );
    expect(branchesLog?.result).toEqual([
      expect.objectContaining({ name: "feature" }),
      expect.objectContaining({ name: "main" }),
    ]);
    expect(filesLog?.result).toEqual([]);
    expect(harness.currentBranch()).toBe("feature");
  });

  it("creates a branch at the current graph commit and sends only create_branch_at_commit", async () => {
    const harness = await createGitBridgeHarness();
    harnessesToCleanup.push(harness);
    setTauriInvokeHandler((command, args) => harness.dispatch(command, args));

    renderAppHarness(await harness.buildStartup());
    await waitForInitialBridgeActivity();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Branch" }));
    await screen.findByText("New local branch");
    await user.type(screen.getByLabelText("Branch name"), "graph-branch");
    await user.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(screen.queryByText("New local branch")).not.toBeInTheDocument();
      const logs = bridgeLogsAsc();
      expect(logs.map((entry) => entry.command)).toEqual(["create_branch_at_commit"]);
      expect(logs.every((entry) => entry.status === "success")).toBe(true);
    });

    const [createBranchLog] = bridgeLogsAsc();
    expect(createBranchLog?.args).toEqual({
      path: harness.repoPath,
      branch: "graph-branch",
      commit: harness.git("rev-parse", "HEAD"),
    });
    expect(harness.currentBranch()).toBe("graph-branch");
  });

  it("creates a local branch from a remote-tracking branch and performs checkout refresh", async () => {
    const harness = await createGitBridgeHarness({ withRemoteFeatureBranch: true });
    harnessesToCleanup.push(harness);
    setTauriInvokeHandler((command, args) => harness.dispatch(command, args));

    renderAppHarness(await harness.buildStartup());
    await waitForInitialBridgeActivity();

    fireEvent.doubleClick(screen.getByTitle("origin/feature"));

    await waitFor(() => {
      const logs = bridgeLogsAsc();
      expect(logs.map((entry) => entry.command)).toEqual([
        "create_branch_from_remote",
        "get_repo_metadata",
        "list_local_branches",
        "list_working_tree_files",
        "list_graph_commits",
      ]);
      expect(logs.every((entry) => entry.status === "success")).toBe(true);
    });

    const [createFromRemoteLog, metadataLog, branchesLog, filesLog, graphLog] = bridgeLogsAsc();
    expect(createFromRemoteLog?.args).toEqual({
      path: harness.repoPath,
      remoteRef: "origin/feature",
    });
    expect(metadataLog?.result).toEqual(
      expect.objectContaining({
        path: harness.repoPath,
        branch: "feature",
        detached: false,
      }),
    );
    expect(branchesLog?.result).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "feature" })]),
    );
    expect(filesLog?.result).toEqual([]);
    expectGraphReloadResult(graphLog?.result);
    expect(harness.currentBranch()).toBe("feature");
  });

  it("pulls the current branch and refreshes metadata, branch lists, and worktree", async () => {
    const harness = await createGitBridgeHarness({ withOriginAheadOnMain: true });
    harnessesToCleanup.push(harness);
    setTauriInvokeHandler((command, args) => harness.dispatch(command, args));

    renderAppHarness(await harness.buildStartup());
    await waitForInitialBridgeActivity();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Pull" }));

    await waitFor(() => {
      const logs = bridgeLogsAsc();
      expect(logs.map((entry) => entry.command)).toEqual([
        "pull_local_branch",
        "get_repo_metadata",
        "list_local_branches",
        "list_remote_branches",
        "list_working_tree_files",
        "list_graph_commits",
      ]);
      expect(logs.every((entry) => entry.status === "success")).toBe(true);
    });

    const [pullLog, metadataLog, localBranchesLog, remoteBranchesLog, filesLog, graphLog] =
      bridgeLogsAsc();
    expect(pullLog?.args).toEqual({
      path: harness.repoPath,
      branch: "main",
    });
    expect(metadataLog?.result).toEqual(
      expect.objectContaining({
        path: harness.repoPath,
        branch: "main",
      }),
    );
    expect(localBranchesLog?.result).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "main",
        }),
      ]),
    );
    expect(remoteBranchesLog?.result).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "origin/main",
        }),
      ]),
    );
    expect(filesLog?.result).toEqual([]);
    expectGraphReloadResult(graphLog?.result);
    expect(harness.git("log", "-1", "--format=%s")).toBe("Advance origin main");
  });

  it("stages and unstages a single path with the expected bridge calls", async () => {
    const harness = await createGitBridgeHarness({ withModifiedTrackedFile: true });
    harnessesToCleanup.push(harness);
    setTauriInvokeHandler((command, args) => harness.dispatch(command, args));

    renderAppHarness(await harness.buildStartup());
    await waitForInitialBridgeActivity();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Stage README.md" }));

    await waitFor(() => {
      const logs = bridgeLogsAsc();
      expect(logs.map((entry) => entry.command)).toEqual([
        "stage_paths",
        "list_working_tree_files",
      ]);
      expect(logs.every((entry) => entry.status === "success")).toBe(true);
    });

    let [stageLog, worktreeAfterStageLog] = bridgeLogsAsc();
    expect(stageLog?.args).toEqual({
      path: harness.repoPath,
      paths: ["README.md"],
    });
    expect(worktreeAfterStageLog?.result).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "README.md",
          staged: true,
        }),
      ]),
    );
    expect(harness.statusPorcelain()).toContain("M  README.md");

    clearTauriBridgeLogs();
    await user.click(screen.getByRole("button", { name: "Unstage README.md" }));

    await waitFor(() => {
      const logs = bridgeLogsAsc();
      expect(logs.map((entry) => entry.command)).toEqual([
        "unstage_paths",
        "list_working_tree_files",
      ]);
      expect(logs.every((entry) => entry.status === "success")).toBe(true);
    });

    [stageLog, worktreeAfterStageLog] = bridgeLogsAsc();
    expect(stageLog?.args).toEqual({
      path: harness.repoPath,
      paths: ["README.md"],
    });
    expect(worktreeAfterStageLog?.result).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "README.md",
          staged: false,
          unstaged: true,
        }),
      ]),
    );
    expect(harness.statusPorcelain()).toContain(" M README.md");
  });

  it("commits staged changes and performs the expected post-commit refresh sequence", async () => {
    const harness = await createGitBridgeHarness({ withModifiedTrackedFile: true });
    harnessesToCleanup.push(harness);
    setTauriInvokeHandler((command, args) => harness.dispatch(command, args));

    renderAppHarness(await harness.buildStartup());
    await waitForInitialBridgeActivity();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Stage README.md" }));

    await waitFor(() => {
      const logs = bridgeLogsAsc();
      expect(logs.map((entry) => entry.command)).toEqual([
        "stage_paths",
        "list_working_tree_files",
      ]);
    });

    clearTauriBridgeLogs();
    await user.type(screen.getByPlaceholderText("Title"), "Commit tracked change");
    await user.click(screen.getByRole("button", { name: "Commit" }));

    await waitFor(() => {
      const logs = bridgeLogsAsc();
      expect(logs.map((entry) => entry.command)).toEqual([
        "commit_staged",
        "get_repo_metadata",
        "list_local_branches",
        "list_working_tree_files",
        "list_graph_commits",
      ]);
      expect(logs.every((entry) => entry.status === "success")).toBe(true);
    });

    const [commitLog, metadataLog, localBranchesLog, filesLog, graphLog] = bridgeLogsAsc();
    expect(commitLog?.args).toEqual({
      path: harness.repoPath,
      message: "Commit tracked change",
    });
    expect(metadataLog?.result).toEqual(
      expect.objectContaining({
        path: harness.repoPath,
        branch: "main",
      }),
    );
    expect(localBranchesLog?.result).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "main" })]),
    );
    expect(filesLog?.result).toEqual([]);
    expectGraphReloadResult(graphLog?.result);
    expect(harness.git("log", "-1", "--format=%s")).toBe("Commit tracked change");
  });
});
