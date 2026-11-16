/**
 * Change orders: changes to a project's scope after the contract, each with
 * its cost and the days it adds. Two kinds:
 *
 *   small   finishes, fixtures, material swaps, extra outlets: priced from the
 *           project's estimate line by line, the design doesn't change
 *   design  a new room, a bathroom, a bigger footprint: a revised plan and
 *           estimate are made in a new folder (revisions.ts), and the change
 *           is priced by comparing the trades it affects
 *
 * A change order is pending (waiting for the client), approved or rejected;
 * only a pending one can be decided. Approving one adds its amount to the
 * project's approved change orders and moves the forecast finish by its days
 * (the original contract stays as it was). Every saved change order gets a
 * one-page PDF in output/change-orders/, made again when it is decided; it
 * shows on the project's Documents tab.
 *
 * They live in data/change-orders.json (CHANGE_ORDERS_FILE in tests), loaded
 * and checked at startup; every change is written back. The web API and the
 * agent's change order tools use them.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import { PROJECT_ROOT } from "./paths.ts";
import { card, esc, page, section, usd } from "./report.ts";
import { markRevision } from "./revisions.ts";
import { printPdf } from "./superagent/render.ts";
import { addChangeOrder, loadProjects, type Project } from "./superagent/skills/projects.ts";

const FILE = process.env.CHANGE_ORDERS_FILE || join(PROJECT_ROOT, "data", "change-orders.json");
const OUTPUT_DIR = join(PROJECT_ROOT, "output");
/** Inside output/, so the files are served and listed like the other reports. */
const PDF_FOLDER = "change-orders";

export const CHANGE_ORDER_KINDS = ["small", "design"] as const;
export type ChangeOrderKind = (typeof CHANGE_ORDER_KINDS)[number];
export const CHANGE_ORDER_STATUSES = ["pending", "approved", "rejected"] as const;
export type ChangeOrderStatus = (typeof CHANGE_ORDER_STATUSES)[number];

/** One priced line: a trade (and optionally one item in it) before and after the change. */
export const ChangeOrderLine = z
  .object({
    trade: z.string().trim().min(1).max(80),
    item: z.string().trim().max(160).nullable().default(null),
    oldUsd: z.number().min(0),
    newUsd: z.number().min(0),
    note: z.string().max(300).default(""),
  })
  .strict();
export type ChangeOrderLine = z.infer<typeof ChangeOrderLine>;

export const ChangeOrderInput = z
  .object({
    projectId: z.string().min(1),
    kind: z.enum(CHANGE_ORDER_KINDS),
    title: z.string().trim().min(1).max(120),
    /** Why: "Client request", "Rotten subfloor found", "City requires a fire sprinkler". */
    reason: z.string().trim().max(500).default(""),
    lines: z.array(ChangeOrderLine).max(40).default([]),
    /** Negative when work is removed. */
    amountUsd: z.number(),
    daysAdded: z.number().int().min(-365).max(365).default(0),
    /** A design change: the revised plan folder (in output/) and what it changed. */
    revision: z
      .object({ dir: z.string().min(1), basedOn: z.string().min(1), changes: z.array(z.string()) })
      .nullable()
      .default(null),
    status: z.enum(CHANGE_ORDER_STATUSES).default("pending"),
    notes: z.string().max(2000).default(""),
  })
  .strict();
