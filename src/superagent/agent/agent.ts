/**
 * The agent: works toward a goal on its own by calling tools.
 *
 * The loop itself is run by the Claude Agent SDK (the engine behind Claude
 * Code): it sends Claude the goal and SuperAgent's tools, runs the tool calls
 * Claude makes, feeds the results back, and repeats until Claude answers.
 * SuperAgent's tools (tools.ts) are served to it in-process as an MCP server;
 * Claude Code's own tools (files, shell, web) are all turned off, and no local
 * settings are loaded, so the agent can only do what those tools allow.
 *
 * The model decides WHAT to do (which tools, in what order, with what inputs,
 * when to change course). Code decides what is ALLOWED and keeps the facts
 * straight:
 *   - every tool call is checked against its schema (tools.ts),
 *   - slow jobs only run after the user approved a plan that includes them,
 *     and only as many as were approved,
 *   - at most MAX_MODEL_CALLS turns per mission, then it must wrap up,
 *   - the same call twice in a row is refused,
 *   - numbers come from tool results (comparison tables are built by code).
 *
 * A mission can take an hour (designs and estimates take minutes each), and
 * it can pause to wait for the user (approve a plan, answer a question). Those
 * two tools end the model's turn; the SDK saves the session, and the user's
 * answer resumes it later as the next message, even after a restart.
 */
import { createSdkMcpServer, query, tool, type Options } from "@anthropic-ai/claude-agent-sdk";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLANNER_MODEL } from "../../llm.ts";
import { cancel } from "../queue.ts";
import { errorReply } from "../replies.ts";
import { getSession, recentHistory, threadSummary, updateSession } from "../sessions.ts";
import type { Ctx } from "../superagent.ts";
import {
  MISSION_CANCEL_BUTTON,
  missionBusyReply,
  missionCancelledReply,
  missionDoneReply,
  missionResumeReply,
  missionStatusText,
  notYourMissionReply,
} from "./missionReplies.ts";
import {
  activeMissions,
  allMissions,
  createMission,
  getMission,
  saveMission,
  type Mission,
} from "./missions.ts";
import { settlePendingChange, TOOLS, type AgentTool, type ToolOutcome } from "./tools.ts";

/** How many model turns one mission may use before it must answer. */
const MAX_MODEL_CALLS = 25;

/**
 * Missions one conversation may have going at once. Every message starts one,
 * so a quick question shouldn't have to wait for an hour-long goal.
 */
const MAX_MISSIONS_PER_CONVERSATION = 3;

/**
 * Let the planner think before each decision. On by default: it makes the
 * final answers read numbers correctly. PLANNER_THINK=false turns it off.
 */
const PLANNER_THINK = process.env.PLANNER_THINK !== "false";

/** The MCP server name; the model sees each tool as mcp__superagent__<name>. */
const SERVER = "superagent";

/** An empty folder for the agent's sessions, so no project files, CLAUDE.md or settings are picked up. */
const WORKDIR = join(tmpdir(), "superagent-agent");

