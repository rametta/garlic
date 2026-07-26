/**
 * Settings modal for theme selection, AI commit settings, and graph display preferences.
 * Search tags: settings page, theme picker, OpenAI API key, graph font size.
 */
import { memo, useCallback, useEffect, useState } from "react";
import { THEME_SELECT_OPTIONS } from "../appThemes";
import {
  clampGraphCommitTitleFontSizePx,
  GRAPH_COMMIT_TITLE_FONT_SIZE_MAX,
  GRAPH_COMMIT_TITLE_FONT_SIZE_MIN,
} from "../commitGraphLayout";
import { DEFAULT_OPENAI_MODEL } from "../generateCommitMessage";
import {
  useSetAutoFetchSettingsMutation,
  useSetGraphCommitTitleFontSizeMutation,
  useSetNotifyGitCompletionMutation,
  useSetOpenAiSettingsMutation,
  useSetThemeMutation,
} from "../repoMutations";
import { resolveThemePreference } from "../theme";
import {
  AUTO_FETCH_INTERVAL_MINUTES_MAX,
  AUTO_FETCH_INTERVAL_MINUTES_MIN,
  clampAutoFetchIntervalMinutes,
} from "../gitTypes";

function invokeErrorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message || String(error);
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export type SettingsPageProps = {
  onClose: () => void;
  themePreference: string;
  onThemePreferenceChange: (theme: string) => void;
  openaiApiKey: string;
  openaiModel: string;
  onOpenAiChange: (next: { apiKey: string; model: string }) => void;
  graphCommitTitleFontSizePx: number;
  onGraphCommitTitleFontSizeChange: (px: number) => void;
  notifyGitCompletion: boolean;
  onNotifyGitCompletionChange: (enabled: boolean) => void;
  autoFetchEnabled: boolean;
  autoFetchIntervalMinutes: number;
  onAutoFetchSettingsChange: (next: { enabled: boolean; intervalMinutes: number }) => void;
  onError: (message: string | null) => void;
};

