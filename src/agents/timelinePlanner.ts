import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { z } from "zod";
import { ESTIMATE_MODEL, chatJson } from "../llm.ts";
import { callout, card, esc, list, page, section } from "../report.ts";
import {
  CONSTRUCTION_TYPE,
  loadEstimate,
  readPlanSpec,
  specSummary,
  withRetry,
  type HouseSpec,
  type TradeEstimate,
} from "./costEstimator.ts";
import {
  STRATEGY_LABEL,
  homes as homesOf,
  loadStrategy,
  type SiteStrategy,
} from "./sitePlanner.ts";

const WEATHER_BUFFER = 0.1;

type PhaseGroup = { prefix: string; label: string; taskRange: string; checklist: string };

const PHASE_GROUPS: PhaseGroup[] = [
  {
    prefix: "A",
    label: "Pre-construction to foundation",
    taskRange: "12 to 18",
    checklist: `1. Pre-construction: boundary/topo survey, final construction drawings, structural engineering,
   City of Austin residential permit application and review, utility service applications
   (Austin Energy, Austin Water), builder contract and financing, subdivision/replat approval
   (only if the project subdivides), permit issued (milestone)
2. Site preparation: clearing, erosion control/silt fence, temporary power, portable toilet,
   construction entrance, building layout and staking
3. Foundation: under-slab plumbing, under-slab plumbing inspection, excavate grade beams, forms,
   vapor barrier, rebar, foundation inspection, concrete pour, cure time`,
  },
  {
    prefix: "B",
    label: "Framing to drywall",
    taskRange: "12 to 18",
    checklist: `4. Framing: wall framing, roof trusses, roof and wall sheathing, windows and exterior doors,
   framing inspection
5. Dry-in: roofing, house wrap and flashing, dried-in (milestone)
6. Rough-ins: plumbing, electrical and HVAC rough-in, combined rough-in inspection
7. Insulation: wall and attic insulation, insulation/energy inspection
8. Drywall: hang, tape, texture`,
  },
  {
    prefix: "C",
    label: "Exterior, finishes and close-out",
    taskRange: "14 to 20",
    checklist: `9. Exterior: siding and trim, exterior paint, gutters, driveway and flatwork, final grading
10. Interior finishes: cabinet order and lead time, cabinets, countertops (template + fabrication
    lead time), tile, flooring, interior doors and trim, interior paint
11. Final installs: plumbing, electrical and HVAC trim-out, appliances, fixtures
12. Close-out: final inspections (building, plumbing, electrical, mechanical), certificate of
    occupancy, punch list, final cleaning, handover / move-in (milestone)`,
  },
];

// Permit figures: City of Austin issued-permit data, new single-family homes, 2026
// (median ~48-52 calendar days application-to-issue; middle half 24-94 days).
const REFERENCE_DURATIONS = `- Survey: 5-10 working days. Construction drawings + structural engineering: 15-30 working days.
- City of Austin permit, application to issuance (several review cycles + revisions):
  about 35 working days typical, 17-65 working days for most projects.
- Utility service applications run in parallel with permit review.
- Subdivision/replat approval (only when subdividing): often several months; use about
  120 working days, before building permits are issued.
- Slab concrete cure before framing loads: 7 calendar days minimum.
- Inspections: 1-3 working days each including scheduling.
- Countertop template to install: 10-15 working days. Cabinet lead time: 20-30 working days
  (order once drawings are final).
- Groundbreaking to completion for a typical 1-2 story wood-frame house: 6-9 months.`;

const TimelineSchema = z.object({
  tasks: z.array(
    z.object({
      id: z.string(),
      phase: z.string(),
      name: z.string(),
      durationDays: z.number(),
      crew: z.string(),
      dependsOn: z.array(z.string()),
      kind: z.enum(["work", "inspection", "milestone", "wait"]),
      outdoor: z.boolean(),
      perHome: z.boolean(),
      notes: z.string(),
    }),
  ),
  assumptions: z.array(z.string()),
  risks: z.array(z.string()),
});

