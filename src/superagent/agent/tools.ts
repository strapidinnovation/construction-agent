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
import {
  applyVendorChange,
  findVendor,
  listVendors,
  vendorInUse,
  VENDOR_STATUSES,
  VENDOR_TYPES,
  VendorInput,
  VendorPatch,
  type Vendor,
  type VendorChange,
} from "../../vendors.ts";
import {
  applyOrderChange,
  checkReferences,
  getOrder,
  isFinal,
  listOrders,
  nextStatuses,
  ORDER_STATUSES,
  OrderInput,
  OrderPatch,
  orderTotal,
  orderView,
  orderViews,
  refusal,
  type Order,
  type OrderChange,
  type OrderItem,
  type OrderView,
} from "../../orders.ts";
import {
  applyPaymentChange,
  creationRefusal,
  getPayment,
  listPayments,
  PAYMENT_KINDS,
  PAYMENT_STATES,
  PaymentInput,
  PaymentPatch,
  paymentSummary,
  paymentView,
  paymentViews,
  refusal as paymentRefusal,
  type Payment,
  type PaymentChange,
  type PaymentView,
} from "../../payments.ts";
import {
  DOCUMENT_KINDS,
  OUTPUT_DIR,
  projectDocuments,
  type ProjectDocument,
} from "../../projectDocuments.ts";
import { getSession, isWebKey, threadSummary, updateSession } from "../sessions.ts";
import { searchLand } from "../skills/search.ts";
import {
  findProject,
  listProjects,
  PROJECT_FILTERS,
  STAGES,
  stageLabel,
  statusText,
  type Project,
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
  /** Only offered in web chats (src/web/), not in Slack. */
  webOnly?: boolean;
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
  webOnly?: boolean;
  label: (args: z.infer<S>) => string;
  run: (args: z.infer<S>, env: ToolEnv) => Promise<ToolOutcome>;
}): AgentTool {
  return {
    name: def.name,
    description: def.description,
    params: def.params,
    slow: def.slow,
    needsUser: def.needsUser,
    webOnly: def.webOnly,
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

// ---------------------------------------------------------------------------
// Project documents: the PDFs made for a project (see projectDocuments.ts).
// ---------------------------------------------------------------------------

const documentBrief = (d: ProjectDocument) => ({
  document: d.path,
  title: d.title,
  kind: d.kind,
  made: d.createdAt.slice(0, 10),
  postedInProjectChat: d.sources.includes("chat"),
});

const listProjectDocumentsTool = defineTool({
  name: "list_project_documents",
  description:
    "List the PDFs made for a construction project (site and floor plans, cost estimates, timelines, feasibility reports, interior views), newest first. Use share_project_documents to post them.",
  params: z.object({ project: z.string().describe("Project name") }),
  label: (a) => `Listing documents for ${a.project}`,
  async run(a) {
    const found = projectOr(a.project);
    if ("error" in found) return fail(found.error);
    const docs = projectDocuments(found.project);
    return {
      result: { project: found.project.data.name, documents: docs.map(documentBrief) },
      done: `Found ${docs.length} documents for ${found.project.data.name}`,
    };
  },
});

const shareProjectDocumentsTool = defineTool({
  name: "share_project_documents",
  description:
    "Post a project's PDFs in this conversation so the user can open them. Name them by `document` from list_project_documents, or by kind to post the newest of each kind.",
  params: z.object({
    project: z.string().describe("Project name"),
    documents: z
      .array(z.string())
      .optional()
      .describe("The `document` values from list_project_documents"),
    kinds: z
      .array(z.enum(DOCUMENT_KINDS))
      .optional()
      .describe("Post the newest document of each of these kinds"),
  }),
  label: (a) => `Sharing documents for ${a.project}`,
  async run(a, { ctx }) {
    const found = projectOr(a.project);
    if ("error" in found) return fail(found.error);
    const name = found.project.data.name;
    const all = projectDocuments(found.project);
    if (!all.length) return fail(`${name} has no documents yet.`);
    const unknown = (a.documents ?? []).filter((p) => !all.some((d) => d.path === p));
    if (unknown.length)
      return fail(`Not documents of ${name}: ${unknown.join(", ")}. Call list_project_documents.`);
    const picked = [
      ...all.filter((d) => a.documents?.includes(d.path)),
      ...(a.kinds ?? []).flatMap((k) => all.find((d) => d.kind === k) ?? []),
    ].filter((d, i, list) => list.findIndex((x) => x.path === d.path) === i);
    if (!picked.length)
      return fail(
        `Nothing to share: name documents or kinds ${name} has (${[...new Set(all.map((d) => d.kind))].join(", ")}).`,
      );
    await ctx.out.upload(
      picked.map((d) => ({
        path: join(OUTPUT_DIR, d.path),
        title: `${d.title} (${d.createdAt.slice(0, 10)})`,
      })),
      `Documents for *${name}*`,
    );
    return {
      result: { shared: picked.map(documentBrief), note: "The user can see and open these now." },
      done: `Shared ${picked.length} document${picked.length === 1 ? "" : "s"} for ${name}`,
    };
  },
});

// ---------------------------------------------------------------------------
// Vendors (web chat only). Reading is quick. A change is never made by the
// tool: it shows the change with Yes / No buttons and pauses, and code makes
// it only when the user says yes (settlePendingChange, called from agent.ts).
// ---------------------------------------------------------------------------

const CONFIRM_YES = "Yes, save it";
const CONFIRM_NO = "No, don't";
/** A typed reply that means yes and nothing else ("yes but…" is not a yes). */
const TYPED_YES =
  /^\s*(yes|y|yep|yeah|sure|ok|okay|confirm(ed)?|do it|go( ahead)?|save( it)?)[\s,.!]*(please|thanks?)?[\s.!]*$/i;

const vendorBrief = (v: Vendor) => ({
  vendor: v.name,
  type: v.type,
  trade: v.trade,
  stages: v.stages.map(stageLabel),
  status: v.status,
  rating: v.rating,
  insuranceExpires: v.insuranceExpires,
  contact: [v.contact.name, v.contact.phone].filter(Boolean).join(", ") || null,
});

function vendorOr(query: string): { vendor: Vendor } | { error: string } {
  const found = findVendor(query);
  if (found.kind === "found") return { vendor: found.vendor };
  if (found.kind === "ambiguous")
    return {
      error: `"${query}" matches ${found.options.map((v) => v.name).join(" and ")}. Use the full name.`,
    };
  return { error: `No vendor called "${query}". Vendors: ${found.names.join("; ")}.` };
}

/** The vendor fields as the model sends them (flat; contact fields have their own names). */
const vendorFields = {
  name: z.string().describe("Company name"),
  type: z.enum(VENDOR_TYPES),
  trade: z.string().describe('What they do, e.g. "Roofing" or "Windows & exterior doors"'),
  stages: z.array(z.enum(STAGES)).describe("The construction stages they can work on"),
  contactName: z.string().nullable(),
  contactPhone: z.string().nullable(),
  contactEmail: z.string().nullable(),
  serviceArea: z.string().nullable().describe('Where they work, e.g. "Austin metro"'),
  licenseNumber: z.string().nullable(),
  insuranceExpires: z.string().nullable().describe("YYYY-MM-DD"),
  rating: z.number().nullable().describe("The builder's rating, 1 to 5"),
  status: z.enum(VENDOR_STATUSES),
  notes: z.string(),
};
type FlatVendor = Partial<{ [K in keyof typeof vendorFields]: z.infer<(typeof vendorFields)[K]> }>;

/** Flat fields to the store's shape, leaving out what wasn't given. Checked by the store's schemas after. */
function vendorShape(a: FlatVendor): Record<string, unknown> {
  const { contactName, contactPhone, contactEmail, ...rest } = a;
  const given = (o: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
  const contact = given({ name: contactName, phone: contactPhone, email: contactEmail });
  return { ...given(rest), ...(Object.keys(contact).length ? { contact } : {}) };
}

const FIELD_LABEL: Record<string, string> = {
  name: "Name",
  type: "Type",
  trade: "Trade",
  stages: "Stages",
  serviceArea: "Service area",
  licenseNumber: "License",
  insuranceExpires: "Insurance expires",
  rating: "Rating",
  status: "Status",
  notes: "Notes",
  "contact.name": "Contact",
  "contact.phone": "Phone",
  "contact.email": "Email",
};

const show = (key: string, v: unknown): string =>
  v === null || v === undefined || v === ""
    ? "none"
    : key === "stages"
      ? (v as (typeof STAGES)[number][]).map(stageLabel).join(", ")
      : String(v);

/** The fields of a vendor shape, flattened ("contact.phone"), in a fixed order. */
function flatEntries(shape: Record<string, unknown>): [string, unknown][] {
  const { contact, ...rest } = shape as { contact?: Record<string, unknown> };
  return [
    ...Object.entries(rest),
    ...Object.entries(contact ?? {}).map(([k, v]): [string, unknown] => [`contact.${k}`, v]),
  ];
}

const sameName = (name: string, exceptId?: string) =>
  listVendors().find((v) => v.id !== exceptId && v.name.toLowerCase() === name.toLowerCase());

/** Show the change with Yes / No buttons and pause the mission until the user answers. */
async function askToConfirm(
  { ctx, mission }: ToolEnv,
  change: PendingChange,
  text: string,
  done: string,
): Promise<ToolOutcome> {
  const options = [CONFIRM_YES, CONFIRM_NO];
  await ctx.out.reply(questionReply(mission, `${text}\n\nShall I save this?`, options));
  mission.state = "waiting-answer";
  mission.pendingQuestion = { question: text, options };
  mission.pendingChange = change;
  await saveMission(mission);
  return {
    result:
      "The change is shown to the user to confirm. Stop now: nothing is saved until they say yes, and the outcome will come as the next message.",
    pause: "answer",
    done,
  };
}

/**
 * The user answered a vendor, order or payment change: make it if they said
 * yes, else drop it. Returns the message for the model and the checklist line.
 */
export async function settlePendingChange(
  m: Mission,
  answer: string,
): Promise<{ prompt: string; step: string }> {
  const change = m.pendingChange;
  m.pendingChange = undefined;
  if (!change)
    return { prompt: `The user answered: "${answer}"`, step: `You answered: "${answer}"` };
  const what = "entity" in change ? change.entity : "vendor";
  if (answer !== CONFIRM_YES && !TYPED_YES.test(answer))
    return {
      prompt: `The user did not confirm the ${what} change, so nothing was saved. They said: "${answer}". If they asked for something different, propose that change instead; otherwise tell them nothing was changed.`,
      step: "Not confirmed: nothing saved",
    };
  const did = { create: "added", update: "updated", delete: "deleted" }[change.action];
  const saved = (detail: unknown) =>
    change.action === "delete" ? "" : ` Saved: ${JSON.stringify(detail)}`;
  try {
    if ("entity" in change && change.entity === "payment") {
      const p = await applyPaymentChange(change);
      return {
        prompt: `The user confirmed. Payment ${p.id} was ${did}.${saved(paymentBrief(paymentView(p)))}`,
        step: `Payment ${did}: ${p.id} ${p.title}`,
      };
    }
    if ("entity" in change) {
      const o = await applyOrderChange(change);
      return {
        prompt: `The user confirmed. Order ${o.id} was ${did}.${saved(orderDetail(orderView(o)))}`,
        step: `Order ${did}: ${o.id} ${o.title}`,
      };
    }
    const v = await applyVendorChange(change);
    return {
      prompt: `The user confirmed. Vendor ${v.name} was ${did}.${change.action === "delete" ? "" : ` Saved: ${JSON.stringify(vendorBrief(v))}`}`,
      step: `Vendor ${did}: ${v.name}`,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return {
      prompt: `The user confirmed, but the change failed, so nothing was saved: ${error}`,
      step: `${what[0]!.toUpperCase()}${what.slice(1)} change failed`,
    };
  }
}

const listVendorsTool = defineTool({
  name: "list_vendors",
  webOnly: true,
  description:
    "List the builder's vendors (subcontractors, suppliers, consultants) with trade, the construction stages they can work on, status, rating, insurance expiry and contact. Filter by type, status, stage or text.",
  params: z.object({
    type: z.enum(VENDOR_TYPES).optional(),
    status: z.enum(VENDOR_STATUSES).optional(),
    stage: z.enum(STAGES).optional().describe("Only vendors who can work on this stage"),
    query: z.string().optional().describe("Text in the name, trade or contact name"),
  }),
  label: (a) =>
    `Listing vendors${a.stage ? ` for ${stageLabel(a.stage)}` : ""}${a.query ? ` matching "${a.query}"` : ""}`,
  async run(a) {
    const vendors = listVendors({ type: a.type, status: a.status, stage: a.stage, q: a.query });
    return {
      result: { vendors: vendors.map(vendorBrief) },
      done: `Listed ${vendors.length} vendors`,
    };
  },
});

const vendorDetailsTool = defineTool({
  name: "vendor_details",
  webOnly: true,
  description:
    "Everything about one vendor: trade, stages, contact, service area, license, insurance expiry, rating, status and notes.",
  params: z.object({ vendor: z.string().describe('Vendor name, e.g. "Capitol Concrete"') }),
  label: (a) => `Reading vendor ${a.vendor}`,
  async run(a) {
    const found = vendorOr(a.vendor);
    if ("error" in found) return fail(found.error);
    const v = found.vendor;
    return {
      result: { ...v, stages: v.stages.map(stageLabel) },
      done: `Read vendor ${v.name}`,
    };
  },
});

const createVendorTool = defineTool({
  name: "create_vendor",
  webOnly: true,
  needsUser: true,
  description:
    "Add a new vendor. Needs name, type, trade and at least one stage (ask_user for any that are missing). The user is shown the vendor and must confirm before it is saved.",
  params: z.object({
    ...vendorFields,
    contactName: vendorFields.contactName.optional(),
    contactPhone: vendorFields.contactPhone.optional(),
    contactEmail: vendorFields.contactEmail.optional(),
    serviceArea: vendorFields.serviceArea.optional(),
    licenseNumber: vendorFields.licenseNumber.optional(),
    insuranceExpires: vendorFields.insuranceExpires.optional(),
    rating: vendorFields.rating.optional(),
    status: vendorFields.status.optional(),
    notes: vendorFields.notes.optional(),
  }),
  label: (a) => `Adding vendor ${a.name}`,
  async run(a, env) {
    const parsed = VendorInput.safeParse(vendorShape(a));
    if (!parsed.success) return fail(`Invalid vendor: ${z.prettifyError(parsed.error)}`);
    const input = parsed.data;
    const taken = sameName(input.name);
    if (taken)
      return fail(`A vendor named "${taken.name}" already exists. Use update_vendor to change it.`);
    const details = flatEntries(vendorShape(a))
      .filter(([k]) => !["name", "type", "trade", "stages"].includes(k))
      .map(([k, v]) => `• ${FIELD_LABEL[k] ?? k}: ${show(k, v)}`);
    const text = [
      `Add a new vendor: *${input.name}* (${input.type}, ${input.trade})`,
      `• Stages: ${show("stages", input.stages)}`,
      ...details,
    ].join("\n");
    return askToConfirm(env, { action: "create", input }, text, `Asked to add ${input.name}`);
  },
});

const updateVendorTool = defineTool({
  name: "update_vendor",
  webOnly: true,
  needsUser: true,
  description:
    "Change an existing vendor: give only the fields to change (null clears an optional field). The user is shown the changes and must confirm before they are saved.",
  params: z.object({
    vendor: z.string().describe("The vendor's current name"),
    ...(Object.fromEntries(Object.entries(vendorFields).map(([k, s]) => [k, s.optional()])) as {
      [K in keyof typeof vendorFields]: z.ZodOptional<(typeof vendorFields)[K]>;
    }),
  }),
  label: (a) => `Updating vendor ${a.vendor}`,
  async run({ vendor: name, ...fields }, env) {
    const found = vendorOr(name);
    if ("error" in found) return fail(found.error);
    const v = found.vendor;
    const parsed = VendorPatch.safeParse(vendorShape(fields));
    if (!parsed.success) return fail(`Invalid change: ${z.prettifyError(parsed.error)}`);
    const patch = parsed.data;
    if (patch.name && sameName(patch.name, v.id))
      return fail(`Another vendor is already called "${patch.name}".`);
    const current = Object.fromEntries(flatEntries(v));
    const changes = flatEntries(patch).filter(
      ([k, next]) => JSON.stringify(current[k] ?? null) !== JSON.stringify(next ?? null),
    );
    if (!changes.length) return fail(`Nothing would change: ${v.name} already has those values.`);
    const text = [
      `Change *${v.name}*:`,
      ...changes.map(
        ([k, next]) => `• ${FIELD_LABEL[k] ?? k}: ${show(k, current[k])} → ${show(k, next)}`,
      ),
    ].join("\n");
    return askToConfirm(
      env,
      { action: "update", id: v.id, patch },
      text,
      `Asked to update ${v.name}`,
    );
  },
});

const deleteVendorTool = defineTool({
  name: "delete_vendor",
  webOnly: true,
  needsUser: true,
  description:
    'Delete a vendor. The user must confirm first. Prefer update_vendor with status "inactive" when the user only wants to stop using them.',
  params: z.object({ vendor: z.string().describe("The vendor's name") }),
  label: (a) => `Deleting vendor ${a.vendor}`,
  async run(a, env) {
    const found = vendorOr(a.vendor);
    if ("error" in found) return fail(found.error);
    const v = found.vendor;
    const inUse = vendorInUse(v.id);
    if (inUse) return fail(`${inUse} Offer that instead.`);
    return askToConfirm(
      env,
      { action: "delete", id: v.id },
      `Delete *${v.name}* (${v.trade})? This can't be undone.`,
      `Asked to delete ${v.name}`,
    );
  },
});

// ---------------------------------------------------------------------------
// Orders (web chat only): what the builder orders from a vendor for a project.
// Same rules as vendors: reading is quick, changes are confirmed first.
// ---------------------------------------------------------------------------

type PendingChange = VendorChange | OrderChange | PaymentChange;

function projectOr(query: string): { project: Project } | { error: string } {
  const found = findProject(query);
  if (found.kind === "found") return { project: found.project };
  if (found.kind === "ambiguous")
    return {
      error: `"${query}" matches ${found.options.map((p) => p.data.name).join(" and ")}. Use the full name.`,
    };
  return { error: `No project called "${query}". Projects: ${found.names.join("; ")}.` };
}

function orderOr(id: string): { order: Order } | { error: string } {
  const order = getOrder(id);
  return order ? { order } : { error: `No order "${id}". Orders are numbered like PO-1012.` };
}

const orderBrief = (o: OrderView) => ({
  order: o.id,
  title: o.title,
  project: o.project?.name ?? o.projectId,
  vendor: o.vendor?.name ?? o.vendorId,
  stage: o.stage && stageLabel(o.stage),
  status: o.status,
  since: o.history.at(-1)?.at.slice(0, 10),
  totalUsd: o.totalUsd,
  neededBy: o.neededBy,
  overdue: o.overdue,
});

const orderDetail = (o: OrderView) => ({
  ...orderBrief(o),
  items: o.items.map((i) => ({ ...i, lineUsd: i.quantity * i.unitPriceUsd })),
  notes: o.notes || null,
  history: o.history.map((h) => `${h.status} ${h.at.slice(0, 10)}`),
  canBecome: nextStatuses(o.status),
  canDelete: o.status === "created",
});

const itemParam = z.object({
  description: z.string(),
  quantity: z.number(),
  unit: z.string().describe('e.g. "ea", "cu yd", "sq ft", "lot"'),
  unitPriceUsd: z.number(),
});

const ORDER_FIELD_LABEL: Record<string, string> = {
  status: "Status",
  title: "Title",
  stage: "Stage",
  neededBy: "Needed by",
  notes: "Notes",
};

const itemLine = (i: OrderItem) =>
  `${i.quantity.toLocaleString("en-US")} ${i.unit} ${i.description} × ${usd(i.unitPriceUsd)} = ${usd(i.quantity * i.unitPriceUsd)}`;

const listOrdersTool = defineTool({
  name: "list_orders",
  webOnly: true,
  description:
    "List orders (what the builder ordered from a vendor for a project) with status, total, needed-by date and whether they are overdue. Filter by project, vendor, status or text; openOnly leaves out fulfilled and cancelled ones.",
  params: z.object({
    project: z.string().optional().describe("Project name"),
    vendor: z.string().optional().describe("Vendor name"),
    status: z.enum(ORDER_STATUSES).optional(),
    openOnly: z.boolean().optional(),
    query: z.string().optional().describe("Text in the order number, title or items"),
  }),
  label: (a) =>
    `Listing orders${a.project ? ` for ${a.project}` : ""}${a.vendor ? ` from ${a.vendor}` : ""}`,
  async run(a) {
    const project = a.project ? projectOr(a.project) : undefined;
    if (project && "error" in project) return fail(project.error);
    const vendor = a.vendor ? vendorOr(a.vendor) : undefined;
    if (vendor && "error" in vendor) return fail(vendor.error);
    const orders = orderViews(
      listOrders({
        projectId: project?.project.data.id,
        vendorId: vendor?.vendor.id,
        status: a.status,
        open: a.openOnly,
        q: a.query,
      }),
    );
    return {
      result: {
        orders: orders.map(orderBrief),
        totalUsd: orders.reduce((sum, o) => sum + o.totalUsd, 0),
      },
      done: `Listed ${orders.length} orders`,
    };
  },
});

const orderDetailsTool = defineTool({
  name: "order_details",
  webOnly: true,
  description:
    "Everything about one order: line items, total, status history, notes, and which statuses it can move to.",
  params: z.object({ order: z.string().describe('Order number, e.g. "PO-1012"') }),
  label: (a) => `Reading order ${a.order}`,
  async run(a) {
    const found = orderOr(a.order);
    if ("error" in found) return fail(found.error);
    return { result: orderDetail(orderView(found.order)), done: `Read order ${found.order.id}` };
  },
});

const createOrderTool = defineTool({
  name: "create_order",
  webOnly: true,
  needsUser: true,
  description:
    'Create an order from a project to a vendor. Needs the project, vendor, a title and at least one line item with quantity, unit and unit price (ask_user for any that are missing; never guess prices). It starts as "created". The user is shown the order and must confirm before it is saved.',
  params: z.object({
    project: z.string().describe("Project name"),
    vendor: z.string().describe("Vendor name"),
    title: z.string().describe('Short title, e.g. "Roof trusses for H2 and H3"'),
    items: z.array(itemParam),
    stage: z.enum(STAGES).optional().describe("The construction stage it is for"),
    neededBy: z.string().optional().describe("YYYY-MM-DD"),
    notes: z.string().optional(),
  }),
  label: (a) => `Creating an order from ${a.vendor}`,
  async run(a, env) {
    const project = projectOr(a.project);
    if ("error" in project) return fail(project.error);
    const vendor = vendorOr(a.vendor);
    if ("error" in vendor) return fail(vendor.error);
    const parsed = OrderInput.safeParse({
      projectId: project.project.data.id,
      vendorId: vendor.vendor.id,
      title: a.title,
      items: a.items,
      stage: a.stage,
      neededBy: a.neededBy,
      notes: a.notes,
    });
    if (!parsed.success) return fail(`Invalid order: ${z.prettifyError(parsed.error)}`);
    const input = parsed.data;
    try {
      checkReferences(input.projectId, input.vendorId);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
    const text = [
      `New order for *${project.project.data.name}* from *${vendor.vendor.name}*: ${input.title}`,
      ...input.items.map((i) => `• ${itemLine(i)}`),
      `• *Total: ${usd(orderTotal(input.items))}*`,
      ...(input.stage ? [`• Stage: ${stageLabel(input.stage)}`] : []),
      ...(input.neededBy ? [`• Needed by: ${input.neededBy}`] : []),
      ...(input.notes ? [`• Notes: ${input.notes}`] : []),
    ].join("\n");
    return askToConfirm(
      env,
      { entity: "order", action: "create", input },
      text,
      `Asked to create an order from ${vendor.vendor.name}`,
    );
  },
});

const updateOrderTool = defineTool({
  name: "update_order",
  webOnly: true,
  needsUser: true,
  description:
    "Change an order: its status (forward only: created, sent, confirmed, fulfilled; or cancelled until fulfilled), title, stage, needed-by date, notes, or its line items (items replaces all of them). Give only what changes; null clears stage or neededBy. Fulfilled and cancelled orders can only change notes. The user is shown the change and must confirm before it is saved.",
  params: z.object({
    order: z.string().describe('Order number, e.g. "PO-1012"'),
    status: z.enum(ORDER_STATUSES).optional(),
    title: z.string().optional(),
    stage: z.enum(STAGES).nullable().optional(),
    neededBy: z.string().nullable().optional().describe("YYYY-MM-DD"),
    notes: z.string().optional(),
    items: z.array(itemParam).optional().describe("The full new list of line items"),
  }),
  label: (a) => `Updating order ${a.order}`,
  async run({ order: id, ...fields }, env) {
    const found = orderOr(id);
    if ("error" in found) return fail(found.error);
    const o = found.order;
    const given = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
    const parsed = OrderPatch.safeParse(given);
    if (!parsed.success) return fail(`Invalid change: ${z.prettifyError(parsed.error)}`);
    const patch = Object.fromEntries(
      Object.entries(parsed.data).filter(
        ([k, v]) => JSON.stringify(o[k as keyof typeof o] ?? null) !== JSON.stringify(v ?? null),
      ),
    ) as OrderPatch;
    if (!Object.keys(patch).length)
      return fail(`Nothing would change: ${o.id} already has those values.`);
    const refused = refusal(o, patch);
    if (refused) return fail(refused);
    const show = (k: string, v: unknown) =>
      v === null || v === undefined || v === ""
        ? "none"
        : k === "stage"
          ? stageLabel(v as (typeof STAGES)[number])
          : String(v);
    const lines = Object.entries(patch).flatMap(([k, v]) =>
      k === "items"
        ? [
            `• Items (total ${usd(orderTotal(o.items))} → ${usd(orderTotal(v as OrderItem[]))}):`,
            ...(v as OrderItem[]).map((i) => `   ${itemLine(i)}`),
          ]
        : [`• ${ORDER_FIELD_LABEL[k] ?? k}: ${show(k, o[k as keyof typeof o])} → ${show(k, v)}`],
    );
    return askToConfirm(
      env,
      { entity: "order", action: "update", id: o.id, patch },
      [`Change order *${o.id}* (${o.title}):`, ...lines].join("\n"),
      `Asked to update ${o.id}`,
    );
  },
});

const deleteOrderTool = defineTool({
  name: "delete_order",
  webOnly: true,
  needsUser: true,
  description:
    'Delete an order that was never sent (status "created"). Once sent, use update_order with status "cancelled" instead. The user must confirm first.',
  params: z.object({ order: z.string().describe('Order number, e.g. "PO-1012"') }),
  label: (a) => `Deleting order ${a.order}`,
  async run(a, env) {
    const found = orderOr(a.order);
    if ("error" in found) return fail(found.error);
    const o = found.order;
    if (o.status !== "created")
      return fail(
        `${o.id} is ${o.status}, so it can't be deleted.${isFinal(o.status) ? "" : ' Offer to set its status to "cancelled" instead.'}`,
      );
    const view = orderView(o);
    return askToConfirm(
      env,
      { entity: "order", action: "delete", id: o.id },
      `Delete order *${o.id}* (${o.title}, ${usd(view.totalUsd)} from ${view.vendor?.name ?? o.vendorId})? This can't be undone.`,
      `Asked to delete ${o.id}`,
    );
  },
});

// ---------------------------------------------------------------------------
// Payments (web chat only): client collections and payments to vendors.
// Same rules as orders: reading is quick, changes are confirmed first.
// ---------------------------------------------------------------------------

function paymentOr(id: string): { payment: Payment } | { error: string } {
  const payment = getPayment(id);
  return payment
    ? { payment }
    : { error: `No payment "${id}". Payments are numbered like PMT-1012.` };
}

const KIND_LABEL = { collection: "client collection", "vendor-payment": "vendor payment" };

const paymentBrief = (p: PaymentView) => ({
  payment: p.id,
  kind: KIND_LABEL[p.kind],
  title: p.title,
  project: p.project?.name ?? p.projectId,
  ...(p.vendorId ? { vendor: p.vendor?.name ?? p.vendorId } : {}),
  ...(p.orderId ? { order: p.orderId } : {}),
  ...(p.stage ? { stage: stageLabel(p.stage) } : {}),
  amountUsd: p.amountUsd,
  state: p.state,
  proposedDate: p.proposedDate,
  actualDate: p.actualDate,
  ...(p.state === "overdue" ? { daysOverdue: p.daysLate } : {}),
  ...(p.state === "completed" && p.daysLate > 0 ? { paidDaysLate: p.daysLate } : {}),
  ...(p.notes ? { notes: p.notes } : {}),
});

/** Overdue first (most overdue first), then pending (soonest first), then completed (latest first). */
function byUrgency(a: PaymentView, b: PaymentView): number {
  const rank = { overdue: 0, pending: 1, completed: 2 };
  if (a.state !== b.state) return rank[a.state] - rank[b.state];
  return a.state === "completed"
    ? (b.actualDate ?? "").localeCompare(a.actualDate ?? "")
    : a.proposedDate.localeCompare(b.proposedDate);
}

const MAX_PAYMENTS = 40;

/** In the order the changes are shown. */
const PAYMENT_FIELD_LABEL: Record<string, string> = {
  status: "Status",
  actualDate: "Actual date",
  amountUsd: "Amount",
  proposedDate: "Proposed date",
  title: "Title",
  stage: "Stage",
  orderId: "Order",
  notes: "Notes",
};

const showPaymentField = (k: string, v: unknown) =>
  v === null || v === undefined || v === ""
    ? "none"
    : k === "stage"
      ? stageLabel(v as (typeof STAGES)[number])
      : k === "amountUsd"
        ? usd(v as number)
        : String(v);

const listPaymentsTool = defineTool({
  name: "list_payments",
  webOnly: true,
  description:
    'Client collections (money the client pays the builder: deposit, milestone draws, change orders) and vendor payments (money the builder pays vendors), each with an amount, a proposed date and, once paid, an actual date. State is "pending" (not due yet), "overdue" (pending past its proposed date) or "completed". Returns pending, overdue and completed totals for each kind and the net cash (collected minus paid), plus the matching records, overdue first. Filter by project, vendor, kind, state or text.',
  params: z.object({
    project: z.string().optional().describe("Project name"),
    vendor: z.string().optional().describe("Vendor name (vendor payments only)"),
    kind: z.enum(PAYMENT_KINDS).optional(),
    state: z.enum(PAYMENT_STATES).optional(),
    query: z.string().optional().describe("Text in the payment number, title or notes"),
  }),
  label: (a) =>
    `Listing ${a.kind === "collection" ? "client collections" : a.kind === "vendor-payment" ? "vendor payments" : "payments"}${a.project ? ` for ${a.project}` : ""}${a.vendor ? ` to ${a.vendor}` : ""}`,
  async run(a) {
    const project = a.project ? projectOr(a.project) : undefined;
    if (project && "error" in project) return fail(project.error);
    const vendor = a.vendor ? vendorOr(a.vendor) : undefined;
    if (vendor && "error" in vendor) return fail(vendor.error);
    const filter = {
      projectId: project?.project.data.id,
      vendorId: vendor?.vendor.id,
      kind: a.kind,
      q: a.query,
    };
    const matching = paymentViews(listPayments({ ...filter, state: a.state })).sort(byUrgency);
    return {
      result: {
        summary: paymentSummary(listPayments(filter)),
        payments: matching.slice(0, MAX_PAYMENTS).map(paymentBrief),
        ...(matching.length > MAX_PAYMENTS
          ? {
              more: `${matching.length - MAX_PAYMENTS} more not shown; filter by project, kind or state to see them.`,
            }
          : {}),
      },
      done: `Listed ${matching.length} payments`,
    };
  },
});

const createPaymentTool = defineTool({
  name: "create_payment",
  webOnly: true,
  needsUser: true,
  description:
    'Add a client collection (kind "collection": money due from the project\'s client) or a vendor payment (kind "vendor-payment": needs the vendor, or one of its orders on this project). Needs the project, a title, the amount and the proposed date (ask_user for any that are missing; never guess amounts). To record something already paid, give status "completed" and the actual date (today if left out). The user is shown the record and must confirm before it is saved.',
  params: z.object({
    kind: z.enum(PAYMENT_KINDS),
    project: z.string().describe("Project name"),
    vendor: z.string().optional().describe("Vendor name (vendor payments only)"),
    order: z.string().optional().describe('An order it pays for, e.g. "PO-1012"'),
    title: z.string().describe('Short title, e.g. "Draw 3: Framing complete (20%)"'),
    amountUsd: z.number(),
    proposedDate: z.string().describe("When it is due, YYYY-MM-DD"),
    stage: z.enum(STAGES).optional().describe("The construction stage it is for"),
    status: z.enum(["pending", "completed"]).optional(),
    actualDate: z.string().optional().describe("When it was paid, YYYY-MM-DD"),
    notes: z.string().optional(),
  }),
  label: (a) =>
    `Adding a ${KIND_LABEL[a.kind]}${a.vendor ? ` to ${a.vendor}` : ""} for ${a.project}`,
  async run(a, env) {
    const project = projectOr(a.project);
    if ("error" in project) return fail(project.error);
    const order = a.order ? getOrder(a.order) : undefined;
    if (a.order && !order) return fail(`No order "${a.order}". Orders are numbered like PO-1012.`);
    const vendor = a.vendor ? vendorOr(a.vendor) : undefined;
    if (vendor && "error" in vendor) return fail(vendor.error);
    const parsed = PaymentInput.safeParse({
      kind: a.kind,
      projectId: project.project.data.id,
      vendorId: vendor?.vendor.id ?? (a.kind === "vendor-payment" ? order?.vendorId : undefined),
      orderId: order?.id,
      title: a.title,
      amountUsd: a.amountUsd,
      proposedDate: a.proposedDate,
      stage: a.stage,
      status: a.status,
      actualDate: a.actualDate,
      notes: a.notes,
    });
    if (!parsed.success) return fail(`Invalid payment: ${z.prettifyError(parsed.error)}`);
    const input = parsed.data;
    const refused = creationRefusal(input);
    if (refused) return fail(refused);
    const who =
      input.kind === "collection"
        ? `from ${project.project.data.client}`
        : `to *${listVendors().find((v) => v.id === input.vendorId)?.name ?? input.vendorId}*`;
    const text = [
      `New ${KIND_LABEL[input.kind]} for *${project.project.data.name}* ${who}: ${input.title}`,
      `• *Amount: ${usd(input.amountUsd)}*`,
      `• Proposed date: ${input.proposedDate}`,
      ...(input.status === "completed"
        ? [`• Paid on: ${input.actualDate ?? `${new Date().toISOString().slice(0, 10)} (today)`}`]
        : []),
      ...(input.orderId ? [`• For order: ${input.orderId}`] : []),
      ...(input.stage ? [`• Stage: ${stageLabel(input.stage)}`] : []),
      ...(input.notes ? [`• Notes: ${input.notes}`] : []),
    ].join("\n");
    return askToConfirm(
      env,
      { entity: "payment", action: "create", input },
      text,
      `Asked to add a ${KIND_LABEL[input.kind]}`,
    );
  },
});

const updatePaymentTool = defineTool({
  name: "update_payment",
  webOnly: true,
  needsUser: true,
  description:
    'Change a payment. To record that it was paid (or received), set status "completed" and the actualDate (today if left out); status "pending" puts it back (e.g. a bounced check) and clears the actual date. Can also change the title, amount, proposed date (reschedule), stage, order or notes. Give only what changes; null clears stage or order. The user is shown the change and must confirm before it is saved.',
  params: z.object({
    payment: z.string().describe('Payment number, e.g. "PMT-1012"'),
    status: z.enum(["pending", "completed"]).optional(),
    actualDate: z.string().nullable().optional().describe("YYYY-MM-DD"),
    proposedDate: z.string().optional().describe("YYYY-MM-DD"),
    amountUsd: z.number().optional(),
    title: z.string().optional(),
    stage: z.enum(STAGES).nullable().optional(),
    order: z.string().nullable().optional().describe('e.g. "PO-1012"'),
    notes: z.string().optional(),
  }),
  label: (a) => `Updating payment ${a.payment}`,
  async run({ payment: id, order, ...fields }, env) {
    const found = paymentOr(id);
    if ("error" in found) return fail(found.error);
    const p = found.payment;
    const given = Object.fromEntries(
      Object.entries({
        ...fields,
        orderId: order === undefined ? undefined : order && (getOrder(order)?.id ?? order),
      }).filter(([, v]) => v !== undefined),
    );
    const parsed = PaymentPatch.safeParse(given);
    if (!parsed.success) return fail(`Invalid change: ${z.prettifyError(parsed.error)}`);
    const patch = Object.fromEntries(
      Object.entries(parsed.data).filter(
        ([k, v]) => JSON.stringify(p[k as keyof Payment] ?? null) !== JSON.stringify(v ?? null),
      ),
    ) as PaymentPatch;
    if (!Object.keys(patch).length)
      return fail(`Nothing would change: ${p.id} already has those values.`);
    const refused = paymentRefusal(p, patch);
    if (refused) return fail(refused);
    const fullPatch: PaymentPatch = { ...patch };
    if (patch.status === "completed" && !patch.actualDate && !p.actualDate)
      fullPatch.actualDate = new Date().toISOString().slice(0, 10);
    if (patch.status === "pending" && p.actualDate) fullPatch.actualDate = null;
    const lines = Object.keys(PAYMENT_FIELD_LABEL)
      .filter((k) => k in fullPatch)
      .map(
        (k) =>
          `• ${PAYMENT_FIELD_LABEL[k]}: ${showPaymentField(k, p[k as keyof Payment])} → ${showPaymentField(k, fullPatch[k as keyof PaymentPatch])}`,
      );
    const view = paymentView(p);
    return askToConfirm(
      env,
      { entity: "payment", action: "update", id: p.id, patch: fullPatch },
      [
        `Change payment *${p.id}* (${p.title}, ${usd(p.amountUsd)}, ${view.vendor ? `to ${view.vendor.name}` : "from the client"}):`,
        ...lines,
      ].join("\n"),
      `Asked to update ${p.id}`,
    );
  },
});

const deletePaymentTool = defineTool({
  name: "delete_payment",
  webOnly: true,
  needsUser: true,
  description:
    'Delete a pending payment (e.g. one added by mistake). Completed payments stay on the books: if one never happened, update_payment it back to "pending" first. The user must confirm first.',
  params: z.object({ payment: z.string().describe('Payment number, e.g. "PMT-1012"') }),
  label: (a) => `Deleting payment ${a.payment}`,
  async run(a, env) {
    const found = paymentOr(a.payment);
    if ("error" in found) return fail(found.error);
    const p = found.payment;
    if (p.status === "completed")
      return fail(
        `${p.id} is completed, so it can't be deleted. If it never happened, offer to set it back to pending first.`,
      );
    const view = paymentView(p);
    return askToConfirm(
      env,
      { entity: "payment", action: "delete", id: p.id },
      `Delete payment *${p.id}* (${p.title}, ${usd(p.amountUsd)} ${view.vendor ? `to ${view.vendor.name}` : "from the client"}, due ${p.proposedDate})? This can't be undone.`,
      `Asked to delete ${p.id}`,
    );
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
  listProjectDocumentsTool,
  shareProjectDocumentsTool,
  listVendorsTool,
  vendorDetailsTool,
  createVendorTool,
  updateVendorTool,
  deleteVendorTool,
  listOrdersTool,
  orderDetailsTool,
  createOrderTool,
  updateOrderTool,
  deleteOrderTool,
  listPaymentsTool,
  createPaymentTool,
  updatePaymentTool,
  deletePaymentTool,
  designTool,
  estimateTool,
  timelineTool,
  feasibilityTool,
  interiorTool,
  proposePlanTool,
  askUserTool,
];

/**
 * The tools a mission may use: scheduled missions get only the quick ones,
 * and vendor tools are only for web chats.
 */
export function toolsFor(m: Mission): AgentTool[] {
  return TOOLS.filter(
    (t) => (!t.webOnly || isWebKey(m.key)) && (!m.unattended || (!t.slow && !t.needsUser)),
  );
}
