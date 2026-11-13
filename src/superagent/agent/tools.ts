/**
 * The agent's tools: SuperAgent's skills, described so the planner model can
 * choose between them.
 *
 * Each tool has:
 *   - a name and a description the model reads to decide when to use it,
 *   - an input schema (zod), which the Agent SDK sends to the model. Every call
 *     is checked against it in code; a bad call gets a clear error back, so the
 *     model can correct itself instead of the bot crashing,
 *   - `label`: the line shown in the Slack checklist while it runs,
 *   - `run`: does the work and returns a SHORT result for the model. Short
 *     matters: a small model gets confused by long reports, so tools return
 *     the key facts and post the full reports/files to Slack themselves.
 *
 * Two kinds of tools:
 *   - Quick tools (search, site checks, saved plans, comparisons, projects,
 *     conversation status) take seconds and can be used freely.
 *   - Slow tools (design, estimate, timeline, feasibility) take minutes and go
 *     through the job queue. The agent may only run them after the user
 *     approved a plan that includes them (propose_plan); code enforces that
 *     with a budget per kind of job, whatever the model decides. The one
 *     exception: a single slow job may run without a plan, for requests that
 *     ask for exactly that job.
 *
 * Two control tools let the agent talk to the user mid-mission:
 * propose_plan (approval) and ask_user (a question). Both pause the mission
 * until the user answers.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";
import type { Feasibility } from "../../agents/feasibility.ts";
import type { Listing } from "../../agents/landSearch.ts";
import { runSiteChecks, type Flag, type SiteChecks } from "../../agents/siteChecks.ts";
import { HOUSING_TYPE_LABEL, STRATEGY_LABEL, type SiteStrategy } from "../../agents/sitePlanner.ts";
import { researchSiteRules } from "../../agents/siteRules.ts";
import { usd } from "../../listingFormat.ts";
import { bestMatch } from "../match.ts";
import { findPlanByName, listingOfPlan, savedPlans, streetOf } from "../plans.ts";
import { allJobs, type JobKind } from "../queue.ts";
import { getSession, threadSummary, updateSession } from "../sessions.ts";
import { searchLand } from "../skills/search.ts";
import {
  findProject,
  listProjects,
  PROJECT_FILTERS,
  stageLabel,
  statusText,
} from "../skills/projects.ts";
import { listingsReply, MAX_LISTINGS, missingSearchInfo, street } from "../slackUi.ts";
import {
  queueDesign,
  queueEstimate,
  queueFeasibility,
  queueInterior,
  queueTimeline,
  type Ctx,
  type QueueOpts,
  type Started,
} from "../superagent.ts";
import {
  comparisonReply,
  planReply,
  questionReply,
  type ComparisonRow,
  type PlanLine,
} from "./missionUi.ts";
import { activeMissions, saveMission, type JobCounts, type Mission } from "./missions.ts";

/** At most this many house designs in one approved plan (each takes ~7 minutes). */
const MAX_DESIGNS_PER_PLAN = 3;
/** At most this many slow jobs in one approved plan. */
const MAX_SLOW_STEPS_PER_PLAN = 9;

/** Rough minutes per slow job, shown in the plan so people know what they approve. */
const MINUTES: Record<JobKind, number> = {
  design: 7,
  estimate: 12,
  timeline: 6,
  feasibility: 6,
  interior: 4,
};

/** What a tool gets to work with: the conversation (to post into) and the mission. */
export type ToolEnv = { ctx: Ctx; mission: Mission };

/**
 * What a tool hands back:
 * - result: what the model sees (kept short),
 * - done:   the checklist line once finished (default: the label),
 * - failed: show it as failed in the checklist,
 * - pause:  the mission waits for the user (the tool already posted the question).
 */
export type ToolOutcome = {
  result: unknown;
  done?: string;
  failed?: boolean;
  pause?: "approval" | "answer";
};

export type AgentTool = {
  name: string;
  /** What the model reads to decide when to use the tool. */
  description: string;
  /** The input the model must send (agent.ts registers it with the Agent SDK). */
  params: z.ZodObject;
  /** The kind of queued job this tool runs, for slow tools. */
  slow?: JobKind;
  /** Control tools need a person to answer, so scheduled (unattended) missions can't use them. */
  needsUser?: boolean;
  label: (args: unknown) => string;
  run: (args: unknown, env: ToolEnv) => Promise<ToolOutcome>;
};

const fail = (error: string, done?: string): ToolOutcome => ({
  result: { error },
  failed: true,
  done,
});

/** Define a tool. Its input is checked against `params` before `run` is called. */
function defineTool<S extends z.ZodObject>(def: {
  name: string;
  description: string;
  params: S;
  slow?: JobKind;
  needsUser?: boolean;
  label: (args: z.infer<S>) => string;
  run: (args: z.infer<S>, env: ToolEnv) => Promise<ToolOutcome>;
}): AgentTool {
  return {
    name: def.name,
    description: def.description,
    params: def.params,
    slow: def.slow,
    needsUser: def.needsUser,
    label: (args) => {
      const parsed = def.params.safeParse(args ?? {});
      return parsed.success ? def.label(parsed.data) : def.name;
    },
    run: async (args, env) => {
      const parsed = def.params.safeParse(args ?? {});
      if (!parsed.success)
        return fail(`Invalid input for ${def.name}: ${z.prettifyError(parsed.error)}`);
      return def.run(parsed.data, env);
    },
  };
}

