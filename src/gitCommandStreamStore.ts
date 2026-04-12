/**
 * Client-side event store for streaming long-running Git command output from Tauri.
 * Search tags: git command stream, live command output, repository-mutated, external store.
 */
import { useSyncExternalStore } from "react";
import { listen } from "./tauriBridgeDebug";

type GitCommandStreamLine = {
  stream: string;
  text: string;
};

export interface GitCommandStreamState {
  sessionId: number;
  operation: string;
  commandLine: string;
  lines: GitCommandStreamLine[];
  finished: boolean;
  success: boolean | null;
  error: string | null;
}

interface GitCommandStreamStartedPayload {
  sessionId: number;
  repoPath: string;
  operation: string;
  commandLine: string;
}

interface GitCommandStreamLinePayload {
  sessionId: number;
  repoPath: string;
  operation: string;
  stream: string;
  line: string;
}

interface GitCommandStreamFinishedPayload {
  sessionId: number;
  repoPath: string;
  operation: string;
  success: boolean;
  error?: string | null;
}

type GitCommandStreamStore = {
  started: boolean;
  subscribers: Set<() => void>;
  streamsByRepo: Map<string, GitCommandStreamState>;
  pendingLinesByRepo: Map<string, GitCommandStreamLine[]>;
  flushRaf: number | null;
};

const globalStore = (
  globalThis as typeof globalThis & {
    __garlicGitCommandStreamStore?: GitCommandStreamStore;
  }
).__garlicGitCommandStreamStore ?? {
  started: false,
  subscribers: new Set<() => void>(),
  streamsByRepo: new Map<string, GitCommandStreamState>(),
  pendingLinesByRepo: new Map<string, GitCommandStreamLine[]>(),
  flushRaf: null,
};

(
  globalThis as typeof globalThis & {
    __garlicGitCommandStreamStore?: GitCommandStreamStore;
  }
).__garlicGitCommandStreamStore = globalStore;

function notifySubscribers() {
  for (const subscriber of globalStore.subscribers) {
    subscriber();
  }
}

function flushPendingLines() {
  globalStore.flushRaf = null;
  if (globalStore.pendingLinesByRepo.size === 0) return;

  let changed = false;
  for (const [repoPath, pendingLines] of globalStore.pendingLinesByRepo) {
    globalStore.pendingLinesByRepo.delete(repoPath);
    if (pendingLines.length === 0) continue;
    const current = globalStore.streamsByRepo.get(repoPath);
    if (!current) continue;
    globalStore.streamsByRepo.set(repoPath, {
      ...current,
      lines: [...current.lines, ...pendingLines].slice(-400),
    });
    changed = true;
  }

  if (changed) {
    notifySubscribers();
  }
}

function scheduleFlush() {
  if (globalStore.flushRaf !== null) return;
  globalStore.flushRaf = requestAnimationFrame(() => {
    flushPendingLines();
  });
}

function takePendingLines(repoPath: string): GitCommandStreamLine[] {
  const pendingLines = globalStore.pendingLinesByRepo.get(repoPath) ?? [];
  globalStore.pendingLinesByRepo.delete(repoPath);
  return pendingLines;
}

function ensureGitCommandStreamStoreStarted() {
  if (globalStore.started) return;
  globalStore.started = true;

  void Promise.all([
    listen<GitCommandStreamStartedPayload>("git-command-stream-started", (e) => {
      const p = e.payload;
      globalStore.pendingLinesByRepo.delete(p.repoPath);
      globalStore.streamsByRepo.set(p.repoPath, {
        sessionId: p.sessionId,
        operation: p.operation,
        commandLine: p.commandLine,
        lines: [],
        finished: false,
        success: null,
        error: null,
      });
      notifySubscribers();
    }),
    listen<GitCommandStreamLinePayload>("git-command-stream-line", (e) => {
      const p = e.payload;
      const current = globalStore.streamsByRepo.get(p.repoPath);
      if (!current || current.sessionId !== p.sessionId) return;

      const pendingLines = globalStore.pendingLinesByRepo.get(p.repoPath) ?? [];
      pendingLines.push({ stream: p.stream, text: p.line });
      globalStore.pendingLinesByRepo.set(p.repoPath, pendingLines);
      scheduleFlush();
    }),
    listen<GitCommandStreamFinishedPayload>("git-command-stream-finished", (e) => {
      const p = e.payload;
      if (globalStore.flushRaf !== null) {
        cancelAnimationFrame(globalStore.flushRaf);
        globalStore.flushRaf = null;
        flushPendingLines();
      }
      const current = globalStore.streamsByRepo.get(p.repoPath);
      if (!current || current.sessionId !== p.sessionId) return;

      const pendingLines = takePendingLines(p.repoPath);
      globalStore.streamsByRepo.set(p.repoPath, {
        ...current,
        lines:
          pendingLines.length > 0 ? [...current.lines, ...pendingLines].slice(-400) : current.lines,
        finished: true,
        success: p.success,
        error: p.error ?? null,
      });
      notifySubscribers();
    }),
  ]).catch(() => {
    globalStore.started = false;
  });
}

function subscribe(onStoreChange: () => void) {
  ensureGitCommandStreamStoreStarted();
  globalStore.subscribers.add(onStoreChange);
  return () => {
    globalStore.subscribers.delete(onStoreChange);
  };
}

function getGitCommandStreamSnapshot(repoPath: string | null): GitCommandStreamState | null {
  if (!repoPath) return null;
  return globalStore.streamsByRepo.get(repoPath) ?? null;
}

export function useGitCommandStream(repoPath: string | null): GitCommandStreamState | null {
  return useSyncExternalStore(
    subscribe,
    () => getGitCommandStreamSnapshot(repoPath),
    () => null,
  );
}

export function clearGitCommandStream(repoPath: string | null) {
  if (!repoPath) return;

  const hadStream = globalStore.streamsByRepo.delete(repoPath);
  globalStore.pendingLinesByRepo.delete(repoPath);
  if (hadStream) {
    notifySubscribers();
  }
}
