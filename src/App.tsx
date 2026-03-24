import { type ReactNode, useEffect, useState } from "react";
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
      <dd className="m-0 min-w-0 wrap-break-word text-[#222] dark:text-[#e8e8e8]">
        {children}
      </dd>
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
        {repo.detached
          ? `Detached at ${repo.headShort ?? "—"}`
          : (repo.branch ?? "—")}
      </MetaRow>
      {repo.headShort ? (
        <MetaRow label="HEAD">
          <code className="rounded bg-black/6 px-1.5 py-0.5 font-mono text-[0.85em] dark:bg-white/10">
            {repo.headShort}
          </code>
          {repo.headSubject ? (
            <span className="font-medium"> {repo.headSubject}</span>
          ) : null}
        </MetaRow>
      ) : null}
      {repo.headAuthor ? (
        <MetaRow label="Last commit author">{repo.headAuthor}</MetaRow>
      ) : null}
      {lastCommit ? (
        <MetaRow label="Last commit">{lastCommit}</MetaRow>
      ) : null}
      {repo.workingTreeClean !== null ? (
        <MetaRow label="Working tree">
          {repo.workingTreeClean ? (
            <span className="font-medium text-[#0a6b2d] dark:text-[#7dcea0]">
              Clean
            </span>
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

function App() {
  const [repo, setRepo] = useState<RepoMetadata | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const promise = listen("open-repo-request", async () => {
      const selected = await open({
        directory: true,
        multiple: false,
        title: "Open repository",
      });
      if (selected === null || Array.isArray(selected)) return;

      setLoading(true);
      setLoadError(null);
      try {
        const meta = await invoke<RepoMetadata>("get_repo_metadata", {
          path: selected,
        });
        setRepo(meta);
      } catch (e) {
        setRepo(null);
        setLoadError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    });

    return () => {
      void promise.then((unlisten) => unlisten());
    };
  }, []);

  return (
    <main className="box-border flex min-h-screen flex-col items-center bg-[#f0f0f0] px-6 pb-12 pt-8 text-[#0f0f0f] antialiased [font-synthesis:none] dark:bg-[#1a1a1a] dark:text-[#e8e8e8]">
      <header className="mb-10 max-w-lg text-center">
        <h1 className="mb-2 text-2xl font-semibold tracking-tight">Git GUI</h1>
        <p className="m-0 text-[0.9375rem] text-[#444] dark:text-[#b0b0b0]">
          Use <Kbd>File</Kbd> → <Kbd>Open Repository…</Kbd> to choose a local
          folder.
        </p>
      </header>

      <section
        className="w-full max-w-xl rounded-[10px] bg-white p-5 px-6 text-left shadow-[0_1px_3px_rgba(0,0,0,0.08)] dark:bg-[#252525] dark:shadow-[0_1px_3px_rgba(0,0,0,0.35)]"
        aria-live="polite"
        aria-busy={loading}
      >
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
            <div className="mb-5 text-center">
              <p className="mb-1.5 text-xs font-semibold uppercase tracking-[0.06em] text-[#666] dark:text-[#999]">
                Current repository
              </p>
              <p className="m-0 wrap-break-word text-xl font-semibold tracking-tight">
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
                <dl className="mt-4 m-0 flex flex-col gap-2.5">
                  <MetaRow label="Path">{repo.path}</MetaRow>
                </dl>
              </>
            ) : (
              <RepoMetadataDetails repo={repo} />
            )}
          </>
        ) : (
          <p className="m-0 text-center text-[0.9375rem] text-[#666] dark:text-[#999]">
            No repository open
          </p>
        )}
      </section>
    </main>
  );
}

export default App;