const SYSTEM = `You are SuperAgent, an autonomous assistant for a home builder, working in the company's chat app.
Every message people send you comes to you: quick questions, follow-ups, single requests and multi-step goals.
You reach the goal on your own by calling tools, one step at a time, until you can give a complete answer.
Your tools are named mcp__superagent__<name>; below they are called by <name>.
What you can do: find land for sale (any US city), check site risks (flood, soil, aquifer, utilities), research what
can legally be built on a lot (zoning, allowed housing types, setbacks, state laws), design houses
on a lot, furnish them in 3D (a top view of every floor), estimate build costs, plan construction timelines, assess
feasibility (profit if sold, yield if rented), compare plans, and report on the company's ongoing construction projects
(including the documents made for them).

How to work:
1. Work out what the message needs. Gather facts with the QUICK tools: search_land, check_site, list_saved_plans,
   compare_plans, conversation_status, list_projects, project_details, list_project_documents,
   share_project_documents, read_report. They take seconds; use them as needed.
   research_site_rules needs no approval but takes 1-8 minutes per new property (cached after), so call it only
   for the lots the user asks about, not every search result. design_house already researches the rules itself.
   Some messages need no tool at all: a greeting, or a question your earlier answer already covers.
2. SLOW tools take minutes: design_house (~7 min), estimate_cost (~12 min), plan_timeline (~6 min),
   feasibility_report (~6 min, or ~18 if it has to estimate the cost first), design_interior (~4 min),
   revise_design (~22 min, ~28 for a project still in planning).
   - If the user asked for exactly ONE slow action on one property they named ("design a house on 8446 Corral Ln",
     "estimate 3218 Brass Buttons Trl", "timeline for River Bnd starting Jan 4"), run it directly.
   - Anything more (several slow steps, or slow steps the user didn't ask for by name): call propose_plan ONCE
     listing every step you intend to take, then wait for the answer. After approval, run exactly the approved steps.
3. Narrow down before slow work: e.g. search, check_site on the candidates, then design only the best 1 to 3 lots.
4. feasibility_report needs a design (design_house) and makes the cost estimate itself when there is none,
   so don't add estimate_cost before it unless the user asked for an estimate.
5. "Best", "top" or "ideal" without a measure means the most profitable for a builder: that needs feasibility_report
   on each candidate, then compare_plans. If you judge on something else (land price, site risk), say so in the answer.

Recipes (adapt them to the goal):
- "Is it worth building / assess / profit / sell or rent / best lot to build on": design_house, then feasibility_report
  for each candidate lot, then compare_plans when there is more than one. All of these slow steps go in ONE plan.
- "Find land that doesn't flood / has good soil": search_land, then check_site on the listings.
- "Show me the inside / interior / furnish it / 3D view": design_interior on a property that has a plan
  (design_house first if it has none, both in one plan).
- "What can I build on X / zoning / can I put a duplex or ADU there": research_site_rules (a full typed address works
  even if it isn't a known listing). Mention the confidence and any warnings in the answer.
- "Compare plans we already have": compare_plans (list_saved_plans first if you don't know the names).
- "Which projects need attention / why are they late": list_projects, then project_details on each relevant one.
- "Send me / show me / where is the plan (estimate, timeline, report) for <project>": list_project_documents, then
  share_project_documents with the ones asked for (newest of a kind unless they name another). If there is none,
  say so and offer to make it (the project's street address is the property).
- Questions about what is IN a plan, estimate, timeline or feasibility report ("what's the most expensive trade at
  Corral Lane?", "when is the framing inspection?", "which homes did you compare it with?", "what approvals does it
  need?"): read_report, the overview first, then the section that answers it (a trade, tasks, comps). Answer from
  what it returns, never from memory, and say which report and date the numbers come from.
- "Make it a project / start a project for <property>": create_project (it needs a plan; if there is none, design
  first, both in one plan). After a design_house you ran for the user finishes, end your answer by offering to make
  it a project, unless one already exists there. "The client for <project> is …": update_project.
- "What have we done / what are you working on / is it still running": conversation_status.
6. To compare properties that have plans, use compare_plans: it shows a ranked table to the user and gives you the ranking.
7. Name properties by street address exactly as the tools return them (e.g. "3218 Brass Buttons Trl").
8. If a tool returns an error, read it and fix your input or try another way. Never repeat the same call.
9. When you need the user's input to continue the work (e.g. no city or budget for a land search), call ask_user.
10. When you are done, reply WITHOUT a tool call. That reply is your final answer:
   start with the answer or recommendation in one sentence, then up to 5 short bullet points with the reasons
   (a simple question gets a short answer, without bullets if they add nothing).
   Use only facts and numbers from tool results or your earlier answers; never make up numbers. Under 150 words.
   Markdown: **bold** and "- " bullets, no headings or tables (the user already saw the tables tools posted).
11. A follow-up ("why should I worry about them?", "how did you pick that one?", "how long would each take?") is
   about your earlier answers, given before the new request with the steps you took. Answer straight from them only
   when they already contain what is asked, and be honest about what they were based on; otherwise call tools for
   the things they name.`;

