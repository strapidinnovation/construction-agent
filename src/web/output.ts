/**
 * The web chat's Output (see the Output type in superagent.ts): what the
 * agent posts goes into the conversation's history (conversations.ts).
 *   - replies are Markdown with their buttons, which the UI renders and
 *     posts back (server.ts),
 *   - the status message is one chat message edited in place, and when it
 *     belongs to an agent mission it carries the mission's live checklist,
 *   - uploaded files get a download link (/files/<token>), and PDFs posted in
 *     a chat opened from a project are filed under that project.
 */
import { existsSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { PROJECT_ROOT } from "../paths.ts";
import { fileDocuments } from "../projectDocuments.ts";
import { MISSION_CANCEL_BUTTON } from "../superagent/agent/missionReplies.ts";
import { getMission } from "../superagent/agent/missions.ts";
import { CANCEL_BUTTON } from "../superagent/replies.ts";
import { WEB_KEY_PREFIX } from "../superagent/sessions.ts";
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

/** The agent's memory key for a web conversation. */
export const webKey = (conversationId: string) => `${WEB_KEY_PREFIX}${conversationId}`;
export const conversationIdOf = (key: string) => key.slice(WEB_KEY_PREFIX.length);

/**
 * Replies put one fact per line ("**Lot**\n60 x 150 ft"), so a single line
 * break is shown as one instead of being joined into the line before (Markdown's default).
 */
const hardBreaks = (text: string) => text.replace(/([^\n])\n(?!\n)/g, "$1  \n");

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
    async reply({ text, actions }) {
      upsertMessage(
        conversationId,
        agentMessage({
          kind: "text",
          text: hardBreaks(text),
          ...(actions?.length ? { actions } : {}),
        }),
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
        text: hardBreaks(text),
        actions,
        mission,
        updatedAt: new Date().toISOString(),
      };
      upsertMessage(conversationId, status);
      if (mission) dropStaleButtons(conversationId, mission);
    },
    async upload(files, comment) {
      const projectId = getConversation(conversationId)?.projectId;
      if (projectId) await fileDocuments(projectId, conversationId, files);
      upsertMessage(
        conversationId,
        agentMessage({
          kind: "files",
          text: hardBreaks(comment),
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
    makeOutput: () => webOutput(conversationId),
  };
}
