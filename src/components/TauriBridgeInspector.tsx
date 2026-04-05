/**
 * Debug-only UI for inspecting frontend-to-Tauri command calls and payloads.
 * Search tags: bridge inspector, tauri invoke logs, command debug panel, export bridge logs.
 */
import { useMemo, useState, useSyncExternalStore } from "react";
import {
  clearTauriBridgeLogs,
  getTauriBridgeLogs,
  isTauriBridgeLoggingPaused,
  invoke,
  setTauriBridgeLoggingPaused,
  subscribeTauriBridgeLogs,
  type TauriBridgeLogEntry,
} from "../tauriBridgeDebug";

const JSON_PREVIEW_LIMIT = 600;

function formatValue(value: unknown) {
  if (value === undefined) return "undefined";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "[unserializable value]";
  }
}

function previewValue(value: unknown) {
  const text = formatValue(value);
  return text.length > JSON_PREVIEW_LIMIT ? `${text.slice(0, JSON_PREVIEW_LIMIT)}...` : text;
}

function formatErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function formatTimestamp(value: number | null) {
  return value == null ? "pending" : new Date(value).toISOString();
}

function formatBridgeDebugExport(entries: readonly TauriBridgeLogEntry[]) {
  const lines = [
    "# Garlic bridge debug export",
    `Exported at: ${new Date().toISOString()}`,
    `Entry count: ${entries.length}`,
    "",
  ];

  for (const [index, entry] of entries.entries()) {
    lines.push(`## ${index + 1}. ${entry.command}`);
    lines.push(`- Status: ${entry.status}`);
    lines.push(`- Started: ${formatTimestamp(entry.startedAt)}`);
    lines.push(`- Finished: ${formatTimestamp(entry.finishedAt)}`);
    lines.push(`- Duration: ${entry.durationMs == null ? "pending" : `${entry.durationMs}ms`}`);
    lines.push("- Args:");
    lines.push("```");
    lines.push(formatValue(entry.args));
    lines.push("```");
    lines.push(`- ${entry.status}`);
    lines.push("");
  }

  return lines.join("\n");
}

function entryStatusTone(status: TauriBridgeLogEntry["status"]) {
  switch (status) {
    case "success":
      return "text-success";
    case "error":
      return "text-error";
    default:
      return "text-warning";
  }
}

