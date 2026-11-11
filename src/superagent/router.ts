/**
 * The router: turns a free-text Slack message into a structured request.
 *
 * People write things like "hey search me a property around 300k usd in
 * austin, texas" or "design a house on #3". The router asks Qwen to fill in a
 * small, fixed form (an "intent" plus a few details). Ollama's structured
 * output forces the reply to match the form, so the rest of the code never has
 * to guess what the model meant.
 *
 * The router does not do any work itself. It only decides WHAT the user wants;
 * src/slack.ts then sends the request to the matching skill.
 */
import { existsSync } from "node:fs";
import { z } from "zod";
import { usd } from "../listingFormat.ts";
import { chatJson } from "../llm.ts";
import type { Session } from "./sessions.ts";

/**
 * The form Qwen fills in.
 * - intent: what the user wants to do.
 * - city / budget: details for a land search ("" when not mentioned).
 * - listing: the property the user names, as written ("Corral Lane", "8446"), or "".
 *   Code matches it to a listing or a saved plan (listingFor / planFor in superagent.ts).
 * - listingNumber: a position instead of a name ("#3", "the third one"), or 0.
 * - lot: a lot size the user gave for a design ("60x150", "7500"), or "".
 * - startDate: a construction start date for a timeline, as "YYYY-MM-DD", or "".
 * - projectName / projectFilter / projectTopic: details for questions about
 *   the company's ongoing construction projects (see skills/projects.ts).
 */
export const Request = z.object({
  intent: z.enum([
    "search",
    "design",
    "estimate",
    "timeline",
    "feasibility",
    "status",
    "projects",
    "cancel",
    "help",
  ]),
  city: z.string(),
  budget: z.string(),
  listing: z.string(),
  listingNumber: z.number().int(),
  lot: z.string(),
  startDate: z.string(),
  projectName: z.string(),
  projectFilter: z.enum(["all", "behind", "on-hold"]),
  projectTopic: z.enum(["overview", "delay"]),
});
export type Request = z.infer<typeof Request>;

const SYSTEM = `You route Slack messages for SuperAgent, a construction assistant that finds land and plans houses.
Fill in the form for the user's latest message.

intent:
- "search": find land or property for sale (mentions a place, a budget, or asks for listings/lots/land).
- "design": design or plan a house on a lot, e.g. "design a house on Corral Lane" or "draw a plan for the Geronimo Trail lot".
- "estimate": cost, price to build, materials, budget for construction.
- "timeline": schedule, how long construction takes, start date.
- "feasibility": is it worth building, feasibility report or study, profit, return, sell vs rent, flood or soil risk of a property.
- "status": what has been done so far in THIS Slack thread (search, selected lot, plan), is it still working.
  The status of a named construction project ("status of the River Bend project") is "projects", not "status".
- "projects": the company's ongoing construction projects: list them, which are delayed or on hold,
  or one project by name ("what's happening with River Bend?", "why is the Blessing Ave job late?").
- "cancel": stop or cancel the job that is running or waiting ("stop", "cancel", "never mind").
- "help": greetings, questions about what the bot can do, or anything else.

city: "City, ST" with the 2-letter US state code (e.g. "Austin, TX"), or "" if none.
budget: written like "300k", "200k-350k", "under 400k" or "1.2m", or "" if none.
  "around 300k" is "300k"; "between 200 and 350 thousand" is "200k-350k"; "max 400k" is "under 400k".
listing: the property the user names for a design, cost estimate, timeline or feasibility report, copied as they wrote it: a street,
  address or house number ("Corral Lane", "the Geronimo Trail lot" = "Geronimo Trail", "8446",
  "estimate the cost for 3218 Brass Buttons Trl, Austin, TX" = "3218 Brass Buttons Trl"), or "" if they don't name one.
listingNumber: only when they point by position instead of name ("#3", "number 3", "the third one" = 3), otherwise 0.
lot: a lot size given for a design, as "WIDTHxDEPTH" in feet (e.g. "60x150") or an area in sq ft (e.g. "7500"), or "" if none.
startDate: when construction should start, as "YYYY-MM-DD" (e.g. "starting Jan 4" = the next January 4th), or "" if none.
projectName: the construction project asked about, as the user wrote it ("River Bend", "Blessing Ave"), or "" for a list.
  If they say "it" or "that project" and the thread's last project is known, use that project's name.
projectFilter: "behind" for lists of delayed / late / behind / at-risk projects, "on-hold" for paused projects, otherwise "all".
projectTopic: "delay" when asking why a project is late or what is causing a delay, otherwise "overview".

For a search follow-up that leaves out the city or budget (e.g. "same but under 200k"),
reuse the missing value from the thread's last search.`;

/**
 * Describe the thread so far in a few lines. This is what lets the model
 * resolve "the second one" or "same city but cheaper" — it can only use what
 * we tell it here, since it has no other memory of the conversation.
 */
function threadSummary(session: Session): string {
  const lines: string[] = [];
  if (session.search)
    lines.push(
      `Last search: ${session.search.city}, budget "${session.search.budget}" (${usd(session.search.lo)} to ${usd(session.search.hi)}).`,
    );
  if (session.listings.length)
    lines.push(
      `Listings shown: ${session.listings.map((l) => l.address.split(",")[0]).join("; ")}.`,
    );
  if (session.selected) lines.push(`Selected lot: ${session.selected.address}.`);
  for (const j of session.jobs ?? [])
    lines.push(
      `A ${j.kind} job${j.listing ? ` for ${j.listing.address.split(",")[0]}` : ""} is waiting or running.`,
    );
  if (session.projectName)
    lines.push(`Last construction project discussed: ${session.projectName}.`);
  if (session.planDir) {
    lines.push("A house plan has been designed for the selected lot.");
    if (existsSync(`${session.planDir}/estimate.json`)) lines.push("It has a cost estimate.");
    if (existsSync(`${session.planDir}/timeline.json`))
      lines.push("It has a construction timeline.");
  }
  return lines.length ? lines.join("\n") : "Nothing has happened in this thread yet.";
}

/**
 * `projectNames` are the construction projects in data/projects/. Telling the
 * model their names lets it recognize "tell me about Manchaca" as a project
 * question rather than a land search in the town of Manchaca, TX.
 */
export async function route(
  message: string,
  session: Session,
  projectNames: string[] = [],
): Promise<Request> {
  // The model has no clock, so today's date is included for relative dates
  // like "next month" or "Jan 4" (which year?).
  const today = new Date().toISOString().slice(0, 10);
  const projects = projectNames.length
    ? `\nOngoing construction projects (a message naming one of these, even partly, is a "projects" question): ${projectNames.join(", ")}.\n`
    : "";
  const user = `Today is ${today}.\n${projects}\nThread so far:\n${threadSummary(session)}\n\nLatest message:\n${message}`;
  const raw = await chatJson(SYSTEM, user, z.toJSONSchema(Request));
  return Request.parse(JSON.parse(raw));
}
