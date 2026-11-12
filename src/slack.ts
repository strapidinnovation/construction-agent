/**
 * Slack gateway for SuperAgent. Start it with `npm run dev`.
 *
 * This file is the only place that talks to Slack. It:
 *   - connects to Slack using Socket Mode,
 *   - listens for messages that @mention the bot and for button clicks,
 *   - hands the work to src/superagent/superagent.ts,
 *   - gives superagent.ts an "Output" that posts messages, live status
 *     updates and files into the right place.
 *
 * SLACK_REPLY_MODE (in .env) decides where replies go and whose memory is
 * used: "channel" (default, shared memory per channel), "user" (in the
 * channel, separate memory per person) or "thread" (a memory per thread).
 *
 * Socket Mode means the bot opens a connection TO Slack (like a browser
 * would), instead of Slack sending web requests to us. So no public URL,
 * server or ngrok is needed, and the bot can run on a laptop next to Ollama.
 *
 * Tokens (from .env):
 *   SLACK_BOT_TOKEN  xoxb-...  lets the bot read mentions and post messages.
 *   SLACK_APP_TOKEN  xapp-...  lets the bot open the Socket Mode connection.
 *
 * Slack app settings this code relies on:
 *   - Bot scopes: app_mentions:read, chat:write, reactions:write, files:write.
 *   - Event subscription: app_mention.
 *   - Interactivity: ON (needed for the "Design on this lot", "Estimate cost",
 *     "Plan the timeline", "Feasibility report", "Cancel", "Details" and "Why is it late?" buttons).
 *
 * On startup it also checks that Ollama and the models are available, and
 * restarts any jobs that were interrupted when the bot last stopped.
 */
import { basename } from "node:path";
import { App, LogLevel, type BlockButtonAction } from "@slack/bolt";
import {
  BACKEND,
  DESIGN_MODEL,
  ESTIMATE_MODEL,
  MODEL,
  PLANNER_MODEL,
  ROUTER_MODEL,
} from "./llm.ts";
import {
  answerMission,
  approveMission,
  cancelMission,
  resumeMissions,
} from "./superagent/agent/agent.ts";
import { getMission } from "./superagent/agent/missions.ts";
import {
  MISSION_ANSWER_BUTTON,
  MISSION_CANCEL_BUTTON,
  MISSION_GO_BUTTON,
} from "./superagent/agent/missionUi.ts";
import { startScheduler } from "./superagent/agent/schedule.ts";
import { checkModels } from "./superagent/health.ts";
import { conversationKey, parseKey, type ReplyMode } from "./superagent/sessions.ts";
import {
  CANCEL_BUTTON,
  DESIGN_BUTTON,
  ESTIMATE_BUTTON,
  errorReply,
  FEASIBILITY_BUTTON,
  PROJECT_BUTTON,
  PROJECT_DELAY_BUTTON,
  statusBlocks,
  TIMELINE_BUTTON,
  type Reply,
} from "./superagent/slackUi.ts";
import {
  cancelJob,
  handleMessage,
  resumeJobs,
  showProjectById,
  startDesign,
  startEstimate,
  startFeasibility,
  startTimeline,
  type Ctx,
  type Output,
} from "./superagent/superagent.ts";

/**
 * Slack limits how often a message can be edited (roughly once per second per
 * channel). Progress updates arrive much faster than that while the model is
 * writing, so the status message is edited at most once every few seconds.
 */
const STATUS_EVERY_MS = 4000;

for (const key of ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"])
  if (!process.env[key]) throw new Error(`${key} is missing from .env.`);

/**
 * Where the bot replies and whose memory it uses (SLACK_REPLY_MODE in .env):
 *   "channel" (default) - replies in the channel; one shared memory per channel.
 *   "user"              - replies in the channel; each person has their own memory.
 *   "thread"            - replies in a thread; each thread has its own memory.
 */
const MODES: ReplyMode[] = ["channel", "user", "thread"];
const MODE = (process.env.SLACK_REPLY_MODE || "channel") as ReplyMode;
if (!MODES.includes(MODE))
  throw new Error(`SLACK_REPLY_MODE must be one of ${MODES.join(", ")}; got "${MODE}".`);

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
  logLevel: LogLevel.WARN,
});

/**
 * Build the Output for one conversation (see the Output type in superagent.ts).
 * `threadTs` is only given in thread mode; without it, Slack posts straight
 * into the channel.
 *
 * - reply():  posts a new message.
 * - status(): posts ONE status message the first time, then edits it. Edits are
 *             throttled; the newest text always wins, and any pending edit is
 *             sent before the next reply so the status never lags behind.
 * - upload(): uploads files (needs the files:write scope).
 */
