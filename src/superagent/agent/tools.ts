/**
 * The agent's tools: SuperAgent's skills, described so the planner model can
 * choose between them.
 *
 * Each tool has:
 *   - a name and a description the model reads to decide when to use it,
 *   - an input schema (zod), which the Agent SDK sends to the model. Every call
 *     is checked against it in code; a bad call gets a clear error back, so the
 *     model can correct itself instead of the bot crashing,
 *   - `label`: the line shown in the chat's checklist while it runs,
 *   - `run`: does the work and returns a SHORT result for the model. Short
 *     matters: a small model gets confused by long reports, so tools return
 *     the key facts and post the full reports/files to the chat themselves.
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
import type { Estimate } from "../../agents/costEstimator.ts";
import type { Feasibility } from "../../agents/feasibility.ts";
import type { Listing } from "../../agents/landSearch.ts";
import { runSiteChecks, type Flag, type SiteChecks } from "../../agents/siteChecks.ts";
import { HOUSING_TYPE_LABEL, STRATEGY_LABEL, type SiteStrategy } from "../../agents/sitePlanner.ts";
import { researchSiteRules } from "../../agents/siteRules.ts";
import type { Timeline } from "../../agents/timelinePlanner.ts";
import {
  CHANGE_ORDER_KINDS,
  CHANGE_ORDER_STATUSES,
  changeOrderSummary,
  changeOrderView,
  createChangeOrder,
  decideChangeOrder,
  getChangeOrder,
  linesTotal,
  listChangeOrders,
  type ChangeOrderChange,
  type ChangeOrderInput,
  type ChangeOrderStatus,
  type ChangeOrderView,
} from "../../changeOrders.ts";
import { usd } from "../../listingFormat.ts";
import { isCurrentPlan, markRevision } from "../../revisions.ts";
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
  foldersFor,
  OUTPUT_DIR,
  projectDocuments,
  type ProjectDocument,
} from "../../projectDocuments.ts";
import { getSession, threadSummary, updateSession } from "../sessions.ts";
import { searchLand } from "../skills/search.ts";
import { draftProject } from "../skills/projectFromPlan.ts";
import {
  currentDesign,
  editHouseTypes,
  matchTrades,
  tradeTotals,
  type RevisionResult,
} from "../skills/revision.ts";
import {
  applyProjectChange,
  findProject,
  listProjects,
  PROJECT_FILTERS,
  ProjectPatch,
  STAGES,
  stageLabel,
  statusText,
  type Project,
  type ProjectChange,
} from "../skills/projects.ts";
import {
  listingsReply,
  MAX_LISTINGS,
  missingSearchInfo,
  projectDraftText,
  street,
} from "../replies.ts";
import {
  queueDesign,
  queueEstimate,
  queueFeasibility,
  queueInterior,
  queueRevision,
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
} from "./missionReplies.ts";
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
  revision: 22,
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
  label: (args: z.infer<S>) => string;
  run: (args: z.infer<S>, env: ToolEnv) => Promise<ToolOutcome>;
}): AgentTool {
  return {
    name: def.name,
    description: def.description,
    params: def.params,
    slow: def.slow,
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
 * status message, so it doesn't overwrite the mission's checklist),
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
    "What has happened in this conversation and what is running right now: the last land search and listings shown, the selected lot and latest plan, slow jobs waiting or running, and other tasks you are working on here.",
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
    "List the PDFs made for a construction project (site and floor plans, cost estimates, timelines, feasibility reports, interior views), newest first. Use share_project_documents to post them, and read_report to answer questions about what is in them.",
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
      `Documents for **${name}**`,
    );
    return {
      result: { shared: picked.map(documentBrief), note: "The user can see and open these now." },
      done: `Shared ${picked.length} document${picked.length === 1 ? "" : "s"} for ${name}`,
    };
  },
});

// ---------------------------------------------------------------------------
// Reading inside the reports: the JSON each job saves next to its PDF, so the
// answers use exact numbers. One section at a time keeps results short.
// ---------------------------------------------------------------------------

const REPORTS = ["plan", "estimate", "timeline", "feasibility"] as const;
type ReportKind = (typeof REPORTS)[number];
const REPORT_FILE: Record<ReportKind, string> = {
  plan: "strategy.json",
  estimate: "estimate.json",
  timeline: "timeline.json",
  feasibility: "feasibility.json",
};
const REPORT_SECTIONS = ["overview", "trade", "tasks", "comps"] as const;
const SECTIONS_OF: Record<ReportKind, (typeof REPORT_SECTIONS)[number][]> = {
  plan: ["overview"],
  estimate: ["overview", "trade"],
  timeline: ["overview", "tasks"],
  feasibility: ["overview", "comps"],
};
const MAX_REPORT_ROWS = 40;

/** Money to whole dollars and ratios to 3 decimals, so the model reads clean numbers. */
function tidy(v: unknown): unknown {
  if (typeof v === "number")
    return Math.abs(v) >= 100 ? Math.round(v) : Math.round(v * 1000) / 1000;
  if (Array.isArray(v)) return v.map(tidy);
  if (v && typeof v === "object")
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, tidy(x)]));
  return v;
}

/** Whether `text` contains every word of `query` ("roof shingles" matches "Roofing: asphalt shingles"). */
function matches(text: string, query: string): boolean {
  const have = text.toLowerCase();
  return query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1)
    .every((w) => have.includes(w.replace(/(ing|s)$/, "")));
}

/**
 * The newest folder with this report for a project or designed property. A
 * project is tried first; if it has no such report, a designed property of
 * that name is.
 */