/** A list of names; small models sometimes send one string instead of a list, so accept that too. */
const nameList = (description: string, max: number) =>
  z.preprocess(
    (v) => (typeof v === "string" ? [v] : v),
    z.array(z.string()).min(1).max(max).describe(description),
  );

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

// ---------------------------------------------------------------------------
// Finding properties by street name.
// ---------------------------------------------------------------------------

/** Every property the agent can refer to: its own search results, this conversation's, and saved plans. */
function knownListings(env: ToolEnv): Listing[] {
  const session = getSession(env.ctx.key);
  const all = [
    ...env.mission.listings,
    ...session.listings,
    ...(session.selected ? [session.selected] : []),
    ...savedPlans().map((p) => p.listing),
  ];
  const seen = new Set<string>();
  return all.filter((l) => !seen.has(l.url) && seen.add(l.url));
}

function findListing(env: ToolEnv, name: string): { listing: Listing } | { error: string } {
  const listings = knownListings(env);
  if (!listings.length) return { error: "No properties known yet. Use search_land first." };
  const match = bestMatch(name, listings, (l) => [street(l)], {
    extraFiller: ["lot", "property", "land", "house", "home", "parcel", "listing", "plot"],
  });
  if (match.kind === "found") return { listing: match.item };
  const names = (match.kind === "ambiguous" ? match.items : listings).slice(0, 12).map(street);
  return {
    error:
      match.kind === "ambiguous"
        ? `"${name}" matches several properties: ${names.join("; ")}. Use the full street address.`
        : `No known property matches "${name}". Known properties: ${names.join("; ")}.`,
  };
}

// ---------------------------------------------------------------------------
// Slow jobs: the approval budget and waiting for the queued job.
// ---------------------------------------------------------------------------

/**
 * Why this slow job can't run now, or null if it may. An approved plan allows
 * its steps. Before any plan, ONE slow job may run directly: a request for
 * exactly one slow action ("design a house on Corral Ln") is its own approval.
 */
function budgetProblem(m: Mission, kind: JobKind): string | null {
  if (m.unattended)
    return "Slow tools can't run in a scheduled report. Answer with what the quick tools found.";
  if ((m.approved[kind] ?? 0) - (m.used[kind] ?? 0) > 0) return null;
  if (!m.directStep && !Object.keys(m.approved).length) {
    m.directStep = true;
    m.approved[kind] = 1;
    return null;
  }
  return "This step isn't in an approved plan. Call propose_plan listing every slow step you want to run, and wait for the user's approval.";
}

/** How the agent queues jobs: the mission restarts them itself, and they don't change the selected lot. */
const AGENT_JOB: QueueOpts = { persist: false, remember: false };

/**
 * Run one slow job for the mission: check the budget, queue it (with its own
 * Slack status message, so it doesn't overwrite the mission's checklist),
 * wait for it, and summarize the result for the model.
 */
async function runSlow<R>(
  env: ToolEnv,
  kind: JobKind,
  start: (ctx: Ctx) => Promise<Started<R>>,
  summarize: (r: R) => ToolOutcome,
): Promise<ToolOutcome> {
  const m = env.mission;
  const problem = budgetProblem(m, kind);
  if (problem) return fail(problem);

  const jobCtx: Ctx = { ...env.ctx, out: env.ctx.makeOutput?.() ?? env.ctx.out };
  const started = await start(jobCtx);
  // The refusal reply explains why (no plan for that property, a duplicate, Ollama down, …).
  if (!started.ok) return fail(started.reply.text);

  m.used[kind] = (m.used[kind] ?? 0) + 1;
  m.inflight = { jobId: started.id, kind };
  await saveMission(m);
  const outcome = await started.outcome;
  m.inflight = undefined;
  await saveMission(m);

  if (outcome.status === "cancelled") return fail("The job was cancelled.", "Cancelled");
  if (outcome.status === "failed") return fail(`The job failed: ${outcome.error}`);
  return summarize(outcome.value);
}

/** "flag: summary" for each site check, the shape the model sees. */
function siteSummary(site: SiteChecks): Record<string, string> {
  return Object.fromEntries(
    Object.entries(site).map(([k, c]) => [k, `${c.flag}: ${c.summary}`]),
  ) as Record<string, string>;
}

const readJson = <T>(path: string): T | null =>
  existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : null;

// ---------------------------------------------------------------------------
// The tools.
// ---------------------------------------------------------------------------

