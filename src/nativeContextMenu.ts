import { isTauri } from "@tauri-apps/api/core";
import { LogicalPosition } from "@tauri-apps/api/dpi";
import { Menu } from "@tauri-apps/api/menu";
import type { MenuItemOptions } from "@tauri-apps/api/menu";

/** Context menus use the OS shell via Tauri; plain Vite dev keeps the browser default menu. */
export function nativeContextMenusAvailable(): boolean {
  return isTauri();
}

async function showMenuAt(
  clientX: number,
  clientY: number,
  items: MenuItemOptions[],
): Promise<void> {
  const menu = await Menu.new({ items });
  await menu.popup(new LogicalPosition(clientX, clientY));
}

export async function popupBranchContextMenu(
  clientX: number,
  clientY: number,
  args: {
    kind: "local" | "remote";
    branchName?: string;
    fullRef?: string;
    currentBranchName: string | null;
    repoDetached: boolean;
    branchBusy: boolean;
    onPull: () => void;
    /** Check out this branch (local) or create from remote ref. */
    onCheckout?: () => void;
    onMerge: () => void;
    onRebase: () => void;
    onRebaseInteractive: () => void;
    onDelete: () => void;
    onForceDelete: () => void;
    onDeleteRemote?: () => void;
    /** When set (e.g. for `origin/*` refs), edit that remote's fetch URL. */
    onEditOriginUrl?: () => void;
  },
): Promise<void> {
  if (!isTauri()) return;
  const disableRebaseOnto = args.kind === "local" && args.branchName === args.currentBranchName;
  const isCurrentLocalBranch = args.kind === "local" && args.branchName === args.currentBranchName;

  const mergeDisabled = args.branchBusy || disableRebaseOnto || args.repoDetached;
  const rebaseDisabled = args.branchBusy || disableRebaseOnto;
  const deleteDisabled = args.branchBusy || isCurrentLocalBranch;

  const items: MenuItemOptions[] = [];

  if (args.kind === "local" && args.onCheckout && !isCurrentLocalBranch) {
    items.push({
      id: "branch_checkout",
      text: "Check out branch",
      enabled: !args.branchBusy,
      action: () => {
        args.onCheckout!();
      },
    });
  }

  if (args.kind === "remote" && args.onCheckout) {
    items.push({
      id: "remote_checkout",
      text: "Check out (create local branch)…",
      enabled: !args.branchBusy,
      action: () => {
        args.onCheckout!();
      },
    });
  }

  if (args.kind === "local") {
    items.push({
      id: "branch_pull",
      text: "Pull",
      enabled: !args.branchBusy,
      action: () => {
        args.onPull();
      },
    });
  }

  items.push(
    {
      id: "branch_merge",
      text: "Merge into current branch",
      enabled: !mergeDisabled,
      action: () => {
        args.onMerge();
      },
    },
    {
      id: "branch_rebase",
      text: "Rebase current branch onto this",
      enabled: !rebaseDisabled,
      action: () => {
        args.onRebase();
      },
    },
    {
      id: "branch_rebase_i",
      text: "Interactive rebase onto this…",
      enabled: !rebaseDisabled,
      action: () => {
        args.onRebaseInteractive();
      },
    },
  );

  if (args.kind === "local") {
    items.push(
      {
        id: "branch_delete",
        text: "Delete branch…",
        enabled: !deleteDisabled,
        action: () => {
          args.onDelete();
        },
      },
      {
        id: "branch_force_delete",
        text: "Force delete…",
        enabled: !deleteDisabled,
        action: () => {
          args.onForceDelete();
        },
      },
    );
  }

  if (args.kind === "remote" && args.onEditOriginUrl) {
    items.push({
      id: "remote_edit_origin_url",
      text: "Edit origin URL…",
      enabled: !args.branchBusy,
      action: () => {
        args.onEditOriginUrl!();
      },
    });
  }

  if (args.kind === "remote" && args.onDeleteRemote) {
    items.push({
      id: "remote_branch_delete",
      text: "Delete remote branch…",
      enabled: !args.branchBusy,
      action: () => {
        args.onDeleteRemote!();
      },
    });
  }

  try {
    await showMenuAt(clientX, clientY, items);
  } catch (e) {
    console.error("native branch context menu failed", e);
  }
}

export async function popupStashContextMenu(
  clientX: number,
  clientY: number,
  args: {
    disabled: boolean;
    onPop: () => void;
    onDrop: () => void;
  },
): Promise<void> {
  if (!isTauri()) return;
  try {
    await showMenuAt(clientX, clientY, [
      {
        id: "stash_pop",
        text: "Pop stash…",
        enabled: !args.disabled,
        action: () => {
          args.onPop();
        },
      },
      {
        id: "stash_drop",
        text: "Delete stash…",
        enabled: !args.disabled,
        action: () => {
          args.onDrop();
        },
      },
    ]);
  } catch (e) {
    console.error("native stash context menu failed", e);
  }
}

export async function popupWorktreeContextMenu(
  clientX: number,
  clientY: number,
  args: {
    disabled: boolean;
    canOpen: boolean;
    canBrowse: boolean;
    canApply: boolean;
    canDelete: boolean;
    onOpen: () => void;
    onBrowse: () => void;
    onApply: () => void;
    onDelete: () => void;
  },
): Promise<void> {
  if (!isTauri()) return;
  const items: MenuItemOptions[] = [
    {
      id: "worktree_open",
      text: "Open worktree",
      enabled: !args.disabled && args.canOpen,
      action: () => {
        args.onOpen();
      },
    },
    {
      id: "worktree_browse",
      text: "Browse changes",
      enabled: !args.disabled && args.canBrowse,
      action: () => {
        args.onBrowse();
      },
    },
    {
      id: "worktree_apply",
      text: "Apply branch to current branch…",
      enabled: !args.disabled && args.canApply,
      action: () => {
        args.onApply();
      },
    },
    {
      id: "worktree_delete",
      text: "Delete worktree…",
      enabled: !args.disabled && args.canDelete,
      action: () => {
        args.onDelete();
      },
    },
  ];
  try {
    await showMenuAt(clientX, clientY, items);
  } catch (e) {
    console.error("native worktree context menu failed", e);
  }
}