export type ChangeOrderInput = z.infer<typeof ChangeOrderInput>;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const ChangeOrder = ChangeOrderInput.safeExtend({
  id: z.string(),
  requestedOn: isoDate,
  decidedOn: isoDate.nullable(),
  /** The PDF, inside output/. */
  pdf: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ChangeOrder = z.infer<typeof ChangeOrder>;

/** The API answers 404 for "not-found", 400 for "bad-reference" (unknown project) and 409 for "not-allowed". */
export class ChangeOrderError extends Error {
  constructor(
    readonly kind: "not-found" | "bad-reference" | "not-allowed",
    message: string,
  ) {
    super(message);
  }
}

function load(): Map<string, ChangeOrder> {
  if (!existsSync(FILE)) return new Map();
  const parsed = z.array(ChangeOrder).safeParse(JSON.parse(readFileSync(FILE, "utf8")));
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new Error(`${FILE} is not valid: ${first?.path.join(".")}: ${first?.message}`);
  }
  return new Map(parsed.data.map((c) => [c.id, c]));
}

const changeOrders = load();

/** Writes are chained so two quick saves can't interleave and corrupt the file. */
let saving: Promise<void> = Promise.resolve();

function save(): Promise<void> {
  const snapshot = `${JSON.stringify([...changeOrders.values()], null, 2)}\n`;
  saving = saving.then(async () => {
    mkdirSync(dirname(FILE), { recursive: true });
    await writeFile(`${FILE}.tmp`, snapshot);
    await rename(`${FILE}.tmp`, FILE);
  });
  return saving;
}

/** CO-1001, CO-1002…: one more than the highest so far. */
function newId(): string {
  const highest = Math.max(1000, ...[...changeOrders.keys()].map((id) => Number(id.slice(3)) || 0));
  return `CO-${highest + 1}`;
}

const today = () => new Date().toISOString().slice(0, 10);
const round = (n: number) => Math.round(n * 100) / 100;

/** The amount of a set of lines: what the change adds (negative if it saves money). */
export const linesTotal = (lines: Pick<ChangeOrderLine, "oldUsd" | "newUsd">[]) =>
  round(lines.reduce((n, l) => n + l.newUsd - l.oldUsd, 0));

export type ChangeOrderFilter = {
  projectId?: string;
  status?: ChangeOrderStatus;
  kind?: ChangeOrderKind;
};

/** Change orders matching `filter`, newest first. */
export function listChangeOrders(filter: ChangeOrderFilter = {}): ChangeOrder[] {
  return [...changeOrders.values()]
    .filter(
      (c) =>
        (!filter.projectId || c.projectId === filter.projectId) &&
        (!filter.status || c.status === filter.status) &&
        (!filter.kind || c.kind === filter.kind),
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
}

/** A change order by id; "co-1003" and "1003" work too. */
export function getChangeOrder(id: string): ChangeOrder | undefined {
  const key = id.trim().toUpperCase();
  return changeOrders.get(key) ?? changeOrders.get(`CO-${key}`);
}

function projectOf(id: string): Project {
  const project = loadProjects().find((p) => p.data.id === id);
  if (!project) throw new ChangeOrderError("bad-reference", `No project ${id}.`);
  return project;
}

/** Save a change order. Approved right away, it is applied to the project too. */
export async function createChangeOrder(raw: ChangeOrderInput): Promise<ChangeOrder> {
  const input = ChangeOrderInput.parse(raw);
  const project = projectOf(input.projectId);
  if (project.status === "completed")
    throw new ChangeOrderError("not-allowed", `${project.data.name} is completed.`);
  const now = new Date().toISOString();
  const co: ChangeOrder = {
    ...input,
    amountUsd: round(input.amountUsd),
    id: newId(),
    requestedOn: today(),
    decidedOn: input.status === "pending" ? null : today(),
    pdf: null,
    createdAt: now,
    updatedAt: now,
  };
  changeOrders.set(co.id, co);
  await save();
  if (co.status === "approved") await addChangeOrder(co.projectId, co);
  return settled(co);
}

/** Approve or reject a pending change order. */
export async function decideChangeOrder(
  id: string,
  status: Exclude<ChangeOrderStatus, "pending">,
): Promise<ChangeOrder> {
  const prev = getChangeOrder(id);
  if (!prev) throw new ChangeOrderError("not-found", `No change order ${id}.`);
  if (prev.status !== "pending")
    throw new ChangeOrderError("not-allowed", `${prev.id} is already ${prev.status}.`);
  const co: ChangeOrder = {
    ...prev,
    status,
    decidedOn: today(),
    updatedAt: new Date().toISOString(),
  };
  changeOrders.set(co.id, co);
  await save();
  if (status === "approved") await addChangeOrder(co.projectId, co);
  return settled(co);
}

/** After a save: tell its revision folder, and make its PDF (a failed PDF doesn't undo the save). */
async function settled(co: ChangeOrder): Promise<ChangeOrder> {
  if (co.revision)
    await markRevision(join(OUTPUT_DIR, co.revision.dir), {
      status: co.status,
      changeOrderId: co.id,
    });
  try {
    const pdf = await writePdf(co);
    const next = { ...co, pdf };
    changeOrders.set(co.id, next);
    await save();
    return next;
  } catch (err) {
    console.error(`Could not make the PDF for ${co.id}:`, err);
    return co;
  }
}

/** Count, amount and days of each status; the three don't overlap. */
export function changeOrderSummary(list: ChangeOrder[]) {
  const sum = (status: ChangeOrderStatus) => {
    const matching = list.filter((c) => c.status === status);
    return {
      count: matching.length,
      usd: round(matching.reduce((n, c) => n + c.amountUsd, 0)),
      days: matching.reduce((n, c) => n + c.daysAdded, 0),
    };
  };
  return { pending: sum("pending"), approved: sum("approved"), rejected: sum("rejected") };
}
export type ChangeOrderSummary = ReturnType<typeof changeOrderSummary>;

/** A change order as the API and the agent show it: with the project's name. */
export function changeOrderView(co: ChangeOrder, projects = loadProjects()) {
  const project = projects.find((p) => p.data.id === co.projectId);
  return { ...co, project: project ? { id: project.data.id, name: project.data.name } : null };
}
export type ChangeOrderView = ReturnType<typeof changeOrderView>;

/** A change order the agent proposed and the user has to answer (see the change order tools). */
export type ChangeOrderChange = { entity: "change-order" } & (
  | { action: "create"; input: ChangeOrderInput }
  | { action: "decide"; id: string; status: Exclude<ChangeOrderStatus, "pending"> }
);

// ---------------------------------------------------------------------------
// The PDF: one page with the change, its cost, the new contract and schedule,
// and lines for signatures.
// ---------------------------------------------------------------------------

const STATUS_TEXT: Record<ChangeOrderStatus, string> = {
  pending: "Pending approval",
  approved: "Approved",
  rejected: "Rejected",
};

const signed = (n: number) => `${n < 0 ? "-" : "+"}${usd(Math.abs(n))}`;
const days = (n: number) => `${n > 0 ? "+" : ""}${n} ${Math.abs(n) === 1 ? "day" : "days"}`;
const longDate = (iso: string) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
const shift = (iso: string, n: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

function pdfHtml(co: ChangeOrder, project: Project, dir: string, file: string): string {
  const d = project.data;
  // What the contract and finish were before this change order (after it, if it is approved).
  const applied = co.status === "approved";
  const changesBefore = round(d.budget.approvedChangeOrdersUsd - (applied ? co.amountUsd : 0));
  const before = d.budget.contractUsd + changesBefore;
  const finishBefore = applied
    ? shift(d.dates.forecastFinish, -co.daysAdded)
    : d.dates.forecastFinish;

  const lines = co.lines.length
    ? `<table><tr><th>Trade</th><th>Item</th><th class="num">Original</th><th class="num">Revised</th>` +
      `<th class="num">Difference</th><th>Note</th></tr>` +
      co.lines
        .map(
          (l) =>
            `<tr><td>${esc(l.trade)}</td><td>${esc(l.item ?? "Whole trade")}</td>` +
            `<td class="num">${usd(l.oldUsd)}</td><td class="num">${usd(l.newUsd)}</td>` +
            `<td class="num">${signed(l.newUsd - l.oldUsd)}</td><td>${esc(l.note)}</td></tr>`,
        )
        .join("") +
      `<tr class="total"><td colspan="4">Lines total</td><td class="num">${signed(linesTotal(co.lines))}</td><td></td></tr>` +
      `</table>` +
      (Math.abs(linesTotal(co.lines) - co.amountUsd) >= 1
        ? `<p class="note">The change order amount (${signed(co.amountUsd)}) was set by the builder; the lines show how it was worked out.</p>`
        : "")
    : `<p>Priced as a lump sum of ${signed(co.amountUsd)}.</p>`;

  const revision = co.revision
    ? section(
        "Revised design",
        `<p>The plan was redrawn with this change and estimated again. The original design stays on file.</p>` +
          `<ul>${co.revision.changes.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>` +
          `<table><tr><th>Original design</th><td>${esc(co.revision.basedOn)}</td></tr>` +
          `<tr><th>Revised design</th><td>${esc(co.revision.dir)}</td></tr></table>`,
      )
    : "";

  const signature = (who: string) =>
    `<div class="sign"><span></span><p>${esc(who)}</p><span></span><p>Date</p></div>`;

  const body =
    `<div class="cards">` +
    card(
      "Amount",
      signed(co.amountUsd),
      co.amountUsd < 0 ? "credit to the client" : "added to the contract",
    ) +
    card("Schedule", days(co.daysAdded), "to the forecast finish") +
    card(
      "Status",
      STATUS_TEXT[co.status],
      co.decidedOn ? `on ${longDate(co.decidedOn)}` : "waiting for the client",
    ) +
    card(
      "Kind",
      co.kind === "design" ? "Design change" : "Small change",
      co.kind === "design" ? "revised plan and estimate" : "same design",
    ) +
    `</div>` +
    section(
      "The change",
      `<h3>${esc(co.title)}</h3>` +
        (co.reason ? `<p><strong>Reason:</strong> ${esc(co.reason)}</p>` : "") +
        (co.notes ? `<p>${esc(co.notes)}</p>` : ""),
    ) +
    revision +
    section("Cost", lines) +
    section(
      "Contract and schedule",
      `<table>` +
        `<tr><th>Original contract</th><td class="num">${usd(d.budget.contractUsd)}</td></tr>` +
        `<tr><th>Approved change orders before this one</th><td class="num">${signed(changesBefore)}</td></tr>` +
        `<tr><th>Contract before this change</th><td class="num">${usd(before)}</td></tr>` +
        `<tr><th>This change order</th><td class="num">${signed(co.amountUsd)}</td></tr>` +
        `<tr class="total"><th>Contract with this change</th><td class="num">${usd(before + co.amountUsd)}</td></tr>` +
        `<tr><th>Forecast finish before this change</th><td class="num">${longDate(finishBefore)}</td></tr>` +
        `<tr class="total"><th>Forecast finish with this change</th><td class="num">${longDate(shift(finishBefore, co.daysAdded))}</td></tr>` +
        `</table>`,
    ) +
    section(
      "Approval",
      `<p>By signing, the client and the builder agree to the change, its cost and its effect on the schedule.</p>` +
        `<div class="signatures">${signature(`Client: ${d.client}`)}${signature(`Builder: ${d.team.builder}`)}</div>` +
        `<style>.signatures{display:grid;grid-template-columns:1fr 1fr;gap:28px;margin-top:28px}` +
        `.sign{display:grid;grid-template-columns:2fr 1fr;gap:4px 16px}.sign span{border-bottom:1px solid #1f2328;height:34px}` +
        `.sign p{margin:0;font-family:var(--sans);font-size:12px;color:#5d6470}</style>`,
    );

  return page({
    dir,
    file,
    kind: `Change order ${co.id}`,
    title: `${d.name}: ${co.title}`,
    meta: [
      ["Project", d.name],
      ["Address", d.site.address],
      ["Client", d.client],
      ["Requested", longDate(co.requestedOn)],
      ["Status", STATUS_TEXT[co.status]],
    ],
    body,
  });
}

/** Make (or remake) the change order's PDF; returns its path inside output/. */
async function writePdf(co: ChangeOrder): Promise<string> {
  const dir = join(OUTPUT_DIR, PDF_FOLDER);
  await mkdir(dir, { recursive: true });
  const file = `${co.id}.html`;
  const htmlPath = join(dir, file);
  const pdfPath = join(dir, `${co.id}.pdf`);
  await writeFile(htmlPath, pdfHtml(co, projectOf(co.projectId), dir, file));
  await printPdf(htmlPath, pdfPath);
  return join(PDF_FOLDER, basename(pdfPath));
}