const searchLandTool = defineTool({
  name: "search_land",
  description:
    "Search Realtor.com for land for sale in a US city within a budget. Returns up to 10 listings (cheapest first) and shows them to the user with links.",
  params: z.object({
    city: z.string().describe('City and 2-letter state, e.g. "Austin, TX"'),
    budget: z.string().describe('Budget like "300k" (around), "under 400k", "200k-350k" or "1.2m"'),
  }),
  label: (a) => `Searching land in ${a.city} (${a.budget})`,
  async run(a, { ctx, mission }) {
    const result = await searchLand(a.city, a.budget);
    if (!result.ok) return fail(missingSearchInfo(result.reason, result.budget).text);

    const shown = result.listings.slice(0, MAX_LISTINGS);
    const seen = new Set(mission.listings.map((l) => l.url));
    mission.listings.push(...shown.filter((l) => !seen.has(l.url)));
    await saveMission(mission);
    // Also this conversation's memory, so "design a house on X" works after the mission.
    await updateSession(ctx.key, {
      search: { city: result.city, budget: a.budget, lo: result.lo, hi: result.hi },
      listings: shown,
      selected: undefined,
    });
    if (shown.length)
      await ctx.out.reply(
        listingsReply(shown, result.listings.length, result.city, result.lo, result.hi),
      );

    return {
      result: {
        city: result.city,
        priceRange: `${usd(result.lo)} to ${usd(result.hi)}`,
        found: result.listings.length,
        listings: shown.map((l) => ({
          property: street(l),
          priceUsd: l.priceUsd,
          lotSqft: l.lotSqft,
          acres: l.acres,
          zip: l.zipCode,
        })),
        ...(shown.length ? {} : { hint: "Nothing found: try a wider budget or a nearby city." }),
      },
      done: `Searched land in ${result.city} (${a.budget}): ${result.listings.length} found`,
    };
  },
});

const checkSiteTool = defineTool({
  name: "check_site",
  description:
    "Quick site-risk check for up to 10 known properties (no design needed): FEMA flood zone, soil rating for slab foundations, Edwards Aquifer zone and likely utilities. Each check is green (fine), amber (plan for it), red (serious) or unknown.",
  params: z.object({
    properties: nameList("Street addresses of the properties", MAX_LISTINGS),
  }),
  label: (a) =>
    `Checking site risks for ${a.properties.length} ${a.properties.length === 1 ? "property" : "properties"}`,
  async run(a, env) {
    const rows = await Promise.all(
      a.properties.map(async (name) => {
        const found = findListing(env, name);
        if ("error" in found) return { property: name, error: found.error };
        const l = found.listing;
        if (l.latitude === null || l.longitude === null)
          return { property: street(l), error: "This listing has no map location." };
        const site = await runSiteChecks(l);
        const flags = Object.values(site).map((c) => c.flag);
        const worst: Flag = flags.includes("red")
          ? "red"
          : flags.includes("amber")
            ? "amber"
            : flags.includes("unknown")
              ? "unknown"
              : "green";
        return { property: street(l), worst, ...siteSummary(site) };
      }),
    );
    const flagged = rows.filter((r) => "worst" in r && r.worst === "red").length;
    return {
      result: rows,
      done: `Checked site risks for ${rows.length} ${rows.length === 1 ? "property" : "properties"}${flagged ? ` (${flagged} with a red flag)` : ""}`,
    };
  },
});

/** A bare listing for an address the user typed: "12 Oak St, Springfield, IL 62701". */
function typedListing(address: string): Listing | null {
  const parts = address.split(",").map((p) => p.trim());
  const tail = parts.at(-1)?.match(/^([A-Za-z]{2})(?:\s+(\d{5}))?$/);
  if (parts.length < 3 || !tail) return null;
  return {
    address,
    city: parts.at(-2) ?? null,
    state: tail[1].toUpperCase(),
    zipCode: tail[2] ?? null,
    county: null,
    latitude: null,
    longitude: null,
    priceUsd: 0,
    lotSqft: null,
    acres: null,
    url: `address:${address.toLowerCase()}`,
  };
}

const siteRulesTool = defineTool({
  name: "research_site_rules",
  description:
    "Research what can legally be built on a property (1-8 min the first time, then cached): zoning district, setbacks, coverage, height, floor area ratio, parking, which housing types are allowed (single-family, ADU, duplex, townhouse, subdivision, multifamily...), overlays, state housing laws and permits, with official sources. Works anywhere in the US.",
  params: z.object({
    property: z
      .string()
      .describe(
        'Street address of a known property, or a full address "12 Oak St, Springfield, IL 62701"',
      ),
  }),
  label: (a) => `Researching what can be built on ${a.property}`,
  async run(a, env) {
    const found = findListing(env, a.property);
    const listing = "listing" in found ? found.listing : typedListing(a.property);
    if (!listing)
      return fail(
        `${"error" in found ? found.error : ""} Or give the full address: street, city, 2-letter state.`.trim(),
      );
    const result = await researchSiteRules(listing);
    if (result.kind === "failed") return fail(`Site rules research failed: ${result.reason}`);
    const r = result.rules;
    const res = r.research;
    return {
      result: {
        property: street(listing),
        jurisdiction: r.jurisdiction,
        district: `${r.district} (${r.districtName})`,
        setbacksFt: { front: r.frontFt, side: r.interiorSideFt, rear: r.rearFt },
        maxHeightFt: r.maxHeightFt,
        maxStories: r.maxStories ?? null,
        maxBuildingCoveragePct:
          r.maxBuildingCoverage === null ? null : Math.round(r.maxBuildingCoverage * 100),
        maxFar: r.maxFar ?? null,
        minLotSqft: r.minLotSqft,
        maxUnitsPerLot: r.maxUnits,
        parkingPerUnit: r.parkingPerUnit ?? null,
        housingTypes: Object.fromEntries(
          (res?.housingTypes ?? []).map((t) => [
            t.type,
            `${t.allowed}${t.maxUnits ? ` (max ${t.maxUnits})` : ""}${t.conditions ? `: ${t.conditions}` : ""}`,
          ]),
        ),
        overlays: res?.overlays.map((o) => `${o.name}: ${o.effect}`) ?? [],
        stateLaws: res?.stateLaws ?? [],
        warnings: res?.warnings ?? [],
        assumedDefaults: res?.assumed ?? [],
        confidence: res?.confidence ?? "low",
        sources: res?.citations.length ?? 0,
      },
      done: `Researched site rules for ${street(listing)}: ${r.district}, ${res?.confidence ?? "low"} confidence${result.cached ? " (cached)" : ""}`,
    };
  },
});

