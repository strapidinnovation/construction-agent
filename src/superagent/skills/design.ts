/**
 * Skill: design houses on a lot.
 *
 * It runs the whole design pipeline without asking questions, because in
 * Slack nobody is sitting at a prompt. Where details are missing, it picks a
 * sensible answer and reports what it assumed:
 *
 *   1. Lot size     - from the listing, or what the user typed ("60x150",
 *                     "7500 sq ft"); otherwise an 8,000 sq ft assumption.
 *   2. Site rules   - researched on the web from official sources (zoning
 *                     district, setbacks, which housing types are allowed,
 *                     overlays, state laws); gaps and failures fall back to
 *                     typical residential defaults (siteRules.ts).
 *   3. Site plan    - the site planner agent decides how many homes fit and
 *                     what each one is (bedrooms, size, stories).
 *   4. Drawing      - the house designer agent draws the site plan and floor
 *                     plans as an SVG and writes plan.html.
 *   5. Slack files  - plan.pdf and plan.png are made from those (render.ts).
 *
 * Like every skill, it knows nothing about Slack. It reports progress through
 * the `onStep` callback and returns plain data.
 */
import * as houseDesigner from "../../agents/houseDesigner.ts";
import type { Listing } from "../../agents/landSearch.ts";
import * as sitePlanner from "../../agents/sitePlanner.ts";
import { researchSiteRules } from "../../agents/siteRules.ts";
import { DEFAULT_RULES, userRules, type ZoningRules } from "../../agents/zoning.ts";
import { refreshReports } from "../../refreshReports.ts";
import { printPdf, screenshotSvg } from "../render.ts";

/** Lot area assumed when neither the listing nor the user gives one. */
const FALLBACK_LOT_SQFT = 8000;

export type DesignResult = {
  /** The plan folder in output/, e.g. output/2026-11-11_10-40-00_8435-corral-ln-austin-tx-78745. */
  dir: string;
  pdfPath: string;
  pngPath: string;
  model: string;
  lot: houseDesigner.Lot;
  /** Explains where the lot size came from ("from the listing", "assumed", ...). */
  lotNote: string;
  rules: ZoningRules;
  /** True when real zoning data was found; false when defaults were used. */
  zoningFound: boolean;
  /** Explains why defaults were used, when they were. */
  zoningNote: string;
  strategy: sitePlanner.SiteStrategy;
  /** False if the model stopped before finishing the drawing. */
  complete: boolean;
  seconds: number;
};

/**
 * Work out the lot's width and depth.
 * `lotText` is the lot size the user gave: "60x150", "7500" or "".
 */
export function resolveLot(
  listing: Listing,
  lotText: string,
): { lot: houseDesigner.Lot; note: string } {
  const dims = lotText.match(/(\d+(?:\.\d+)?)\s*[x×*]\s*(\d+(?:\.\d+)?)/i);
  if (dims) {
    return {
      lot: { widthFt: Number(dims[1]), depthFt: Number(dims[2]) },
      note: "as you gave it",
    };
  }
  const area = Number(lotText.replace(/[^\d.]/g, ""));
  if (area >= 1000)
    return {
      lot: houseDesigner.estimateLot(area),
      note: `${area.toLocaleString("en-US")} sq ft as you gave it; width and depth estimated`,
    };
  if (listing.lotSqft)
    return {
      lot: houseDesigner.estimateLot(listing.lotSqft),
      note: `${listing.lotSqft.toLocaleString("en-US")} sq ft from the listing; width and depth estimated`,
    };
  return {
    lot: houseDesigner.estimateLot(FALLBACK_LOT_SQFT),
    note: `the listing has no lot size, so ${FALLBACK_LOT_SQFT.toLocaleString("en-US")} sq ft was assumed`,
  };
}

/** Research the site rules, falling back to common residential defaults. */
async function resolveRules(
  listing: Listing,
): Promise<{ rules: ZoningRules; found: boolean; note: string }> {
  const result = await researchSiteRules(listing);
  if (result.kind === "found") return { rules: result.rules, found: true, note: "" };
  return {
    rules: userRules(DEFAULT_RULES),
    found: false,
    note: `the site rules research failed (${result.reason})`,
  };
}

export async function designHouse(
  listing: Listing,
  lotText: string,
  onStep: (step: string) => void,
): Promise<DesignResult> {
  const started = Date.now();
  const elapsed = () => `${Math.round((Date.now() - started) / 1000)}s`;

  const { lot, note: lotNote } = resolveLot(listing, lotText);

  onStep("Researching the zoning and building rules for this land (1–8 minutes)…");
  const { rules, found: zoningFound, note: zoningNote } = await resolveRules(listing);

  onStep("Deciding how many homes fit and what each one should be…");
  const strategy = await sitePlanner.plan(listing, lot, rules);

  // The designer streams its answer; `chars` tells us how much it has written,
  // which we show so people can see it is still making progress.
  const design = await houseDesigner.run(listing, lot, rules, strategy, (p) =>
    onStep(
      p.phase === "thinking"
        ? `Thinking about the layout… (${elapsed()})`
        : `Drawing the plan… ${p.chars.toLocaleString("en-US")} characters so far (${elapsed()})`,
    ),
  );

  onStep("Making the PDF and preview image…");
  await refreshReports(design.dir);
  const pdfPath = `${design.dir}/plan.pdf`;
  const pngPath = `${design.dir}/plan.png`;
  // The drawing is wider than it is tall, so landscape pages show it much larger.
  await printPdf(design.htmlPath, pdfPath, { landscape: true });
  await screenshotSvg(design.svgPath, pngPath);

  return {
    dir: design.dir,
    pdfPath,
    pngPath,
    model: design.model,
    lot,
    lotNote,
    rules,
    zoningFound,
    zoningNote,
    strategy,
    complete: design.complete,
    seconds: Math.round((Date.now() - started) / 1000),
  };
}
