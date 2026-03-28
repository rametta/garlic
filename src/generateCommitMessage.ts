import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";

export const DEFAULT_OPENAI_MODEL = "gpt-5.4-mini";

const MAX_DIFF_CHARS = 100_000;

export type GeneratedCommitMessage = {
  title: string;
  description: string;
};

/**
 * Uses the Vercel AI SDK (`ai`) with the OpenAI provider (`@ai-sdk/openai`, built on the `openai`
 * package) to propose a commit title plus a slightly more detailed description from the full staged
 * diff.
 */
export async function generateCommitMessageFromStagedDiff(options: {
  apiKey: string;
  /** OpenAI model id, e.g. `gpt-5.4-mini`. */
  model: string;
  stagedDiff: string;
}): Promise<GeneratedCommitMessage> {
  const openai = createOpenAI({ apiKey: options.apiKey });
  const modelId = options.model.trim() || DEFAULT_OPENAI_MODEL;
  let body = options.stagedDiff;
  if (body.length > MAX_DIFF_CHARS) {
    body = `${body.slice(0, MAX_DIFF_CHARS)}\n\n[diff truncated]`;
  }
  const { text } = await generateText({
    model: openai(modelId),
    system:
      "You write Git commit messages. Reply as plain text only. The first non-empty line must be a short imperative commit title, at most about 72 characters, with no surrounding quotes, no markdown, and no trailing period. After one blank line, write a concise description in 1-2 sentences with slightly more detail than the title, focused on the why and notable effects.",
    prompt: `Propose a commit title and description for this staged diff:\n\n${body}`,
  });
  const lines = text
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trimEnd());
  const titleIndex = lines.findIndex((line) => line.trim().length > 0);
  if (titleIndex < 0) {
    return { title: "", description: "" };
  }
  const title = lines[titleIndex]?.trim() ?? "";
  const description = lines
    .slice(titleIndex + 1)
    .join("\n")
    .trim();
  return { title, description };
}
