/**
 * Feasibility report: should this project go ahead, and is it better to
 * build and sell, or build and rent?
 *
 * It brings together what the other agents already produced for a plan
 * folder (zoning and lot in inputs.json, homes in strategy.json, construction
 * cost in estimate.json, build length in timeline.json) and adds:
 *   - comparable homes nearby (scripts/realtor_comps.py): recent sales for the
 *     value of each home, and current rentals for the rent,
 *   - site checks (siteChecks.ts): flood zone, soil, Edwards Aquifer, utilities,
 *   - the money: total cost, profit if sold, yield and cash flow if rented,
 *     and "what if" cases.
 *
 * Who does what:
 *   - CODE does every number and both verdicts (green / amber / red), using
 *     the assumptions in data/feasibility-defaults.json, so the figures always
 *     add up and the same inputs always give the same verdict.
 *   - QWEN only writes the short plain-English summary, from those numbers.
 *
 * Output in the plan folder: feasibility.json (all data) and
 * feasibility.html (the report; the Slack skill prints it to PDF).
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { MODEL, chatJson } from "../llm.ts";
import { PROJECT_ROOT } from "../paths.ts";
import { callout, card, esc, list, page, section, usd } from "../report.ts";
import { loadEstimate, type Estimate } from "./costEstimator.ts";
import type { Listing } from "./landSearch.ts";
import { runSiteChecks, type Flag, type SiteChecks } from "./siteChecks.ts";
import { STRATEGY_LABEL, loadStrategy, type SiteStrategy } from "./sitePlanner.ts";
import type { Timeline } from "./timelinePlanner.ts";
import type { ZoningRules } from "./zoning.ts";

const execFileAsync = promisify(execFile);
const PYTHON = `${PROJECT_ROOT}.venv/bin/python`;
const COMPS_SCRIPT = `${PROJECT_ROOT}scripts/realtor_comps.py`;
const DEFAULTS_FILE = join(PROJECT_ROOT, "data", "feasibility-defaults.json");

// ---------------------------------------------------------------------------
// Assumptions (data/feasibility-defaults.json)
// ---------------------------------------------------------------------------

const Assumptions = z.object({
  landClosingPct: z.number(),
  softCostPct: z.number(),
  utilityFeesPerHome: z.number(),
  propertyTaxPct: z.number(),
  defaultBuildMonths: z.number(),
  /** Usual new-build cost range; an estimate outside it is flagged as a risk. */
  typicalBuildCostPerSqft: z.object({ low: z.number(), high: z.number() }),
  constructionLoan: z.object({
    loanToCostPct: z.number(),
    interestPct: z.number(),
    originationFeePct: z.number(),
    averageDrawnPct: z.number(),
  }),
  sell: z.object({
    sellingCostPct: z.number(),
    monthsToSell: z.number(),
    insurancePerHomePerYear: z.number(),
  }),
  rent: z.object({
    vacancyPct: z.number(),
    managementPct: z.number(),
    maintenancePct: z.number(),
    insurancePerHomePerYear: z.number(),
    mortgage: z.object({ loanToValuePct: z.number(), interestPct: z.number(), years: z.number() }),
  }),
  comps: z.object({
    radiusMiles: z.array(z.number()).min(1),
    minComps: z.number(),
    sizeTolerancePct: z.number(),
  }),
  verdict: z.object({
    sellGreenMarginPct: z.number(),
    sellAmberMarginPct: z.number(),
    sellStressPriceDropPct: z.number(),
    rentGreenYieldPct: z.number(),
    rentAmberYieldPct: z.number(),
  }),
});
export type Assumptions = z.infer<typeof Assumptions>;

export function loadAssumptions(): Assumptions {
  const parsed = Assumptions.safeParse(JSON.parse(readFileSync(DEFAULTS_FILE, "utf8")));
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new Error(
      `data/feasibility-defaults.json is not valid: ${first?.path.join(".")}: ${first?.message}`,
    );
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Comparable homes ("comps")
// ---------------------------------------------------------------------------

export type Comp = {
  address: string | null;
  /** Sale price, last asking price of a sold home, or monthly rent (see priceKind). */
  price: number;
  priceKind: "sold" | "asking" | "rent";
  sqft: number;
  beds: number | null;
  yearBuilt: number | null;
  date: string;
  url: string | null;
};

/** The comps used for one house type, and the median price per sq ft they give. */
export type CompSet = {
  radiusMiles: number;
  comps: Comp[];
  /** Median price (or monthly rent) per sq ft of the comps used. */
  medianPerSqft: number;
  /** True when fewer comps than `minComps` were found even at the widest radius. */
  lowConfidence: boolean;
};

const median = (values: number[]) => {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

/** Fetch comps around an address from Realtor.com (via Python), cached per mode and radius. */
async function fetchComps(
  address: string,
  mode: "sold" | "rent",
  radius: number,
  cache: Map<string, Comp[]>,
): Promise<Comp[]> {
  const key = `${mode}:${radius}`;
  const hit = cache.get(key);
  if (hit) return hit;
  if (!existsSync(PYTHON))
    throw new Error("Python environment not found. Run `npm run setup` first.");
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(PYTHON, [COMPS_SCRIPT, address, mode, String(radius)], {
      maxBuffer: 20 * 1024 * 1024,
      timeout: 120_000,
    }));
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr?.trim();
    throw new Error(`Comparable homes search failed: ${stderr || (err as Error).message}`, {
      cause: err,
    });
  }
  const comps = JSON.parse(stdout) as Comp[];
  cache.set(key, comps);
  return comps;
}

