import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { UnifiedDiff } from "./components/UnifiedDiff";
import { resolveThemePreference } from "./theme";

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

/** Short relative label for dense commit rows (e.g. `2h ago`, `3d ago`). */
function formatRelativeShort(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  const t = d.getTime();
  if (Number.isNaN(t)) return null;
  const diffSec = Math.round((Date.now() - t) / 1000);
  if (diffSec < 0) {
    return formatDate(iso);
  }
  if (diffSec < 45) {
    return "now";
  }
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) {
    return `${diffMin}m ago`;
  }
  const diffH = Math.round(diffMin / 60);
  if (diffH < 24) {
    return `${diffH}h ago`;
  }
  const diffD = Math.round(diffH / 24);
  if (diffD < 7) {
    return `${diffD}d ago`;
  }
  const diffW = Math.round(diffD / 7);
  if (diffW < 8) {
    return `${diffW}w ago`;
  }
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: d.getFullYear() !== new Date().getFullYear() ? "numeric" : undefined,
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

export default function App({
  startup,
  themePreference: initialThemePreference,
}: {
  startup: RestoreLastRepo;
  /** Persisted value: `auto` or a DaisyUI theme name. */
  themePreference: string;
}) {
  const [themePreference, setThemePreference] = useState(initialThemePreference);
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
  const [selectedDiffPath, setSelectedDiffPath] = useState<string | null>(null);
  const [diffStagedText, setDiffStagedText] = useState<string | null>(null);
  const [diffUnstagedText, setDiffUnstagedText] = useState<string | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [commitBrowseHash, setCommitBrowseHash] = useState<string | null>(null);
  const [commitBrowseFiles, setCommitBrowseFiles] = useState<string[]>([]);
  const [commitBrowseLoading, setCommitBrowseLoading] = useState(false);
  const [commitBrowseError, setCommitBrowseError] = useState<string | null>(null);
  const [commitDiffPath, setCommitDiffPath] = useState<string | null>(null);
  const [commitDiffText, setCommitDiffText] = useState<string | null>(null);
  const [commitDiffLoading, setCommitDiffLoading] = useState(false);
  const [commitDiffError, setCommitDiffError] = useState<string | null>(null);
  const [stageCommitBusy, setStageCommitBusy] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  const createBranchDialogRef = useRef<HTMLDialogElement>(null);
  const newBranchInputRef = useRef<HTMLInputElement>(null);
  const [newBranchName, setNewBranchName] = useState("");
  const [createBranchFieldError, setCreateBranchFieldError] = useState<string | null>(null);
  const refreshLists = useCallback(async (repoPath: string): Promise<WorkingTreeFile[] | null> => {
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
      return worktree;
    } catch (e) {
      setListsError(e instanceof Error ? e.message : String(e));
      return null;
    }
  }, []);

  const clearCommitBrowse = useCallback(() => {
    setCommitBrowseHash(null);
    setCommitBrowseFiles([]);
    setCommitBrowseLoading(false);
    setCommitBrowseError(null);
    setCommitDiffPath(null);
    setCommitDiffText(null);
    setCommitDiffLoading(false);
    setCommitDiffError(null);
  }, []);

  const loadDiffForFile = useCallback(
    async (f: WorkingTreeFile) => {
      if (!repo?.path || repo.error) return;
      if (!f.staged && !f.unstaged) return;
      clearCommitBrowse();
      setSelectedDiffPath(f.path);
      setDiffLoading(true);
      setDiffError(null);
      setDiffStagedText(null);
      setDiffUnstagedText(null);
      try {
        const [staged, unstaged] = await Promise.all([
          f.staged
            ? invoke<string>("get_staged_diff", { path: repo.path, filePath: f.path })
            : Promise.resolve<string | null>(null),
          f.unstaged
            ? invoke<string>("get_unstaged_diff", { path: repo.path, filePath: f.path })
            : Promise.resolve<string | null>(null),
        ]);
        setDiffStagedText(staged);
        setDiffUnstagedText(unstaged);
      } catch (e) {
        setDiffError(e instanceof Error ? e.message : String(e));
      } finally {
        setDiffLoading(false);
      }
    },
    [repo, clearCommitBrowse],
  );

  const selectCommit = useCallback(
    async (hash: string) => {
      if (!repo?.path || repo.error) return;
      setSelectedDiffPath(null);
      setDiffStagedText(null);
      setDiffUnstagedText(null);
      setDiffError(null);
      setCommitBrowseHash(hash);
      setCommitBrowseFiles([]);
      setCommitDiffPath(null);
      setCommitDiffText(null);
      setCommitDiffError(null);
      setCommitBrowseLoading(true);
      setCommitBrowseError(null);
      try {
        const files = await invoke<string[]>("list_commit_files", {
          path: repo.path,
          commitHash: hash,
        });
        setCommitBrowseFiles(files);
      } catch (e) {
        setCommitBrowseError(e instanceof Error ? e.message : String(e));
      } finally {
        setCommitBrowseLoading(false);
      }
    },
    [repo],
  );

  const loadCommitFileDiff = useCallback(
    async (filePath: string, commitHash: string) => {
      if (!repo?.path || repo.error || !commitHash.trim()) return;
      setCommitDiffPath(filePath);
      setCommitDiffLoading(true);
      setCommitDiffError(null);
      setCommitDiffText(null);
      try {
        const text = await invoke<string>("get_commit_file_diff", {
          path: repo.path,
          commitHash,
          filePath,
        });
        setCommitDiffText(text);
      } catch (e) {
        setCommitDiffError(e instanceof Error ? e.message : String(e));
      } finally {
        setCommitDiffLoading(false);
      }
    },
    [repo],
  );

  const backFromCommitFileDiff = useCallback(() => {
    setCommitDiffPath(null);
    setCommitDiffText(null);
    setCommitDiffError(null);
    setCommitDiffLoading(false);
  }, []);

  const clearDiffSelection = useCallback(() => {
    setSelectedDiffPath(null);
    setDiffStagedText(null);
    setDiffUnstagedText(null);
    setDiffError(null);
    setDiffLoading(false);
  }, []);

  const loadRepo = useCallback(
    async (selected: string) => {
      setLoading(true);
      setLoadError(null);
      clearCommitBrowse();
      setSelectedDiffPath(null);
      setDiffStagedText(null);
      setDiffUnstagedText(null);
      setDiffError(null);
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
    [refreshLists, clearCommitBrowse],
  );

  const refreshAfterMutation = useCallback(async () => {
    if (!repo?.path || repo.error) return;
    try {
      const meta = await invoke<RepoMetadata>("get_repo_metadata", {
        path: repo.path,
      });
      setRepo(meta);
      if (!meta.error) {
        const files = await refreshLists(repo.path);
        if (selectedDiffPath && files) {
          const next = files.find((w) => w.path === selectedDiffPath);
          if (next && (next.staged || next.unstaged)) {
            void loadDiffForFile(next);
          } else {
            setSelectedDiffPath(null);
            setDiffStagedText(null);
            setDiffUnstagedText(null);
            setDiffError(null);
          }
        }
      }
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }, [repo, refreshLists, selectedDiffPath, loadDiffForFile]);

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
        const pref = e.payload.theme;
        setThemePreference(pref);
        document.documentElement.setAttribute("data-theme", resolveThemePreference(pref));
      }),
      listen("window-focused", () => {
        void refreshAfterMutation();
      }),
    ]);

    return () => {
      void promise.then((listeners) => {
        for (const u of listeners) {
          u();
        }
      });
    };
  }, [loadRepo, refreshAfterMutation]);

  useEffect(() => {
    if (themePreference !== "auto") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      document.documentElement.setAttribute("data-theme", mq.matches ? "dark" : "light");
    };
    apply();
    mq.addEventListener("change", apply);
    return () => {
      mq.removeEventListener("change", apply);
    };
  }, [themePreference]);

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
  const commitsSectionTitle =
    currentBranchName ??
    (repo?.detached
      ? repo.headShort
        ? `Detached (${repo.headShort})`
        : "Detached HEAD"
      : (repo?.headShort ?? "Current branch"));

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
    !repo?.detached &&
    !stageCommitBusy &&
    !pushBusy;

  const showExpandedDiff =
    Boolean(selectedDiffPath || commitDiffPath) && !listsError && Boolean(repo && !repo.error);

  return (
    <main className="box-border flex min-h-screen flex-col bg-base-200 px-4 pt-6 pb-8 text-base-content antialiased [font-synthesis:none]">
      <div
        className="grid min-h-0 min-w-0 flex-1 grid-cols-12 gap-4 lg:min-h-[calc(100vh-5rem)] lg:items-stretch"
        aria-live="polite"
        aria-busy={loading}
      >
        <aside className="col-span-12 flex min-h-0 min-w-0 flex-col gap-3 lg:sticky lg:top-6 lg:col-span-3">
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

        <div
          className={`col-span-12 flex min-w-0 flex-col gap-4 lg:col-span-6 ${
            showExpandedDiff ? "min-h-0 min-w-0 lg:flex lg:h-full lg:flex-col" : ""
          }`}
        >
          <section
            className={`card w-full min-w-0 border-base-300 bg-base-100 shadow-md ${
              showExpandedDiff ? "flex min-h-0 min-w-0 flex-1 flex-col" : ""
            }`}
          >
            <div
              className={`card-body px-6 py-5 ${
                showExpandedDiff ? "flex min-h-0 min-w-0 flex-1 flex-col gap-0" : ""
              }`}
            >
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

                      {!listsError && selectedDiffPath ? (
                        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
                          <div className="flex shrink-0 flex-wrap items-start justify-between gap-3 border-b border-base-300 pb-3">
                            <div className="min-w-0">
                              <h2 className="m-0 font-mono text-sm font-semibold tracking-wide text-base-content opacity-90">
                                Diff
                              </h2>
                              <code className="mt-1 block font-mono text-xs wrap-break-word text-base-content/80">
                                {selectedDiffPath}
                              </code>
                            </div>
                            <button
                              type="button"
                              className="btn shrink-0 btn-ghost btn-sm"
                              onClick={clearDiffSelection}
                            >
                              Back to commits
                            </button>
                          </div>
                          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                            {diffLoading ? (
                              <div className="flex flex-1 flex-col items-center justify-center gap-3 py-20">
                                <span className="loading loading-md loading-spinner text-primary" />
                                <p className="m-0 text-sm text-base-content/70">Loading diff…</p>
                              </div>
                            ) : diffError ? (
                              <div role="alert" className="alert text-sm alert-error">
                                <span className="wrap-break-word">{diffError}</span>
                              </div>
                            ) : (
                              <div className="min-h-0 w-full min-w-0 flex-1 overflow-auto rounded-lg border border-base-300 bg-base-200/40 p-4">
                                {diffStagedText !== null ? (
                                  <div className="mb-8 last:mb-0">
                                    <div className="m-0 mb-2 text-xs font-semibold tracking-wide uppercase opacity-70">
                                      Staged
                                    </div>
                                    <UnifiedDiff
                                      text={diffStagedText}
                                      emptyLabel="(no staged diff)"
                                    />
                                  </div>
                                ) : null}
                                {diffUnstagedText !== null ? (
                                  <div>
                                    <div className="m-0 mb-2 text-xs font-semibold tracking-wide uppercase opacity-70">
                                      Unstaged
                                    </div>
                                    <UnifiedDiff
                                      text={diffUnstagedText}
                                      emptyLabel="(no unstaged diff)"
                                    />
                                  </div>
                                ) : null}
                              </div>
                            )}
                          </div>
                        </div>
                      ) : !listsError && commitDiffPath && commitBrowseHash ? (
                        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
                          <div className="flex shrink-0 flex-wrap items-start justify-between gap-3 border-b border-base-300 pb-3">
                            <div className="min-w-0">
                              <h2 className="m-0 font-mono text-sm font-semibold tracking-wide text-base-content opacity-90">
                                Commit diff
                              </h2>
                              <code className="mt-1 block font-mono text-xs wrap-break-word text-base-content/80">
                                {commitDiffPath}
                              </code>
                              <p className="mt-1 mb-0 font-mono text-[0.65rem] text-base-content/60">
                                {commits.find((x) => x.hash === commitBrowseHash)?.shortHash ??
                                  commitBrowseHash.slice(0, 7)}
                              </p>
                            </div>
                            <button
                              type="button"
                              className="btn shrink-0 btn-ghost btn-sm"
                              onClick={backFromCommitFileDiff}
                            >
                              Back to files
                            </button>
                          </div>
                          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                            {commitDiffLoading ? (
                              <div className="flex flex-1 flex-col items-center justify-center gap-3 py-20">
                                <span className="loading loading-md loading-spinner text-primary" />
                                <p className="m-0 text-sm text-base-content/70">Loading diff…</p>
                              </div>
                            ) : commitDiffError ? (
                              <div role="alert" className="alert text-sm alert-error">
                                <span className="wrap-break-word">{commitDiffError}</span>
                              </div>
                            ) : (
                              <div className="min-h-0 w-full min-w-0 flex-1 overflow-auto rounded-lg border border-base-300 bg-base-200/40 p-4">
                                <div className="mb-8 last:mb-0">
                                  <div className="m-0 mb-2 text-xs font-semibold tracking-wide uppercase opacity-70">
                                    Commit
                                  </div>
                                  <UnifiedDiff
                                    text={commitDiffText ?? ""}
                                    emptyLabel="(no diff for this file)"
                                  />
                                </div>
                              </div>
                            )}
                          </div>
                        </div>
                      ) : !listsError && commitBrowseHash ? (
                        <div className="mb-6 flex min-h-0 min-w-0 flex-col gap-3">
                          <div className="flex shrink-0 flex-wrap items-start justify-between gap-3 border-b border-base-300 pb-2">
                            <div className="min-w-0">
                              <h2 className="m-0 font-mono text-sm font-semibold tracking-wide text-base-content opacity-90">
                                Files in commit
                              </h2>
                              <p className="mt-1 mb-0 font-mono text-[0.65rem] text-base-content/70">
                                {commits.find((x) => x.hash === commitBrowseHash)?.subject ??
                                  commitBrowseHash.slice(0, 7)}
                              </p>
                            </div>
                            <button
                              type="button"
                              className="btn shrink-0 btn-ghost btn-sm"
                              onClick={clearCommitBrowse}
                            >
                              Back to commits
                            </button>
                          </div>
                          {commitBrowseLoading ? (
                            <div className="flex flex-col items-center justify-center gap-3 py-12">
                              <span className="loading loading-md loading-spinner text-primary" />
                              <p className="m-0 text-sm text-base-content/70">Loading files…</p>
                            </div>
                          ) : commitBrowseError ? (
                            <div role="alert" className="alert text-sm alert-error">
                              <span className="wrap-break-word">{commitBrowseError}</span>
                            </div>
                          ) : commitBrowseFiles.length === 0 ? (
                            <p className="m-0 text-center text-sm text-base-content/60">
                              No files changed in this commit
                            </p>
                          ) : (
                            <ul className="m-0 max-h-[min(52vh,28rem)] list-none space-y-1 overflow-y-auto p-0">
                              {commitBrowseFiles.map((fp) => (
                                <li key={fp}>
                                  <button
                                    type="button"
                                    className="w-full rounded-md border border-base-300 bg-base-200 px-2 py-2 text-left transition-colors hover:bg-base-300/50"
                                    onClick={() =>
                                      void loadCommitFileDiff(fp, commitBrowseHash ?? "")
                                    }
                                  >
                                    <code className="font-mono text-[0.75rem] wrap-break-word text-base-content">
                                      {fp}
                                    </code>
                                  </button>
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      ) : (
                        <div className="mb-4 min-w-0">
                          <h2 className="m-0 mb-1.5 border-b border-base-300 pb-1.5 text-[0.65rem] font-semibold tracking-wide text-base-content/50 uppercase">
                            Commits
                          </h2>
                          {commits.length === 0 ? (
                            <p className="m-0 text-center text-xs text-base-content/60">
                              No commits to show
                            </p>
                          ) : (
                            <>
                              <div className="mb-0.5 grid grid-cols-[minmax(0,5.5rem)_0.875rem_minmax(0,1fr)_minmax(0,3.5rem)] items-center gap-x-1.5 border-b border-base-300/80 px-1 pb-0.5 text-[0.6rem] font-semibold tracking-wide text-base-content/45 uppercase">
                                <span className="truncate">Branch / tag</span>
                                <span className="text-center">Graph</span>
                                <span className="min-w-0 truncate">Commit message</span>
                                <span className="text-right" />
                              </div>
                              <ol className="m-0 list-none p-0">
                                {commits.map((c, idx) => {
                                  const isBrowsing = commitBrowseHash === c.hash;
                                  const branchCell =
                                    idx === 0 ? (
                                      <span
                                        className="flex min-w-0 items-center gap-0.5 truncate text-[0.65rem] leading-tight text-base-content"
                                        title={commitsSectionTitle}
                                      >
                                        <span className="shrink-0 text-primary" aria-hidden>
                                          ✓
                                        </span>
                                        <span className="min-w-0 truncate font-medium">
                                          {commitsSectionTitle}
                                        </span>
                                      </span>
                                    ) : (
                                      <span />
                                    );
                                  const rel = formatRelativeShort(c.date);
                                  const fullTitle = [
                                    `${c.shortHash} — ${c.subject}`,
                                    c.author,
                                    formatDate(c.date) ?? undefined,
                                  ]
                                    .filter(Boolean)
                                    .join("\n");
                                  return (
                                    <li
                                      key={c.hash}
                                      className="border-b border-base-300/40 last:border-b-0"
                                    >
                                      <button
                                        type="button"
                                        title={fullTitle}
                                        className={`grid w-full grid-cols-[minmax(0,5.5rem)_0.875rem_minmax(0,1fr)_minmax(0,3.5rem)] items-center gap-x-1.5 px-1 py-0.5 text-left text-[0.6875rem] leading-tight transition-colors ${
                                          isBrowsing
                                            ? "bg-primary/20 ring-1 ring-primary/35 ring-inset"
                                            : "hover:bg-base-300/40"
                                        }`}
                                        onClick={() => void selectCommit(c.hash)}
                                      >
                                        <div className="min-w-0">{branchCell}</div>
                                        <div
                                          className="relative flex min-h-4.5 w-3.5 shrink-0 flex-col items-center justify-start pt-0.5"
                                          aria-hidden
                                        >
                                          <span className="absolute top-0 bottom-0 left-1/2 w-px -translate-x-1/2 bg-primary/35" />
                                          <span className="relative z-1 mt-px h-1.5 w-1.5 shrink-0 rounded-full border-base-100 bg-primary ring-1 ring-base-100" />
                                        </div>
                                        <span className="min-w-0 truncate text-base-content/90">
                                          {c.subject}
                                        </span>
                                        <span
                                          className="shrink-0 text-right text-[0.6rem] text-base-content/45 tabular-nums"
                                          title={formatDate(c.date) ?? undefined}
                                        >
                                          {rel ?? "—"}
                                        </span>
                                      </button>
                                    </li>
                                  );
                                })}
                              </ol>
                            </>
                          )}
                        </div>
                      )}
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

        <aside className="col-span-12 flex min-h-0 min-w-0 flex-col gap-3 lg:sticky lg:top-6 lg:col-span-3">
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
              <div className="max-h-[min(52vh,28rem)] min-h-16 overflow-y-auto p-2">
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
                    {workingTreeFiles.map((f) => {
                      const selectable = f.staged || f.unstaged;
                      const selected = selectedDiffPath === f.path;
                      return (
                        <li
                          key={f.path}
                          role={selectable ? "button" : undefined}
                          tabIndex={selectable ? 0 : undefined}
                          className={`rounded-md border bg-base-200/80 px-2 py-1 ${
                            selectable
                              ? `cursor-pointer transition-colors hover:bg-base-300/50 ${
                                  selected
                                    ? "border-primary ring-1 ring-primary/40"
                                    : "border-base-300"
                                }`
                              : "border-base-300"
                          }`}
                          onClick={() => {
                            if (!selectable) return;
                            void loadDiffForFile(f);
                          }}
                          onKeyDown={(e) => {
                            if (!selectable) return;
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              void loadDiffForFile(f);
                            }
                          }}
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
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    void onStagePaths([f.path]);
                                  }}
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
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    void onUnstagePaths([f.path]);
                                  }}
                                >
                                  −
                                </button>
                              ) : null}
                            </div>
                          </div>
                        </li>
                      );
                    })}
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
