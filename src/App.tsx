import { type ReactNode, useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";

const THEME_STORAGE_KEY = "git-gui-theme";

const DAISY_THEMES = [
  "light",
  "dark",
  "cupcake",
  "bumblebee",
  "corporate",
  "synthwave",
  "retro",
  "cyberpunk",
  "valentine",
  "garden",
  "forest",
  "dracula",
  "night",
  "nord",
  "sunset",
] as const;

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

function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd kbd-sm">{children}</kbd>;
}

function MetaRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[8.5rem_1fr] items-baseline gap-x-4 gap-y-2 text-sm">
      <dt className="m-0 font-semibold text-base-content/70">{label}</dt>
      <dd className="m-0 min-w-0 wrap-break-word text-base-content">{children}</dd>
    </div>
  );
}

function RepoMetadataDetails({ repo }: { repo: RepoMetadata }) {
  const lastCommit = formatDate(repo.headDate);
  return (
    <dl className="m-0 flex flex-col gap-2.5">
      <MetaRow label="Path">{repo.path}</MetaRow>
      {repo.gitRoot && repo.gitRoot !== repo.path ? (
        <MetaRow label="Git root">{repo.gitRoot}</MetaRow>
      ) : null}
      <MetaRow label="Branch">
        {repo.detached ? `Detached at ${repo.headShort ?? "—"}` : (repo.branch ?? "—")}
      </MetaRow>
      {repo.headShort ? (
        <MetaRow label="HEAD">
          <code className="rounded bg-base-300 px-1.5 py-0.5 font-mono text-[0.85em]">
            {repo.headShort}
          </code>
          {repo.headSubject ? <span className="font-medium"> {repo.headSubject}</span> : null}
        </MetaRow>
      ) : null}
      {repo.headAuthor ? <MetaRow label="Last commit author">{repo.headAuthor}</MetaRow> : null}
      {lastCommit ? <MetaRow label="Last commit">{lastCommit}</MetaRow> : null}
      {repo.workingTreeClean !== null ? (
        <MetaRow label="Working tree">
          {repo.workingTreeClean ? (
            <span className="font-medium text-success">Clean</span>
          ) : (
            <span className="font-medium text-warning">Has local changes</span>
          )}
        </MetaRow>
      ) : null}
      {repo.ahead !== null && repo.behind !== null ? (
        <MetaRow label="Upstream">
          {repo.ahead} ahead, {repo.behind} behind
        </MetaRow>
      ) : null}
      {repo.remotes.length > 0 ? (
        <MetaRow label="Remotes">
          <ul className="mb-0 ml-0 list-disc space-y-1.5 pl-[1.1rem]">
            {repo.remotes.map((r) => (
              <li key={r.name}>
                <span className="mr-1.5 font-semibold">{r.name}</span>
                <span className="font-mono text-[0.8125rem] text-base-content/80">
                  {r.fetchUrl}
                </span>
              </li>
            ))}
          </ul>
        </MetaRow>
      ) : (
        <MetaRow label="Remotes">None configured</MetaRow>
      )}
    </dl>
  );
}

