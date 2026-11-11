/**
 * Everything SuperAgent shows in Slack: message text and "Block Kit" layouts.
 *
 * Slack messages can be plain text or "blocks" — a JSON layout of sections,
 * buttons and small print (https://api.slack.com/block-kit). Keeping all of
 * that here means src/slack.ts only decides WHAT to say, not how it looks.
 *
 * Slack formatting notes used below:
 * - *bold* and _italic_ use single asterisks/underscores ("mrkdwn").
 * - A link is written <https://example.com|link text>.
 * - Every message also needs a plain `text`; Slack uses it for notifications
 *   and screen readers when it cannot show the blocks.
 */
import type { KnownBlock } from "@slack/types";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import type { Listing } from "../agents/landSearch.ts";
import { houseTypeLine, STRATEGY_LABEL } from "../agents/sitePlanner.ts";
import { listingDetails, noListingsText, usd } from "../listingFormat.ts";
import type { CancelResult, JobInfo, JobKind } from "./queue.ts";
import type { ReplyMode, Session } from "./sessions.ts";
import type { DesignResult } from "./skills/design.ts";
import type { EstimateResult } from "./skills/estimate.ts";
import {
  AT_RISK_MAX_DAYS,
  niceDate,
  ON_TRACK_MAX_DAYS,
  stageLabel,
  statusText,
  type Issue,
  type Project,
  type ProjectFilter,
  type ProjectStatus,
} from "./skills/projects.ts";
import type { TimelineResult } from "./skills/timeline.ts";
import type { Verdict } from "../agents/feasibility.ts";
import type { Flag } from "../agents/siteChecks.ts";
import type { FeasibilityResult } from "./skills/feasibility.ts";

/** At most this many listings per message (Slack allows 50 blocks per message). */
export const MAX_LISTINGS = 10;

/** action_id of the "Design on this lot" button; src/slack.ts listens for it. */
export const DESIGN_BUTTON = "design_listing";

export type Reply = { text: string; blocks?: KnownBlock[] };

/** Strip characters that would break Slack's <url|text> link syntax. */
const safe = (s: string) => s.replace(/[<>|]/g, "");

const EXAMPLES = [
  "land around 300k in Austin, TX",
  "same but under 200k",
  "design a house on Corral Lane",
  "design on Geronimo Trail with a 60x150 lot",
  "how much will it cost to build?",
  "timeline starting Jan 4",
  "feasibility report for 3218 Brass Buttons Trl",
  "status",
  "cancel",
  "list ongoing projects",
  "which projects are delayed?",
  "why is River Bend late?",
];

/** The last line of the help message, describing what the bot remembers in the current reply mode. */
const MEMORY_NOTE: Record<ReplyMode, string> = {
  thread: "Each thread is its own project: I remember the listings and the lot you picked there.",
  channel:
    "This channel shares one memory: the latest search, lot and plan posted here are the ones I work with.",
  user: "I keep a separate memory for each person in this channel: your searches, lots and plans are your own.",
};

export function helpReply(mode: ReplyMode = "thread"): Reply {
  const text = `I'm SuperAgent. I find land and plan houses. Try: ${EXAMPLES.map((e) => `"${e}"`).join(", ")}.`;
  return {
    text,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "*I'm SuperAgent.* I find land you can build on, plan houses for it, and keep track of ongoing construction projects. Tag me and try:",
        },
      },
      {
        type: "section",
        text: { type: "mrkdwn", text: EXAMPLES.map((e) => `• \`@superagent ${e}\``).join("\n") },
      },
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: MEMORY_NOTE[mode] }],
      },
    ],
  };
}

/** Reply when the router understood a search but a detail is missing or unreadable. */
export function missingSearchInfo(
  reason: "missing-city" | "missing-budget" | "bad-budget",
  budget?: string,
): Reply {
  const ask = {
    "missing-city": "Which US city should I search? For example: `land around 300k in Austin, TX`.",
    "missing-budget": "What's the budget? For example `300k`, `200k-350k` or `under 400k`.",
    "bad-budget": `I couldn't read the budget "${budget}". Try \`300k\`, \`200k-350k\` or \`under 400k\`.`,
  }[reason];
  return { text: ask };
}

