/** Calendar-only label for exports (`YYYY-MM-DD`, local date). */
export function formatShortDateOnly(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.replace(/\s+/g, " ").trim();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

/** Short relative label for dense commit rows (e.g. `2h ago`, `3d ago`). */
export function formatRelativeShort(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  const t = d.getTime();
  if (Number.isNaN(t)) return null;
  const diffSec = Math.round((Date.now() - t) / 1000);
  if (diffSec < 0) {
    return formatDate(iso);
  }
  if (diffSec < 45) {
    return "now";
  }
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) {
    return `${diffMin}m ago`;
  }
  const diffH = Math.round(diffMin / 60);
  if (diffH < 24) {
    return `${diffH}h ago`;
  }
  const diffD = Math.round(diffH / 24);
  if (diffD < 7) {
    return `${diffD}d ago`;
  }
  const diffW = Math.round(diffD / 7);
  if (diffW < 8) {
    return `${diffW}w ago`;
  }
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: d.getFullYear() !== new Date().getFullYear() ? "numeric" : undefined,
  });
}

/** Prefer `Name` from Git's `Name <email>` for dense rows. */
export function formatAuthorDisplay(author: string): string {
  const t = author.trim();
  const lt = t.indexOf("<");
  if (lt > 0) {
    return t.slice(0, lt).trim();
  }
  return t;
}