function reportFolder(
  name: string,
  report: ReportKind,
): { dir: string; subject: string } | { error: string } {
  const candidates: { address: string; subject: string }[] = [];
  const problems: string[] = [];
  const project = findProject(name);
  if (project.kind === "found")
    candidates.push({
      address: project.project.data.site.address,
      subject: project.project.data.name,
    });
  else if (project.kind === "ambiguous")
    problems.push(`projects ${project.options.map((p) => p.data.name).join(" and ")}`);
  const plan = findPlanByName(name);
  if (plan.kind === "found")
    candidates.push({
      address: plan.item.listing.address,
      subject: streetOf(plan.item.listing.address),
    });
  else if (plan.kind === "ambiguous")
    problems.push(`properties ${plan.items.map((p) => streetOf(p.listing.address)).join(" and ")}`);
  for (const c of candidates) {
    const dir = foldersFor(c.address).find(
      (d) => existsSync(join(d, REPORT_FILE[report])) && isCurrentPlan(d),
    );
    if (dir) return { dir, subject: c.subject };
  }
  if (candidates.length)
    return {
      error: `${candidates.map((c) => c.subject).join(" / ")} has no ${report} report yet. You can make one (it is a slow job).`,
    };
  if (problems.length)
    return { error: `"${name}" matches ${problems.join("; ")}. Use the full name.` };
  return {
    error: `No project or designed property called "${name}". Use list_projects or list_saved_plans.`,
  };
}

function planOverview(dir: string) {
  const s = readJson<SiteStrategy>(join(dir, "strategy.json"))!;
  const inputs = readJson<{ lot?: unknown; rules?: Record<string, unknown> }>(
    join(dir, "inputs.json"),
  );
  const r = inputs?.rules ?? {};
  return {
    strategy: STRATEGY_LABEL[s.strategy],
    homes: s.homes,
    layout: s.layout,
    reasoning: s.reasoning,
    houseTypes: s.houseTypes,
    approvalsNeeded: s.approvals,
    lot: inputs?.lot ?? null,
    zoning: Object.fromEntries(
      [
        "jurisdiction",
        "district",
        "districtName",
        "minLotSqft",
        "maxUnits",
        "maxHeightFt",
        "frontFt",
        "streetSideFt",
        "interiorSideFt",
        "rearFt",
        "maxBuildingCoverage",
        "maxImperviousCover",
        "notes",
      ]
        .filter((k) => r[k] !== undefined)
        .map((k) => [k, r[k]]),
    ),
  };
}

function estimateOverview(e: Estimate) {
  const byTrade = new Map<string, { materialsUsd: number; laborUsd: number }>();
  for (const h of e.houses)
    for (const t of h.trades) {
      const sum = byTrade.get(t.name) ?? { materialsUsd: 0, laborUsd: 0 };
      sum.materialsUsd += t.materialsUsd * h.count;
      sum.laborUsd += t.laborUsd * h.count;
      byTrade.set(t.name, sum);
    }
  return {
    location: e.location,
    homes: e.homes,
    heatedSqft: e.heatedSqft,
    totalUsd: e.totalUsd,
    costPerSqftUsd: e.totalUsd / Math.max(1, e.heatedSqft),
    materialsUsd: e.materialsUsd,
    laborUsd: e.laborUsd,
    contingencyUsd: e.contingencyUsd,
    houseTypes: e.houses.map((h) => ({
      type: h.type,
      name: h.name,
      count: h.count,
      perHomeUsd: h.materialsUsd + h.laborUsd,
      heatedSqft: h.spec.heatedSqft,
      stories: h.spec.stories,
      bedrooms: h.spec.bedrooms,
      bathrooms: h.spec.bathrooms,
      roof: `${h.spec.roofType}, ${h.spec.roofPitch}, ${h.spec.roofAreaSqft} sq ft`,
      notEstimated: h.failedTrades,
    })),
    tradesForAllHomes: [...byTrade]
      .map(([trade, t]) => ({ trade, ...t, totalUsd: t.materialsUsd + t.laborUsd }))
      .sort((a, b) => b.totalUsd - a.totalUsd),
    note: 'Trade totals are before the contingency. Use section "trade" with match for a trade\'s line items.',
  };
}

function estimateTrade(e: Estimate, match: string) {
  const trades = e.houses.flatMap((h) =>
    h.trades
      .filter((t) => matches(t.name, match))
      .map((t) => ({
        houseType: e.houses.length > 1 ? `${h.type} "${h.name}" x${h.count}` : undefined,
        trade: t.name,
        perHome: { materialsUsd: t.materialsUsd, laborUsd: t.laborUsd },
        materials: t.materials.slice(0, MAX_REPORT_ROWS),
        labor: t.labor.slice(0, MAX_REPORT_ROWS),
      })),
  );
  if (trades.length) return { trades };
  // No trade of that name: look for the item in every trade's lines instead.
  const lines = e.houses.flatMap((h) =>
    h.trades.flatMap((t) => [
      ...t.materials
        .filter((m) => matches(`${m.item} ${m.specification}`, match))
        .map((m) => ({ trade: t.name, ...m })),
      ...t.labor.filter((l) => matches(l.task, match)).map((l) => ({ trade: t.name, ...l })),
    ]),
  );
  return lines.length
    ? { matchingLines: lines.slice(0, MAX_REPORT_ROWS), note: "Amounts are per home." }
    : {
        error: `No trade or line matches "${match}". Trades: ${[...new Set(e.houses.flatMap((h) => h.trades.map((t) => t.name)))].join("; ")}.`,
      };
}

