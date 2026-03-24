import { type ReactNode, useCallback, useEffect, useState } from "react";
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
  return (
    <kbd className="rounded border border-black/10 bg-black/6 px-1.5 py-0.5 text-[0.875em] font-normal dark:border-white/12 dark:bg-white/8">
      {children}
    </kbd>
  );
}

function MetaRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[8.5rem_1fr] items-baseline gap-x-4 gap-y-2 text-sm">
      <dt className="m-0 font-semibold text-[#555] dark:text-[#aaa]">{label}</dt>
      <dd className="m-0 min-w-0 wrap-break-word text-[#222] dark:text-[#e8e8e8]">{children}</dd>
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
          <code className="rounded bg-black/6 px-1.5 py-0.5 font-mono text-[0.85em] dark:bg-white/10">
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
            <span className="font-medium text-[#0a6b2d] dark:text-[#7dcea0]">Clean</span>
          ) : (
            <span className="font-medium text-[#8a4b00] dark:text-[#f0c27a]">
              Has local changes
            </span>
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
                <span className="font-mono text-[0.8125rem] text-[#444] dark:text-[#b0b0b0]">
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
    <div className="flex min-h-0 flex-col rounded-lg border border-black/8 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.04)] dark:border-white/10 dark:bg-[#2a2a2a] dark:shadow-none">
      <h2 className="m-0 shrink-0 border-b border-black/8 px-3 py-2 text-xs font-semibold tracking-[0.06em] text-[#555] uppercase dark:border-white/10 dark:text-[#aaa]">
        {title}
      </h2>
      <div className="max-h-[40vh] min-h-16 overflow-y-auto p-2">
        {empty ? (
          <p className="m-0 py-2 text-center text-xs text-[#888] dark:text-[#777]">{emptyHint}</p>
        ) : (
          children
        )}
      </div>
    </div>
  );
}

