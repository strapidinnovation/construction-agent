/**
 * Skill: plan the construction schedule.
 *
 * Wraps the timeline planner agent (src/agents/timelinePlanner.ts). The model
 * lists the construction tasks with durations and what each one waits for
 * (e.g. "framing inspection" waits for "framing"). Code then turns that into
 * real calendar dates, skipping weekends and US federal holidays, and finds
 * the "critical path": the chain of tasks where any delay delays the whole
 * project. If a cost estimate exists, its labor figures are used to size the
 * task durations. Results go to timeline.json, timeline.md and timeline.html.
 *
 * This skill picks the start date, reports progress, and makes a PDF.
 */
import * as timelinePlanner from "../../agents/timelinePlanner.ts";
import { refreshReports } from "../../refreshReports.ts";
import { printPdf } from "../render.ts";

/** Read "2027-01-04" or "Jan 4 2027" as "YYYY-MM-DD"; null if it isn't a date. */
function parseDate(input: string): string | null {
  const s = input.trim();
  const isoMatch = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  const d = isoMatch
    ? new Date(Date.UTC(+isoMatch[1]!, +isoMatch[2]! - 1, +isoMatch[3]!))
    : new Date(`${s} UTC`);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

export type TimelineResult = {
  timeline: timelinePlanner.Timeline;
  pdfPath: string;
  /** Explains where the start date came from. */
  startNote: string;
  seconds: number;
};

/**
 * Choose the start date. `startText` comes from the router (ideally already
 * "2027-01-04"); if it is empty or unreadable we use next Monday.
 */
export function resolveStart(startText: string): { date: string; note: string } {
  const parsed = startText ? parseDate(startText) : null;
  if (parsed) {
    // "Jan 4" without a year can come back as a date that already passed.
    // Construction can't start in the past, so move it to the next such date.
    const today = new Date().toISOString().slice(0, 10);
    let date = parsed;
    while (date < today) date = `${Number(date.slice(0, 4)) + 1}${date.slice(4)}`;
    return {
      date,
      note: date === parsed ? "as you asked" : `moved to ${date} because ${parsed} has passed`,
    };
  }
  return {
    date: timelinePlanner.nextMonday(),
    note: startText
      ? `I couldn't read "${startText}", so I used next Monday`
      : "no start date given, so I used next Monday",
  };
}

export async function planTimeline(
  planDir: string,
  startText: string,
  onStep: (step: string) => void,
): Promise<TimelineResult> {
  const started = Date.now();
  const { date, note } = resolveStart(startText);

  onStep(`Planning the construction tasks (starting ${date})…`);
  const timeline = await timelinePlanner.run(planDir, date, (p) => onStep(`${p.step}…`));

  onStep("Making the PDF…");
  await refreshReports(planDir);
  const pdfPath = `${planDir}/timeline.pdf`;
  // The Gantt chart is wide, so landscape pages show it much better.
  await printPdf(timeline.htmlPath, pdfPath, { landscape: true });

  return { timeline, pdfPath, startNote: note, seconds: Math.round((Date.now() - started) / 1000) };
}
