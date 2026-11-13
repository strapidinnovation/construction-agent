/**
 * The skills' model calls go through the two functions here:
 *   - chatJson: a reply that must match a JSON Schema (estimator, timeline, ...),
 *   - chatText: long free text with progress (the house designer).
 * (The agent talks to Claude through the Agent SDK instead; see agent/agent.ts.)
 *
 * Two backends can answer them, chosen with LLM_BACKEND:
 *   - "claude-code" (default): Claude, through the Claude Code command line and
 *     the subscription logged in on this computer (see claudeCode.ts),
 *   - "ollama": a local model such as qwen3.5:9b, run by Ollama.
 */
import ollama from "ollama";
import { runClaude } from "./claudeCode.ts";

export const BACKEND: "claude-code" | "ollama" =
  process.env.LLM_BACKEND === "ollama" ? "ollama" : "claude-code";
const CLAUDE = BACKEND === "claude-code";

/** A model name from .env, or `fallback`. Ollama names ("qwen3.5:9b", always with a ":tag") can't run on Claude. */
function claudeModel(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value && !value.includes(":") ? value : fallback;
}

/**
 * A model name from .env, or the backend's default. On Claude, Ollama names
 * are skipped, so a .env written for Ollama doesn't break the switch.
 */
function modelSetting(name: string, claudeDefault: string, ollamaDefault: string): string {
  if (CLAUDE) return claudeModel(name, claudeDefault);
  return process.env[name]?.trim() || ollamaDefault;
}

/** General-purpose model: feasibility verdicts and summaries. */
export const MODEL = CLAUDE ? "sonnet" : "qwen3.5:9b";

export const DESIGN_MODEL = modelSetting("DESIGN_MODEL", "sonnet", MODEL);

export const ESTIMATE_MODEL = modelSetting("ESTIMATE_MODEL", "sonnet", MODEL);

/** The model that drives the agent. Always Claude: the Agent SDK only runs Claude models. */
export const PLANNER_MODEL = claudeModel("PLANNER_MODEL", "sonnet");

/** JSON Schemas from zod carry a "$schema" key, which isn't part of the form itself. */
function withoutMeta(schema: object): object {
  const copy = { ...(schema as Record<string, unknown>) };
  delete copy.$schema;
  return copy;
}

export async function chatJson(
  system: string,
  user: string,
  schema: object,
  opts: { model?: string; numPredict?: number; numCtx?: number; temperature?: number } = {},
): Promise<string> {
  if (CLAUDE) {
    const reply = await runClaude({
      model: opts.model ?? MODEL,
      system,
      prompt: user,
      schema: withoutMeta(schema),
      effort: "low",
    });
    if (reply.truncated) throw new Error("The model's reply hit the output limit and was cut off.");
    // Callers parse the JSON text themselves, as with Ollama.
    return JSON.stringify(reply.structured);
  }
  const res = await ollama.chat({
    model: opts.model ?? MODEL,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    format: schema,
    think: false,
    options: {
      temperature: opts.temperature ?? 0,
      num_ctx: opts.numCtx ?? 16384,
      num_predict: opts.numPredict ?? 8000,
    },
  });
  if (res.done_reason === "length") {
    throw new Error("The model's reply hit the output limit and was cut off.");
  }
  return res.message.content;
}

export type Progress = { phase: "thinking" | "writing"; chars: number };

export async function chatText(
  model: string,
  system: string,
  user: string,
  opts: { think?: boolean; onProgress?: (p: Progress) => void } = {},
): Promise<{ content: string; truncated: boolean }> {
  if (CLAUDE) {
    const reply = await runClaude({
      model,
      system,
      prompt: user,
      effort: opts.think ? undefined : "low",
      onText: (chars) => opts.onProgress?.({ phase: "writing", chars }),
    });
    return { content: reply.text, truncated: reply.truncated };
  }
  const stream = await ollama.chat({
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    think: opts.think ?? false,
    stream: true,
    options: { temperature: 0.4, num_ctx: 32768, num_predict: 24000 },
  });

  let content = "";
  let thinkingChars = 0;
  let truncated = false;
  try {
    for await (const chunk of stream) {
      if (chunk.done) truncated = chunk.done_reason === "length";
      if (chunk.message.thinking) {
        thinkingChars += chunk.message.thinking.length;
        opts.onProgress?.({ phase: "thinking", chars: thinkingChars });
      }
      if (chunk.message.content) {
        content += chunk.message.content;
        opts.onProgress?.({ phase: "writing", chars: content.length });
      }
    }
  } catch (err) {
    // onProgress may throw to cancel; close the stream so Ollama stops generating.
    stream.abort();
    throw err;
  }
  return { content, truncated };
}
