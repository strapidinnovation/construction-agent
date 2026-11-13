/**
 * The project data the web UI shows: a card per project on the dashboard,
 * the full picture on a project screen, and counts for the dashboard tiles.
 * Every number is computed by skills/projects.ts, the same facts the agent
 * reports, so the screens and the chat always agree.
 */
import {
  findProject,
  listProjects,
  loadProjects,
  stageLabel,
  statusText,
  type Project,
  type ProjectFilter,
  type ProjectStatus,
} from "../superagent/skills/projects.ts";

export function projectSummary(p: Project) {
  const d = p.data;
  return {
    id: d.id,
    name: d.name,
    client: d.client,
    address: d.site.address,
    status: p.status,
    statusLabel: statusText(p.status),
    daysLate: p.daysLate,
    percentComplete: p.percentComplete,
    currentStages: p.current.map((s) => ({
      stage: s.stage,
      label: stageLabel(s.stage),
      percent: s.percent,
      plannedEnd: s.plannedEnd,
      forecastEnd: s.forecastEnd ?? null,
    })),
    doneStages: p.doneStages,
    totalStages: d.stages.length,
    openIssueCount: p.openIssues.length,
    nextInspection: p.nextInspection ?? null,
    onHold: d.onHold ?? null,
    dates: d.dates,
    budget: d.budget,
  };
}

export function projectDetail(p: Project) {
  const d = p.data;
  return {
    ...projectSummary(p),
    aliases: d.aliases,
    site: d.site,
    scope: d.scope,
    team: d.team,
    currentStageLateDays: p.currentStageLateDays,
    stages: d.stages.map((s) => ({ ...s, label: stageLabel(s.stage) })),
    delayCauses: p.delayCauses,
    openIssues: p.openIssues,
    issues: d.issues,
    inspections: [...d.inspections].sort((a, b) => a.date.localeCompare(b.date)),
    updates: [...d.updates].sort((a, b) => b.date.localeCompare(a.date)),
  };
}

/** Ongoing projects matching `filter`, most urgent first; completed ones after them if asked for. */
export function projectList(filter: ProjectFilter, includeCompleted: boolean) {
  const ongoing = listProjects(filter);
  const completed = includeCompleted ? loadProjects().filter((p) => p.status === "completed") : [];
  return [...ongoing, ...completed].map(projectSummary);
}

export function projectCounts() {
  const all = loadProjects();
  const byStatus: Record<ProjectStatus, number> = {
    delayed: 0,
    "at-risk": 0,
    "on-hold": 0,
    "on-track": 0,
    completed: 0,
  };
  for (const p of all) byStatus[p.status]++;
  const ongoing = all.filter((p) => p.status !== "completed");
  return {
    total: all.length,
    ongoing: ongoing.length,
    byStatus,
    openIssues: ongoing.reduce((n, p) => n + p.openIssues.length, 0),
    contractUsd: ongoing.reduce((n, p) => n + p.data.budget.contractUsd, 0),
    spentUsd: ongoing.reduce((n, p) => n + p.data.budget.spentUsd, 0),
  };
}

/** A project by exact id, else by a loosely typed name ("river bend"). */
export function lookupProject(
  idOrName: string,
):
  | { kind: "found"; project: Project }
  | { kind: "ambiguous"; options: { id: string; name: string }[] }
  | { kind: "not-found"; names: string[] } {
  const exact = loadProjects().find((p) => p.data.id === idOrName);
  if (exact) return { kind: "found", project: exact };
  const found = findProject(idOrName);
  if (found.kind === "ambiguous")
    return {
      kind: "ambiguous",
      options: found.options.map((p) => ({ id: p.data.id, name: p.data.name })),
    };
  return found;
}
