/**
 * Thin `invoke` / `listen` wrappers plus in-memory logs for inspecting native Tauri traffic.
 * Search tags: tauri invoke logging, backend event logging, bridge inspector, webdriver debug.
 */
import { invoke as tauriInvoke, type InvokeArgs } from "@tauri-apps/api/core";
import { listen as tauriListen } from "@tauri-apps/api/event";

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

export interface TauriEventLogEntry {
  id: number;
  event: string;
  payload: unknown;
  receivedAt: number;
}

type Listener = () => void;

const MAX_LOG_ENTRIES = 200;
export const TAURI_RUNTIME_DEBUG_ENABLED =
  import.meta.env.DEV || import.meta.env.VITE_GARLIC_E2E === "true";

let nextEntryId = 1;
let nextEventId = 1;
let paused = false;
let entries: TauriBridgeLogEntry[] = [];
let eventEntries: TauriEventLogEntry[] = [];
const listeners = new Set<Listener>();

type GarlicRuntimeDebugApi = {
  getInvokeLogs(): TauriBridgeLogEntry[];
  clearInvokeLogs(): void;
  getEventLogs(): TauriEventLogEntry[];
  clearEventLogs(): void;
  isPaused(): boolean;
  setPaused(nextPaused: boolean): void;
};

function installRuntimeDebugApi() {
  if (!TAURI_RUNTIME_DEBUG_ENABLED) return;
  (
    globalThis as typeof globalThis & {
      __garlicRuntimeDebug?: GarlicRuntimeDebugApi;
    }
  ).__garlicRuntimeDebug = {
    getInvokeLogs: () => entries,
    clearInvokeLogs: () => {
      clearTauriBridgeLogs();
    },
    getEventLogs: () => eventEntries,
    clearEventLogs: () => {
      clearTauriEventLogs();
    },
    isPaused: () => paused,
    setPaused: (nextPaused: boolean) => {
      setTauriBridgeLoggingPaused(nextPaused);
    },
  };
}

installRuntimeDebugApi();

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

function appendEventEntry(entry: TauriEventLogEntry) {
  if (paused) return;
  eventEntries = [entry, ...eventEntries].slice(0, MAX_LOG_ENTRIES);
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

export function getTauriEventLogs() {
  return eventEntries;
}

export function clearTauriBridgeLogs() {
  entries = [];
  emitChange();
}

export function clearTauriEventLogs() {
  eventEntries = [];
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
  if (!TAURI_RUNTIME_DEBUG_ENABLED) {
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

export async function listen<T>(
  eventName: string,
  callback: (event: { payload: T }) => void,
): Promise<() => void> {
  return tauriListen<T>(eventName, (event) => {
    if (TAURI_RUNTIME_DEBUG_ENABLED) {
      appendEventEntry({
        id: nextEventId++,
        event: eventName,
        payload: event.payload,
        receivedAt: Date.now(),
      });
    }
    callback({ payload: event.payload });
  });
}
