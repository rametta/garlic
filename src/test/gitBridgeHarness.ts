import { execFileSync } from "node:child_process";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RepoMetadata, RestoreLastRepo, WorkingTreeFile } from "../gitTypes";
import { normalizeCommitEntries } from "../repoTypes";
import type {
  LocalBranchEntry,
  RemoteBranchEntry,
  StashEntry,
  TagEntry,
  WireCommitEntry,
  WorktreeEntry,
} from "../repoTypes";

type GraphCommitsArgs = {
  path: string;
  hiddenRefs?: string[];
  skip?: number;
  pageSize?: number;
};

type PathArgs = {
  path: string;
};

type CreateBranchArgs = {
  path: string;
  branch: string;
};

type CreateBranchAtCommitArgs = CreateBranchArgs & {
  commit: string;
};

type CreateBranchFromRemoteArgs = PathArgs & {
  remoteRef: string;
};

type StagePathsArgs = PathArgs & {
  paths: string[];
};

type CommitStagedArgs = PathArgs & {
  message: string;
};

type PullLocalBranchArgs = PathArgs & {
  branch: string;
};

export interface GitBridgeHarness {
  repoPath: string;
  dispatch(command: string, args?: unknown): Promise<unknown>;
  buildStartup(): Promise<RestoreLastRepo>;
  cleanup(): Promise<void>;
  git(...args: string[]): string;
  currentBranch(): string;
  statusPorcelain(): string;
}