const VENDORS = `
Vendors, orders and payments: you can also manage the builder's vendors (subcontractors, suppliers,
consultants), each with the construction stages it can work on; orders: what the builder orders from a vendor for
a project (numbered like PO-1012, with line items, a total and a status: created, sent, confirmed, fulfilled or
cancelled); and payments (numbered like PMT-1012): client collections (the client's deposit, milestone draws and
change orders) and vendor payments, each with an amount, a proposed date and, once paid, an actual date. A payment is
pending, overdue (pending past its proposed date) or completed.
- list_vendors, vendor_details, list_orders, order_details and list_payments are QUICK tools: use them freely ("who
  can do framing?", "which orders are overdue?", "what is the client behind on at Corral Lane?", "what do we owe
  vendors this month?"). list_payments also gives pending, overdue and completed totals and the net cash.
- create_vendor, update_vendor, delete_vendor, create_order, update_order, delete_order, create_payment,
  update_payment, delete_payment, create_project and update_project never save anything themselves: they show the change to the user with Yes / No
  buttons and pause. Code saves it only if the user says yes, and the next message tells you whether it was saved.
  Never say a change is saved before that message says so.
- A new vendor needs a name, type, trade and at least one stage. A new order needs the project, vendor, a title and
  line items with quantity, unit and unit price. A new payment needs the kind, project, title, amount and proposed
  date (and the vendor for a vendor payment). Call ask_user for anything missing; never make up prices or amounts.
- Make one change per call. To stop using a vendor, prefer update_vendor with status "inactive" over deleting it.
  An order's status only moves forward; once sent, cancel it (update_order status "cancelled") instead of deleting it.
  "We got the draw" or "we paid them" is update_payment with status "completed" (the actual date is today unless the
  user names one); find the payment with list_payments first.

Change orders (numbered like CO-1003): a change to a project's scope after the contract, with its cost, the days it
adds and a status (pending until the client signs, approved or rejected). Approving one adds its amount to the
project's approved change orders and moves the forecast finish; the original contract stays.
- list_change_orders is a QUICK tool ("what change orders are pending at Corral Lane?").
- A SMALL change (finishes, fixtures, materials, outlets, anything that keeps the rooms, size and layout): read the
  project's estimate first (read_report estimate, the overview then section trade for the lines it touches), then
  create_change_order with each line's cost now and with the change, for all homes. If the estimate has no such
  line (something new), its cost now is 0; price the new item from the estimate's similar lines and say so, or ask
  the user. Never make up a price you can't base on the estimate or the user.
- A DESIGN change (add a bathroom or bedroom, more square feet, another story, a bigger garage): read_report plan
  for the house types, then revise_design with the changes in words, the house types' new numbers and the
  estimate trades it affects. It redraws and re-estimates the plan (a slow job) and prices only those trades.
  When it isn't clear which kind a change is, say which you chose and why in one line before calling the tool.
- create_change_order and revise_design show the change order with Approve / Save as pending / Reject buttons;
  decide_change_order approves or rejects a pending one with Yes / No. Nothing is saved before the answer, and the
  next message says what was saved.`;

/**
 * The system prompt, fixed for the whole mission: the SDK records it with the
 * session, so anything that changes later (e.g. approved steps) goes into the
 * messages instead.
 */
function systemPrompt(m: Mission): string {
  return [
    SYSTEM,
    VENDORS,
    "",
    `Today is ${new Date().toISOString().slice(0, 10)}.`,
    `What happened in this conversation before the goal:\n${threadSummary(getSession(m.key))}`,
  ].join("\n");
}

