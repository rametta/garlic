/**
 * Frontend bootstrap that restores persisted app state before React renders.
 * Search tags: restore_app_bootstrap, query client, theme hydration, startup repo snapshot.
 */
import { QueryClientProvider } from "@tanstack/react-query";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { TauriBridgeInspector } from "./components/TauriBridgeInspector";
import {
  type RestoreLastRepo,
  type WireRestoreLastRepo,
  DEFAULT_GRAPH_COMMITS_PAGE_SIZE,
  normalizeRestoreLastRepo,
} from "./gitTypes";
import type { BranchSidebarSectionsState } from "./repoTypes";
import { invoke } from "./tauriBridgeDebug";
import { queryClient } from "./queryClient";
import "./index.css";
import { DEFAULT_OPENAI_MODEL } from "./generateCommitMessage";
import { DEFAULT_GRAPH_COMMIT_TITLE_FONT_SIZE_PX } from "./commitGraphLayout";
import { resolveThemePreference } from "./theme";

export interface AppBootstrap {
  repo: RestoreLastRepo;
  theme: string | null;
  openaiApiKey: string | null;
  openaiModel: string;
  branchSidebarSections: BranchSidebarSectionsState;
  graphBranchVisible: Record<string, boolean>;
  highlightActiveBranchRows: boolean;
  graphCommitsPageSize: number;
  graphCommitTitleFontSizePx: number;
  /** System notification after long push/commit (default on). */
  notifyGitCompletion: boolean;
}

interface WireAppBootstrap extends Omit<AppBootstrap, "repo"> {
  repo: WireRestoreLastRepo;
}

export const emptyAppBootstrap: AppBootstrap = {
  repo: {
    loadError: null,
    metadata: null,
    localBranches: [],
    remoteBranches: [],
    worktrees: [],
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
    worktreesOpen: false,
    tagsOpen: true,
    stashOpen: false,
  },
  graphBranchVisible: {},
  highlightActiveBranchRows: false,
  graphCommitsPageSize: DEFAULT_GRAPH_COMMITS_PAGE_SIZE,
  graphCommitTitleFontSizePx: DEFAULT_GRAPH_COMMIT_TITLE_FONT_SIZE_PX,
  notifyGitCompletion: true,
};

async function bootstrap() {
  let data: AppBootstrap = emptyAppBootstrap;
  try {
    const wire = await invoke<WireAppBootstrap>("restore_app_bootstrap");
    data = {
      ...wire,
      repo: normalizeRestoreLastRepo(wire.repo),
    };
  } catch {
    console.warn("Could not load 'restore_app_bootstrap'");
  }

  document.documentElement.setAttribute("data-theme", resolveThemePreference(data.theme));

  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <QueryClientProvider client={queryClient}>
        <App
          startup={data.repo}
          themePreference={data.theme ?? "light"}
          openaiApiKey={data.openaiApiKey ?? null}
          openaiModel={data.openaiModel?.trim() || DEFAULT_OPENAI_MODEL}
          branchSidebarSections={data.branchSidebarSections}
          initialGraphBranchVisible={data.graphBranchVisible}
          highlightActiveBranchRows={data.highlightActiveBranchRows}
          graphCommitsPageSize={data.graphCommitsPageSize ?? DEFAULT_GRAPH_COMMITS_PAGE_SIZE}
          graphCommitTitleFontSizePx={
            data.graphCommitTitleFontSizePx ?? DEFAULT_GRAPH_COMMIT_TITLE_FONT_SIZE_PX
          }
          notifyGitCompletion={data.notifyGitCompletion ?? true}
        />
        {import.meta.env.DEV ? <ReactQueryDevtools buttonPosition="bottom-left" /> : null}
        {import.meta.env.DEV ? <TauriBridgeInspector /> : null}
      </QueryClientProvider>
    </React.StrictMode>,
  );
}

void bootstrap();
