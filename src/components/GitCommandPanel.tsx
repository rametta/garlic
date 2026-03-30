import { openUrl } from "@tauri-apps/plugin-opener";
import { memo, useEffect, useMemo, useState, type RefObject } from "react";

const GITLAB_MERGE_REQUEST_URL_RE = /\bhttps?:\/\/[^\s)]+\/-\/merge_requests\/\d+\b/;

function extractMergeRequestUrl(lines: { stream: string; text: string }[]): string | null {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = lines[index]?.text.match(GITLAB_MERGE_REQUEST_URL_RE);
    if (match) return match[0];
  }
  return null;
}

function IconChevronRight({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}

export interface GitCommandStreamState {
  sessionId: number;
  operation: string;
  commandLine: string;
  lines: { stream: string; text: string }[];
  finished: boolean;
  success: boolean | null;
  error: string | null;
}

export interface GitCommandPanelProps {
  repoPath: string | null;
  gitCommandStream: GitCommandStreamState | null;
  scrollRef: RefObject<HTMLDivElement | null>;
  onClear: () => void;
}

export const GitCommandPanel = memo(function GitCommandPanel({
  repoPath,
  gitCommandStream,
  scrollRef,
  onClear,
}: GitCommandPanelProps) {
  const [open, setOpen] = useState(false);
  const mergeRequestUrl = useMemo(
    () => (gitCommandStream ? extractMergeRequestUrl(gitCommandStream.lines) : null),
    [gitCommandStream],
  );

  useEffect(() => {
    setOpen(false);
  }, [repoPath]);

  useEffect(() => {
    if (mergeRequestUrl) {
      setOpen(true);
    }
  }, [mergeRequestUrl]);

  return (
    <div className="card shrink-0 border-base-300 bg-base-100 shadow-sm">
      <div className="card-body gap-0 p-0">
        <div
          className={`collapse border-0 bg-transparent shadow-none ${open ? "collapse-open" : ""}`}
        >
          <input
            type="checkbox"
            checked={open}
            onChange={(e) => {
              setOpen(e.target.checked);
            }}
            aria-label="Show or hide git command output"
          />
          <div className="collapse-title block! min-h-0 min-w-0 border-b border-base-300/80 px-3! py-2! text-left!">
            <div className="flex min-w-0 items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 className="m-0 text-xs font-semibold tracking-wide uppercase opacity-70">
                  Git command
                </h2>
                <p className="mt-0.5 mb-0 text-xs text-base-content/60">
                  {gitCommandStream
                    ? gitCommandStream.finished
                      ? gitCommandStream.success
                        ? "Finished"
                        : "Failed"
                      : "Running…"
                    : "No recent command output"}
                </p>
              </div>
              <IconChevronRight
                className={`mt-0.5 h-4 w-4 shrink-0 opacity-60 transition-transform ${
                  open ? "rotate-90" : ""
                }`}
              />
            </div>
          </div>
          <div className="collapse-content px-0! pt-0! pb-0!">
            <div className="space-y-2 p-3">
              {gitCommandStream ? (
                <>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="m-0 text-sm font-semibold text-base-content">
                        {gitCommandStream.operation}
                      </p>
                      <code
                        className="mt-1 block max-h-10 overflow-y-auto font-mono text-[10px] leading-tight wrap-anywhere text-base-content/70"
                        title={gitCommandStream.commandLine}
                      >
                        {gitCommandStream.commandLine}
                      </code>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {mergeRequestUrl ? (
                        <button
                          type="button"
                          className="btn btn-xs btn-primary"
                          title={mergeRequestUrl}
                          onClick={() => {
                            void openUrl(mergeRequestUrl);
                          }}
                        >
                          View MR
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="btn shrink-0 btn-ghost btn-xs"
                        onClick={onClear}
                      >
                        Clear
                      </button>
                    </div>
                  </div>
                  <div
                    ref={scrollRef}
                    className="max-h-[min(12rem,35vh)] min-h-12 overflow-x-hidden overflow-y-auto rounded border border-base-300 bg-base-200/40 px-2 py-1.5 font-mono text-[11px] leading-snug wrap-anywhere [scrollbar-gutter:stable]"
                  >
                    {gitCommandStream.lines.length === 0 && !gitCommandStream.finished ? (
                      <span className="text-base-content/60">Running…</span>
                    ) : null}
                    {gitCommandStream.lines.map((line, index) => (
                      <div
                        key={index}
                        className={
                          line.stream === "stderr" ? "text-warning" : "text-base-content/85"
                        }
                      >
                        {line.text}
                      </div>
                    ))}
                    {gitCommandStream.finished ? (
                      <div
                        className={
                          gitCommandStream.success
                            ? "mt-1 border-t border-base-300 pt-1 text-success"
                            : "mt-1 border-t border-base-300 pt-1 text-error"
                        }
                      >
                        {gitCommandStream.success
                          ? "Finished."
                          : gitCommandStream.error?.trim() || "Command failed."}
                      </div>
                    ) : null}
                  </div>
                </>
              ) : (
                <p className="m-0 text-xs text-base-content/50">No recent command output</p>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
});
