/**
 * Skill: ongoing construction projects.
 *
 * Projects live in data/projects/, one JSON file per project (dummy data for
 * now, plus projects created from a finished design). Each file holds the
 * project's dates, its 12 construction stages, the issues that came up (with
 * how many days of delay each caused), inspections and a site log.
 *
 * Who does what:
 *   - CODE works out every fact: current stage, % complete, days late, status
 *     (planning / on track / at risk / delayed / on hold / completed), and the ranked list
 *     of what caused the delay. Numbers never come from the AI model, so they
 *     always match the data.
 *   - The agent reads those facts (list_projects, project_details) and writes
 *     the answer.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { PROJECT_ROOT } from "../../paths.ts";
import { bestMatch } from "../match.ts";

/** PROJECTS_DIR lets test scripts use their own copy. */
const DIR = process.env.PROJECTS_DIR || join(PROJECT_ROOT, "data", "projects");

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

export const ProjectFile = z.object({
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
  /** The vendors working on the project (ids in data/vendors.json) and the stages each works on. */
  vendors: z
    .array(
      z.object({
        vendorId: z.string(),
        stages: z.array(stage).min(1),
        /** What they do on this project. */
        scope: z.string(),
        contractUsd: z.number().nullish(),
      }),
    )
    .default([]),
});
export type ProjectFile = z.infer<typeof ProjectFile>;
export type Issue = ProjectFile["issues"][number];

// ---------------------------------------------------------------------------
// Computed view of a project: the facts the agent reports.
// ---------------------------------------------------------------------------

/** "planning": no stage has started yet (e.g. a project created from a design). */
export type ProjectStatus =
  "planning" | "on-track" | "at-risk" | "delayed" | "on-hold" | "completed";

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
  /** Each vendor's work on the project, with its status and dates worked out from the stages. */
  assignments: Assignment[];
};

/**
 * - done:     every stage they work on is done,
 * - working:  one of their stages is in progress,
 * - on-hold:  one of their stages is in progress, but the project is paused,
 * - upcoming: their next stage hasn't started (they may have finished earlier ones).
 */
export type AssignmentStatus = "done" | "working" | "on-hold" | "upcoming";

export type Assignment = ProjectFile["vendors"][number] & {
  status: AssignmentStatus;
  /** First day on site (actual if started, else planned). */
  start: string;
  /** Last day on site (actual if finished, else forecast or planned). */
  end: string;
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
      : data.stages.every((s) => s.status === "not-started")
        ? "planning"
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

  const assignments = data.vendors.map((v): Assignment => {
    const stages = data.stages.filter((s) => v.stages.includes(s.stage));
    return {
      ...v,
      status: stages.every((s) => s.status === "done")
        ? "done"
        : stages.some((s) => s.status === "in-progress")
          ? data.onHold
            ? "on-hold"
            : "working"
          : "upcoming",
      start: stages.map((s) => s.actualStart ?? s.plannedStart).sort()[0] ?? data.dates.start,
      end:
        stages
          .map((s) => s.actualEnd ?? s.forecastEnd ?? s.plannedEnd)
          .sort()
          .at(-1) ?? data.dates.plannedFinish,
    };
  });

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
    assignments,
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
  planning: 4,
  completed: 5,
};

/**
 * Which ongoing projects a list shows:
 * - "all":       every ongoing project.
 * - "delayed":   past their planned dates.
 * - "behind":    delayed or at risk.
 * - "attention": delayed, at risk or on hold (everything except on track).
 * - "on-hold":   paused projects only.
 * - "planning":  projects that haven't started construction.
 */
export const PROJECT_FILTERS = [
  "all",
  "delayed",
  "behind",
  "attention",
  "on-hold",
  "planning",
] as const;
export type ProjectFilter = (typeof PROJECT_FILTERS)[number];

const FILTER_STATUSES: Record<ProjectFilter, ProjectStatus[]> = {
  all: ["delayed", "at-risk", "on-hold", "on-track", "planning"],
  delayed: ["delayed"],
  behind: ["delayed", "at-risk"],
  attention: ["delayed", "at-risk", "on-hold"],
  "on-hold": ["on-hold"],
  planning: ["planning"],
};