/**
 * The search results message. Each listing is a "section" block whose text is
 * the address (as a link), price and size, with a button on the right
 * ("accessory"). People refer to a listing by its street ("design a house on
 * Corral Lane"), so the address is the label and there are no numbers.
 *
 * The button's `value` is the listing's URL, which identifies the exact lot
 * even if a newer search has replaced the list, or someone else clicks it.
 */
export function listingsReply(
  listings: Listing[],
  total: number,
  city: string,
  lo: number,
  hi: number,
): Reply {
  if (!listings.length) return { text: noListingsText(city, lo, hi) };

  const blocks: KnownBlock[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `Found *${total}* land ${total === 1 ? "listing" : "listings"} in *${city}* between ${usd(lo)} and ${usd(hi)}:`,
      },
    },
    ...listings.map((l): KnownBlock => ({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*<${l.url}|${safe(l.address)}>*\n${listingDetails(l)}`,
      },
      accessory: {
        type: "button",
        action_id: DESIGN_BUTTON,
        text: { type: "plain_text", text: "Design on this lot" },
        value: l.url,
      },
    })),
  ];
  const example = listings[0] ? street(listings[0]) : "Corral Lane";
  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text:
          (total > listings.length ? `Showing the ${listings.length} cheapest of ${total}. ` : "") +
          `To design on one, click its button or say \`design a house on ${example}\`.`,
      },
    ],
  });
  return { text: `Found ${total} land listings in ${city}`, blocks };
}

/** The street part of an address: "8435 Corral Ln, Austin, TX, 78745" -> "8435 Corral Ln". */
export function street(l: Listing): string {
  return l.address.split(",")[0]!.trim();
}

/** "8435 Corral Ln ($279,000)" for lists in replies. */
const listingShort = (l: Listing) => `${street(l)} (${usd(l.priceUsd)})`;

export function noListingsYetReply(): Reply {
  return {
    text: "There are no listings here yet. Search first, e.g. `land around 300k in Austin, TX`.",
  };
}

/** No property name was given and none was picked earlier. */
export function whichListingReply(listings: Listing[]): Reply {
  return {
    text: `Which property? Name it by its street, e.g. \`design a house on ${street(listings[0]!)}\`, or click "Design on this lot".`,
  };
}

export function listingNotFoundReply(query: string, listings: Listing[]): Reply {
  return {
    text: `No listing here matches "${query}". The listings are: ${listings.map(listingShort).join(", ")}.`,
  };
}

export function listingAmbiguousReply(query: string, options: Listing[]): Reply {
  return {
    text: `"${query}" matches ${options.length} listings: ${options.map(listingShort).join(" and ")}. Which one? Add the house number, e.g. \`design on ${street(options[0]!)}\`.`,
  };
}

/** For "#5" / "the fifth one" when there aren't that many listings. */
export function noSuchListingNumberReply(n: number, count: number): Reply {
  return {
    text: `There are only ${count} listings here, so there's no #${n}. Name the property by its street instead.`,
  };
}

// ---------------------------------------------------------------------------
// Progress messages for slow jobs (design, estimate, timeline).
//
// Each job posts ONE status message and then keeps editing it: a bold title
// line ("Designing 123 Main St") followed by the current step ("Checking the
// zoning rules…"). That shows live progress without flooding the conversation.
// ---------------------------------------------------------------------------

export function designTitle(l: Listing): string {
  return `:building_construction: Designing *<${l.url}|${safe(l.address)}>*`;
}

/** `subject` is the property in words, e.g. "3218 Brass Buttons Trl", when known. */
export function estimateTitle(subject?: string): string {
  return `:moneybag: *Estimating the construction cost${subject ? ` for ${subject}` : ""}*`;
}

export function feasibilityTitle(subject?: string): string {
  return `:clipboard: *Preparing the feasibility report${subject ? ` for ${subject}` : ""}*`;
}

export function timelineTitle(subject?: string): string {
  return `:calendar: *Planning the construction timeline${subject ? ` for ${subject}` : ""}*`;
}

/**
 * Status text for a job that was just queued; `ahead` is how many jobs must
 * finish first. `note` adds a line, e.g. that it waits for a design.
 */
export function queuedText(title: string, ahead: number, note?: string): string {
  const line = ahead
    ? `Waiting in line: ${ahead} ${ahead === 1 ? "job is" : "jobs are"} ahead of this one. I'll post the result here when it's done.`
    : "Starting… this usually takes a few minutes.";
  return `${title}\n> ${line}${note ? `\n> ${note}` : ""}`;
}