function BranchPanel({
  title,
  empty,
  emptyHint,
  children,
}: {
  title: string;
  empty: boolean;
  emptyHint: string;
  children: ReactNode;
}) {
  return (
    <div className="card border-base-300 bg-base-100 shadow-sm">
      <div className="card-body min-h-0 gap-0 p-0">
        <h2 className="m-0 card-title shrink-0 border-b border-base-300 px-3 py-2 text-xs font-semibold tracking-wide uppercase opacity-70">
          {title}
        </h2>
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

function App() {
  const [theme, setTheme] = useState<string>(() => {
    if (typeof window === "undefined") return "light";
    return localStorage.getItem(THEME_STORAGE_KEY) ?? "light";
  });
  const [repo, setRepo] = useState<RepoMetadata | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [localBranches, setLocalBranches] = useState<string[]>([]);
  const [remoteBranches, setRemoteBranches] = useState<string[]>([]);
  const [commits, setCommits] = useState<CommitEntry[]>([]);
  const [branchBusy, setBranchBusy] = useState<string | null>(null);
  const [listsError, setListsError] = useState<string | null>(null);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  }, [theme]);

  const refreshLists = useCallback(async (repoPath: string) => {
    setListsError(null);
    try {
      const [locals, remotes, log] = await Promise.all([
        invoke<string[]>("list_local_branches", { path: repoPath }),
        invoke<string[]>("list_remote_branches", { path: repoPath }),
        invoke<CommitEntry[]>("list_branch_commits", { path: repoPath }),
      ]);
      setLocalBranches(locals);
      setRemoteBranches(remotes);
      setCommits(log);
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
          await refreshLists(selected);
        } else {
          setLocalBranches([]);
          setRemoteBranches([]);
          setCommits([]);
        }
      } catch (e) {
        setRepo(null);
        setLocalBranches([]);
        setRemoteBranches([]);
        setCommits([]);
        setLoadError(e instanceof Error ? e.message : String(e));
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
    const promise = listen("open-repo-request", async () => {
      const selected = await open({
        directory: true,
        multiple: false,
        title: "Open repository",
      });
      if (selected === null || Array.isArray(selected)) return;
      await loadRepo(selected);
    });

    return () => {
      void promise.then((unlisten) => unlisten());
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

  const canShowBranches = Boolean(repo && !repo.error && !loading);
  const currentBranchName = repo?.detached ? null : (repo?.branch ?? null);

  return (
    <main className="box-border flex min-h-screen flex-col bg-base-200 px-4 pt-6 pb-8 text-base-content antialiased [font-synthesis:none]">
      <header className="mb-6 flex max-w-4xl flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="mb-1 text-2xl font-semibold tracking-tight">Git GUI</h1>
          <p className="m-0 text-[0.9375rem] text-base-content/80">
            Use <Kbd>File</Kbd> → <Kbd>Open Repository…</Kbd> to choose a local folder.
          </p>
        </div>
        <div className="flex w-full max-w-xs shrink-0 flex-col gap-1">
          <span className="text-xs opacity-70">Theme</span>
          <select
            className="select-bordered select w-full select-sm"
            value={theme}
            onChange={(e) => setTheme(e.target.value)}
            aria-label="Theme"
          >
            {DAISY_THEMES.map((t) => (
              <option key={t} value={t}>
                {t.charAt(0).toUpperCase() + t.slice(1)}
              </option>
            ))}
          </select>
        </div>
      </header>

      <div
        className="grid flex-1 grid-cols-1 gap-4 lg:grid-cols-[minmax(200px,280px)_minmax(0,1fr)] lg:items-start"
        aria-live="polite"
        aria-busy={loading}
      >
        <aside className="flex min-h-0 flex-col gap-3 lg:sticky lg:top-6 lg:max-h-[calc(100vh-3rem)]">
          <BranchPanel
            title="Local branches"
            empty={canShowBranches && localBranches.length === 0}
            emptyHint="No local branches"
          >
            {canShowBranches ? (
              <ul className="menu w-full menu-sm rounded-md bg-transparent p-0">
                {localBranches.map((b) => {
                  const isCurrent = currentBranchName === b;
                  const busy = branchBusy === `local:${b}`;
                  return (
                    <li key={b} className={isCurrent ? "menu-active" : ""}>
                      <button
                        type="button"
                        disabled={busy || isCurrent}
                        onClick={() => void onCheckoutLocal(b)}
                        className={`h-auto min-h-0 justify-start py-2 text-left whitespace-normal ${busy ? "opacity-60" : ""}`}
                      >
                        {busy ? "Switching…" : b}
                        {isCurrent && !busy ? (
                          <span className="ml-1.5 text-xs font-normal opacity-70">(current)</span>
                        ) : null}
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

        <div className="flex min-w-0 flex-col gap-4">
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
                  <div className="mb-4 text-center">
                    <p className="mb-1.5 text-xs font-semibold tracking-wide uppercase opacity-70">
                      Current repository
                    </p>
                    <p className="m-0 text-xl font-semibold tracking-tight wrap-break-word">
                      {repo.name}
                    </p>
                  </div>

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

                      <div>
                        <h2 className="m-0 mb-3 border-b border-base-300 pb-2 text-sm font-semibold tracking-wide uppercase opacity-70">
                          Details
                        </h2>
                        <RepoMetadataDetails repo={repo} />
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
      </div>
    </main>
  );
}

export default App;
