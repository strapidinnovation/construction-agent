/**
 * Skill: ongoing construction projects.
 *
 * Projects live in data/projects/, one JSON file per project (dummy data for
 * now). Each file holds the project's dates, its 12 construction stages, the
 * issues that came up (with how many days of delay each caused), inspections
 * and a site log.
 *
 * Who does what:
 *   - CODE works out every fact: current stage, % complete, days late, status
 *     (on track / at risk / delayed / on hold / completed), and the ranked list
 *     of what caused the delay. Numbers never come from the AI model, so they
 *     always match the data.
 *   - QWEN only writes the plain-English parts: a short "what's happening"
 *     summary and the "why is it late" explanation, from the facts code hands
 *     it. It is told to use nothing else.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { chatJson } from "../../llm.ts";
import { PROJECT_ROOT } from "../../paths.ts";
import { bestMatch } from "../match.ts";

const DIR = join(PROJECT_ROOT, "data", "projects");

/** The 12 standard stages, in order (the same breakdown the timeline agent uses). */
export const STAGES = [
  "pre-construction",
  "permitting",
  "site-prep",
  "foundation",
  "framing",
  "dry-in",
  "rough-ins",
  "insulation-drywall",
  "exterior",
  "interior-finishes",
  "final-installs",
  "closeout",
] as const;

const STAGE_LABEL: Record<(typeof STAGES)[number], string> = {
  "pre-construction": "Pre-construction",
  permitting: "Permitting",
  "site-prep": "Site prep",
  foundation: "Foundation",
  framing: "Framing",
  "dry-in": "Dry-in",
  "rough-ins": "Rough-ins",
  "insulation-drywall": "Insulation & drywall",
  exterior: "Exterior",
  "interior-finishes": "Interior finishes",
  "final-installs": "Final installs",
  closeout: "Close-out",
};

export const stageLabel = (s: (typeof STAGES)[number]) => STAGE_LABEL[s];

// ---------------------------------------------------------------------------
// The file format. Every project file is checked against this schema when it
// is loaded, so a typo in the data gives a clear error naming the file and
// field instead of a confusing answer later.
// ---------------------------------------------------------------------------

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "dates must be YYYY-MM-DD");
const stage = z.enum(STAGES);

const ProjectFile = z.object({
  id: z.string(),
  name: z.string(),
  /** Other names people may use: street name, short name, address. */
  aliases: z.array(z.string()),
  client: z.string(),
  site: z.object({ address: z.string(), zoning: z.string(), lotSqft: z.number() }),
  scope: z.object({ homes: z.number(), description: z.string(), heatedSqft: z.number() }),
  team: z.object({ builder: z.string(), projectManager: z.string(), superintendent: z.string() }),
  dates: z.object({
    start: isoDate,
    plannedFinish: isoDate,
    /** The project manager's current best guess for the finish date. */
    forecastFinish: isoDate,
    /** Only set once the project is finished. */
    actualFinish: isoDate.nullish(),
  }),
  budget: z.object({
    contractUsd: z.number(),
    spentUsd: z.number(),
    approvedChangeOrdersUsd: z.number(),
  }),
  /** Set when work is paused (e.g. financing); a paused project is "on hold", not "delayed". */
  onHold: z.object({ since: isoDate, reason: z.string() }).nullish(),
  stages: z.array(
    z.object({
      stage,
      plannedStart: isoDate,
      plannedEnd: isoDate,
      actualStart: isoDate.nullish(),
      actualEnd: isoDate.nullish(),
      /** For a stage in progress: when it is now expected to finish. */
      forecastEnd: isoDate.nullish(),
      status: z.enum(["done", "in-progress", "not-started"]),
      percent: z.number().min(0).max(100),
    }),
  ),
  issues: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      category: z.enum([
        "permit",
        "inspection",
        "material",
        "labor",
        "weather",
        "utility",
        "design",
        "change-order",
        "site-condition",
        "financing",
        "scheduling",
        "other",
      ]),
      status: z.enum(["open", "resolved"]),
      raisedOn: isoDate,
      resolvedOn: isoDate.nullish(),
      expectedResolution: isoDate.nullish(),
      /** Calendar days this issue pushed the schedule (0 = no delay, just something to track). */
      impactDays: z.number().min(0),
      stage,
      owner: z.string(),
      description: z.string(),
      nextStep: z.string().nullish(),
    }),
  ),
  inspections: z.array(
    z.object({
      name: z.string(),
      date: isoDate,
      result: z.enum(["passed", "failed", "scheduled"]),
      notes: z.string().optional(),
    }),
  ),
  updates: z.array(z.object({ date: isoDate, author: z.string(), note: z.string() })),
});
export type ProjectFile = z.infer<typeof ProjectFile>;
export type Issue = ProjectFile["issues"][number];

