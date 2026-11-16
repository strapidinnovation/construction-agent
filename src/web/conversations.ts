/**
 * Web chat history: every conversation started from the web UI, with all of
 * its messages, as the chat screen shows them.
 *
 * Each conversation is one JSON file in data/conversations/ (CONVERSATIONS_DIR
 * in tests), loaded once at startup and kept in a Map. Messages change often
 * while the agent works (a status line is edited many times), so a file is
 * written at most once per SAVE_EVERY_MS; the newest state always wins.
 *
 * Listeners (the chat screen's live stream, see server.ts) get every new or
 * changed message as it happens.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PROJECT_ROOT } from "../paths.ts";
import type { MissionState, Step } from "../superagent/agent/missions.ts";

const DIR = process.env.CONVERSATIONS_DIR || join(PROJECT_ROOT, "data", "conversations");

const SAVE_EVERY_MS = 1000;

/** A button under a message. Clicking it posts { actionId, value } to the conversation's actions. */
export type ChatAction = {
  label: string;
  actionId: string;
  value: string;
  style?: "primary" | "danger";
};

export type ChatFile = { title: string; name: string; url: string | null };

/** The live state of an agent mission, attached to its status message. */
export type MissionView = {
  id: string;
  goal: string;
  state: MissionState;
  steps: Step[];
  pendingPlan?: { counts: Record<string, number>; minutes: number };
  pendingQuestion?: { question: string; options: string[] };
};

/**
 * One message in the chat.
 * - text:   what the user wrote, or the agent's reply (Markdown).
 * - status: a progress line that is edited in place while work runs (same id, new text).
 * - files:  plan images and PDFs.
 */
export type ChatMessage = {
  id: string;
  role: "user" | "agent";
  kind: "text" | "status" | "files";
  text: string;
  actions?: ChatAction[];
  files?: ChatFile[];
  mission?: MissionView;
  createdAt: string;
  updatedAt: string;
};

export type Conversation = {
  id: string;
  title: string;
  /** The project this chat was opened from, if any; its first message is about that project. */
  projectId?: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
};

const conversations = new Map<string, Conversation>();

function load(): void {
  if (!existsSync(DIR)) return;
  for (const file of readdirSync(DIR).filter((f) => f.endsWith(".json"))) {
    try {
      const c = JSON.parse(readFileSync(join(DIR, file), "utf8")) as Conversation;
      conversations.set(c.id, c);
    } catch {
      console.warn(`Could not read conversation file ${file}; skipping it.`);
    }
  }
}
load();

const timers = new Map<string, NodeJS.Timeout>();
/** Writes are chained so two saves can't interleave and corrupt a file. */
let saving: Promise<void> = Promise.resolve();

function write(id: string): Promise<void> {
  const c = conversations.get(id);
  if (!c) return saving;
  const snapshot = JSON.stringify(c, null, 2);
  saving = saving.then(async () => {
    mkdirSync(DIR, { recursive: true });
    const file = join(DIR, `${id}.json`);
    await writeFile(`${file}.tmp`, snapshot);
    await rename(`${file}.tmp`, file);
  });
  return saving;
}

function scheduleSave(id: string): void {
  if (timers.has(id)) return;
  timers.set(
    id,
    setTimeout(() => {
      timers.delete(id);
      write(id).catch((err) => console.error(`Could not save conversation ${id}:`, err));
    }, SAVE_EVERY_MS),
  );
}

type Listener = (message: ChatMessage) => void;
const listeners = new Map<string, Set<Listener>>();

/** Get every new or changed message in a conversation. Returns the unsubscribe function. */
export function subscribe(id: string, listener: Listener): () => void {
  const set = listeners.get(id) ?? new Set();
  set.add(listener);
  listeners.set(id, set);
  return () => set.delete(listener);
}

const newId = (prefix: string) =>
  `${prefix}${Date.now().toString(36).slice(-5)}${Math.random().toString(36).slice(2, 6)}`;

export const newMessageId = () => newId("msg");

export function createConversation(projectId?: string): Conversation {
  const now = new Date().toISOString();
  const c: Conversation = {
    id: newId("c"),
    title: "New chat",
    projectId,
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
  conversations.set(c.id, c);
  void write(c.id);
  return c;
}

export function getConversation(id: string): Conversation | undefined {
  return conversations.get(id);
}

/** Newest first. */
export function allConversations(): Conversation[] {
  return [...conversations.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function setTitle(id: string, title: string): void {
  const c = conversations.get(id);
  if (!c) return;
  c.title = title;
  scheduleSave(id);
}

/** Add a message, or replace the one with the same id (status lines are edited this way). */
export function upsertMessage(conversationId: string, message: ChatMessage): void {
  const c = conversations.get(conversationId);
  if (!c) return;
  const i = c.messages.findIndex((m) => m.id === message.id);
  if (i >= 0) c.messages[i] = message;
  else c.messages.push(message);
  c.updatedAt = message.updatedAt;
  scheduleSave(conversationId);
  for (const listener of listeners.get(conversationId) ?? []) listener(message);
}

export async function deleteConversation(id: string): Promise<boolean> {
  if (!conversations.delete(id)) return false;
  clearTimeout(timers.get(id));
  timers.delete(id);
  saving = saving.then(() => rm(join(DIR, `${id}.json`), { force: true }));
  await saving;
  return true;
}