export async function createGitBridgeHarness(options?: {
  withFeatureBranch?: boolean;
  withUntrackedFile?: boolean;
  withModifiedTrackedFile?: boolean;
  withOrigin?: boolean;
  withRemoteFeatureBranch?: boolean;
  withOriginAheadOnMain?: boolean;
}): Promise<GitBridgeHarness> {
  const cleanupRoots: string[] = [];
  const repoPath = await mkdtemp(path.join(tmpdir(), "garlic-bridge-e2e-"));
  cleanupRoots.push(repoPath);
  let activeRepoPath: string | null = repoPath;

  const git = (...args: string[]): string =>
    execFileSync("git", args, {
      cwd: repoPath,
      encoding: "utf8",
    }).trimEnd();

  git("init");
  configureTestGitIdentity(repoPath);

  await writeFile(path.join(repoPath, "README.md"), "# Garlic test repo\n");
  git("add", "README.md");
  git("commit", "-m", "Initial commit");
  git("branch", "-M", "main");

  if (options?.withFeatureBranch) {
    git("branch", "feature");
  }

  if (options?.withOrigin || options?.withRemoteFeatureBranch || options?.withOriginAheadOnMain) {
    const originRoot = await mkdtemp(path.join(tmpdir(), "garlic-bridge-origin-"));
    cleanupRoots.push(originRoot);
    const originPath = path.join(originRoot, "origin.git");
    runGit(originRoot, ["init", "--bare", "origin.git"]);

    git("remote", "add", "origin", originPath);
    git("push", "-u", "origin", "main");

    if (options?.withRemoteFeatureBranch || options?.withOriginAheadOnMain) {
      const peerRoot = await mkdtemp(path.join(tmpdir(), "garlic-bridge-peer-"));
      cleanupRoots.push(peerRoot);
      const peerPath = path.join(peerRoot, "work");
      runGit(peerRoot, ["clone", originPath, "work"]);
      configureTestGitIdentity(peerPath);

      if (options?.withRemoteFeatureBranch) {
        runGit(peerPath, ["switch", "-c", "feature"]);
        await writeFile(path.join(peerPath, "feature.txt"), "remote feature branch\n");
        runGit(peerPath, ["add", "feature.txt"]);
        runGit(peerPath, ["commit", "-m", "Add remote feature branch"]);
        runGit(peerPath, ["push", "-u", "origin", "feature"]);
      }

      if (options?.withOriginAheadOnMain) {
        runGit(peerPath, ["switch", "main"]);
        await writeFile(path.join(peerPath, "REMOTE.md"), "upstream update\n");
        runGit(peerPath, ["add", "REMOTE.md"]);
        runGit(peerPath, ["commit", "-m", "Advance origin main"]);
        runGit(peerPath, ["push", "origin", "main"]);
      }
    }

    git("fetch", "--all");
  }

  if (options?.withModifiedTrackedFile) {
    await appendFile(path.join(repoPath, "README.md"), "local tracked change\n");
  }

  if (options?.withUntrackedFile) {
    await writeFile(path.join(repoPath, "notes.txt"), "work in progress\n");
  }

  async function cleanup() {
    await Promise.all(
      cleanupRoots.map((root) =>
        rm(root, {
          recursive: true,
          force: true,
        }),
      ),
    );
  }

  function currentBranch(): string {
    return git("branch", "--show-current");
  }

  function statusPorcelain(): string {
    return git("status", "--porcelain=v1", "--untracked-files=all");
  }

  async function buildStartup(): Promise<RestoreLastRepo> {
    const metadata = getRepoMetadata(repoPath);
    const localBranches = listLocalBranches(repoPath);
    const remoteBranches = listRemoteBranches(repoPath);
    const worktrees: WorktreeEntry[] = [];
    const tags = listTags(repoPath);
    const stashes = listStashes(repoPath);
    const graphPage = listGraphCommits({
      path: repoPath,
      hiddenRefs: [],
      skip: 0,
      pageSize: 500,
    });

    return {
      loadError: null,
      metadata,
      localBranches,
      remoteBranches,
      worktrees,
      tags,
      stashes,
      commits: normalizeCommitEntries(graphPage.commits),
      graphCommitsHasMore: graphPage.hasMore,
      workingTreeFiles: listWorkingTreeFiles(repoPath),
      listsError: null,
    };
  }

  async function dispatch(command: string, args?: unknown): Promise<unknown> {
    switch (command) {
      case "start_repo_watch": {
        activeRepoPath = getPathArg(args);
        return undefined;
      }
      case "list_graph_commits":
        return listGraphCommits(args as GraphCommitsArgs);
      case "stage_all": {
        const targetPath = activeRepoPath ?? repoPath;
        runGit(targetPath, ["add", "-A"]);
        return undefined;
      }
      case "stage_paths": {
        const { path: targetPath, paths } = args as StagePathsArgs;
        if (paths.length > 0) {
          runGit(targetPath, ["add", "--", ...paths]);
        }
        return undefined;
      }
      case "unstage_paths": {
        const { path: targetPath, paths } = args as StagePathsArgs;
        if (paths.length > 0) {
          runGit(targetPath, ["restore", "--staged", "--", ...paths]);
        }
        return undefined;
      }
      case "commit_staged": {
        const { path: targetPath, message } = args as CommitStagedArgs;
        runGit(targetPath, ["commit", "-m", message]);
        return undefined;
      }
      case "list_working_tree_files":
        return listWorkingTreeFiles(getPathArg(args));
      case "create_local_branch": {
        const { path: targetPath, branch } = args as CreateBranchArgs;
        runGit(targetPath, ["switch", "-c", branch]);
        activeRepoPath = targetPath;
        return undefined;
      }
      case "create_branch_at_commit": {
        const { path: targetPath, branch, commit } = args as CreateBranchAtCommitArgs;
        runGit(targetPath, ["switch", "-c", branch, commit]);
        activeRepoPath = targetPath;
        return undefined;
      }
      case "create_branch_from_remote": {
        const { path: targetPath, remoteRef } = args as CreateBranchFromRemoteArgs;
        const slashIndex = remoteRef.indexOf("/");
        const localName = slashIndex >= 0 ? remoteRef.slice(slashIndex + 1) : remoteRef;
        runGit(targetPath, ["switch", "-c", localName, remoteRef]);
        activeRepoPath = targetPath;
        return undefined;
      }
      case "checkout_local_branch": {
        const { path: targetPath, branch } = args as CreateBranchArgs;
        runGit(targetPath, ["switch", branch]);
        activeRepoPath = targetPath;
        return undefined;
      }
      case "pull_local_branch": {
        const { path: targetPath, branch } = args as PullLocalBranchArgs;
        pullLocalBranch(targetPath, branch);
        return undefined;
      }
      case "get_repo_metadata":
        return getRepoMetadata(getPathArg(args));
      case "list_local_branches":
        return listLocalBranches(getPathArg(args));
      case "list_remote_branches":
        return listRemoteBranches(getPathArg(args));
      default:
        throw new Error(`Unhandled Tauri bridge command in test harness: ${command}`);
    }
  }

  return {
    repoPath,
    dispatch,
    buildStartup,
    cleanup,
    git,
    currentBranch,
    statusPorcelain,
  };
}