const listSavedPlansTool = defineTool({
  name: "list_saved_plans",
  description:
    "List the properties that already have a house plan, and which reports each has (estimate, timeline, feasibility).",
  params: z.object({}),
  label: () => "Looking up saved plans",
  async run() {
    const plans = savedPlans()
      .slice(0, 15)
      .map((p) => ({
        property: streetOf(p.listing.address),
        designed: basename(p.dir).slice(0, 10),
        reports: (["estimate", "timeline", "feasibility"] as const).filter((r) =>
          existsSync(join(p.dir, `${r}.json`)),
        ),
      }));
    return { result: { plans }, done: `Found ${plans.length} saved plans` };
  },
});

/** One comparison row from a plan folder's saved reports. */
function comparisonRow(property: string, dir: string): ComparisonRow {
  const f = readJson<Feasibility>(join(dir, "feasibility.json"));
  const e = readJson<{ totalUsd: number; heatedSqft: number; homes: number }>(
    join(dir, "estimate.json"),
  );
  const t = readJson<{ calendarWeeks: number }>(join(dir, "timeline.json"));
  // The design itself says how many homes and how big, even before any report exists.
  const s = readJson<SiteStrategy>(join(dir, "strategy.json"));
  const designSqft = s ? s.houseTypes.reduce((n, h) => n + h.heatedSqft * h.count, 0) : null;
  const listing = listingOfPlan(dir);
  const buildCost = f?.costToBuild ?? e?.totalUsd ?? null;
  const sqft = f?.totalSqft ?? e?.heatedSqft ?? designSqft;
  return {
    property,
    landPrice: listing?.priceUsd ?? null,
    homes: f?.homes ?? e?.homes ?? s?.homes ?? null,
    heatedSqft: sqft,
    buildCost,
    costPerSqft: e && e.heatedSqft ? e.totalUsd / e.heatedSqft : null,
    weeks: t?.calendarWeeks ?? null,
    sellProfit: f?.sell.profit ?? null,
    sellMargin: f?.sell.margin ?? null,
    sellVerdict: f?.sell.verdict ?? null,
    rentYield: f?.rent?.yieldOnCost ?? null,
    rentVerdict: f?.rent?.verdict ?? null,
    recommendation: f?.recommendation.option ?? null,
    siteFlags: f
      ? Object.entries(f.site)
          .filter(([, c]) => c.flag === "red" || c.flag === "amber")
          .map(([k, c]) => `${k} (${c.flag})`)
      : [],
    missing: [
      ...(e ? [] : ["cost estimate"]),
      ...(t ? [] : ["timeline"]),
      ...(f ? [] : ["feasibility report"]),
    ],
  };
}

/** Recommended options first, then properties without a report, then "not recommended"; ties by margin. */
function rank(rows: ComparisonRow[]): ComparisonRow[] {
  const group = (r: ComparisonRow) =>
    r.recommendation === "sell" || r.recommendation === "rent"
      ? 0
      : r.recommendation === null
        ? 1
        : 2;
  return [...rows].sort(
    (a, b) => group(a) - group(b) || (b.sellMargin ?? -Infinity) - (a.sellMargin ?? -Infinity),
  );
}

/**
 * Which property wins on each measure, worked out by code and written as
 * sentences. Small models often get "which number is bigger" wrong when
 * writing ("34 weeks is longer than 54"), so they are given the answers.
 */