// ---------------------------------------------------------------------------
// Computed view of a project: the facts the agent reports.
// ---------------------------------------------------------------------------

export type ProjectStatus = "on-track" | "at-risk" | "delayed" | "on-hold" | "completed";

/**
 * Status thresholds, in calendar days between the planned and forecast finish.
 * Up to a week late is normal noise; more than three weeks is a real delay.
 */
export const ON_TRACK_MAX_DAYS = 7;
export const AT_RISK_MAX_DAYS = 21;

export type Project = {
  data: ProjectFile;
  status: ProjectStatus;
  /** Forecast (or actual) finish minus planned finish, in calendar days. Negative = early. */
  daysLate: number;
  /** Overall % complete: each stage's % weighted by how long the stage is planned to take. */
  percentComplete: number;
  /** Stages in progress right now (usually one, sometimes two that overlap). */
  current: ProjectFile["stages"];
  doneStages: number;
  /** How far behind its own plan the current stage is expected to finish, in days. */
  currentStageLateDays: number;
  /** Issues that caused delay, biggest first, open ones before resolved ones of the same size. */
  delayCauses: Issue[];
  openIssues: Issue[];
  /** The next inspection on the calendar, if any. */
  nextInspection?: ProjectFile["inspections"][number];
};

/** Days from date a to date b (both "YYYY-MM-DD"). */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

const today = () => new Date().toISOString().slice(0, 10);

/** Turn a raw project file into the facts the agent reports. */
function compute(data: ProjectFile): Project {
  const finish = data.dates.actualFinish ?? data.dates.forecastFinish;
  const daysLate = daysBetween(data.dates.plannedFinish, finish);

  const status: ProjectStatus = data.dates.actualFinish
    ? "completed"
    : data.onHold
      ? "on-hold"
      : daysLate <= ON_TRACK_MAX_DAYS
        ? "on-track"
        : daysLate <= AT_RISK_MAX_DAYS
          ? "at-risk"
          : "delayed";

  // A 6-week framing stage counts for more of the project than a 1-week
  // site-prep stage, so weight each stage by its planned length.
  const weight = (s: ProjectFile["stages"][number]) =>
    Math.max(1, daysBetween(s.plannedStart, s.plannedEnd));
  const total = data.stages.reduce((sum, s) => sum + weight(s), 0);
  const percentComplete = Math.round(
    data.stages.reduce((sum, s) => sum + weight(s) * s.percent, 0) / total,
  );

  const current = data.stages.filter((s) => s.status === "in-progress");
  const currentStageLateDays = Math.max(
    0,
    ...current.map((s) => (s.forecastEnd ? daysBetween(s.plannedEnd, s.forecastEnd) : 0)),
  );

  const delayCauses = data.issues
    .filter((i) => i.impactDays > 0)
    .sort(
      (a, b) =>
        b.impactDays - a.impactDays || Number(b.status === "open") - Number(a.status === "open"),
    );

  const nextInspection = data.inspections
    .filter((i) => i.result === "scheduled" && i.date >= today())
    .sort((a, b) => a.date.localeCompare(b.date))[0];

  return {
    data,
    status,
    daysLate,
    percentComplete,
    current,
    doneStages: data.stages.filter((s) => s.status === "done").length,
    currentStageLateDays,
    delayCauses,
    openIssues: data.issues.filter((i) => i.status === "open"),
    nextInspection,
  };
}

