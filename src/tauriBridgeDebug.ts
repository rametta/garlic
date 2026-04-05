/**
 * Thin `invoke` wrapper plus an in-memory log for inspecting frontend-to-Tauri command traffic.
 * Search tags: tauri invoke logging, bridge inspector, command timing, debug export.
 */
import { invoke as tauriInvoke, type InvokeArgs } from "@tauri-apps/api/core";

export interface TauriBridgeLogEntry {
  id: number;
  command: string;
  args: unknown;
  status: "pending" | "success" | "error";
  startedAt: number;
  finishedAt: number | null;
  durationMs: number | null;
  result?: unknown;
  error?: string;
}

type Listener = () => void;

const MAX_LOG_ENTRIES = 200;

let nextEntryId = 1;
let paused = false;
let entries: TauriBridgeLogEntry[] = [];
const listeners = new Set<Listener>();

function emitChange() {
  for (const listener of listeners) listener();
}

function upsertEntry(entry: TauriBridgeLogEntry) {
  if (paused) return;
  const index = entries.findIndex((row) => row.id === entry.id);
  if (index >= 0) {
    entries = [...entries.slice(0, index), entry, ...entries.slice(index + 1)];
  } else {
    entries = [entry, ...entries].slice(0, MAX_LOG_ENTRIES);
  }
  emitChange();
}

function safeSerializeError(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message || String(error);
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export function subscribeTauriBridgeLogs(listener: Listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getTauriBridgeLogs() {
  return entries;
}

export function clearTauriBridgeLogs() {
  entries = [];
  emitChange();
}

export function setTauriBridgeLoggingPaused(nextPaused: boolean) {
  paused = nextPaused;
  emitChange();
}

export function isTauriBridgeLoggingPaused() {
  return paused;
}

export async function invoke<T>(command: string, args?: InvokeArgs): Promise<T> {
  if (!import.meta.env.DEV) {
    return tauriInvoke<T>(command, args);
  }

  const entryId = nextEntryId++;
  const startedAt = Date.now();
  upsertEntry({
    id: entryId,
    command,
    args,
    status: "pending",
    startedAt,
    finishedAt: null,
    durationMs: null,
  });

  try {
    const result = await tauriInvoke<T>(command, args);
    upsertEntry({
      id: entryId,
      command,
      args,
      status: "success",
      startedAt,
      finishedAt: Date.now(),
      durationMs: Date.now() - startedAt,
      result,
    });
    return result;
  } catch (error) {
    upsertEntry({
      id: entryId,
      command,
      args,
      status: "error",
      startedAt,
      finishedAt: Date.now(),
      durationMs: Date.now() - startedAt,
      error: safeSerializeError(error),
    });
    throw error;
  }
}
