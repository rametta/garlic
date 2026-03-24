import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import "./App.css";

function repoNameFromPath(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, "");
  const segments = trimmed.split(/[/\\]/);
  return segments[segments.length - 1] || trimmed;
}

function App() {
  const [repoName, setRepoName] = useState<string | null>(null);

  useEffect(() => {
    const promise = listen("open-repo-request", async () => {
      const selected = await open({
        directory: true,
        multiple: false,
        title: "Open repository",
      });
      if (selected === null || Array.isArray(selected)) return;
      setRepoName(repoNameFromPath(selected));
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

      <section className="repo-panel" aria-live="polite">
        {repoName ? (
          <>
            <p className="repo-label">Current repository</p>
            <p className="repo-name">{repoName}</p>
          </>
        ) : (
          <p className="repo-empty">No repository open</p>
        )}
      </section>
    </main>
  );
}

export default App;