function timelineOverview(t: Timeline) {
  const phases = new Map<string, { start: string; end: string; tasks: number }>();
  for (const x of t.tasks) {
    const p = phases.get(x.phase);
    phases.set(x.phase, {
      start: !p || x.start < p.start ? x.start : p.start,
      end: !p || x.end > p.end ? x.end : p.end,
      tasks: (p?.tasks ?? 0) + 1,
    });
  }
  const byDate = (kind: string) =>
    t.tasks
      .filter((x) => x.kind === kind)
      .sort((a, b) => a.end.localeCompare(b.end))
      .map((x) => ({ date: x.end, name: x.name, phase: x.phase }));
  return {
    location: t.location,
    homes: t.homes,
    start: t.startDate,
    finish: t.finishDate,
    workdays: t.workdays,
    calendarWeeks: t.calendarWeeks,
    phases: [...phases].map(([phase, p]) => ({ phase, ...p })),
    milestones: byDate("milestone").slice(0, MAX_REPORT_ROWS),
    inspections: byDate("inspection").slice(0, MAX_REPORT_ROWS),
    waits: byDate("wait").slice(0, 15),
    tasksOnCriticalPath: t.tasks.filter((x) => x.critical && x.workdays > 0).length,
    risks: t.risks,
    assumptions: t.assumptions,
    note: 'Use section "tasks" (with match, from, to) for individual tasks.',
  };
}

function timelineTasks(t: Timeline, a: { match?: string; from?: string; to?: string }) {
  const tasks = t.tasks
    .filter((x) => !a.match || matches(`${x.phase} ${x.name} ${x.crew} ${x.kind}`, a.match))
    .filter((x) => (!a.from || x.end >= a.from) && (!a.to || x.start <= a.to))
    .sort((x, y) => x.start.localeCompare(y.start));
  return {
    found: tasks.length,
    tasks: tasks.slice(0, MAX_REPORT_ROWS).map((x) => ({
      id: x.id,
      phase: x.phase,
      name: x.name,
      kind: x.kind,
      start: x.start,
      end: x.end,
      workdays: x.workdays,
      crew: x.crew,
      critical: x.critical,
      dependsOn: x.dependsOn,
      ...(x.notes ? { notes: x.notes } : {}),
    })),
    ...(tasks.length > MAX_REPORT_ROWS
      ? { note: `Only the first ${MAX_REPORT_ROWS}; narrow it down.` }
      : {}),
  };
}

function feasibilityOverview(f: Feasibility) {
  return {
    property: f.listing.address,
    landPriceUsd: f.listing.priceUsd,
    recommendation: f.recommendation,
    summary: f.summary,
    homes: f.homes,
    totalSqft: f.totalSqft,
    buildMonths: f.buildMonths,
    costs: f.costs,
    costToBuildUsd: f.costToBuild,
    constructionLoanUsd: f.constructionLoan,
    sell: f.sell,
    rent: f.rent,
    valuePerHome: f.houses.map((h) => ({
      type: h.type,
      name: h.name,
      count: h.count,
      saleValueUsd: h.valuePerHome,
      monthlyRentUsd: h.rentPerHome,
      saleComps: h.sale.comps.length,
      salePerSqftUsd: h.sale.medianPerSqft,
    })),
    site: f.site,
    risks: f.risks,
    nextSteps: f.nextSteps,
    lowConfidence: f.lowConfidence ? f.confidenceNotes : false,
    note: 'Sold comparables use last asking prices (Texas does not disclose sale prices). Use section "comps" for the comparable homes.',
  };
}

function feasibilityComps(f: Feasibility) {
  const brief = (c: Feasibility["houses"][number]["sale"]["comps"][number]) => ({
    address: c.address,
    price: c.price,
    priceKind: c.priceKind,
    sqft: c.sqft,
    beds: c.beds,
    yearBuilt: c.yearBuilt,
    date: c.date,
  });
  return {
    houseTypes: f.houses.map((h) => ({
      type: h.type,
      name: h.name,
      sale: {
        radiusMiles: h.sale.radiusMiles,
        medianPerSqftUsd: h.sale.medianPerSqft,
        comps: h.sale.comps.slice(0, 20).map(brief),
      },
      rent: h.rent
        ? {
            radiusMiles: h.rent.radiusMiles,
            medianPerSqftUsd: h.rent.medianPerSqft,
            comps: h.rent.comps.slice(0, 20).map(brief),
          }
        : null,
    })),
  };
}

const readReportTool = defineTool({
  name: "read_report",
  description:
    "Read inside a report made for a project or designed property, to answer questions about its contents: the house plan (layout, house types, zoning rules, approvals), cost estimate (trade totals; a trade's materials and labor line items), timeline (phases, milestones, inspections, risks; individual tasks by name or date) or feasibility report (costs, sale and rent numbers, what-ifs, site checks, risks, next steps; comparable homes). Exact numbers from the saved report. Read only the section you need.",
  params: z.object({
    name: z
      .string()
      .describe(
        'A project name or a designed property\'s street, e.g. "River Bend" or "8446 Corral Ln"',
      ),
    report: z.enum(REPORTS),
    section: z
      .enum(REPORT_SECTIONS)
      .optional()
      .describe(
        'Default "overview". estimate: "trade" (needs match: a trade or item, e.g. "roofing", "windows"). timeline: "tasks" (match and/or from, to). feasibility: "comps" (comparable homes).',
      ),
    match: z.string().optional().describe("Words to look for (trade, item, task or phase)"),
    from: z
      .string()
      .optional()
      .describe("timeline tasks: only those running on or after YYYY-MM-DD"),
    to: z
      .string()
      .optional()
      .describe("timeline tasks: only those running on or before YYYY-MM-DD"),
  }),
  label: (a) => `Reading the ${a.report} for ${a.name}`,
  async run(a) {
    const section = a.section ?? "overview";
    if (!SECTIONS_OF[a.report].includes(section))
      return fail(`The ${a.report} report has sections: ${SECTIONS_OF[a.report].join(", ")}.`);
    if (section === "trade" && !a.match)
      return fail('Section "trade" needs match, e.g. "roofing".');
    const found = reportFolder(a.name, a.report);
    if ("error" in found) return fail(found.error);
    const file = join(found.dir, REPORT_FILE[a.report]);
    const made = basename(found.dir).slice(0, 10);
    let content: unknown;
    if (a.report === "plan") content = planOverview(found.dir);
    else if (a.report === "estimate") {
      const e = readJson<Estimate>(file)!;
      content = section === "trade" ? estimateTrade(e, a.match!) : estimateOverview(e);
    } else if (a.report === "timeline") {
      const t = readJson<Timeline>(file)!;
      content = section === "tasks" ? timelineTasks(t, a) : timelineOverview(t);
    } else {
      const f = readJson<Feasibility>(file)!;
      content = section === "comps" ? feasibilityComps(f) : feasibilityOverview(f);
    }
    if (content && typeof content === "object" && "error" in content)
      return fail(String((content as { error: string }).error));
    return {
      result: tidy({
        subject: found.subject,
        report: a.report,
        made,
        section,
        ...(content as object),
      }),
      done: `Read the ${a.report} for ${found.subject}${section === "overview" ? "" : ` (${a.match ?? section})`}`,
    };
  },
});

