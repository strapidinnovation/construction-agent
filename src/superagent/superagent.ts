/**
 * SuperAgent's brain: decides what to do with each message and does it.
 *
 * The flow for every message is:
 *   1. Load this conversation's memory (sessions.ts).
 *   2. Ask the router (router.ts) what the user wants.
 *   3. Run the matching skill (skills/), updating the conversation memory.
 *   4. Send the result through the conversation's `Output`.
 *
 * Nothing in this file talks to Slack directly. src/slack.ts creates an
 * Output that posts to Slack and passes it in. That separation means
 * the same logic can be driven by a test script that prints to the console.
 *
 * Quick jobs (search, projects, status, help, cancel) answer immediately. Slow jobs
 * (house design, cost estimate, timeline) go into the job queue (queue.ts)
 * and report progress while they run.
 *
 * Goals that need several steps ("find the best lot under 300k and tell me if
 * it's worth building") go to the agent (agent/agent.ts), which decides on its
 * own which of these skills to use, in what order.
 */
import { existsSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { DESIGN_MODEL, ESTIMATE_MODEL, MODEL } from "../llm.ts";
import { answerMission, cancelMission, startMission } from "./agent/agent.ts";
import { activeMission, waitingMission } from "./agent/missions.ts";
import { checkModels } from "./health.ts";
import {
  allJobs,
  cancel,
  enqueue,
  findDuplicate,
  jobsAhead,
  jobsForUser,
  newJobId,
  type JobInfo,
  type JobKind,
} from "./queue.ts";
import { findPlanByName, listingOfPlan, planForListing, savedPlans, streetOf } from "./plans.ts";
import type { Listing } from "../agents/landSearch.ts";
import { bestMatch } from "./match.ts";
import { route, type Request } from "./router.ts";
import {
  allSessions,
  findListingByUrl,
  forgetJob,
  getSession,
  recentAnswer,
  saveJob,
  updateSession,
  type LastAnswer,
  type ReplyMode,
  type SavedJob,
  type Session,
} from "./sessions.ts";
import { designHouse } from "./skills/design.ts";
import { estimateCost } from "./skills/estimate.ts";
import { searchLand } from "./skills/search.ts";
import {
  explainDelay,
  findProject,
  listProjects,
  loadProjects,
  statusText,
  summarizeProject,
  type Project,
} from "./skills/projects.ts";
import { planTimeline } from "./skills/timeline.ts";
import { feasibilityReport, type FeasibilityResult } from "./skills/feasibility.ts";
import type { DesignResult } from "./skills/design.ts";
import type { EstimateResult } from "./skills/estimate.ts";
import type { TimelineResult } from "./skills/timeline.ts";
import {
  cancelledReply,
  cancelReply,
  designDoneReply,
  designTitle,
  duplicateReply,
  estimateDoneReply,
  estimateTitle,
  feasibilityDoneReply,
  feasibilityTitle,
  helpReply,
  jobFailedReply,
  limitReply,
  listingAmbiguousReply,
  listingNotFoundReply,
  listingsReply,
  MAX_LISTINGS,
  missingSearchInfo,
  noListingsYetReply,
  noPlanForReply,
  noPlanReply,
  noSuchListingNumberReply,
  modelDownReply,
  planAmbiguousReply,
  projectAmbiguousReply,
  projectDelayReply,
  projectNotFoundReply,
  projectOverviewReply,
  projectsListReply,
  queuedText,
  resumeReply,
  statusReply,
  stepText,
  street,
  timelineDoneReply,
  timelineTitle,
  whichListingReply,
  type Reply,
} from "./slackUi.ts";

/** How many slow jobs one person may have waiting or running at the same time. */
const MAX_JOBS_PER_USER = 2;

/** A quick answer to remember as the conversation's last answer, for follow-ups. */
const answered = (request: string, summary: string): LastAnswer => ({
  request,
  summary,
  at: new Date().toISOString(),
});

/**
 * Where SuperAgent sends its answers for one conversation. src/slack.ts implements
 * this for Slack; a test can implement it with console.log.
 */
export type Output = {
  /** Post a new message in the conversation. */
  reply(reply: Reply): Promise<void>;
  /**
   * Show a progress line. The first call posts a status message; later calls
   * edit that same message, so progress updates don't flood the conversation.
   * `cancelId` adds a "Cancel" button for that job while it can still be cancelled;
   * `cancelAction` is the button's action id (default: the job Cancel button).
   */
  status(text: string, opts?: { cancelId?: string; cancelAction?: string }): Promise<void>;
  /** Upload files (e.g. plan.pdf and plan.png) into the conversation with a short comment. */
  upload(files: { path: string; title: string }[], comment: string): Promise<void>;
};

/**
 * Who is asking and where to answer. Every request carries one of these:
 * - key:  which conversation's memory to use (see conversationKey in sessions.ts),
 * - user: the Slack user id of the person who wrote the message or clicked,
 * - out:  how to post into that conversation,
 * - mode: how the bot holds conversations (thread / channel / user), used to
 *         describe its memory in the help message.
 * - makeOutput: a fresh Output for the same conversation. Each Output keeps ONE
 *         status message, so the agent gives every job it starts its own Output
 *         (otherwise the jobs would overwrite the agent's checklist).
 */
export type Ctx = {
  key: string;
  user: string;
  out: Output;
  mode?: ReplyMode;
  makeOutput?: () => Output;
};

/** Handle one message sent to the bot. */
export async function handleMessage(ctx: Ctx, text: string): Promise<void> {
  // The agent asked this person something (approve a plan, pick an option):
  // their next message is the answer, unless they want to stop.
  const waiting = waitingMission(ctx.key, ctx.user);
  if (waiting) {
    if (/^\s*(cancel|stop|never ?mind|abort)\b/i.test(text)) return cancelMission(ctx, waiting.id);
    return answerMission(ctx, waiting.id, text);
  }

  const session = getSession(ctx.key);
  const projectNames = loadProjects().map((p) => p.data.name);
  const recent = recentAnswer(session);
  const agentNote = recent
    ? `SuperAgent's last answer here was to "${recent.request}": "${recent.summary.slice(-300)}". A reply that continues it with several steps or several things ("yes, do that", "why for each of them", "now the same for X") is a "goal".`
    : undefined;
  const request = await route(text, session, projectNames, agentNote);
  console.log(`  intent: ${JSON.stringify(request)}`);

  // Safety net: "status of the X project" sometimes comes back as the
  // conversation "status" intent, but with a project name filled in. A project name means
  // the question is about that project.
  if (request.intent === "status" && request.projectName) request.intent = "projects";
  // "Which projects need attention, and why?" asks for the reasons behind a
  // whole list, which means reading each project: a job for the agent.
  if (
    request.intent === "projects" &&
    !request.projectName &&
    request.projectFilter !== "all" &&
    request.projectTopic === "delay"
  )
    request.intent = "goal";
  // The single-property skills work on one property; several named ("Brass
  // Buttons and Corral Lane", "A, B") is a job for the agent.
  // The same goes for follow-ups to the last answer that point back at
  // several things ("how long would each take?", "estimate both of them").
  const singleProperty = ["design", "estimate", "timeline", "feasibility"];
  const several = /,|;|\band\b|&/i.test(request.listing);
  const backReference = /\b(each|both|them|those|these|all)\b/i.test(text);
  if (singleProperty.includes(request.intent) && (several || (recent && backReference)))
    request.intent = "goal";

  switch (request.intent) {
    case "search":
      return ctx.out.reply(await search(ctx.key, session, request, text));
    case "design":
      return startDesign(
        ctx,
        { name: request.listing, number: request.listingNumber },
        request.lot,
      );
    // The router sometimes files a named property under projectName ("the
    // timeline for River Bend"), so either field can name the plan.
    case "estimate":
      return startEstimate(ctx, { name: request.listing || request.projectName });
    case "timeline":
      return startTimeline(ctx, request.startDate, {
        name: request.listing || request.projectName,
      });
    case "feasibility":
      return startFeasibility(ctx, { name: request.listing || request.projectName });
    case "status":
      return ctx.out.reply(statusReply(session, activeMission(ctx.key)?.goal));
    case "projects":
      return projects(ctx, session, request, text);
    case "goal":
      await startMission(ctx, text);
      return;
    case "cancel": {
      // A typed "cancel" stops the agent's mission here first (which also stops its job).
      const mission = activeMission(ctx.key);
      return mission ? cancelMission(ctx, mission.id) : cancelJob(ctx);
    }
    case "help":
      return ctx.out.reply(helpReply(ctx.mode));
  }
}

/**
 * Run a land search. If the message left out the city or budget but this
 * conversation already searched before, reuse the earlier value ("same but under
 * 200k"). The router is asked to do this too; doing it here as well makes it
 * reliable even when the model forgets.
 */
async function search(
  key: string,
  session: Session,
  request: Request,
  text: string,
): Promise<Reply> {
  const city = request.city || session.search?.city || "";
  const budget = request.budget || session.search?.budget || "";
  const result = await searchLand(city, budget);
  if (!result.ok) return missingSearchInfo(result.reason, result.budget);

  // Only the listings we actually show are remembered, so "#3"
  // always means the third line of the message the user is looking at.
  const shown = result.listings.slice(0, MAX_LISTINGS);
  const streets = shown.map((l) => l.address.split(",")[0]).join("; ");
  await updateSession(key, {
    search: { city: result.city, budget, lo: result.lo, hi: result.hi },
    listings: shown,
    selected: undefined,
    lastAnswer: answered(text, `Showed ${shown.length} listings in ${result.city}: ${streets}.`),
  });
  return listingsReply(shown, result.listings.length, result.city, result.lo, result.hi);
}

// ---------------------------------------------------------------------------
// Construction projects. These are quick answers (reading JSON files plus at
// most one short model call), so they don't go through the job queue.
// ---------------------------------------------------------------------------

/**
 * Answer a question about ongoing projects:
 * - no project name           -> the list (optionally filtered, e.g. only delayed),
 * - a name                    -> that project's overview,
 * - a name + "why is it late" -> the delay breakdown.
 * "Why is it late?" without a name uses the project last discussed in this conversation.
 */
async function projects(ctx: Ctx, session: Session, request: Request, text: string): Promise<void> {
  // Only a question about one project ("why is it late?") falls back to the
  // last project discussed; a filtered list ("which are delayed?") never does.
  const followUp = request.projectTopic === "delay" && request.projectFilter === "all";
  const name = request.projectName || (followUp ? (session.projectName ?? "") : "");
  if (!name) {
    const list = listProjects(request.projectFilter);
    const names = list
      .map((p) => `${p.data.name} (${statusText(p.status)}, ${p.daysLate} days late)`)
      .join("; ");
    await updateSession(ctx.key, {
      lastAnswer: answered(text, `Listed ${list.length} projects: ${names || "none"}.`),
    });
    return ctx.out.reply(projectsListReply(list, request.projectFilter));
  }

  const found = findProject(name);
  if (found.kind === "not-found") return ctx.out.reply(projectNotFoundReply(name, found.names));
  if (found.kind === "ambiguous") return ctx.out.reply(projectAmbiguousReply(name, found.options));
  await showProject(ctx, found.project, request.projectTopic, text);
}

/** Post one project's overview or delay breakdown, and remember it as the conversation's current project. */
async function showProject(
  ctx: Ctx,
  p: Project,
  topic: "overview" | "delay",
  text = topic === "delay" ? `Why is ${p.data.name} late?` : `Tell me about ${p.data.name}`,
): Promise<void> {
  const what = topic === "delay" ? "why it is late" : "an overview";
  await updateSession(ctx.key, {
    projectName: p.data.name,
    lastAnswer: answered(
      text,
      `Showed ${what} of ${p.data.name} (${statusText(p.status)}, ${p.daysLate} days late).`,
    ),
  });
  if (topic === "delay") {
    const explanation = p.daysLate > 0 && p.delayCauses.length ? await explainDelay(p) : null;
    return ctx.out.reply(projectDelayReply(p, explanation));
  }
  return ctx.out.reply(projectOverviewReply(p, await summarizeProject(p)));
}

/** For the "Details" and "Why is it late?" buttons, whose value is the project id. */
export async function showProjectById(
  ctx: Ctx,
  id: string,
  topic: "overview" | "delay",
): Promise<void> {
  const p = loadProjects().find((x) => x.data.id === id);
  if (!p) return ctx.out.reply({ text: "That project no longer exists in data/projects/." });
  await showProject(ctx, p, topic);
}

/**
 * Cancel a job. The Cancel button passes the exact job id; a typed "cancel"
 * stops this conversation's running job, or its most recently queued one.
 */
export async function cancelJob(ctx: Ctx, id?: string): Promise<void> {
  await ctx.out.reply(cancelReply(cancel(ctx.key, id)));
}

// ---------------------------------------------------------------------------
// Slow jobs: design, estimate and timeline.
//
// All three follow the same pattern, handled by queueJob():
//   1. Checks: refuse an exact duplicate (the same kind of job on the same
//      property, already waiting or running), refuse if this person already
//      has too many jobs, and refuse if Ollama / the model isn't available.
//      Different jobs are NOT refused: they wait in line.
//   2. Save the job in the conversation's memory, so it survives a restart.
//   3. Post a status message with its own Cancel button ("Starting…" or
//      "Waiting in line: 2 jobs ahead").
//   4. Put the job in the queue. When its turn comes, it runs the skill, edits
//      the status message with each step, then posts the result and files.
//   5. At every step it checks whether it was cancelled, and stops if so.
//   6. When it ends (done, failed or cancelled) the saved job is removed.
//
// Each job has two entry points:
//   - queueDesign / queueEstimate / ...: return a `Started` handle. If the job
//     was refused, it holds the reason; otherwise its `outcome` resolves with
//     the result when the job ends. The agent uses these to wait for results.
//   - startDesign / startEstimate / ...: the same, but they post a refusal to
//     the conversation and don't wait. Messages and buttons use these.
// ---------------------------------------------------------------------------

/** Thrown from a progress step when the job has been cancelled; unwinds out of the skill. */
class Cancelled extends Error {}

/** How a queued job ended. */
export type JobOutcome<R> =
  { status: "done"; value: R } | { status: "cancelled" } | { status: "failed"; error: string };

/** The answer to "start this job": refused (with the reply explaining why), or queued. */
export type Started<R> =
  { ok: false; reply: Reply } | { ok: true; id: string; outcome: Promise<JobOutcome<R>> };

/**
 * Options for jobs started by the agent:
 * - persist: false skips saving the job for a restart. The agent's mission
 *   is saved instead and starts the job again itself after a restart.
 */
export type QueueOpts = { persist?: boolean };

/** Post the refusal (if any) and don't wait for the job; used by messages and buttons. */
async function postRefusal(ctx: Ctx, started: Started<unknown>): Promise<void> {
  if (!started.ok) await ctx.out.reply(started.reply);
}

type JobSpec<R> = {
  kind: JobKind;
  /** The property the job is for (its URL identifies duplicates). */
  listing: Listing;
  /** Job-specific inputs to save for a restart (lot size, start date, plan folder). */
  saved: Pick<SavedJob, "lotText" | "startText" | "planDir">;
  /** Ollama models the job needs, checked before queueing. */
  models: string[];
  /** First line of the status message, e.g. "Designing 123 Main St". */
  title: string;
  /** Extra line under "Starting…" / "Waiting in line…", e.g. "Waits for the design". */
  note?: string;
  /** The actual work. Report progress with `step(...)`; post results through `out`; return the result. */
  work: (step: (text: string) => void) => Promise<R>;
};

async function queueJob<R>(ctx: Ctx, job: JobSpec<R>, opts: QueueOpts = {}): Promise<Started<R>> {
  const { key, user, out } = ctx;
  const subject = street(job.listing);
  const persist = opts.persist ?? true;

  const duplicate = findDuplicate(job.kind, job.listing.url);
  if (duplicate) return { ok: false, reply: duplicateReply(duplicate) };
  if (jobsForUser(user) >= MAX_JOBS_PER_USER)
    return { ok: false, reply: limitReply(MAX_JOBS_PER_USER) };
  const problem = await checkModels(job.models);
  if (problem) return { ok: false, reply: modelDownReply(problem) };

  const id = newJobId();
  if (persist) await saveJob(key, { id, kind: job.kind, user, listing: job.listing, ...job.saved });
  const forget = () => (persist ? forgetJob(key, id) : Promise.resolve());

  // `outcome` resolves exactly once, whichever way the job ends.
  let settle!: (o: JobOutcome<R>) => void;
  const outcome = new Promise<JobOutcome<R>>((resolve) => (settle = resolve));

  // Post the "waiting/starting" status BEFORE queueing: if the queue is empty
  // the job starts immediately and its first progress step must come after this.
  await out.status(queuedText(job.title, jobsAhead(), job.note), { cancelId: id });

  enqueue({
    id,
    key,
    user,
    kind: job.kind,
    target: job.listing.url,
    subject,
    label: `${job.kind} ${subject}`,
    // Cancelled while still waiting: it never ran, so just tidy up.
    dropped: async () => {
      await forget();
      await out.status(stepText(job.title, ":octagonal_sign: Cancelled."));
      settle({ status: "cancelled" });
    },
    run: async (signal) => {
      // Every progress update first checks for a cancel request. Throwing here
      // stops the skill wherever it is (between trades of an estimate, or
      // mid-stream while the plan is being drawn).
      const step = (text: string) => {
        if (signal.aborted) throw new Cancelled();
        void out.status(stepText(job.title, text), { cancelId: id });
      };
      try {
        step("Starting…");
        const value = await job.work(step);
        await out.status(stepText(job.title, ":white_check_mark: Done."));
        settle({ status: "done", value });
      } catch (err) {
        if (signal.aborted || err instanceof Cancelled) {
          await out.status(stepText(job.title, ":octagonal_sign: Cancelled."));
          await out.reply(cancelledReply({ kind: job.kind, subject }));
          settle({ status: "cancelled" });
        } else {
          console.error(err);
          await out.status(stepText(job.title, ":x: Stopped."));
          await out.reply(jobFailedReply(job.kind, err));
          settle({ status: "failed", error: err instanceof Error ? err.message : String(err) });
        }
      } finally {
        await forget();
      }
    },
  });
  return { ok: true, id, outcome };
}

/**
 * How a request points at a listing. Any of these may be given; they are
 * tried in this order:
 * - url:    from the "Design on this lot" button (always exact),
 * - name:   what the user wrote, e.g. "Corral Lane" or "8446" (matched in code),
 * - number: a position, e.g. "#3" or "the third one".
 * - listing: the listing itself (the agent finds it in its own memory first).
 * With none of them, the lot picked earlier in this conversation is used.
 */
export type ListingRef = { url?: string; name?: string; number?: number; listing?: Listing };

/** Find the listing a request points at, or the reply explaining why it couldn't be found. */
function listingFor(session: Session, ref: ListingRef): { listing: Listing } | { reply: Reply } {
  if (ref.listing) return { listing: ref.listing };
  const { listings } = session;
  if (ref.url) {
    // A button under someone else's listings (in "user" mode) isn't in this
    // person's memory, so look in every conversation's memory too.
    const listing = listings.find((l) => l.url === ref.url) ?? findListingByUrl(ref.url);
    return listing
      ? { listing }
      : { reply: { text: "I don't have that listing anymore. Please search again." } };
  }
  if (!listings.length) return { reply: noListingsYetReply() };

  if (ref.name) {
    // Match against the street part only ("8435 Corral Ln"): every listing in
    // a search shares the city, state and ZIP, so those words can't tell them apart.
    const match = bestMatch(ref.name, listings, (l) => [street(l)], {
      extraFiller: ["lot", "property", "land", "house", "home", "parcel", "listing", "plot"],
    });
    if (match.kind === "found") return { listing: match.item };
    if (match.kind === "ambiguous") return { reply: listingAmbiguousReply(ref.name, match.items) };
    return { reply: listingNotFoundReply(ref.name, listings) };
  }
  if (ref.number) {
    const listing = listings[ref.number - 1];
    return listing ? { listing } : { reply: noSuchListingNumberReply(ref.number, listings.length) };
  }
  const selected = listings.find((l) => l.url === session.selected?.url);
  return selected ? { listing: selected } : { reply: whichListingReply(listings) };
}

/**
 * Start a house design on the listing `ref` points at.
 * Used by "design a house on Corral Lane" and by the "Design on this lot"
 * button. Returns as soon as the job is queued.
 */
export async function startDesign(ctx: Ctx, ref: ListingRef, lotText: string): Promise<void> {
  await postRefusal(ctx, await queueDesign(ctx, ref, lotText));
}

export async function queueDesign(
  ctx: Ctx,
  ref: ListingRef,
  lotText: string,
  opts?: QueueOpts,
): Promise<Started<DesignResult>> {
  const { key, out } = ctx;
  const found = listingFor(getSession(key), ref);
  if ("reply" in found) return { ok: false, reply: found.reply };
  const { listing } = found;

  await updateSession(key, { selected: listing });
  return queueJob(
    ctx,
    {
      kind: "design",
      listing,
      saved: { lotText },
      models: [DESIGN_MODEL],
      title: designTitle(listing),
      work: async (step) => {
        const result = await designHouse(listing, lotText, step);
        // Remember the plan folder: estimates and timelines build on it.
        await updateSession(key, { planDir: result.dir });
        await out.reply(designDoneReply(listing, result));
        await out.upload(
          [
            { path: result.pngPath, title: "Site and floor plan (preview)" },
            { path: result.pdfPath, title: "Site and floor plan (PDF)" },
          ],
          "Here's the plan. Open the PDF for the full page with notes.",
        );
        return result;
      },
    },
    opts,
  );
}

/**
 * How an estimate or timeline request points at a plan, tried in this order:
 * - planDir: from the "Estimate cost" / "Plan the timeline" button (exact),
 * - url:     a property's listing URL (used when restarting saved jobs),
 * - name:    the property the user named, e.g. "3218 Brass Buttons Trl".
 * With none of them, this conversation's latest plan is used.
 */
export type PlanRef = { planDir?: string; url?: string; name?: string };

/**
 * Where a plan comes from:
 * - "ready":        the plan exists; use this folder.
 * - "after-design": a design for this property is still waiting or running;
 *                   the job waits for it and looks the plan up when it starts.
 */
/** The jobs that work on an existing plan. */
type PlanJob = "estimate" | "timeline" | "feasibility";

type PlanTarget =
  | { kind: "ready"; planDir: string; listing: Listing }
  | { kind: "after-design"; listing: Listing; design: JobInfo };

/** A plan folder's listing, or a stand-in if its inputs.json is missing. */
function planListing(planDir: string): Listing {
  return (
    listingOfPlan(planDir) ?? {
      address: basename(planDir),
      url: planDir,
      city: null,
      state: null,
      zipCode: null,
      county: null,
      latitude: null,
      longitude: null,
      priceUsd: 0,
      lotSqft: null,
      acres: null,
    }
  );
}

/** Designs that are waiting or running, newest first. */
const pendingDesigns = () =>
  allJobs()
    .filter((j) => j.kind === "design")
    .reverse();

/** A design in the queue for this property, as a PlanTarget (its listing is in someone's memory). */
function afterDesign(design: JobInfo): PlanTarget | undefined {
  const listing = findListingByUrl(design.target);
  return listing ? { kind: "after-design", listing, design } : undefined;
}

/** Find the plan an estimate or timeline should use, or the reply explaining why there isn't one. */
function planFor(ctx: Ctx, ref: PlanRef, what: PlanJob): PlanTarget | { reply: Reply } {
  if (ref.planDir)
    return { kind: "ready", planDir: ref.planDir, listing: planListing(ref.planDir) };

  if (ref.url) {
    const design = pendingDesigns().find((j) => j.target === ref.url);
    const pending = design && afterDesign(design);
    if (pending) return pending;
    const plan = planForListing(ref.url);
    if (plan) return { kind: "ready", planDir: plan.dir, listing: plan.listing };
    return { reply: noPlanReply(what) };
  }

  if (ref.name) {
    // A design still in the queue wins over an older plan of the same
    // property: the user most likely wants the estimate of the new design.
    const queued = bestMatch(ref.name, pendingDesigns(), (j) => [j.subject], {
      extraFiller: ["lot", "property", "land", "house", "home", "plan"],
    });
    const pending = queued.kind === "found" ? afterDesign(queued.item) : undefined;
    if (pending) return pending;

    const match = findPlanByName(ref.name);
    if (match.kind === "found")
      return { kind: "ready", planDir: match.item.dir, listing: match.item.listing };
    if (match.kind === "ambiguous")
      return {
        reply: planAmbiguousReply(
          ref.name,
          match.items.map((p) => streetOf(p.listing.address)),
        ),
      };
    return {
      reply: noPlanForReply(
        ref.name,
        savedPlans().map((p) => streetOf(p.listing.address)),
      ),
    };
  }

  // Nothing named: a design queued in this conversation, else its latest plan.
  const mine = pendingDesigns().find((j) => j.key === ctx.key);
  const pending = mine && afterDesign(mine);
  if (pending) return pending;
  const { planDir } = getSession(ctx.key);
  if (planDir) return { kind: "ready", planDir, listing: planListing(planDir) };
  return { reply: noPlanReply(what) };
}

/**
 * When the job starts: the plan folder to work on. For "after-design" jobs,
 * the plan must have been made after the job was queued; an older plan of the
 * same property doesn't count (the design it waited for may have failed).
 */
function resolvePlanDir(target: PlanTarget, queuedAt: number, what: string): string {
  if (target.kind === "ready") return target.planDir;
  const plan = planForListing(target.listing.url);
  if (!plan || statSync(plan.dir).birthtimeMs < queuedAt)
    throw new Error(
      `the design for ${street(target.listing)} didn't finish, so there's no plan to ${what}.`,
    );
  return plan.dir;
}

/** The note shown under the status line for jobs that depend on other queued jobs. */
function dependencyNote(target: PlanTarget, what: PlanJob): string | undefined {
  const notes: string[] = [];
  if (target.kind === "after-design")
    notes.push(`Waits for the design of ${street(target.listing)} to finish first.`);
  const queuedFor = (kind: JobKind) =>
    allJobs().some((j) => j.kind === kind && j.target === target.listing.url);
  if (what === "timeline" && queuedFor("estimate"))
    notes.push("It will use the cost estimate ahead of it once that's done.");
  if (what === "estimate" && queuedFor("timeline"))
    notes.push(
      "The timeline ahead of this won't include this estimate; ask for the timeline again afterwards to use its labor figures.",
    );
  if (what === "feasibility") {
    const hasEstimate =
      target.kind === "ready" && existsSync(join(target.planDir, "estimate.json"));
    if (queuedFor("estimate")) notes.push("It will use the cost estimate ahead of it.");
    else if (!hasEstimate)
      notes.push("There's no cost estimate yet, so it runs the estimate first (about 10 minutes).");
    if (queuedFor("timeline"))
      notes.push("It will use the timeline ahead of it for the build length.");
  }
  return notes.join(" ") || undefined;
}

/**
 * Start a feasibility report. Used by "feasibility report for 3218 Brass
 * Buttons Trl", "is it worth building?" (latest plan here) and the
 * "Feasibility report" button. If the plan has no cost estimate yet, the job
 * runs the estimate first (see skills/feasibility.ts).
 */
export async function startFeasibility(ctx: Ctx, ref: PlanRef = {}): Promise<void> {
  await postRefusal(ctx, await queueFeasibility(ctx, ref));
}

export async function queueFeasibility(
  ctx: Ctx,
  ref: PlanRef = {},
  opts?: QueueOpts,
): Promise<Started<FeasibilityResult>> {
  const target = planFor(ctx, ref, "feasibility");
  if ("reply" in target) return { ok: false, reply: target.reply };
  const queuedAt = Date.now();

  return queueJob(
    ctx,
    {
      kind: "feasibility",
      listing: target.listing,
      saved: { planDir: target.kind === "ready" ? target.planDir : undefined },
      // The estimate (if it has to run) uses ESTIMATE_MODEL; the summary uses MODEL.
      models: [ESTIMATE_MODEL, MODEL],
      title: feasibilityTitle(street(target.listing)),
      note: dependencyNote(target, "feasibility"),
      work: async (step) => {
        const planDir = resolvePlanDir(target, queuedAt, "assess");
        const result = await feasibilityReport(planDir, step);
        // If the estimate had to run first, share it too.
        if (result.estimate) {
          await ctx.out.reply(estimateDoneReply(result.estimate));
          await ctx.out.upload(
            [{ path: result.estimate.pdfPath, title: "Material and cost estimate (PDF)" }],
            "The feasibility report needed a cost estimate, so here it is too.",
          );
        }
        await ctx.out.reply(feasibilityDoneReply(result));
        await ctx.out.upload(
          [{ path: result.pdfPath, title: "Feasibility report (PDF)" }],
          "Here's the full feasibility report: site checks, costs, sell and rent numbers, comparable homes and assumptions.",
        );
        return result;
      },
    },
    opts,
  );
}

/**
 * Start a cost estimate. Used by "estimate the cost for 3218 Brass Buttons
 * Trl" (that property's plan), "how much will it cost?" (latest plan here),
 * and the "Estimate cost" button (the exact plan it was posted under).
 */
export async function startEstimate(ctx: Ctx, ref: PlanRef = {}): Promise<void> {
  await postRefusal(ctx, await queueEstimate(ctx, ref));
}

export async function queueEstimate(
  ctx: Ctx,
  ref: PlanRef = {},
  opts?: QueueOpts,
): Promise<Started<EstimateResult>> {
  const target = planFor(ctx, ref, "estimate");
  if ("reply" in target) return { ok: false, reply: target.reply };
  const queuedAt = Date.now();

  return queueJob(
    ctx,
    {
      kind: "estimate",
      listing: target.listing,
      saved: { planDir: target.kind === "ready" ? target.planDir : undefined },
      models: [ESTIMATE_MODEL],
      title: estimateTitle(street(target.listing)),
      note: dependencyNote(target, "estimate"),
      work: async (step) => {
        const result = await estimateCost(resolvePlanDir(target, queuedAt, "estimate"), step);
        await ctx.out.reply(estimateDoneReply(result));
        await ctx.out.upload(
          [{ path: result.pdfPath, title: "Material and cost estimate (PDF)" }],
          "Here's the full estimate with every material and labor line.",
        );
        return result;
      },
    },
    opts,
  );
}

/**
 * Start a construction timeline. Used by "plan the timeline for 3218 Brass
 * Buttons Trl", "timeline starting Jan 4" (latest plan here), and the "Plan
 * the timeline" button. `startText` is the start date ("" means next Monday).
 */
export async function startTimeline(ctx: Ctx, startText: string, ref: PlanRef = {}): Promise<void> {
  await postRefusal(ctx, await queueTimeline(ctx, startText, ref));
}

export async function queueTimeline(
  ctx: Ctx,
  startText: string,
  ref: PlanRef = {},
  opts?: QueueOpts,
): Promise<Started<TimelineResult>> {
  const target = planFor(ctx, ref, "timeline");
  if ("reply" in target) return { ok: false, reply: target.reply };
  const queuedAt = Date.now();

  return queueJob(
    ctx,
    {
      kind: "timeline",
      listing: target.listing,
      saved: { startText, planDir: target.kind === "ready" ? target.planDir : undefined },
      models: [ESTIMATE_MODEL],
      title: timelineTitle(street(target.listing)),
      note: dependencyNote(target, "timeline"),
      work: async (step) => {
        const planDir = resolvePlanDir(target, queuedAt, "plan a timeline for");
        const result = await planTimeline(planDir, startText, step);
        await ctx.out.reply(timelineDoneReply(result));
        await ctx.out.upload(
          [{ path: result.pdfPath, title: "Construction timeline (PDF)" }],
          "Here's the full schedule with the Gantt chart, inspections and every task.",
        );
        return result;
      },
    },
    opts,
  );
}

/**
 * Called once when the bot starts. Jobs still saved in a conversation's
 * memory were interrupted by a restart (jobs are removed when they end), so
 * say so and queue them again with the same inputs, in the order they were
 * asked for (so a design comes before the estimate waiting for it).
 *
 * `makeCtx` builds the Ctx for a conversation; src/slack.ts supplies one that
 * posts to Slack.
 */
export async function resumeJobs(makeCtx: (key: string, user: string) => Ctx): Promise<number> {
  let count = 0;
  for (const [key, session] of allSessions()) {
    const jobs = session.jobs ?? [];
    if (!jobs.length) continue;
    await updateSession(key, { jobs: [] });
    for (const job of jobs) {
      count++;
      const ctx = makeCtx(key, job.user);
      console.log(`Resuming ${job.kind} in ${key}`);
      try {
        const subject = job.listing ? street(job.listing) : "";
        await ctx.out.reply(resumeReply({ kind: job.kind, subject }));
        const ref: PlanRef = { planDir: job.planDir, url: job.listing?.url };
        if (job.kind === "design") {
          // Put the saved listing back into memory so it is found by its URL.
          if (job.listing) await updateSession(key, { selected: job.listing });
          await startDesign(ctx, { url: job.listing?.url }, job.lotText ?? "");
        } else if (job.kind === "estimate") await startEstimate(ctx, ref);
        else if (job.kind === "feasibility") await startFeasibility(ctx, ref);
        else await startTimeline(ctx, job.startText ?? "", ref);
      } catch (err) {
        // E.g. the bot was removed from that channel; skip it rather than crash at startup.
        console.error(`Could not resume ${job.kind} in ${key}:`, err);
      }
    }
  }
  return count;
}