/**
 * Comps for a home of `sqft` square feet: homes within ±tolerance of its size.
 * Starts with the smallest radius and widens until there are enough comps.
 */
async function compsFor(
  address: string,
  mode: "sold" | "rent",
  sqft: number,
  a: Assumptions,
  cache: Map<string, Comp[]>,
): Promise<CompSet | null> {
  const lo = sqft * (1 - a.comps.sizeTolerancePct);
  const hi = sqft * (1 + a.comps.sizeTolerancePct);
  let best: { radius: number; comps: Comp[] } | null = null;
  for (const radius of a.comps.radiusMiles) {
    const similar = (await fetchComps(address, mode, radius, cache)).filter(
      (c) => c.sqft >= lo && c.sqft <= hi && c.price > 0,
    );
    best = { radius, comps: similar };
    if (similar.length >= a.comps.minComps) break;
  }
  if (!best || !best.comps.length) return null;
  // Newest builds first in the list shown in the report (they match new homes best).
  const comps = [...best.comps].sort((x, y) => (y.yearBuilt ?? 0) - (x.yearBuilt ?? 0));
  return {
    radiusMiles: best.radius,
    comps,
    medianPerSqft: median(comps.map((c) => c.price / c.sqft)),
    lowConfidence: comps.length < a.comps.minComps,
  };
}

// ---------------------------------------------------------------------------
// The report data
// ---------------------------------------------------------------------------

export type Verdict = "green" | "amber" | "red";

export type HouseValue = {
  type: string;
  name: string;
  count: number;
  heatedSqft: number;
  sale: CompSet;
  rent: CompSet | null;
  /** Expected sale value of one home. */
  valuePerHome: number;
  /** Expected monthly rent of one home (0 if no rental comps). */
  rentPerHome: number;
};

export type CostLine = { label: string; usd: number; note: string };

export type SellResult = {
  revenue: number;
  sellingCosts: number;
  holdingCosts: number;
  totalCost: number;
  profit: number;
  /** Profit ÷ total cost. */
  margin: number;
  /** Cash the builder puts in (cost not covered by the construction loan). */
  equity: number;
  /** Profit ÷ equity. */
  returnOnEquity: number;
  /** Sale price per sq ft at which profit is zero. */
  breakEvenPerSqft: number;
  whatIf: { label: string; profit: number; margin: number }[];
  verdict: Verdict;
};

export type RentResult = {
  grossRentPerYear: number;
  vacancy: number;
  operatingExpenses: number;
  /** Net operating income: rent after vacancy and running costs, before the mortgage. */
  noi: number;
  totalCost: number;
  /** NOI ÷ total cost. */
  yieldOnCost: number;
  mortgage: number;
  debtServicePerYear: number;
  cashFlowPerYear: number;
  cashInvested: number;
  cashOnCash: number | null;
  verdict: Verdict;
};

export type Feasibility = {
  planDir: string;
  model: string;
  createdAt: string;
  listing: Listing;
  rules: ZoningRules;
  strategy: SiteStrategy;
  homes: number;
  totalSqft: number;
  buildMonths: number;
  buildMonthsSource: string;
  site: SiteChecks;
  houses: HouseValue[];
  costs: CostLine[];
  /** All costs up to completion (before selling or renting). */
  costToBuild: number;
  constructionLoan: number;
  sell: SellResult;
  rent: RentResult | null;
  /** Which option code recommends, and why. */
  recommendation: { option: "sell" | "rent" | "neither"; reason: string };
  lowConfidence: boolean;
  /** The reasons confidence is low (empty when it isn't). */
  confidenceNotes: string[];
  risks: string[];
  nextSteps: string[];
  summary: string;
  assumptions: Assumptions;
  htmlPath: string;
  jsonPath: string;
};

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
const RANK: Record<Verdict, number> = { green: 2, amber: 1, red: 0 };

/** Monthly payment of a fixed-rate loan. */
function monthlyPayment(principal: number, annualRate: number, years: number): number {
  const r = annualRate / 12;
  const n = years * 12;
  return r === 0 ? principal / n : (principal * r) / (1 - (1 + r) ** -n);
}

type Inputs = {
  listing: Listing;
  estimate: Estimate;
  houses: HouseValue[];
  buildMonths: number;
  homes: number;
  a: Assumptions;
};

