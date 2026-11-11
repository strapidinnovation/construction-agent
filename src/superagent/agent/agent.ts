/**
 * The agent: works toward a goal on its own by calling tools.
 *
 * This is the classic agent loop:
 *   1. Send the planner model the goal, everything that happened so far in
 *      this mission, and the list of tools.
 *   2. The model answers with tool calls ("search_land Austin 300k") or with
 *      a final answer (no tool calls).
 *   3. Code checks and runs each tool call and adds the result to the
 *      conversation.
 *   4. Repeat until the model gives its final answer.
 *
 * The model decides WHAT to do (which tools, in what order, with what inputs,
 * when to change course). Code decides what is ALLOWED and keeps the facts
 * straight:
 *   - every tool call is checked against its schema (tools.ts),
 *   - slow jobs only run after the user approved a plan that includes them,
 *     and only as many as were approved,
 *   - at most MAX_MODEL_CALLS decisions per mission, then it must wrap up,
 *   - the same call twice in a row is refused (a common small-model loop),
 *   - numbers come from tool results (comparison tables are built by code).
 *
 * A mission can take an hour (designs and estimates take minutes each), and
 * it can pause to wait for the user (approve a plan, answer a question). So
 * the loop doesn't hold on to anything in memory: after every step the
 * mission is saved (missions.ts), and the loop can stop and later continue
 * from the saved state: when the user answers, or after a restart.
 */
import type { Message } from "ollama";
import { chatTools } from "../../llm.ts";
import { cancel } from "../queue.ts";
import { threadSummary } from "../router.ts";
import { getSession } from "../sessions.ts";
import { errorReply } from "../slackUi.ts";
import type { Ctx } from "../superagent.ts";
import {
  MISSION_CANCEL_BUTTON,
  missionBusyReply,
  missionCancelledReply,
  missionDoneReply,
  missionResumeReply,
  missionStatusText,
  notYourMissionReply,
} from "./missionUi.ts";
import {
  activeMission,
  allMissions,
  createMission,
  getMission,
  recentMission,
  saveMission,
  type Mission,
} from "./missions.ts";
import { TOOLS_BY_NAME, toolsFor, type ToolOutcome } from "./tools.ts";

/** How many times the model may decide a next step in one mission before it must answer. */
const MAX_MODEL_CALLS = 25;

const SYSTEM = `You are SuperAgent, an autonomous assistant for a home builder, working in Slack.
You reach the user's goal on your own by calling tools, one step at a time, until you can give a complete answer.

How to work:
1. Work out what the goal needs, then gather facts with the QUICK tools: search_land, check_site, list_saved_plans,
   compare_plans, list_projects, project_details. They take seconds; use them as needed.
2. SLOW tools take minutes and need the user's approval: design_house (~7 min), estimate_cost (~12 min),
   plan_timeline (~6 min), feasibility_report (~6 min, or ~18 if it has to estimate the cost first).
   Before running any of them, call propose_plan ONCE listing every step you intend to take, then wait for the answer.
   After approval, run exactly the approved slow steps.
3. Narrow down before slow work: e.g. search, check_site on the candidates, then design only the best 1 to 3 lots.
4. feasibility_report needs a design (design_house) and makes the cost estimate itself when there is none,
   so don't add estimate_cost before it unless the user asked for an estimate.

Recipes (adapt them to the goal):
- "Is it worth building / assess / profit / sell or rent / best lot to build on": design_house, then feasibility_report
  for each candidate lot, then compare_plans when there is more than one. All of these slow steps go in ONE plan.
- "Find land that doesn't flood / has good soil": search_land, then check_site on the listings.
- "Compare plans we already have": compare_plans (list_saved_plans first if you don't know the names).
- "Which projects need attention / why are they late": list_projects, then project_details on each relevant one.
5. To compare properties that have plans, use compare_plans: it shows a ranked table to the user and gives you the ranking.
6. Name properties by street address exactly as the tools return them (e.g. "3218 Brass Buttons Trl").
7. If a tool returns an error, read it and fix your input or try another way. Never repeat the same call.
8. When you need information from the user (e.g. no city or budget for a land search), call ask_user.
   Never ask questions in a plain reply: a reply without a tool call ENDS the mission.
9. When the goal is met, reply WITHOUT a tool call. That reply is your final answer:
   start with the answer or recommendation in one sentence, then up to 5 short bullet points with the reasons.
   Use only facts and numbers from tool results; never make up numbers. Under 150 words.
   Slack formatting: *bold* and • bullets, no headings or tables (the user already saw the tables tools posted).`;