function leaders(rows: ComparisonRow[]): string[] {
  const out: string[] = [];
  const best = (
    label: string,
    value: (r: ComparisonRow) => number | null,
    lowerIsBetter: boolean,
    show: (v: number) => string,
  ) => {
    const have = rows.filter((r) => value(r) !== null);
    if (have.length < 2) return;
    const sorted = [...have].sort((a, b) =>
      lowerIsBetter ? value(a)! - value(b)! : value(b)! - value(a)!,
    );
    out.push(
      `${label}: ${sorted[0]!.property} (${sorted.map((r) => `${r.property} ${show(value(r)!)}`).join(" vs ")})`,
    );
  };
  const money = (v: number) => usd(Math.round(v));
  best("Highest profit if sold", (r) => r.sellProfit, false, money);
  best("Highest sale margin", (r) => r.sellMargin, false, pct);
  best("Highest rental yield", (r) => r.rentYield, false, pct);
  best("Lowest build cost", (r) => r.buildCost, true, money);
  best("Lowest cost per sq ft", (r) => r.costPerSqft, true, money);
  best(
    "Fastest build",
    (r) => r.weeks,
    true,
    (v) => `${v} weeks`,
  );
  best("Cheapest land", (r) => r.landPrice, true, money);
  best(
    "Most homes",
    (r) => r.homes,
    false,
    (v) => `${v}`,
  );
  return out;
}

const comparePlansTool = defineTool({
  name: "compare_plans",
  description:
    "Compare 1 to 5 properties that have house plans, from their saved reports: land price, homes, build cost, weeks, profit if sold, rental yield, site flags and recommendation. Shows a ranked table to the user and returns the ranking (best first). Also use it to read one plan's results.",
  params: z.object({
    properties: nameList("Street addresses of the properties to compare", 5),
  }),
  label: (a) => `Comparing ${a.properties.join(", ")}`,
  async run(a, { ctx }) {
    const rows: ComparisonRow[] = [];
    const problems: string[] = [];
    for (const name of a.properties) {
      const match = findPlanByName(name);
      if (match.kind === "found")
        rows.push(comparisonRow(streetOf(match.item.listing.address), match.item.dir));
      else if (match.kind === "ambiguous")
        problems.push(
          `"${name}" matches several plans: ${match.items.map((p) => streetOf(p.listing.address)).join("; ")}`,
        );
      else problems.push(`No house plan for "${name}" (design it first)`);
    }
    if (!rows.length) return fail(problems.join(". "));
    const ranked = rank(rows);
    await ctx.out.reply(comparisonReply(ranked));
    return {
      result: {
        bestOnEachMeasure: rows.length > 1 ? leaders(rows) : undefined,
        rankedBestFirst: ranked.map((r) => ({
          property: r.property,
          recommendation: r.recommendation ?? "no feasibility report",
          landPriceUsd: r.landPrice,
          homes: r.homes,
          heatedSqft: r.heatedSqft,
          buildCostUsd: r.buildCost && Math.round(r.buildCost),
          costPerSqftUsd: r.costPerSqft && Math.round(r.costPerSqft),
          buildWeeks: r.weeks,
          sellProfitUsd: r.sellProfit && Math.round(r.sellProfit),
          sellMargin: r.sellMargin !== null ? pct(r.sellMargin) : null,
          sellVerdict: r.sellVerdict,
          rentYield: r.rentYield !== null ? pct(r.rentYield) : null,
          rentVerdict: r.rentVerdict,
          siteFlags: r.siteFlags,
          missingReports: r.missing,
        })),
        ...(problems.length ? { problems } : {}),
        note: "The user has been shown this table.",
      },
      done: `Compared ${rows.map((r) => r.property).join(", ")}`,
    };
  },
});

const conversationStatusTool = defineTool({
  name: "conversation_status",
  description:
    "What has happened in this Slack conversation and what is running right now: the last land search and listings shown, the selected lot and latest plan, slow jobs waiting or running, and other tasks you are working on here.",
  params: z.object({}),
  label: () => "Checking this conversation",
  async run(_a, { ctx, mission }) {
    const session = getSession(ctx.key);
    const jobs = allJobs()
      .filter((j) => j.key === ctx.key)
      .map((j) => `${j.kind} ${j.subject} (${j.running ? "running" : "waiting in line"})`);
    const tasks = activeMissions(ctx.key)
      .filter((m) => m.id !== mission.id)
      .map((m) => ({
        goal: m.goal,
        state: m.state,
        lastStep: m.steps.at(-1)?.text ?? null,
      }));
    return {
      result: {
        memory: threadSummary(session),
        jobs,
        otherTasks: tasks,
        earlierRequests: (session.history ?? []).map((h) => ({
          request: h.request,
          steps: h.steps ?? [],
          at: h.at,
        })),
      },
    };
  },
});

const listProjectsTool = defineTool({
  name: "list_projects",
  description:
    "List the company's ongoing construction projects with status, days late, current stage and number of open issues, most urgent first.",
  params: z.object({
    filter: z
      .enum(PROJECT_FILTERS)
      .optional()
      .describe(
        '"delayed" = past planned dates, "behind" = delayed or at risk, "attention" = delayed, at risk or on hold, "on-hold" = paused, default "all"',
      ),
  }),
  label: (a) =>
    a.filter && a.filter !== "all" ? `Listing projects (${a.filter})` : "Listing projects",
  async run(a) {
    const projects = listProjects(a.filter ?? "all").map((p) => ({
      project: p.data.name,
      status: statusText(p.status),
      daysLate: p.daysLate,
      stage: p.current.map((s) => stageLabel(s.stage)).join(" + ") || "not started",
      percentComplete: p.percentComplete,
      forecastFinish: p.data.dates.forecastFinish,
      openIssues: p.openIssues.length,
    }));
    return { result: { projects }, done: `Listed ${projects.length} projects` };
  },
});