export function stepText(title: string, step: string): string {
  return `${title}\n> ${step}`;
}

/** action_id of the "Cancel" button on a job's status message; its value is the job id. */
export const CANCEL_BUTTON = "cancel_job";

/**
 * Layout of a status message: the text, plus a "Cancel" button while the job
 * can still be cancelled. The button carries the job's id, so with several
 * jobs queued it cancels exactly this one. Finished/stopped statuses are drawn
 * without the button, which also removes it from the message when edited.
 */
export function statusBlocks(text: string, cancelId?: string): KnownBlock[] {
  const blocks: KnownBlock[] = [{ type: "section", text: { type: "mrkdwn", text } }];
  if (cancelId)
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: CANCEL_BUTTON,
          text: { type: "plain_text", text: "Cancel" },
          style: "danger",
          value: cancelId,
        },
      ],
    });
  return blocks;
}

const JOB_NAME: Record<JobKind, string> = {
  design: "design",
  estimate: "cost estimate",
  timeline: "timeline",
  feasibility: "feasibility report",
};

/** "the cost estimate for 3218 Brass Buttons Trl" */
const jobName = (j: Pick<JobInfo, "kind" | "subject">) =>
  `the ${JOB_NAME[j.kind]}${j.subject ? ` for ${j.subject}` : ""}`;

export function cancelReply(c: CancelResult): Reply {
  if (c.result === "none") return { text: "There's nothing running or waiting here to cancel." };
  if (c.result === "removed")
    return { text: `Cancelled ${jobName(c.job)}. It hadn't started yet.` };
  return {
    text: `Stopping ${jobName(c.job)}… It stops at its next step, which can take up to a minute.`,
  };
}

export function cancelledReply(job: Pick<JobInfo, "kind" | "subject">): Reply {
  const name = jobName(job);
  return { text: `:octagonal_sign: ${name[0]!.toUpperCase()}${name.slice(1)} was cancelled.` };
}

export function limitReply(max: number): Reply {
  return {
    text: `You already have ${max} jobs waiting or running. I'll take new ones once one of them finishes (or cancel one with \`@superagent cancel\`).`,
  };
}

export function ollamaDownReply(problem: string): Reply {
  return { text: `:warning: I can't start that right now: ${problem}` };
}

/** Posted after a restart, for each job that was interrupted. */
export function resumeReply(job: Pick<JobInfo, "kind" | "subject">): Reply {
  return {
    text: `:arrows_counterclockwise: I was restarted while working on ${jobName(job)}, so I'm starting it again.`,
  };
}

/** The same kind of job on the same property is already queued or running. */
export function duplicateReply(job: JobInfo): Reply {
  const name = jobName(job);
  return {
    text: `${name[0]!.toUpperCase()}${name.slice(1)} is already ${job.running ? "running" : "waiting in line"}. I'll post the result here when it's done.`,
  };
}

export function noPlanReply(what: "estimate" | "timeline" | "feasibility"): Reply {
  const thing = {
    estimate: "a cost estimate",
    timeline: "a timeline",
    feasibility: "a feasibility report",
  }[what];
  return {
    text: `There's no house plan here yet, so I can't make ${thing}. Search for land, pick a lot and design it first (e.g. \`design a house on Corral Lane\`).`,
  };
}

/** No saved plan (and no design in the queue) matches the property the user named. */
export function noPlanForReply(name: string, planned: string[]): Reply {
  return {
    text:
      `There's no house plan for "${name}" yet, so design it first: \`design a house on ${name}\`.` +
      (planned.length ? ` Properties with a plan: ${planned.slice(0, 8).join(", ")}.` : ""),
  };
}

export function planAmbiguousReply(name: string, streets: string[]): Reply {
  return {
    text: `"${name}" matches plans for ${streets.join(" and ")}. Which one? Add the house number.`,
  };
}

export function jobFailedReply(what: JobKind, err: unknown): Reply {
  const { text } = errorReply(err);
  return { text: `:warning: The ${JOB_NAME[what]} didn't finish. ${text}` };
}

