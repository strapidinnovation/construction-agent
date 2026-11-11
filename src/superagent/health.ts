/**
 * Checks that the AI model is ready before SuperAgent promises to do work.
 *
 * Every skill depends on Ollama running on this computer with the right model
 * downloaded ("pulled"). If it isn't, a design would only fail several
 * minutes later with a cryptic error. Checking first lets the bot answer
 * right away with something useful, e.g. "Ollama is not running" or "the
 * model qwen3.5:9b isn't downloaded; run `ollama pull qwen3.5:9b`".
 */
import ollama from "ollama";

/** How long to wait for Ollama to answer before calling it unreachable. */
const TIMEOUT_MS = 5000;

/**
 * Returns null when Ollama is up and every model in `models` is installed,
 * otherwise a short explanation of what is wrong.
 */
export async function checkOllama(models: string[]): Promise<string | null> {
  let installed: string[];
  try {
    // ollama.list() returns the models downloaded on this computer. Racing it
    // against a timer means a hung Ollama can't make the bot hang too.
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("timeout")), TIMEOUT_MS),
    );
    const list = await Promise.race([ollama.list(), timeout]);
    installed = list.models.map((m) => m.name);
  } catch {
    return "Ollama, which runs my AI model, isn't running on the computer that hosts me.";
  }

  // Ollama names models like "qwen3.5:9b"; a name without a tag means ":latest".
  const has = (m: string) => installed.includes(m) || installed.includes(`${m}:latest`);
  const missing = [...new Set(models)].filter((m) => !has(m));
  if (missing.length)
    return `the AI model ${missing.join(", ")} isn't downloaded. Run \`ollama pull ${missing[0]}\` on the computer that hosts me.`;
  return null;
}