const projectDetailsTool = defineTool({
  name: "project_details",
  description:
    "Facts about one construction project: status, days late, stage, budget, the causes of delay (with days), open issues with their next steps, and the next inspection.",
  params: z.object({
    project: z
      .string()
      .describe('Project name as the user or list_projects gave it, e.g. "River Bend"'),
  }),
  label: (a) => `Reading project ${a.project}`,
  async run(a) {
    const found = findProject(a.project);
    if (found.kind === "not-found")
      return fail(`No project called "${a.project}". Projects: ${found.names.join("; ")}.`);
    if (found.kind === "ambiguous")
      return fail(
        `"${a.project}" matches ${found.options.map((p) => p.data.name).join(" and ")}. Use the full name.`,
      );
    const p = found.project;
    const d = p.data;
    return {
      result: {
        project: d.name,
        address: d.site.address,
        status: statusText(p.status),
        daysLate: p.daysLate,
        plannedFinish: d.dates.plannedFinish,
        forecastFinish: d.dates.actualFinish ?? d.dates.forecastFinish,
        stage: p.current.map((s) => `${stageLabel(s.stage)} ${s.percent}%`).join(" + "),
        percentComplete: p.percentComplete,
        onHold: d.onHold ?? null,
        budget: {
          contractUsd: d.budget.contractUsd + d.budget.approvedChangeOrdersUsd,
          spentUsd: d.budget.spentUsd,
        },
        projectManager: d.team.projectManager,
        delayCauses: p.delayCauses.map((i) => ({
          issue: i.title,
          category: i.category,
          days: i.impactDays,
          status: i.status,
          ...(i.status === "open" ? { nextStep: i.nextStep, expected: i.expectedResolution } : {}),
        })),
        openIssues: p.openIssues.map((i) => ({
          issue: i.title,
          category: i.category,
          owner: i.owner,
          nextStep: i.nextStep,
        })),
        nextInspection: p.nextInspection ?? null,
      },
      done: `Read project ${d.name}`,
    };
  },
});

const designTool = defineTool({
  name: "design_house",
  slow: "design",
  description:
    "SLOW (~7 min, needs an approved plan). Design houses on a known property: decides how many homes fit under zoning and draws the site and floor plans (shown to the user). Needed before estimate_cost, plan_timeline and feasibility_report.",
  params: z.object({
    property: z.string().describe("Street address of a property from search_land"),
    lot: z
      .string()
      .optional()
      .describe('Lot size if the user gave one: "60x150" (feet) or "7500" (sq ft)'),
  }),
  label: (a) => `Designing ${a.property}`,
  async run(a, env) {
    const found = findListing(env, a.property);
    if ("error" in found) return fail(found.error);
    const listing = found.listing;
    return runSlow(
      env,
      "design",
      (ctx) => queueDesign(ctx, { listing }, a.lot ?? "", AGENT_JOB),
      (r) => ({
        result: {
          property: street(listing),
          plan: STRATEGY_LABEL[r.strategy.strategy],
          housingType: r.strategy.housingType ? HOUSING_TYPE_LABEL[r.strategy.housingType] : null,
          homes: r.strategy.homes,
          houseTypes: r.strategy.houseTypes.map((t) => ({
            name: t.name,
            count: t.count,
            bedrooms: t.bedrooms,
            bathrooms: t.bathrooms,
            heatedSqft: t.heatedSqft,
            stories: t.stories,
          })),
          lot: `${r.lot.widthFt} x ${r.lot.depthFt} ft (${r.lotNote})`,
          zoning: r.zoningFound
            ? `${r.rules.district}, ${r.rules.jurisdiction} (${r.rules.research?.confidence ?? "low"} confidence)`
            : `typical defaults (${r.zoningNote})`,
          drawingComplete: r.complete,
        },
        done: `Designed ${street(listing)}: ${r.strategy.homes} ${r.strategy.homes === 1 ? "home" : "homes"}`,
      }),
    );
  },
});

/** The property name of a finished job's plan folder. */
const planStreet = (dir: string, fallback: string) =>
  streetOf(listingOfPlan(dir)?.address ?? fallback);