/** All costs up to completion, line by line. */
function buildCosts({ listing, estimate, buildMonths, homes, a }: Inputs, costFactor = 1) {
  const land = listing.priceUsd;
  const construction = estimate.totalUsd * costFactor;
  const lines: CostLine[] = [
    { label: "Land", usd: land, note: "Listing price" },
    {
      label: "Land closing costs",
      usd: land * a.landClosingPct,
      note: `${pct(a.landClosingPct)} of land`,
    },
    {
      label: "Construction",
      usd: construction,
      note: "From the cost estimate, including its 10% contingency",
    },
    {
      label: "Soft costs",
      usd: construction * a.softCostPct,
      note: `${pct(a.softCostPct)} of construction: design, engineering, surveys, permits`,
    },
    {
      label: "Utility connection and impact fees",
      usd: homes * a.utilityFeesPerHome,
      note: `${usd(a.utilityFeesPerHome)} per home (assumed; confirm with the utility)`,
    },
    {
      label: "Property tax during construction",
      usd: land * a.propertyTaxPct * (buildMonths / 12),
      note: `${pct(a.propertyTaxPct)} of land value per year for ${buildMonths} months`,
    },
  ];
  const development = lines.reduce((s, l) => s + l.usd, 0);
  const loan = development * a.constructionLoan.loanToCostPct;
  const fees = loan * a.constructionLoan.originationFeePct;
  const interest =
    loan * a.constructionLoan.averageDrawnPct * a.constructionLoan.interestPct * (buildMonths / 12);
  lines.push(
    {
      label: "Construction loan fee",
      usd: fees,
      note: `${pct(a.constructionLoan.originationFeePct)} of a ${usd(loan)} loan (${pct(a.constructionLoan.loanToCostPct)} of cost)`,
    },
    {
      label: "Construction loan interest",
      usd: interest,
      note: `${pct(a.constructionLoan.interestPct)} on ${pct(a.constructionLoan.averageDrawnPct)} of the loan drawn on average, ${buildMonths} months`,
    },
  );
  return { lines, development, loan, total: development + fees + interest };
}

function sellScenario(inputs: Inputs, { priceFactor = 1, costFactor = 1, extraMonths = 0 } = {}) {
  const { a, homes } = inputs;
  const months = inputs.buildMonths + extraMonths;
  const build = buildCosts({ ...inputs, buildMonths: months }, costFactor);
  const revenue = inputs.houses.reduce((s, h) => s + h.count * h.valuePerHome, 0) * priceFactor;
  const sellingCosts = revenue * a.sell.sellingCostPct;
  const m = a.sell.monthsToSell / 12;
  // While the finished homes are on the market, the loan, taxes and insurance keep running.
  const holdingCosts =
    build.loan * a.constructionLoan.interestPct * m +
    revenue * a.propertyTaxPct * m +
    homes * a.sell.insurancePerHomePerYear * m;
  const totalCost = build.total + sellingCosts + holdingCosts;
  const profit = revenue - totalCost;
  return {
    build,
    revenue,
    sellingCosts,
    holdingCosts,
    totalCost,
    profit,
    margin: profit / totalCost,
  };
}

function computeSell(inputs: Inputs, totalSqft: number): SellResult {
  const { a } = inputs;
  const base = sellScenario(inputs);
  const equity = base.build.total - base.build.loan;
  const drop = a.verdict.sellStressPriceDropPct;
  const whatIf = [
    { label: `Sale prices ${pct(drop)} lower`, ...sellScenario(inputs, { priceFactor: 1 - drop }) },
    { label: "Construction costs 10% higher", ...sellScenario(inputs, { costFactor: 1.1 }) },
    { label: "Takes 3 months longer", ...sellScenario(inputs, { extraMonths: 3 }) },
  ].map((w) => ({ label: w.label, profit: w.profit, margin: w.margin }));
  const stressed = whatIf[0]!;
  const verdict: Verdict =
    base.margin >= a.verdict.sellGreenMarginPct && stressed.profit > 0
      ? "green"
      : base.margin >= a.verdict.sellAmberMarginPct
        ? "amber"
        : "red";
  return {
    revenue: base.revenue,
    sellingCosts: base.sellingCosts,
    holdingCosts: base.holdingCosts,
    totalCost: base.totalCost,
    profit: base.profit,
    margin: base.margin,
    equity,
    returnOnEquity: equity > 0 ? base.profit / equity : 0,
    breakEvenPerSqft:
      (base.build.total + base.holdingCosts) / (totalSqft * (1 - a.sell.sellingCostPct)),
    whatIf,
    verdict,
  };
}

function computeRent(inputs: Inputs, costToBuild: number): RentResult | null {
  const { a, homes, houses } = inputs;
  if (houses.some((h) => !h.rent)) return null;
  const value = houses.reduce((s, h) => s + h.count * h.valuePerHome, 0);
  const grossRentPerYear = houses.reduce((s, h) => s + h.count * h.rentPerHome * 12, 0);
  const vacancy = grossRentPerYear * a.rent.vacancyPct;
  const effective = grossRentPerYear - vacancy;
  const operatingExpenses =
    effective * (a.rent.managementPct + a.rent.maintenancePct) +
    homes * a.rent.insurancePerHomePerYear +
    value * a.propertyTaxPct;
  const noi = effective - operatingExpenses;
  const yieldOnCost = noi / costToBuild;
  // A long-term mortgage replaces the construction loan once the homes are rented.
  const mortgage = Math.min(value, costToBuild) * a.rent.mortgage.loanToValuePct;
  const debtServicePerYear =
    monthlyPayment(mortgage, a.rent.mortgage.interestPct, a.rent.mortgage.years) * 12;
  const cashFlowPerYear = noi - debtServicePerYear;
  const cashInvested = Math.max(0, costToBuild - mortgage);
  const verdict: Verdict =
    yieldOnCost >= a.verdict.rentGreenYieldPct
      ? "green"
      : yieldOnCost >= a.verdict.rentAmberYieldPct
        ? "amber"
        : "red";
  return {
    grossRentPerYear,
    vacancy,
    operatingExpenses,
    noi,
    totalCost: costToBuild,
    yieldOnCost,
    mortgage,
    debtServicePerYear,
    cashFlowPerYear,
    cashInvested,
    cashOnCash: cashInvested > 0 ? cashFlowPerYear / cashInvested : null,
    verdict,
  };
}

