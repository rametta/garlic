import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { UnifiedDiff } from "./components/UnifiedDiff";
import { resolveThemePreference } from "./theme";

interface RemoteEntry {
  name: string;
  fetchUrl: string;
}

interface RepoMetadata {
  path: string;
  name: string;
  gitRoot: string | null;
  error: string | null;
  branch: string | null;
  headShort: string | null;
  headSubject: string | null;
  headAuthor: string | null;
  headDate: string | null;
  detached: boolean;
  remotes: RemoteEntry[];
  workingTreeClean: boolean | null;
  ahead: number | null;
  behind: number | null;
}

interface CommitEntry {
  hash: string;
  shortHash: string;
  subject: string;
  author: string;
  date: string;
}

/** From `get_commit_signature_status` (`git log -1 --format=%G?`). */
interface CommitSignatureStatus {
  verified: boolean | null;
}

/** Local branch row from `list_local_branches` / bootstrap. */
export interface LocalBranchEntry {
  name: string;
  /** Remote-tracking upstream ref (e.g. origin/main); null if not configured. */
  upstreamName: string | null;
  /** Commits on this branch not on upstream; null if no upstream. */
  ahead: number | null;
  /** Commits on upstream not on this branch; null if no upstream. */
  behind: number | null;
}

/** One path in the working tree from `list_working_tree_files` / bootstrap. */
export interface WorkingTreeFile {
  path: string;
  staged: boolean;
  unstaged: boolean;
}

/** Repo snapshot from `restore_app_bootstrap` (`repo` field). */
export interface RestoreLastRepo {
  loadError: string | null;
  metadata: RepoMetadata | null;
  localBranches: LocalBranchEntry[];
  remoteBranches: string[];
  commits: CommitEntry[];
  workingTreeFiles: WorkingTreeFile[];
  listsError: string | null;
}

function localBranchUpstreamLabel(
  ahead: number | null,
  behind: number | null,
  upstreamName: string | null,
): string | null {
  if (ahead === null || behind === null) return null;
  const vs = upstreamName ? ` · ${upstreamName}` : "";
  return `↑${ahead} ↓${behind}${vs}`;
}

/** Rules aligned with `git check-ref-format --branch` for short branch names. */
function branchNameValidationError(name: string): string | null {
  if (name.length === 0) return null;
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    if (c <= 0x20 || c === 0x7f) {
      return "Branch names cannot contain spaces or control characters.";
    }
  }
  if (/[~^:?*[\]\\]/.test(name)) {
    return "Branch names cannot contain ~ ^ : ? * [ ] \\.";
  }
  if (name.includes("..")) {
    return 'Branch names cannot contain "..".';
  }
  if (name.includes("@{")) {
    return 'Branch names cannot contain "@{".';
  }
  if (name.startsWith("/") || name.endsWith("/")) {
    return 'Branch names cannot start or end with "/".';
  }
  if (name.includes("//")) {
    return 'Branch names cannot contain "//".';
  }
  if (name.endsWith(".lock")) {
    return 'Branch names cannot end with ".lock".';
  }
  if (name.endsWith(".")) {
    return 'Branch names cannot end with ".".';
  }
  if (name.startsWith(".")) {
    return 'Branch names cannot start with ".".';
  }
  if (name.startsWith("-")) {
    return 'Branch names cannot start with "-".';
  }
  return null;
}

function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