/**
 * Load and check every project file. Throws a clear error naming the file
 * and field if a file doesn't match the format.
 */
export function loadProjects(): Project[] {
  if (!existsSync(DIR)) return [];
  return readdirSync(DIR)
    .filter((f) => f.endsWith(".json"))
    .map((file) => {
      const raw = JSON.parse(readFileSync(join(DIR, file), "utf8")) as unknown;
      const parsed = ProjectFile.safeParse(raw);
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        throw new Error(
          `data/projects/${file} is not valid: ${first?.path.join(".")}: ${first?.message}`,
        );
      }
      return compute(parsed.data);
    });
}

/** Order for the list: the projects that need attention first. */
const STATUS_ORDER: Record<ProjectStatus, number> = {
  delayed: 0,
  "at-risk": 1,
  "on-hold": 2,
  "on-track": 3,
  completed: 4,
};

export type ProjectFilter = "all" | "behind" | "on-hold";

/**
 * Ongoing projects (completed ones are left out), most urgent first.
 * - "behind":  delayed or at risk.
 * - "on-hold": paused projects only.
 */
export function listProjects(filter: ProjectFilter = "all"): Project[] {
  return loadProjects()
    .filter((p) => p.status !== "completed")
    .filter((p) =>
      filter === "behind"
        ? p.status === "delayed" || p.status === "at-risk"
        : filter === "on-hold"
          ? p.status === "on-hold"
          : true,
    )
    .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.daysLate - a.daysLate);
}

// ---------------------------------------------------------------------------
// Finding a project from a loosely typed name ("river bend", "the Blessing
// Ave job", "12610"). Uses the shared matcher in ../match.ts, which is plain
// code, so it is predictable.
// ---------------------------------------------------------------------------

export type FindResult =
  | { kind: "found"; project: Project }
  | { kind: "ambiguous"; options: Project[] }
  | { kind: "not-found"; names: string[] };

/**
 * Find one project by name (completed ones included, so you can still ask
 * about them). The query is compared with each project's name, id and
 * aliases. Two projects matching equally well ("lane" matches two "... Lane
 * ..." names) come back as "ambiguous" so the bot can ask which one.
 */
export function findProject(query: string): FindResult {
  const all = loadProjects();
  const result = bestMatch(
    query,
    all,
    (p) => [p.data.name, p.data.id.replace(/-/g, " "), ...p.data.aliases],
    { extraFiller: ["project", "job", "site"] },
  );
  if (result.kind === "found") return { kind: "found", project: result.item };
  if (result.kind === "ambiguous") return { kind: "ambiguous", options: result.items };
  return { kind: "not-found", names: all.map((p) => p.data.name) };
}

// ---------------------------------------------------------------------------
// The plain-English parts, written by Qwen from code-computed facts.
// ---------------------------------------------------------------------------

/** "Apr 9, 2027" */
export function niceDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

const STATUS_TEXT: Record<ProjectStatus, string> = {
  "on-track": "on track",
  "at-risk": "at risk of delay",
  delayed: "delayed",
  "on-hold": "on hold",
  completed: "completed",
};
export const statusText = (s: ProjectStatus) => STATUS_TEXT[s];