/** A serious site issue (e.g. a floodplain) caps a green verdict at amber: check it first. */
const capped = (v: Verdict, site: SiteChecks): Verdict =>
  v === "green" && Object.values(site).some((c) => c.flag === "red") ? "amber" : v;

function recommend(
  sell: SellResult,
  rent: RentResult | null,
  a: Assumptions,
): Feasibility["recommendation"] {
  const best = rent && RANK[rent.verdict] > RANK[sell.verdict] ? "rent" : "sell";
  const chosen = best === "rent" ? rent!.verdict : sell.verdict;
  if (chosen === "red")
    return {
      option: "neither",
      reason: `Selling gives a ${pct(sell.margin)} margin (target ${pct(a.verdict.sellGreenMarginPct)})${rent ? ` and renting a ${pct(rent.yieldOnCost)} yield (target ${pct(a.verdict.rentGreenYieldPct)})` : ""}; neither clears the bar at this land price and build cost.`,
    };
  return best === "sell"
    ? {
        option: "sell",
        reason: `Selling gives a ${pct(sell.margin)} margin on cost${rent ? `, compared with a ${pct(rent.yieldOnCost)} yield if rented` : ""}.`,
      }
    : {
        option: "rent",
        reason: `Renting gives a ${pct(rent!.yieldOnCost)} yield on cost, a better result than selling at a ${pct(sell.margin)} margin.`,
      };
}

function buildRisksAndSteps(
  f: Omit<Feasibility, "risks" | "nextSteps" | "summary">,
  estimate: Estimate,
  timeline: Timeline | null,
) {
  const risks: string[] = [];
  const steps: string[] = [];
  const site = f.site;
  for (const [name, check] of Object.entries(site) as [
    keyof SiteChecks,
    SiteChecks[keyof SiteChecks],
  ][])
    if (check.flag !== "green")
      risks.push(
        `${name === "edwards" ? "Edwards Aquifer" : name[0]!.toUpperCase() + name.slice(1)}: ${check.summary}.`,
      );
  if (f.sell.whatIf[0]!.profit <= 0)
    risks.push(
      `Selling loses money if prices come in ${pct(f.assumptions.verdict.sellStressPriceDropPct)} lower than the comps.`,
    );
  if (f.lowConfidence)
    risks.push("Few comparable homes were found, so the value and rent are less certain.");
  for (const approval of f.strategy.approvals.slice(0, 3))
    risks.push(`Approval needed: ${approval}.`);
  const failed = estimate.houses.flatMap((h) => h.failedTrades);
  if (failed.length)
    risks.push(`The cost estimate couldn't price: ${failed.join(", ")} (not in the total).`);
  for (const r of timeline?.risks.slice(0, 2) ?? []) risks.push(r);
  risks.push(
    "Texas doesn't disclose sale prices, so home values use the last asking prices of recently sold homes; actual sale prices can be lower.",
  );

  steps.push("Order a geotechnical (soil boring) report to size the foundation.");
  steps.push("Order a boundary and topographic survey.");
  steps.push(
    site.utilities.flag === "green"
      ? "Request an Austin Water Service Extension Request or tap confirmation, and get the connection and impact fees."
      : "Find the water and sewer provider and get a will-serve letter, or a septic feasibility study.",
  );
  if (site.flood.flag === "red")
    steps.push("Get an elevation certificate and talk to the City's floodplain office.");
  if (site.edwards.flag === "amber")
    steps.push("Ask your engineer what the TCEQ Edwards Aquifer rules require for this site.");
  if (f.rules.district === "user-entered")
    steps.push(
      "Confirm the zoning and setbacks with the city or county; this plan used typical defaults.",
    );
  else if (f.rules.research && f.rules.research.confidence !== "high")
    steps.push(
      `Confirm the zoning, setbacks and allowed housing types with ${f.rules.jurisdiction}; the site rules research had ${f.rules.research.confidence} confidence.`,
    );
  for (const w of f.rules.research?.warnings.slice(0, 2) ?? []) risks.push(w);
  steps.push("Check the value with a local agent or appraiser before committing.");
  return { risks, nextSteps: steps };
}

const WRITER = `You are a real estate development analyst writing the summary of a feasibility report.
Use ONLY the facts given. Never invent numbers, names, dates or causes. Quote figures exactly as given.
Write plain sentences, no headings, no bullet points, no markdown.`;

