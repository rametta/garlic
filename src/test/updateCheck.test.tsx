import { ask, message } from "@tauri-apps/plugin-dialog";
import { check } from "@tauri-apps/plugin-updater";
import { waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RestoreLastRepo } from "../gitTypes";
import { renderAppHarness } from "./renderAppHarness";

const emptyStartup: RestoreLastRepo = {
  loadError: null,
  metadata: null,
  localBranches: [],
  remoteBranches: [],
  worktrees: [],
  tags: [],
  stashes: [],
  commits: [],
  graphCommitsHasMore: false,
  workingTreeFiles: [],
  listsError: null,
};

describe("automatic update checks", () => {
  beforeEach(() => {
    vi.mocked(check).mockReset();
    vi.mocked(ask).mockReset();
    vi.mocked(message).mockReset();
    vi.mocked(ask).mockResolvedValue(false);
  });

  it("shows the install popup when an update is available on launch", async () => {
    vi.mocked(check).mockResolvedValue({
      version: "0.2.0",
      body: "A useful improvement.",
      downloadAndInstall: vi.fn(),
    } as unknown as Awaited<ReturnType<typeof check>>);

    renderAppHarness(emptyStartup);

    await waitFor(() => {
      expect(check).toHaveBeenCalledOnce();
      expect(ask).toHaveBeenCalledWith(expect.stringContaining("Garlic 0.2.0 is available."), {
        title: "Update Available",
        kind: "info",
      });
    });
  });

  it("stays quiet when the installed version is current", async () => {
    vi.mocked(check).mockResolvedValue(null);

    renderAppHarness(emptyStartup);

    await waitFor(() => expect(check).toHaveBeenCalledOnce());
    expect(ask).not.toHaveBeenCalled();
    expect(message).not.toHaveBeenCalled();
  });
});
