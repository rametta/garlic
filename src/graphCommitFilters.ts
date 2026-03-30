import { formatShortDateOnly } from "./appFormat";
import type { CommitEntry } from "./repoTypes";

export interface GraphCommitExportOptions {
  includeHash: boolean;
  includeAuthor: boolean;
  includeMergeCommits: boolean;
}

function localDayBounds(ymd: string): { start: Date; end: Date } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) return null;
  const start = new Date(y, mo - 1, d, 0, 0, 0, 0);
  const end = new Date(y, mo - 1, d, 23, 59, 59, 999);
  return { start, end };
}

/**
 * Client-side filters for the graph commit list (author substring + optional local date range).
 */
export function filterGraphCommits(
  commits: CommitEntry[],
  authorQuery: string,
  dateFromYmd: string,
  dateToYmd: string,
): CommitEntry[] {
  const q = authorQuery.trim().toLowerCase();
  const fromBound = dateFromYmd.trim() ? localDayBounds(dateFromYmd) : null;
  const toBound = dateToYmd.trim() ? localDayBounds(dateToYmd) : null;

  return commits.filter((c) => {
    if (q.length > 0) {
      const a = c.author.toLowerCase();
      const e = c.authorEmail.toLowerCase();
      if (!a.includes(q) && !e.includes(q)) return false;
    }
    const t = new Date(c.date).getTime();
    if (Number.isNaN(t)) return false;
    if (fromBound && t < fromBound.start.getTime()) return false;
    if (toBound && t > toBound.end.getTime()) return false;
    return true;
  });
}

/**
 * Commit hashes reachable from `HEAD` by walking `parentHashes` on the given rows only
 * (same ancestry idea as `git log HEAD`, limited to commits already loaded in the graph).
 */
export function reachableCommitHashesFromHead(
  loadedCommits: CommitEntry[],
  headFullHash: string | null,
): Set<string> {
  const trimmed = headFullHash?.trim() ?? "";
  if (!trimmed) return new Set();
  const byHash = new Map(loadedCommits.map((c) => [c.hash, c] as const));
  let tip = trimmed;
  if (!byHash.has(tip)) {
    const match = loadedCommits.find(
      (c) => c.hash === tip || c.hash.startsWith(tip) || c.shortHash === tip,
    );
    if (match === undefined) return new Set();
    tip = match.hash;
  }
  const reachable = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const h = stack.pop();
    if (h === undefined || reachable.has(h)) continue;
    reachable.add(h);
    const c = byHash.get(h);
    if (c === undefined) continue;
    for (const p of c.parentHashes) {
      if (!reachable.has(p)) stack.push(p);
    }
  }
  return reachable;
}

export function formatCommitsExportTxt(
  commits: CommitEntry[],
  repoLabel: string,
  checkoutLabel: string,
  authorQuery: string,
  dateFromYmd: string,
  dateToYmd: string,
  options: GraphCommitExportOptions,
): string {
  const lines: string[] = [];
  lines.push(`- Repository: ${repoLabel}`);
  lines.push(`- Checked-out: ${checkoutLabel}`);
  lines.push(`- Count: ${commits.length}`);
  const parts: string[] = [];
  if (authorQuery.trim()) parts.push(`author contains "${authorQuery.trim()}"`);
  if (dateFromYmd.trim()) parts.push(`from ${dateFromYmd.trim()}`);
  if (dateToYmd.trim()) parts.push(`to ${dateToYmd.trim()}`);
  lines.push(parts.length > 0 ? `- Filters: ${parts.join(", ")}` : `- Filters: (none)`);
  lines.push(`- Include hash: ${options.includeHash ? "yes" : "no"}`);
  lines.push(`- Include author: ${options.includeAuthor ? "yes" : "no"}`);
  lines.push(`- Include merge commits: ${options.includeMergeCommits ? "yes" : "no"}`);
  for (const c of commits) {
    const fields: string[] = [];
    if (options.includeHash) fields.push(c.shortHash);
    fields.push(formatShortDateOnly(c.date));
    if (options.includeAuthor) fields.push(c.author);
    fields.push(c.subject);
    lines.push(`- ${fields.join(" | ")}`);
  }
  return `${lines.join("\n")}\n`;
}

const MAX_EXPORT_FILENAME_STEM = 180;

function slugFilenamePart(raw: string, maxLength: number): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength)
    .replace(/-+$/g, "");
}

/**
 * Default save name for a graph commit export, derived from active filters (safe for common filesystems).
 */
export function buildGraphExportDefaultFilename(
  repoLabel: string,
  authorQuery: string,
  dateFromYmd: string,
  dateToYmd: string,
): string {
  const repoStem = slugFilenamePart(repoLabel, 64) || "repo";
  const parts: string[] = [`${repoStem}-commits`];
  const author = slugFilenamePart(authorQuery, 48);
  if (author.length > 0) {
    parts.push(`by-${author}`);
  }
  const from = dateFromYmd.trim();
  const to = dateToYmd.trim();
  if (from.length > 0 && to.length > 0) {
    parts.push(`${from}_to_${to}`);
  } else if (from.length > 0) {
    parts.push(`from-${from}`);
  } else if (to.length > 0) {
    parts.push(`to-${to}`);
  }
  let stem = parts.join("_");
  if (stem.length > MAX_EXPORT_FILENAME_STEM) {
    stem = stem.slice(0, MAX_EXPORT_FILENAME_STEM).replace(/_+$/, "");
  }
  return `${stem}.txt`;
}