export function TauriBridgeInspector() {
  const entries = useSyncExternalStore(
    subscribeTauriBridgeLogs,
    getTauriBridgeLogs,
    getTauriBridgeLogs,
  );
  const paused = useSyncExternalStore(
    subscribeTauriBridgeLogs,
    isTauriBridgeLoggingPaused,
    isTauriBridgeLoggingPaused,
  );
  const [open, setOpen] = useState(false);
  const [expandedEntryId, setExpandedEntryId] = useState<number | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportPath, setExportPath] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  const stats = useMemo(() => {
    let pending = 0;
    let errors = 0;
    for (const entry of entries) {
      if (entry.status === "pending") pending += 1;
      if (entry.status === "error") errors += 1;
    }
    return { pending, errors };
  }, [entries]);

  const exportDisabled = exporting || entries.length === 0;

  return (
    <div className="pointer-events-none fixed bottom-4 left-1/2 z-70 flex max-h-[70vh] w-120 max-w-[calc(100vw-2rem)] -translate-x-1/2 flex-col items-center gap-2">
      <button
        type="button"
        className="btn pointer-events-auto shadow-lg btn-sm btn-neutral"
        onClick={() => {
          setOpen((current) => !current);
        }}
      >
        Bridge
        <span className="badge badge-sm">{entries.length}</span>
        {stats.pending > 0 ? (
          <span className="badge badge-sm badge-warning">{stats.pending} pending</span>
        ) : null}
        {stats.errors > 0 ? (
          <span className="badge badge-sm badge-error">{stats.errors} errors</span>
        ) : null}
        {paused ? <span className="badge badge-ghost badge-sm">paused</span> : null}
      </button>

      {open ? (
        <section className="pointer-events-auto card max-h-full w-full overflow-hidden border border-base-300 bg-base-100 shadow-2xl">
          <div className="flex items-center gap-2 border-b border-base-300 px-3 py-2">
            <div className="min-w-0 flex-1">
              <h2 className="m-0 text-sm font-semibold">Tauri bridge</h2>
            </div>
            <button
              type="button"
              className="btn btn-ghost btn-xs"
              onClick={() => {
                setTauriBridgeLoggingPaused(!paused);
              }}
            >
              {paused ? "Resume" : "Pause"}
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-xs"
              disabled={exportDisabled}
              onClick={() => {
                void (async () => {
                  if (entries.length === 0) return;
                  setExporting(true);
                  setExportError(null);
                  try {
                    const savedPath = await invoke<string>("export_bridge_debug_to_downloads", {
                      contents: formatBridgeDebugExport(entries),
                    });
                    setExportPath(savedPath);
                  } catch (error) {
                    setExportError(formatErrorMessage(error));
                  } finally {
                    setExporting(false);
                  }
                })();
              }}
            >
              {exporting ? "Exporting..." : "Export"}
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-xs"
              onClick={() => {
                clearTauriBridgeLogs();
                setExpandedEntryId(null);
                setExportPath(null);
                setExportError(null);
              }}
            >
              Clear
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-xs"
              onClick={() => {
                setOpen(false);
              }}
            >
              Close
            </button>
          </div>

          {exportPath || exportError ? (
            <div className="border-b border-base-300 px-3 py-2 text-[11px]">
              {exportPath ? (
                <div className="truncate text-base-content/70">
                  Saved to Downloads: {exportPath}
                </div>
              ) : null}
              {exportError ? <div className="text-error">{exportError}</div> : null}
            </div>
          ) : null}

          <div className="overflow-y-auto p-2">
            {entries.length === 0 ? (
              <p className="m-0 rounded-md border border-dashed border-base-300 px-3 py-6 text-center text-sm text-base-content/60">
                No bridge traffic yet.
              </p>
            ) : (
              <ul className="m-0 flex list-none flex-col gap-2 p-0">
                {entries.map((entry) => {
                  const expanded = expandedEntryId === entry.id;
                  return (
                    <li key={entry.id} className="rounded-md border border-base-300 bg-base-200/60">
                      <button
                        type="button"
                        className="flex w-full items-start gap-2 px-3 py-2 text-left"
                        onClick={() => {
                          setExpandedEntryId((current) => (current === entry.id ? null : entry.id));
                        }}
                      >
                        <span
                          className={`mt-0.5 text-xs font-semibold uppercase ${entryStatusTone(entry.status)}`}
                        >
                          {entry.status}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-mono text-xs text-base-content">
                            {entry.command}
                          </div>
                          <div className="mt-1 line-clamp-2 font-mono text-[11px] break-all whitespace-pre-wrap text-base-content/65">
                            {entry.status === "error"
                              ? previewValue(entry.error)
                              : entry.status === "success"
                                ? previewValue(entry.result)
                                : previewValue(entry.args)}
                          </div>
                        </div>
                        <div className="shrink-0 text-right text-[11px] text-base-content/55">
                          {entry.durationMs === null ? "..." : `${entry.durationMs}ms`}
                        </div>
                      </button>

                      {expanded ? (
                        <div className="border-t border-base-300 px-3 py-2">
                          <div className="grid gap-2 text-xs">
                            <div>
                              <div className="mb-1 font-semibold text-base-content/70">Args</div>
                              <pre className="m-0 max-h-40 overflow-auto rounded bg-base-300/60 p-2 text-[11px] break-all whitespace-pre-wrap">
                                {formatValue(entry.args)}
                              </pre>
                            </div>
                            {entry.status === "success" ? (
                              <div>
                                <div className="mb-1 font-semibold text-base-content/70">
                                  Result
                                </div>
                                <pre className="m-0 max-h-48 overflow-auto rounded bg-base-300/60 p-2 text-[11px] break-all whitespace-pre-wrap">
                                  {formatValue(entry.result)}
                                </pre>
                              </div>
                            ) : null}
                            {entry.status === "error" ? (
                              <div>
                                <div className="mb-1 font-semibold text-base-content/70">Error</div>
                                <pre className="m-0 max-h-40 overflow-auto rounded bg-base-300/60 p-2 text-[11px] break-all whitespace-pre-wrap">
                                  {entry.error}
                                </pre>
                              </div>
                            ) : null}
                          </div>
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </section>
      ) : null}
    </div>
  );
}