export async function popupFileRowContextMenu(
  clientX: number,
  clientY: number,
  args:
    | {
        source: "worktree";
        variant: "staged" | "unstaged";
        branchBusy: boolean;
        stageCommitBusy: boolean;
        discardLabel: string;
        onHistory: () => void;
        onBlame: () => void;
        onOpenInCursor: () => void;
        onDiscard: () => void;
      }
    | {
        source: "commitBrowse";
        branchBusy: boolean;
        onHistory: () => void;
        onBlame: () => void;
      },
): Promise<void> {
  if (!isTauri()) return;
  const items: MenuItemOptions[] = [
    {
      id: "file_history",
      text: "File history",
      enabled: !args.branchBusy,
      action: () => {
        args.onHistory();
      },
    },
    {
      id: "file_blame",
      text: "Blame",
      enabled: !args.branchBusy,
      action: () => {
        args.onBlame();
      },
    },
  ];

  if (args.source === "worktree") {
    items.push({
      id: "file_open_cursor",
      text: "Open in Cursor",
      enabled: true,
      action: () => {
        args.onOpenInCursor();
      },
    });
    items.push({
      id: "file_discard",
      text: args.discardLabel,
      enabled: !(args.branchBusy || args.stageCommitBusy),
      action: () => {
        args.onDiscard();
      },
    });
  }

  try {
    await showMenuAt(clientX, clientY, items);
  } catch (e) {
    console.error("native file context menu failed", e);
  }
}

export async function popupGraphCommitContextMenu(
  clientX: number,
  clientY: number,
  args: {
    branchBusy: boolean;
    cherryPickDisabled: boolean;
    rebaseOntoDisabled: boolean;
    onBrowse: () => void;
    onCherryPick: () => void;
    onRebaseCurrentOnto: () => void;
    onCreateBranch: () => void;
    onCreateTag: () => void;
    onCopyFull: () => void;
    onCopyShort: () => void;
  },
): Promise<void> {
  if (!isTauri()) return;
  try {
    await showMenuAt(clientX, clientY, [
      {
        id: "commit_browse",
        text: "Browse commit",
        enabled: true,
        action: () => {
          args.onBrowse();
        },
      },
      {
        id: "commit_rebase_onto",
        text: "Rebase current branch onto this commit",
        enabled: !args.branchBusy && !args.rebaseOntoDisabled,
        action: () => {
          args.onRebaseCurrentOnto();
        },
      },
      {
        id: "commit_cherry_pick",
        text: "Cherry-pick this commit",
        enabled: !args.cherryPickDisabled,
        action: () => {
          args.onCherryPick();
        },
      },
      {
        id: "commit_branch",
        text: "Create branch from here…",
        enabled: !args.branchBusy,
        action: () => {
          args.onCreateBranch();
        },
      },
      {
        id: "commit_tag",
        text: "Create tag…",
        enabled: !args.branchBusy,
        action: () => {
          args.onCreateTag();
        },
      },
      {
        id: "commit_copy_full",
        text: "Copy full hash",
        enabled: true,
        action: () => {
          args.onCopyFull();
        },
      },
      {
        id: "commit_copy_short",
        text: "Copy short hash",
        enabled: true,
        action: () => {
          args.onCopyShort();
        },
      },
    ]);
  } catch (e) {
    console.error("native commit context menu failed", e);
  }
}

export async function popupTagSidebarMenu(
  clientX: number,
  clientY: number,
  args: {
    disabled: boolean;
    hasOrigin: boolean;
    onOrigin: boolean;
    onDeleteLocal: () => void;
    onDeleteRemote: () => void;
    onPushToOrigin: () => void;
  },
): Promise<void> {
  if (!isTauri()) return;
  const deleteRemoteEnabled = !args.disabled && args.hasOrigin && args.onOrigin;
  const pushEnabled = !args.disabled && args.hasOrigin && !args.onOrigin;
  try {
    await showMenuAt(clientX, clientY, [
      {
        id: "tag_sidebar_delete_local",
        text: "Delete local tag…",
        enabled: !args.disabled,
        action: () => {
          args.onDeleteLocal();
        },
      },
      {
        id: "tag_sidebar_delete_remote",
        text: "Delete tag on origin…",
        enabled: deleteRemoteEnabled,
        action: () => {
          args.onDeleteRemote();
        },
      },
      {
        id: "tag_sidebar_push_origin",
        text: "Push tag to origin…",
        enabled: pushEnabled,
        action: () => {
          args.onPushToOrigin();
        },
      },
    ]);
  } catch (e) {
    console.error("native tag sidebar context menu failed", e);
  }
}

export async function popupGraphTagContextMenu(
  clientX: number,
  clientY: number,
  args: {
    pushDisabled: boolean;
    onPushToOrigin: () => void;
  },
): Promise<void> {
  if (!isTauri()) return;
  try {
    await showMenuAt(clientX, clientY, [
      {
        id: "tag_push_origin",
        text: "Push tag to origin",
        enabled: !args.pushDisabled,
        action: () => {
          args.onPushToOrigin();
        },
      },
    ]);
  } catch (e) {
    console.error("native tag context menu failed", e);
  }
}
