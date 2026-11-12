/**
 * Proactive work: SuperAgent starts missions on its own, without being asked.
 *
 * Today that is one job, the morning project digest: at DIGEST_TIME every day
 * it starts a mission in DIGEST_CHANNEL with the goal below. The agent then
 * decides for itself which projects to look into (list_projects, then
 * project_details on the ones that need attention) and posts a briefing.
 * Scheduled missions are "unattended": nobody is there to approve a plan, so
 * they only get the quick tools.
 *
 * .env:
 *   DIGEST_CHANNEL  Slack channel id (e.g. C0123ABCD); no digest without it.
 *   DIGEST_TIME     "HH:MM" in this computer's time zone, default "08:30".
 *
 * The date of the last digest is saved in data/digest.json, so a restart
 * after DIGEST_TIME doesn't post a second digest the same day.
 */
import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PROJECT_ROOT } from "../../paths.ts";
import type { Ctx } from "../superagent.ts";
import { startMission } from "./agent.ts";

const FILE = join(PROJECT_ROOT, "data", "digest.json");

/** Who scheduled missions belong to (not a real Slack user). */
const SCHEDULER_USER = "scheduler";

export const DIGEST_GOAL =
  "Morning digest for the team: which ongoing construction projects need attention today (delayed, at risk or on hold), " +
  "what is holding each of them up and the next step on each open issue, and inspections in the next 7 days. " +
  "End with the 3 most important actions for today.";

/** "2026-11-11" in this computer's time zone. */
const localDate = (d: Date) => d.toLocaleDateString("en-CA");
/** "08:05" in this computer's time zone. */
const localTime = (d: Date) =>
  `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

function lastRun(): string | undefined {
  if (!existsSync(FILE)) return undefined;
  try {
    return (JSON.parse(readFileSync(FILE, "utf8")) as { lastRun?: string }).lastRun;
  } catch {
    return undefined;
  }
}

/**
 * Start the daily digest timer. `makeCtx` builds the conversation to post in
 * (src/slack.ts passes one that posts to Slack). Returns a description of the
 * schedule for the startup log, or null when no digest is configured.
 */
export function startScheduler(makeCtx: (key: string, user: string) => Ctx): string | null {
  const channel = process.env.DIGEST_CHANNEL;
  if (!channel) return null;
  const match = (process.env.DIGEST_TIME || "08:30").match(/^(\d{1,2}):(\d{2})$/);
  if (!match)
    throw new Error(`DIGEST_TIME must look like "08:30"; got "${process.env.DIGEST_TIME}".`);
  const time = `${match[1]!.padStart(2, "0")}:${match[2]}`;

  const tick = async () => {
    const now = new Date();
    const today = localDate(now);
    if (localTime(now) < time || lastRun() === today) return;
    await writeFile(FILE, JSON.stringify({ lastRun: today }));
    console.log(`Starting the daily digest in ${channel}`);
    // The channel id alone is the conversation key, so the digest posts in the channel itself.
    await startMission(makeCtx(channel, SCHEDULER_USER), DIGEST_GOAL, { unattended: true });
  };
  const safeTick = () => void tick().catch((err) => console.error("Digest failed to start:", err));
  setInterval(safeTick, 60_000);
  safeTick();
  return `daily digest at ${time} in ${channel}`;
}