function getPathArg(args: unknown): string {
  if (!args || typeof args !== "object" || !("path" in args)) {
    throw new Error("Expected path-scoped Tauri invoke args.");
  }
  const { path } = args as PathArgs;
  if (!path) {
    throw new Error("Expected non-empty repo path.");
  }
  return path;
}

function runGit(repoPath: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: repoPath,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trimEnd();
}

function configureTestGitIdentity(repoPath: string) {
  runGit(repoPath, ["config", "user.name", "Garlic Test"]);
  runGit(repoPath, ["config", "user.email", "garlic@example.com"]);
}

function tryRunGit(repoPath: string, args: string[]): string | null {
  try {
    return runGit(repoPath, args);
  } catch {
    return null;
  }
}

function getRepoMetadata(repoPath: string): RepoMetadata {
  const gitRoot = runGit(repoPath, ["rev-parse", "--show-toplevel"]);
  const branch = runGit(repoPath, ["branch", "--show-current"]) || null;
  const headHash = runGit(repoPath, ["rev-parse", "HEAD"]);
  const headShort = runGit(repoPath, ["rev-parse", "--short", "HEAD"]);
  const headSubject = runGit(repoPath, ["log", "-1", "--format=%s"]);
  const headAuthor = runGit(repoPath, ["log", "-1", "--format=%an"]);
  const remotes = runGit(repoPath, ["remote"])
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((name) => ({
      name,
      fetchUrl: runGit(repoPath, ["remote", "get-url", name]),
    }));
  const upstream = branch
    ? tryRunGit(repoPath, ["rev-parse", "--abbrev-ref", `${branch}@{upstream}`])
    : null;
  const counts = upstream
    ? runGit(repoPath, ["rev-list", "--left-right", "--count", `${upstream}...HEAD`]).split("\t")
    : null;
  const behind = counts ? Number.parseInt(counts[0] ?? "0", 10) : null;
  const ahead = counts ? Number.parseInt(counts[1] ?? "0", 10) : null;

  return {
    path: repoPath,
    name: path.basename(repoPath),
    gitRoot,
    error: null,
    branch,
    headHash,
    headShort,
    headSubject,
    headAuthor,
    detached: branch === null,
    remotes,
    workingTreeClean: listWorkingTreeFiles(repoPath).length === 0,
    ahead,
    behind,
    operationState: null,
  };
}

function listLocalBranches(repoPath: string): LocalBranchEntry[] {
  const output = runGit(repoPath, [
    "for-each-ref",
    "--sort=refname",
    "--format=%(refname:short)\t%(objectname)\t%(upstream:short)",
    "refs/heads",
  ]);

  if (!output.trim()) return [];

  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, tipHash, upstreamName] = line.split("\t");
      const counts = upstreamName
        ? runGit(repoPath, [
            "rev-list",
            "--left-right",
            "--count",
            `${upstreamName}...${name}`,
          ]).split("\t")
        : null;
      return {
        name,
        tipHash,
        upstreamName: upstreamName || null,
        ahead: counts ? Number.parseInt(counts[1] ?? "0", 10) : null,
        behind: counts ? Number.parseInt(counts[0] ?? "0", 10) : null,
      };
    });
}