function conversationOutput(channel: string, threadTs?: string): Output {
  let statusTs: string | undefined; // timestamp (= id) of the status message once posted
  let lastEdit = 0; // when we last edited it
  let pending: { text: string; cancelId?: string; cancelAction?: string } | undefined; // newest status not yet shown
  let timer: NodeJS.Timeout | undefined;

  const post = async (reply: Reply) => {
    await app.client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: reply.text,
      blocks: reply.blocks,
      // Turn off link previews so each listing link doesn't expand into a big card.
      unfurl_links: false,
      unfurl_media: false,
    });
  };

  const flush = async () => {
    clearTimeout(timer);
    timer = undefined;
    if (pending === undefined) return;
    const { text, cancelId, cancelAction } = pending;
    pending = undefined;
    lastEdit = Date.now();
    // Always send the blocks: when a job ends, the new blocks have no Cancel
    // button, which removes the old one from the message.
    const blocks = statusBlocks(text, cancelId, cancelAction);
    try {
      if (statusTs) await app.client.chat.update({ channel, ts: statusTs, text, blocks });
      else
        statusTs = (
          await app.client.chat.postMessage({ channel, thread_ts: threadTs, text, blocks })
        ).ts;
    } catch (err) {
      // A failed progress update shouldn't stop the actual work.
      console.warn("Status update failed:", err instanceof Error ? err.message : err);
    }
  };

  return {
    async reply(reply) {
      await flush();
      await post(reply);
    },
    async status(text, opts) {
      pending = { text, cancelId: opts?.cancelId, cancelAction: opts?.cancelAction };
      const wait = STATUS_EVERY_MS - (Date.now() - lastEdit);
      if (!statusTs || wait <= 0) await flush();
      else timer ??= setTimeout(() => void flush(), wait);
    },
    async upload(files, comment) {
      await flush();
      await app.client.files.uploadV2({
        channel_id: channel,
        thread_ts: threadTs,
        initial_comment: comment,
        file_uploads: files.map((f) => ({
          file: f.path,
          filename: basename(f.path),
          title: f.title,
        })),
      });
    },
  };
}

/** Build the request context (memory key, who asked, and an Output that posts to the right place). */
function ctxFor(key: string, user: string): Ctx {
  const { channel, threadTs } = parseKey(key);
  return {
    key,
    user,
    out: conversationOutput(channel, threadTs),
    mode: MODE,
    makeOutput: () => conversationOutput(channel, threadTs),
  };
}

/**
 * Someone wrote "@superagent ..." in a channel the bot is in.
 *
 * Bolt automatically tells Slack "got it" as soon as the event arrives (Slack
 * expects that within 3 seconds), so it is fine that the work below can take
 * much longer — replies simply arrive when they are ready.
 */
app.event("app_mention", async ({ event, client, logger }) => {
  // Thread mode: answer in the thread the mention is in, or start one on it.
  // Channel and user modes: answer in the channel (threadTs is ignored there).
  const user = event.user ?? "unknown";
  const ctx = ctxFor(conversationKey(MODE, event.channel, event.thread_ts ?? event.ts, user), user);
  const { key, out } = ctx;

  // The message text contains the mention as "<@U123ABC>"; remove it so the
  // router only sees what the person actually asked.
  const text = event.text.replace(/<@[^>]+>/g, "").trim();
  console.log(`Mention in ${key} from ${ctx.user}: "${text}"`);

  // A magnifying-glass reaction on the user's message shows the bot is working
  // on it. Reactions are a nicety, so failures (e.g. a missing scope) are ignored.
  const react = (add: boolean) =>
    client.reactions[add ? "add" : "remove"]({
      channel: event.channel,
      timestamp: event.ts,
      name: "mag",
    }).catch(() => undefined);

  await react(true);
  try {
    // For a design this returns once the job is queued; the queued job keeps
    // using `out` to post progress and results later.
    await handleMessage(ctx, text);
  } catch (err) {
    logger.error(err);
    await out.reply(errorReply(err));
  } finally {
    await react(false);
  }
});

/**
 * Register a handler for one of our buttons.
 *
 * Button clicks must be acknowledged with ack() within 3 seconds or Slack
 * shows the user an error, so ack() comes first and the work happens after.
 *
 * The click is mapped to a conversation the same way a mention is: in thread
 * mode the clicked message's thread_ts points to the thread's first message;
 * in channel mode it's the channel; in user mode it's the person who clicked.
 * Buttons that need an exact listing or plan carry it in their value, so they
 * work even when the click comes from someone else's results.
 */
