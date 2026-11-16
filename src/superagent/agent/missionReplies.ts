/**
 * What the agent's missions look like in the chat: the live checklist, the
 * plan waiting for approval, questions with answer buttons, the comparison
 * table and the final answer. Kept apart from replies.ts (the single-skill
 * replies) so each file stays readable.
 */
import type { Verdict } from "../../agents/feasibility.ts";
import { usd } from "../../listingFormat.ts";
import { VERDICT_ICON, type Reply } from "../replies.ts";
import type { Mission } from "./missions.ts";

/** actionIds of the mission buttons. Values carry the mission id. */
export const MISSION_GO_BUTTON = "mission_go";
export const MISSION_CANCEL_BUTTON = "mission_cancel";
/** Each answer button is "mission_answer_<option index>"; its value is "<mission id>|<option index>". */
export const MISSION_ANSWER_BUTTON = "mission_answer";
export const MISSION_ANSWER_ACTION = new RegExp(`^${MISSION_ANSWER_BUTTON}_\\d+$`);

const STEP_ICON = { running: "⏳", done: "✅", failed: "❌" } as const;

/** Only the most recent checklist lines are shown, so long missions don't make a huge message. */
const MAX_STEPS_SHOWN = 12;

const shorten = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/**
 * The mission's status message: the goal, the checklist so far, and what it
 * is doing right now (`now`, e.g. "Deciding what to do next…").
 */
export function missionStatusText(m: Mission, now?: string): string {
  const steps = m.steps.slice(-MAX_STEPS_SHOWN).map((s) => `${STEP_ICON[s.state]} ${s.text}`);
  const hidden = m.steps.length - steps.length;
  return [
    `🎯 **${shorten(m.goal, 150)}**`,
    ...(hidden > 0 ? [`*…${hidden} earlier steps*`] : []),
    ...steps,
    ...(now ? [`> ${now}`] : []),
  ].join("\n");
}

/** One step of a proposed plan, with its estimated minutes when it's a slow job. */
export type PlanLine = { text: string; minutes?: number };

/** The plan the agent wants to run, with Go / Cancel buttons. */
export function planReply(m: Mission, summary: string, lines: PlanLine[], minutes: number): Reply {
  const steps = lines
    .map((l, i) => `${i + 1}. ${l.text}${l.minutes ? ` *(~${l.minutes} min)*` : ""}`)
    .join("\n");
  return {
    text: `📋 **Here's my plan**\n${summary}\n\n${steps}\n\nAbout **${minutes} minutes** of work. Click Go to start, or reply to change the plan.`,
    actions: [
      { label: "Go", actionId: MISSION_GO_BUTTON, value: m.id, style: "primary" },
      { label: "Cancel", actionId: MISSION_CANCEL_BUTTON, value: m.id, style: "danger" },
    ],
  };
}

/** A question from the agent, with one button per suggested answer (people can also just reply). */
export function questionReply(m: Mission, question: string, options: string[]): Reply {
  return {
    text: `💬 ${question.trim()}\n\nReply to answer, or say \`cancel\` to stop.`,
    actions: options.map((o, i) => ({
      label: shorten(o, 70),
      actionId: `${MISSION_ANSWER_BUTTON}_${i}`,
      value: `${m.id}|${i}`,
    })),
  };
}

/** "8s" / "12m" / "1h 5m" */
function duration(ms: number): string {
  if (ms < 60000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  const min = Math.round(ms / 60000);
  return min >= 60 ? `${Math.floor(min / 60)}h ${min % 60}m` : `${min}m`;
}

export function missionDoneReply(m: Mission, answer: string): Reply {
  const text = answer.trim() || "I finished, but have nothing more to add.";
  const tools = m.steps.length;
  const footer = [
    `🎯 ${shorten(m.goal, 120)}`,
    ...(tools ? [`${tools} ${tools === 1 ? "step" : "steps"}`] : []),
    duration(Date.now() - Date.parse(m.createdAt)),
  ].join(" · ");
  return { text: `${text}\n\n${footer}` };
}

export function missionBusyReply(active: Mission[]): Reply {
  const goals = active.map((m) => `- *${shorten(m.goal, 100)}*`).join("\n");
  return {
    text: `I'm already working on ${active.length} things here:\n${goals}\n\nWait until one is done, or say \`cancel\` to stop the newest.`,
  };
}

export function notYourMissionReply(): Reply {
  return { text: "Only the person who asked for this can approve its plan." };
}

export function missionCancelledReply(m: Mission): Reply {
  return { text: `🛑 Stopped working on *${shorten(m.goal, 120)}*.` };
}

export function missionResumeReply(m: Mission): Reply {
  return {
    text: `🔄 I was restarted while working on *${shorten(m.goal, 120)}*, so I'm picking up where I left off.`,
  };
}

/** One property in a comparison; null means that report doesn't exist yet. */
export type ComparisonRow = {
  property: string;
  landPrice: number | null;
  homes: number | null;
  heatedSqft: number | null;
  buildCost: number | null;
  costPerSqft: number | null;
  weeks: number | null;
  sellProfit: number | null;
  sellMargin: number | null;
  sellVerdict: Verdict | null;
  rentYield: number | null;
  rentVerdict: Verdict | null;
  recommendation: "sell" | "rent" | "neither" | null;
  /** Site checks that came back red or amber, e.g. "flood (red)". */
  siteFlags: string[];
  /** Reports this property doesn't have yet. */
  missing: string[];
};

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

/** The comparison table, built from the saved reports by code (best first). */
export function comparisonReply(rows: ComparisonRow[]): Reply {
  const line = (r: ComparisonRow, i: number) => {
    const head =
      r.recommendation === null
        ? "no feasibility report yet"
        : r.recommendation === "neither"
          ? "🔴 not recommended as planned"
          : `${VERDICT_ICON[(r.recommendation === "sell" ? r.sellVerdict : r.rentVerdict) ?? "amber"]} build and ${r.recommendation}`;
    const facts = [
      r.landPrice !== null ? `Land ${usd(r.landPrice)}` : "",
      r.homes !== null ? `${r.homes} ${r.homes === 1 ? "home" : "homes"}` : "",
      r.heatedSqft !== null ? `${r.heatedSqft.toLocaleString("en-US")} sq ft` : "",
      r.buildCost !== null
        ? `build ${usd(Math.round(r.buildCost))}${r.costPerSqft !== null ? ` (${usd(Math.round(r.costPerSqft))}/sq ft)` : ""}`
        : "",
      r.weeks !== null ? `${r.weeks} weeks` : "",
    ].filter(Boolean);
    const money = [
      r.sellProfit !== null && r.sellMargin !== null && r.sellVerdict
        ? `Sell: ${usd(Math.round(r.sellProfit))} profit (${pct(r.sellMargin)}) ${VERDICT_ICON[r.sellVerdict]}`
        : "",
      r.rentYield !== null && r.rentVerdict
        ? `Rent: ${pct(r.rentYield)} yield ${VERDICT_ICON[r.rentVerdict]}`
        : "",
    ].filter(Boolean);
    return [
      `${i + 1}. **${r.property}** — ${head}`,
      facts.join(" · "),
      money.join(" · "),
      r.siteFlags.length ? `⚠️ Site: ${r.siteFlags.join(", ")}` : "",
      r.missing.length ? `*Missing: ${r.missing.join(", ")}*` : "",
    ]
      .filter(Boolean)
      .join("\n");
  };
  return {
    text: [
      "📊 **Side-by-side comparison**",
      ...rows.map(line),
      "Ranked by code from the saved reports: recommended options first, then by profit margin.",
    ].join("\n\n"),
  };
}
