/**
 * Shared React Query client configuration for the desktop app.
 * Search tags: query client, stale time, mutation retry, cache defaults.
 */
import { QueryClient } from "@tanstack/react-query";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      staleTime: Infinity,
    },
    mutations: {
      retry: 0,
    },
  },
});
