/**
 * Starts SuperAgent: the web API (src/web/server.ts) that the web UI talks to.
 *
 * .env:
 *   HTTP_PORT  port of the web API (default 3001).
 *
 * On startup it checks the AI models and picks up jobs and agent missions
 * that were interrupted by the last restart, each in the chat it belongs to.
 */
import { BACKEND, DESIGN_MODEL, ESTIMATE_MODEL, MODEL, PLANNER_MODEL } from "./llm.ts";
import { resumeMissions } from "./superagent/agent/agent.ts";
import { checkModels } from "./superagent/health.ts";
import { resumeJobs, type Ctx } from "./superagent/superagent.ts";
import { conversationIdOf, webCtx } from "./web/output.ts";
import { startServer } from "./web/server.ts";

const port = Number(process.env.HTTP_PORT || "3001");
if (!Number.isInteger(port) || port <= 0)
  throw new Error(`HTTP_PORT must be a port number; got "${process.env.HTTP_PORT}".`);
await startServer(port);

// Warn in the terminal if the model backend isn't ready, so whoever started
// SuperAgent can fix it before anyone asks.
console.log(
  `AI models (${BACKEND}): agent ${PLANNER_MODEL}, design ${DESIGN_MODEL}, estimate ${ESTIMATE_MODEL}, other ${MODEL}.`,
);
const problem = await checkModels([MODEL, DESIGN_MODEL, ESTIMATE_MODEL, PLANNER_MODEL]);
if (problem) console.warn(`Warning: ${problem}`);

const makeCtx = (key: string, user: string): Ctx => webCtx(conversationIdOf(key), user);

const jobs = await resumeJobs(makeCtx);
if (jobs) console.log(`Resumed ${jobs} interrupted ${jobs === 1 ? "job" : "jobs"}.`);
const missions = await resumeMissions(makeCtx);
if (missions)
  console.log(`Resumed ${missions} interrupted ${missions === 1 ? "mission" : "missions"}.`);

console.log("SuperAgent is running. Ctrl+C to stop.");