/** Ongoing projects (completed ones are left out) that match `filter`, most urgent first. */
export function listProjects(filter: ProjectFilter = "all"): Project[] {
  return loadProjects()
    .filter((p) => FILTER_STATUSES[filter].includes(p.status))
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

const STATUS_TEXT: Record<ProjectStatus, string> = {
  planning: "planning (construction not started)",
  "on-track": "on track",
  "at-risk": "at risk of delay",
  delayed: "delayed",
  "on-hold": "on hold",
  completed: "completed",
};
export const statusText = (s: ProjectStatus) => STATUS_TEXT[s];

// ---------------------------------------------------------------------------
// Creating and changing projects. Only through the API or a change the user
// confirmed in the chat; each project is one file, written whole.
// ---------------------------------------------------------------------------

export class ProjectError extends Error {
  constructor(
    readonly kind: "not-found" | "not-allowed",
    message: string,
  ) {
    super(message);
  }
}

/** "8435 Corral Ln, Austin, TX 78745" -> street "8435-corral-ln" and ZIP "78745", to compare addresses. */
function addressKey(address: string): { street: string; zip?: string } {
  const street = (address.split(",")[0] ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return { street, zip: address.match(/\b\d{5}\b(?!.*\b\d{5}\b)/)?.[0] };
}

/** The project at this address (same street and, when both have one, ZIP), if any. */
export function projectAt(address: string): Project | undefined {
  const want = addressKey(address);
  return loadProjects().find((p) => {
    const have = addressKey(p.data.site.address);
    return have.street === want.street && (!have.zip || !want.zip || have.zip === want.zip);
  });
}

/** Writes are chained so two quick saves can't interleave. */
let saving: Promise<void> = Promise.resolve();

function write(data: ProjectFile): Promise<void> {
  const file = join(DIR, `${data.id}.json`);
  const snapshot = `${JSON.stringify(data, null, 2)}\n`;
  saving = saving.then(async () => {
    mkdirSync(DIR, { recursive: true });
    await writeFile(`${file}.tmp`, snapshot);
    await rename(`${file}.tmp`, file);
  });
  return saving;
}

export async function createProject(input: ProjectFile): Promise<Project> {
  const data = ProjectFile.parse(input);
  if (!/^[a-z0-9-]+$/.test(data.id))
    throw new ProjectError("not-allowed", `Bad project id "${data.id}".`);
  const all = loadProjects();
  if (all.some((p) => p.data.id === data.id))
    throw new ProjectError("not-allowed", `A project with the id "${data.id}" already exists.`);
  const there = projectAt(data.site.address);
  if (there)
    throw new ProjectError(
      "not-allowed",
      `${there.data.name} is already the project at ${data.site.address}.`,
    );
  await write(data);
  return compute(data);
}

/** The project fields that can be changed after it is created. */
export const ProjectPatch = z
  .object({
    name: z.string().min(1),
    client: z.string().min(1),
    builder: z.string().min(1),
    projectManager: z.string().min(1),
    superintendent: z.string().min(1),
    description: z.string().min(1),
    contractUsd: z.number().min(0),
  })
  .partial()
  .strict();
export type ProjectPatch = z.infer<typeof ProjectPatch>;

export async function updateProject(id: string, patch: ProjectPatch): Promise<Project> {
  const p = loadProjects().find((x) => x.data.id === id);
  if (!p) throw new ProjectError("not-found", `No project ${id}.`);
  const { name, client, builder, projectManager, superintendent, description, contractUsd } =
    ProjectPatch.parse(patch);
  const d = p.data;
  const data = ProjectFile.parse({
    ...d,
    name: name ?? d.name,
    client: client ?? d.client,
    team: {
      builder: builder ?? d.team.builder,
      projectManager: projectManager ?? d.team.projectManager,
      superintendent: superintendent ?? d.team.superintendent,
    },
    scope: { ...d.scope, description: description ?? d.scope.description },
    budget: { ...d.budget, contractUsd: contractUsd ?? d.budget.contractUsd },
  });
  await write(data);
  return compute(data);
}

const addDays = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/**
 * An approved change order: add its amount to the approved change orders,
 * move the forecast finish by its days and note it in the site log. The
 * original contract and planned finish stay, so original + changes = current.
 */
export async function addChangeOrder(
  id: string,
  co: { id: string; title: string; amountUsd: number; daysAdded: number },
): Promise<Project> {
  const p = loadProjects().find((x) => x.data.id === id);
  if (!p) throw new ProjectError("not-found", `No project ${id}.`);
  const d = p.data;
  const money = `${co.amountUsd < 0 ? "-" : "+"}$${Math.abs(co.amountUsd).toLocaleString("en-US")}`;
  const days = co.daysAdded ? `, ${co.daysAdded > 0 ? "+" : ""}${co.daysAdded} days` : "";
  const data: ProjectFile = {
    ...d,
    budget: {
      ...d.budget,
      approvedChangeOrdersUsd:
        Math.round((d.budget.approvedChangeOrdersUsd + co.amountUsd) * 100) / 100,
    },
    dates: { ...d.dates, forecastFinish: addDays(d.dates.forecastFinish, co.daysAdded) },
    updates: [
      {
        date: today(),
        author: "SuperAgent",
        note: `Change order ${co.id} approved: ${co.title} (${money}${days}).`,
      },
      ...d.updates,
    ],
  };
  await write(data);
  return compute(data);
}

/** A project change the agent proposed and the user has to confirm. */
export type ProjectChange = { entity: "project" } & (
  { action: "create"; input: ProjectFile } | { action: "update"; id: string; patch: ProjectPatch }
);

export function applyProjectChange(change: ProjectChange): Promise<Project> {
  return change.action === "create"
    ? createProject(change.input)
    : updateProject(change.id, change.patch);
}
