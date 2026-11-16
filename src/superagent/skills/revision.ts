/**
 * Skill: revise a project's design for a design change order (add a bathroom,
 * a bedroom, a story, more square feet).
 *
 *   1. Start from the project's current design: its listing, lot, rules and
 *      house types. The agent gives the changed numbers (bedrooms, bathrooms,
 *      heated sq ft, stories, garage) and the changes in words.
 *   2. Draw the plan again with those changes, into a NEW folder; the
 *      original is never touched. revision.json marks it as a revision.
 *   3. Estimate the revised plan, and for a project still in planning, plan
 *      its timeline again.
 *   4. Compare the trades the change affects with the original estimate.
 *      Only those: an estimate made again comes out a little different in
 *      every trade, so a total-to-total comparison would price that noise too.
 *
 * Until its change order is approved the revision isn't the current design
 * (revisions.ts), so reports and new estimates keep using the original.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Estimate } from "../../agents/costEstimator.ts";
import * as houseDesigner from "../../agents/houseDesigner.ts";
import type { Listing } from "../../agents/landSearch.ts";
import { loadStrategy, withFootprint, type HouseType } from "../../agents/sitePlanner.ts";
import type { Timeline } from "../../agents/timelinePlanner.ts";
import type { ZoningRules } from "../../agents/zoning.ts";
import { foldersFor } from "../../projectDocuments.ts";
import { refreshReports } from "../../refreshReports.ts";
import { isCurrentPlan, markRevision, writeRevision } from "../../revisions.ts";
import { printPdf, screenshotSvg } from "../render.ts";
import { estimateCost, type EstimateResult } from "./estimate.ts";
import { planTimeline, type TimelineResult } from "./timeline.ts";

/** New values for one house type ("A"); what isn't given stays. */
export type HouseTypeEdit = {
  type: string;
  bedrooms?: number;
  bathrooms?: number;
  heatedSqft?: number;
  stories?: number;
  garage?: HouseType["garage"];
};

export type RevisionRequest = {
  /** The design to revise (a full path in output/). */
  baseDir: string;
  title: string;
  changes: string[];
  houseTypes: HouseTypeEdit[];
  /** Trades the change affects, named as in the estimate ("Plumbing", "Interior finishes"). */
  affectedTrades: string[];
  /** The timeline's start date ("" for next Monday), or null for no new timeline. */
  timelineStart: string | null;
};

export type TradeChange = { trade: string; oldUsd: number; newUsd: number };

export type RevisionResult = {
  dir: string;
  baseDir: string;
  pdfPath: string;
  pngPath: string;
  estimate: EstimateResult;
  timeline: TimelineResult | null;
  /** The affected trades, original against revised (all homes); empty without an original estimate. */
  affected: TradeChange[];
  /** The original estimate's folder, if there is one. */
  baseEstimateDir: string | null;
  /** Calendar days the new timeline finishes after the original one, when both exist. */
  timelineDays: number | null;
  seconds: number;
};

const readJson = <T>(path: string): T | null =>
  existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : null;

/** The newest current folder for an address that has `file`. */
const newestWith = (address: string, file: string) =>
  foldersFor(address).find((d) => existsSync(join(d, file)) && isCurrentPlan(d)) ?? null;

/** The project's current design and the estimate and timeline it is compared with. */
export function currentDesign(address: string): {
  planDir: string | null;
  estimateDir: string | null;
  timelineDir: string | null;
} {
  return {
    // plan.svg is written last, so a design that stopped halfway doesn't count.
    planDir: newestWith(address, "plan.svg"),
    estimateDir: newestWith(address, "estimate.json"),
    timelineDir: newestWith(address, "timeline.json"),
  };
}

/** Each trade's materials and labor for all homes. */
export function tradeTotals(e: Estimate): Map<string, number> {
  const totals = new Map<string, number>();
  for (const h of e.houses)
    for (const t of h.trades)
      totals.set(t.name, (totals.get(t.name) ?? 0) + (t.materialsUsd + t.laborUsd) * h.count);
  return totals;
}

/** The estimate's trade names that `wanted` names ("plumbing" matches "Plumbing"); unknown names in `missing`. */
export function matchTrades(
  trades: string[],
  wanted: string[],
): { matched: string[]; missing: string[] } {
  const matched = new Set<string>();
  const missing: string[] = [];
  for (const w of wanted) {
    const q = w.trim().toLowerCase();
    const hits = trades.filter((t) => t.toLowerCase() === q || t.toLowerCase().includes(q));
    if (hits.length) hits.forEach((h) => matched.add(h));
    else missing.push(w);
  }
  return { matched: [...matched], missing };
}