function listRemoteBranches(repoPath: string): RemoteBranchEntry[] {
  const output = runGit(repoPath, [
    "for-each-ref",
    "--sort=refname",
    "--format=%(refname:short)\t%(objectname)",
    "refs/remotes",
  ]);

  if (!output.trim()) return [];

  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, tipHash] = line.split("\t");
      return { name, tipHash };
    })
    .filter((branch) => !branch.name.endsWith("/HEAD"));
}

function listTags(repoPath: string): TagEntry[] {
  const output = runGit(repoPath, [
    "for-each-ref",
    "--sort=refname",
    "--format=%(refname:short)\t%(*objectname)\t%(objectname)",
    "refs/tags",
  ]);

  if (!output.trim()) return [];

  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, peeledHash, directHash] = line.split("\t");
      return {
        name,
        tipHash: peeledHash || directHash,
      };
    });
}

function listStashes(repoPath: string): StashEntry[] {
  const output = runGit(repoPath, ["stash", "list", "--format=%gd%x1f%gs%x1f%H"]);
  if (!output.trim()) return [];

  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [refName, message, commitHash] = line.split("\u001f");
      return { refName, message, commitHash };
    });
}

function listWorkingTreeFiles(repoPath: string): WorkingTreeFile[] {
  const output = runGit(repoPath, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (!output.trim()) return [];

  return output
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const xy = line.slice(0, 2);
      const rawPath = line.slice(3);
      const filePath = rawPath.includes(" -> ") ? (rawPath.split(" -> ")[1] ?? rawPath) : rawPath;
      const parsedPath = path.parse(filePath);

      return {
        path: filePath,
        pathDisplayDir: parsedPath.dir ? `${parsedPath.dir}/` : null,
        pathDisplayBase: parsedPath.base,
        pathDisplayTitle: filePath,
        staged: xy[0] !== " " && xy[0] !== "?",
        unstaged: xy[1] !== " " || xy === "??",
        conflict: null,
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}

function listGraphCommits(args: GraphCommitsArgs): {
  commits: WireCommitEntry[];
  hasMore: boolean;
} {
  const skip = args.skip ?? 0;
  const pageSize = args.pageSize ?? 500;
  const output = runGit(args.path, [
    "log",
    "--date-order",
    `--skip=${skip}`,
    `--max-count=${pageSize + 1}`,
    "--format=%H%x1f%h%x1f%s%x1f%an%x1f%ae%x1f%at%x1f%P%x1e",
  ]);

  const rows = output
    .split("\u001e")
    .map((row) => row.trim())
    .filter(Boolean);

  const hasMore = rows.length > pageSize;
  const pageRows = rows.slice(0, pageSize);
  const commits: WireCommitEntry[] = pageRows.map((row) => {
    const [hash, shortHash, subject, author, authorEmail, authorTime, parentsRaw] =
      row.split("\u001f");
    const parents = parentsRaw ? parentsRaw.split(" ").filter(Boolean) : [];
    const [firstParent, ...extraParents] = parents;
    return {
      hash,
      shortHash,
      subject,
      author,
      authorEmail,
      authorTime: Number(authorTime),
      firstParent: firstParent ?? null,
      extraParents,
      stashRef: null,
    };
  });

  return { commits, hasMore };
}

function pullLocalBranch(repoPath: string, branch: string) {
  const currentHead = runGit(repoPath, ["branch", "--show-current"]);
  if (currentHead === branch) {
    runGit(repoPath, ["pull", "--ff-only"]);
    return;
  }

  const upstream = tryRunGit(repoPath, ["rev-parse", "--abbrev-ref", `${branch}@{upstream}`]);
  if (upstream && upstream.includes("/")) {
    const [remote, remoteBranch] = upstream.split("/");
    runGit(repoPath, ["fetch", remote ?? "origin", `${remoteBranch}:${branch}`]);
    return;
  }

  runGit(repoPath, ["fetch", "origin", `${branch}:${branch}`]);
}