// ---------------------------------------------------------------------------
// Vendors. Reading is quick. A change is never made by the
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

/** Show the change with Yes / No buttons (or other answers) and pause the mission until the user answers. */
async function askToConfirm(
  { ctx, mission }: ToolEnv,
  change: PendingChange,
  text: string,
  done: string,
  ask = { question: "Shall I save this?", options: [CONFIRM_YES, CONFIRM_NO] },
): Promise<ToolOutcome> {
  const { options } = ask;
  await ctx.out.reply(questionReply(mission, `${text}\n\n${ask.question}`, options));
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
 * The user answered a vendor, order, payment or project change: make it if they said
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
  const what = "entity" in change ? change.entity.replace("-", " ") : "vendor";
  if ("entity" in change && change.entity === "change-order" && change.action === "create")
    return settleNewChangeOrder(change.input, answer);
  if (answer !== CONFIRM_YES && !TYPED_YES.test(answer))
    return {
      prompt: `The user did not confirm the ${what} change, so nothing was saved. They said: "${answer}". If they asked for something different, propose that change instead; otherwise tell them nothing was changed.`,
      step: "Not confirmed: nothing saved",
    };
  const did = { create: "added", update: "updated", delete: "deleted", decide: "decided" }[
    change.action
  ];
  const saved = (detail: unknown) =>
    change.action === "delete" ? "" : ` Saved: ${JSON.stringify(detail)}`;
  try {
    if ("entity" in change && change.entity === "change-order") {
      if (change.action !== "decide") throw new Error("Unexpected change order change.");
      const co = await decideChangeOrder(change.id, change.status);
      return {
        prompt: `The user confirmed. Change order ${co.id} is now ${co.status}.${co.status === "approved" ? ` Its ${signedUsd(co.amountUsd)} was added to the project's approved change orders and the forecast finish moved by ${co.daysAdded} days.${co.revision ? " Its revised design is now the project's current design." : ""}` : ""} Its PDF is on the project's Documents tab.`,
        step: `Change order ${co.status}: ${co.id} ${co.title}`,
      };
    }
    if ("entity" in change && change.entity === "project") {
      const p = await applyProjectChange(change);
      return {
        prompt: `The user confirmed. Project ${p.data.name} was ${did}. Saved: ${JSON.stringify({ project: p.data.name, id: p.data.id, status: statusText(p.status), client: p.data.client, team: p.data.team, contractUsd: p.data.budget.contractUsd })}. The user can open it as [${p.data.name}](/projects/${p.data.id}); its plan and reports are on its Documents tab.`,
        step: `Project ${did}: ${p.data.name}`,
      };
    }
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
      .map(([k, v]) => `- ${FIELD_LABEL[k] ?? k}: ${show(k, v)}`);
    const text = [
      `Add a new vendor: **${input.name}** (${input.type}, ${input.trade})`,
      `- Stages: ${show("stages", input.stages)}`,
      ...details,
    ].join("\n");
    return askToConfirm(env, { action: "create", input }, text, `Asked to add ${input.name}`);
  },
});

const updateVendorTool = defineTool({
  name: "update_vendor",
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
      `Change **${v.name}**:`,
      ...changes.map(
        ([k, next]) => `- ${FIELD_LABEL[k] ?? k}: ${show(k, current[k])} → ${show(k, next)}`,
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
      `Delete **${v.name}** (${v.trade})? This can't be undone.`,
      `Asked to delete ${v.name}`,
    );
  },
});

// ---------------------------------------------------------------------------
// Orders (web chat only): what the builder orders from a vendor for a project.
// Same rules as vendors: reading is quick, changes are confirmed first.
// ---------------------------------------------------------------------------

type PendingChange = VendorChange | OrderChange | PaymentChange | ProjectChange | ChangeOrderChange;

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
      `New order for **${project.project.data.name}** from **${vendor.vendor.name}**: ${input.title}`,
      ...input.items.map((i) => `- ${itemLine(i)}`),
      `- **Total: ${usd(orderTotal(input.items))}**`,
      ...(input.stage ? [`- Stage: ${stageLabel(input.stage)}`] : []),
      ...(input.neededBy ? [`- Needed by: ${input.neededBy}`] : []),
      ...(input.notes ? [`- Notes: ${input.notes}`] : []),
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
            `- Items (total ${usd(orderTotal(o.items))} → ${usd(orderTotal(v as OrderItem[]))}):`,
            ...(v as OrderItem[]).map((i) => `   ${itemLine(i)}`),
          ]
        : [`- ${ORDER_FIELD_LABEL[k] ?? k}: ${show(k, o[k as keyof typeof o])} → ${show(k, v)}`],
    );
    return askToConfirm(
      env,
      { entity: "order", action: "update", id: o.id, patch },
      [`Change order **${o.id}** (${o.title}):`, ...lines].join("\n"),
      `Asked to update ${o.id}`,
    );
  },
});

