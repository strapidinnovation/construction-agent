/**
 * Skill: estimate what it costs to build the plan.
 *
 * Wraps the cost estimator agent (src/agents/costEstimator.ts). For each
 * house type in the plan, the agent first reads the plan into a "spec"
 * (sizes, rooms, finishes), then asks the model for materials and labor one
 * trade at a time (foundation, framing, roofing, ...), and adds a contingency.
 * It writes estimate.json, materials.md and materials.html into the plan folder.
 *
 * This skill adds what Slack needs on top: progress messages and a PDF of the
 * report (Slack can't show HTML).
 */
import * as costEstimator from "../../agents/costEstimator.ts";
import { refreshReports } from "../../refreshReports.ts";
import { printPdf } from "../render.ts";

export type EstimateResult = {
  estimate: costEstimator.Estimate;
  pdfPath: string;
  seconds: number;
};

export async function estimateCost(
  planDir: string,
  onStep: (step: string) => void,
): Promise<EstimateResult> {
  const started = Date.now();

  // The agent reports "[3/12] Framing" style progress: index out of total steps.
  const estimate = await costEstimator.run(planDir, (p) =>
    onStep(`Estimating ${p.step} (step ${p.index} of ${p.total})…`),
  );

  onStep("Making the PDF…");
  // Rebuild all reports so the tabs between plan, estimate and timeline stay in sync.
  await refreshReports(planDir);
  const pdfPath = `${planDir}/materials.pdf`;
  await printPdf(estimate.htmlPath, pdfPath);

  return { estimate, pdfPath, seconds: Math.round((Date.now() - started) / 1000) };
}
