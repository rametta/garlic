import { invoke } from "@tauri-apps/api/core";
import React from "react";
import ReactDOM from "react-dom/client";
import App, { type RestoreLastRepo } from "./App";
import type { BranchSidebarSectionsState } from "./repoTypes";
import "./index.css";
import { DEFAULT_OPENAI_MODEL } from "./generateCommitMessage";
import { resolveThemePreference } from "./theme";

export interface AppBootstrap {
  repo: RestoreLastRepo;
  theme: string | null;
  openaiApiKey: string | null;
  openaiModel: string;
  branchSidebarSections: BranchSidebarSectionsState;
}

export const emptyAppBootstrap: AppBootstrap = {
  repo: {
    loadError: null,
    metadata: null,
    localBranches: [],
    remoteBranches: [],
    tags: [],
    stashes: [],
    commits: [],
    graphCommitsHasMore: false,
    workingTreeFiles: [],
    listsError: null,
  },
  theme: null,
  openaiApiKey: null,
  openaiModel: "gpt-5.4-mini",
  branchSidebarSections: {
    localOpen: true,
    remoteOpen: true,
    tagsOpen: true,
    stashOpen: false,
  },
};

async function bootstrap() {
  let data: AppBootstrap = emptyAppBootstrap;
  try {
    data = await invoke<AppBootstrap>("restore_app_bootstrap");
  } catch {
    console.warn("Could not load 'restore_app_bootstrap'");
  }

  document.documentElement.setAttribute("data-theme", resolveThemePreference(data.theme));

  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <App
        startup={data.repo}
        themePreference={data.theme ?? "light"}
        openaiApiKey={data.openaiApiKey ?? null}
        openaiModel={data.openaiModel?.trim() || DEFAULT_OPENAI_MODEL}
        branchSidebarSections={data.branchSidebarSections}
      />
    </React.StrictMode>,
  );
}

void bootstrap();