/** "2 design, 2 feasibility": the approved slow steps not used yet. */
function stepsLeft(m: Mission): string {
  const left = (["design", "estimate", "timeline", "feasibility", "interior", "revision"] as const)
    .map((k) => [k, (m.approved[k] ?? 0) - (m.used[k] ?? 0)] as const)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${k}`);
  return left.length ? left.join(", ") : "none";
}

const statusOf = (ctx: Ctx, m: Mission) => (now?: string) =>
  ctx.out.status(missionStatusText(m, now), {
    cancelId: m.id,
    cancelAction: MISSION_CANCEL_BUTTON,
  });

// ---------------------------------------------------------------------------
// Tools: SuperAgent's tools, wrapped for the Agent SDK.
// ---------------------------------------------------------------------------

type ToolReply = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
  _meta?: Record<string, unknown>;
};

const toolReply = (outcome: ToolOutcome): ToolReply => ({
  content: [{ type: "text", text: JSON.stringify(outcome.result ?? null) }],
  ...(outcome.failed ? { isError: true } : {}),
  // propose_plan / ask_user: end the model's turn here. The session is saved,
  // and the user's answer continues it as the next message.
  ...(outcome.pause ? { _meta: { "claude/endTurn": true } } : {}),
});

/** One tool call at a time per mission (the model may ask for several at once). */
const toolQueue = new Map<string, Promise<unknown>>();

/**
 * Missions whose current turn was ended by a pausing tool (propose_plan,
 * ask_user, a vendor change). The loop can't tell from the mission's state:
 * the user may answer in the seconds the turn takes to end.
 */
const pausedTurns = new Set<string>();

/** Run one tool call: checklist line, repeat guard, the tool itself, and its result for the model. */
async function callTool(ctx: Ctx, m: Mission, t: AgentTool, args: unknown): Promise<ToolReply> {
  const call = `${t.name} ${JSON.stringify(args)}`;
  if (call === m.lastCall)
    return toolReply({
      result: {
        error:
          "You just made this exact call; its result is above. Use it, or do something different.",
      },
      failed: true,
    });
  m.lastCall = call;

  const status = statusOf(ctx, m);
  const step = { text: t.label(args), state: "running" as "running" | "done" | "failed" };
  m.steps.push(step);
  await saveMission(m);
  await status();
  console.log(`  [${m.id}] ${call}`);

  let outcome: ToolOutcome;
  try {
    outcome = await t.run(args, { ctx, mission: m });
  } catch (err) {
    console.error(err);
    outcome = { result: { error: err instanceof Error ? err.message : String(err) }, failed: true };
  }
  step.text = outcome.done ?? step.text;
  // A paused step stays "running" until the user answers (see resume).
  if (outcome.pause) pausedTurns.add(m.id);
  else step.state = outcome.failed ? "failed" : "done";
  await saveMission(m);
  if (m.state === "running") await status("Deciding what to do next…");
  else await status();
  return toolReply(outcome);
}

function toolServer(ctx: Ctx, m: Mission) {
  return createSdkMcpServer({
    name: SERVER,
    tools: TOOLS.map((t) =>
      tool(t.name, t.description, t.params.shape, (args) => {
        const run = (toolQueue.get(m.id) ?? Promise.resolve()).then(() =>
          callTool(ctx, m, t, args),
        );
        toolQueue.set(
          m.id,
          run.catch(() => undefined),
        );
        return run;
      }),
    ),
  });
}

// ---------------------------------------------------------------------------
// Running a mission: one SDK query per stretch of work.
// ---------------------------------------------------------------------------

/** Missions whose loop is running in this process, so a mission never runs twice at once. */
const driving = new Map<string, Promise<void>>();
/** Lets cancel stop the model mid-turn. */
const aborts = new Map<string, AbortController>();

/** Run (or continue) a mission in the background, starting with `prompt`. */
function drive(ctx: Ctx, id: string, prompt: string): Promise<void> {
  const running = driving.get(id);
  // Still finishing a previous stretch (e.g. "Go" clicked the moment it paused): continue after it.
  if (running) return running.then(() => drive(ctx, id, prompt));
  const run = work(ctx, id, prompt)
    .catch((err) => {
      if (getMission(id)?.state === "cancelled") return;
      return fail(ctx, id, err);
    })
    .finally(() => {
      driving.delete(id);
      aborts.delete(id);
    });
  driving.set(id, run);
  return run;
}

/** Resolves when the mission's loop stops (finished, or paused for the user). For tests. */
export function settled(id: string): Promise<void> {
  return driving.get(id) ?? Promise.resolve();
}

/**
 * Send `prompt` to the mission's session and let the SDK run tools until the
 * model's turn ends. Returns the model's text reply and how the turn ended.
 */
async function turn(
  ctx: Ctx,
  m: Mission,
  prompt: string,
  opts: { noTools?: boolean } = {},
): Promise<{ text: string; outOfTurns: boolean }> {
  mkdirSync(WORKDIR, { recursive: true });
  const abort = new AbortController();
  aborts.set(m.id, abort);
  const tools = opts.noTools ? [] : TOOLS;
  const options: Options = {
    model: PLANNER_MODEL,
    cwd: WORKDIR,
    resume: m.sessionId,
    abortController: abort,
    systemPrompt: systemPrompt(m),
    tools: [],
    settingSources: [],
    strictMcpConfig: true,
    mcpServers: tools.length ? { [SERVER]: toolServer(ctx, m) } : {},
    allowedTools: tools.map((t) => `mcp__${SERVER}__${t.name}`),
    permissionMode: "dontAsk",
    maxTurns: opts.noTools ? 1 : Math.max(1, MAX_MODEL_CALLS - m.modelCalls),
    thinking: PLANNER_THINK ? { type: "adaptive" } : { type: "disabled" },
  };

  for await (const msg of query({ prompt, options })) {
    if (msg.type === "system" && msg.subtype === "init" && msg.session_id !== m.sessionId) {
      m.sessionId = msg.session_id;
      await saveMission(m);
    }
    if (msg.type !== "result") continue;
    m.modelCalls += msg.num_turns;
    await saveMission(m);
    // An API or login error ("Not logged in", usage limit) also comes back as
    // "success", with the error as its text.
    if (msg.subtype === "success" && msg.is_error)
      throw new Error(`Claude couldn't answer: ${msg.result.trim()}`);
    if (msg.subtype === "success") return { text: msg.result.trim(), outOfTurns: false };
    if (msg.subtype === "error_max_turns") return { text: "", outOfTurns: true };
    throw new Error(`The agent stopped: ${msg.errors?.join("; ") || msg.subtype}`);
  }
  throw new Error("The agent stopped without an answer.");
}

