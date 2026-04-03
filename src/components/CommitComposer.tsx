import { invoke } from "@tauri-apps/api/core";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import {
  DEFAULT_OPENAI_MODEL,
  generateCommitMessageFromStagedDiff,
} from "../generateCommitMessage";

function composeCommitMessage(title: string, description: string): string {
  const trimmedTitle = title.trim();
  const trimmedDescription = description.trim();
  if (!trimmedTitle) return trimmedDescription;
  if (!trimmedDescription) return trimmedTitle;
  return `${trimmedTitle}\n\n${trimmedDescription}`;
}

function invokeErrorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message || String(error);
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export interface CommitComposerProps {
  repoPath: string | null;
  repoDetached: boolean;
  canShowBranches: boolean;
  hasStagedFiles: boolean;
  stageSyncBusy: boolean;
  stageCommitBusy: boolean;
  commitPushBusy: boolean;
  pushBusy: boolean;
  openaiApiKey: string;
  openaiModel: string;
  onCommit: (options: { message: string; amendLastCommit: boolean }) => Promise<boolean>;
  onCommitAndPush: (options: { message: string; skipHooks: boolean }) => Promise<boolean>;
  onPushToOrigin: (options: { skipHooks: boolean }) => Promise<void>;
  onOperationError: (message: string | null) => void;
}

