import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";

interface RemoteEntry {
  name: string;
  fetchUrl: string;
}

interface RepoMetadata {
  path: string;
  name: string;
  gitRoot: string | null;
  error: string | null;
  branch: string | null;
  headShort: string | null;
  headSubject: string | null;
  headAuthor: string | null;
  headDate: string | null;
  detached: boolean;
  remotes: RemoteEntry[];
  workingTreeClean: boolean | null;
  ahead: number | null;
  behind: number | null;
}

interface CommitEntry {
  hash: string;
  shortHash: string;
  subject: string;
  author: string;
  date: string;
}

/** Local branch row from `list_local_branches` / bootstrap. */
export interface LocalBranchEntry {
  name: string;
  /** Remote-tracking upstream ref (e.g. origin/main); null if not configured. */
  upstreamName: string | null;
  /** Commits on this branch not on upstream; null if no upstream. */
  ahead: number | null;
  /** Commits on upstream not on this branch; null if no upstream. */
  behind: number | null;
}

/** One path in the working tree from `list_working_tree_files` / bootstrap. */
export interface WorkingTreeFile {
  path: string;
  staged: boolean;
  unstaged: boolean;
}

/** Repo snapshot from `restore_app_bootstrap` (`repo` field). */
export interface RestoreLastRepo {
  loadError: string | null;
  metadata: RepoMetadata | null;
  localBranches: LocalBranchEntry[];
  remoteBranches: string[];
  commits: CommitEntry[];
  workingTreeFiles: WorkingTreeFile[];
  listsError: string | null;
}

function localBranchUpstreamLabel(
  ahead: number | null,
  behind: number | null,
  upstreamName: string | null,
): string | null {
  if (ahead === null || behind === null) return null;
  const vs = upstreamName ? ` · ${upstreamName}` : "";
  return `↑${ahead} ↓${behind}${vs}`;
}

function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function MetaRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[8.5rem_1fr] items-baseline gap-x-4 gap-y-2 text-sm">
      <dt className="m-0 font-semibold text-base-content/70">{label}</dt>
      <dd className="m-0 min-w-0 wrap-break-word text-base-content">{children}</dd>
    </div>
  );
}

function BranchPanel({
  title,
  empty,
  emptyHint,
  headerRight,
  children,
}: {
  title: string;
  empty: boolean;
  emptyHint: string;
  /** Optional control (e.g. action button) aligned with the panel title. */
  headerRight?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="card border-base-300 bg-base-100 shadow-sm">
      <div className="card-body min-h-0 gap-0 p-0">
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-base-300 px-3 py-2">
          <h2 className="m-0 card-title min-w-0 flex-1 text-xs font-semibold tracking-wide uppercase opacity-70">
            {title}
          </h2>
          {headerRight ? <div className="shrink-0">{headerRight}</div> : null}
        </div>
        <div className="max-h-[40vh] min-h-16 overflow-y-auto p-2">
          {empty ? (
            <p className="m-0 py-2 text-center text-xs text-base-content/50">{emptyHint}</p>
          ) : (
            children
          )}
        </div>
      </div>
    </div>
  );
}