async function writeSummary(f: Omit<Feasibility, "summary">): Promise<string> {
  const facts = [
    `Property: ${f.listing.address}. Land price ${usd(f.listing.priceUsd)}.`,
    `Plan: ${STRATEGY_LABEL[f.strategy.strategy]}, ${f.homes} home(s), ${f.totalSqft.toLocaleString("en-US")} sq ft in total, about ${f.buildMonths} months to build.`,
    `Cost to build (land, construction, fees, financing): ${usd(f.costToBuild)}.`,
    `Build and sell: expected sales ${usd(f.sell.revenue)}, total cost ${usd(f.sell.totalCost)}, profit ${usd(f.sell.profit)} (${pct(f.sell.margin)} margin), verdict ${f.sell.verdict}.`,
    `If prices are ${pct(f.assumptions.verdict.sellStressPriceDropPct)} lower: profit ${usd(f.sell.whatIf[0]!.profit)}.`,
    f.rent
      ? `Build and rent: rent ${usd(f.rent.grossRentPerYear / 12)} per month in total, yield on cost ${pct(f.rent.yieldOnCost)}, cash flow after mortgage ${usd(f.rent.cashFlowPerYear)} per year, verdict ${f.rent.verdict}.`
      : "Build and rent: not enough rental comps to estimate.",
    `Recommendation: ${f.recommendation.option}. ${f.recommendation.reason}`,
    `Confidence: ${f.lowConfidence ? `low, because ${f.confidenceNotes.join(" and ")}` : "normal"}.`,
    `Top risks: ${f.risks.slice(0, 4).join(" ")}`,
  ].join("\n");
  const raw = await chatJson(
    WRITER,
    `${facts}\n\nWrite a 4 to 6 sentence executive summary: whether the project looks worth doing, which option (sell or rent) looks better and why, the key numbers, and the most important risks to check first.`,
    z.toJSONSchema(z.object({ summary: z.string() })),
  );
  return (JSON.parse(raw) as { summary: string }).summary;
}

export type FeasibilityProgress = { step: string };

/**
 * Build the feasibility report for a plan folder. The plan must already have
 * a cost estimate (estimate.json); a timeline is used when there is one.
 */
export async function run(
  planDir: string,
  onProgress?: (p: FeasibilityProgress) => void,
): Promise<Feasibility> {
  const a = loadAssumptions();
  const inputs = JSON.parse(await readFile(join(planDir, "inputs.json"), "utf8")) as {
    listing: Listing;
    rules: ZoningRules;
  };
  const strategy = await loadStrategy(planDir);
  if (!strategy) throw new Error("This plan has no strategy.json, so it can't be assessed.");
  if (!existsSync(join(planDir, "estimate.json")))
    throw new Error("This plan has no cost estimate yet; run the estimate first.");
  const estimate = await loadEstimate(planDir);
  const timeline = existsSync(join(planDir, "timeline.json"))
    ? (JSON.parse(await readFile(join(planDir, "timeline.json"), "utf8")) as Timeline)
    : null;
  const { listing } = inputs;
  const buildMonths = timeline
    ? Math.max(1, Math.round(timeline.calendarWeeks / 4.345))
    : a.defaultBuildMonths;

  onProgress?.({ step: "Checking flood zone, soil, aquifer and utilities" });
  const site = await runSiteChecks(listing);

  onProgress?.({ step: "Finding recent nearby sales and rentals" });
  const cache = new Map<string, Comp[]>();
  const houses: HouseValue[] = [];
  for (const t of strategy.houseTypes) {
    const sale = await compsFor(listing.address, "sold", t.heatedSqft, a, cache);
    if (!sale)
      throw new Error(
        `No comparable homes of about ${t.heatedSqft.toLocaleString("en-US")} sq ft sold within ${a.comps.radiusMiles.at(-1)} miles in the last year, so the value can't be estimated.`,
      );
    const rent = await compsFor(listing.address, "rent", t.heatedSqft, a, cache);
    houses.push({
      type: t.type,
      name: t.name,
      count: t.count,
      heatedSqft: t.heatedSqft,
      sale,
      rent,
      valuePerHome: sale.medianPerSqft * t.heatedSqft,
      rentPerHome: rent ? rent.medianPerSqft * t.heatedSqft : 0,
    });
  }

  onProgress?.({ step: "Running the numbers" });
  const homes = strategy.homes;
  const totalSqft = houses.reduce((s, h) => s + h.count * h.heatedSqft, 0);
  const calc: Inputs = { listing, estimate, houses, buildMonths, homes, a };
  const build = buildCosts(calc);
  const sell = computeSell(calc, totalSqft);
  const rent = computeRent(calc, build.total);
  sell.verdict = capped(sell.verdict, site);
  if (rent) rent.verdict = capped(rent.verdict, site);
  // Sanity check: an AI estimate far outside normal build costs makes the
  // profit unreliable, so it lowers confidence and is listed as a risk.
  const buildCostPerSqft = estimate.totalUsd / totalSqft;
  const costOutOfRange =
    buildCostPerSqft < a.typicalBuildCostPerSqft.low ||
    buildCostPerSqft > a.typicalBuildCostPerSqft.high;
  // Why confidence is low, spelled out so the summary doesn't guess.
  const confidenceNotes = [
    ...(costOutOfRange
      ? [
          `the cost estimate (${usd(Math.round(buildCostPerSqft))}/sq ft) is outside the usual range`,
        ]
      : []),
    ...(houses.some((h) => h.sale.lowConfidence) ? ["few comparable sales were found"] : []),
    ...(houses.some((h) => h.rent?.lowConfidence) ? ["few comparable rentals were found"] : []),
    ...(Object.values(site).some((c) => c.flag === "unknown") ? ["a site check couldn't run"] : []),
  ];
  const lowConfidence = confidenceNotes.length > 0;

  const base = {
    planDir,
    model: MODEL,
    createdAt: new Date().toISOString(),
    listing,
    rules: inputs.rules,
    strategy,
    homes,
    totalSqft,
    buildMonths,
    buildMonthsSource: timeline
      ? `from the construction timeline (${timeline.startDate} to ${timeline.finishDate})`
      : `assumed (no timeline yet)`,
    site,
    houses,
    costs: build.lines,
    costToBuild: build.total,
    constructionLoan: build.loan,
    sell,
    rent,
    recommendation: recommend(sell, rent, a),
    lowConfidence,
    confidenceNotes,
    assumptions: a,
    htmlPath: join(planDir, "feasibility.html"),
    jsonPath: join(planDir, "feasibility.json"),
  };
  const { risks, nextSteps } = buildRisksAndSteps(base, estimate, timeline);
  if (costOutOfRange)
    risks.unshift(
      `The cost estimate works out to ${usd(Math.round(buildCostPerSqft))}/sq ft, outside the usual ${usd(a.typicalBuildCostPerSqft.low)}–${usd(a.typicalBuildCostPerSqft.high)}/sq ft for new homes, so the ${buildCostPerSqft < a.typicalBuildCostPerSqft.low ? "profit may be overstated" : "profit may be understated"}. Get a builder's bid before relying on it.`,
    );

  onProgress?.({ step: "Writing the summary" });
  const withRisks = { ...base, risks, nextSteps };
  const feasibility: Feasibility = { ...withRisks, summary: await writeSummary(withRisks) };

  await writeFile(feasibility.jsonPath, JSON.stringify(feasibility, null, 2));
  await writeFile(feasibility.htmlPath, toHtml(feasibility));
  return feasibility;
}

