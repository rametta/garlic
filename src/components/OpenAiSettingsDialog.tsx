import { invoke } from "@tauri-apps/api/core";
import { createPortal } from "react-dom";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { DEFAULT_OPENAI_MODEL } from "../generateCommitMessage";

function invokeErrorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message || String(error);
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export interface OpenAiSettingsDialogProps {
  isOpen: boolean;
  apiKey: string;
  model: string;
  onClose: () => void;
  onSaved: (settings: { apiKey: string; model: string }) => void;
  onError: (message: string | null) => void;
}

export const OpenAiSettingsDialog = memo(function OpenAiSettingsDialog({
  isOpen,
  apiKey,
  model,
  onClose,
  onSaved,
  onError,
}: OpenAiSettingsDialogProps) {
  const apiKeyInputRef = useRef<HTMLInputElement>(null);
  const [keyDraft, setKeyDraft] = useState(apiKey);
  const [modelDraft, setModelDraft] = useState(model);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setKeyDraft(apiKey);
    setModelDraft(model);
    setBusy(false);
  }, [apiKey, isOpen, model]);

  useEffect(() => {
    if (!isOpen) return;
    const id = requestAnimationFrame(() => {
      apiKeyInputRef.current?.focus();
      apiKeyInputRef.current?.select();
    });
    return () => {
      cancelAnimationFrame(id);
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [isOpen, onClose]);

  const save = useCallback(async () => {
    setBusy(true);
    onError(null);
    try {
      const trimmedKey = keyDraft.trim();
      const trimmedModel = modelDraft.trim();
      await invoke("set_openai_settings", {
        key: trimmedKey.length > 0 ? trimmedKey : null,
        model: trimmedModel.length > 0 ? trimmedModel : null,
      });
      onSaved({
        apiKey: trimmedKey,
        model: trimmedModel || DEFAULT_OPENAI_MODEL,
      });
      onClose();
    } catch (error) {
      onError(invokeErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }, [keyDraft, modelDraft, onClose, onError, onSaved]);

  if (!isOpen) return null;

  return createPortal(
    <div
      className="modal-open modal pointer-events-auto z-9999"
      role="presentation"
      onClick={() => {
        onClose();
      }}
    >
      <div
        className="modal-box"
        role="dialog"
        aria-modal="true"
        aria-labelledby="openai-settings-title"
        onClick={(event) => {
          event.stopPropagation();
        }}
      >
        <h3 id="openai-settings-title" className="m-0 text-lg font-bold">
          OpenAI settings
        </h3>
        <p className="mt-1 mb-0 text-sm text-base-content/70">
          Stored only on this device in Garlic settings. Used to suggest commit titles and
          descriptions from your staged diff via the OpenAI API.
        </p>
        <label className="form-control mt-4 w-full">
          <span className="label-text mb-1">API key</span>
          <input
            ref={apiKeyInputRef}
            type="password"
            className="input-bordered input w-full font-mono text-sm"
            value={keyDraft}
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
            placeholder="sk-…"
            onChange={(event) => {
              setKeyDraft(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void save();
              }
            }}
          />
        </label>
        <label className="form-control mt-3 w-full">
          <span className="label-text mb-1">Model</span>
          <input
            type="text"
            className="input-bordered input w-full font-mono text-sm"
            value={modelDraft}
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
            placeholder={DEFAULT_OPENAI_MODEL}
            title="OpenAI model id (e.g. gpt-5.4-mini)"
            onChange={(event) => {
              setModelDraft(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void save();
              }
            }}
          />
          <span className="label-text-alt text-base-content/60">
            Default is {DEFAULT_OPENAI_MODEL} (fast). Leave empty to use the default.
          </span>
        </label>
        <div className="modal-action">
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => {
              onClose();
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={() => {
              void save();
            }}
          >
            {busy ? <span className="loading loading-sm loading-spinner" /> : "Save"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
});
