/**
 * Payments: the money of a project, dummy data for now. Each record is either
 *
 *   a collection      money the client pays the builder (a deposit, a draw at a milestone)
 *   a vendor payment  money the builder pays a vendor (often for one of its orders)
 *
 * and has a proposed date (when it is due) and, once paid, an actual date.
 * Its status is "pending" or "completed"; a pending one past its proposed date
 * is shown as "overdue" (worked out, never stored). Completing a record needs
 * an actual date (today if none is given) that isn't in the future; putting it
 * back to pending (a bounced check) clears it. Only pending records can be
 * deleted, so paid ones stay on the books.
 *
 * They live in data/payments.json (PAYMENTS_FILE in tests), loaded and checked
 * at startup and kept in a Map; every change is written back. The web API
 * (src/web/server.ts) and the agent's payment tools use them.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { getOrder } from "./orders.ts";
import { PROJECT_ROOT } from "./paths.ts";
import { loadProjects, STAGES } from "./superagent/skills/projects.ts";
import { getVendor } from "./vendors.ts";

const FILE = process.env.PAYMENTS_FILE || join(PROJECT_ROOT, "data", "payments.json");

export const PAYMENT_KINDS = ["collection", "vendor-payment"] as const;
export type PaymentKind = (typeof PAYMENT_KINDS)[number];
export const PAYMENT_STATUSES = ["pending", "completed"] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];
/** What the user sees: a pending record past its proposed date is overdue. */
export const PAYMENT_STATES = ["pending", "overdue", "completed"] as const;
export type PaymentState = (typeof PAYMENT_STATES)[number];

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "dates must be YYYY-MM-DD");

/** What a client may set, without defaults (zod applies defaults even inside .partial()). */
const fields = {
  title: z.string().trim().min(1).max(120),
  /** The construction stage it is for (the milestone a draw is billed at), if any. */
  stage: z.enum(STAGES).nullable(),
  /** A vendor payment for one of the vendor's orders on this project. */
  orderId: z.string().nullable(),
  amountUsd: z.number().positive(),
  proposedDate: isoDate,
  actualDate: isoDate.nullable(),
  status: z.enum(PAYMENT_STATUSES),
  notes: z.string().max(2000),
};

/** A new record. A collection has no vendor or order; a vendor payment needs a vendor. */
export const PaymentInput = z
  .object({
    kind: z.enum(PAYMENT_KINDS),
    projectId: z.string().min(1),
    vendorId: z.string().min(1).nullable().default(null),
    ...fields,
    stage: fields.stage.default(null),
    orderId: fields.orderId.default(null),
    actualDate: fields.actualDate.default(null),
    status: fields.status.default("pending"),
    notes: fields.notes.default(""),
  })
  .strict();
export type PaymentInput = z.infer<typeof PaymentInput>;

/** A partial change. The kind, project and vendor can't change: delete it and add another instead. */
export const PaymentPatch = z.object(fields).partial().strict();
export type PaymentPatch = z.infer<typeof PaymentPatch>;