/** The house types after the edits; throws if an edit names a type the design doesn't have. */
export function editHouseTypes(
  types: HouseType[],
  edits: HouseTypeEdit[],
  lot: houseDesigner.Lot,
  rules: ZoningRules,
): HouseType[] {
  for (const e of edits)
    if (!types.some((t) => t.type.toLowerCase() === e.type.trim().toLowerCase()))
      throw new Error(
        `The design has no house type "${e.type}" (it has ${types.map((t) => t.type).join(", ")}).`,
      );
  return types.map((t) => {
    const e = edits.find((x) => x.type.trim().toLowerCase() === t.type.toLowerCase());
    if (!e) return t;
    const given = Object.fromEntries(
      Object.entries(e).filter(([k, v]) => k !== "type" && v !== undefined),
    );
    return withFootprint({ ...t, ...given }, lot, rules);
  });
}

export async function reviseDesign(
  req: RevisionRequest,
  onStep: (step: string) => void,
): Promise<RevisionResult> {
  const started = Date.now();
  const elapsed = () => `${Math.round((Date.now() - started) / 1000)}s`;

  const inputs = readJson<{ listing: Listing; lot: houseDesigner.Lot; rules: ZoningRules }>(
    join(req.baseDir, "inputs.json"),
  );
  const base = await loadStrategy(req.baseDir);
  if (!inputs || !base) throw new Error("the current design's files are missing.");
  const { listing, lot, rules } = inputs;
  const houseTypes = editHouseTypes(base.houseTypes, req.houseTypes, lot, rules);
  const strategy = { ...base, houseTypes };

  onStep("Drawing the revised plan…");
  const design = await houseDesigner.run(
    listing,
    lot,
    rules,
    strategy,
    (p) =>
      onStep(
        p.phase === "thinking"
          ? `Thinking about the revised layout… (${elapsed()})`
          : `Drawing the revised plan… ${p.chars.toLocaleString("en-US")} characters so far (${elapsed()})`,
      ),
    req.changes,
  );
  const dir = design.dir;
  await writeRevision(dir, {
    basedOn: basename(req.baseDir),
    title: req.title,
    changes: req.changes,
    changeOrderId: null,
    status: "proposed",
    createdAt: new Date().toISOString(),
  });

  try {
    onStep("Making the revised plan's PDF…");
    await refreshReports(dir);
    const pdfPath = `${dir}/plan.pdf`;
    const pngPath = `${dir}/plan.png`;
    await printPdf(design.htmlPath, pdfPath, { landscape: true });
    await screenshotSvg(design.svgPath, pngPath);

    const estimate = await estimateCost(dir, (s) => onStep(`Revised estimate: ${s}`));
    const timeline =
      req.timelineStart === null
        ? null
        : await planTimeline(dir, req.timelineStart, (s) => onStep(`Revised timeline: ${s}`));

    const { estimateDir, timelineDir } = currentDesign(listing.address);
    const oldEstimate = estimateDir ? readJson<Estimate>(join(estimateDir, "estimate.json")) : null;
    const oldTotals = oldEstimate ? tradeTotals(oldEstimate) : null;
    const newTotals = tradeTotals(estimate.estimate);
    const affected = oldTotals
      ? matchTrades(
          [...new Set([...oldTotals.keys(), ...newTotals.keys()])],
          req.affectedTrades,
        ).matched.map((trade) => ({
          trade,
          oldUsd: Math.round(oldTotals.get(trade) ?? 0),
          newUsd: Math.round(newTotals.get(trade) ?? 0),
        }))
      : [];
    const oldTimeline = timelineDir ? readJson<Timeline>(join(timelineDir, "timeline.json")) : null;
    const timelineDays =
      timeline && oldTimeline
        ? Math.round(
            (Date.parse(timeline.timeline.finishDate) - Date.parse(oldTimeline.finishDate)) /
              86_400_000,
          )
        : null;

    return {
      dir,
      baseDir: req.baseDir,
      pdfPath,
      pngPath,
      estimate,
      timeline,
      affected,
      baseEstimateDir: estimateDir,
      timelineDays,
      seconds: Math.round((Date.now() - started) / 1000),
    };
  } catch (err) {
    await markRevision(dir, { status: "discarded" });
    throw err;
  }
}
