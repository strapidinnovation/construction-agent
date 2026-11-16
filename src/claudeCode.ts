/**
 * Runs Claude through the Claude Code command line (`claude -p`), using the
 * Claude subscription logged in on this computer instead of an API key.
 *
 * Every call is one fresh, locked-down `claude` process:
 *   - no built-in tools (--tools ""), so it can't read files, run commands or
 *     browse; SuperAgent's own tools are the only things it can ask for.
 *     A caller may allow web search and page reading (`webSearch`), never
 *     files or commands,
 *   - no settings, MCP servers, slash commands or saved sessions from this
 *     computer, and it runs in an empty folder,
 *   - our system prompt replaces Claude Code's coding-assistant one.
 * The prompt goes in through stdin (no length limit) and the reply comes back
 * as JSON, or as a stream of JSON lines when progress is wanted.
 */
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** An empty folder to run in, so no project files or CLAUDE.md are picked up. */
const WORKDIR = join(tmpdir(), "superagent-claude");

const WEB_TOOLS = "WebSearch,WebFetch";

/** A long design can write for several minutes; anything past this is stuck. */
const TIMEOUT_MS = 15 * 60 * 1000;

export type ClaudeRequest = {
  /** A model alias ("sonnet", "haiku", "opus") or a full model name. */
  model: string;
  system: string;
  prompt: string;
  /** JSON Schema the reply must match; the parsed reply comes back as `structured`. */
  schema?: object;
  /** How hard it thinks: "low" for quick routing, higher for planning and design. */
  effort?: "low" | "medium" | "high";
  /** Let Claude search the web and read pages (WebSearch, WebFetch). */
  webSearch?: boolean;
  /** Called with the text written so far (streams the reply). Throw from it to cancel. */
  onText?: (chars: number) => void;
};

export type ClaudeReply = {
  text: string;
  structured?: unknown;
  /** The reply hit the output limit and was cut off. */
  truncated: boolean;
};

export async function runClaude(req: ClaudeRequest): Promise<ClaudeReply> {
  mkdirSync(WORKDIR, { recursive: true });
  const stream = Boolean(req.onText);
  const args = [
    "-p",
    "--model",
    req.model,
    "--system-prompt",
    req.system,
    "--tools",
    req.webSearch ? WEB_TOOLS : "",
    ...(req.webSearch ? ["--allowedTools", WEB_TOOLS] : []),
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--no-session-persistence",
    "--output-format",
    stream ? "stream-json" : "json",
    ...(stream ? ["--verbose", "--include-partial-messages"] : []),
    ...(req.schema ? ["--json-schema", JSON.stringify(req.schema)] : []),
    ...(req.effort ? ["--effort", req.effort] : []),
  ];
  const child = spawn("claude", args, { cwd: WORKDIR, stdio: ["pipe", "pipe", "pipe"] });
  const timer = setTimeout(() => child.kill(), TIMEOUT_MS);

  let result: Record<string, unknown> | undefined;
  let stdout = "";
  let stderr = "";
  let written = 0;
  let failure: unknown;
  let pending = "";

  // In stream mode each line is one event: text as it is written, then the result.
  const onLine = (line: string) => {
    if (!line.trim()) return;
    const event = JSON.parse(line) as Record<string, unknown>;
    if (event.type === "result") result = event;
    const delta = (event.event as { delta?: { type?: string; text?: string } } | undefined)?.delta;
    if (delta?.type === "text_delta" && delta.text) {
      written += delta.text.length;
      req.onText!(written);
    }
  };

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    if (!stream) {
      stdout += chunk;
      return;
    }
    pending += chunk;
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    try {
      for (const line of lines) onLine(line);
    } catch (err) {
      // onText threw (the job was cancelled): stop Claude and report that error.
      failure ??= err;
      child.kill();
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => (stderr += chunk));
  child.stdin.end(req.prompt);

  const code = await new Promise<number | null>((resolve, reject) => {
    child.on("error", (err) =>
      reject(
        (err as NodeJS.ErrnoException).code === "ENOENT"
          ? new Error(
              "Claude Code isn't installed on this computer (the `claude` command is missing).",
            )
          : err,
      ),
    );
    child.on("close", resolve);
  }).finally(() => clearTimeout(timer));

  if (failure) throw failure;
  if (stream && pending.trim()) onLine(pending);
  if (!stream && stdout.trim()) result = JSON.parse(stdout) as Record<string, unknown>;
  if (!result)
    throw new Error(
      `Claude stopped without an answer (exit code ${code}). ${stderr.trim().slice(0, 300)}`,
    );
  if (result.is_error || result.subtype !== "success")
    throw new Error(`Claude couldn't answer: ${String(result.result ?? result.subtype)}`);
  return {
    text: typeof result.result === "string" ? result.result : "",
    structured: result.structured_output,
    truncated: result.stop_reason === "max_tokens",
  };
}

/** Null when Claude Code is installed and logged in, otherwise what is wrong. */
export async function checkClaude(): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn("claude", ["auth", "status"], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (c: string) => (out += c));
    child.on("error", () =>
      resolve("Claude Code isn't installed on the computer that hosts me (`claude` is missing)."),
    );
    child.on("close", () => {
      try {
        const status = JSON.parse(out) as { loggedIn?: boolean };
        resolve(
          status.loggedIn
            ? null
            : "Claude Code isn't logged in on the computer that hosts me. Run `claude` there and log in.",
        );
      } catch {
        resolve("I couldn't check Claude Code's login on the computer that hosts me.");
      }
    });
  });
}
