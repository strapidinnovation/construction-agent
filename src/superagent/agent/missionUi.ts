/**
 * What the agent's missions look like in Slack: the live checklist, the plan
 * waiting for approval, questions with answer buttons, the comparison table
 * and the final answer. Kept apart from slackUi.ts (the single-skill replies)
 * so each file stays readable.
 */
import type { KnownBlock } from "@slack/types";
import type { Verdict } from "../../agents/feasibility.ts";
import { usd } from "../../listingFormat.ts";
import type { Reply } from "../slackUi.ts";
import type { Mission } from "./missions.ts";

/** action_ids of the mission buttons; src/slack.ts listens for them. Values carry the mission id. */
export const MISSION_GO_BUTTON = "mission_go";
export const MISSION_CANCEL_BUTTON = "mission_cancel";
/** Its value is "<mission id>|<option index>". */
export const MISSION_ANSWER_BUTTON = "mission_answer";

const STEP_ICON = {
  running: ":hourglass_flowing_sand:",
  done: ":white_check_mark:",
  failed: ":x:",
} as const;

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
    `:dart: *${shorten(m.goal, 150)}*`,
    ...(hidden > 0 ? [`_…${hidden} earlier steps_`] : []),
    ...steps,
    ...(now ? [`> ${now}`] : []),
  ].join("\n");
}

/** One step of a proposed plan, with its estimated minutes when it's a slow job. */
export type PlanLine = { text: string; minutes?: number };

/** The plan the agent wants to run, with Go / Cancel buttons. */
export function planReply(m: Mission, summary: string, lines: PlanLine[], minutes: number): Reply {
  const steps = lines
    .map((l, i) => `${i + 1}. ${l.text}${l.minutes ? ` _(~${l.minutes} min)_` : ""}`)
    .join("\n");
  return {
    text: `Here's my plan: ${summary}`,
    blocks: [
      {
        type: "section",
        text: { type: "mrkdwn", text: `:clipboard: *Here's my plan*\n${summary}\n\n${steps}` },
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `About *${minutes} minutes* of work. Click Go to start, or reply to change the plan.`,
          },
        ],
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            action_id: MISSION_GO_BUTTON,
            text: { type: "plain_text", text: "Go" },
            style: "primary",
            value: m.id,
          },
          {
            type: "button",
            action_id: MISSION_CANCEL_BUTTON,
            text: { type: "plain_text", text: "Cancel" },
            style: "danger",
            value: m.id,
          },
        ],
      },
    ],
  };
}

/** A question from the agent, with one button per suggested answer (people can also just reply). */
export function questionReply(m: Mission, question: string, options: string[]): Reply {
  const blocks: KnownBlock[] = [
    { type: "section", text: { type: "mrkdwn", text: `:speech_balloon: ${slackify(question)}` } },
  ];
  if (options.length)
    blocks.push({
      type: "actions",
      elements: options.map((o, i) => ({
        type: "button" as const,
        action_id: MISSION_ANSWER_BUTTON,
        text: { type: "plain_text" as const, text: shorten(o, 70) },
        value: `${m.id}|${i}`,
      })),
    });
  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: "Reply to answer, or say `cancel` to stop." }],
  });
  return { text: question, blocks };
}

/**
 * Models write Markdown (**bold**, ## headings); Slack uses its own "mrkdwn"
 * (*bold*, no headings). Convert the common cases so answers look right.
 */
export function slackify(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    .replace(/^#{1,6}\s+(.+)$/gm, "*$1*")
    .replace(/^\s*[-*]\s+/gm, "• ")
    .trim();
}

/** "12m" / "1h 5m" */
function duration(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60000));
  return min >= 60 ? `${Math.floor(min / 60)}h ${min % 60}m` : `${min}m`;
}

export function missionDoneReply(m: Mission, answer: string): Reply {
  const text = slackify(answer) || "I finished, but have nothing more to add.";
  const tools = m.steps.length;
  return {
    text,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: shorten(text, 2900) } },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: [
              `:dart: ${shorten(m.goal, 120)}`,
              ...(tools ? [`${tools} ${tools === 1 ? "step" : "steps"}`] : []),
              duration(Date.now() - Date.parse(m.createdAt)),
            ].join(" · "),
          },
        ],
      },
    ],
  };
}

export function missionBusyReply(m: Mission): Reply {
  return {
    text: `I'm still working on _${shorten(m.goal, 120)}_ here. Say \`@superagent cancel\` to stop it, or wait until it's done.`,
  };
}

export function notYourMissionReply(m: Mission): Reply {
  return { text: `Only <@${m.user}>, who asked for this, can approve its plan.` };
}

export function missionCancelledReply(m: Mission): Reply {
  return { text: `:octagonal_sign: Stopped working on _${shorten(m.goal, 120)}_.` };
}

export function missionResumeReply(m: Mission): Reply {
  return {
    text: `:arrows_counterclockwise: I was restarted while working on _${shorten(m.goal, 120)}_, so I'm picking up where I left off.`,
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

const VERDICT_ICON: Record<Verdict, string> = {
  green: ":large_green_circle:",
  amber: ":large_orange_circle:",
  red: ":red_circle:",
};

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

/** The comparison table, built from the saved reports by code (best first). */
export function comparisonReply(rows: ComparisonRow[]): Reply {
  const line = (r: ComparisonRow, i: number) => {
    const head =
      r.recommendation === null
        ? "no feasibility report yet"
        : r.recommendation === "neither"
          ? ":red_circle: not recommended as planned"
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
      `${i + 1}. *${r.property}* — ${head}`,
      facts.join(" · "),
      money.join(" · "),
      r.siteFlags.length ? `:warning: Site: ${r.siteFlags.join(", ")}` : "",
      r.missing.length ? `_Missing: ${r.missing.join(", ")}_` : "",
    ]
      .filter(Boolean)
      .join("\n");
  };
  return {
    text: `Comparison of ${rows.map((r) => r.property).join(", ")}`,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: ":bar_chart: *Side-by-side comparison*" } },
      ...rows.map((r, i): KnownBlock => ({
        type: "section",
        text: { type: "mrkdwn", text: line(r, i) },
      })),
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: "Ranked by code from the saved reports: recommended options first, then by profit margin.",
          },
        ],
      },
    ],
  };
}
