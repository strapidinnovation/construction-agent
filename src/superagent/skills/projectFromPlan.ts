/**
 * Skill: turn a finished design into a new construction project.
 *
 * Everything comes from the plan folder: the listing (inputs.json), the
 * design (strategy.json), and the cost estimate and timeline if they were
 * made. What a design can't know (client, team) is "TBD" until someone
 * changes it. Every stage starts "not started", so the project shows as
 * "planning".
 *
 * Nothing is saved here: the draft is shown to the user, and createProject
 * (projects.ts) saves it once they confirm. The project's documents need no
 * linking: projectDocuments.ts finds the output folders made for its address.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Estimate } from "../../agents/costEstimator.ts";
import type { Listing } from "../../agents/landSearch.ts";
import type { SiteStrategy } from "../../agents/sitePlanner.ts";
import { nextMonday, type Timeline } from "../../agents/timelinePlanner.ts";
import { listingOfPlan, streetOf } from "../plans.ts";
import { loadProjects, projectAt, STAGES, type Project, type ProjectFile } from "./projects.ts";

export const TBD = "TBD";

type Stage = (typeof STAGES)[number];

/** Typical weeks per stage for one house, used when the plan has no timeline yet. */
const TYPICAL_WEEKS: Record<Stage, number> = {
  "pre-construction": 3,
  permitting: 6,
  "site-prep": 1,
  foundation: 3,
  framing: 5,
  "dry-in": 2,
  "rough-ins": 3,
  "insulation-drywall": 3,
  exterior: 4,
  "interior-finishes": 5,
  "final-installs": 2,
  closeout: 2,
};

/** Which stage a timeline task belongs to: by its phase, and permit tasks go under permitting. */
function stageOf(task: { phase: string; name: string }): Stage | null {
  const phase = task.phase.toLowerCase();
  if (phase.startsWith("pre-construction"))
    return /permit|approval|replat|plat\b/i.test(task.name) ? "permitting" : "pre-construction";
  if (phase.includes("site")) return "site-prep";
  if (phase.includes("foundation")) return "foundation";
  if (phase.includes("framing")) return "framing";
  if (phase.includes("dry-in") || phase.includes("dry in")) return "dry-in";
  if (phase.includes("rough")) return "rough-ins";
  if (phase.includes("insulation") || phase.includes("drywall")) return "insulation-drywall";
  if (phase.includes("exterior")) return "exterior";
  if (phase.includes("interior")) return "interior-finishes";
  if (phase.includes("final")) return "final-installs";
  if (phase.includes("close")) return "closeout";
  return null;
}

const addDays = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

function stagesFromTimeline(t: Timeline): ProjectFile["stages"] {
  const spans = new Map<Stage, { start?: string; end: string }>();
  for (const task of t.tasks) {
    const stage = stageOf(task);
    if (!stage) continue;
    const span = spans.get(stage);
    // Lead times ("cabinet order") run long before a stage's work starts, so
    // waits only start the stages that are mostly waiting (approvals, permits).
    const starts = task.kind !== "wait" || stage === "pre-construction" || stage === "permitting";
    const start = starts && (!span?.start || task.start < span.start) ? task.start : span?.start;
    spans.set(stage, { start, end: !span || task.end > span.end ? task.end : span.end });
  }
  // A stage the timeline has no tasks for gets one day right after the stage before it.
  let previousEnd = t.startDate;
  return STAGES.map((stage) => {
    const span = spans.get(stage);
    const end = span?.end ?? addDays(previousEnd, 1);
    const start = span?.start ?? (previousEnd < end ? previousEnd : end);
    previousEnd = end > previousEnd ? end : previousEnd;
    return planned(stage, start, end);
  });
}

function typicalStages(start: string, homes: number): ProjectFile["stages"] {
  // More homes take longer, though not proportionally (crews work on several at once).
  const scale = 1 + (Math.max(1, homes) - 1) * 0.35;
  let at = start;
  return STAGES.map((stage) => {
    const begin = at;
    at = addDays(begin, Math.round(TYPICAL_WEEKS[stage] * 7 * scale));
    return planned(stage, begin, at);
  });
}