// ---------------------------------------------------------------------------
// "Next step" buttons under finished results. src/slack.ts listens for these
// action_ids and starts the matching job.
//
// The button's value is the plan folder, so a click always works on the plan
// it was posted under, even if a newer plan was made since, or someone other
// than the original requester clicks it.
// ---------------------------------------------------------------------------

export const ESTIMATE_BUTTON = "estimate_plan";
export const TIMELINE_BUTTON = "timeline_plan";
export const FEASIBILITY_BUTTON = "feasibility_plan";

type NextStep = "estimate" | "timeline" | "feasibility";
const NEXT_STEP: Record<NextStep, { action: string; label: string }> = {
  estimate: { action: ESTIMATE_BUTTON, label: "Estimate cost" },
  timeline: { action: TIMELINE_BUTTON, label: "Plan the timeline" },
  feasibility: { action: FEASIBILITY_BUTTON, label: "Feasibility report" },
};

function nextSteps(steps: NextStep[], planDir: string): KnownBlock {
  return {
    type: "actions",
    elements: steps.map((s) => ({
      type: "button" as const,
      action_id: NEXT_STEP[s].action,
      text: { type: "plain_text" as const, text: NEXT_STEP[s].label },
      value: planDir,
      // The first button is styled as the main action.
      ...(s === steps[0] ? { style: "primary" as const } : {}),
    })),
  };
}

/** "4m 12s" style duration. */
function took(seconds: number): string {
  const m = Math.floor(seconds / 60);
  return m ? `${m}m ${seconds % 60}s` : `${seconds}s`;
}

const money = (n: number) => usd(Math.round(n));

/** The summary posted when a design is finished; the PDF and image are uploaded right after it. */
export function designDoneReply(l: Listing, r: DesignResult): Reply {
  const s = r.strategy;
  const zoning = r.zoningFound
    ? `${r.rules.district} (${r.rules.districtName}), ${r.rules.jurisdiction}`
    : `typical residential defaults, because ${r.zoningNote}`;
  const types = s.houseTypes.map((t) => `• ${houseTypeLine(t)}`).join("\n");

  const blocks: KnownBlock[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `:house: *Plan ready for <${l.url}|${safe(l.address)}>*\n*${STRATEGY_LABEL[s.strategy]}*: ${s.homes} ${s.homes === 1 ? "home" : "homes"}\n${types}`,
      },
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Lot*\n${r.lot.widthFt} x ${r.lot.depthFt} ft (${r.lotNote})` },
        { type: "mrkdwn", text: `*Zoning*\n${zoning}` },
      ],
    },
    { type: "section", text: { type: "mrkdwn", text: `*Why*\n${s.reasoning}` } },
  ];
  if (s.approvals.length)
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Approvals needed*\n${s.approvals.map((a) => `• ${a}`).join("\n")}`,
      },
    });
  const notes = [
    `Drawn by ${r.model} in ${took(r.seconds)}. Concept plan only, not a construction or permit drawing.`,
    ...(r.complete
      ? []
      : ["The model stopped before finishing the drawing, so parts may be missing."]),
  ];
  blocks.push({
    type: "context",
    elements: notes.map((t) => ({ type: "mrkdwn" as const, text: t })),
  });
  blocks.push(nextSteps(["estimate", "timeline", "feasibility"], r.dir));
  return { text: `Plan ready for ${l.address}`, blocks };
}

/**
 * The summary posted when a cost estimate is finished.
 * Shows the total, how it splits into materials / labor / contingency, the
 * cost per home type, and the five most expensive trades.
 */