type RawTask = z.infer<typeof TimelineSchema>["tasks"][number];

export type ScheduledTask = Omit<RawTask, "dependsOn"> & {
  dependsOn: string[];
  workdays: number;
  startOffset: number;
  endOffset: number;
  start: string;
  end: string;
  critical: boolean;
};

export type Timeline = {
  model: string;
  planDir: string;
  location: string;
  usedEstimate: boolean;
  homes: number;
  startDate: string;
  finishDate: string;
  workdays: number;
  calendarWeeks: number;
  tasks: ScheduledTask[];
  assumptions: string[];
  risks: string[];
  markdownPath: string;
  htmlPath: string;
  jsonPath: string;
};

export type TimelineProgress = { step: string };

// ---------- calendar ----------

const iso = (d: Date) => d.toISOString().slice(0, 10);

function utcDate(y: number, m: number, d: number): Date {
  return new Date(Date.UTC(y, m, d));
}

function nthWeekday(y: number, m: number, weekday: number, n: number): Date {
  const first = utcDate(y, m, 1);
  const offset = (weekday - first.getUTCDay() + 7) % 7;
  return utcDate(y, m, 1 + offset + (n - 1) * 7);
}

function lastWeekday(y: number, m: number, weekday: number): Date {
  const last = utcDate(y, m + 1, 0);
  const offset = (last.getUTCDay() - weekday + 7) % 7;
  return utcDate(y, m, last.getUTCDate() - offset);
}

