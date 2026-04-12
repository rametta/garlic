import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import App from "../App";
import { DEFAULT_GRAPH_COMMITS_PAGE_SIZE, type RestoreLastRepo } from "../gitTypes";
import { DEFAULT_GRAPH_COMMIT_TITLE_FONT_SIZE_PX } from "../commitGraphLayout";

export function renderAppHarness(startup: RestoreLastRepo) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        refetchOnWindowFocus: false,
        staleTime: Number.POSITIVE_INFINITY,
      },
      mutations: {
        retry: 0,
      },
    },
  });

  const view = render(
    <QueryClientProvider client={queryClient}>
      <App
        startup={startup}
        themePreference="light"
        openaiApiKey={null}
        openaiModel="gpt-5.4-mini"
        branchSidebarSections={{
          localOpen: true,
          remoteOpen: true,
          worktreesOpen: false,
          tagsOpen: true,
          stashOpen: false,
        }}
        initialGraphBranchVisible={{}}
        highlightActiveBranchRows={false}
        graphCommitsPageSize={DEFAULT_GRAPH_COMMITS_PAGE_SIZE}
        graphCommitTitleFontSizePx={DEFAULT_GRAPH_COMMIT_TITLE_FONT_SIZE_PX}
        notifyGitCompletion
      />
    </QueryClientProvider>,
  );

  return {
    queryClient,
    ...view,
  };
}