async function work(ctx: Ctx, id: string, firstPrompt: string): Promise<void> {
  const m = getMission(id);
  if (!m || m.state !== "running") return;
  const status = statusOf(ctx, m);
  await status("Deciding what to do next…");

  let prompt = firstPrompt;
  for (let nudges = 0; ; nudges++) {
    pausedTurns.delete(m.id);
    const { text, outOfTurns } = await turn(ctx, m, prompt);
    if ((m.state as string) === "cancelled") {
      await ctx.out.status(missionStatusText(m, "🛑 Cancelled."));
      return;
    }
    // A pausing tool ended the turn: wait for the user. Their answer may
    // already have set the mission running again while the turn was ending;
    // drive() then continues with it once this loop returns.
    if (pausedTurns.delete(m.id) || m.state !== "running") return;

    if (outOfTurns) {
      const wrapUp = await turn(
        ctx,
        m,
        "You have used all your steps. Give your final answer now from what you found, and say what is still undone.",
        { noTools: true },
      );
      return finish(
        ctx,
        m,
        wrapUp.text || "I ran out of steps before finishing. The results so far are above.",
      );
    }

    // A plain reply ends the mission, even a question: the user's answer then
    // starts a new one that gets this reply as the earlier answer.
    if (text) return finish(ctx, m, text);
    // An empty reply: nudge once more.
    if (nudges >= 1) return finish(ctx, m, "");
    prompt = "Please give your final answer now.";
  }
}

async function finish(ctx: Ctx, m: Mission, answer: string): Promise<void> {
  m.state = "done";
  m.answer = answer;
  await saveMission(m);
  await updateSession(m.key, {
    lastAnswer: {
      request: m.goal,
      summary: answer,
      steps: m.steps.map((s) => s.text),
      at: new Date().toISOString(),
    },
  });
  await ctx.out.status(missionStatusText(m, "✅ Done."));
  await ctx.out.reply(missionDoneReply(m, answer));
}

async function fail(ctx: Ctx, id: string, err: unknown): Promise<void> {
  console.error(`Mission ${id} failed:`, err);
  const m = getMission(id);
  if (!m) return;
  m.state = "failed";
  await saveMission(m);
  await ctx.out.status(missionStatusText(m, "❌ Stopped."));
  await ctx.out.reply(errorReply(err));
}

// ---------------------------------------------------------------------------
// Entry points used by superagent.ts (messages) and src/web/server.ts (buttons).
// ---------------------------------------------------------------------------

/**
 * Start working on a goal. Returns the mission id once it is under way (the
 * work continues in the background), or undefined if this conversation
 * already has MAX_MISSIONS_PER_CONVERSATION unfinished missions.
 */
export async function startMission(ctx: Ctx, goal: string): Promise<string | undefined> {
  const active = activeMissions(ctx.key);
  if (active.length >= MAX_MISSIONS_PER_CONVERSATION) {
    await ctx.out.reply(missionBusyReply(active));
    return undefined;
  }
  // A message may build on earlier answers ("yes, run those", "why should I
  // worry about them?"), so the model gets the recent requests, steps and answers.
  const previous = recentHistory(getSession(ctx.key));
  const m = await createMission(ctx.key, ctx.user, goal, { previous });
  console.log(`Mission ${m.id} started in ${ctx.key}: "${goal}"`);
  void drive(ctx, m.id, m.prompt);
  return m.id;
}