// ---------------------------------------------------------------------------
// The HTML report
// ---------------------------------------------------------------------------

const VERDICT_TEXT: Record<Verdict, string> = {
  green: "Feasible",
  amber: "Marginal",
  red: "Not feasible",
};
const FLAG_TEXT: Record<Flag, string> = {
  green: "OK",
  amber: "Plan for it",
  red: "Serious",
  unknown: "Not checked",
};

const badge = (flag: Flag | Verdict, text: string) =>
  `<span class="badge v-${flag}">${esc(text)}</span>`;
const money = (n: number) => usd(Math.round(n));
const row = (cells: string[], numFrom = 1) =>
  `<tr>${cells.map((c, i) => `<td${i >= numFrom ? ' class="num"' : ""}>${c}</td>`).join("")}</tr>`;

function compsTable(title: string, set: CompSet, perMonth: boolean): string {
  const rows = set.comps
    .slice(0, 15)
    .map(
      (c) =>
        `<tr><td>${c.url ? `<a href="${esc(c.url)}">${esc(c.address ?? "Address n/a")}</a>` : esc(c.address ?? "Address n/a")}</td>` +
        `<td class="num">${money(c.price)}${perMonth ? "/mo" : ""}</td><td class="num">${c.sqft.toLocaleString("en-US")}</td>` +
        `<td class="num">${perMonth ? `$${(c.price / c.sqft).toFixed(2)}` : money(c.price / c.sqft)}</td>` +
        `<td class="num">${c.yearBuilt ?? "-"}</td><td>${esc(c.priceKind === "asking" ? "asking price" : c.priceKind)}</td></tr>`,
    )
    .join("");
  return (
    `<h3>${esc(title)}</h3>` +
    `<p class="note">${set.comps.length} homes within ${set.radiusMiles} miles · median ${perMonth ? `$${set.medianPerSqft.toFixed(2)}/sq ft per month` : `${money(set.medianPerSqft)}/sq ft`}${set.lowConfidence ? " · few comps, lower confidence" : ""}${set.comps.length > 15 ? " · showing 15 newest" : ""}</p>` +
    `<div class="table-scroll"><table><thead><tr><th>Address</th><th class="num">${perMonth ? "Rent" : "Price"}</th><th class="num">Sq ft</th><th class="num">Per sq ft</th><th class="num">Built</th><th>Price type</th></tr></thead>${rows}</table></div>`
  );
}

