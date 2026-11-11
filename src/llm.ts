import ollama, { type Message, type Tool } from "ollama";

export const MODEL = "qwen3.5:9b";

export const DESIGN_MODEL = process.env.DESIGN_MODEL || MODEL;

export const ESTIMATE_MODEL = process.env.ESTIMATE_MODEL || MODEL;

/** The model that drives the agent (decides which tools to call). A stronger model plans better. */
export const PLANNER_MODEL = process.env.PLANNER_MODEL || MODEL;

/**
 * Let the planner think before each decision. On by default: without it the
 * 9B model misread numbers in its final answers ("$551k is lower than $418k");
 * with it, answers were correct and barely slower. PLANNER_THINK=false turns it off.
 */
const PLANNER_THINK = process.env.PLANNER_THINK !== "false";

/** Ollama answers one request at a time; behind a long job, a request can wait past the 5-minute header timeout. */
function isBusyTimeout(err: unknown): boolean {
  const cause = err instanceof Error ? (err.cause as { code?: string } | undefined) : undefined;
  return (
    cause?.code === "UND_ERR_HEADERS_TIMEOUT" ||
    (err instanceof Error && /headers timeout/i.test(err.message))
  );
}

/**
 * One step of the agent: send the conversation and the tool list, get back
 * the model's next message (tool calls, or a final answer). Retried when
 * Ollama is busy with a long job, since the agent can afford to wait.
 */
export async function chatTools(messages: Message[], tools: Tool[]): Promise<Message> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await ollama.chat({
        model: PLANNER_MODEL,
        messages,
        tools,
        think: PLANNER_THINK,
        options: { temperature: 0.2, num_ctx: 32768, num_predict: 6000 },
      });
      return res.message;
    } catch (err) {
      if (attempt >= 4 || !isBusyTimeout(err)) throw err;
      console.warn(`Planner waited too long for Ollama (busy); retrying (attempt ${attempt + 1})`);
    }
  }
}

export async function chatJson(
  system: string,
  user: string,
  schema: object,
  opts: { model?: string; numPredict?: number; numCtx?: number; temperature?: number } = {},
): Promise<string> {
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
