/**
 * Shared Shiki highlighter lifecycle and theme state for diff/code previews.
 * Search tags: shiki highlighter, syntax highlighting, diff theme, external store.
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import { getSingletonHighlighter, type Highlighter } from "shiki";

/** Bundled langs loaded once for the diff viewer (popular stacks + common tooling). */
const SHIKI_LANGS = [
  "typescript",
  "javascript",
  "tsx",
  "jsx",
  "json",
  "jsonc",
  "css",
  "scss",
  "sass",
  "less",
  "html",
  "markdown",
  "mdx",
  "yaml",
  "rust",
  "python",
  "go",
  "java",
  "kotlin",
  "cpp",
  "c",
  "csharp",
  "ruby",
  "php",
  "bash",
  "fish",
  "shell",
  "sql",
  "xml",
  "toml",
  "vue",
  "svelte",
  "swift",
  "docker",
  "dockerfile",
  "ini",
  "graphql",
  "scala",
  "powershell",
  "makefile",
  "cmake",
  "latex",
  "vb",
  "haskell",
  "elixir",
  "dart",
  "lua",
  "zig",
  "wasm",
  "groovy",
  "perl",
  "diff",
  "fsharp",
  "hcl",
] as const;

/** DaisyUI themes that read as dark; others use the light Shiki theme. */
const DARK_DAISY_THEMES = new Set([
  "dark",
  "synthwave",
  "halloween",
  "forest",
  "black",
  "luxury",
  "dracula",
  "night",
  "coffee",
  "dim",
  "sunset",
  "abyss",
  "business",
  "aqua",
  "cyberpunk",
]);

function subscribeDataTheme(callback: () => void): () => void {
  const obs = new MutationObserver(callback);
  obs.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
  return () => {
    obs.disconnect();
  };
}

function getDataTheme(): string {
  return document.documentElement.getAttribute("data-theme") ?? "light";
}

export function useDiffShikiTheme(): "github-light" | "github-dark" {
  const name = useSyncExternalStore(subscribeDataTheme, getDataTheme, getDataTheme);
  return DARK_DAISY_THEMES.has(name) ? "github-dark" : "github-light";
}

let highlighterPromise: Promise<Highlighter> | null = null;

function ensureHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = getSingletonHighlighter({
      themes: ["github-light", "github-dark"],
      langs: [...SHIKI_LANGS],
    });
  }
  return highlighterPromise;
}

export function useShikiHighlighter(): Highlighter | null {
  const [h, setH] = useState<Highlighter | null>(null);
  useEffect(() => {
    let cancelled = false;
    void ensureHighlighter().then((highlighter) => {
      if (!cancelled) setH(highlighter);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return h;
}