function toHtml(f: Feasibility): string {
  const a = f.assumptions;
  const s = f.sell;
  const r = f.rent;
  const rec = f.recommendation;

  const site = Object.entries(f.site)
    .map(([k, c]) =>
      row(
        [
          esc(k === "edwards" ? "Edwards Aquifer" : k[0]!.toUpperCase() + k.slice(1)),
          `${badge(c.flag, FLAG_TEXT[c.flag])} ${esc(c.summary)}`,
          esc(c.detail),
        ],
        99,
      ),
    )
    .join("");

  const houses = f.houses
    .map((h) =>
      row([
        esc(`Type ${h.type} "${h.name}"`),
        String(h.count),
        h.heatedSqft.toLocaleString("en-US"),
        money(h.valuePerHome),
        h.rent ? `${money(h.rentPerHome)}/mo` : "-",
      ]),
    )
    .join("");

  const costs =
    f.costs
      .map(
        (c) =>
          `<tr><td>${esc(c.label)}</td><td class="num">${money(c.usd)}</td><td>${esc(c.note)}</td></tr>`,
      )
      .join("") +
    `<tr><th>Cost to build</th><th class="num">${money(f.costToBuild)}</th><th></th></tr>`;

  const sellRows = [
    ["Expected sales", money(s.revenue)],
    ["Cost to build", money(f.costToBuild)],
    [`Selling costs (${pct(a.sell.sellingCostPct)})`, money(s.sellingCosts)],
    [`Holding costs while selling (${a.sell.monthsToSell} months)`, money(s.holdingCosts)],
    ["Total cost", money(s.totalCost)],
    ["<strong>Profit</strong>", `<strong>${money(s.profit)}</strong>`],
    ["Margin on cost", pct(s.margin)],
    ["Cash invested (not covered by the loan)", money(s.equity)],
    ["Return on cash invested", pct(s.returnOnEquity)],
    ["Break-even sale price", `${money(s.breakEvenPerSqft)}/sq ft`],
  ]
    .map(([l, v]) => row([l!, v!]))
    .join("");
  const whatIf = s.whatIf.map((w) => row([esc(w.label), money(w.profit), pct(w.margin)])).join("");

  const rentRows = r
    ? [
        ["Rent", `${money(r.grossRentPerYear / 12)}/mo (${money(r.grossRentPerYear)}/yr)`],
        [`Vacancy (${pct(a.rent.vacancyPct)})`, `−${money(r.vacancy)}`],
        [
          "Operating expenses (management, repairs, insurance, tax)",
          `−${money(r.operatingExpenses)}`,
        ],
        ["<strong>Net operating income</strong>", `<strong>${money(r.noi)}/yr</strong>`],
        ["Yield on cost", pct(r.yieldOnCost)],
        [
          `Mortgage (${pct(a.rent.mortgage.loanToValuePct)} of value, ${pct(a.rent.mortgage.interestPct)}, ${a.rent.mortgage.years} yr)`,
          money(r.mortgage),
        ],
        ["Mortgage payments", `−${money(r.debtServicePerYear)}/yr`],
        [
          "<strong>Cash flow after mortgage</strong>",
          `<strong>${money(r.cashFlowPerYear)}/yr</strong>`,
        ],
        ["Cash left in the project", money(r.cashInvested)],
        [
          "Cash-on-cash return",
          r.cashOnCash === null ? "n/a (no cash left in)" : pct(r.cashOnCash),
        ],
      ]
        .map(([l, v]) => row([l!, v!]))
        .join("")
    : "";

  const assumptions = [
    ["Land closing costs", pct(a.landClosingPct)],
    [
      "Typical build cost (sanity check)",
      `${money(a.typicalBuildCostPerSqft.low)}–${money(a.typicalBuildCostPerSqft.high)} per sq ft`,
    ],
    ["Soft costs", `${pct(a.softCostPct)} of construction`],
    ["Utility fees", `${money(a.utilityFeesPerHome)} per home`],
    ["Property tax", `${pct(a.propertyTaxPct)} per year`],
    [
      "Construction loan",
      `${pct(a.constructionLoan.loanToCostPct)} of cost, ${pct(a.constructionLoan.interestPct)}, ${pct(a.constructionLoan.originationFeePct)} fee, ${pct(a.constructionLoan.averageDrawnPct)} drawn on average`,
    ],
    [
      "Selling costs / time to sell",
      `${pct(a.sell.sellingCostPct)} / ${a.sell.monthsToSell} months`,
    ],
    [
      "Rental vacancy / management / repairs",
      `${pct(a.rent.vacancyPct)} / ${pct(a.rent.managementPct)} / ${pct(a.rent.maintenancePct)}`,
    ],
    ["Insurance", `${money(a.rent.insurancePerHomePerYear)} per home per year`],
    [
      "Verdict: sell",
      `green ≥ ${pct(a.verdict.sellGreenMarginPct)} margin and profitable with prices ${pct(a.verdict.sellStressPriceDropPct)} lower; amber ≥ ${pct(a.verdict.sellAmberMarginPct)}`,
    ],
    [
      "Verdict: rent",
      `green ≥ ${pct(a.verdict.rentGreenYieldPct)} yield on cost; amber ≥ ${pct(a.verdict.rentAmberYieldPct)}`,
    ],
    [
      "Comparable homes",
      `±${pct(a.comps.sizeTolerancePct)} of the home's size, within ${a.comps.radiusMiles.join(" / ")} miles, at least ${a.comps.minComps}`,
    ],
  ]
    .map(([l, v]) => row([esc(l!), esc(v!)], 99))
    .join("");

  const body =
    section(
      "Summary",
      callout(
        rec.option === "neither"
          ? `Not recommended as planned. ${rec.reason}`
          : `Best option: build and ${rec.option}. ${rec.reason}`,
        rec.option === "neither" ? "warn" : "info",
      ) +
        `<p>${esc(f.summary)}</p>` +
        `<div class="cards">` +
        card(
          "Build and sell",
          `${VERDICT_TEXT[s.verdict]}`,
          `${money(s.profit)} profit · ${pct(s.margin)} margin`,
        ) +
        card(
          "Build and rent",
          r ? VERDICT_TEXT[r.verdict] : "n/a",
          r
            ? `${pct(r.yieldOnCost)} yield · ${money(r.cashFlowPerYear)}/yr cash flow`
            : "No rental comps",
        ) +
        card(
          "Cost to build",
          money(f.costToBuild),
          `${f.homes} ${f.homes === 1 ? "home" : "homes"} · ${f.totalSqft.toLocaleString("en-US")} sq ft`,
        ) +
        card("Expected value", money(s.revenue), "From nearby sold homes") +
        card(
          "Confidence",
          f.lowConfidence ? "Low" : "Normal",
          f.lowConfidence
            ? `Because ${(f.confidenceNotes ?? []).join(" and ")}`
            : "Enough comps, all checks ran, cost in the usual range",
        ) +
        `</div>`,
    ) +
    section(
      "Site",
      `<p>${esc(f.listing.address)} · lot ${f.listing.lotSqft ? `${f.listing.lotSqft.toLocaleString("en-US")} sq ft` : "size n/a"} · zoning ${esc(f.rules.district === "user-entered" ? "typical defaults (no zoning data)" : `${f.rules.district} (${f.rules.districtName})`)}</p>` +
        `<div class="table-scroll"><table><tr><th>Check</th><th>Result</th><th>What it means</th></tr>${site}</table></div>`,
    ) +
    section(
      "Development plan",
      `<p>${esc(STRATEGY_LABEL[f.strategy.strategy])}: ${f.homes} ${f.homes === 1 ? "home" : "homes"}. ${esc(f.strategy.reasoning)}</p>` +
        `<table><tr><th>House type</th><th class="num">Homes</th><th class="num">Sq ft</th><th class="num">Value each</th><th class="num">Rent each</th></tr>${houses}</table>` +
        (f.strategy.approvals.length
          ? `<h3>Approvals needed</h3>${list(f.strategy.approvals)}`
          : ""),
    ) +
    section(
      "Costs",
      `<div class="table-scroll"><table><thead><tr><th>Item</th><th class="num">Amount</th><th>How it's worked out</th></tr></thead>${costs}</table></div>`,
    ) +
    section(
      `Build and sell: ${VERDICT_TEXT[s.verdict]}`,
      `<p>${badge(s.verdict, VERDICT_TEXT[s.verdict])}</p><table>${sellRows}</table>` +
        `<h3>What if</h3><table><tr><th>Case</th><th class="num">Profit</th><th class="num">Margin</th></tr>${whatIf}</table>`,
    ) +
    section(
      `Build and rent: ${r ? VERDICT_TEXT[r.verdict] : "not estimated"}`,
      r
        ? `<p>${badge(r.verdict, VERDICT_TEXT[r.verdict])}</p><table>${rentRows}</table>`
        : callout("Not enough comparable rentals nearby to estimate rent.", "warn"),
    ) +
    section(
      "Schedule",
      `<p>About ${f.buildMonths} months from start to finished homes, ${esc(f.buildMonthsSource)}. Selling is assumed to take ${a.sell.monthsToSell} more months.</p>`,
    ) +
    section("Risks", list(f.risks)) +
    section("Next steps before buying", list(f.nextSteps)) +
    section(
      "Comparable homes",
      f.houses
        .map(
          (h) =>
            `<details open><summary><span class="title">Type ${esc(h.type)} (${h.heatedSqft.toLocaleString("en-US")} sq ft)</span><span class="meta">${h.sale.comps.length} sold · ${h.rent?.comps.length ?? 0} rentals</span></summary><div class="content">` +
            compsTable("Recently sold", h.sale, false) +
            (h.rent ? compsTable("For rent now", h.rent, true) : "") +
            `</div></details>`,
        )
        .join(""),
    ) +
    section("Assumptions", `<table>${assumptions}</table>`);

  return page({
    dir: f.planDir,
    file: "feasibility.html",
    kind: "Feasibility report",
    title: f.listing.address,
    meta: [
      [
        "Lot",
        f.listing.lotSqft ? `${f.listing.lotSqft.toLocaleString("en-US")} sq ft` : "Size n/a",
      ],
      ["Zoning", f.rules.district === "user-entered" ? "Typical defaults" : f.rules.district],
      [
        "Scheme",
        `${f.homes} ${f.homes === 1 ? "home" : "homes"}, ${f.totalSqft.toLocaleString("en-US")} sq ft`,
      ],
      ["Summary written by", f.model],
    ],
    date: new Date(f.createdAt),
    body,
  });
}

/** Rebuilds feasibility.html from a saved feasibility.json without calling the model. */
export async function renderHtml(planDir: string): Promise<string> {
  const saved = JSON.parse(
    await readFile(join(planDir, "feasibility.json"), "utf8"),
  ) as Feasibility;
  const htmlPath = join(planDir, "feasibility.html");
  await writeFile(htmlPath, toHtml({ ...saved, planDir }));
  return htmlPath;
}