function App() {
  const [repo, setRepo] = useState<RepoMetadata | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [localBranches, setLocalBranches] = useState<string[]>([]);
  const [remoteBranches, setRemoteBranches] = useState<string[]>([]);
  const [commits, setCommits] = useState<CommitEntry[]>([]);
  const [branchBusy, setBranchBusy] = useState<string | null>(null);
  const [listsError, setListsError] = useState<string | null>(null);

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
    <main className="box-border flex min-h-screen flex-col bg-[#f0f0f0] px-4 pt-6 pb-8 text-[#0f0f0f] antialiased [font-synthesis:none] dark:bg-[#1a1a1a] dark:text-[#e8e8e8]">
      <header className="mb-6 max-w-4xl">
        <h1 className="mb-1 text-2xl font-semibold tracking-tight">Git GUI</h1>
        <p className="m-0 text-[0.9375rem] text-[#444] dark:text-[#b0b0b0]">
          Use <Kbd>File</Kbd> → <Kbd>Open Repository…</Kbd> to choose a local folder.
        </p>
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
              <ul className="m-0 list-none space-y-1 p-0">
                {localBranches.map((b) => {
                  const isCurrent = currentBranchName === b;
                  const busy = branchBusy === `local:${b}`;
                  return (
                    <li key={b}>
                      <button
                        type="button"
                        disabled={busy || isCurrent}
                        onClick={() => void onCheckoutLocal(b)}
                        className={`w-full rounded-md px-2.5 py-1.5 text-left text-sm transition-colors disabled:cursor-default ${
                          isCurrent
                            ? "cursor-default bg-black/10 font-semibold dark:bg-white/15"
                            : "bg-black/4 hover:bg-black/10 dark:bg-white/8 dark:hover:bg-white/14"
                        } ${busy ? "opacity-60" : ""}`}
                      >
                        {busy ? "Switching…" : b}
                        {isCurrent && !busy ? (
                          <span className="ml-1.5 text-xs font-normal text-[#666] dark:text-[#999]">
                            (current)
                          </span>
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
              <ul className="m-0 list-none space-y-1 p-0">
                {remoteBranches.map((r) => {
                  const busy = branchBusy === `remote:${r}`;
                  return (
                    <li key={r}>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void onCreateFromRemote(r)}
                        className={`w-full rounded-md bg-black/4 px-2.5 py-1.5 text-left font-mono text-[0.8125rem] transition-colors hover:bg-black/10 disabled:opacity-60 dark:bg-white/8 dark:hover:bg-white/14`}
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
          <section className="rounded-[10px] bg-white p-5 px-6 shadow-[0_1px_3px_rgba(0,0,0,0.08)] dark:bg-[#252525] dark:shadow-[0_1px_3px_rgba(0,0,0,0.35)]">
            {loading ? (
              <p className="m-0 text-center text-[0.9375rem] text-[#444] dark:text-[#b0b0b0]">
                Loading repository…
              </p>
            ) : loadError ? (
              <p
                className="m-0 text-center text-[0.9375rem] text-[#a30] dark:text-[#f88]"
                role="alert"
              >
                {loadError}
              </p>
            ) : repo ? (
              <>
                <div className="mb-4 text-center">
                  <p className="mb-1.5 text-xs font-semibold tracking-[0.06em] text-[#666] uppercase dark:text-[#999]">
                    Current repository
                  </p>
                  <p className="m-0 text-xl font-semibold tracking-tight wrap-break-word">
                    {repo.name}
                  </p>
                </div>

                {repo.error ? (
                  <>
                    <p
                      className="mb-0 rounded-lg bg-[rgba(180,120,0,0.12)] px-4 py-3 text-[0.9375rem] text-[#5c4a00] dark:bg-[rgba(220,180,60,0.15)] dark:text-[#e8d48a]"
                      role="status"
                    >
                      {repo.error}
                    </p>
                    <dl className="m-0 mt-4 flex flex-col gap-2.5">
                      <MetaRow label="Path">{repo.path}</MetaRow>
                    </dl>
                  </>
                ) : (
                  <>
                    {listsError ? (
                      <p
                        className="mb-3 rounded-lg bg-[rgba(160,60,0,0.1)] px-3 py-2 text-sm text-[#8a3000] dark:bg-[rgba(220,100,40,0.15)] dark:text-[#f0a070]"
                        role="alert"
                      >
                        {listsError}
                      </p>
                    ) : null}

                    <div className="mb-6">
                      <h2 className="m-0 mb-3 border-b border-black/10 pb-2 text-sm font-semibold tracking-[0.06em] text-[#555] uppercase dark:border-white/12 dark:text-[#aaa]">
                        Commits on current branch
                      </h2>
                      {commits.length === 0 ? (
                        <p className="m-0 text-center text-sm text-[#666] dark:text-[#999]">
                          No commits to show
                        </p>
                      ) : (
                        <ol className="m-0 max-h-[min(50vh,28rem)] list-none space-y-2 overflow-y-auto p-0">
                          {commits.map((c) => (
                            <li
                              key={c.hash}
                              className="rounded-lg border border-black/6 bg-black/2 px-3 py-2 dark:border-white/8 dark:bg-white/4"
                            >
                              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                                <code className="shrink-0 font-mono text-[0.75rem] text-[#444] dark:text-[#b8b8b8]">
                                  {c.shortHash}
                                </code>
                                <span className="min-w-0 flex-1 font-medium text-[#111] dark:text-[#eee]">
                                  {c.subject}
                                </span>
                              </div>
                              <p className="mt-1 mb-0 text-xs text-[#666] dark:text-[#999]">
                                {c.author}
                                {formatDate(c.date) ? (
                                  <span className="text-[#888] dark:text-[#777]">
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
                      <h2 className="m-0 mb-3 border-b border-black/10 pb-2 text-sm font-semibold tracking-[0.06em] text-[#555] uppercase dark:border-white/12 dark:text-[#aaa]">
                        Details
                      </h2>
                      <RepoMetadataDetails repo={repo} />
                    </div>
                  </>
                )}
              </>
            ) : (
              <p className="m-0 text-center text-[0.9375rem] text-[#666] dark:text-[#999]">
                No repository open
              </p>
            )}
          </section>
        </div>
      </div>
    </main>
  );
}

export default App;
