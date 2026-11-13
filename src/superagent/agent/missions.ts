/**
 * Missions: the agent's memory of one goal it is working on.
 *
 * When someone gives SuperAgent a goal ("find the best lot under 300k and tell
 * me if it's worth building"), the agent may need an hour and many steps to
 * reach it. A mission records everything about that work:
 *   - the goal and who asked,
 *   - the Agent SDK session id: the SDK keeps the conversation with the model
 *     (every tool call and result), and resuming that session is what lets
 *     the agent pick up exactly where it stopped, after a pause or a restart,
 *   - the checklist shown in Slack,
 *   - which slow jobs the user approved and how many have been used,
 *   - what it is waiting for (plan approval, an answer, a job).
 *
 * Each mission is one JSON file in data/missions/ (MISSIONS_DIR in tests).
 * The checklist in it shows what the agent did; the session transcript (see
 * `sessionId`) has every decision in full, the first place to look when it
 * does something odd.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Listing } from "../../agents/landSearch.ts";
import { PROJECT_ROOT } from "../../paths.ts";
import type { JobKind } from "../queue.ts";
import type { LastAnswer } from "../sessions.ts";

const DIR = process.env.MISSIONS_DIR || join(PROJECT_ROOT, "data", "missions");

/** Finished missions older than this aren't loaded at startup (their files stay on disk). */
const MAX_AGE_DAYS = 30;

/**
 * - running:          the agent is working (thinking, or waiting for a job).
 * - waiting-approval: it proposed a plan and waits for "Go" (or changes).
 * - waiting-answer:   it asked the user a question.
 * - done / failed / cancelled: finished.
 */
export type MissionState =
  "running" | "waiting-approval" | "waiting-answer" | "done" | "failed" | "cancelled";

/** One line of the checklist shown in Slack. */
export type Step = { text: string; state: "running" | "done" | "failed" };

/** How many slow jobs of each kind. */
export type JobCounts = Partial<Record<JobKind, number>>;

export type Mission = {
  id: string;
  /** The conversation it belongs to (see conversationKey in sessions.ts). */
  key: string;
  /** Slack user id of the person who gave the goal; only they can approve its plans. */
  user: string;
  goal: string;
  state: MissionState;
  /** Started by the scheduler (no one to approve plans or answer questions), so only quick tools. */
  unattended?: boolean;
  /** Started as a follow-up to this earlier request, whose answer the model was given. */
  followsUp?: string;
  /** The first message the model gets: the goal, after any earlier answer it follows up on. */
  prompt: string;
  /**
   * The Agent SDK session holding the conversation with the model (every tool
   * call and result). Resuming it continues exactly where the mission stopped.
   * Its transcript is in ~/.claude/projects/, under the agent's work folder.
   */
  sessionId?: string;
  /** The last tool call as "name {args}", to refuse an exact repeat. */
  lastCall?: string;
  steps: Step[];
  /** Every listing the agent's searches found, so it can refer to them by street later. */
  listings: Listing[];
  /** Slow jobs the user has approved (added up over every approved plan) and how many were used. */
  approved: JobCounts;
  used: JobCounts;
  /** A slow job ran without a plan because the user asked for exactly that one job (allowed once). */
  directStep?: boolean;
  /** The plan waiting for approval. */
  pendingPlan?: { counts: JobCounts; minutes: number };
  /** The question waiting for an answer, with the options offered as buttons. */
  pendingQuestion?: { question: string; options: string[] };
  /** The slow job running for this mission right now (to cancel it with the mission). */
  inflight?: { jobId: string; kind: JobKind };
  /** How many model turns the mission has used (each turn decides the next tool calls). */
  modelCalls: number;
  /** The final answer, once done. */
  answer?: string;
  createdAt: string;
  updatedAt: string;
};

const missions = new Map<string, Mission>();

