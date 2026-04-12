import { execFileSync } from "node:child_process";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

function runGit(repoPath, args) {
  return execFileSync("git", args, {
    cwd: repoPath,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trimEnd();
}

function configureGitIdentity(repoPath) {
  runGit(repoPath, ["config", "user.name", "Garlic Native E2E"]);
  runGit(repoPath, ["config", "user.email", "garlic-native-e2e@example.com"]);
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

export function createNativeRepoFixture() {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), "garlic-native-e2e-"));
  const repoPath = path.join(rootDir, "repo");
  const fakeHome = path.join(rootDir, "home");

  mkdirSync(repoPath, { recursive: true });
  mkdirSync(path.join(fakeHome, ".config"), { recursive: true });

  runGit(repoPath, ["init"]);
  configureGitIdentity(repoPath);

  writeFileSync(path.join(repoPath, "README.md"), "# Garlic native e2e repo\n");
  runGit(repoPath, ["add", "README.md"]);
  runGit(repoPath, ["commit", "-m", "Initial commit"]);
  runGit(repoPath, ["branch", "-M", "main"]);

  writeFileSync(path.join(repoPath, "notes.txt"), "native e2e untracked file\n");

  return {
    rootDir,
    repoPath,
    fakeHome,
    appendToReadme(text) {
      appendFileSync(path.join(repoPath, "README.md"), text);
    },
    git(...args) {
      return runGit(repoPath, args);
    },
    cleanup() {
      rmSync(rootDir, { recursive: true, force: true });
    },
  };
}

export function createLinuxLauncherScript({ rootDir, repoPath, fakeHome, appBinaryPath }) {
  const launcherPath = path.join(rootDir, "launch-garlic-native-e2e.sh");
  writeFileSync(
    launcherPath,
    `#!/usr/bin/env bash
set -euo pipefail
export HOME=${shellEscape(fakeHome)}
export XDG_CONFIG_HOME=${shellEscape(path.join(fakeHome, ".config"))}
export GARLIC_E2E_REPO_PATH=${shellEscape(repoPath)}
exec ${shellEscape(appBinaryPath)} "$@"
`,
  );
  chmodSync(launcherPath, 0o755);
  return launcherPath;
}
