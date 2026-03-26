import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";

export const DEFAULT_OPENAI_MODEL = "gpt-5.4-mini";

const MAX_DIFF_CHARS = 100_000;

/**
 * Uses the Vercel AI SDK (`ai`) with the OpenAI provider (`@ai-sdk/openai`, built on the `openai` package)
 * to propose a one-line commit subject from the full staged diff.
 */
export async function generateCommitTitleFromStagedDiff(options: {
  apiKey: string;
  /** OpenAI model id, e.g. `gpt-5.4-mini`. */
  model: string;
  stagedDiff: string;
}): Promise<string> {
  const openai = createOpenAI({ apiKey: options.apiKey });
  const modelId = options.model.trim() || DEFAULT_OPENAI_MODEL;
  let body = options.stagedDiff;
  if (body.length > MAX_DIFF_CHARS) {
    body = `${body.slice(0, MAX_DIFF_CHARS)}\n\n[diff truncated]`;
  }
  const { text } = await generateText({
    model: openai(modelId),
    system:
      "You write short Git commit subject lines. Reply with one line only: imperative mood, at most about 72 characters, no surrounding quotes, no markdown, no trailing period.",
    prompt: `Propose a commit title for this staged diff:\n\n${body}`,
  });
  const line = text
    .trim()
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return line ?? "";
}