/** Load saved missions once at startup. */
function load(): void {
  if (!existsSync(DIR)) return;
  const cutoff = Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  for (const file of readdirSync(DIR).filter((f) => f.endsWith(".json"))) {
    try {
      const m = JSON.parse(readFileSync(join(DIR, file), "utf8")) as Mission;
      if (Date.parse(m.updatedAt) > cutoff) missions.set(m.id, m);
    } catch {
      console.warn(`Could not read mission file ${file}; skipping it.`);
    }
  }
}
load();

/** Writes are chained so two quick saves can't interleave and corrupt a file. */
let saving: Promise<void> = Promise.resolve();

/** Save a mission (in memory and on disk). Always save after changing one. */
export function saveMission(m: Mission): Promise<void> {
  m.updatedAt = new Date().toISOString();
  missions.set(m.id, m);
  const snapshot = JSON.stringify(m, null, 2);
  saving = saving.then(async () => {
    mkdirSync(DIR, { recursive: true });
    const file = join(DIR, `${m.id}.json`);
    await writeFile(`${file}.tmp`, snapshot);
    await rename(`${file}.tmp`, file);
  });
  return saving;
}

/** A short random id like "mx7k2p9q". */
const newId = () =>
  `m${Date.now().toString(36).slice(-4)}${Math.random().toString(36).slice(2, 6)}`;

/** The earlier exchanges, as the model reads them before the new request. */
function earlier(previous: LastAnswer[]): string {
  return previous
    .map((p, i) =>
      [
        `${i + 1}. The user asked: "${p.request}"`,
        ...(p.steps?.length ? [`Steps you took: ${p.steps.join("; ")}`] : []),
        `You answered:\n${p.summary}`,
      ].join("\n"),
    )
    .join("\n\n");
}

/** `previous`: the recent exchanges in this conversation (oldest first); they go before the new goal. */
export async function createMission(
  key: string,
  user: string,
  goal: string,
  opts: { unattended?: boolean; previous?: LastAnswer[] } = {},
): Promise<Mission> {
  const now = new Date().toISOString();
  const previous = opts.previous ?? [];
  const content = previous.length
    ? `Earlier in this conversation (oldest first):\n\n${earlier(previous)}\n\nNew request: ${goal}`
    : goal;
  const m: Mission = {
    id: newId(),
    key,
    user,
    goal,
    state: "running",
    unattended: opts.unattended || undefined,
    followsUp: previous.at(-1)?.request,
    prompt: content,
    steps: [],
    listings: [],
    approved: {},
    used: {},
    modelCalls: 0,
    createdAt: now,
    updatedAt: now,
  };
  await saveMission(m);
  return m;
}

/** The live mission object (not a copy): change it, then saveMission() it. */
export function getMission(id: string): Mission | undefined {
  return missions.get(id);
}

export function allMissions(): Mission[] {
  return [...missions.values()];
}

/**
 * A plan or question nobody answered for this long is treated as abandoned:
 * it no longer blocks new goals or captures the person's messages. (Its Go
 * button still works if someone clicks it later.)
 */
const WAIT_EXPIRES_MS = 24 * 60 * 60 * 1000;

const isWaiting = (m: Mission) =>
  (m.state === "waiting-approval" || m.state === "waiting-answer") &&
  Date.now() - Date.parse(m.updatedAt) < WAIT_EXPIRES_MS;

const isActive = (m: Mission) => m.state === "running" || isWaiting(m);

/** The unfinished missions in this conversation, oldest first. */
export function activeMissions(key: string): Mission[] {
  return allMissions()
    .filter((m) => m.key === key && isActive(m))
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

/** The newest unfinished mission in this conversation, if any. */
export function activeMission(key: string): Mission | undefined {
  return activeMissions(key).at(-1);
}

/** This person's mission here that is waiting for them to approve a plan or answer a question. */
export function waitingMission(key: string, user: string): Mission | undefined {
  return allMissions().find((m) => m.key === key && m.user === user && isWaiting(m));
}