export function estimateDoneReply(r: EstimateResult): Reply {
  const e = r.estimate;
  const perSqft = e.totalUsd / Math.max(1, e.heatedSqft);

  // Add up each trade across all house types (per-home cost x number of homes).
  const byTrade = new Map<string, number>();
  for (const h of e.houses)
    for (const t of h.trades)
      byTrade.set(t.name, (byTrade.get(t.name) ?? 0) + (t.materialsUsd + t.laborUsd) * h.count);
  const topTrades = [...byTrade]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, cost]) => `• ${name}: ${money(cost)}`);

  const perType = e.houses.map(
    (h) =>
      `• Type ${h.type} "${h.name}" x${h.count}: ${money(h.materialsUsd + h.laborUsd)} per home`,
  );
  const failed = e.houses.flatMap((h) =>
    h.failedTrades.map((t) => (e.houses.length > 1 ? `Type ${h.type} ${t}` : t)),
  );

  const blocks: KnownBlock[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `:moneybag: *Estimated cost: ${money(e.totalUsd)}* (about ${money(perSqft)} per sq ft)\n${e.homes} ${e.homes === 1 ? "home" : "homes"}, ${e.heatedSqft.toLocaleString("en-US")} sq ft heated in total · ${e.location}`,
      },
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Materials*\n${money(e.materialsUsd)}` },
        { type: "mrkdwn", text: `*Labor*\n${money(e.laborUsd)}` },
        { type: "mrkdwn", text: `*Contingency*\n${money(e.contingencyUsd)}` },
        { type: "mrkdwn", text: `*Strategy*\n${e.strategy}` },
      ],
    },
  ];
  if (e.houses.length > 1 || e.homes > 1)
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*Per home*\n${perType.join("\n")}` },
    });
  if (topTrades.length)
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*Biggest costs*\n${topTrades.join("\n")}` },
    });
  const notes = [
    `Estimated by ${e.model} in ${took(r.seconds)}. A rough estimate for planning, not a bid.`,
    ...(failed.length
      ? [`Could not estimate: ${failed.join(", ")} (not included in the total).`]
      : []),
  ];
  blocks.push({
    type: "context",
    elements: notes.map((t) => ({ type: "mrkdwn" as const, text: t })),
  });
  blocks.push(nextSteps(["timeline", "feasibility"], e.planDir));
  return { text: `Estimated cost: ${money(e.totalUsd)}`, blocks };
}

/**
 * The summary posted when a timeline is finished.
 * Shows start and finish dates, total length, the key milestones and the top
 * risks. The full Gantt chart is in the uploaded PDF.
 */
export function timelineDoneReply(r: TimelineResult): Reply {
  const t = r.timeline;
  const critical = t.tasks.filter((x) => x.critical && x.workdays > 0).length;
  const milestones = t.tasks
    .filter((x) => x.kind === "milestone")
    .sort((a, b) => a.end.localeCompare(b.end))
    .slice(0, 8)
    .map((x) => `• ${x.end}: ${x.name}`);

  const blocks: KnownBlock[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `:calendar: *Construction timeline: ${t.startDate} → ${t.finishDate}*\n${t.workdays} working days (about ${t.calendarWeeks} weeks) for ${t.homes} ${t.homes === 1 ? "home" : "homes"} · start date ${r.startNote}`,
      },
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Tasks*\n${t.tasks.length}` },
        { type: "mrkdwn", text: `*On the critical path*\n${critical}` },
      ],
    },
  ];
  if (milestones.length)
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*Milestones*\n${milestones.join("\n")}` },
    });
  if (t.risks.length)
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Main risks*\n${t.risks
          .slice(0, 3)
          .map((x) => `• ${x}`)
          .join("\n")}`,
      },
    });
  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: `Planned by ${t.model} in ${took(r.seconds)}${t.usedEstimate ? ", using the cost estimate's labor figures" : ""}. Weekends and US federal holidays are skipped.`,
      },
    ],
  });
  blocks.push(nextSteps(["feasibility"], t.planDir));
  return { text: `Construction timeline: ${t.startDate} to ${t.finishDate}`, blocks };
}

const VERDICT_ICON: Record<Verdict, string> = {
  green: ":large_green_circle:",
  amber: ":large_orange_circle:",
  red: ":red_circle:",
};
const VERDICT_WORD: Record<Verdict, string> = {
  green: "Feasible",
  amber: "Marginal",
  red: "Not feasible",
};
const FLAG_ICON: Record<Flag, string> = {
  green: ":large_green_circle:",
  amber: ":large_orange_circle:",
  red: ":red_circle:",
  unknown: ":white_circle:",
};
const percent = (v: number) => `${(v * 100).toFixed(1)}%`;

/**
 * The summary posted when a feasibility report is finished: the
 * recommendation, sell and rent results side by side, the model's summary,
 * the site checks, and what to do next. The full report is in the PDF.
 */
