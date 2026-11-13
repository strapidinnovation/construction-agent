/**
 * Starts SuperAgent: the web API (src/web/server.ts) and, when its tokens are
 * set, the Slack bot (src/slack.ts). Both run in this one process because
 * they share the agent's memory files and its job queue, which lives in memory.
 *
 * .env:
 *   HTTP_PORT        port of the web API (default 3001); "off" turns it off.
 *   SLACK_BOT_TOKEN  with SLACK_APP_TOKEN: connect to Slack too.
 *
 * On startup it checks the AI models, picks up jobs and agent missions that
 * were interrupted by the last restart (each in the chat it belongs to, web
 * or Slack), and starts the daily digest when Slack is on.
 */
import { BACKEND, DESIGN_MODEL, ESTIMATE_MODEL, MODEL, PLANNER_MODEL } from "./llm.ts";
import { resumeMissions } from "./superagent/agent/agent.ts";
import { startScheduler } from "./superagent/agent/schedule.ts";
import { checkModels } from "./superagent/health.ts";
import { resumeJobs, type Ctx } from "./superagent/superagent.ts";
import { conversationIdOf, isWebKey, webCtx } from "./web/output.ts";
import { startServer } from "./web/server.ts";

const port = process.env.HTTP_PORT || "3001";
const httpOn = port !== "off";
const slackOn = Boolean(process.env.SLACK_BOT_TOKEN && process.env.SLACK_APP_TOKEN);
if (!httpOn && !slackOn)
  throw new Error("Nothing to start: HTTP_PORT is off and the Slack tokens are missing from .env.");

if (httpOn) {
  const n = Number(port);
  if (!Number.isInteger(n) || n <= 0)
    throw new Error(`HTTP_PORT must be a port number; got "${port}".`);
  await startServer(n);
}
const slack = slackOn ? await import("./slack.ts") : undefined;
if (!slackOn) console.log("Slack is off (no SLACK_BOT_TOKEN / SLACK_APP_TOKEN).");

// Warn in the terminal if the model backend isn't ready, so whoever started
// SuperAgent can fix it before anyone asks.
console.log(
  `AI models (${BACKEND}): agent ${PLANNER_MODEL}, design ${DESIGN_MODEL}, estimate ${ESTIMATE_MODEL}, other ${MODEL}.`,
);
const problem = await checkModels([MODEL, DESIGN_MODEL, ESTIMATE_MODEL, PLANNER_MODEL]);
if (problem) console.warn(`Warning: ${problem}`);

const makeCtx = (key: string, user: string): Ctx =>
  isWebKey(key) ? webCtx(conversationIdOf(key), user) : slack!.ctxFor(key, user);
const keep = (key: string) => (isWebKey(key) ? httpOn : slackOn);

const jobs = await resumeJobs(makeCtx, keep);
if (jobs) console.log(`Resumed ${jobs} interrupted ${jobs === 1 ? "job" : "jobs"}.`);
const missions = await resumeMissions(makeCtx, keep);
if (missions)
  console.log(`Resumed ${missions} interrupted ${missions === 1 ? "mission" : "missions"}.`);

if (slack) {
  const schedule = startScheduler(slack.ctxFor);
  if (schedule) console.log(`Scheduled: ${schedule}.`);
}
console.log("SuperAgent is running. Ctrl+C to stop.");