const estimateTool = defineTool({
  name: "estimate_cost",
  slow: "estimate",
  description:
    "SLOW (~12 min, needs an approved plan). Material and labor cost estimate for a property's house plan (the PDF is shown to the user). The property must have a plan (design_house).",
  params: z.object({ property: z.string().describe("Street address of a property with a plan") }),
  label: (a) => `Estimating the cost for ${a.property}`,
  async run(a, env) {
    return runSlow(
      env,
      "estimate",
      (ctx) => queueEstimate(ctx, { name: a.property }, AGENT_JOB),
      (r) => {
        const e = r.estimate;
        const name = planStreet(e.planDir, a.property);
        return {
          result: {
            property: name,
            totalUsd: Math.round(e.totalUsd),
            costPerSqftUsd: e.heatedSqft ? Math.round(e.totalUsd / e.heatedSqft) : null,
            materialsUsd: Math.round(e.materialsUsd),
            laborUsd: Math.round(e.laborUsd),
            contingencyUsd: Math.round(e.contingencyUsd),
            homes: e.homes,
            heatedSqft: e.heatedSqft,
          },
          done: `Estimated ${name}: ${usd(Math.round(e.totalUsd))}`,
        };
      },
    );
  },
});

const timelineTool = defineTool({
  name: "plan_timeline",
  slow: "timeline",
  description:
    "SLOW (~6 min, needs an approved plan). Construction schedule for a property's house plan: start and finish dates, weeks, risks (the Gantt chart PDF is shown to the user).",
  params: z.object({
    property: z.string().describe("Street address of a property with a plan"),
    startDate: z.string().optional().describe('Start date "YYYY-MM-DD"; default next Monday'),
  }),
  label: (a) => `Planning the timeline for ${a.property}`,
  async run(a, env) {
    return runSlow(
      env,
      "timeline",
      (ctx) => queueTimeline(ctx, a.startDate ?? "", { name: a.property }, AGENT_JOB),
      (r) => {
        const t = r.timeline;
        const name = planStreet(t.planDir, a.property);
        return {
          result: {
            property: name,
            start: t.startDate,
            finish: t.finishDate,
            workdays: t.workdays,
            calendarWeeks: t.calendarWeeks,
            startNote: r.startNote,
            risks: t.risks.slice(0, 3),
          },
          done: `Planned ${name}: ${t.calendarWeeks} weeks`,
        };
      },
    );
  },
});

const feasibilityTool = defineTool({
  name: "feasibility_report",
  slow: "feasibility",
  description:
    "SLOW (~6 min, plus ~12 min if there is no cost estimate yet, which it then makes itself; needs an approved plan). Is it worth building? Site checks, comparable homes, profit if sold and yield if rented, and a recommendation (the PDF is shown to the user). The property must have a plan (design_house).",
  params: z.object({ property: z.string().describe("Street address of a property with a plan") }),
  label: (a) => `Assessing feasibility of ${a.property}`,
  async run(a, env) {
    return runSlow(
      env,
      "feasibility",
      (ctx) => queueFeasibility(ctx, { name: a.property }, AGENT_JOB),
      (r) => {
        const f = r.feasibility;
        const name = streetOf(f.listing.address);
        return {
          result: {
            property: name,
            recommendation: f.recommendation.option,
            reason: f.recommendation.reason,
            landPriceUsd: f.listing.priceUsd,
            homes: f.homes,
            costToBuildUsd: Math.round(f.costToBuild),
            sell: {
              profitUsd: Math.round(f.sell.profit),
              margin: pct(f.sell.margin),
              verdict: f.sell.verdict,
            },
            rent: f.rent
              ? {
                  yieldOnCost: pct(f.rent.yieldOnCost),
                  cashFlowPerYearUsd: Math.round(f.rent.cashFlowPerYear),
                  verdict: f.rent.verdict,
                }
              : null,
            site: siteSummary(f.site),
            lowConfidence: f.lowConfidence,
            confidenceNotes: f.confidenceNotes,
            risks: f.risks.slice(0, 3),
          },
          done: `Assessed ${name}: ${f.recommendation.option === "neither" ? "not recommended" : `build and ${f.recommendation.option}`}`,
        };
      },
    );
  },
});

const interiorTool = defineTool({
  name: "design_interior",
  slow: "interior",
  description:
    "SLOW (~4 min, needs an approved plan). Furnished 3D top view of every floor of a property's house plan, in a style picked for the house and its price (a PDF of the pictures is shown to the user). The property must have a plan (design_house).",
  params: z.object({ property: z.string().describe("Street address of a property with a plan") }),
  label: (a) => `Designing the 3D interior for ${a.property}`,
  async run(a, env) {
    return runSlow(
      env,
      "interior",
      (ctx) => queueInterior(ctx, { name: a.property }, AGENT_JOB),
      (r) => {
        const name = planStreet(r.planDir, a.property);
        return {
          result: { property: name, floors: r.floors, style: r.style.name, why: r.style.reasoning },
          done: `Designed the 3D interior for ${name}: ${r.style.name}`,
        };
      },
    );
  },
});

// ---------------------------------------------------------------------------
// Control tools: pause the mission until the user answers.
// ---------------------------------------------------------------------------

/** Every tool a plan step may name (the slow ones are what need approval). */
const PLAN_STEP_TOOLS = [
  "search_land",
  "check_site",
  "list_saved_plans",
  "compare_plans",
  "list_projects",
  "project_details",
  "design_house",
  "estimate_cost",
  "plan_timeline",
  "feasibility_report",
  "design_interior",
] as const;