export function feasibilityDoneReply(r: FeasibilityResult): Reply {
  const f = r.feasibility;
  const s = f.sell;
  const rent = f.rent;
  const rec = f.recommendation;
  const headline =
    rec.option === "neither"
      ? `:red_circle: *Not recommended as planned*`
      : `${VERDICT_ICON[rec.option === "sell" ? s.verdict : rent!.verdict]} *Best option: build and ${rec.option}*`;
  const comps = f.houses[0]!.sale;
  const site = (Object.entries(f.site) as [string, { flag: Flag; summary: string }][])
    .map(
      ([k, c]) =>
        `${FLAG_ICON[c.flag]} ${k === "edwards" ? "Edwards Aquifer" : k[0]!.toUpperCase() + k.slice(1)}: ${c.summary}`,
    )
    .join("\n");

  const blocks: KnownBlock[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `:clipboard: *Feasibility: ${safe(f.listing.address)}*\n${headline}. ${rec.reason}`,
      },
    },
    {
      type: "section",
      fields: [
        {
          type: "mrkdwn",
          text: `*Build and sell* ${VERDICT_ICON[s.verdict]}\n${VERDICT_WORD[s.verdict]}: ${money(s.profit)} profit (${percent(s.margin)} margin)`,
        },
        {
          type: "mrkdwn",
          text: rent
            ? `*Build and rent* ${VERDICT_ICON[rent.verdict]}\n${VERDICT_WORD[rent.verdict]}: ${percent(rent.yieldOnCost)} yield, ${money(rent.cashFlowPerYear)}/yr after mortgage`
            : "*Build and rent*\nNot enough rental comps",
        },
        { type: "mrkdwn", text: `*Cost to build*\n${money(f.costToBuild)}` },
        {
          type: "mrkdwn",
          text: `*Expected value*\n${money(s.revenue)} (${comps.comps.length} homes nearby, ${money(comps.medianPerSqft)}/sq ft)`,
        },
      ],
    },
    { type: "section", text: { type: "mrkdwn", text: f.summary } },
    { type: "section", text: { type: "mrkdwn", text: `*Site checks*\n${site}` } },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Watch out for*\n${f.risks
          .slice(0, 3)
          .map((x) => `• ${x}`)
          .join("\n")}`,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Next steps*\n${f.nextSteps
          .slice(0, 4)
          .map((x) => `• ${x}`)
          .join("\n")}`,
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `${f.lowConfidence ? `Low confidence: ${f.confidenceNotes.join(" and ")}. ` : ""}Values use the asking prices of recently sold homes (Texas doesn't disclose sale prices). Planning-level estimate, not a lender's appraisal. Done in ${took(r.seconds)}.`,
        },
      ],
    },
  ];
  return {
    text: `Feasibility for ${f.listing.address}: ${rec.option === "neither" ? "not recommended" : `build and ${rec.option}`}`,
    blocks,
  };
}

// ---------------------------------------------------------------------------
// Construction projects (skills/projects.ts): the list, one project's
// overview, and the "why is it late" breakdown.
// ---------------------------------------------------------------------------

/** action_ids of the project buttons; their value is the project id. */
export const PROJECT_BUTTON = "project_details";
export const PROJECT_DELAY_BUTTON = "project_delay";

const STATUS_ICON: Record<ProjectStatus, string> = {
  delayed: ":red_circle:",
  "at-risk": ":large_orange_circle:",
  "on-track": ":large_green_circle:",
  "on-hold": ":double_vertical_bar:",
  completed: ":white_check_mark:",
};

/** "42 days late" / "on schedule" / "3 days early". */
function lateText(days: number): string {
  if (days > 0) return `${days} ${days === 1 ? "day" : "days"} late`;
  if (days < 0) return `${-days} days early`;
  return "on schedule";
}

/** "Framing (55%)", or "Rough-ins (70%) + Exterior (10%)" when stages overlap. */
function currentStageText(p: Project): string {
  if (p.status === "completed") return "Completed";
  return (
    p.current.map((s) => `${stageLabel(s.stage)} (${s.percent}%)`).join(" + ") || "Not started"
  );
}

