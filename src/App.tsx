import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import "./App.css";

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

function RepoMetadataDetails({ repo }: { repo: RepoMetadata }) {
  const lastCommit = formatDate(repo.headDate);
  return (
    <dl className="repo-meta">
      <div className="repo-meta-row">
        <dt>Path</dt>
        <dd>{repo.path}</dd>
      </div>
      {repo.gitRoot && repo.gitRoot !== repo.path ? (
        <div className="repo-meta-row">
          <dt>Git root</dt>
          <dd>{repo.gitRoot}</dd>
        </div>
      ) : null}
      <div className="repo-meta-row">
        <dt>Branch</dt>
        <dd>
          {repo.detached
            ? `Detached at ${repo.headShort ?? "—"}`
            : (repo.branch ?? "—")}
        </dd>
      </div>
      {repo.headShort ? (
        <div className="repo-meta-row">
          <dt>HEAD</dt>
          <dd>
            <code className="repo-hash">{repo.headShort}</code>
            {repo.headSubject ? (
              <span className="repo-subject"> {repo.headSubject}</span>
            ) : null}
          </dd>
        </div>
      ) : null}
      {repo.headAuthor ? (
        <div className="repo-meta-row">
          <dt>Last commit author</dt>
          <dd>{repo.headAuthor}</dd>
        </div>
      ) : null}
      {lastCommit ? (
        <div className="repo-meta-row">
          <dt>Last commit</dt>
          <dd>{lastCommit}</dd>
        </div>
      ) : null}
      {repo.workingTreeClean !== null ? (
        <div className="repo-meta-row">
          <dt>Working tree</dt>
          <dd>
            {repo.workingTreeClean ? (
              <span className="repo-clean">Clean</span>
            ) : (
              <span className="repo-dirty">Has local changes</span>
            )}
          </dd>
        </div>
      ) : null}
      {repo.ahead !== null && repo.behind !== null ? (
        <div className="repo-meta-row">
          <dt>Upstream</dt>
          <dd>
            {repo.ahead} ahead, {repo.behind} behind
          </dd>
        </div>
      ) : null}
      {repo.remotes.length > 0 ? (
        <div className="repo-meta-row repo-meta-row--block">
          <dt>Remotes</dt>
          <dd>
            <ul className="repo-remote-list">
              {repo.remotes.map((r) => (
                <li key={r.name}>
                  <span className="repo-remote-name">{r.name}</span>
                  <span className="repo-remote-url">{r.fetchUrl}</span>
                </li>
              ))}
            </ul>
          </dd>
        </div>
      ) : (
        <div className="repo-meta-row">
          <dt>Remotes</dt>
          <dd>None configured</dd>
        </div>
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
    <main className="main">
      <header className="main-header">
        <h1 className="title">Git GUI</h1>
        <p className="subtitle">
          Use <kbd>File</kbd> → <kbd>Open Repository…</kbd> to choose a local
          folder.
        </p>
      </header>

      <section
        className="repo-panel"
        aria-live="polite"
        aria-busy={loading}
      >
        {loading ? (
          <p className="repo-status">Loading repository…</p>
        ) : loadError ? (
          <p className="repo-error" role="alert">
            {loadError}
          </p>
        ) : repo ? (
          <>
            <div className="repo-panel-heading">
              <p className="repo-label">Current repository</p>
              <p className="repo-name">{repo.name}</p>
            </div>

            {repo.error ? (
              <>
                <p className="repo-warn" role="status">
                  {repo.error}
                </p>
                <dl className="repo-meta">
                  <div className="repo-meta-row">
                    <dt>Path</dt>
                    <dd>{repo.path}</dd>
                  </div>
                </dl>
              </>
            ) : (
              <RepoMetadataDetails repo={repo} />
            )}
          </>
        ) : (
          <p className="repo-empty">No repository open</p>
        )}
      </section>
    </main>
  );
}

export default App;