const Payment = PaymentInput.safeExtend({
  id: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Payment = z.infer<typeof Payment>;

/**
 * Why a change was refused. The API answers 404 for "not-found" (the record),
 * 400 for "bad-reference" (unknown project, vendor or order) and 409 for "not-allowed".
 */
export class PaymentError extends Error {
  constructor(
    readonly kind: "not-found" | "bad-reference" | "not-allowed",
    message: string,
  ) {
    super(message);
  }
}

function load(): Map<string, Payment> {
  if (!existsSync(FILE)) return new Map();
  const parsed = z.array(Payment).safeParse(JSON.parse(readFileSync(FILE, "utf8")));
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new Error(`${FILE} is not valid: ${first?.path.join(".")}: ${first?.message}`);
  }
  return new Map(parsed.data.map((p) => [p.id, p]));
}

const payments = load();

/** Writes are chained so two quick saves can't interleave and corrupt the file. */
let saving: Promise<void> = Promise.resolve();

function save(): Promise<void> {
  const snapshot = `${JSON.stringify([...payments.values()], null, 2)}\n`;
  saving = saving.then(async () => {
    mkdirSync(dirname(FILE), { recursive: true });
    await writeFile(`${FILE}.tmp`, snapshot);
    await rename(`${FILE}.tmp`, FILE);
  });
  return saving;
}

/** PMT-1001, PMT-1002…: one more than the highest so far. */
function newId(): string {
  const highest = Math.max(1000, ...[...payments.keys()].map((id) => Number(id.slice(4)) || 0));
  return `PMT-${highest + 1}`;
}

const today = () => new Date().toISOString().slice(0, 10);

export function paymentState(p: Payment): PaymentState {
  if (p.status === "completed") return "completed";
  return p.proposedDate < today() ? "overdue" : "pending";
}

export type PaymentFilter = {
  projectId?: string;
  vendorId?: string;
  kind?: PaymentKind;
  state?: PaymentState;
  /** Matches the id, title or notes. */
  q?: string;
};

/** Records matching `filter`, by proposed date (soonest first). */
export function listPayments(filter: PaymentFilter = {}): Payment[] {
  const q = filter.q?.toLowerCase();
  return [...payments.values()]
    .filter(
      (p) =>
        (!filter.projectId || p.projectId === filter.projectId) &&
        (!filter.vendorId || p.vendorId === filter.vendorId) &&
        (!filter.kind || p.kind === filter.kind) &&
        (!filter.state || paymentState(p) === filter.state) &&
        (!q || [p.id, p.title, p.notes].some((s) => s.toLowerCase().includes(q))),
    )
    .sort((a, b) => a.proposedDate.localeCompare(b.proposedDate) || a.id.localeCompare(b.id));
}

/** A record by id; "pmt-1012" and "1012" work too. */
export function getPayment(id: string): Payment | undefined {
  const key = id.trim().toUpperCase();
  return payments.get(key) ?? payments.get(`PMT-${key}`);
}

function paymentOr404(id: string): Payment {
  const payment = getPayment(id);
  if (!payment) throw new PaymentError("not-found", `No payment ${id}.`);
  return payment;
}

const badReference = (message: string) => new PaymentError("bad-reference", message);
const notAllowed = (message: string) => new PaymentError("not-allowed", message);

/** Why `p` (a new record, or one after a change) can't be saved, or null if it can. */
function problem(p: PaymentInput): PaymentError | null {
  if (!loadProjects().some((x) => x.data.id === p.projectId))
    return badReference(`No project ${p.projectId}.`);
  if (p.kind === "collection") {
    if (p.vendorId || p.orderId)
      return notAllowed("A collection is money from the client, so it has no vendor or order.");
  } else {
    if (!p.vendorId) return notAllowed("A vendor payment needs a vendor.");
    if (!getVendor(p.vendorId)) return badReference(`No vendor ${p.vendorId}.`);
  }
  if (p.orderId) {
    const order = getOrder(p.orderId);
    if (!order) return badReference(`No order ${p.orderId}.`);
    if (order.projectId !== p.projectId || order.vendorId !== p.vendorId)
      return notAllowed(`${order.id} is not an order from this vendor for this project.`);
    if (order.status === "cancelled")
      return notAllowed(`${order.id} is cancelled, so nothing is paid for it.`);
  }
  if (p.status === "pending" && p.actualDate)
    return notAllowed("A pending payment has no actual date yet; set its status to completed too.");
  if (p.actualDate && p.actualDate > today())
    return notAllowed("The actual date can't be in the future.");
  return null;
}

/** Completing without a date means it was paid today. */
const withActualDate = <T extends Pick<Payment, "status" | "actualDate">>(p: T): T =>
  p.status === "completed" && !p.actualDate ? { ...p, actualDate: today() } : p;

/** Why `input` can't be saved as a new record, or null if it can. */
export function creationRefusal(input: PaymentInput): string | null {
  return problem(withActualDate(input))?.message ?? null;
}

export async function createPayment(input: PaymentInput): Promise<Payment> {
  const bad = problem(withActualDate(input));
  if (bad) throw bad;
  const now = new Date().toISOString();
  const payment: Payment = {
    id: newId(),
    ...withActualDate(input),
    createdAt: now,
    updatedAt: now,
  };
  payments.set(payment.id, payment);
  await save();
  return payment;
}

/** `prev` after `patch`: back to pending clears the actual date, completed without one means today. */
export function patched(prev: Payment, patch: PaymentPatch): Payment {
  const next = { ...prev, ...patch };
  if (patch.status === "pending" && patch.actualDate === undefined) next.actualDate = null;
  return withActualDate(next);
}

/** Why `patch` can't be made to `prev`, or null if it can. */
export function refusal(prev: Payment, patch: PaymentPatch): string | null {
  return problem(patched(prev, patch))?.message ?? null;
}

export async function updatePayment(id: string, patch: PaymentPatch): Promise<Payment> {
  const prev = paymentOr404(id);
  const bad = problem(patched(prev, patch));
  if (bad) throw bad;
  const next = { ...patched(prev, patch), updatedAt: new Date().toISOString() };
  payments.set(prev.id, next);
  await save();
  return next;
}

/** Delete a pending record; a completed one stays (put it back to pending first if it never happened). */
export async function deletePayment(id: string): Promise<Payment> {
  const payment = paymentOr404(id);
  if (payment.status === "completed")
    throw new PaymentError(
      "not-allowed",
      `${payment.id} is completed, so it can't be deleted. Set it back to pending first if it never happened.`,
    );
  payments.delete(payment.id);
  await save();
  return payment;
}

/** Ids of the payments to this vendor. */
export function paymentsForVendor(vendorId: string): string[] {
  return [...payments.values()].filter((p) => p.vendorId === vendorId).map((p) => p.id);
}

function viewOf(p: Payment, projectName: string | undefined) {
  const vendor = p.vendorId ? getVendor(p.vendorId) : undefined;
  const state = paymentState(p);
  return {
    ...p,
    state,
    /** Days past the proposed date (overdue) or between it and the actual date (positive = paid late). */
    daysLate:
      state === "completed"
        ? daysBetween(p.proposedDate, p.actualDate ?? p.proposedDate)
        : Math.max(0, daysBetween(p.proposedDate, today())),
    project: projectName ? { id: p.projectId, name: projectName } : null,
    vendor: vendor ? { id: vendor.id, name: vendor.name } : null,
  };
}
/** A record as the API and the agent show it: with its state, the names and how late it is. */
export type PaymentView = ReturnType<typeof viewOf>;

const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);