export function projectsListReply(projects: Project[], filter: ProjectFilter): Reply {
  const what = {
    all: "Ongoing projects",
    behind: "Projects behind schedule",
    "on-hold": "Projects on hold",
  }[filter];
  if (!projects.length)
    return {
      text:
        filter === "all"
          ? "There are no ongoing projects in data/projects/."
          : `No ${filter === "behind" ? "projects are behind schedule" : "projects are on hold"} right now.`,
    };

  const blocks: KnownBlock[] = [
    { type: "section", text: { type: "mrkdwn", text: `*${what} (${projects.length})*` } },
    ...projects.map((p): KnownBlock => ({
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          `${STATUS_ICON[p.status]} *${p.data.name}* — ${statusText(p.status)}${p.status === "on-hold" ? "" : `, ${lateText(p.daysLate)}`}\n` +
          `${currentStageText(p)} · ${p.percentComplete}% overall · finish ${niceDate(p.data.dates.forecastFinish)}`,
      },
      accessory: {
        type: "button",
        action_id: PROJECT_BUTTON,
        text: { type: "plain_text", text: "Details" },
        value: p.data.id,
      },
    })),
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `:large_green_circle: up to ${ON_TRACK_MAX_DAYS} days late · :large_orange_circle: ${ON_TRACK_MAX_DAYS + 1}–${AT_RISK_MAX_DAYS} days · :red_circle: more than ${AT_RISK_MAX_DAYS} days · :double_vertical_bar: on hold. Late = forecast finish vs planned finish.`,
        },
      ],
    },
  ];
  return { text: `${what}: ${projects.length}`, blocks };
}

/** One project: status line, the model's summary, key facts, open issues and what's next. */
export function projectOverviewReply(p: Project, summary: string): Reply {
  const d = p.data;
  const finish = d.dates.actualFinish
    ? `Finished ${niceDate(d.dates.actualFinish)} (planned ${niceDate(d.dates.plannedFinish)})`
    : `${niceDate(d.dates.forecastFinish)} (planned ${niceDate(d.dates.plannedFinish)})`;

  const blocks: KnownBlock[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          `${STATUS_ICON[p.status]} *${d.name}* — ${statusText(p.status)}${p.status === "on-hold" ? "" : `, ${lateText(p.daysLate)}`}\n` +
          `${d.site.address} · ${d.scope.homes} ${d.scope.homes === 1 ? "home" : "homes"} · PM ${d.team.projectManager}`,
      },
    },
    { type: "section", text: { type: "mrkdwn", text: summary } },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Stage now*\n${currentStageText(p)}` },
        {
          type: "mrkdwn",
          text: `*Overall*\n${p.percentComplete}% · ${p.doneStages} of ${d.stages.length} stages done`,
        },
        { type: "mrkdwn", text: `*Finish*\n${finish}` },
        {
          type: "mrkdwn",
          // Approved change orders raise what the client has agreed to pay, so
          // they count toward the budget the spending is compared with.
          text: `*Budget*\n${usd(d.budget.spentUsd)} spent of ${usd(d.budget.contractUsd + d.budget.approvedChangeOrdersUsd)}${
            d.budget.approvedChangeOrdersUsd
              ? ` (incl. ${usd(d.budget.approvedChangeOrdersUsd)} change orders)`
              : ""
          }`,
        },
      ],
    },
  ];
  if (d.onHold)
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `:double_vertical_bar: *On hold since ${niceDate(d.onHold.since)}*\n${d.onHold.reason}`,
      },
    });
  if (p.openIssues.length)
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Open issues*\n${p.openIssues
          .map((i) => `• ${i.title} — ${i.owner}${i.nextStep ? `. Next: ${i.nextStep}` : ""}`)
          .join("\n")}`,
      },
    });
  if (p.nextInspection)
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `Next inspection: ${p.nextInspection.name}, ${niceDate(p.nextInspection.date)}`,
        },
      ],
    });
  if (p.delayCauses.length && p.daysLate > 0)
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: PROJECT_DELAY_BUTTON,
          text: { type: "plain_text", text: "Why is it late?" },
          value: d.id,
        },
      ],
    });
  return { text: `${d.name}: ${statusText(p.status)}`, blocks };
}

/**
 * Why a project is late: the model's explanation, then every cause with its
 * days, status and next step, biggest first. `explanation` is null when the
 * project isn't late (then there's nothing to explain).
 */
