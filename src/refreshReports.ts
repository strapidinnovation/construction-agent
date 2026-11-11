import { existsSync } from "node:fs";
import * as costEstimator from "./agents/costEstimator.ts";
import * as feasibility from "./agents/feasibility.ts";
import * as houseDesigner from "./agents/houseDesigner.ts";
import * as timelinePlanner from "./agents/timelinePlanner.ts";

/**
 * Rebuilds every HTML report in a plan folder from its saved data, so the tabs between
 * them stay current and plans made before HTML reports existed get them too.
 */
export async function refreshReports(planDir: string) {
  try {
    if (existsSync(`${planDir}/plan.svg`)) await houseDesigner.renderHtml(planDir);
    if (existsSync(`${planDir}/estimate.json`)) await costEstimator.renderHtml(planDir);
    if (existsSync(`${planDir}/timeline.json`)) await timelinePlanner.renderHtml(planDir);
    if (existsSync(`${planDir}/feasibility.json`)) await feasibility.renderHtml(planDir);
  } catch (err) {
    console.error(`Couldn't update the HTML reports: ${err instanceof Error ? err.message : err}`);
  }
}