const deleteOrderTool = defineTool({
  name: "delete_order",
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
      `Delete order **${o.id}** (${o.title}, ${usd(view.totalUsd)} from ${view.vendor?.name ?? o.vendorId})? This can't be undone.`,
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
        : `to **${listVendors().find((v) => v.id === input.vendorId)?.name ?? input.vendorId}**`;
    const text = [
      `New ${KIND_LABEL[input.kind]} for **${project.project.data.name}** ${who}: ${input.title}`,
      `- **Amount: ${usd(input.amountUsd)}**`,
      `- Proposed date: ${input.proposedDate}`,
      ...(input.status === "completed"
        ? [`- Paid on: ${input.actualDate ?? `${new Date().toISOString().slice(0, 10)} (today)`}`]
        : []),
      ...(input.orderId ? [`- For order: ${input.orderId}`] : []),
      ...(input.stage ? [`- Stage: ${stageLabel(input.stage)}`] : []),
      ...(input.notes ? [`- Notes: ${input.notes}`] : []),
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
          `- ${PAYMENT_FIELD_LABEL[k]}: ${showPaymentField(k, p[k as keyof Payment])} → ${showPaymentField(k, fullPatch[k as keyof PaymentPatch])}`,
      );
    const view = paymentView(p);
    return askToConfirm(
      env,
      { entity: "payment", action: "update", id: p.id, patch: fullPatch },
      [
        `Change payment **${p.id}** (${p.title}, ${usd(p.amountUsd)}, ${view.vendor ? `to ${view.vendor.name}` : "from the client"}):`,
        ...lines,
      ].join("\n"),
      `Asked to update ${p.id}`,
    );
  },
});

const deletePaymentTool = defineTool({
  name: "delete_payment",
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
      `Delete payment **${p.id}** (${p.title}, ${usd(p.amountUsd)} ${view.vendor ? `to ${view.vendor.name}` : "from the client"}, due ${p.proposedDate})? This can't be undone.`,
      `Asked to delete ${p.id}`,
    );
  },
});

// ---------------------------------------------------------------------------
// Projects from designs. Like the vendor tools, they only propose: the change
// is saved after the user says yes.
// ---------------------------------------------------------------------------

const createProjectTool = defineTool({
  name: "create_project",
  description:
    "Make a designed property a construction project, from its newest plan (with its cost estimate and timeline if made). It starts in planning, with the client and team TBD, and the plan and reports show on the project's Documents tab. Shows the project to the user with Yes / No buttons and pauses; nothing is saved before yes. If a project already exists at that address, it says which.",
  params: z.object({
    property: z
      .string()
      .describe('Street address of a property with a plan, e.g. "8446 Corral Ln"'),
  }),
  label: (a) => `Proposing a project for ${a.property}`,
  async run(a, env) {
    const match = findPlanByName(a.property);
    if (match.kind === "ambiguous")
      return fail(
        `"${a.property}" matches ${match.items.map((p) => streetOf(p.listing.address)).join(" and ")}. Use the full street address.`,
      );
    if (match.kind !== "found")
      return fail(
        `No plan for "${a.property}". Design a house there first (design_house), or use list_saved_plans.`,
      );
    const draft = draftProject(match.item.dir);
    if (draft.kind === "error") return fail(draft.error);
    if (draft.kind === "exists")
      return {
        result: {
          alreadyAProject: draft.project.data.name,
          note: "Nothing to create: this property is already that project, and its plan and reports are on the project's Documents tab.",
        },
        done: `${draft.project.data.name} is already the project there`,
      };
    return askToConfirm(
      env,
      { entity: "project", action: "create", input: draft.project },
      projectDraftText(draft.project, draft.from),
      `Asked to create ${draft.project.name}`,
    );
  },
});

const PROJECT_FIELD_LABEL: Record<keyof ProjectPatch, string> = {
  name: "Name",
  client: "Client",
  builder: "Builder",
  projectManager: "Project manager",
  superintendent: "Superintendent",
  description: "Scope",
  contractUsd: "Contract",
};

const updateProjectTool = defineTool({
  name: "update_project",
  description:
    "Change a project's name, client, builder, project manager, superintendent, scope description or contract amount (e.g. filling in what was TBD). Give only the fields that change. Shows the change with Yes / No buttons and pauses; nothing is saved before yes.",
  params: z.object({
    project: z.string().describe("Project name"),
    name: z.string().optional(),
    client: z.string().optional(),
    builder: z.string().optional(),
    projectManager: z.string().optional(),
    superintendent: z.string().optional(),
    description: z.string().optional().describe("What is being built"),
    contractUsd: z.number().optional().describe("The contract amount in dollars"),
  }),
  label: (a) => `Changing project ${a.project}`,
  async run({ project, ...fields }, env) {
    const found = projectOr(project);
    if ("error" in found) return fail(found.error);
    const d = found.project.data;
    const current: Record<keyof ProjectPatch, string | number> = {
      name: d.name,
      client: d.client,
      builder: d.team.builder,
      projectManager: d.team.projectManager,
      superintendent: d.team.superintendent,
      description: d.scope.description,
      contractUsd: d.budget.contractUsd,
    };
    const changed = (Object.keys(PROJECT_FIELD_LABEL) as (keyof ProjectPatch)[]).filter(
      (k) => fields[k] !== undefined && fields[k] !== current[k],
    );
    if (!changed.length)
      return fail("Nothing to change: give at least one field with a new value.");
    const patch = ProjectPatch.safeParse(Object.fromEntries(changed.map((k) => [k, fields[k]])));
    if (!patch.success) return fail(z.prettifyError(patch.error));
    const shown = (k: keyof ProjectPatch, v: string | number) =>
      k === "contractUsd" ? usd(Number(v)) : String(v);
    return askToConfirm(
      env,
      { entity: "project", action: "update", id: d.id, patch: patch.data },
      [
        `Change project **${d.name}**:`,
        ...changed.map(
          (k) => `- ${PROJECT_FIELD_LABEL[k]}: ${shown(k, current[k])} → ${shown(k, fields[k]!)}`,
        ),
      ].join("\n"),
      `Asked to change ${d.name}`,
    );
  },
});

