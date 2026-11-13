/**
 * The web chat's Output (see the Output type in superagent.ts): what the
 * agent posts goes into the conversation's history (conversations.ts) instead
 * of Slack.
 *
 * The agent builds its replies for Slack (slackUi.ts, missionUi.ts). Here they
 * become what a web chat needs:
 *   - Slack "mrkdwn" becomes Markdown (*bold* -> **bold**, <url|text> -> [text](url)),
 *   - buttons become actions the UI can render and post back (server.ts),
 *   - the status message is one chat message edited in place, and when it
 *     belongs to an agent mission it carries the mission's live checklist,
 *   - uploaded files get a download link (/files/<token>).
 */
import type { KnownBlock } from "@slack/types";
import { existsSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { PROJECT_ROOT } from "../paths.ts";
import { getMission } from "../superagent/agent/missions.ts";
import { MISSION_CANCEL_BUTTON } from "../superagent/agent/missionUi.ts";
import { CANCEL_BUTTON, type Reply } from "../superagent/slackUi.ts";
import type { Ctx, Output } from "../superagent/superagent.ts";
import {
  getConversation,
  newMessageId,
  upsertMessage,
  type ChatAction,
  type ChatMessage,
  type MissionView,
} from "./conversations.ts";

/** Everyone using the web UI is the same person (no logins in this test setup). */
export const WEB_USER = "web";

const KEY_PREFIX = "web:";

/** The agent's memory key for a web conversation; keeps web chats apart from Slack ones. */
export const webKey = (conversationId: string) => `${KEY_PREFIX}${conversationId}`;
export const isWebKey = (key: string) => key.startsWith(KEY_PREFIX);
export const conversationIdOf = (key: string) => key.slice(KEY_PREFIX.length);

const EMOJI: Record<string, string> = {
  arrows_counterclockwise: "🔄",
  bar_chart: "📊",
  building_construction: "🏗️",
  calendar: "📅",
  clipboard: "📋",
  couch_and_lamp: "🛋️",
  dart: "🎯",
  hourglass_flowing_sand: "⏳",
  house: "🏠",
  large_green_circle: "🟢",
  large_orange_circle: "🟠",
  moneybag: "💰",
  octagonal_sign: "🛑",
  red_circle: "🔴",
  speech_balloon: "💬",
  warning: "⚠️",
  white_check_mark: "✅",
  white_circle: "⚪",
  x: "❌",
};

/** Slack mrkdwn to Markdown. Single line breaks become hard breaks, as Slack shows them. */
export function slackToMarkdown(text: string): string {
  return text
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, "[$2]($1)")
    .replace(/<(https?:[^>]+)>/g, "$1")
    .replace(/<@([A-Za-z0-9]+)>/g, "@$1")
    .replace(/:([a-z_0-9+-]+):/g, (code, name: string) => EMOJI[name] ?? code)
    .replace(/^(\s*)• /gm, "$1- ")
    .replace(/(^|[\s(>])\*([^*\n]+?)\*(?=$|[\s).,:;!?—-])/gm, "$1**$2**")
    .replace(/(^|[\s(>])_([^_\n]+?)_(?=$|[\s).,:;!?—-])/gm, "$1*$2*")
    .replace(/@superagent\s+/g, "")
    .replace(/([^\n])\n(?!\n)/g, "$1  \n");
}

type Button = {
  type: string;
  action_id?: string;
  value?: string;
  style?: "primary" | "danger";
  text?: { text: string };
};

function action(b: Button): ChatAction[] {
  if (b.type !== "button" || !b.action_id) return [];
  return [
    {
      label: b.text?.text ?? b.action_id,
      actionId: b.action_id,
      value: b.value ?? "",
      ...(b.style ? { style: b.style } : {}),
    },
  ];
}

/** A Slack reply as Markdown text and the buttons in it. */
export function fromReply(reply: Reply): { text: string; actions: ChatAction[] } {
  if (!reply.blocks?.length) return { text: slackToMarkdown(reply.text), actions: [] };
  const parts: string[] = [];
  const actions: ChatAction[] = [];
  for (const block of reply.blocks as KnownBlock[]) {
    if (block.type === "section") {
      const lines = [block.text?.text ?? "", ...(block.fields ?? []).map((f) => f.text)];
      parts.push(lines.filter(Boolean).join("\n"));
      if (block.accessory) actions.push(...action(block.accessory as Button));
    } else if (block.type === "context") {
      parts.push(block.elements.map((e) => ("text" in e ? e.text : "")).join(" "));
    } else if (block.type === "actions") {
      for (const e of block.elements) actions.push(...action(e as Button));
    }
  }
  return { text: slackToMarkdown(parts.filter(Boolean).join("\n\n")), actions };
}