/** Short relative label for dense commit rows (e.g. `2h ago`, `3d ago`). */
function formatRelativeShort(iso: string | null): string | null {
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
function formatAuthorDisplay(author: string): string {
  const t = author.trim();
  const lt = t.indexOf("<");
  if (lt > 0) {
    return t.slice(0, lt).trim();
  }
  return t;
}

/** Tauri `invoke` may reject with a string or a non-Error object; normalize for display. */
function invokeErrorMessage(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  if (e !== null && typeof e === "object" && "message" in e) {
    const m = (e as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  return String(e);
}

function StagePanelFileRow({
  f,
  selected,
  busy,
  variant,
  onSelect,
  onStage,
  onUnstage,
}: {
  f: WorkingTreeFile;
  selected: boolean;
  busy: boolean;
  variant: "unstaged" | "staged";
  onSelect: () => void;
  onStage: () => void;
  onUnstage: () => void;
}) {
  const selectable = f.staged || f.unstaged;
  return (
    <li
      role={selectable ? "button" : undefined}
      tabIndex={selectable ? 0 : undefined}
      className={`rounded-md border bg-base-200/80 px-2 py-1 ${
        selectable
          ? `cursor-pointer transition-colors hover:bg-base-300/50 ${
              selected ? "border-primary ring-1 ring-primary/40" : "border-base-300"
            }`
          : "border-base-300"
      }`}
      onClick={() => {
        if (!selectable) return;
        onSelect();
      }}
      onKeyDown={(e) => {
        if (!selectable) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
    >
      <div className="flex min-h-7 items-center gap-2">
        <code className="min-w-0 flex-1 font-mono text-[0.7rem] leading-snug wrap-break-word text-base-content">
          {f.path}
        </code>
        <div className="flex shrink-0 items-center gap-0.5">
          {variant === "unstaged" && f.unstaged ? (
            <button
              type="button"
              className="btn btn-square min-h-7 min-w-7 px-0 font-mono text-sm leading-none btn-xs btn-primary"
              disabled={busy}
              aria-label={`Stage ${f.path}`}
              title="Stage"
              onClick={(e) => {
                e.stopPropagation();
                onStage();
              }}
            >
              +
            </button>
          ) : null}
          {variant === "staged" && f.staged ? (
            <button
              type="button"
              className="btn btn-square min-h-7 min-w-7 px-0 font-mono text-sm leading-none btn-ghost btn-xs"
              disabled={busy}
              aria-label={`Unstage ${f.path}`}
              title="Unstage"
              onClick={(e) => {
                e.stopPropagation();
                onUnstage();
              }}
            >
              −
            </button>
          ) : null}
        </div>
      </div>
    </li>
  );
}

function MetaRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[8.5rem_1fr] items-baseline gap-x-4 gap-y-2 text-sm">
      <dt className="m-0 font-semibold text-base-content/70">{label}</dt>
      <dd className="m-0 min-w-0 wrap-break-word text-base-content">{children}</dd>
    </div>
  );
}

function BranchPanel({
  title,
  empty,
  emptyHint,
  headerRight,
  children,
}: {
  title: string;
  empty: boolean;
  emptyHint: string;
  /** Optional control (e.g. action button) aligned with the panel title. */
  headerRight?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="card border-base-300 bg-base-100 shadow-sm">
      <div className="card-body min-h-0 gap-0 p-0">
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-base-300 px-3 py-2">
          <h2 className="m-0 card-title min-w-0 flex-1 text-xs font-semibold tracking-wide uppercase opacity-70">
            {title}
          </h2>
          {headerRight ? <div className="shrink-0">{headerRight}</div> : null}
        </div>
        <div className="max-h-[40vh] min-h-16 overflow-y-auto p-2">
          {empty ? (
            <p className="m-0 py-2 text-center text-xs text-base-content/50">{emptyHint}</p>
          ) : (
            children
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Path segments → nested folders (supports `a` + `a/b` as in Git).
 * UI: DaisyUI [collapsible submenu](https://daisyui.com/components/menu/#collapsible-submenu) (`li` → `details` → `summary` + `ul`).
 */
type BranchTrieNode = {
  branchHere: LocalBranchEntry | null;
  children: Map<string, BranchTrieNode>;
};

function emptyBranchTrieNode(): BranchTrieNode {
  return { branchHere: null, children: new Map() };
}

function insertLocalBranchIntoTrie(root: BranchTrieNode, branch: LocalBranchEntry) {
  const parts = branch.name.split("/").filter((p) => p.length > 0);
  if (parts.length === 0) return;
  let node = root;
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i];
    if (!node.children.has(seg)) {
      node.children.set(seg, emptyBranchTrieNode());
    }
    node = node.children.get(seg)!;
    if (i === parts.length - 1) {
      node.branchHere = branch;
    }
  }
}

function buildLocalBranchTrie(branches: LocalBranchEntry[]): BranchTrieNode {
  const root = emptyBranchTrieNode();
  for (const b of branches) {
    insertLocalBranchIntoTrie(root, b);
  }
  return root;
}

type RemoteTrieNode = {
  refHere: string | null;
  children: Map<string, RemoteTrieNode>;
};

function emptyRemoteTrieNode(): RemoteTrieNode {
  return { refHere: null, children: new Map() };
}

function insertRemoteRefIntoTrie(root: RemoteTrieNode, fullRef: string) {
  const parts = fullRef.split("/").filter((p) => p.length > 0);
  if (parts.length === 0) return;
  let node = root;
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i];
    if (!node.children.has(seg)) {
      node.children.set(seg, emptyRemoteTrieNode());
    }
    node = node.children.get(seg)!;
    if (i === parts.length - 1) {
      node.refHere = fullRef;
    }
  }
}

function buildRemoteBranchTrie(refs: string[]): RemoteTrieNode {
  const root = emptyRemoteTrieNode();
  for (const r of refs) {
    insertRemoteRefIntoTrie(root, r);
  }
  return root;
}

function LocalBranchRow({
  branch,
  currentBranchName,
  branchBusy,
  onCheckoutLocal,
}: {
  branch: LocalBranchEntry;
  currentBranchName: string | null;
  branchBusy: string | null;
  onCheckoutLocal: (name: string) => void;
}) {
  const isCurrent = currentBranchName === branch.name;
  const busy = branchBusy === `local:${branch.name}`;
  const upstreamLabel = localBranchUpstreamLabel(
    branch.ahead,
    branch.behind,
    branch.upstreamName ?? null,
  );
  return (
    <li className={isCurrent ? "menu-active" : ""}>
      <button
        type="button"
        disabled={busy || isCurrent}
        onClick={() => {
          onCheckoutLocal(branch.name);
        }}
        className={`flex h-auto min-h-0 flex-col items-stretch justify-start gap-0.5 py-2 text-left whitespace-normal ${busy ? "opacity-60" : ""}`}
      >
        <span className="flex w-full min-w-0 items-baseline justify-between gap-2">
          <span className="min-w-0 wrap-break-word">
            {busy ? "Switching…" : branch.name}
            {isCurrent && !busy ? (
              <span className="ml-1.5 text-xs font-normal opacity-70">(current)</span>
            ) : null}
          </span>
          {upstreamLabel && !busy ? (
            <span
              className={`shrink-0 font-mono text-[0.65rem] leading-none tracking-tight ${
                isCurrent ? "text-inherit opacity-90" : "text-base-content/60"
              }`}
              title={
                branch.upstreamName
                  ? `Ahead of ${branch.upstreamName}: ${branch.ahead ?? 0}; behind: ${branch.behind ?? 0}`
                  : "Commits ahead / behind configured upstream"
              }
            >
              {upstreamLabel}
            </span>
          ) : null}
        </span>
      </button>
    </li>
  );
}

function renderLocalBranchTrieChildren(
  node: BranchTrieNode,
  currentBranchName: string | null,
  branchBusy: string | null,
  onCheckoutLocal: (name: string) => void,
): ReactNode {
  const sorted = [...node.children.entries()].sort((a, b) =>
    a[0].localeCompare(b[0], undefined, { sensitivity: "base" }),
  );
  return sorted.map(([segment, child]) => {
    const leafOnly = child.children.size === 0 && child.branchHere !== null;
    if (leafOnly) {
      const b = child.branchHere!;
      return (
        <LocalBranchRow
          key={b.name}
          branch={b}
          currentBranchName={currentBranchName}
          branchBusy={branchBusy}
          onCheckoutLocal={onCheckoutLocal}
        />
      );
    }
    return (
      <li key={segment}>
        <details open>
          <summary className="font-mono text-[0.8125rem]">{segment}</summary>
          <ul>
            {child.branchHere ? (
              <LocalBranchRow
                branch={child.branchHere}
                currentBranchName={currentBranchName}
                branchBusy={branchBusy}
                onCheckoutLocal={onCheckoutLocal}
              />
            ) : null}
            {renderLocalBranchTrieChildren(child, currentBranchName, branchBusy, onCheckoutLocal)}
          </ul>
        </details>
      </li>
    );
  });
}

function RemoteBranchRow({
  fullRef,
  branchBusy,
  onCreateFromRemote,
}: {
  fullRef: string;
  branchBusy: string | null;
  onCreateFromRemote: (remoteRef: string) => void;
}) {
  const busy = branchBusy === `remote:${fullRef}`;
  return (
    <li>
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          onCreateFromRemote(fullRef);
        }}
        className={`h-auto min-h-0 justify-start py-2 text-left font-mono text-[0.8125rem] whitespace-normal ${busy ? "opacity-60" : ""}`}
      >
        {busy ? "Creating…" : fullRef}
      </button>
    </li>
  );
}

function renderRemoteBranchTrieChildren(
  node: RemoteTrieNode,
  branchBusy: string | null,
  onCreateFromRemote: (remoteRef: string) => void,
): ReactNode {
  const sorted = [...node.children.entries()].sort((a, b) =>
    a[0].localeCompare(b[0], undefined, { sensitivity: "base" }),
  );
  return sorted.map(([segment, child]) => {
    const leafOnly = child.children.size === 0 && child.refHere !== null;
    if (leafOnly) {
      const r = child.refHere!;
      return (
        <RemoteBranchRow
          key={r}
          fullRef={r}
          branchBusy={branchBusy}
          onCreateFromRemote={onCreateFromRemote}
        />
      );
    }
    return (
      <li key={segment}>
        <details open>
          <summary className="font-mono text-[0.8125rem]">{segment}</summary>
          <ul>
            {child.refHere ? (
              <RemoteBranchRow
                fullRef={child.refHere}
                branchBusy={branchBusy}
                onCreateFromRemote={onCreateFromRemote}
              />
            ) : null}
            {renderRemoteBranchTrieChildren(child, branchBusy, onCreateFromRemote)}
          </ul>
        </details>
      </li>
    );
  });
}

export default function App({
  startup,
  themePreference: initialThemePreference,
}: {
  startup: RestoreLastRepo;
  /** Persisted value: `auto` or a DaisyUI theme name. */
  themePreference: string;
}) {
  const [themePreference, setThemePreference] = useState(initialThemePreference);
  const [repo, setRepo] = useState<RepoMetadata | null>(() => startup.metadata ?? null);
  const [loadError, setLoadError] = useState<string | null>(() => startup.loadError ?? null);
  /** Mutations (checkout, commit, refresh, …) while a repo is open — shown inline, not as a full-panel error. */
  const [operationError, setOperationError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [localBranches, setLocalBranches] = useState<LocalBranchEntry[]>(
    () => startup.localBranches,
  );
  const [remoteBranches, setRemoteBranches] = useState<string[]>(() => startup.remoteBranches);
  const [commits, setCommits] = useState<CommitEntry[]>(() => startup.commits);
  const [workingTreeFiles, setWorkingTreeFiles] = useState<WorkingTreeFile[]>(
    () => startup.workingTreeFiles,
  );
  const [branchBusy, setBranchBusy] = useState<string | null>(null);
  const [listsError, setListsError] = useState<string | null>(() => startup.listsError ?? null);
  const [commitMessage, setCommitMessage] = useState("");
  const [selectedDiffPath, setSelectedDiffPath] = useState<string | null>(null);
  const [diffStagedText, setDiffStagedText] = useState<string | null>(null);
  const [diffUnstagedText, setDiffUnstagedText] = useState<string | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [commitBrowseHash, setCommitBrowseHash] = useState<string | null>(null);
  const [commitBrowseFiles, setCommitBrowseFiles] = useState<string[]>([]);
  const [commitBrowseLoading, setCommitBrowseLoading] = useState(false);
  const [commitBrowseError, setCommitBrowseError] = useState<string | null>(null);
  const [commitSignature, setCommitSignature] = useState<{
    loading: boolean;
    verified: boolean | null;
  }>({ loading: false, verified: null });
  const [commitDiffPath, setCommitDiffPath] = useState<string | null>(null);
  const [commitDiffText, setCommitDiffText] = useState<string | null>(null);
  const [commitDiffLoading, setCommitDiffLoading] = useState(false);
  const [commitDiffError, setCommitDiffError] = useState<string | null>(null);
  const [stageCommitBusy, setStageCommitBusy] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  const [commitPushBusy, setCommitPushBusy] = useState(false);
  const createBranchDialogRef = useRef<HTMLDialogElement>(null);
  const newBranchInputRef = useRef<HTMLInputElement>(null);
  const [newBranchName, setNewBranchName] = useState("");
  const [createBranchFieldError, setCreateBranchFieldError] = useState<string | null>(null);
  const refreshLists = useCallback(async (repoPath: string): Promise<WorkingTreeFile[] | null> => {
    setListsError(null);
    try {
      const [locals, remotes, log, worktree] = await Promise.all([
        invoke<LocalBranchEntry[]>("list_local_branches", { path: repoPath }),
        invoke<string[]>("list_remote_branches", { path: repoPath }),
        invoke<CommitEntry[]>("list_branch_commits", { path: repoPath }),
        invoke<WorkingTreeFile[]>("list_working_tree_files", { path: repoPath }),
      ]);
      setLocalBranches(locals);
      setRemoteBranches(remotes);
      setCommits(log);
      setWorkingTreeFiles(worktree);
      return worktree;
    } catch (e) {
      setListsError(invokeErrorMessage(e));
      return null;
    }
  }, []);

  const clearCommitBrowse = useCallback(() => {
    setCommitBrowseHash(null);
    setCommitBrowseFiles([]);
    setCommitBrowseLoading(false);
    setCommitBrowseError(null);
    setCommitSignature({ loading: false, verified: null });
    setCommitDiffPath(null);
    setCommitDiffText(null);
    setCommitDiffLoading(false);
    setCommitDiffError(null);
  }, []);

  const loadDiffForFile = useCallback(
    async (f: WorkingTreeFile) => {
      if (!repo?.path || repo.error) return;
      if (!f.staged && !f.unstaged) return;
      clearCommitBrowse();
      setSelectedDiffPath(f.path);
      setDiffLoading(true);
      setDiffError(null);
      setDiffStagedText(null);
      setDiffUnstagedText(null);
      try {
        const [staged, unstaged] = await Promise.all([
          f.staged
            ? invoke<string>("get_staged_diff", { path: repo.path, filePath: f.path })
            : Promise.resolve<string | null>(null),
          f.unstaged
            ? invoke<string>("get_unstaged_diff", { path: repo.path, filePath: f.path })
            : Promise.resolve<string | null>(null),
        ]);
        setDiffStagedText(staged);
        setDiffUnstagedText(unstaged);
      } catch (e) {
        setDiffError(invokeErrorMessage(e));
      } finally {
        setDiffLoading(false);
      }
    },
    [repo, clearCommitBrowse],
  );

  const selectCommit = useCallback(
    async (hash: string) => {
      if (!repo?.path || repo.error) return;
      setSelectedDiffPath(null);
      setDiffStagedText(null);
      setDiffUnstagedText(null);
      setDiffError(null);
      setCommitBrowseHash(hash);
      setCommitBrowseFiles([]);
      setCommitDiffPath(null);
      setCommitDiffText(null);
      setCommitDiffError(null);
      setCommitBrowseLoading(true);
      setCommitBrowseError(null);
      setCommitSignature({ loading: true, verified: null });
      const [filesSettled, sigSettled] = await Promise.allSettled([
        invoke<string[]>("list_commit_files", {
          path: repo.path,
          commitHash: hash,
        }),
        invoke<CommitSignatureStatus>("get_commit_signature_status", {
          path: repo.path,
          commitHash: hash,
        }),
      ]);

      if (filesSettled.status === "fulfilled") {
        setCommitBrowseFiles(filesSettled.value);
      } else {
        setCommitBrowseFiles([]);
        setCommitBrowseError(invokeErrorMessage(filesSettled.reason));
      }

      let verified: boolean | null = null;
      if (sigSettled.status === "fulfilled") {
        verified = sigSettled.value.verified ?? null;
      }
      setCommitSignature({ loading: false, verified });
      setCommitBrowseLoading(false);
    },
    [repo],
  );

  const loadCommitFileDiff = useCallback(
    async (filePath: string, commitHash: string) => {
      if (!repo?.path || repo.error || !commitHash.trim()) return;
      setCommitDiffPath(filePath);
      setCommitDiffLoading(true);
      setCommitDiffError(null);
      setCommitDiffText(null);
      try {
        const text = await invoke<string>("get_commit_file_diff", {
          path: repo.path,
          commitHash,
          filePath,
        });
        setCommitDiffText(text);
      } catch (e) {
        setCommitDiffError(invokeErrorMessage(e));
      } finally {
        setCommitDiffLoading(false);
      }
    },
    [repo],
  );

  const backFromCommitFileDiff = useCallback(() => {
    setCommitDiffPath(null);
    setCommitDiffText(null);
    setCommitDiffError(null);
    setCommitDiffLoading(false);
  }, []);

  const clearDiffSelection = useCallback(() => {
    setSelectedDiffPath(null);
    setDiffStagedText(null);
    setDiffUnstagedText(null);
    setDiffError(null);
    setDiffLoading(false);
  }, []);

  const loadRepo = useCallback(
    async (selected: string) => {
      setLoading(true);
      setLoadError(null);
      setOperationError(null);
      clearCommitBrowse();
      setSelectedDiffPath(null);
      setDiffStagedText(null);
      setDiffUnstagedText(null);
      setDiffError(null);
      try {
        const meta = await invoke<RepoMetadata>("get_repo_metadata", {
          path: selected,
        });
        setRepo(meta);
        if (!meta.error) {
          await invoke("set_last_repo_path", { path: selected });
          await refreshLists(selected);
        } else {
          setLocalBranches([]);
          setRemoteBranches([]);
          setCommits([]);
          setWorkingTreeFiles([]);
        }
      } catch (e) {
        setRepo(null);
        setLocalBranches([]);
        setRemoteBranches([]);
        setCommits([]);
        setWorkingTreeFiles([]);
        setLoadError(invokeErrorMessage(e));
        void invoke("reset_main_window_title").catch(() => {});
      } finally {
        setLoading(false);
      }
    },
    [refreshLists, clearCommitBrowse],
  );

  const refreshAfterMutation = useCallback(async () => {
    if (!repo?.path || repo.error) return;
    const prevBranch = repo.branch;
    const prevDetached = repo.detached;
    try {
      const meta = await invoke<RepoMetadata>("get_repo_metadata", {
        path: repo.path,
      });
      const branchContextChanged = meta.branch !== prevBranch || meta.detached !== prevDetached;
      setRepo(meta);
      if (!meta.error) {
        if (branchContextChanged) {
          clearCommitBrowse();
        }
        const files = await refreshLists(repo.path);
        if (selectedDiffPath && files) {
          const next = files.find((w) => w.path === selectedDiffPath);
          if (next && (next.staged || next.unstaged)) {
            void loadDiffForFile(next);
          } else {
            setSelectedDiffPath(null);
            setDiffStagedText(null);
            setDiffUnstagedText(null);
            setDiffError(null);
          }
        }
      }
    } catch (e) {
      setOperationError(invokeErrorMessage(e));
    }
  }, [repo, refreshLists, selectedDiffPath, loadDiffForFile, clearCommitBrowse]);

  useEffect(() => {
    const promise = Promise.all([
      listen("open-repo-request", () => {
        void (async () => {
          const selected = await open({
            directory: true,
            multiple: false,
            title: "Open repository",
          });
          if (selected === null || Array.isArray(selected)) return;
          await loadRepo(selected);
        })();
      }),
      listen<string>("open-recent-repo", (e) => {
        const path = e.payload.trim();
        if (path) void loadRepo(path);
      }),
      listen<{ theme: string }>("theme-changed", (e) => {
        const pref = e.payload.theme;
        setThemePreference(pref);
        document.documentElement.setAttribute("data-theme", resolveThemePreference(pref));
      }),
      listen("window-focused", () => {
        void refreshAfterMutation();
      }),
    ]);

    return () => {
      void promise.then((listeners) => {
        for (const u of listeners) {
          u();
        }
      });
    };
  }, [loadRepo, refreshAfterMutation]);

  useEffect(() => {
    if (themePreference !== "auto") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      document.documentElement.setAttribute("data-theme", mq.matches ? "dark" : "light");
    };
    apply();
    mq.addEventListener("change", apply);
    return () => {
      mq.removeEventListener("change", apply);
    };
  }, [themePreference]);

  async function onCheckoutLocal(branch: string) {
    if (!repo?.path || repo.error) return;
    setBranchBusy(`local:${branch}`);
    setOperationError(null);
    try {
      await invoke("checkout_local_branch", {
        path: repo.path,
        branch,
      });
      await refreshAfterMutation();
    } catch (e) {
      setOperationError(invokeErrorMessage(e));
    } finally {
      setBranchBusy(null);
    }
  }

  function openCreateBranchDialog() {
    setNewBranchName("");
    setCreateBranchFieldError(null);
    setOperationError(null);
    createBranchDialogRef.current?.showModal();
    requestAnimationFrame(() => {
      newBranchInputRef.current?.focus();
    });
  }

  async function submitCreateBranch() {
    const trimmed = newBranchName.trim();
    if (!repo?.path || repo.error) return;
    if (!trimmed) {
      setCreateBranchFieldError("Enter a branch name.");
      return;
    }
    const nameErr = branchNameValidationError(trimmed);
    if (nameErr) {
      setCreateBranchFieldError(nameErr);
      return;
    }
    setCreateBranchFieldError(null);
    setBranchBusy("create");
    setOperationError(null);
    try {
      await invoke("create_local_branch", {
        path: repo.path,
        branch: trimmed,
      });
      createBranchDialogRef.current?.close();
      await refreshAfterMutation();
    } catch (e) {
      setOperationError(invokeErrorMessage(e));
    } finally {
      setBranchBusy(null);
    }
  }

  async function onCreateFromRemote(remoteRef: string) {
    if (!repo?.path || repo.error) return;
    setBranchBusy(`remote:${remoteRef}`);
    setOperationError(null);
    try {
      await invoke("create_branch_from_remote", {
        path: repo.path,
        remoteRef,
      });
      await refreshAfterMutation();
    } catch (e) {
      setOperationError(invokeErrorMessage(e));
    } finally {
      setBranchBusy(null);
    }
  }

  async function onStagePaths(paths: string[]) {
    if (!repo?.path || repo.error || paths.length === 0) return;
    setStageCommitBusy(true);
    setOperationError(null);
    try {
      await invoke("stage_paths", { path: repo.path, paths });
      await refreshAfterMutation();
    } catch (e) {
      setOperationError(invokeErrorMessage(e));
    } finally {
      setStageCommitBusy(false);
    }
  }

  async function onUnstagePaths(paths: string[]) {
    if (!repo?.path || repo.error || paths.length === 0) return;
    setStageCommitBusy(true);
    setOperationError(null);
    try {
      await invoke("unstage_paths", { path: repo.path, paths });
      await refreshAfterMutation();
    } catch (e) {
      setOperationError(invokeErrorMessage(e));
    } finally {
      setStageCommitBusy(false);
    }
  }

  async function onCommit() {
    if (!repo?.path || repo.error) return;
    const msg = commitMessage.trim();
    if (!msg) return;
    setStageCommitBusy(true);
    setOperationError(null);
    try {
      await invoke("commit_staged", { path: repo.path, message: msg });
      setCommitMessage("");
      await refreshAfterMutation();
    } catch (e) {
      setOperationError(invokeErrorMessage(e));
    } finally {
      setStageCommitBusy(false);
    }
  }

  async function onPushToOrigin() {
    if (!repo?.path || repo.error) return;
    setPushBusy(true);
    setOperationError(null);
    try {
      await invoke("push_to_origin", { path: repo.path });
      await refreshAfterMutation();
    } catch (e) {
      setOperationError(invokeErrorMessage(e));
    } finally {
      setPushBusy(false);
    }
  }

  async function onCommitAndPush() {
    if (!repo?.path || repo.error || repo.detached) return;
    const msg = commitMessage.trim();
    if (!msg) return;
    if (!workingTreeFiles.some((f) => f.staged)) return;
    setCommitPushBusy(true);
    setOperationError(null);
    try {
      await invoke("commit_staged", { path: repo.path, message: msg });
      setCommitMessage("");
      await invoke("push_to_origin", { path: repo.path });
      await refreshAfterMutation();
    } catch (e) {
      setOperationError(invokeErrorMessage(e));
      void refreshAfterMutation();
    } finally {
      setCommitPushBusy(false);
    }
  }

  const canShowBranches = Boolean(repo && !repo.error && !loading);
  const currentBranchName = repo?.detached ? null : (repo?.branch ?? null);
  const commitsSectionTitle =
    currentBranchName ??
    (repo?.detached
      ? repo.headShort
        ? `Detached (${repo.headShort})`
        : "Detached HEAD"
      : (repo?.headShort ?? "Current branch"));

  const hasStagedFiles = workingTreeFiles.some((f) => f.staged);
  const unstagedFiles = workingTreeFiles.filter((f) => f.unstaged);
  const stagedFiles = workingTreeFiles.filter((f) => f.staged);
  const unstagedPaths = unstagedFiles.map((f) => f.path);
  const stagedPaths = stagedFiles.map((f) => f.path);
  const canCommit =
    Boolean(repo?.path && !repo.error && !loading) &&
    hasStagedFiles &&
    commitMessage.trim().length > 0 &&
    !stageCommitBusy &&
    !commitPushBusy;
  const canPush =
    Boolean(repo?.path && !repo.error && !loading) &&
    !repo?.detached &&
    !stageCommitBusy &&
    !commitPushBusy &&
    !pushBusy;
  const canCommitAndPush = canCommit && !repo?.detached && !pushBusy;

  const newBranchTrimmed = newBranchName.trim();
  const newBranchNameInvalid =
    newBranchTrimmed.length > 0 && branchNameValidationError(newBranchTrimmed) !== null;
  const canSubmitNewBranch =
    newBranchTrimmed.length > 0 && !newBranchNameInvalid && branchBusy !== "create";

  const showExpandedDiff =
    Boolean(selectedDiffPath || commitDiffPath) && !listsError && Boolean(repo && !repo.error);

  const localBranchTrieRoot = useMemo(() => buildLocalBranchTrie(localBranches), [localBranches]);
  const remoteBranchTrieRoot = useMemo(
    () => buildRemoteBranchTrie(remoteBranches),
    [remoteBranches],
  );

  return (
    <main className="box-border flex min-h-screen flex-col bg-base-200 px-4 pt-6 pb-8 text-base-content antialiased [font-synthesis:none]">
      <div
        className="grid min-h-0 min-w-0 flex-1 grid-cols-12 gap-4 lg:min-h-[calc(100vh-5rem)] lg:items-stretch"
        aria-live="polite"
        aria-busy={loading}
      >
        <aside className="col-span-12 flex min-h-0 min-w-0 flex-col gap-3 lg:sticky lg:top-6 lg:col-span-3">
          <dialog
            ref={createBranchDialogRef}
            className="modal"
            onClick={(e) => {
              if (e.target === e.currentTarget) {
                e.currentTarget.close();
              }
            }}
            onClose={() => {
              setNewBranchName("");
              setCreateBranchFieldError(null);
            }}
          >
            <div
              className="modal-box"
              onClick={(e) => {
                e.stopPropagation();
              }}
            >
              <h3 className="m-0 text-lg font-bold">New local branch</h3>
              <p className="mt-1 mb-0 text-sm text-base-content/70">
                Creates a branch from the current commit and switches to it.
              </p>
              <label className="form-control mt-4 w-full">
                <span className="label-text mb-1">Branch name</span>
                <input
                  ref={newBranchInputRef}
                  type="text"
                  className="input-bordered input w-full font-mono text-sm"
                  value={newBranchName}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={branchBusy === "create"}
                  onChange={(e) => {
                    setNewBranchName(e.target.value);
                    if (createBranchFieldError) setCreateBranchFieldError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === " ") {
                      e.preventDefault();
                    }
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void submitCreateBranch();
                    }
                  }}
                />
                {createBranchFieldError ? (
                  <span className="label-text-alt text-error">{createBranchFieldError}</span>
                ) : newBranchNameInvalid ? (
                  <span className="label-text-alt text-error">
                    {branchNameValidationError(newBranchTrimmed)}
                  </span>
                ) : null}
              </label>
              <div className="modal-action">
                <button
                  type="button"
                  className="btn"
                  disabled={branchBusy === "create"}
                  onClick={() => createBranchDialogRef.current?.close()}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={!canSubmitNewBranch}
                  onClick={() => void submitCreateBranch()}
                >
                  {branchBusy === "create" ? (
                    <span className="loading loading-sm loading-spinner" />
                  ) : (
                    "Create"
                  )}
                </button>
              </div>
            </div>
          </dialog>

          <BranchPanel
            title="Local branches"
            empty={canShowBranches && localBranches.length === 0}
            emptyHint="No local branches"
            headerRight={
              canShowBranches ? (
                <button
                  type="button"
                  className="btn btn-ghost btn-xs"
                  disabled={Boolean(branchBusy)}
                  onClick={() => {
                    openCreateBranchDialog();
                  }}
                >
                  New branch
                </button>
              ) : null
            }
          >
            {canShowBranches ? (
              <ul className="menu w-full menu-sm rounded-md bg-transparent p-0">
                {renderLocalBranchTrieChildren(
                  localBranchTrieRoot,
                  currentBranchName,
                  branchBusy,
                  (name) => {
                    void onCheckoutLocal(name);
                  },
                )}
              </ul>
            ) : null}
          </BranchPanel>

          <BranchPanel
            title="Remote branches"
            empty={canShowBranches && remoteBranches.length === 0}
            emptyHint="No remote-tracking branches"
          >
            {canShowBranches ? (
              <ul className="menu w-full menu-sm rounded-md bg-transparent p-0">
                {renderRemoteBranchTrieChildren(remoteBranchTrieRoot, branchBusy, (remoteRef) => {
                  void onCreateFromRemote(remoteRef);
                })}
              </ul>
            ) : null}
          </BranchPanel>
        </aside>

        <div
          className={`col-span-12 flex min-w-0 flex-col gap-4 lg:col-span-6 ${
            showExpandedDiff ? "min-h-0 min-w-0 lg:flex lg:h-full lg:flex-col" : ""
          }`}
        >
          <section
            className={`card w-full min-w-0 border-base-300 bg-base-100 shadow-md ${
              showExpandedDiff ? "flex min-h-0 min-w-0 flex-1 flex-col" : ""
            }`}
          >
            <div
              className={`card-body px-6 py-5 ${
                showExpandedDiff ? "flex min-h-0 min-w-0 flex-1 flex-col gap-0" : ""
              }`}
            >
              {loading ? (
                <div className="flex flex-col items-center justify-center gap-3 py-4">
                  <span className="loading loading-md loading-spinner text-primary" />
                  <p className="m-0 text-center text-[0.9375rem] text-base-content/80">
                    Loading repository…
                  </p>
                </div>
              ) : loadError ? (
                <div role="alert" className="alert text-sm alert-error">
                  <span>{loadError}</span>
                </div>
              ) : repo ? (
                <>
                  {repo.error ? (
                    <>
                      <div role="status" className="alert text-sm alert-warning">
                        <span>{repo.error}</span>
                      </div>
                      <dl className="m-0 mt-4 flex flex-col gap-2.5">
                        <MetaRow label="Path">{repo.path}</MetaRow>
                      </dl>
                    </>
                  ) : (
                    <>
                      {listsError ? (
                        <div role="alert" className="mb-3 alert text-sm alert-error">
                          <span>{listsError}</span>
                        </div>
                      ) : null}
                      {operationError ? (
                        <div role="alert" className="mb-3 alert text-sm alert-error">
                          <span className="wrap-break-word whitespace-pre-wrap">
                            {operationError}
                          </span>
                        </div>
                      ) : null}

                      {!listsError && selectedDiffPath ? (
                        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
                          <div className="flex shrink-0 flex-wrap items-start justify-between gap-3 border-b border-base-300 pb-3">
                            <div className="min-w-0">
                              <h2 className="m-0 font-mono text-sm font-semibold tracking-wide text-base-content opacity-90">
                                Diff
                              </h2>
                              <code className="mt-1 block font-mono text-xs wrap-break-word text-base-content/80">
                                {selectedDiffPath}
                              </code>
                            </div>
                            <button
                              type="button"
                              className="btn shrink-0 btn-ghost btn-sm"
                              onClick={clearDiffSelection}
                            >
                              Back to commits
                            </button>
                          </div>
                          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                            {diffLoading ? (
                              <div className="flex flex-1 flex-col items-center justify-center gap-3 py-20">
                                <span className="loading loading-md loading-spinner text-primary" />
                                <p className="m-0 text-sm text-base-content/70">Loading diff…</p>
                              </div>
                            ) : diffError ? (
                              <div role="alert" className="alert text-sm alert-error">
                                <span className="wrap-break-word">{diffError}</span>
                              </div>
                            ) : (
                              <div className="min-h-0 w-full min-w-0 flex-1 overflow-auto rounded-lg border border-base-300 bg-base-200/40 p-4">
                                {diffStagedText !== null ? (
                                  <div className="mb-8 last:mb-0">
                                    <div className="m-0 mb-2 text-xs font-semibold tracking-wide uppercase opacity-70">
                                      Staged
                                    </div>
                                    <UnifiedDiff
                                      text={diffStagedText}
                                      emptyLabel="(no staged diff)"
                                    />
                                  </div>
                                ) : null}
                                {diffUnstagedText !== null ? (
                                  <div>
                                    <div className="m-0 mb-2 text-xs font-semibold tracking-wide uppercase opacity-70">
                                      Unstaged
                                    </div>
                                    <UnifiedDiff
                                      text={diffUnstagedText}
                                      emptyLabel="(no unstaged diff)"
                                    />
                                  </div>
                                ) : null}
                              </div>
                            )}
                          </div>
                        </div>
                      ) : !listsError && commitDiffPath && commitBrowseHash ? (
                        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
                          <div className="flex shrink-0 flex-wrap items-end justify-between gap-2 border-b border-base-300 pb-1.5">
                            <div className="min-w-0">
                              <h2 className="m-0 text-[0.65rem] font-semibold tracking-wide text-base-content/50 uppercase">
                                Commit diff
                              </h2>
                              <code className="mt-0.5 block font-mono text-[0.65rem] leading-tight wrap-break-word text-base-content/85">
                                {commitDiffPath}
                              </code>
                              <p className="mt-0.5 mb-0 font-mono text-[0.6rem] text-base-content/50">
                                {commits.find((x) => x.hash === commitBrowseHash)?.shortHash ??
                                  commitBrowseHash.slice(0, 7)}
                              </p>
                            </div>
                            <button
                              type="button"
                              className="btn shrink-0 btn-ghost btn-xs"
                              onClick={backFromCommitFileDiff}
                            >
                              Back to files
                            </button>
                          </div>
                          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                            {commitDiffLoading ? (
                              <div className="flex flex-1 flex-col items-center justify-center gap-2 py-12">
                                <span className="loading loading-md loading-spinner text-primary" />
                                <p className="m-0 text-xs text-base-content/70">Loading diff…</p>
                              </div>
                            ) : commitDiffError ? (
                              <div role="alert" className="alert py-2 text-xs alert-error">
                                <span className="wrap-break-word">{commitDiffError}</span>
                              </div>
                            ) : (
                              <div className="min-h-0 w-full min-w-0 flex-1 overflow-auto rounded border border-base-300/80 bg-base-200/30 p-2">
                                <div className="m-0 mb-1.5 text-[0.6rem] font-semibold tracking-wide text-base-content/45 uppercase">
                                  Patch
                                </div>
                                <UnifiedDiff
                                  text={commitDiffText ?? ""}
                                  emptyLabel="(no diff for this file)"
                                />
                              </div>
                            )}
                          </div>
                        </div>
                      ) : !listsError && commitBrowseHash ? (
                        <div className="mb-4 flex min-h-0 min-w-0 flex-col gap-2">
                          <div className="flex shrink-0 flex-wrap items-end justify-between gap-2 border-b border-base-300 pb-1.5">
                            <div className="min-w-0">
                              <h2 className="m-0 text-[0.65rem] font-semibold tracking-wide text-base-content/50 uppercase">
                                Files in commit
                              </h2>
                              <p className="mt-0.5 mb-0 truncate font-mono text-[0.65rem] leading-tight text-base-content/80">
                                {commits.find((x) => x.hash === commitBrowseHash)?.subject ??
                                  commitBrowseHash.slice(0, 7)}
                              </p>
                              {commitSignature.loading ? (
                                <p className="mt-1 mb-0 text-[0.6rem] text-base-content/50">
                                  Signature: checking…
                                </p>
                              ) : (
                                <p className="mt-1 mb-0 text-[0.6rem] text-base-content/60">
                                  Signature:{" "}
                                  {commitSignature.verified === true ? (
                                    <span className="text-success">verified</span>
                                  ) : commitSignature.verified === false ? (
                                    <span className="text-base-content/70">not verified</span>
                                  ) : (
                                    <span className="text-base-content/50">unknown</span>
                                  )}
                                </p>
                              )}
                            </div>
                            <button
                              type="button"
                              className="btn shrink-0 btn-ghost btn-xs"
                              onClick={clearCommitBrowse}
                            >
                              Back to commits
                            </button>
                          </div>
                          {commitBrowseLoading ? (
                            <div className="flex flex-col items-center justify-center gap-2 py-8">
                              <span className="loading loading-md loading-spinner text-primary" />
                              <p className="m-0 text-xs text-base-content/70">Loading files…</p>
                            </div>
                          ) : commitBrowseError ? (
                            <div role="alert" className="alert py-2 text-xs alert-error">
                              <span className="wrap-break-word">{commitBrowseError}</span>
                            </div>
                          ) : commitBrowseFiles.length === 0 ? (
                            <p className="m-0 text-center text-xs text-base-content/60">
                              No files changed in this commit
                            </p>
                          ) : (
                            <ul className="m-0 flex max-h-[min(52vh,28rem)] list-none flex-col gap-2 overflow-y-auto py-1 pr-0.5">
                              {commitBrowseFiles.map((fp) => (
                                <li key={fp}>
                                  <button
                                    type="button"
                                    className="w-full rounded-lg border border-base-300/40 bg-base-200/50 px-3 py-2.5 text-left text-sm leading-snug transition-colors hover:border-base-300 hover:bg-base-300/45 active:bg-base-300/55"
                                    onClick={() =>
                                      void loadCommitFileDiff(fp, commitBrowseHash ?? "")
                                    }
                                  >
                                    <code className="font-mono wrap-break-word text-base-content/95">
                                      {fp}
                                    </code>
                                  </button>
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      ) : (
                        <div className="mb-4 min-w-0">
                          <h2 className="m-0 mb-1.5 border-b border-base-300 pb-1.5 text-[0.65rem] font-semibold tracking-wide text-base-content/50 uppercase">
                            Commits
                          </h2>
                          {commits.length === 0 ? (
                            <p className="m-0 text-center text-xs text-base-content/60">
                              No commits to show
                            </p>
                          ) : (
                            <>
                              <div className="mb-0.5 grid grid-cols-[minmax(0,5.5rem)_0.875rem_minmax(0,1fr)_minmax(0,6.5rem)_minmax(0,3.25rem)] items-center gap-x-1.5 border-b border-base-300/80 px-1 pb-0.5 text-[0.6rem] font-semibold tracking-wide text-base-content/45 uppercase">
                                <span className="truncate">Branch / tag</span>
                                <span className="text-center"></span>
                                <span className="min-w-0 truncate">Commit message</span>
                                <span className="min-w-0 truncate">Author</span>
                                <span className="text-right">When</span>
                              </div>
                              <ol className="m-0 list-none p-0">
                                {commits.map((c, idx) => {
                                  const isBrowsing = commitBrowseHash === c.hash;
                                  const branchCell =
                                    idx === 0 ? (
                                      <span
                                        className="flex min-w-0 items-center gap-0.5 truncate text-[0.65rem] leading-tight text-base-content"
                                        title={commitsSectionTitle}
                                      >
                                        <span className="shrink-0 text-primary" aria-hidden>
                                          ✓
                                        </span>
                                        <span className="min-w-0 truncate font-medium">
                                          {commitsSectionTitle}
                                        </span>
                                      </span>
                                    ) : (
                                      <span />
                                    );
                                  const rel = formatRelativeShort(c.date);
                                  const fullTitle = [
                                    `${c.shortHash} — ${c.subject}`,
                                    c.author,
                                    formatDate(c.date) ?? undefined,
                                  ]
                                    .filter(Boolean)
                                    .join("\n");
                                  return (
                                    <li
                                      key={c.hash}
                                      className="border-b border-base-300/40 last:border-b-0"
                                    >
                                      <button
                                        type="button"
                                        title={fullTitle}
                                        className={`grid w-full grid-cols-[minmax(0,5.5rem)_0.875rem_minmax(0,1fr)_minmax(0,6.5rem)_minmax(0,3.25rem)] items-center gap-x-1.5 px-1 py-0.5 text-left text-[0.6875rem] leading-tight transition-colors ${
                                          isBrowsing
                                            ? "bg-primary/20 ring-1 ring-primary/35 ring-inset"
                                            : "hover:bg-base-300/40"
                                        }`}
                                        onClick={() => void selectCommit(c.hash)}
                                      >
                                        <div className="min-w-0">{branchCell}</div>
                                        <div
                                          className="relative flex min-h-4.5 w-3.5 shrink-0 flex-col items-center justify-start pt-0.5"
                                          aria-hidden
                                        >
                                          <span className="absolute top-0 bottom-0 left-1/2 w-px -translate-x-1/2 bg-primary/35" />
                                          <span className="relative z-1 mt-px h-1.5 w-1.5 shrink-0 rounded-full border-base-100 bg-primary ring-1 ring-base-100" />
                                        </div>
                                        <span className="min-w-0 truncate text-base-content/90">
                                          {c.subject}
                                        </span>
                                        <span
                                          className="min-w-0 truncate text-[0.62rem] text-base-content/55"
                                          title={c.author.trim() || undefined}
                                        >
                                          {formatAuthorDisplay(c.author) || "—"}
                                        </span>
                                        <span
                                          className="shrink-0 text-right text-[0.6rem] text-base-content/45 tabular-nums"
                                          title={formatDate(c.date) ?? undefined}
                                        >
                                          {rel ?? "—"}
                                        </span>
                                      </button>
                                    </li>
                                  );
                                })}
                              </ol>
                            </>
                          )}
                        </div>
                      )}
                    </>
                  )}
                </>
              ) : (
                <p className="m-0 text-center text-[0.9375rem] text-base-content/60">
                  No repository open
                </p>
              )}
            </div>
          </section>
        </div>

        <aside className="col-span-12 flex min-h-0 min-w-0 flex-col gap-3 lg:sticky lg:top-6 lg:col-span-3 lg:h-full lg:max-h-[calc(100vh-5rem)] lg:min-h-0">
          <div className="card flex min-h-0 min-w-0 flex-1 flex-col border-base-300 bg-base-100 shadow-sm">
            <div className="card-body flex min-h-0 flex-1 flex-col gap-0 p-0">
              <section
                className="flex min-h-0 flex-[1_1_0%] flex-col border-b border-base-300"
                aria-labelledby="sidebar-unstaged-heading"
              >
                <div className="flex shrink-0 items-center justify-between gap-2 border-b border-base-300/80 px-3 py-2">
                  <h2
                    id="sidebar-unstaged-heading"
                    className="m-0 min-w-0 flex-1 text-xs font-semibold tracking-wide uppercase opacity-80"
                  >
                    Unstaged files ({unstagedFiles.length})
                  </h2>
                  {canShowBranches && unstagedPaths.length > 0 ? (
                    <button
                      type="button"
                      className="btn shrink-0 btn-outline btn-xs btn-success"
                      disabled={stageCommitBusy}
                      onClick={() => void onStagePaths(unstagedPaths)}
                    >
                      Stage all
                    </button>
                  ) : null}
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto p-2">
                  {!canShowBranches ? (
                    <p className="m-0 py-2 text-center text-xs text-base-content/50">
                      Open a repository to manage changes
                    </p>
                  ) : unstagedFiles.length === 0 ? (
                    <p className="m-0 py-2 text-center text-xs text-base-content/50">
                      {workingTreeFiles.length === 0 ? "No pending changes" : "No unstaged changes"}
                    </p>
                  ) : (
                    <ul className="m-0 flex list-none flex-col gap-1 p-0">
                      {unstagedFiles.map((f) => (
                        <StagePanelFileRow
                          key={f.path}
                          f={f}
                          variant="unstaged"
                          selected={selectedDiffPath === f.path}
                          busy={stageCommitBusy}
                          onSelect={() => void loadDiffForFile(f)}
                          onStage={() => void onStagePaths([f.path])}
                          onUnstage={() => void onUnstagePaths([f.path])}
                        />
                      ))}
                    </ul>
                  )}
                </div>
              </section>

              <section
                className="flex min-h-0 flex-[1_1_0%] flex-col border-b border-base-300"
                aria-labelledby="sidebar-staged-heading"
              >
                <div className="flex shrink-0 items-center justify-between gap-2 border-b border-base-300/80 px-3 py-2">
                  <h2
                    id="sidebar-staged-heading"
                    className="m-0 min-w-0 flex-1 text-xs font-semibold tracking-wide uppercase opacity-80"
                  >
                    Staged files ({stagedFiles.length})
                  </h2>
                  {canShowBranches && stagedPaths.length > 0 ? (
                    <button
                      type="button"
                      className="btn shrink-0 btn-outline btn-xs btn-error"
                      disabled={stageCommitBusy || commitPushBusy}
                      onClick={() => void onUnstagePaths(stagedPaths)}
                    >
                      Unstage all
                    </button>
                  ) : null}
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto p-2">
                  {!canShowBranches ? (
                    <p className="m-0 py-2 text-center text-xs text-base-content/50">
                      Open a repository to manage changes
                    </p>
                  ) : stagedFiles.length === 0 ? (
                    <p className="m-0 py-2 text-center text-xs text-base-content/50">
                      No staged changes
                    </p>
                  ) : (
                    <ul className="m-0 flex list-none flex-col gap-1 p-0">
                      {stagedFiles.map((f) => (
                        <StagePanelFileRow
                          key={f.path}
                          f={f}
                          variant="staged"
                          selected={selectedDiffPath === f.path}
                          busy={stageCommitBusy}
                          onSelect={() => void loadDiffForFile(f)}
                          onStage={() => void onStagePaths([f.path])}
                          onUnstage={() => void onUnstagePaths([f.path])}
                        />
                      ))}
                    </ul>
                  )}
                </div>
              </section>

              <section
                className="shrink-0 border-t border-base-300 bg-base-100 p-3"
                aria-labelledby="sidebar-commit-heading"
              >
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <h2
                    id="sidebar-commit-heading"
                    className="m-0 text-xs font-semibold tracking-wide uppercase opacity-80"
                  >
                    Commit
                  </h2>
                  <span className="ml-auto flex flex-wrap items-center gap-1.5">
                    <button
                      type="button"
                      className="btn gap-1 px-2 btn-ghost btn-xs"
                      disabled={!canPush}
                      title="Push the current branch to origin"
                      onClick={() => void onPushToOrigin()}
                    >
                      {pushBusy ? (
                        <span className="loading loading-xs loading-spinner" />
                      ) : (
                        <>
                          <span aria-hidden>↑</span>
                          <span className="hidden sm:inline">Push</span>
                        </>
                      )}
                    </button>
                  </span>
                </div>
                <label className="form-control w-full">
                  <span className="label-text mb-1 text-xs font-medium">Message</span>
                  <textarea
                    className="textarea-bordered textarea min-h-18 w-full resize-y font-sans text-sm textarea-sm"
                    placeholder="Describe your changes…"
                    value={commitMessage}
                    disabled={!canShowBranches || stageCommitBusy || commitPushBusy}
                    onChange={(e) => {
                      setCommitMessage(e.target.value);
                    }}
                    rows={3}
                  />
                </label>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    className="btn btn-outline btn-sm"
                    disabled={!canCommitAndPush}
                    title="Create the commit, then push the branch to origin"
                    onClick={() => void onCommitAndPush()}
                  >
                    {commitPushBusy ? (
                      <span className="loading loading-xs loading-spinner" />
                    ) : (
                      "Commit & Push"
                    )}
                  </button>
                  <button
                    type="button"
                    className="btn ml-auto btn-sm btn-primary"
                    disabled={!canCommit}
                    onClick={() => void onCommit()}
                  >
                    {stageCommitBusy ? (
                      <span className="loading loading-xs loading-spinner" />
                    ) : (
                      "Commit"
                    )}
                  </button>
                </div>
              </section>
            </div>
          </div>
        </aside>
      </div>
    </main>
  );
}