/** The system prompt for one turn: the rules plus today's situation. */
function systemPrompt(m: Mission): string {
  const left = (["design", "estimate", "timeline", "feasibility"] as const)
    .map((k) => [k, (m.approved[k] ?? 0) - (m.used[k] ?? 0)] as const)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${k}`);
  return [
    SYSTEM,
    "",
    `Today is ${new Date().toISOString().slice(0, 10)}.`,
    `What happened in this conversation before the goal:\n${threadSummary(getSession(m.key))}`,
    `Approved slow steps still available: ${left.length ? left.join(", ") : "none"}.`,
    ...(m.unattended
      ? [
          "This is a scheduled report: nobody is there to approve plans or answer questions, so you only have quick tools. Answer from what they find.",
        ]
      : []),
  ].join("\n");
}

/** Tool calls from the model's last message that don't have a result yet. */
function pendingCalls(m: Mission): NonNullable<Message["tool_calls"]> {
  let i = m.messages.length - 1;
  while (i >= 0 && m.messages[i]!.role === "tool") i--;
  const last = m.messages[i];
  if (!last || last.role !== "assistant" || !last.tool_calls?.length) return [];
  return last.tool_calls.slice(m.messages.length - 1 - i);
}

/** The tool call made just before the next pending one, as "name {args}", to catch exact repeats. */
function previousCall(m: Mission): string | undefined {
  const calls = m.messages.flatMap((msg) => msg.tool_calls ?? []);
  const answered = m.messages.filter((msg) => msg.role === "tool").length;
  const prev = calls[answered - 1];
  return prev && `${prev.function.name} ${JSON.stringify(prev.function.arguments)}`;
}

const failResult = (error: string): ToolOutcome => ({ result: { error }, failed: true });

/** Missions whose loop is running in this process, so a mission never runs twice at once. */
const driving = new Map<string, Promise<void>>();

/** Run (or continue) a mission's loop in the background. */
function drive(ctx: Ctx, id: string): Promise<void> {
  const running = driving.get(id);
  // Still finishing a previous stretch (e.g. "Go" clicked the moment it paused): continue after it.
  if (running) return running.then(() => drive(ctx, id));
  const run = loop(ctx, id)
    .catch((err) => fail(ctx, id, err))
    .finally(() => driving.delete(id));
  driving.set(id, run);
  return run;
}

/** Resolves when the mission's loop stops (finished, or paused for the user). For tests. */
export function settled(id: string): Promise<void> {
  return driving.get(id) ?? Promise.resolve();
}

async function loop(ctx: Ctx, id: string): Promise<void> {
  const m = getMission(id);
  if (!m) return;
  const status = (now?: string) =>
    ctx.out.status(missionStatusText(m, now), {
      cancelId: m.id,
      cancelAction: MISSION_CANCEL_BUTTON,
    });

  for (;;) {
    if (m.state === "cancelled") {
      await ctx.out.status(missionStatusText(m, ":octagonal_sign: Cancelled."));
      return;
    }
    if (m.state !== "running") return;

    // 1. Run the model's tool calls that don't have a result yet, one at a time.
    const [call] = pendingCalls(m);
    if (call) {
      const { name, arguments: args } = call.function;
      const tool = TOOLS_BY_NAME.get(name);
      const allowed = toolsFor(m).map((t) => t.name);
      let outcome: ToolOutcome;
      if (!tool || !allowed.includes(name)) {
        outcome = failResult(`There is no tool "${name}". Tools: ${allowed.join(", ")}.`);
      } else if (previousCall(m) === `${name} ${JSON.stringify(args)}`) {
        outcome = failResult(
          "You just made this exact call; its result is above. Use it, or do something different.",
        );
      } else {
        const step = { text: tool.label(args), state: "running" as const };
        m.steps.push(step);
        await saveMission(m);
        await status();
        console.log(`  [${m.id}] ${name} ${JSON.stringify(args)}`);
        try {
          outcome = await tool.run(args, { ctx, mission: m });
        } catch (err) {
          console.error(err);
          outcome = failResult(err instanceof Error ? err.message : String(err));
        }
        const last = m.steps.at(-1)!;
        last.text = outcome.done ?? last.text;
        if (outcome.pause) {
          // The tool posted its question and set the waiting state; the user's answer continues the loop.
          await saveMission(m);
          await status();
          return;
        }
        last.state = outcome.failed ? "failed" : "done";
      }
      // Cancelled while the tool was running: stop without recording its result.
      if ((m.state as string) === "cancelled") continue;
      m.messages.push({ role: "tool", tool_name: name, content: JSON.stringify(outcome.result) });
      await saveMission(m);
      continue;
    }

    // 2. Ask the model for its next step.
    if (m.modelCalls >= MAX_MODEL_CALLS) return finish(ctx, m, await wrapUp(m));
    await status("Deciding what to do next…");
    const reply = await chatTools(
      [{ role: "system", content: systemPrompt(m) }, ...m.messages],
      toolsFor(m).map((t) => t.schema),
    );
    m.modelCalls++;
    if ((m.state as string) === "cancelled") continue;

    const calls = reply.tool_calls ?? [];
    // Small models often ask "which city?" in a plain reply instead of calling
    // ask_user, which would end the mission and lose the goal. A new goal always
    // needs tools, so a reply before any tool was used is a clarifying question:
    // it is turned into ask_user and the mission waits for the answer. A
    // follow-up can be answered from the earlier result, so there only a reply
    // that actually asks something is treated that way.
    const content = reply.content?.trim() ?? "";
    const asking = !m.followsUp || content.includes("?");
    if (!calls.length && !m.steps.length && !m.unattended && content && asking)
      calls.push({ function: { name: "ask_user", arguments: { question: content } } });
    // Thinking text isn't kept: it's long, and the model doesn't need its old thoughts.
    m.messages.push({
      role: "assistant",
      content: reply.content ?? "",
      ...(calls.length ? { tool_calls: calls } : {}),
    });
    await saveMission(m);
    if (calls.length) continue;

    if (reply.content?.trim()) return finish(ctx, m, reply.content);
    // An empty reply: nudge it once more (the step limit stops endless nudging).
    m.messages.push({ role: "user", content: "Please give your final answer now." });
    await saveMission(m);
  }
}

/** Out of steps: ask for the best answer from what it has, without tools. */
async function wrapUp(m: Mission): Promise<string> {
  const reply = await chatTools(
    [
      { role: "system", content: systemPrompt(m) },
      ...m.messages,
      {
        role: "user",
        content:
          "You have used all your steps. Give your final answer now from what you found, and say what is still undone.",
      },
    ],
    [],
  );
  return reply.content || "I ran out of steps before finishing. The results so far are above.";
}

async function finish(ctx: Ctx, m: Mission, answer: string): Promise<void> {
  m.state = "done";
  m.answer = answer;
  await saveMission(m);
  await ctx.out.status(missionStatusText(m, ":white_check_mark: Done."));
  await ctx.out.reply(missionDoneReply(m, answer));
}

async function fail(ctx: Ctx, id: string, err: unknown): Promise<void> {
  console.error(`Mission ${id} failed:`, err);
  const m = getMission(id);
  if (!m) return;
  m.state = "failed";
  await saveMission(m);
  await ctx.out.status(missionStatusText(m, ":x: Stopped."));
  await ctx.out.reply(errorReply(err));
}

// ---------------------------------------------------------------------------
// Entry points used by superagent.ts (messages) and src/slack.ts (buttons).
// ---------------------------------------------------------------------------

/**
 * Start working on a goal. Returns the mission id once it is under way (the
 * work continues in the background), or undefined if this conversation is
 * still busy with another mission.
 * `unattended`: started by the scheduler, so only quick tools (nobody to ask).
 */
export async function startMission(
  ctx: Ctx,
  goal: string,
  opts: { unattended?: boolean } = {},
): Promise<string | undefined> {
  const busy = activeMission(ctx.key);
  if (busy) {
    await ctx.out.reply(missionBusyReply(busy));
    return undefined;
  }
  // A goal soon after another one may build on it ("yes, run those", "now do
  // the same for Cadillac Dr"), so the model gets the earlier goal and answer.
  const previous = opts.unattended ? undefined : recentMission(ctx.key);
  const m = await createMission(ctx.key, ctx.user, goal, {
    unattended: opts.unattended,
    previous,
  });
  console.log(`Mission ${m.id} started in ${ctx.key}: "${goal}"`);
  void drive(ctx, m.id);
  return m.id;
}

/** Answer the paused tool call (propose_plan or ask_user) and continue the loop. */
async function resume(ctx: Ctx, m: Mission, result: unknown, stepText: string): Promise<void> {
  const [call] = pendingCalls(m);
  if (call)
    m.messages.push({
      role: "tool",
      tool_name: call.function.name,
      content: JSON.stringify(result),
    });
  const last = m.steps.at(-1);
  if (last) Object.assign(last, { text: stepText, state: "done" });
  m.state = "running";
  m.pendingPlan = undefined;
  m.pendingQuestion = undefined;
  await saveMission(m);
  void drive(ctx, m.id);
}

/** "Go" on a proposed plan: approve its slow steps and carry on. Only the person who asked may approve. */
export async function approveMission(ctx: Ctx, id: string): Promise<void> {
  const m = getMission(id);
  if (!m || m.state !== "waiting-approval" || !m.pendingPlan) return;
  if (ctx.user !== m.user) return ctx.out.reply(notYourMissionReply(m));
  for (const [kind, n] of Object.entries(m.pendingPlan.counts))
    m.approved[kind as keyof typeof m.approved] =
      (m.approved[kind as keyof typeof m.approved] ?? 0) + n;
  const minutes = m.pendingPlan.minutes;
  await resume(
    ctx,
    m,
    { approved: true, message: "The user approved the plan. Run its steps now." },
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
      {
        approved: false,
        userSays: text,
        message:
          "The user did not approve yet. Adjust the plan to what they said and call propose_plan again, or answer them if no slow work is needed any more.",
      },
      `You asked for changes: "${text}"`,
    );
  if (m.state === "waiting-answer")
    return resume(ctx, m, { answer: text }, `You answered: "${text}"`);
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
  console.log(`Mission ${m.id} cancelled`);
  await ctx.out.reply(missionCancelledReply(m));
}

/**
 * Called once when the bot starts: missions that were running when it
 * stopped carry on from their last saved step. A slow job that was running is
 * started again (its tool call never got a result). Missions waiting for the
 * user stay paused; their buttons and replies still work.
 */
export async function resumeMissions(makeCtx: (key: string, user: string) => Ctx): Promise<number> {
  const running = allMissions().filter((m) => m.state === "running");
  for (const m of running) {
    if (m.inflight) {
      // That job will be queued again, so it shouldn't count twice against the approval.
      m.used[m.inflight.kind] = Math.max(0, (m.used[m.inflight.kind] ?? 1) - 1);
      m.inflight = undefined;
    }
    const lastStep = m.steps.at(-1);
    if (lastStep?.state === "running") m.steps.pop();
    await saveMission(m);
    const ctx = makeCtx(m.key, m.user);
    try {
      await ctx.out.reply(missionResumeReply(m));
      void drive(ctx, m.id);
    } catch (err) {
      console.error(`Could not resume mission ${m.id}:`, err);
    }
  }
  return running.length;
}