export function projectDelayReply(p: Project, explanation: string | null): Reply {
  const d = p.data;
  if (p.daysLate <= 0 || !explanation)
    return {
      text: `${d.name} is ${lateText(p.daysLate)}: forecast finish ${niceDate(d.dates.forecastFinish)}, planned ${niceDate(d.dates.plannedFinish)}. Nothing is delaying it.`,
    };

  const verb = d.dates.actualFinish ? "finished" : "is";
  const cause = (i: Issue) =>
    `• *${i.impactDays} days* · ${i.title} — ${i.category}, ${
      i.status === "open"
        ? `:red_circle: open${i.expectedResolution ? ` (expected ${niceDate(i.expectedResolution)})` : ""}`
        : `:white_check_mark: resolved${i.resolvedOn ? ` ${niceDate(i.resolvedOn)}` : ""}`
    }, during ${stageLabel(i.stage)}` +
    (i.status === "open" && i.nextStep ? `\n   Next: ${i.nextStep}` : "");

  const blocks: KnownBlock[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `:hourglass_flowing_sand: *Why ${d.name} ${verb} ${lateText(p.daysLate)}*\nPlanned finish ${niceDate(d.dates.plannedFinish)} → ${d.dates.actualFinish ? "finished" : "now"} ${niceDate(d.dates.actualFinish ?? d.dates.forecastFinish)}`,
      },
    },
    { type: "section", text: { type: "mrkdwn", text: explanation } },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Causes, biggest first*\n${p.delayCauses.map(cause).join("\n")}`,
      },
    },
  ];
  if (d.onHold)
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `:double_vertical_bar: *On hold:* ${d.onHold.reason}` },
    });
  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: "Delays can overlap, so the days per cause don't always add up to the total.",
      },
    ],
  });
  return { text: `Why ${d.name} ${verb} ${lateText(p.daysLate)}`, blocks };
}

export function projectNotFoundReply(query: string, names: string[]): Reply {
  return {
    text: `I couldn't find a project called "${query}". The projects I know are: ${names.join(", ")}.`,
  };
}

export function projectAmbiguousReply(query: string, options: Project[]): Reply {
  return {
    text: `"${query}" matches more than one project: ${options.map((p) => p.data.name).join(" or ")}. Which one?`,
  };
}

/** A plain summary of the thread memory, for "status". */
export function statusReply(s: Session): Reply {
  const lines: string[] = [];
  if (s.search)
    lines.push(`• Last search: *${s.search.city}*, ${usd(s.search.lo)} to ${usd(s.search.hi)}`);
  if (s.listings.length) lines.push(`• Listings shown: ${s.listings.map(street).join(", ")}`);
  if (s.selected) lines.push(`• Selected lot: <${s.selected.url}|${safe(s.selected.address)}>`);
  for (const j of s.jobs ?? [])
    lines.push(
      `• Queued or running: ${jobName({ kind: j.kind, subject: j.listing ? street(j.listing) : "" })}`,
    );
  if (s.planDir) {
    const extras = [
      existsSync(`${s.planDir}/estimate.json`) ? "cost estimate" : "",
      existsSync(`${s.planDir}/timeline.json`) ? "timeline" : "",
    ].filter(Boolean);
    lines.push(
      `• Latest plan: \`output/${basename(s.planDir)}\`${extras.length ? ` (with ${extras.join(" and ")})` : ""}`,
    );
  }
  if (!lines.length)
    return {
      text: "Nothing here yet. Start with a search, e.g. `land around 300k in Austin, TX`.",
    };
  return {
    text: "Here's where things stand.",
    blocks: [
      {
        type: "section",
        text: { type: "mrkdwn", text: `*So far*\n${lines.join("\n")}` },
      },
    ],
  };
}

export function errorReply(err: unknown): Reply {
  const message = err instanceof Error ? err.message : String(err);
  const cause = err instanceof Error ? (err.cause as { code?: string } | undefined) : undefined;
  // Ollama answers one request at a time; during a long job (e.g. a design)
  // a quick request can wait more than 5 minutes and time out. Ollama is
  // running then, just busy, so say that instead of "not running".
  if (cause?.code === "UND_ERR_HEADERS_TIMEOUT" || /headers timeout/i.test(message))
    return {
      text: "I'm in the middle of a long job and couldn't read your message in time. Please try again in a few minutes.",
    };
  // The Ollama client fails with "fetch failed" / ECONNREFUSED when Ollama
  // isn't running, which would mean nothing to someone in Slack.
  if (/fetch failed|ECONNREFUSED/i.test(message))
    return {
      text: "My AI model isn't reachable right now (Ollama is not running). Please try again in a bit.",
    };
  return { text: `Something went wrong: ${message}` };
}
