import { invoke } from "@tauri-apps/api/core";
import React from "react";
import ReactDOM from "react-dom/client";
import App, { type RestoreLastRepo } from "./App";
import "./index.css";

export interface AppBootstrap {
  repo: RestoreLastRepo;
  theme: string | null;
}

export const emptyAppBootstrap: AppBootstrap = {
  repo: {
    loadError: null,
    metadata: null,
    localBranches: [],
    remoteBranches: [],
    commits: [],
    workingTreeFiles: [],
    listsError: null,
  },
  theme: null,
};

async function bootstrap() {
  let data: AppBootstrap = emptyAppBootstrap;
  try {
    data = await invoke<AppBootstrap>("restore_app_bootstrap");
  } catch {
    console.warn("Could not load 'restore_app_bootstrap'");
  }

  document.documentElement.setAttribute("data-theme", data.theme ?? "light");

  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <App startup={data.repo} />
    </React.StrictMode>,
  );
}

void bootstrap();
