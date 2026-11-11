import ollama from "ollama";

export const MODEL = "qwen3.5:9b";

export const DESIGN_MODEL = process.env.DESIGN_MODEL || MODEL;

export const ESTIMATE_MODEL = process.env.ESTIMATE_MODEL || MODEL;

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
