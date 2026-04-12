/* global $, browser, describe, it */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import path from "node:path";

function repoPath() {
  const value = process.env.GARLIC_NATIVE_E2E_REPO_PATH;
  assert.ok(value, "Expected GARLIC_NATIVE_E2E_REPO_PATH to be set.");
  return value;
}

function git(...args) {
  return execFileSync("git", args, {
    cwd: repoPath(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trimEnd();
}

function appendTrackedChange(text) {
  appendFileSync(path.join(repoPath(), "README.md"), text);
}

async function runtimeDebugValue(expression) {
  return browser.execute(expression);
}

async function getInvokeLogs() {
  return runtimeDebugValue(() => globalThis.__garlicRuntimeDebug?.getInvokeLogs?.() ?? []);
}

async function getEventLogs() {
  return runtimeDebugValue(() => globalThis.__garlicRuntimeDebug?.getEventLogs?.() ?? []);
}

async function clearRuntimeDebug() {
  await runtimeDebugValue(() => {
    globalThis.__garlicRuntimeDebug?.clearInvokeLogs?.();
    globalThis.__garlicRuntimeDebug?.clearEventLogs?.();
  });
}

function latestLogForCommand(logs, command) {
  return logs.find((entry) => entry.command === command) ?? null;
}

function latestSuccessfulLogForCommand(logs, command) {
  return logs.find((entry) => entry.command === command && entry.status === "success") ?? null;
}

describe("Garlic native backend e2e", () => {
  it("boots from the native backend and stages files through the real Tauri bridge", async () => {
    await browser.waitUntil(
      async () => {
        const readyState = await browser.execute(() => document.readyState);
        return readyState === "complete";
      },
      { timeout: 30000, interval: 250, timeoutMsg: "Timed out waiting for the Garlic webview." },
    );

    await browser.waitUntil(
      async () =>
        browser.execute(() => {
          return Boolean(globalThis.__garlicRuntimeDebug);
        }),
      {
        timeout: 30000,
        interval: 250,
        timeoutMsg: "Timed out waiting for Garlic runtime debug hooks.",
      },
    );

    await browser.waitUntil(
      async () => {
        const logs = await getInvokeLogs();
        return (
          logs.some(
            (entry) => entry.command === "restore_app_bootstrap" && entry.status === "success",
          ) &&
          logs.some(
            (entry) => entry.command === "start_repo_watch" && entry.status === "success",
          ) &&
          logs.some((entry) => entry.command === "list_graph_commits" && entry.status === "success")
        );
      },
      {
        timeout: 30000,
        interval: 250,
        timeoutMsg: "Timed out waiting for native startup bridge traffic.",
      },
    );

    const startupLogs = await getInvokeLogs();
    const restoreBootstrapLog = latestLogForCommand(startupLogs, "restore_app_bootstrap");
    assert.ok(restoreBootstrapLog, "Expected restore_app_bootstrap to be logged.");
    assert.equal(restoreBootstrapLog.status, "success");
    assert.equal(restoreBootstrapLog.result.repo.metadata.path, repoPath());

    await clearRuntimeDebug();

    const stageAllButton = await $("button=Stage all");
    await stageAllButton.waitForClickable({ timeout: 30000 });
    await stageAllButton.click();

    await browser.waitUntil(
      async () => {
        const logs = await getInvokeLogs();
        return (
          logs.some((entry) => entry.command === "stage_all" && entry.status === "success") &&
          logs.some(
            (entry) => entry.command === "list_working_tree_files" && entry.status === "success",
          )
        );
      },
      {
        timeout: 30000,
        interval: 250,
        timeoutMsg: "Timed out waiting for stage_all bridge traffic.",
      },
    );

    const logs = await getInvokeLogs();
    const stageAllLog = latestSuccessfulLogForCommand(logs, "stage_all");
    const worktreeRefreshLog = latestSuccessfulLogForCommand(logs, "list_working_tree_files");
    assert.ok(stageAllLog, "Expected stage_all to be logged.");
    assert.ok(worktreeRefreshLog, "Expected worktree refresh after stage_all.");
    assert.equal(stageAllLog.status, "success");
    assert.equal(worktreeRefreshLog.status, "success");
    assert.ok(
      worktreeRefreshLog.result.some(
        (file) => file.path === "notes.txt" && file.staged === true && file.unstaged === false,
      ),
      "Expected native backend to return notes.txt as staged after Stage all.",
    );
    assert.match(git("status", "--porcelain=v1", "--untracked-files=all"), /A  notes.txt/);
  });

  it("captures a real repository-mutated event from the backend watcher", async () => {
    await clearRuntimeDebug();
    appendTrackedChange("native watcher update\n");

    await browser.waitUntil(
      async () => {
        const events = await getEventLogs();
        return events.some((entry) => entry.event === "repository-mutated");
      },
      {
        timeout: 30000,
        interval: 250,
        timeoutMsg: "Timed out waiting for repository-mutated from the native backend watcher.",
      },
    );

    await browser.waitUntil(
      async () => {
        const logs = await getInvokeLogs();
        return logs.some(
          (entry) => entry.command === "list_working_tree_files" && entry.status === "success",
        );
      },
      {
        timeout: 30000,
        interval: 250,
        timeoutMsg: "Timed out waiting for watcher-triggered refresh after repository-mutated.",
      },
    );

    const eventLogs = await getEventLogs();
    const invokeLogs = await getInvokeLogs();
    const watcherEvent = eventLogs.find((entry) => entry.event === "repository-mutated");
    const worktreeRefreshLog = latestSuccessfulLogForCommand(invokeLogs, "list_working_tree_files");
    assert.ok(watcherEvent, "Expected repository-mutated to be logged.");
    assert.ok(worktreeRefreshLog, "Expected watcher refresh to fetch working tree files.");
    assert.equal(worktreeRefreshLog.status, "success");
    assert.ok(
      worktreeRefreshLog.result.some((file) => file.path === "README.md" && file.unstaged === true),
      "Expected README.md to be refreshed as unstaged after the watcher event.",
    );
    assert.match(git("status", "--porcelain=v1", "--untracked-files=all"), /README\.md/);
  });
});