const SLOW_KIND: Partial<Record<(typeof PLAN_STEP_TOOLS)[number], JobKind>> = {
  design_house: "design",
  estimate_cost: "estimate",
  plan_timeline: "timeline",
  feasibility_report: "feasibility",
  design_interior: "interior",
};

const STEP_VERB: Record<(typeof PLAN_STEP_TOOLS)[number], string> = {
  search_land: "Search land",
  check_site: "Check site risks:",
  list_saved_plans: "Look up saved plans",
  compare_plans: "Compare",
  list_projects: "List projects",
  project_details: "Read project",
  design_house: "Design houses on",
  estimate_cost: "Estimate the cost for",
  plan_timeline: "Plan the timeline for",
  feasibility_report: "Feasibility report for",
  design_interior: "Design the 3D interior for",
};

const proposePlanTool = defineTool({
  name: "propose_plan",
  needsUser: true,
  description:
    "Ask the user to approve your plan before running slow tools. List every step you intend to take (slow ones especially). The mission pauses until the user clicks Go or replies with changes.",
  params: z.object({
    summary: z.string().describe("One sentence: what you'll do and why"),
    steps: z
      .array(
        z.object({
          tool: z.enum(PLAN_STEP_TOOLS),
          about: z.string().describe("The property, place or project the step is about"),
        }),
      )
      .min(1)
      .max(15),
  }),
  label: () => "Proposing a plan",
  async run(a, { ctx, mission }) {
    const counts: JobCounts = {};
    for (const s of a.steps) {
      const kind = SLOW_KIND[s.tool];
      if (kind) counts[kind] = (counts[kind] ?? 0) + 1;
    }
    const slowSteps = Object.values(counts).reduce((n, c) => n + c, 0);
    if (!slowSteps)
      return fail(
        "This plan has no slow steps, so it doesn't need approval. Just run the quick tools.",
      );
    if ((counts.design ?? 0) > MAX_DESIGNS_PER_PLAN || slowSteps > MAX_SLOW_STEPS_PER_PLAN)
      return fail(
        `Plan too big: at most ${MAX_DESIGNS_PER_PLAN} designs and ${MAX_SLOW_STEPS_PER_PLAN} slow steps per plan. Narrow it down first (e.g. check_site, then pick the best lots).`,
      );

    // A feasibility report also makes the cost estimate if the plan has none
    // (and no estimate step for it comes first), which adds ~12 minutes.
    const lines: PlanLine[] = a.steps.map((s) => {
      const kind = SLOW_KIND[s.tool];
      let minutes = kind ? MINUTES[kind] : undefined;
      if (kind === "feasibility") {
        const plan = findPlanByName(s.about);
        const hasEstimate =
          plan.kind === "found" && existsSync(join(plan.item.dir, "estimate.json"));
        const estimateFirst = a.steps.some(
          (o) => o.tool === "estimate_cost" && o.about.toLowerCase() === s.about.toLowerCase(),
        );
        if (!hasEstimate && !estimateFirst) minutes = MINUTES.feasibility + MINUTES.estimate;
      }
      return { text: `${STEP_VERB[s.tool]} ${s.about}`, minutes };
    });
    const minutes = lines.reduce((n, l) => n + (l.minutes ?? 0), 0) || 1;

    // Posted before the mission waits, so a failed post can't leave it waiting on nothing.
    await ctx.out.reply(planReply(mission, a.summary, lines, minutes));
    mission.state = "waiting-approval";
    mission.pendingPlan = { counts, minutes };
    await saveMission(mission);
    return {
      result:
        "The plan is shown to the user. Stop now; their answer will come as the next message.",
      pause: "approval",
      done: `Waiting for your OK on the plan (~${minutes} min)`,
    };
  },
});

const askUserTool = defineTool({
  name: "ask_user",
  needsUser: true,
  description:
    "Ask the user a question when you can't continue without their input (e.g. no city or budget given). Offer up to 4 short answer options when it helps. The mission pauses until they answer.",
  params: z.object({
    question: z.string(),
    options: z.array(z.string()).max(4).optional(),
  }),
  label: (a) => `Asked: ${a.question}`,
  async run(a, { ctx, mission }) {
    const options = a.options ?? [];
    await ctx.out.reply(questionReply(mission, a.question, options));
    mission.state = "waiting-answer";
    mission.pendingQuestion = { question: a.question, options };
    await saveMission(mission);
    return {
      result:
        "The question is shown to the user. Stop now; their answer will come as the next message.",
      pause: "answer",
      done: `Asked: ${a.question}`,
    };
  },
});

export const TOOLS: AgentTool[] = [
  searchLandTool,
  checkSiteTool,
  siteRulesTool,
  listSavedPlansTool,
  comparePlansTool,
  conversationStatusTool,
  listProjectsTool,
  projectDetailsTool,
  designTool,
  estimateTool,
  timelineTool,
  feasibilityTool,
  interiorTool,
  proposePlanTool,
  askUserTool,
];

/** The tools a mission may use: scheduled missions get only the quick ones. */
export function toolsFor(m: Mission): AgentTool[] {
  return m.unattended ? TOOLS.filter((t) => !t.slow && !t.needsUser) : TOOLS;
}