// ---------------------------------------------------------------------------
// Files: only files inside output/ (where plans and reports are written) are
// served, addressed by a token made from their path inside it.
// ---------------------------------------------------------------------------

const OUTPUT = join(PROJECT_ROOT, "output");

export function fileUrl(path: string): string | null {
  const full = resolve(path);
  if (!full.startsWith(OUTPUT + sep)) return null;
  return `/files/${Buffer.from(relative(OUTPUT, full)).toString("base64url")}`;
}

/** The file a /files/<token> link points at, or undefined if it isn't a file in output/. */
export function fileForToken(token: string): string | undefined {
  const full = resolve(OUTPUT, Buffer.from(token, "base64url").toString("utf8"));
  return full.startsWith(OUTPUT + sep) && existsSync(full) ? full : undefined;
}

// ---------------------------------------------------------------------------
// The Output.
// ---------------------------------------------------------------------------

function missionView(id: string): MissionView | undefined {
  const m = getMission(id);
  if (!m) return undefined;
  return {
    id: m.id,
    goal: m.goal,
    state: m.state,
    steps: m.steps.map((s) => ({ ...s })),
    ...(m.pendingPlan
      ? {
          pendingPlan: {
            counts: m.pendingPlan.counts as Record<string, number>,
            minutes: m.pendingPlan.minutes,
          },
        }
      : {}),
    ...(m.pendingQuestion ? { pendingQuestion: m.pendingQuestion } : {}),
  };
}

function agentMessage(fields: Partial<ChatMessage> & Pick<ChatMessage, "kind" | "text">) {
  const now = new Date().toISOString();
  return { id: newMessageId(), role: "agent" as const, createdAt: now, updatedAt: now, ...fields };
}

/**
 * Plan and question buttons stop working once the mission moves on, so they
 * are taken off its earlier messages.
 */
function dropStaleButtons(conversationId: string, mission: MissionView): void {
  if (mission.state === "waiting-approval" || mission.state === "waiting-answer") return;
  for (const m of getConversation(conversationId)?.messages ?? []) {
    if (m.kind !== "text" || !m.actions) continue;
    const actions = m.actions.filter(
      (a) => !(a.value === mission.id || a.value.startsWith(`${mission.id}|`)),
    );
    if (actions.length < m.actions.length)
      upsertMessage(conversationId, { ...m, actions, updatedAt: new Date().toISOString() });
  }
}

/**
 * An Output that writes into one web conversation. Each Output has its own
 * status message, except that an agent mission keeps one status message for
 * its whole life: every Output that reports on it (after a button click, an
 * answer or a restart) edits that same message. `missionId` names the mission
 * when it is known up front.
 */
export function webOutput(conversationId: string, missionId?: string): Output {
  let status: ChatMessage | undefined;

  return {
    async reply(reply) {
      const { text, actions } = fromReply(reply);
      upsertMessage(
        conversationId,
        agentMessage({ kind: "text", text, ...(actions.length ? { actions } : {}) }),
      );
    },
    async status(text, opts) {
      if (opts?.cancelAction === MISSION_CANCEL_BUTTON && opts.cancelId) missionId = opts.cancelId;
      const actions: ChatAction[] = opts?.cancelId
        ? [
            {
              label: "Cancel",
              actionId: opts.cancelAction ?? CANCEL_BUTTON,
              value: opts.cancelId,
              style: "danger",
            },
          ]
        : [];
      const mission = missionId ? missionView(missionId) : undefined;
      status ??=
        [...(getConversation(conversationId)?.messages ?? [])]
          .reverse()
          .find((m) => m.kind === "status" && mission && m.mission?.id === mission.id) ??
        agentMessage({ kind: "status", text: "" });
      status = {
        ...status,
        text: slackToMarkdown(text),
        actions,
        mission,
        updatedAt: new Date().toISOString(),
      };
      upsertMessage(conversationId, status);
      if (mission) dropStaleButtons(conversationId, mission);
    },
    async upload(files, comment) {
      upsertMessage(
        conversationId,
        agentMessage({
          kind: "files",
          text: slackToMarkdown(comment),
          files: files.map((f) => ({
            title: f.title,
            name: basename(f.path),
            url: fileUrl(f.path),
          })),
        }),
      );
    },
  };
}

/** `missionId`: the mission this request is about, if known (a button on it, or an answer to it). */
export function webCtx(conversationId: string, user: string = WEB_USER, missionId?: string): Ctx {
  return {
    key: webKey(conversationId),
    user,
    out: webOutput(conversationId, missionId),
    mode: "thread",
    makeOutput: () => webOutput(conversationId),
  };
}