/** All the facts about one project, written out for the model. */
function factSheet(p: Project): string {
  const d = p.data;
  const issue = (i: Issue) =>
    `- ${i.title} [${i.category}, ${i.status}, ${i.impactDays} days of delay, during ${stageLabel(i.stage)}]: ${i.description}` +
    (i.status === "open" && i.nextStep ? ` Next step: ${i.nextStep}` : "") +
    (i.status === "open" && i.expectedResolution
      ? ` Expected to be resolved ${niceDate(i.expectedResolution)}.`
      : "");
  return [
    `Today: ${niceDate(today())}`,
    `Project: ${d.name} at ${d.site.address} for ${d.client}. ${d.scope.description}.`,
    `Team: builder ${d.team.builder}, project manager ${d.team.projectManager}, superintendent ${d.team.superintendent}.`,
    `Status: ${statusText(p.status)}. Planned finish ${niceDate(d.dates.plannedFinish)}, ` +
      (d.dates.actualFinish
        ? `actually finished ${niceDate(d.dates.actualFinish)}`
        : `forecast finish ${niceDate(d.dates.forecastFinish)}`) +
      ` (${p.daysLate > 0 ? `${p.daysLate} days late` : p.daysLate < 0 ? `${-p.daysLate} days early` : "on time"}).`,
    // Spelled out so the model quotes the real figure instead of estimating it.
    ...(p.daysLate > 0
      ? [
          `Total delay: ${p.daysLate} days (about ${Math.round(p.daysLate / 7)} weeks), caused by all the delaying issues together, not by one alone.`,
        ]
      : []),
    ...(d.onHold ? [`On hold since ${niceDate(d.onHold.since)}: ${d.onHold.reason}`] : []),
    `Progress: ${p.percentComplete}% overall, ${p.doneStages} of ${d.stages.length} stages done.`,
    ...p.current.map(
      (s) =>
        `Current stage: ${stageLabel(s.stage)}, ${s.percent}% done, planned to end ${niceDate(s.plannedEnd)}` +
        (s.forecastEnd ? `, now expected ${niceDate(s.forecastEnd)}` : "") +
        ".",
    ),
    `Budget: $${d.budget.spentUsd.toLocaleString("en-US")} spent of $${d.budget.contractUsd.toLocaleString("en-US")}` +
      (d.budget.approvedChangeOrdersUsd
        ? ` plus $${d.budget.approvedChangeOrdersUsd.toLocaleString("en-US")} in approved change orders`
        : "") +
      ".",
    ...(p.nextInspection
      ? [`Next inspection: ${p.nextInspection.name} on ${niceDate(p.nextInspection.date)}.`]
      : []),
    `Issues:\n${d.issues.length ? d.issues.map(issue).join("\n") : "- none"}`,
    `Recent site log:\n${
      [...d.updates]
        .sort((a, b) => b.date.localeCompare(a.date))
        .slice(0, 4)
        .map((u) => `- ${niceDate(u.date)} (${u.author}): ${u.note}`)
        .join("\n") || "- none"
    }`,
  ].join("\n");
}

const WRITER = `You are a construction project manager briefing a colleague on Slack.
Use ONLY the facts given. Never invent dates, numbers, names, causes or plans.
When you say how late a project is, use the exact "Total delay" figure.
Write plain, friendly sentences. Use dates like "Nov 23". No headings, no bullet points, no markdown.`;

/** A short "what's happening" summary of one project. */
export async function summarizeProject(p: Project): Promise<string> {
  const raw = await chatJson(
    WRITER,
    `${factSheet(p)}\n\nIn 3 to 5 sentences: what stage the project is at and what is happening on site now, anything that is holding it up, and what happens next.`,
    z.toJSONSchema(z.object({ summary: z.string() })),
  );
  return (JSON.parse(raw) as { summary: string }).summary;
}

/** A short explanation of what is causing the delay, biggest cause first. */
export async function explainDelay(p: Project): Promise<string> {
  const raw = await chatJson(
    WRITER,
    `${factSheet(p)}\n\nIn 2 to 4 sentences, explain why this project is ${p.daysLate} days behind its planned finish: name the causes from the biggest to the smallest with their days, say which are still open and what is being done about them. Delays can overlap, so describe days as "added" or "cost", not as a total.`,
    z.toJSONSchema(z.object({ explanation: z.string() })),
  );
  return (JSON.parse(raw) as { explanation: string }).explanation;
}