function onButton(actionId: string, handle: (ctx: Ctx, value: string) => Promise<void>) {
  app.action<BlockButtonAction>(actionId, async ({ ack, body, action, logger }) => {
    await ack();
    const channel = body.channel?.id;
    const message = body.message;
    if (!channel || !message) return;

    const threadTs: string = message.thread_ts ?? message.ts;
    const ctx = ctxFor(conversationKey(MODE, channel, threadTs, body.user.id), body.user.id);
    console.log(
      `Button "${actionId}" in ${ctx.key} from ${ctx.user}${action.value ? ` (value ${action.value})` : ""}`,
    );

    try {
      await handle(ctx, action.value ?? "");
    } catch (err) {
      logger.error(err);
      await ctx.out.reply(errorReply(err));
    }
  });
}

/**
 * "Design on this lot" under a listing. The value is the listing's URL
 * (buttons posted before names were supported carry a number instead).
 */
onButton(DESIGN_BUTTON, (ctx, value) =>
  startDesign(ctx, /^\d+$/.test(value) ? { number: Number(value) } : { url: value }, ""),
);

/** "Estimate cost" under a finished plan; the value is that plan's folder. */
onButton(ESTIMATE_BUTTON, (ctx, planDir) => startEstimate(ctx, { planDir: planDir || undefined }));

/** "Plan the timeline" under a finished plan or estimate; starts next Monday. */
onButton(TIMELINE_BUTTON, (ctx, planDir) =>
  startTimeline(ctx, "", { planDir: planDir || undefined }),
);

/** "Feasibility report" under a finished plan, estimate or timeline; the value is the plan folder. */
onButton(FEASIBILITY_BUTTON, (ctx, planDir) =>
  startFeasibility(ctx, { planDir: planDir || undefined }),
);

/** "Cancel" on a job's status message; the value is that job's id. */
onButton(CANCEL_BUTTON, (ctx, id) => cancelJob(ctx, id || undefined));

/** "Details" next to a project in the projects list; the value is the project id. */
onButton(PROJECT_BUTTON, (ctx, id) => showProjectById(ctx, id, "overview"));

/** "Why is it late?" under a project's overview. */
onButton(PROJECT_DELAY_BUTTON, (ctx, id) => showProjectById(ctx, id, "delay"));

/**
 * The agent's mission buttons. A mission belongs to the conversation it was
 * started in, so these answer in that conversation (in "user" mode the
 * clicker's own conversation can be a different one).
 */
const missionCtx = (ctx: Ctx, id: string): Ctx => {
  const m = getMission(id);
  return m ? ctxFor(m.key, ctx.user) : ctx;
};

/** "Go" under a proposed plan; the value is the mission id. */
onButton(MISSION_GO_BUTTON, (ctx, id) => approveMission(missionCtx(ctx, id), id));

/** "Cancel" under a plan or on a mission's checklist. */
onButton(MISSION_CANCEL_BUTTON, (ctx, id) => cancelMission(missionCtx(ctx, id), id));

/** An answer button under the agent's question; the value is "<mission id>|<option index>". */
onButton(MISSION_ANSWER_BUTTON, async (ctx, value) => {
  const [id = "", index = ""] = value.split("|");
  const m = getMission(id);
  const answer = m?.pendingQuestion?.options[Number(index)];
  if (!m || answer === undefined || m.user !== ctx.user) return;
  await answerMission(missionCtx(ctx, id), id, answer);
});

await app.start();
console.log(
  `SuperAgent is running (reply mode: ${MODE}). Tag it in a channel it has been invited to. Ctrl+C to stop.`,
);

// Startup check: warn in the terminal (not in Slack) if the model backend isn't
// ready, so whoever started the bot can fix it before anyone asks.
console.log(
  `AI models (${BACKEND}): agent ${PLANNER_MODEL}, router ${ROUTER_MODEL}, design ${DESIGN_MODEL}, estimate ${ESTIMATE_MODEL}, other ${MODEL}.`,
);
const problem = await checkModels([
  MODEL,
  ROUTER_MODEL,
  DESIGN_MODEL,
  ESTIMATE_MODEL,
  PLANNER_MODEL,
]);
if (problem) console.warn(`Warning: ${problem}`);

// Pick up jobs and agent missions that were interrupted by the last restart.
const resumed = await resumeJobs((key, user) => ctxFor(key, user));
if (resumed) console.log(`Resumed ${resumed} interrupted ${resumed === 1 ? "job" : "jobs"}.`);
const missions = await resumeMissions((key, user) => ctxFor(key, user));
if (missions)
  console.log(`Resumed ${missions} interrupted ${missions === 1 ? "mission" : "missions"}.`);

// Proactive work (the daily project digest), if DIGEST_CHANNEL is set.
const schedule = startScheduler((key, user) => ctxFor(key, user));
if (schedule) console.log(`Scheduled: ${schedule}.`);