export default function App({ startup }: { startup: RestoreLastRepo }) {
  const [repo, setRepo] = useState<RepoMetadata | null>(() => startup.metadata ?? null);
  const [loadError, setLoadError] = useState<string | null>(() => startup.loadError ?? null);
  const [loading, setLoading] = useState(false);
  const [localBranches, setLocalBranches] = useState<LocalBranchEntry[]>(
    () => startup.localBranches,
  );
  const [remoteBranches, setRemoteBranches] = useState<string[]>(() => startup.remoteBranches);
  const [commits, setCommits] = useState<CommitEntry[]>(() => startup.commits);
  const [workingTreeFiles, setWorkingTreeFiles] = useState<WorkingTreeFile[]>(
    () => startup.workingTreeFiles,
  );
  const [branchBusy, setBranchBusy] = useState<string | null>(null);
  const [listsError, setListsError] = useState<string | null>(() => startup.listsError ?? null);
  const [commitMessage, setCommitMessage] = useState("");
  const [stageCommitBusy, setStageCommitBusy] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  const createBranchDialogRef = useRef<HTMLDialogElement>(null);
  const newBranchInputRef = useRef<HTMLInputElement>(null);
  const [newBranchName, setNewBranchName] = useState("");
  const [createBranchFieldError, setCreateBranchFieldError] = useState<string | null>(null);
  const refreshLists = useCallback(async (repoPath: string) => {
    setListsError(null);
    try {
      const [locals, remotes, log, worktree] = await Promise.all([
        invoke<LocalBranchEntry[]>("list_local_branches", { path: repoPath }),
        invoke<string[]>("list_remote_branches", { path: repoPath }),
        invoke<CommitEntry[]>("list_branch_commits", { path: repoPath }),
        invoke<WorkingTreeFile[]>("list_working_tree_files", { path: repoPath }),
      ]);
      setLocalBranches(locals);
      setRemoteBranches(remotes);
      setCommits(log);
      setWorkingTreeFiles(worktree);
    } catch (e) {
      setListsError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const loadRepo = useCallback(
    async (selected: string) => {
      setLoading(true);
      setLoadError(null);
      try {
        const meta = await invoke<RepoMetadata>("get_repo_metadata", {
          path: selected,
        });
        setRepo(meta);
        if (!meta.error) {
          await invoke("set_last_repo_path", { path: selected });
          await refreshLists(selected);
        } else {
          setLocalBranches([]);
          setRemoteBranches([]);
          setCommits([]);
          setWorkingTreeFiles([]);
        }
      } catch (e) {
        setRepo(null);
        setLocalBranches([]);
        setRemoteBranches([]);
        setCommits([]);
        setWorkingTreeFiles([]);
        setLoadError(e instanceof Error ? e.message : String(e));
        void invoke("reset_main_window_title").catch(() => {});
      } finally {
        setLoading(false);
      }
    },
    [refreshLists],
  );

  const refreshAfterMutation = useCallback(async () => {
    if (!repo?.path || repo.error) return;
    try {
      const meta = await invoke<RepoMetadata>("get_repo_metadata", {
        path: repo.path,
      });
      setRepo(meta);
      if (!meta.error) {
        await refreshLists(repo.path);
      }
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }, [repo, refreshLists]);

  useEffect(() => {
    const promise = Promise.all([
      listen("open-repo-request", () => {
        void (async () => {
          const selected = await open({
            directory: true,
            multiple: false,
            title: "Open repository",
          });
          if (selected === null || Array.isArray(selected)) return;
          await loadRepo(selected);
        })();
      }),
      listen<{ theme: string }>("theme-changed", (e) => {
        document.documentElement.setAttribute("data-theme", e.payload.theme);
      }),
    ]);

    return () => {
      void promise.then((listeners) => {
        for (const u of listeners) {
          u();
        }
      });
    };
  }, [loadRepo]);

  async function onCheckoutLocal(branch: string) {
    if (!repo?.path || repo.error) return;
    setBranchBusy(`local:${branch}`);
    setLoadError(null);
    try {
      await invoke("checkout_local_branch", {
        path: repo.path,
        branch,
      });
      await refreshAfterMutation();
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setBranchBusy(null);
    }
  }

  function openCreateBranchDialog() {
    setNewBranchName("");
    setCreateBranchFieldError(null);
    setLoadError(null);
    createBranchDialogRef.current?.showModal();
    requestAnimationFrame(() => {
      newBranchInputRef.current?.focus();
    });
  }

  async function submitCreateBranch() {
    const trimmed = newBranchName.trim();
    if (!repo?.path || repo.error) return;
    if (!trimmed) {
      setCreateBranchFieldError("Enter a branch name.");
      return;
    }
    setCreateBranchFieldError(null);
    setBranchBusy("create");
    setLoadError(null);
    try {
      await invoke("create_local_branch", {
        path: repo.path,
        branch: trimmed,
      });
      createBranchDialogRef.current?.close();
      await refreshAfterMutation();
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setBranchBusy(null);
    }
  }

  async function onCreateFromRemote(remoteRef: string) {
    if (!repo?.path || repo.error) return;
    setBranchBusy(`remote:${remoteRef}`);
    setLoadError(null);
    try {
      await invoke("create_branch_from_remote", {
        path: repo.path,
        remoteRef,
      });
      await refreshAfterMutation();
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setBranchBusy(null);
    }
  }

  async function onStagePaths(paths: string[]) {
    if (!repo?.path || repo.error || paths.length === 0) return;
    setStageCommitBusy(true);
    setLoadError(null);
    try {
      await invoke("stage_paths", { path: repo.path, paths });
      await refreshAfterMutation();
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setStageCommitBusy(false);
    }
  }

  async function onUnstagePaths(paths: string[]) {
    if (!repo?.path || repo.error || paths.length === 0) return;
    setStageCommitBusy(true);
    setLoadError(null);
    try {
      await invoke("unstage_paths", { path: repo.path, paths });
      await refreshAfterMutation();
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setStageCommitBusy(false);
    }
  }

  async function onCommit() {
    if (!repo?.path || repo.error) return;
    const msg = commitMessage.trim();
    if (!msg) return;
    setStageCommitBusy(true);
    setLoadError(null);
    try {
      await invoke("commit_staged", { path: repo.path, message: msg });
      setCommitMessage("");
      await refreshAfterMutation();
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setStageCommitBusy(false);
    }
  }

  async function onPushToOrigin() {
    if (!repo?.path || repo.error) return;
    setPushBusy(true);
    setLoadError(null);
    try {
      await invoke("push_to_origin", { path: repo.path });
      await refreshAfterMutation();
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setPushBusy(false);
    }
  }

  const canShowBranches = Boolean(repo && !repo.error && !loading);
  const currentBranchName = repo?.detached ? null : (repo?.branch ?? null);

  const hasStagedFiles = workingTreeFiles.some((f) => f.staged);
  const unstagedPaths = workingTreeFiles.filter((f) => f.unstaged).map((f) => f.path);
  const stagedPaths = workingTreeFiles.filter((f) => f.staged).map((f) => f.path);
  const canCommit =
    Boolean(repo?.path && !repo.error && !loading) &&
    hasStagedFiles &&
    commitMessage.trim().length > 0 &&
    !stageCommitBusy;
  const canPush =
    Boolean(repo?.path && !repo.error && !loading) &&
    !repo.detached &&
    !stageCommitBusy &&
    !pushBusy;

  return (
    <main className="box-border flex min-h-screen flex-col bg-base-200 px-4 pt-6 pb-8 text-base-content antialiased [font-synthesis:none]">
      <div
        className="grid flex-1 grid-cols-12 gap-4 lg:items-start"
        aria-live="polite"
        aria-busy={loading}
      >
        <aside className="col-span-12 flex min-h-0 flex-col gap-3 lg:sticky lg:top-6 lg:col-span-3 lg:max-h-[calc(100vh-3rem)]">
          <dialog
            ref={createBranchDialogRef}
            className="modal"
            onClick={(e) => {
              if (e.target === e.currentTarget) {
                e.currentTarget.close();
              }
            }}
            onClose={() => {
              setNewBranchName("");
              setCreateBranchFieldError(null);
            }}
          >
            <div
              className="modal-box"
              onClick={(e) => {
                e.stopPropagation();
              }}
            >
              <h3 className="m-0 text-lg font-bold">New local branch</h3>
              <p className="mt-1 mb-0 text-sm text-base-content/70">
                Creates a branch from the current commit and switches to it.
              </p>
              <label className="form-control mt-4 w-full">
                <span className="label-text mb-1">Branch name</span>
                <input
                  ref={newBranchInputRef}
                  type="text"
                  className="input-bordered input w-full font-mono text-sm"
                  value={newBranchName}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={branchBusy === "create"}
                  onChange={(e) => {
                    setNewBranchName(e.target.value);
                    if (createBranchFieldError) setCreateBranchFieldError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void submitCreateBranch();
                    }
                  }}
                />
                {createBranchFieldError ? (
                  <span className="label-text-alt text-error">{createBranchFieldError}</span>
                ) : null}
              </label>
              <div className="modal-action">
                <button
                  type="button"
                  className="btn"
                  disabled={branchBusy === "create"}
                  onClick={() => createBranchDialogRef.current?.close()}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={branchBusy === "create"}
                  onClick={() => void submitCreateBranch()}
                >
                  {branchBusy === "create" ? (
                    <span className="loading loading-sm loading-spinner" />
                  ) : (
                    "Create"
                  )}
                </button>
              </div>
            </div>
          </dialog>

          <BranchPanel
            title="Local branches"
            empty={canShowBranches && localBranches.length === 0}
            emptyHint="No local branches"
            headerRight={
              canShowBranches ? (
                <button
                  type="button"
                  className="btn btn-ghost btn-xs"
                  disabled={Boolean(branchBusy)}
                  onClick={() => {
                    openCreateBranchDialog();
                  }}
                >
                  New branch
                </button>
              ) : null
            }
          >
            {canShowBranches ? (
              <ul className="menu w-full menu-sm rounded-md bg-transparent p-0">
                {localBranches.map((b) => {
                  const isCurrent = currentBranchName === b.name;
                  const busy = branchBusy === `local:${b.name}`;
                  const upstreamLabel = localBranchUpstreamLabel(
                    b.ahead,
                    b.behind,
                    b.upstreamName ?? null,
                  );
                  return (
                    <li key={b.name} className={isCurrent ? "menu-active" : ""}>
                      <button
                        type="button"
                        disabled={busy || isCurrent}
                        onClick={() => void onCheckoutLocal(b.name)}
                        className={`flex h-auto min-h-0 flex-col items-stretch justify-start gap-0.5 py-2 text-left whitespace-normal ${busy ? "opacity-60" : ""}`}
                      >
                        <span className="flex w-full min-w-0 items-baseline justify-between gap-2">
                          <span className="min-w-0 wrap-break-word">
                            {busy ? "Switching…" : b.name}
                            {isCurrent && !busy ? (
                              <span className="ml-1.5 text-xs font-normal opacity-70">
                                (current)
                              </span>
                            ) : null}
                          </span>
                          {upstreamLabel && !busy ? (
                            <span
                              className={`shrink-0 font-mono text-[0.65rem] leading-none tracking-tight ${
                                isCurrent ? "text-inherit opacity-90" : "text-base-content/60"
                              }`}
                              title={
                                b.upstreamName
                                  ? `Ahead of ${b.upstreamName}: ${b.ahead ?? 0}; behind: ${b.behind ?? 0}`
                                  : "Commits ahead / behind configured upstream"
                              }
                            >
                              {upstreamLabel}
                            </span>
                          ) : null}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </BranchPanel>

          <BranchPanel
            title="Remote branches"
            empty={canShowBranches && remoteBranches.length === 0}
            emptyHint="No remote-tracking branches"
          >
            {canShowBranches ? (
              <ul className="menu w-full menu-sm rounded-md bg-transparent p-0">
                {remoteBranches.map((r) => {
                  const busy = branchBusy === `remote:${r}`;
                  return (
                    <li key={r}>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void onCreateFromRemote(r)}
                        className={`h-auto min-h-0 justify-start py-2 text-left font-mono text-[0.8125rem] whitespace-normal ${busy ? "opacity-60" : ""}`}
                      >
                        {busy ? "Creating…" : r}
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </BranchPanel>
        </aside>

        <div className="col-span-12 flex min-w-0 flex-col gap-4 lg:col-span-6">
          <section className="card border-base-300 bg-base-100 shadow-md">
            <div className="card-body px-6 py-5">
              {loading ? (
                <div className="flex flex-col items-center justify-center gap-3 py-4">
                  <span className="loading loading-md loading-spinner text-primary" />
                  <p className="m-0 text-center text-[0.9375rem] text-base-content/80">
                    Loading repository…
                  </p>
                </div>
              ) : loadError ? (
                <div role="alert" className="alert text-sm alert-error">
                  <span>{loadError}</span>
                </div>
              ) : repo ? (
                <>
                  {repo.error ? (
                    <>
                      <div role="status" className="alert text-sm alert-warning">
                        <span>{repo.error}</span>
                      </div>
                      <dl className="m-0 mt-4 flex flex-col gap-2.5">
                        <MetaRow label="Path">{repo.path}</MetaRow>
                      </dl>
                    </>
                  ) : (
                    <>
                      {listsError ? (
                        <div role="alert" className="mb-3 alert text-sm alert-error">
                          <span>{listsError}</span>
                        </div>
                      ) : null}

                      <div className="mb-6">
                        <h2 className="m-0 mb-3 border-b border-base-300 pb-2 text-sm font-semibold tracking-wide uppercase opacity-70">
                          Commits on current branch
                        </h2>
                        {commits.length === 0 ? (
                          <p className="m-0 text-center text-sm text-base-content/60">
                            No commits to show
                          </p>
                        ) : (
                          <ol className="m-0 max-h-[min(50vh,28rem)] list-none space-y-2 overflow-y-auto p-0">
                            {commits.map((c) => (
                              <li
                                key={c.hash}
                                className="rounded-box border border-base-300 bg-base-200 px-3 py-2"
                              >
                                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                                  <code className="shrink-0 font-mono text-[0.75rem] text-base-content/80">
                                    {c.shortHash}
                                  </code>
                                  <span className="min-w-0 flex-1 font-medium text-base-content">
                                    {c.subject}
                                  </span>
                                </div>
                                <p className="mt-1 mb-0 text-xs text-base-content/70">
                                  {c.author}
                                  {formatDate(c.date) ? (
                                    <span className="text-base-content/50">
                                      {" "}
                                      · {formatDate(c.date)}
                                    </span>
                                  ) : null}
                                </p>
                              </li>
                            ))}
                          </ol>
                        )}
                      </div>
                    </>
                  )}
                </>
              ) : (
                <p className="m-0 text-center text-[0.9375rem] text-base-content/60">
                  No repository open
                </p>
              )}
            </div>
          </section>
        </div>

        <aside className="col-span-12 flex min-h-0 flex-col gap-3 lg:sticky lg:top-6 lg:col-span-3 lg:max-h-[calc(100vh-3rem)]">
          <div className="card border-base-300 bg-base-100 shadow-sm">
            <div className="card-body min-h-0 gap-0 p-0">
              <div className="flex shrink-0 items-center justify-between gap-2 border-b border-base-300 px-3 py-2">
                <h2 className="m-0 card-title min-w-0 flex-1 text-xs font-semibold tracking-wide uppercase opacity-70">
                  Stage & commit
                </h2>
                {canShowBranches && unstagedPaths.length > 0 ? (
                  <button
                    type="button"
                    className="btn btn-ghost btn-xs"
                    disabled={stageCommitBusy}
                    onClick={() => void onStagePaths(unstagedPaths)}
                  >
                    Stage all
                  </button>
                ) : null}
              </div>
              <div className="flex max-h-[min(42vh,22rem)] min-h-16 flex-col gap-2 overflow-y-auto p-2">
                {!canShowBranches ? (
                  <p className="m-0 py-2 text-center text-xs text-base-content/50">
                    Open a repository to manage changes
                  </p>
                ) : workingTreeFiles.length === 0 ? (
                  <p className="m-0 py-2 text-center text-xs text-base-content/50">
                    No pending changes
                  </p>
                ) : (
                  <ul className="m-0 flex list-none flex-col gap-1 p-0">
                    {workingTreeFiles.map((f) => (
                      <li
                        key={f.path}
                        className="rounded-md border border-base-300 bg-base-200/80 px-2 py-1"
                      >
                        <div className="flex min-h-7 items-center gap-2">
                          <code className="min-w-0 flex-1 font-mono text-[0.7rem] leading-snug wrap-break-word text-base-content">
                            {f.path}
                          </code>
                          <div className="flex shrink-0 items-center gap-0.5">
                            {f.unstaged ? (
                              <button
                                type="button"
                                className="btn btn-square min-h-7 min-w-7 px-0 font-mono text-sm leading-none btn-xs btn-primary"
                                disabled={stageCommitBusy}
                                aria-label={`Stage ${f.path}`}
                                title="Stage"
                                onClick={() => void onStagePaths([f.path])}
                              >
                                +
                              </button>
                            ) : null}
                            {f.staged ? (
                              <button
                                type="button"
                                className="btn btn-square min-h-7 min-w-7 px-0 font-mono text-sm leading-none btn-ghost btn-xs"
                                disabled={stageCommitBusy}
                                aria-label={`Unstage ${f.path}`}
                                title="Unstage"
                                onClick={() => void onUnstagePaths([f.path])}
                              >
                                −
                              </button>
                            ) : null}
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div className="border-t border-base-300 p-3">
                <label className="form-control w-full">
                  <span className="label-text mb-1 text-xs font-medium">Commit message</span>
                  <textarea
                    className="textarea-bordered textarea min-h-18 w-full resize-y font-sans text-sm textarea-sm"
                    placeholder="Describe your changes…"
                    value={commitMessage}
                    disabled={!canShowBranches || stageCommitBusy}
                    onChange={(e) => {
                      setCommitMessage(e.target.value);
                    }}
                    rows={3}
                  />
                </label>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {stagedPaths.length > 0 ? (
                    <button
                      type="button"
                      className="btn btn-ghost btn-xs"
                      disabled={stageCommitBusy}
                      onClick={() => void onUnstagePaths(stagedPaths)}
                    >
                      Unstage all
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    disabled={!canPush}
                    title="Push the current branch to origin (commits must be committed first)"
                    onClick={() => void onPushToOrigin()}
                  >
                    {pushBusy ? <span className="loading loading-xs loading-spinner" /> : "Push"}
                  </button>
                  <button
                    type="button"
                    className="btn ml-auto btn-sm btn-primary"
                    disabled={!canCommit}
                    onClick={() => void onCommit()}
                  >
                    {stageCommitBusy ? (
                      <span className="loading loading-xs loading-spinner" />
                    ) : (
                      "Commit"
                    )}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </aside>
      </div>
    </main>
  );
}