export const SettingsPage = memo(function SettingsPage({
  onClose,
  themePreference,
  onThemePreferenceChange,
  openaiApiKey,
  openaiModel,
  onOpenAiChange,
  graphCommitTitleFontSizePx,
  onGraphCommitTitleFontSizeChange,
  notifyGitCompletion,
  onNotifyGitCompletionChange,
  autoFetchEnabled,
  autoFetchIntervalMinutes,
  onAutoFetchSettingsChange,
  onError,
}: SettingsPageProps) {
  const [themeDraft, setThemeDraft] = useState(themePreference);
  const [keyDraft, setKeyDraft] = useState(openaiApiKey);
  const [modelDraft, setModelDraft] = useState(openaiModel);
  const [fontDraft, setFontDraft] = useState(() => String(graphCommitTitleFontSizePx));
  const [autoFetchIntervalDraft, setAutoFetchIntervalDraft] = useState(() =>
    String(clampAutoFetchIntervalMinutes(autoFetchIntervalMinutes)),
  );

  const setThemeMutation = useSetThemeMutation();
  const setOpenAiMutation = useSetOpenAiSettingsMutation();
  const setGraphFontMutation = useSetGraphCommitTitleFontSizeMutation();
  const setNotifyGitCompletionMutation = useSetNotifyGitCompletionMutation();
  const setAutoFetchSettingsMutation = useSetAutoFetchSettingsMutation();

  useEffect(() => {
    setThemeDraft(themePreference);
  }, [themePreference]);

  useEffect(() => {
    setFontDraft(String(graphCommitTitleFontSizePx));
  }, [graphCommitTitleFontSizePx]);

  useEffect(() => {
    setKeyDraft(openaiApiKey);
    setModelDraft(openaiModel);
  }, [openaiApiKey, openaiModel]);

  useEffect(() => {
    setAutoFetchIntervalDraft(String(clampAutoFetchIntervalMinutes(autoFetchIntervalMinutes)));
  }, [autoFetchIntervalMinutes]);

  const themeBusy = setThemeMutation.isPending;
  const openAiBusy = setOpenAiMutation.isPending;
  const graphFontBusy = setGraphFontMutation.isPending;
  const notifyGitBusy = setNotifyGitCompletionMutation.isPending;
  const autoFetchBusy = setAutoFetchSettingsMutation.isPending;

  const applyTheme = useCallback(
    async (next: string) => {
      onError(null);
      try {
        await setThemeMutation.mutateAsync(next);
        onThemePreferenceChange(next);
        document.documentElement.setAttribute("data-theme", resolveThemePreference(next));
      } catch (e) {
        onError(invokeErrorMessage(e));
      }
    },
    [onError, onThemePreferenceChange, setThemeMutation],
  );

  const saveOpenAi = useCallback(async () => {
    onError(null);
    try {
      const trimmedKey = keyDraft.trim();
      const trimmedModel = modelDraft.trim();
      await setOpenAiMutation.mutateAsync({
        key: trimmedKey.length > 0 ? trimmedKey : null,
        model: trimmedModel.length > 0 ? trimmedModel : null,
      });
      onOpenAiChange({
        apiKey: trimmedKey,
        model: trimmedModel || DEFAULT_OPENAI_MODEL,
      });
    } catch (e) {
      onError(invokeErrorMessage(e));
    }
  }, [keyDraft, modelDraft, onError, onOpenAiChange, setOpenAiMutation]);

  const persistGraphFont = useCallback(
    async (px: number) => {
      const clamped = clampGraphCommitTitleFontSizePx(px);
      onError(null);
      try {
        await setGraphFontMutation.mutateAsync(clamped);
        onGraphCommitTitleFontSizeChange(clamped);
        setFontDraft(String(clamped));
      } catch (e) {
        onError(invokeErrorMessage(e));
      }
    },
    [onError, onGraphCommitTitleFontSizeChange, setGraphFontMutation],
  );

  const persistNotifyGitCompletion = useCallback(
    async (enabled: boolean) => {
      onError(null);
      try {
        await setNotifyGitCompletionMutation.mutateAsync(enabled);
        onNotifyGitCompletionChange(enabled);
      } catch (e) {
        onError(invokeErrorMessage(e));
      }
    },
    [onError, onNotifyGitCompletionChange, setNotifyGitCompletionMutation],
  );

  const persistAutoFetchSettings = useCallback(
    async (next: { enabled: boolean; intervalMinutes: number }) => {
      const intervalMinutes = clampAutoFetchIntervalMinutes(next.intervalMinutes);
      onError(null);
      try {
        await setAutoFetchSettingsMutation.mutateAsync({
          enabled: next.enabled,
          intervalMinutes,
        });
        onAutoFetchSettingsChange({
          enabled: next.enabled,
          intervalMinutes,
        });
        setAutoFetchIntervalDraft(String(intervalMinutes));
      } catch (e) {
        onError(invokeErrorMessage(e));
      }
    },
    [onAutoFetchSettingsChange, onError, setAutoFetchSettingsMutation],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <header className="flex shrink-0 items-center gap-3 border-b border-base-300 bg-base-100 px-4 py-3">
        <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
          ← Back
        </button>
        <h1 className="m-0 text-lg font-semibold text-base-content">Settings</h1>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6">
        <div className="mx-auto flex max-w-xl flex-col gap-8">
          <section className="flex flex-col gap-3">
            <h2 className="m-0 text-sm font-semibold tracking-wide text-base-content/80 uppercase">
              Appearance
            </h2>
            <label className="form-control w-full max-w-md">
              <span className="label-text mb-1">Theme</span>
              <select
                className="select-bordered select w-full select-sm"
                disabled={themeBusy}
                value={themeDraft}
                onChange={(e) => {
                  const next = e.target.value;
                  setThemeDraft(next);
                  void applyTheme(next);
                }}
              >
                {THEME_SELECT_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              <span className="label-text-alt mt-1 text-base-content/55">
                Also available from the menu bar. Auto follows your system light or dark mode.
              </span>
            </label>
          </section>

          <section className="flex flex-col gap-3">
            <h2 className="m-0 text-sm font-semibold tracking-wide text-base-content/80 uppercase">
              Commit graph
            </h2>
            <label className="form-control w-full max-w-md">
              <span className="label-text mb-1">Commit title font size</span>
              <div className="flex flex-wrap items-center gap-3">
                <input
                  type="range"
                  className="range max-w-xs flex-1 range-sm"
                  min={GRAPH_COMMIT_TITLE_FONT_SIZE_MIN}
                  max={GRAPH_COMMIT_TITLE_FONT_SIZE_MAX}
                  step={1}
                  disabled={graphFontBusy}
                  value={clampGraphCommitTitleFontSizePx(
                    Number(fontDraft) || graphCommitTitleFontSizePx,
                  )}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    setFontDraft(String(v));
                    void persistGraphFont(v);
                  }}
                />
                <input
                  type="number"
                  className="input-bordered input input-sm w-16 font-mono tabular-nums"
                  min={GRAPH_COMMIT_TITLE_FONT_SIZE_MIN}
                  max={GRAPH_COMMIT_TITLE_FONT_SIZE_MAX}
                  step={1}
                  disabled={graphFontBusy}
                  value={fontDraft}
                  onChange={(e) => {
                    setFontDraft(e.target.value);
                  }}
                  onBlur={() => {
                    const n = parseInt(fontDraft, 10);
                    if (!Number.isFinite(n)) {
                      setFontDraft(String(graphCommitTitleFontSizePx));
                      return;
                    }
                    void persistGraphFont(n);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      (e.target as HTMLInputElement).blur();
                    }
                  }}
                />
                <span className="text-sm text-base-content/60">px</span>
              </div>
              <span className="label-text-alt mt-1 text-base-content/55">
                Applies to commit subject lines in the main history graph. Row height adjusts
                automatically.
              </span>
            </label>
          </section>

          <section className="flex flex-col gap-3">
            <h2 className="m-0 text-sm font-semibold tracking-wide text-base-content/80 uppercase">
              Git
            </h2>
            <label className="flex max-w-md cursor-pointer flex-row items-start gap-3">
              <input
                type="checkbox"
                className="toggle mt-0.5 shrink-0 toggle-sm"
                checked={autoFetchEnabled}
                disabled={autoFetchBusy}
                onChange={(e) => {
                  void persistAutoFetchSettings({
                    enabled: e.target.checked,
                    intervalMinutes: autoFetchIntervalMinutes,
                  });
                }}
              />
              <span className="flex min-w-0 flex-col gap-1">
                <span className="font-medium text-base-content">Auto-fetch remotes</span>
                <span className="text-sm text-base-content/70">
                  Run <code className="font-mono">git fetch --all --quiet</code> for the open repo
                  on an interval. Auth failures pause auto-fetch until the repo watch restarts.
                </span>
              </span>
            </label>
            <label className="form-control w-full max-w-xs">
              <span className="label-text mb-1">Auto-fetch interval</span>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  className="input-bordered input input-sm w-24 font-mono tabular-nums"
                  min={AUTO_FETCH_INTERVAL_MINUTES_MIN}
                  max={AUTO_FETCH_INTERVAL_MINUTES_MAX}
                  step={1}
                  disabled={autoFetchBusy || !autoFetchEnabled}
                  value={autoFetchIntervalDraft}
                  onChange={(e) => {
                    setAutoFetchIntervalDraft(e.target.value);
                  }}
                  onBlur={() => {
                    const n = parseInt(autoFetchIntervalDraft, 10);
                    if (!Number.isFinite(n)) {
                      setAutoFetchIntervalDraft(String(autoFetchIntervalMinutes));
                      return;
                    }
                    void persistAutoFetchSettings({
                      enabled: autoFetchEnabled,
                      intervalMinutes: n,
                    });
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      (e.target as HTMLInputElement).blur();
                    }
                  }}
                />
                <span className="text-sm text-base-content/60">minutes</span>
              </div>
            </label>
          </section>

          <section className="flex flex-col gap-3">
            <h2 className="m-0 text-sm font-semibold tracking-wide text-base-content/80 uppercase">
              Notifications
            </h2>
            <label className="flex max-w-md cursor-pointer flex-row items-start gap-3">
              <input
                type="checkbox"
                className="toggle mt-0.5 shrink-0 toggle-sm"
                checked={notifyGitCompletion}
                disabled={notifyGitBusy}
                onChange={(e) => {
                  void persistNotifyGitCompletion(e.target.checked);
                }}
              />
              <span className="flex min-w-0 flex-col gap-1">
                <span className="font-medium text-base-content">
                  Long push and commit completion
                </span>
                <span className="text-sm text-base-content/70">
                  Show a system notification when a push or commit finishes after a short delay.
                  Uses your OS notification settings for Garlic.
                </span>
              </span>
            </label>
          </section>

          <section className="flex flex-col gap-3">
            <h2 className="m-0 text-sm font-semibold tracking-wide text-base-content/80 uppercase">
              OpenAI
            </h2>
            <p className="m-0 max-w-md text-sm text-base-content/70">
              Stored in your operating system&apos;s secure credential store. Used to suggest commit
              titles and descriptions from your staged diff via the OpenAI API.
            </p>
            <label className="form-control w-full max-w-md">
              <span className="label-text mb-1">API key</span>
              <input
                type="password"
                className="input-bordered input w-full font-mono text-sm"
                value={keyDraft}
                autoComplete="off"
                spellCheck={false}
                disabled={openAiBusy}
                placeholder="sk-…"
                onChange={(e) => {
                  setKeyDraft(e.target.value);
                }}
              />
            </label>
            <label className="form-control w-full max-w-md">
              <span className="label-text mb-1">Model</span>
              <input
                type="text"
                className="input-bordered input w-full font-mono text-sm"
                value={modelDraft}
                autoComplete="off"
                spellCheck={false}
                disabled={openAiBusy}
                placeholder={DEFAULT_OPENAI_MODEL}
                onChange={(e) => {
                  setModelDraft(e.target.value);
                }}
              />
            </label>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="btn btn-sm btn-primary"
                disabled={openAiBusy}
                onClick={() => void saveOpenAi()}
              >
                {openAiBusy ? (
                  <>
                    <span className="loading loading-xs loading-spinner" />
                    Saving…
                  </>
                ) : (
                  "Save OpenAI settings"
                )}
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
});