const planned = (stage: Stage, plannedStart: string, plannedEnd: string) => ({
  stage,
  plannedStart,
  plannedEnd,
  status: "not-started" as const,
  percent: 0,
});

const readJson = <T>(path: string): T | null =>
  existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : null;

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

// The street without its number ("corral ln") only if no other project uses it.
function aliasesFor(street: string): string[] {
  const taken = new Set(
    loadProjects()
      .flatMap((p) => [p.data.name, ...p.data.aliases])
      .map((a) => a.toLowerCase()),
  );
  const full = street.toLowerCase();
  const bare = full.replace(/^\d+\s+/, "");
  return bare === full || taken.has(bare) ? [full] : [full, bare];
}

// Rules typed in at the prompt or not found online save a placeholder district.
const zoningOf = (district?: string) =>
  !district || /^(user-entered|unknown)$/i.test(district) ? TBD : district;

function scopeLine(s: SiteStrategy): string {
  return s.houseTypes
    .map((t) => {
      const garage = t.garage === "none" ? "" : `, ${t.garage} garage`;
      const stories = `${t.stories} ${t.stories === 1 ? "story" : "stories"}`;
      return `${t.count} x ${t.name}: ${stories}, ${t.bedrooms} bed / ${t.bathrooms} bath, ${t.heatedSqft.toLocaleString("en-US")} sq ft${garage}`;
    })
    .join("; ");
}

export type ProjectDraft =
  | {
      kind: "draft";
      project: ProjectFile;
      /** Where the budget and dates came from, to show the user. */
      from: { estimate: boolean; timeline: boolean };
    }
  | { kind: "exists"; project: Project }
  | { kind: "error"; error: string };

/** The project a finished design would become, or the project already at that address. */
export function draftProject(planDir: string): ProjectDraft {
  const listing: Listing | null = listingOfPlan(planDir);
  const strategy = readJson<SiteStrategy>(join(planDir, "strategy.json"));
  if (!listing || !strategy) return { kind: "error", error: "That isn't a finished house plan." };
  const existing = projectAt(listing.address);
  if (existing) return { kind: "exists", project: existing };

  const inputs = readJson<{ rules?: { district?: string } }>(join(planDir, "inputs.json"));
  const estimate = readJson<Estimate>(join(planDir, "estimate.json"));
  const timeline = readJson<Timeline>(join(planDir, "timeline.json"));
  const street = streetOf(listing.address);
  const homes = strategy.homes;
  const name = homes === 1 ? `${street} Residence` : `${street} (${homes} homes)`;
  const heatedSqft = strategy.houseTypes.reduce((n, t) => n + t.heatedSqft * t.count, 0);
  const stages = timeline ? stagesFromTimeline(timeline) : typicalStages(nextMonday(), homes);
  const start = stages[0]!.plannedStart;
  const finish = stages
    .map((s) => s.plannedEnd)
    .sort()
    .at(-1)!;

  return {
    kind: "draft",
    from: { estimate: !!estimate, timeline: !!timeline },
    project: {
      id: slug(name),
      name,
      aliases: aliasesFor(street),
      client: TBD,
      site: {
        address: listing.address,
        zoning: zoningOf(inputs?.rules?.district),
        lotSqft: listing.lotSqft ?? 0,
      },
      scope: { homes, description: scopeLine(strategy), heatedSqft },
      team: { builder: TBD, projectManager: TBD, superintendent: TBD },
      dates: { start, plannedFinish: finish, forecastFinish: finish },
      budget: {
        contractUsd: Math.round(estimate?.totalUsd ?? 0),
        spentUsd: 0,
        approvedChangeOrdersUsd: 0,
      },
      onHold: null,
      stages,
      issues: [],
      inspections: [],
      updates: [
        {
          date: new Date().toISOString().slice(0, 10),
          author: "SuperAgent",
          note: `Project created from the design for ${listing.address}.`,
        },
      ],
      vendors: [],
    },
  };
}