/** The user answered a pause (plan or question): mark it in the checklist and continue with their answer. */
async function resume(ctx: Ctx, m: Mission, prompt: string, stepText: string): Promise<void> {
  const last = m.steps.at(-1);
  if (last) Object.assign(last, { text: stepText, state: "done" });
  m.state = "running";
  m.pendingPlan = undefined;
  m.pendingQuestion = undefined;
  m.pendingChange = undefined;
  m.lastCall = undefined;
  await saveMission(m);
  void drive(ctx, m.id, prompt);
}

/** "Go" on a proposed plan: approve its slow steps and carry on. Only the person who asked may approve. */
export async function approveMission(ctx: Ctx, id: string): Promise<void> {
  const m = getMission(id);
  if (!m || m.state !== "waiting-approval" || !m.pendingPlan) return;
  if (ctx.user !== m.user) return ctx.out.reply(notYourMissionReply());
  for (const [kind, n] of Object.entries(m.pendingPlan.counts))
    m.approved[kind as keyof typeof m.approved] =
      (m.approved[kind as keyof typeof m.approved] ?? 0) + n;
  const minutes = m.pendingPlan.minutes;
  await resume(
    ctx,
    m,
    `The user approved the plan. Run its steps now. Approved slow steps available: ${stepsLeft(m)}.`,
    `Plan approved (~${minutes} min)`,
  );
}

/**
 * A message (or answer button) while the mission waits for this person:
 * changes to the proposed plan, or the answer to the agent's question.
 */
export async function answerMission(ctx: Ctx, id: string, text: string): Promise<void> {
  const m = getMission(id);
  if (!m) return;
  if (m.state === "waiting-approval")
    return resume(
      ctx,
      m,
      `The user did not approve the plan yet. They said: "${text}"\nAdjust the plan to what they said and call propose_plan again, or answer them if no slow work is needed any more.`,
      `You asked for changes: "${text}"`,
    );
  if (m.state === "waiting-answer" && m.pendingChange) {
    // A vendor change: code makes it (or drops it) before the model hears the answer.
    const { prompt, step } = await settlePendingChange(m, text);
    return resume(ctx, m, prompt, step);
  }
  if (m.state === "waiting-answer")
    return resume(ctx, m, `The user answered: "${text}"`, `You answered: "${text}"`);
}

/** Stop a mission (and the job it is waiting for, if any). Anyone in the conversation may cancel. */
export async function cancelMission(ctx: Ctx, id: string): Promise<void> {
  const m = getMission(id);
  if (!m || !["running", "waiting-approval", "waiting-answer"].includes(m.state)) {
    await ctx.out.reply({ text: "That's already finished, so there's nothing to cancel." });
    return;
  }
  m.state = "cancelled";
  await saveMission(m);
  if (m.inflight) cancel(m.key, m.inflight.jobId);
  aborts.get(m.id)?.abort();
  console.log(`Mission ${m.id} cancelled`);
  await ctx.out.reply(missionCancelledReply(m));
  if (!driving.has(m.id)) await ctx.out.status(missionStatusText(m, "🛑 Cancelled."));
}

/**
 * Called once when the bot starts: missions that were running when it stopped
 * carry on from their saved session. A slow job that was interrupted doesn't
 * count against the approval, so the agent can run it again. Missions waiting
 * for the user stay paused; their buttons and replies still work.
 */
export async function resumeMissions(makeCtx: (key: string, user: string) => Ctx): Promise<number> {
  const running = allMissions().filter((m) => m.state === "running");
  for (const m of running) {
    let interrupted = "";
    if (m.inflight) {
      m.used[m.inflight.kind] = Math.max(0, (m.used[m.inflight.kind] ?? 1) - 1);
      interrupted = ` The ${m.inflight.kind} job that was running did not finish; call its tool again to redo it.`;
      m.inflight = undefined;
    }
    const lastStep = m.steps.at(-1);
    if (lastStep?.state === "running") m.steps.pop();
    m.lastCall = undefined;
    await saveMission(m);
    const ctx = makeCtx(m.key, m.user);
    // Without a session (stopped before the model first answered), start over from the goal.
    const prompt = m.sessionId
      ? `SuperAgent was restarted while you were working.${interrupted} Continue toward the goal.`
      : (m.prompt ?? m.goal);
    try {
      await ctx.out.reply(missionResumeReply(m));
      void drive(ctx, m.id, prompt);
    } catch (err) {
      console.error(`Could not resume mission ${m.id}:`, err);
    }
  }
  return running.length;
}