// ---------------------------------------------------------------------------
// Change orders. A small change is priced from the estimate's lines; a design
// change redraws and re-estimates the plan first (a slow job). Either way the
// user answers Approve / Save as pending / Reject before anything is saved.
// ---------------------------------------------------------------------------

const CO_APPROVE = "Approve";
const CO_PENDING = "Save as pending";
const CO_REJECT = "Reject";
const CO_ASK = {
  question: "Approve it now, save it as pending until the client signs, or reject it?",
  options: [CO_APPROVE, CO_PENDING, CO_REJECT],
};

/** The status a typed or clicked answer asks for, or null if it isn't one of the three. */
function changeOrderAnswer(answer: string): ChangeOrderStatus | null {
  if (answer === CO_APPROVE) return "approved";
  if (answer === CO_PENDING) return "pending";
  if (answer === CO_REJECT) return "rejected";
  if (/^\s*(save( it)?( as)? pending|pending|save( it)?|later|wait)\b[\s.!]*$/i.test(answer))
    return "pending";
  if (/^\s*(reject(ed)?|decline(d)?)\b[\s.!]*$/i.test(answer)) return "rejected";
  if (/^\s*(approve(d)?|yes|y|yep|yeah|ok|okay|sure|go ahead|do it)\b[\s.!]*$/i.test(answer))
    return "approved";
  return null;
}

