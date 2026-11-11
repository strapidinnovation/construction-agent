/**
 * Conversation memory for SuperAgent.
 *
 * Each conversation (a thread, a channel, or one person in a channel,
 * depending on SLACK_REPLY_MODE) remembers the last land search, the listings
 * we showed, which lot was picked, the latest plan and the project last asked
 * about. That is what lets someone write "design a house on Corral Lane" or
 * "same but under 200k" later without repeating everything. Below, "thread"
 * means whichever of these the bot is using.
 *
 * The memory lives in a Map while the bot runs and is also written to
 * data/slack-sessions.json, so a restart of `npm run slack` does not forget
 * ongoing conversations.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Listing } from "../agents/landSearch.ts";
import { PROJECT_ROOT } from "../paths.ts";

const FILE = join(PROJECT_ROOT, "data", "slack-sessions.json");

/** Threads untouched for this long are dropped so the file does not grow forever. */
const MAX_AGE_DAYS = 30;

/** Everything SuperAgent remembers about one Slack thread. */
export type Session = {
  /** The most recent search in this thread, so follow-ups can reuse the city or budget. */
  search?: { city: string; budget: string; lo: number; hi: number };
  /** The listings we showed, in the order shown (so "the third one" / "#3" is index 2). */
  listings: Listing[];
  /** The lot the user picked for a house design (by name, number, or the button). */
  selected?: Listing;
  /** The output/ folder of the latest finished design in this thread; estimates and timelines build on it. */
  planDir?: string;
  /**
   * The slow jobs this conversation is waiting for or running. They are saved
   * so that if the bot restarts mid-job, it can say so and start them again
   * (see resumeJobs in superagent.ts). Each is removed when it ends.
   */
  jobs?: SavedJob[];
  /** The construction project last asked about, so "why is it late?" knows which one. */
  projectName?: string;
  /** ISO timestamp of the last change, used for cleanup. */
  updatedAt: string;
};

/** Everything needed to start a slow job again: what kind it is, who asked, and its inputs. */
export type SavedJob = {
  /** The queue job's id (see queue.ts). */
  id: string;
  kind: "design" | "estimate" | "timeline" | "feasibility";
  /** Slack user id of the person who asked. */
  user: string;
  /**
   * The property the job is for, stored whole (not as "#3", which could point
   * at a different lot after a newer search).
   */
  listing?: Listing;
  /** For designs: the lot size text from the request. */
  lotText?: string;
  /** For timelines: the start date text from the request. */
  startText?: string;
  /**
   * For estimates, timelines and feasibility reports: the plan folder, when it
   * was known at queue time. Unset when the job waits for a design that hasn't
   * finished yet.
   */
  planDir?: string;
};

/**
 * How the bot holds conversations in Slack (SLACK_REPLY_MODE in .env):
 *   "thread"  - replies inside a thread; each thread has its own memory.
 *   "channel" - replies in the channel; the whole channel shares one memory.
 *   "user"    - replies in the channel; each person has their own memory there.
 */
export type ReplyMode = "thread" | "channel" | "user";

/**
 * The memory key for a conversation. It also encodes where to reply, so a
 * job restarted after a restart knows where to post:
 *   thread mode:  "C0123:1700000000.123"   (channel + thread_ts)
 *   channel mode: "C0123"                  (channel only)
 *   user mode:    "C0123:@U0456"           (channel + person)
 * Slack thread timestamps are only unique inside a channel, so the channel is
 * always part of the key.
 */
export function conversationKey(
  mode: ReplyMode,
  channel: string,
  threadTs: string,
  user: string,
): string {
  if (mode === "thread") return `${channel}:${threadTs}`;
  if (mode === "user") return `${channel}:@${user}`;
  return channel;
}

/** The reverse of conversationKey: where to post for a key (threadTs only in thread mode). */
export function parseKey(key: string): { channel: string; threadTs?: string } {
  const [channel = "", rest] = key.split(":", 2);
  return rest && !rest.startsWith("@") ? { channel, threadTs: rest } : { channel };
}

/** Read the saved memory once when the bot starts. A missing or broken file means "start empty". */
function load(): Map<string, Session> {
  if (!existsSync(FILE)) return new Map();
  try {
    const saved = JSON.parse(readFileSync(FILE, "utf8")) as Record<
      string,
      Session & { job?: Omit<SavedJob, "id"> }
    >;
    const cutoff = Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
    return new Map(
      Object.entries(saved)
        .filter(([, s]) => Date.parse(s.updatedAt) > cutoff)
        .map(([key, { job, ...s }]) => [
          key,
          // Older files saved a single "job" without an id; turn it into the list form.
          job ? { ...s, jobs: [...(s.jobs ?? []), { ...job, id: "restored" }] } : s,
        ]),
    );
  } catch {
    console.warn(`Could not read ${FILE}; starting with empty thread memory.`);
    return new Map();
  }
}

const sessions = load();

/**
 * Saves are chained one after another. Two Slack messages can arrive at almost
 * the same moment; without this chain two writes could interleave and corrupt
 * the file.
 */
let saving: Promise<void> = Promise.resolve();

function save(): Promise<void> {
  const snapshot = JSON.stringify(Object.fromEntries(sessions), null, 2);
  saving = saving.then(async () => {
    mkdirSync(dirname(FILE), { recursive: true });
    // Write to a temporary file and then rename it over the real one. A rename
    // is atomic, so the JSON file is never left half-written if the bot stops mid-save.
    const tmp = `${FILE}.tmp`;
    await writeFile(tmp, snapshot);
    await rename(tmp, FILE);
  });
  return saving;
}

/** Memory for a thread, or an empty one if the thread is new. The result is a copy; use update() to change it. */
export function getSession(key: string): Session {
  const s = sessions.get(key);
  return s ? structuredClone(s) : { listings: [], updatedAt: new Date().toISOString() };
}

/** Every remembered thread as [key, memory] pairs (copies). Used at startup to find unfinished jobs. */
export function allSessions(): [string, Session][] {
  return [...sessions].map(([k, s]) => [k, structuredClone(s)]);
}

/**
 * Find a listing by its URL in any conversation's memory. Used when someone
 * clicks "Design on this lot" under listings that were searched by someone
 * else (in "user" mode each person has their own memory).
 */
export function findListingByUrl(url: string): Listing | undefined {
  for (const s of sessions.values()) {
    const hit =
      s.listings.find((l) => l.url === url) ?? (s.selected?.url === url ? s.selected : undefined);
    if (hit) return structuredClone(hit);
  }
  return undefined;
}

/** Add a job to a conversation's saved jobs. */
export async function saveJob(key: string, job: SavedJob): Promise<void> {
  await updateSession(key, { jobs: [...(getSession(key).jobs ?? []), job] });
}

/** Remove a job from a conversation's saved jobs (it finished, failed or was cancelled). */
export async function forgetJob(key: string, id: string): Promise<void> {
  await updateSession(key, { jobs: (getSession(key).jobs ?? []).filter((j) => j.id !== id) });
}

/** Change a thread's memory and save it to disk. */
export async function updateSession(key: string, change: Partial<Session>): Promise<Session> {
  const next: Session = { ...getSession(key), ...change, updatedAt: new Date().toISOString() };
  sessions.set(key, next);
  await save();
  return next;
}
