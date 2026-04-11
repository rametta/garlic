/**
 * Maps diff file paths to Shiki language ids for syntax highlighting.
 * Search tags: diff language detection, extension map, basename map, shiki language.
 */
import type { FileData } from "react-diff-view";

/** Path used for language detection (prefer new path for renames). */
export function diffFileDisplayPath(file: FileData): string {
  const np = file.newPath;
  const op = file.oldPath;
  if (np && np !== "/dev/null") return np;
  if (op && op !== "/dev/null") return op;
  return np || op || "";
}

const BASENAME_LANG: Record<string, string> = {
  dockerfile: "dockerfile",
  gnumakefile: "makefile",
  makefile: "makefile",
  cmakelists: "cmake",
};

const EXT_LANG: Record<string, string> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  json: "json",
  jsonc: "jsonc",
  css: "css",
  scss: "scss",
  sass: "sass",
  less: "less",
  html: "html",
  htm: "html",
  vue: "vue",
  svelte: "svelte",
  md: "markdown",
  mdx: "mdx",
  yml: "yaml",
  yaml: "yaml",
  rs: "rust",
  py: "python",
  pyi: "python",
  pyw: "python",
  go: "go",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hh: "cpp",
  cs: "csharp",
  rb: "ruby",
  erb: "ruby",
  php: "php",
  phtml: "php",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  fish: "fish",
  sql: "sql",
  xml: "xml",
  svg: "xml",
  toml: "toml",
  gradle: "groovy",
  dockerfile: "dockerfile",
  ex: "elixir",
  exs: "elixir",
  hs: "haskell",
  dart: "dart",
  lua: "lua",
  zig: "zig",
  wasm: "wasm",
  graphql: "graphql",
  gql: "graphql",
  groovy: "groovy",
  pl: "perl",
  pm: "perl",
  ps1: "powershell",
  psm1: "powershell",
  tex: "latex",
  cls: "latex",
  sty: "latex",
  vb: "vb",
  fs: "fsharp",
  fsi: "fsharp",
  fsx: "fsharp",
  scala: "scala",
  sc: "scala",
  ini: "ini",
  cfg: "ini",
  properties: "ini",
  tf: "hcl",
  hcl: "hcl",
};

/**
 * Shiki bundled language id for syntax highlighting, or `null` when we should show plain text.
 */
export function pathToShikiLang(path: string): string | null {
  const base = path.split(/[/\\]/).pop() ?? path;
  const lower = base.toLowerCase();
  const noExt = lower.includes(".") ? lower.slice(0, lower.lastIndexOf(".")) : lower;
  const basenameLang = BASENAME_LANG[noExt] ?? BASENAME_LANG[lower];
  if (basenameLang) return basenameLang;

  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return null;
  const ext = base.slice(dot + 1).toLowerCase();
  return EXT_LANG[ext] ?? null;
}

/**
 * Splits default `git blame` lines into the metadata prefix and source text so the latter can be
 * syntax-highlighted without lexing the blame header.
 */
export function splitBlameLine(line: string): { prefix: string; code: string } | null {
  const m = /^(\^?[0-9a-f]+)\s+\(/.exec(line);
  if (!m) return null;
  const openParen = m.index + m[0].length - 1;
  let depth = 0;
  for (let i = openParen; i < line.length; i++) {
    const c = line[i];
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0 && line[i + 1] === " ") {
        return { prefix: line.slice(0, i + 1), code: line.slice(i + 2) };
      }
    }
  }
  return null;
}