async function settleNewChangeOrder(
  input: ChangeOrderInput,
  answer: string,
): Promise<{ prompt: string; step: string }> {
  const status = changeOrderAnswer(answer);
  if (!status) {
    if (input.revision)
      await markRevision(join(OUTPUT_DIR, input.revision.dir), { status: "discarded" });
    return {
      prompt: `The user didn't approve, save or reject the change order, so nothing was saved${input.revision ? " and the revised design was set aside" : ""}. They said: "${answer}". If they asked for something different (another amount, other days), propose the change order again with that (for a design change, create_change_order can't reuse the revision: run revise_design again only if the design itself must change); otherwise tell them nothing was saved.`,
      step: "Not saved",
    };
  }
  try {
    const co = await createChangeOrder({ ...input, status });
    const effect =
      status === "approved"
        ? ` Its ${signedUsd(co.amountUsd)} was added to the project's approved change orders and the forecast finish moved by ${co.daysAdded} days.${co.revision ? " The revised design is now the project's current design." : ""}`
        : status === "pending"
          ? " It waits for the client: approve or reject it later with decide_change_order."
          : co.revision
            ? " The revised design stays on file but isn't used."
            : "";
    return {
      prompt: `The user chose "${answer}". Change order ${co.id} was saved as ${status}.${effect} Its PDF is on the project's Documents tab (and the Change orders tab).`,
      step: `Change order ${co.id} saved as ${status}`,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return {
      prompt: `The user answered, but saving the change order failed, so nothing was saved: ${error}`,
      step: "Change order failed",
    };
  }
}

const signedUsd = (n: number) => `${n < 0 ? "-" : "+"}${usd(Math.abs(n))}`;
const signedDays = (n: number) => `${n > 0 ? "+" : ""}${n} ${Math.abs(n) === 1 ? "day" : "days"}`;
const shiftDate = (iso: string, days: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/** The proposal shown to the user: the change, its lines, and what it does to the contract and finish. */
function changeOrderText(p: Project, input: ChangeOrderInput, extra: string[] = []): string {
  const d = p.data;
  const contract = d.budget.contractUsd + d.budget.approvedChangeOrdersUsd;
  return [
    `📝 Change order for **${d.name}**: **${input.title}**`,
    "",
    `- Kind: ${input.kind === "design" ? "design change (revised plan and estimate)" : "small change (same design)"}`,
    ...(input.reason ? [`- Reason: ${input.reason}`] : []),
    ...input.lines.map(
      (l) =>
        `- ${l.trade}${l.item ? `, ${l.item}` : ""}: ${usd(l.oldUsd)} → ${usd(l.newUsd)} (${signedUsd(l.newUsd - l.oldUsd)})${l.note ? `. ${l.note}` : ""}`,
    ),
    `- **Amount: ${signedUsd(input.amountUsd)}** (contract ${usd(contract)} → ${usd(contract + input.amountUsd)})`,
    `- Schedule: ${signedDays(input.daysAdded)} (forecast finish ${d.dates.forecastFinish} → ${shiftDate(d.dates.forecastFinish, input.daysAdded)})`,
    ...extra,
  ].join("\n");
}

const changeOrderBrief = (c: ChangeOrderView) => ({
  changeOrder: c.id,
  project: c.project?.name ?? c.projectId,
  kind: c.kind,
  title: c.title,
  ...(c.reason ? { reason: c.reason } : {}),
  status: c.status,
  amountUsd: c.amountUsd,
  daysAdded: c.daysAdded,
  requestedOn: c.requestedOn,
  decidedOn: c.decidedOn,
  lines: c.lines.map((l) => ({
    trade: l.trade,
    ...(l.item ? { item: l.item } : {}),
    oldUsd: l.oldUsd,
    newUsd: l.newUsd,
  })),
  ...(c.revision ? { revisedDesign: c.revision.dir, changes: c.revision.changes } : {}),
});

function openProjectOr(query: string): { project: Project } | { error: string } {
  const found = projectOr(query);
  if ("error" in found) return found;
  if (found.project.status === "completed")
    return { error: `${found.project.data.name} is completed, so it takes no more change orders.` };
  return found;
}

const listChangeOrdersTool = defineTool({
  name: "list_change_orders",
  description:
    'A project\'s change orders (numbered like CO-1003): changes to the scope after the contract, each with an amount, the days it adds and a status ("pending" waits for the client, "approved", "rejected"). Returns pending / approved / rejected totals and the change orders, newest first. Filter by project, status or kind ("small" or "design").',
  params: z.object({
    project: z.string().optional().describe("Project name"),
    status: z.enum(CHANGE_ORDER_STATUSES).optional(),
    kind: z.enum(CHANGE_ORDER_KINDS).optional(),
  }),
  label: (a) => `Listing change orders${a.project ? ` for ${a.project}` : ""}`,
  async run(a) {
    const project = a.project ? projectOr(a.project) : undefined;
    if (project && "error" in project) return fail(project.error);
    const projectId = project?.project.data.id;
    const all = listChangeOrders({ projectId });
    const matching = listChangeOrders({ projectId, status: a.status, kind: a.kind });
    return {
      result: {
        summary: changeOrderSummary(all),
        changeOrders: matching.slice(0, 40).map((c) => changeOrderBrief(changeOrderView(c))),
        ...(project
          ? {
              contract: {
                originalUsd: project.project.data.budget.contractUsd,
                approvedChangeOrdersUsd: project.project.data.budget.approvedChangeOrdersUsd,
              },
            }
          : {}),
      },
      done: `Listed ${matching.length} change orders`,
    };
  },
});

const coLine = z.object({
  trade: z.string().describe('The estimate\'s trade, e.g. "Interior finishes"'),
  item: z.string().optional().describe('The item in it, e.g. "Kitchen countertops"'),
  oldUsd: z.number().min(0).describe("What the estimate has now (0 for something new)"),
  newUsd: z.number().min(0).describe("What it costs with the change (0 if removed)"),
  note: z.string().optional(),
});

const createChangeOrderTool = defineTool({
  name: "create_change_order",
  description:
    "A SMALL change order: finishes, fixtures, material swaps, extra outlets or anything else that doesn't change the house's rooms, size or layout (for those use revise_design). Price it line by line from the project's estimate first (read_report estimate, section trade): each line is the trade (and item) with what it costs now and with the change, for all homes. The amount is the lines' total unless you give amountUsd (the user's figure). daysAdded is your estimate of the delay (0 if none). Shows the change order with Approve / Save as pending / Reject buttons and pauses; nothing is saved before the answer.",
  params: z.object({
    project: z.string().describe("Project name"),
    title: z.string().describe('Short, e.g. "Quartz countertops instead of laminate"'),
    reason: z.string().optional().describe('e.g. "Client request"'),
    lines: z.array(coLine).min(1).max(20),
    amountUsd: z.number().optional().describe("Only if the user gave the amount"),
    daysAdded: z.number().int().optional(),
    notes: z.string().optional(),
  }),
  label: (a) => `Pricing a change order for ${a.project}`,
  async run(a, env) {
    const found = openProjectOr(a.project);
    if ("error" in found) return fail(found.error);
    const lines = a.lines.map((l) => ({
      trade: l.trade,
      item: l.item ?? null,
      oldUsd: Math.round(l.oldUsd),
      newUsd: Math.round(l.newUsd),
      note: l.note ?? "",
    }));
    const input: ChangeOrderInput = {
      projectId: found.project.data.id,
      kind: "small",
      title: a.title,
      reason: a.reason ?? "",
      lines,
      amountUsd: a.amountUsd ?? linesTotal(lines),
      daysAdded: a.daysAdded ?? 0,
      revision: null,
      status: "pending",
      notes: a.notes ?? "",
    };
    return askToConfirm(
      env,
      { entity: "change-order", action: "create", input },
      changeOrderText(found.project, input),
      `Asked about the change order: ${a.title}`,
      CO_ASK,
    );
  },
});

const reviseDesignTool = defineTool({
  name: "revise_design",
  slow: "revision",
  description:
    "SLOW (~22 min, ~28 with a timeline; needs no plan when it is the only slow step asked for). A DESIGN change order: a change to the house itself (add a bathroom or bedroom, more square feet, another story, a bigger garage). Redraws the project's current design with the change into a new folder (the original stays), estimates it again and, for a project still in planning, plans its timeline again. Then prices the change by comparing ONLY the affectedTrades with the original estimate (an estimate made again differs a little in every trade, so the totals aren't compared), and shows the change order with Approve / Save as pending / Reject buttons. Read the plan first (read_report plan) for the house types and give their new numbers in houseTypes.",
  params: z.object({
    project: z.string().describe("Project name"),
    title: z.string().describe('Short, e.g. "Add a full bathroom on the second floor"'),
    reason: z.string().optional(),
    changes: z
      .array(z.string())
      .min(1)
      .max(8)
      .describe(
        'Each change in words, for the drawing, e.g. "Add a full bathroom between bedrooms 2 and 3 on the second floor"',
      ),
    houseTypes: z
      .array(
        z.object({
          type: z.string().describe('The house type, e.g. "A"'),
          bedrooms: z.number().int().optional(),
          bathrooms: z.number().optional(),
          heatedSqft: z.number().optional(),
          stories: z.number().int().optional(),
          garage: z.enum(["2-car", "1-car", "none"]).optional(),
        }),
      )
      .max(3)
      .describe("New values for the house types that change; leave out what stays"),
    affectedTrades: z
      .array(z.string())
      .min(1)
      .describe(
        'The estimate trades the change affects, e.g. ["Plumbing", "Framing & sheathing", "Interior finishes"]',
      ),
    daysAdded: z
      .number()
      .int()
      .optional()
      .describe(
        "Your estimate of the delay, for a project under construction (a planning project's new timeline decides)",
      ),
    amountUsd: z.number().optional().describe("Only if the user gave the amount"),
  }),
  label: (a) => `Revising the design of ${a.project}: ${a.title}`,
  async run(a, env) {
    const found = openProjectOr(a.project);
    if ("error" in found) return fail(found.error);
    const project = found.project;
    const current = currentDesign(project.data.site.address);
    if (!current.planDir)
      return fail(
        `${project.data.name} has no design to revise. Design its property first (design_house), or price it as a small change.`,
      );
    const inputs = readJson<{ lot: never; rules: never }>(join(current.planDir, "inputs.json"));
    const strategy = readJson<SiteStrategy>(join(current.planDir, "strategy.json"));
    if (!inputs || !strategy) return fail("The current design's files are missing.");
    try {
      editHouseTypes(strategy.houseTypes, a.houseTypes, inputs.lot, inputs.rules);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
    const oldEstimate = current.estimateDir
      ? readJson<Estimate>(join(current.estimateDir, "estimate.json"))
      : null;
    if (oldEstimate) {
      const { missing } = matchTrades([...tradeTotals(oldEstimate).keys()], a.affectedTrades);
      if (missing.length)
        return fail(
          `No trade called ${missing.map((m) => `"${m}"`).join(", ")} in the estimate. Its trades: ${[...tradeTotals(oldEstimate).keys()].join("; ")}.`,
        );
    } else if (a.amountUsd === undefined)
      return fail(
        `${project.data.name} has no cost estimate to compare the revised one with. Ask the user for the change order's amount (amountUsd), or estimate the current design first (estimate_cost).`,
      );

    const planning = project.status === "planning";
    const today = new Date().toISOString().slice(0, 10);
    let revised: RevisionResult | undefined;
    const outcome = await runSlow(
      env,
      "revision",
      (ctx) =>
        queueRevision(
          ctx,
          {
            baseDir: current.planDir!,
            title: a.title,
            changes: a.changes,
            houseTypes: a.houseTypes,
            affectedTrades: a.affectedTrades,
            timelineStart: planning
              ? project.data.dates.start > today
                ? project.data.dates.start
                : ""
              : null,
          },
          AGENT_JOB,
        ),
      (r) => {
        revised = r;
        return { result: null };
      },
    );
    if (!revised) return outcome;
    const r = revised;

    const lines = r.affected.map((t) => ({ ...t, item: null, note: "" }));
    const days = planning && r.timelineDays !== null ? r.timelineDays : (a.daysAdded ?? 0);
    const input: ChangeOrderInput = {
      projectId: project.data.id,
      kind: "design",
      title: a.title,
      reason: a.reason ?? "",
      lines,
      amountUsd: a.amountUsd ?? linesTotal(lines),
      daysAdded: days,
      revision: { dir: basename(r.dir), basedOn: basename(r.baseDir), changes: a.changes },
      status: "pending",
      notes: "",
    };
    const oldTotal = oldEstimate?.totalUsd;
    const extra = [
      `- Revised estimate: ${usd(Math.round(r.estimate.estimate.totalUsd))}${oldTotal ? ` (original ${usd(Math.round(oldTotal))}). Only the trades above are counted: the rest differ a little each time an estimate is made.` : ""}`,
      ...(r.timeline
        ? [
            `- Revised timeline: finishes ${r.timeline.timeline.finishDate}${r.timelineDays !== null ? ` (${signedDays(r.timelineDays)})` : ""}`,
          ]
        : []),
    ];
    const asked = await askToConfirm(
      env,
      { entity: "change-order", action: "create", input },
      changeOrderText(project, input, extra),
      `Asked about the change order: ${a.title}`,
      CO_ASK,
    );
    return {
      ...asked,
      result: {
        revisedDesign: basename(r.dir),
        revisedEstimateUsd: Math.round(r.estimate.estimate.totalUsd),
        originalEstimateUsd: oldTotal ? Math.round(oldTotal) : null,
        affectedTrades: r.affected,
        amountUsd: input.amountUsd,
        daysAdded: days,
        next: asked.result,
      },
    };
  },
});

const decideChangeOrderTool = defineTool({
  name: "decide_change_order",
  description:
    "Approve or reject a PENDING change order (e.g. \"the client signed CO-1003\"). Approving adds its amount to the project's approved change orders and moves the forecast finish by its days; a design change's revised design becomes the current one. Shows it with Yes / No buttons and pauses; nothing is saved before yes.",
  params: z.object({
    changeOrder: z.string().describe('e.g. "CO-1003"'),
    decision: z.enum(["approve", "reject"]),
  }),
  label: (a) =>
    `${a.decision === "approve" ? "Approving" : "Rejecting"} change order ${a.changeOrder}`,
  async run(a, env) {
    const co = getChangeOrder(a.changeOrder);
    if (!co) return fail(`No change order "${a.changeOrder}". They are numbered like CO-1003.`);
    if (co.status !== "pending") return fail(`${co.id} is already ${co.status}.`);
    const status = a.decision === "approve" ? "approved" : "rejected";
    const view = changeOrderView(co);
    return askToConfirm(
      env,
      { entity: "change-order", action: "decide", id: co.id, status },
      [
        `${a.decision === "approve" ? "Approve" : "Reject"} change order **${co.id}** for **${view.project?.name ?? co.projectId}**: ${co.title}`,
        `- Amount: ${signedUsd(co.amountUsd)}`,
        `- Schedule: ${signedDays(co.daysAdded)}`,
        ...(co.revision && status === "approved"
          ? ["- Its revised design becomes the project's current design."]
          : []),
      ].join("\n"),
      `Asked to ${a.decision} ${co.id}`,
      { question: `Shall I mark it ${status}?`, options: [CONFIRM_YES, CONFIRM_NO] },
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
  "revise_design",
] as const;

const SLOW_KIND: Partial<Record<(typeof PLAN_STEP_TOOLS)[number], JobKind>> = {
  design_house: "design",
  estimate_cost: "estimate",
  plan_timeline: "timeline",
  feasibility_report: "feasibility",
  design_interior: "interior",
  revise_design: "revision",
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
  revise_design: "Revise the design for a change order:",
};

const proposePlanTool = defineTool({
  name: "propose_plan",
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
  readReportTool,
  createProjectTool,
  updateProjectTool,
  listChangeOrdersTool,
  createChangeOrderTool,
  reviseDesignTool,
  decideChangeOrderTool,
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