export const CommitComposer = memo(function CommitComposer({
  repoPath,
  repoDetached,
  canShowBranches,
  hasStagedFiles,
  stageSyncBusy,
  stageCommitBusy,
  commitPushBusy,
  pushBusy,
  openaiApiKey,
  openaiModel,
  onCommit,
  onCommitAndPush,
  onPushToOrigin,
  onOperationError,
}: CommitComposerProps) {
  const [commitTitle, setCommitTitle] = useState("");
  const [commitBody, setCommitBody] = useState("");
  const [amendLastCommit, setAmendLastCommit] = useState(false);
  const [pushSkipHooks, setPushSkipHooks] = useState(false);
  const [aiCommitBusy, setAiCommitBusy] = useState(false);

  useEffect(() => {
    setCommitTitle("");
    setCommitBody("");
    setAmendLastCommit(false);
    setPushSkipHooks(false);
    setAiCommitBusy(false);
  }, [repoPath]);

  const controlsBusy = !canShowBranches || stageSyncBusy || stageCommitBusy || commitPushBusy;
  const commitTitleTrimmed = commitTitle.trim();
  const commitBodyTrimmed = commitBody.trim();
  const commitMessage = useMemo(
    () => composeCommitMessage(commitTitle, commitBody),
    [commitBody, commitTitle],
  );
  const invalidCommitDraft = commitTitleTrimmed.length === 0 && commitBodyTrimmed.length > 0;
  const canCommitAmend =
    amendLastCommit && !invalidCommitDraft && (commitTitleTrimmed.length > 0 || hasStagedFiles);
  const canCommitNormal =
    !amendLastCommit && !invalidCommitDraft && hasStagedFiles && commitTitleTrimmed.length > 0;
  const canCommit =
    Boolean(repoPath) &&
    (canCommitAmend || canCommitNormal) &&
    !stageSyncBusy &&
    !stageCommitBusy &&
    !commitPushBusy;
  const canPush =
    Boolean(repoPath) &&
    !repoDetached &&
    !stageSyncBusy &&
    !stageCommitBusy &&
    !commitPushBusy &&
    !pushBusy;
  const canCommitAndPush = canCommit && !repoDetached && !pushBusy && !amendLastCommit;
  const hasOpenAiApiKey = openaiApiKey.trim().length > 0;
  const canUseAiCommit =
    hasOpenAiApiKey &&
    Boolean(repoPath) &&
    hasStagedFiles &&
    !stageSyncBusy &&
    !stageCommitBusy &&
    !commitPushBusy &&
    !aiCommitBusy;

  const clearCommitDraft = useCallback(() => {
    setCommitTitle("");
    setCommitBody("");
    setAmendLastCommit(false);
  }, []);

  const handleCommit = useCallback(async () => {
    if (invalidCommitDraft) {
      onOperationError("Add a commit title before the description.");
      return;
    }
    const message = commitMessage.trim();
    if (!amendLastCommit && !message) return;
    if (amendLastCommit && message.length === 0 && !hasStagedFiles) return;
    const shouldClearDraft = await onCommit({ message, amendLastCommit });
    if (shouldClearDraft) clearCommitDraft();
  }, [
    amendLastCommit,
    clearCommitDraft,
    commitMessage,
    hasStagedFiles,
    invalidCommitDraft,
    onCommit,
    onOperationError,
  ]);

  const handleCommitAndPush = useCallback(async () => {
    if (invalidCommitDraft) {
      onOperationError("Add a commit title before the description.");
      return;
    }
    const message = commitMessage.trim();
    if (!message || !hasStagedFiles) return;
    const shouldClearDraft = await onCommitAndPush({ message, skipHooks: pushSkipHooks });
    if (shouldClearDraft) clearCommitDraft();
  }, [
    clearCommitDraft,
    commitMessage,
    hasStagedFiles,
    invalidCommitDraft,
    onCommitAndPush,
    onOperationError,
    pushSkipHooks,
  ]);

  const handleAiGenerateCommitMessage = useCallback(async () => {
    if (!repoPath || !hasStagedFiles) return;
    const key = openaiApiKey.trim();
    if (!key) return;
    setAiCommitBusy(true);
    onOperationError(null);
    try {
      const stagedDiff = await invoke<string>("get_staged_diff_all", {
        path: repoPath,
      });
      if (!stagedDiff.trim()) {
        onOperationError("Staged diff is empty; nothing to summarize.");
        return;
      }
      const nextMessage = await generateCommitMessageFromStagedDiff({
        apiKey: key,
        model: openaiModel.trim() || DEFAULT_OPENAI_MODEL,
        stagedDiff,
      });
      if (!nextMessage.title) {
        onOperationError("The model returned an empty message.");
        return;
      }
      setCommitTitle(nextMessage.title);
      setCommitBody(nextMessage.description);
    } catch (error) {
      onOperationError(invokeErrorMessage(error));
    } finally {
      setAiCommitBusy(false);
    }
  }, [hasStagedFiles, onOperationError, openaiApiKey, openaiModel, repoPath]);

  return (
    <section
      className="flex min-h-0 min-w-0 flex-[1_1_0%] flex-col"
      aria-labelledby="sidebar-commit-heading"
    >
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden p-3">
        <div className="flex shrink-0 flex-col gap-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2
              id="sidebar-commit-heading"
              className="m-0 text-xs font-semibold tracking-wide uppercase opacity-80"
            >
              Commit
            </h2>
            <div className="flex flex-wrap items-center gap-2">
              <label className="label cursor-pointer gap-1.5 py-0">
                <input
                  type="checkbox"
                  className="checkbox checkbox-xs"
                  checked={pushSkipHooks}
                  onChange={(e) => {
                    setPushSkipHooks(e.target.checked);
                  }}
                />
                <span
                  className="label-text text-[0.65rem] leading-tight"
                  title="Skip local pre-push and other hooks (--no-verify)"
                >
                  Skip hooks
                </span>
              </label>
              <button
                type="button"
                className="btn shrink-0 gap-1 px-2 btn-ghost btn-xs"
                disabled={!canPush}
                title="Push the current branch to origin"
                onClick={() => {
                  void onPushToOrigin({ skipHooks: pushSkipHooks });
                }}
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
            </div>
          </div>
          <div className="flex cursor-pointer items-center gap-2.5">
            <input
              id="commit-amend-checkbox"
              type="checkbox"
              className="checkbox checkbox-sm"
              checked={amendLastCommit}
              disabled={controlsBusy}
              onChange={(e) => {
                setAmendLastCommit(e.target.checked);
              }}
            />
            <label
              htmlFor="commit-amend-checkbox"
              className="cursor-pointer text-xs leading-snug text-base-content/90"
            >
              Amend last commit
            </label>
          </div>
        </div>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
          <div className="form-control min-w-0">
            <input
              type="text"
              className="input input-sm w-full font-sans text-sm"
              placeholder={
                amendLastCommit ? "Title: leave empty to keep the previous message" : "Title"
              }
              value={commitTitle}
              disabled={controlsBusy}
              onChange={(e) => {
                setCommitTitle(e.target.value);
              }}
            />
          </div>
          <div className="form-control flex min-h-0 min-w-0 flex-1 flex-col gap-1">
            <textarea
              className="textarea min-h-0 w-full flex-1 resize-none overflow-y-auto font-sans text-sm textarea-sm"
              placeholder="Description"
              value={commitBody}
              disabled={controlsBusy}
              onChange={(e) => {
                setCommitBody(e.target.value);
              }}
            />
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <button
            type="button"
            className="btn btn-outline btn-sm"
            disabled={!canCommitAndPush}
            title="Create the commit, then push the branch to origin"
            onClick={() => {
              void handleCommitAndPush();
            }}
          >
            {commitPushBusy ? (
              <span className="loading loading-xs loading-spinner" />
            ) : (
              "Commit & Push"
            )}
          </button>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {hasOpenAiApiKey ? (
              <button
                type="button"
                className="btn btn-sm btn-primary"
                disabled={!canUseAiCommit}
                title="Generate a commit title and description from staged changes using OpenAI"
                aria-label="Generate a commit title and description from staged changes using OpenAI"
                onClick={() => {
                  void handleAiGenerateCommitMessage();
                }}
              >
                {aiCommitBusy ? <span className="loading loading-xs loading-spinner" /> : "✨"}
              </button>
            ) : null}
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={!canCommit}
              onClick={() => {
                void handleCommit();
              }}
            >
              {stageCommitBusy ? <span className="loading loading-xs loading-spinner" /> : "Commit"}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
});