function observed(d: Date): Date {
  const day = d.getUTCDay();
  if (day === 6) return utcDate(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - 1);
  if (day === 0) return utcDate(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  return d;
}

const holidayCache = new Map<number, Set<string>>();

function federalHolidays(y: number): Set<string> {
  const cached = holidayCache.get(y);
  if (cached) return cached;
  const days = [
    observed(utcDate(y, 0, 1)), // New Year's Day
    nthWeekday(y, 0, 1, 3), // Martin Luther King Jr. Day
    nthWeekday(y, 1, 1, 3), // Presidents' Day
    lastWeekday(y, 4, 1), // Memorial Day
    observed(utcDate(y, 5, 19)), // Juneteenth
    observed(utcDate(y, 6, 4)), // Independence Day
    nthWeekday(y, 8, 1, 1), // Labor Day
    nthWeekday(y, 9, 1, 2), // Columbus Day
    observed(utcDate(y, 10, 11)), // Veterans Day
    nthWeekday(y, 10, 4, 4), // Thanksgiving
    observed(utcDate(y, 11, 25)), // Christmas
  ];
  const set = new Set(days.map(iso));
  holidayCache.set(y, set);
  return set;
}

function isWorkday(d: Date): boolean {
  const day = d.getUTCDay();
  return day !== 0 && day !== 6 && !federalHolidays(d.getUTCFullYear()).has(iso(d));
}

function workdayCalendar(start: Date) {
  const days: Date[] = [];
  let cursor = new Date(start);
  return (offset: number): Date => {
    while (days.length <= offset) {
      while (!isWorkday(cursor)) cursor = new Date(cursor.getTime() + 86_400_000);
      days.push(cursor);
      cursor = new Date(cursor.getTime() + 86_400_000);
    }
    return days[offset];
  };
}

export function nextMonday(from = new Date()): string {
  const d = utcDate(from.getFullYear(), from.getMonth(), from.getDate() + 1);
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
  return iso(d);
}

// ---------- scheduling ----------

function schedule(raw: RawTask[], startDate: string): ScheduledTask[] {
  const seen = new Set<string>();
  const tasks = raw.map((t, i) => {
    let id = t.id.trim() || `T${i + 1}`;
    if (seen.has(id)) id = `${id}_${i + 1}`;
    seen.add(id);
    return { ...t, id };
  });

  const index = new Map(tasks.map((t, i) => [t.id, i]));
  const deps = tasks.map((t, i) => {
    const valid = [...new Set(t.dependsOn)].filter((d) => (index.get(d) ?? Infinity) < i);
    return valid.length === 0 && i > 0 ? [tasks[i - 1].id] : valid;
  });

  const workdays = tasks.map((t) => {
    if (t.kind === "milestone") return 0;
    const base = Math.max(1, Math.round(t.durationDays));
    return t.outdoor ? Math.ceil(base * (1 + WEATHER_BUFFER)) : base;
  });

  const startOffsets: number[] = [];
  const endOffsets: number[] = [];
  tasks.forEach((_, i) => {
    startOffsets[i] = Math.max(0, ...deps[i].map((d) => endOffsets[index.get(d)!]));
    endOffsets[i] = startOffsets[i] + workdays[i];
  });

  const projectEnd = Math.max(...endOffsets);
  const latestFinish = tasks.map(() => projectEnd);
  for (let i = tasks.length - 1; i >= 0; i--) {
    for (const d of deps[i]) {
      const j = index.get(d)!;
      latestFinish[j] = Math.min(latestFinish[j], latestFinish[i] - workdays[i]);
    }
  }

  const day = workdayCalendar(new Date(`${startDate}T00:00:00Z`));
  return tasks.map((t, i) => {
    const start = workdays[i] === 0 && startOffsets[i] > 0 ? startOffsets[i] - 1 : startOffsets[i];
    const end = workdays[i] === 0 ? start : endOffsets[i] - 1;
    return {
      ...t,
      dependsOn: deps[i],
      workdays: workdays[i],
      startOffset: startOffsets[i],
      endOffset: endOffsets[i],
      start: iso(day(start)),
      end: iso(day(end)),
      critical: latestFinish[i] === endOffsets[i],
    };
  });
}

// ---------- model ----------

type Project = {
  spec: HouseSpec;
  location: string;
  labor: TradeEstimate[] | null;
  strategy: SiteStrategy | null;
  homeIds: string[];
};

function projectText(p: Project): string {
  const subdivide = p.strategy?.strategy === "subdivide";
  const scope =
    p.homeIds.length > 1
      ? `PROJECT: ${p.homeIds.length} homes (${STRATEGY_LABEL[p.strategy!.strategy]}). Plan the tasks
for ONE home; the schedule repeats your perHome tasks for every home, with crews moving from
home to home.`
      : "PROJECT: one home.";
  return `${scope}
- perHome is true for work and inspections done on each house (foundation through final
  inspections and certificate of occupancy), false for tasks done once for the whole project
  (survey, drawings, engineering, approvals, permit review, utility applications, contract and
  financing, clearing, erosion control, temporary power, construction entrance).${
    subdivide
      ? `\n- The land is being subdivided: in pre-construction add a subdivision/replat approval
  (kind "wait", perHome false) that the permit depends on.`
      : ""
  }`;
}

function laborSummary(trades: TradeEstimate[]): string {
  return trades
    .map((t) => {
      const hours = t.labor.reduce((s, l) => s + l.crewHours, 0);
      const tasks = t.labor.map((l) => `${l.task} ${l.crewHours}h`).join("; ");
      return `- ${t.name}: ${Math.round(hours)} crew hours total (${tasks})`;
    })
    .join("\n");
}

async function planGroup(
  group: PhaseGroup,
  earlier: RawTask[],
  project: Project,
): Promise<z.infer<typeof TimelineSchema>> {
  const { spec, location, labor } = project;
  const system = `You are a residential construction project manager building a realistic schedule
for new residential construction at ${location}. Construction type: ${CONSTRUCTION_TYPE}.

${projectText(project)}

The schedule is built in three parts. Now create ONLY the tasks for part "${group.label}",
in the order the work happens. Cover every phase in this checklist (add tasks if needed,
skip ones that do not apply):
${group.checklist}

Typical durations to calibrate against:
${REFERENCE_DURATIONS}

Rules:
- ${group.taskRange} tasks. Ids are ${group.prefix}1, ${group.prefix}2, ${group.prefix}3, ...
- durationDays is in working days (Mon-Fri, 8-hour days) for the crew named.
  ${labor ? "Base work durations on the labor crew hours provided: days = crew hours / (crew size x 8)." : "Use typical durations for a house of this size."}
- Include waiting time as kind "wait" (permit review, concrete cure, inspection scheduling,
  countertop fabrication, material lead times). Inspections are kind "inspection" (usually 1-2 days).
  Milestones are kind "milestone" with durationDays 0.
- dependsOn lists the ids of tasks that must finish first: tasks in this part, or the earlier
  tasks listed below. Let independent work overlap (e.g. exterior siding can run while interior
  drywall happens).
- outdoor is true for weather-sensitive work (site work, foundation, framing, roofing, siding,
  exterior paint, flatwork).
- Keep text short: crew like "Framing crew (4)", notes at most 12 words or an empty string.
- List up to 4 assumptions and up to 4 schedule risks for this part.`;

  const earlierList = earlier.length
    ? `\n\nEARLIER TASKS (already scheduled, you may depend on them)\n` +
      earlier.map((t) => `- ${t.id}: ${t.name} (${t.phase})`).join("\n")
    : "";
  const user =
    `HOUSE SPEC (one home)\n${specSummary(spec)}` +
    (labor ? `\n\nLABOR FROM THE COST ESTIMATE (one home)\n${laborSummary(labor)}` : "") +
    earlierList;

  const raw = await chatJson(system, user, z.toJSONSchema(TimelineSchema), {
    model: ESTIMATE_MODEL,
    numPredict: 12000,
    numCtx: 24576,
  });
  const parsed = TimelineSchema.parse(JSON.parse(raw));
  if (parsed.tasks.length < 3) throw new Error(`Too few tasks for "${group.label}".`);

  const ownIds = new Map(parsed.tasks.map((t, i) => [t.id, `${group.prefix}${i + 1}`]));
  parsed.tasks = parsed.tasks.map((t, i) => ({
    ...t,
    id: `${group.prefix}${i + 1}`,
    dependsOn: t.dependsOn.map((d) => ownIds.get(d) ?? d),
  }));
  return parsed;
}

function uniqueText(items: string[]): string[] {
  const seen = new Set<string>();
  return items.filter((s) => {
    const key = s.trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Repeats per-home tasks for each home; a crew finishes a task on one home before the next. */
function expandForHomes(raw: RawTask[], homeIds: string[]): RawTask[] {
  if (homeIds.length <= 1) return raw;
  const perHome = new Set(raw.filter((t) => t.perHome).map((t) => t.id));
  const out: RawTask[] = [];
  for (const t of raw) {
    if (!perHome.has(t.id)) {
      out.push({
        ...t,
        dependsOn: t.dependsOn.flatMap((d) =>
          perHome.has(d) ? homeIds.map((h) => `${d}-${h}`) : [d],
        ),
      });
      continue;
    }
    homeIds.forEach((h, k) => {
      const dependsOn = t.dependsOn.map((d) => (perHome.has(d) ? `${d}-${h}` : d));
      if (k > 0 && t.kind === "work") dependsOn.push(`${t.id}-${homeIds[k - 1]}`);
      out.push({ ...t, id: `${t.id}-${h}`, name: `${t.name} - ${h}`, dependsOn });
    });
  }
  return out;
}

async function planTasks(
  project: Project,
  onProgress?: (p: TimelineProgress) => void,
): Promise<z.infer<typeof TimelineSchema>> {
  const tasks: RawTask[] = [];
  const assumptions: string[] = [];
  const risks: string[] = [];

  for (const [i, group] of PHASE_GROUPS.entries()) {
    onProgress?.({ step: `Planning tasks (${i + 1}/${PHASE_GROUPS.length}): ${group.label}` });
    const part = await withRetry(() => planGroup(group, tasks, project));
    tasks.push(...part.tasks);
    assumptions.push(...part.assumptions);
    risks.push(...part.risks);
  }
  return { tasks, assumptions: uniqueText(assumptions), risks: uniqueText(risks) };
}

// ---------- markdown ----------

const fmt = (isoDate: string) =>
  new Date(`${isoDate}T00:00:00Z`).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
const mermaidText = (s: string) =>
  s
    .replace(/[:;#,]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

function nextCalendarDay(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return iso(d);
}

function phases(tasks: ScheduledTask[]): { name: string; tasks: ScheduledTask[] }[] {
  const map = new Map<string, ScheduledTask[]>();
  for (const t of tasks) map.set(t.phase, [...(map.get(t.phase) ?? []), t]);
  return [...map].map(([name, list]) => ({ name, tasks: list }));
}

function toMarkdown(t: Timeline): string {
  const lines: string[] = [];
  const critical = t.tasks.filter((x) => x.critical && x.workdays > 0);

  lines.push("# Construction Timeline", "");
  lines.push(`**Location:** ${t.location}  `);
  lines.push(`**Plan:** \`${basename(t.planDir)}\`  `);
  lines.push(`**Generated by:** ${t.model} on ${new Date().toLocaleString("en-US")}  `);
  lines.push(
    `**Based on:** ${t.usedEstimate ? "house spec + labor hours from the cost estimate" : "house spec only (no cost estimate yet)"}`,
    "",
  );
  lines.push("| | |", "|---|---|");
  lines.push(`| Homes | ${t.homes} |`);
  lines.push(`| Start | ${fmt(t.startDate)} |`);
  lines.push(`| Estimated completion | **${fmt(t.finishDate)}** |`);
  lines.push(`| Duration | ${t.workdays} working days (~${t.calendarWeeks} calendar weeks) |`);
  lines.push(`| Tasks | ${t.tasks.length} (${critical.length} on the critical path) |`, "");
  lines.push(
    "> Rough planning schedule generated by an AI model. Working days are Mon-Fri excluding " +
      `US federal holidays, with a ${WEATHER_BUFFER * 100}% weather buffer on outdoor work. ` +
      "Permit review and inspection wait times vary; confirm them with the City of Austin and your builder.",
    "",
  );

  lines.push("## Milestones", "", "| Milestone | Date |", "|---|---|");
  for (const m of t.tasks.filter((x) => x.kind === "milestone")) {
    lines.push(`| ${cell(m.name)} | ${fmt(m.start)} |`);
  }
  lines.push(`| Project complete | ${fmt(t.finishDate)} |`, "");

  lines.push("## Phases", "", "| Phase | Start | End | Working days |", "|---|---|---|---:|");
  for (const p of phases(t.tasks)) {
    const start = Math.min(...p.tasks.map((x) => x.startOffset));
    const end = Math.max(...p.tasks.map((x) => x.endOffset));
    const first = p.tasks.reduce((a, b) => (a.start <= b.start ? a : b));
    const last = p.tasks.reduce((a, b) => (a.end >= b.end ? a : b));
    lines.push(`| ${cell(p.name)} | ${fmt(first.start)} | ${fmt(last.end)} | ${end - start} |`);
  }
  lines.push("");

  lines.push("## Gantt chart", "", "```mermaid", "gantt");
  lines.push("  title Construction schedule", "  dateFormat YYYY-MM-DD", "  axisFormat %b %d");
  for (const p of phases(t.tasks)) {
    lines.push(`  section ${mermaidText(p.name)}`);
    for (const x of p.tasks) {
      const tags = [x.critical ? "crit" : "", x.kind === "milestone" ? "milestone" : ""]
        .filter(Boolean)
        .join(", ");
      const prefix = tags ? `${tags}, ` : "";
      const span =
        x.kind === "milestone" ? `${x.start}, 0d` : `${x.start}, ${nextCalendarDay(x.end)}`;
      lines.push(`  ${mermaidText(x.name)} :${prefix}${span}`);
    }
  }
  lines.push("```", "");

  lines.push("## Detailed schedule", "");
  lines.push("| ID | Phase | Task | Start | End | Days | Crew | Depends on | Critical | Notes |");
  lines.push("|---|---|---|---|---|---:|---|---|:---:|---|");
  for (const x of t.tasks) {
    const name = x.kind === "milestone" ? `**${cell(x.name)}**` : cell(x.name);
    lines.push(
      `| ${x.id} | ${cell(x.phase)} | ${name} | ${x.start} | ${x.end} | ${x.workdays} | ${cell(x.crew)} | ${x.dependsOn.join(", ")} | ${x.critical ? "yes" : ""} | ${cell(x.notes)} |`,
    );
  }
  lines.push("");

  lines.push("## Inspections", "", "| Inspection | Date |", "|---|---|");
  for (const x of t.tasks.filter((y) => y.kind === "inspection")) {
    lines.push(`| ${cell(x.name)} | ${fmt(x.start)} |`);
  }
  lines.push("");

  lines.push("## Critical path", "");
  lines.push(
    "Any delay to these tasks moves the completion date:",
    "",
    critical.map((x) => x.name).join(" → "),
    "",
  );

  lines.push("## Assumptions", "");
  for (const a of t.assumptions) lines.push(`- ${a}`);
  lines.push("", "## Risks", "");
  for (const r of t.risks) lines.push(`- ${r}`);
  lines.push("");
  return lines.join("\n");
}

// ---------- html ----------

const KIND_LABEL: Record<RawTask["kind"], string> = {
  work: "Work",
  inspection: "Inspection",
  wait: "Wait",
  milestone: "Milestone",
};

function monthTicks(t: Timeline): { offset: number; label: string }[] {
  const day = workdayCalendar(new Date(`${t.startDate}T00:00:00Z`));
  const ticks: { offset: number; label: string }[] = [];
  let lastMonth = -1;
  for (let i = 0; i < t.workdays; i++) {
    const d = day(i);
    if (d.getUTCMonth() !== lastMonth) {
      lastMonth = d.getUTCMonth();
      ticks.push({
        offset: i,
        label: d.toLocaleDateString("en-US", { month: "short", year: "2-digit", timeZone: "UTC" }),
      });
    }
  }
  return ticks;
}

function gantt(t: Timeline): string {
  const total = Math.max(1, t.workdays);
  const pct = (n: number) => `${((n / total) * 100).toFixed(2)}%`;
  // Drop a label that would collide with the next one (e.g. a project starting late in a month).
  const ticks = monthTicks(t).filter(
    (x, i, all) => i === all.length - 1 || all[i + 1].offset - x.offset >= total * 0.1,
  );
  const grid = ticks
    .map((x) => `linear-gradient(#e6e9ef,#e6e9ef) ${pct(x.offset)} 0 / 1px 100% no-repeat`)
    .join(",");

  const head =
    `<div class="gantt-head"><span></span><div class="scale">` +
    ticks
      .map((x) => `<span class="tick" style="left:${pct(x.offset)}">${esc(x.label)}</span>`)
      .join("") +
    `</div></div>`;

  const rows = phases(t.tasks)
    .map((p) => {
      const bars = p.tasks
        .map((x) => {
          const cls = ["gantt-bar", `k-${x.kind}`, x.critical && x.workdays > 0 ? "crit" : ""]
            .filter(Boolean)
            .join(" ");
          const width = x.kind === "milestone" ? "" : `;width:${pct(Math.max(0.3, x.workdays))}`;
          const tip = `${x.name}: ${x.start} to ${x.end}, ${x.workdays} working days`;
          return (
            `<div class="gantt-row"><span class="name" title="${esc(x.name)}">${esc(x.name)}</span>` +
            `<div class="gantt-track"><div class="${cls}" style="left:${pct(x.startOffset)}${width}" ` +
            `title="${esc(tip)}"></div></div></div>`
          );
        })
        .join("");
      return `<div class="gantt-phase">${esc(p.name)}</div>${bars}`;
    })
    .join("");

  const legend =
    `<div class="legend"><span><i style="background:#60a5fa"></i>Work</span>` +
    `<span><i style="background:#f59e0b"></i>Inspection</span><span><i style="background:#a78bfa"></i>Wait</span>` +
    `<span><i style="background:#dc2626"></i>Critical path</span><span><i style="background:#16a34a"></i>Milestone</span></div>`;

  return `${legend}<div class="gantt" style="--grid:${grid}">${head}${rows}</div>`;
}

function toHtml(t: Timeline): string {
  const critical = t.tasks.filter((x) => x.critical && x.workdays > 0);
  const milestones = t.tasks.filter((x) => x.kind === "milestone");

  const milestoneCards =
    `<div class="milestones">` +
    [
      ...milestones.map((m) => ({ name: m.name, date: m.start })),
      { name: "Project complete", date: t.finishDate },
    ]
      .map(
        (m) =>
          `<div class="milestone"><strong>${esc(m.name)}</strong><div class="date">${esc(fmt(m.date))}</div></div>`,
      )
      .join("") +
    `</div>`;

  const phaseRows = phases(t.tasks)
    .map((p) => {
      const start = Math.min(...p.tasks.map((x) => x.startOffset));
      const end = Math.max(...p.tasks.map((x) => x.endOffset));
      const first = p.tasks.reduce((a, b) => (a.start <= b.start ? a : b));
      const last = p.tasks.reduce((a, b) => (a.end >= b.end ? a : b));
      return (
        `<tr><td>${esc(p.name)}</td><td>${esc(fmt(first.start))}</td><td>${esc(fmt(last.end))}</td>` +
        `<td class="num">${end - start}</td><td class="num">${p.tasks.length}</td></tr>`
      );
    })
    .join("");

  const taskRows = t.tasks
    .map(
      (x) =>
        `<tr><td>${esc(x.id)}</td><td>${esc(x.name)}</td><td><span class="badge k-${x.kind}">${KIND_LABEL[x.kind]}</span>` +
        `${x.critical && x.workdays > 0 ? ' <span class="badge crit">Critical</span>' : ""}</td>` +
        `<td>${esc(x.start)}</td><td>${esc(x.end)}</td><td class="num">${x.workdays}</td>` +
        `<td>${esc(x.crew)}</td><td>${esc(x.dependsOn.join(", "))}</td><td>${esc(x.notes)}</td></tr>`,
    )
    .join("");

  const inspections = t.tasks
    .filter((x) => x.kind === "inspection")
    .map((x) => `<tr><td>${esc(x.name)}</td><td>${esc(fmt(x.start))}</td></tr>`)
    .join("");

  const body =
    `<div class="cards">` +
    card("Start", fmt(t.startDate)) +
    card("Estimated completion", fmt(t.finishDate)) +
    card("Duration", `${t.workdays} working days`, `~${t.calendarWeeks} calendar weeks`) +
    card("Homes", String(t.homes)) +
    card("Tasks", String(t.tasks.length), `${critical.length} on the critical path`) +
    `</div>` +
    callout(
      `Rough planning schedule generated by an AI model. Working days are Mon-Fri excluding US federal holidays, ` +
        `with a ${WEATHER_BUFFER * 100}% weather buffer on outdoor work. Permit review and inspection wait times vary; ` +
        "confirm them with the City of Austin and your builder.",
    ) +
    section("Milestones", milestoneCards) +
    section("Schedule", gantt(t)) +
    section(
      "Phases",
      `<div class="table-scroll"><table><tr><th>Phase</th><th>Start</th><th>End</th>` +
        `<th class="num">Working days</th><th class="num">Tasks</th></tr>${phaseRows}</table></div>`,
    ) +
    section(
      "Critical path",
      `<p>Any delay to these tasks moves the completion date.</p><div class="chips">` +
        critical.map((x) => `<span class="chip">${esc(x.name)}</span>`).join("") +
        `</div>`,
    ) +
    section(
      "Inspections",
      `<table><tr><th>Inspection</th><th>Date</th></tr>${inspections}</table>`,
    ) +
    section(
      "All tasks",
      `<details open><summary><span class="title">Detailed schedule</span><span class="meta">${t.tasks.length} tasks</span></summary>` +
        `<div class="content table-scroll"><table><tr><th>ID</th><th>Task</th><th>Kind</th><th>Start</th><th>End</th>` +
        `<th class="num">Days</th><th>Crew</th><th>Depends on</th><th>Notes</th></tr>${taskRows}</table></div></details>`,
    ) +
    section("Assumptions", list(t.assumptions)) +
    section("Risks", list(t.risks));

  return page({
    dir: t.planDir,
    file: "timeline.html",
    title: "Construction Timeline",
    subtitle:
      `${esc(t.location)} · generated by ${esc(t.model)} · ` +
      (t.usedEstimate
        ? "based on the cost estimate's labor hours"
        : "based on the house spec only"),
    body,
  });
}

// ---------- entry point ----------

/** Rebuilds timeline.html from a saved timeline.json without calling the model. */
export async function renderHtml(planDir: string): Promise<string> {
  const saved = JSON.parse(await readFile(`${planDir}/timeline.json`, "utf8")) as Timeline;
  const htmlPath = `${planDir}/timeline.html`;
  await writeFile(htmlPath, toHtml({ ...saved, homes: saved.homes ?? 1, planDir }));
  return htmlPath;
}

export async function run(
  planDir: string,
  startDate: string,
  onProgress?: (p: TimelineProgress) => void,
): Promise<Timeline> {
  const strategy = await loadStrategy(planDir);
  const homeIds = strategy ? homesOf(strategy).map((h) => h.id) : ["H1"];
  let project: Project;

  if (existsSync(`${planDir}/estimate.json`)) {
    const estimate = await loadEstimate(planDir);
    const largest = estimate.houses.reduce((a, b) =>
      b.spec.heatedSqft > a.spec.heatedSqft ? b : a,
    );
    project = {
      spec: largest.spec,
      location: estimate.location,
      labor: largest.trades,
      strategy,
      homeIds,
    };
  } else {
    onProgress?.({ step: "Reading the plan" });
    const { spec, location } = await readPlanSpec(planDir);
    project = { spec, location, labor: null, strategy, homeIds };
  }

  const plan = await planTasks(project, onProgress);
  if (homeIds.length > 1) {
    plan.assumptions.unshift(
      `All ${homeIds.length} homes use the task durations of the largest house ` +
        `(${project.spec.heatedSqft.toLocaleString("en-US")} sq ft); each crew finishes a task on one home before starting the next.`,
    );
  }
  const tasks = schedule(expandForHomes(plan.tasks, homeIds), startDate);

  const finish = tasks.reduce((a, b) => (a.end >= b.end ? a : b)).end;
  const workdays = Math.max(...tasks.map((x) => x.endOffset));
  const calendarDays =
    (new Date(`${finish}T00:00:00Z`).getTime() -
      new Date(`${tasks[0].start}T00:00:00Z`).getTime()) /
      86_400_000 +
    1;

  const timeline: Timeline = {
    model: ESTIMATE_MODEL,
    planDir,
    location: project.location,
    usedEstimate: project.labor !== null,
    homes: homeIds.length,
    startDate: tasks[0].start,
    finishDate: finish,
    workdays,
    calendarWeeks: Math.round(calendarDays / 7),
    tasks,
    assumptions: plan.assumptions,
    risks: plan.risks,
    markdownPath: `${planDir}/timeline.md`,
    htmlPath: `${planDir}/timeline.html`,
    jsonPath: `${planDir}/timeline.json`,
  };

  await writeFile(timeline.markdownPath, toMarkdown(timeline));
  await writeFile(timeline.htmlPath, toHtml(timeline));
  await writeFile(timeline.jsonPath, JSON.stringify(timeline, null, 2));
  return timeline;
}
