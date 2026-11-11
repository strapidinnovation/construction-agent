/**
 * Skill: feasibility report (is it worth building, and should you sell or rent?).
 *
 * Wraps the feasibility agent (src/agents/feasibility.ts), which checks the
 * site (flood, soil, aquifer, utilities), finds comparable homes nearby, and
 * works out profit if sold and yield if rented.
 *
 * The report needs a cost estimate. If the plan doesn't have one yet, this
 * skill runs the estimate first (about 10 minutes) and then the report, so a
 * single request gives the whole picture. It also makes the PDF for Slack.
 */
import { existsSync } from "node:fs";
import * as feasibility from "../../agents/feasibility.ts";
import { refreshReports } from "../../refreshReports.ts";
import { printPdf } from "../render.ts";
import { estimateCost, type EstimateResult } from "./estimate.ts";

export type FeasibilityResult = {
  feasibility: feasibility.Feasibility;
  pdfPath: string;
  /** Set when the cost estimate had to be made first, so Slack can share it too. */
  estimate?: EstimateResult;
  seconds: number;
};

export async function feasibilityReport(
  planDir: string,
  onStep: (step: string) => void,
): Promise<FeasibilityResult> {
  const started = Date.now();

  let estimate: EstimateResult | undefined;
  if (!existsSync(`${planDir}/estimate.json`)) {
    onStep("No cost estimate yet, so estimating the cost first…");
    estimate = await estimateCost(planDir, onStep);
  }

  const report = await feasibility.run(planDir, (p) => onStep(`${p.step}…`));

  onStep("Making the PDF…");
  await refreshReports(planDir);
  const pdfPath = `${planDir}/feasibility.pdf`;
  await printPdf(report.htmlPath, pdfPath);

  return {
    feasibility: report,
    pdfPath,
    estimate,
    seconds: Math.round((Date.now() - started) / 1000),
  };
}