export function paymentViews(list: Payment[]): PaymentView[] {
  const projects = new Map(loadProjects().map((p) => [p.data.id, p.data.name]));
  return list.map((p) => viewOf(p, projects.get(p.projectId)));
}

export function paymentView(p: Payment): PaymentView {
  return viewOf(p, loadProjects().find((x) => x.data.id === p.projectId)?.data.name);
}

const round = (n: number) => Math.round(n * 100) / 100;

/** Pending (not yet due), overdue and completed amounts; the three don't overlap. */
function totals(list: Payment[]) {
  const sum = (state: PaymentState) => {
    const matching = list.filter((p) => paymentState(p) === state);
    return { usd: round(matching.reduce((s, p) => s + p.amountUsd, 0)), count: matching.length };
  };
  return { pending: sum("pending"), overdue: sum("overdue"), completed: sum("completed") };
}

/** Totals for client collections and vendor payments, and the cash the payments left the builder with. */
export function paymentSummary(list: Payment[]) {
  const collections = totals(list.filter((p) => p.kind === "collection"));
  const vendorPayments = totals(list.filter((p) => p.kind === "vendor-payment"));
  return {
    collections,
    vendorPayments,
    /** Collected minus paid out so far. */
    netCashUsd: round(collections.completed.usd - vendorPayments.completed.usd),
  };
}
export type PaymentSummary = ReturnType<typeof paymentSummary>;

/** A payment change the agent proposed and the user has to confirm (see the payment tools). */
export type PaymentChange = { entity: "payment" } & (
  | { action: "create"; input: PaymentInput }
  | { action: "update"; id: string; patch: PaymentPatch }
  | { action: "delete"; id: string }
);

/** Make a confirmed change. Returns the record as saved (or the deleted one). */
export function applyPaymentChange(change: PaymentChange): Promise<Payment> {
  if (change.action === "create") return createPayment(change.input);
  if (change.action === "update") return updatePayment(change.id, change.patch);
  return deletePayment(change.id);
}
