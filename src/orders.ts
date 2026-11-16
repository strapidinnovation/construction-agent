/**
 * Orders: what the builder orders from a vendor for a project (materials, or
 * a piece of work), dummy data for now. An order has line items (its total is
 * worked out from them) and a status that only moves forward:
 *
 *   created -> sent -> confirmed -> fulfilled      (steps may be skipped)
 *   any of the first three -> cancelled
 *
 * Fulfilled and cancelled are final: only the notes can change. Only an order
 * still "created" (never sent to the vendor) can be deleted; after that it is
 * cancelled instead, so the record stays.
 *
 * They live in data/orders.json (ORDERS_FILE in tests), loaded and checked at
 * startup and kept in a Map; every change is written back. The web API
 * (src/web/server.ts) and the agent's order tools use them.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { PROJECT_ROOT } from "./paths.ts";
import { loadProjects, STAGES } from "./superagent/skills/projects.ts";
import { getVendor } from "./vendors.ts";

const FILE = process.env.ORDERS_FILE || join(PROJECT_ROOT, "data", "orders.json");

export const ORDER_STATUSES = ["created", "sent", "confirmed", "fulfilled", "cancelled"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];
const FINAL: readonly OrderStatus[] = ["fulfilled", "cancelled"];
export const isFinal = (s: OrderStatus) => FINAL.includes(s);

/** The statuses an order can move to from `s`. */
export function nextStatuses(s: OrderStatus): OrderStatus[] {
  if (isFinal(s)) return [];
  return [...ORDER_STATUSES.slice(ORDER_STATUSES.indexOf(s) + 1, 4), "cancelled"];
}

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "dates must be YYYY-MM-DD");

const Item = z
  .object({
    description: z.string().trim().min(1).max(200),
    quantity: z.number().positive(),
    /** e.g. "ea", "cu yd", "sq ft", "lot". */
    unit: z.string().trim().min(1).max(20),
    unitPriceUsd: z.number().min(0),
  })
  .strict();
export type OrderItem = z.infer<typeof Item>;

/** What a client may set, without defaults (zod applies defaults even inside .partial()). */
const fields = {
  title: z.string().trim().min(1).max(120),
  /** The construction stage it is for, if any. */
  stage: z.enum(STAGES).nullable(),
  items: z.array(Item).min(1).max(50),
  neededBy: isoDate.nullable(),
  notes: z.string().max(2000),
};

/** A new order. It always starts as "created". */
export const OrderInput = z
  .object({
    projectId: z.string().min(1),
    vendorId: z.string().min(1),
    ...fields,
    stage: fields.stage.default(null),
    neededBy: fields.neededBy.default(null),
    notes: fields.notes.default(""),
  })
  .strict();
export type OrderInput = z.infer<typeof OrderInput>;

/** A partial change. The project and vendor can't change: cancel and order again instead. */
export const OrderPatch = z
  .object({ ...fields, status: z.enum(ORDER_STATUSES) })
  .partial()
  .strict();
export type OrderPatch = z.infer<typeof OrderPatch>;

const Order = OrderInput.safeExtend({
  id: z.string(),
  status: z.enum(ORDER_STATUSES),
  /** Every status the order has had, oldest first; the last is the current one. */
  history: z.array(z.object({ status: z.enum(ORDER_STATUSES), at: z.string() })).min(1),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Order = z.infer<typeof Order>;

/**
 * Why a change was refused. The API answers 404 for "not-found" (the order),
 * 400 for "bad-reference" (unknown project or vendor) and 409 for "not-allowed".
 */
export class OrderError extends Error {
  constructor(
    readonly kind: "not-found" | "bad-reference" | "not-allowed",
    message: string,
  ) {
    super(message);
  }
}

function load(): Map<string, Order> {
  if (!existsSync(FILE)) return new Map();
  const parsed = z.array(Order).safeParse(JSON.parse(readFileSync(FILE, "utf8")));
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new Error(`${FILE} is not valid: ${first?.path.join(".")}: ${first?.message}`);
  }
  return new Map(parsed.data.map((o) => [o.id, o]));
}

const orders = load();

/** Writes are chained so two quick saves can't interleave and corrupt the file. */
let saving: Promise<void> = Promise.resolve();

function save(): Promise<void> {
  const snapshot = `${JSON.stringify([...orders.values()], null, 2)}\n`;
  saving = saving.then(async () => {
    mkdirSync(dirname(FILE), { recursive: true });
    await writeFile(`${FILE}.tmp`, snapshot);
    await rename(`${FILE}.tmp`, FILE);
  });
  return saving;
}

/** PO-1001, PO-1002…: one more than the highest so far. */
function newId(): string {
  const highest = Math.max(1000, ...[...orders.keys()].map((id) => Number(id.slice(3)) || 0));
  return `PO-${highest + 1}`;
}

const today = () => new Date().toISOString().slice(0, 10);

export const orderTotal = (items: OrderItem[]) =>
  Math.round(items.reduce((sum, i) => sum + i.quantity * i.unitPriceUsd, 0) * 100) / 100;

/** Past its needed-by date and not fulfilled or cancelled. */
export const isOverdue = (o: Order) => !isFinal(o.status) && !!o.neededBy && o.neededBy < today();

export type OrderFilter = {
  projectId?: string;
  vendorId?: string;
  status?: OrderStatus;
  /** Only orders not fulfilled or cancelled yet. */
  open?: boolean;
  /** Matches the id, title or an item's description. */
  q?: string;
};

/** Orders matching `filter`, newest first. */
export function listOrders(filter: OrderFilter = {}): Order[] {
  const q = filter.q?.toLowerCase();
  return [...orders.values()]
    .filter(
      (o) =>
        (!filter.projectId || o.projectId === filter.projectId) &&
        (!filter.vendorId || o.vendorId === filter.vendorId) &&
        (!filter.status || o.status === filter.status) &&
        (!filter.open || !isFinal(o.status)) &&
        (!q ||
          [o.id, o.title, ...o.items.map((i) => i.description)].some((s) =>
            s.toLowerCase().includes(q),
          )),
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
}

/** An order by id; "po-1012" and "1012" work too. */
export function getOrder(id: string): Order | undefined {
  const key = id.trim().toUpperCase();
  return orders.get(key) ?? orders.get(`PO-${key}`);
}

function orderOr404(id: string): Order {
  const order = getOrder(id);
  if (!order) throw new OrderError("not-found", `No order ${id}.`);
  return order;
}

/** The order's project and vendor must exist; a completed project or inactive vendor takes no new orders. */
export function checkReferences(projectId: string, vendorId: string): void {
  const project = loadProjects().find((p) => p.data.id === projectId);
  if (!project) throw new OrderError("bad-reference", `No project ${projectId}.`);
  if (project.status === "completed")
    throw new OrderError(
      "not-allowed",
      `${project.data.name} is completed, so it takes no new orders.`,
    );
  const vendor = getVendor(vendorId);
  if (!vendor) throw new OrderError("bad-reference", `No vendor ${vendorId}.`);
  if (vendor.status === "inactive")
    throw new OrderError("not-allowed", `${vendor.name} is inactive, so it takes no new orders.`);
}

export async function createOrder(input: OrderInput): Promise<Order> {
  checkReferences(input.projectId, input.vendorId);
  const now = new Date().toISOString();
  const order: Order = {
    id: newId(),
    ...input,
    status: "created",
    history: [{ status: "created", at: now }],
    createdAt: now,
    updatedAt: now,
  };
  orders.set(order.id, order);
  await save();
  return order;
}

/** Why `patch` can't be made to `order`, or null if it can. */
export function refusal(order: Order, patch: OrderPatch): string | null {
  const { status, ...rest } = patch;
  if (isFinal(order.status) && Object.keys(rest).some((k) => k !== "notes"))
    return `${order.id} is ${order.status}, so only its notes can change.`;
  if (status && status !== order.status && !nextStatuses(order.status).includes(status)) {
    const next = nextStatuses(order.status);
    const options = `${next.slice(0, -1).join(", ")} or ${next.at(-1)}`;
    return `${order.id} is ${order.status}, so it can't become ${status}${next.length ? ` (it can become ${options})` : " (that is final)"}.`;
  }
  return null;
}

export async function updateOrder(id: string, patch: OrderPatch): Promise<Order> {
  const prev = orderOr404(id);
  const refused = refusal(prev, patch);
  if (refused) throw new OrderError("not-allowed", refused);
  const { status, ...rest } = patch;
  const now = new Date().toISOString();
  const moved = status !== undefined && status !== prev.status;
  const next: Order = {
    ...prev,
    ...rest,
    ...(moved ? { status, history: [...prev.history, { status, at: now }] } : {}),
    updatedAt: now,
  };
  orders.set(prev.id, next);
  await save();
  return next;
}

/** Delete an order that was never sent; later ones are cancelled instead. */
export async function deleteOrder(id: string): Promise<Order> {
  const order = orderOr404(id);
  if (order.status !== "created")
    throw new OrderError(
      "not-allowed",
      `${order.id} is ${order.status}, so it can't be deleted.${isFinal(order.status) ? "" : " Cancel it instead."}`,
    );
  orders.delete(order.id);
  await save();
  return order;
}

/** Ids of the orders placed with this vendor. */
export function ordersForVendor(vendorId: string): string[] {
  return [...orders.values()].filter((o) => o.vendorId === vendorId).map((o) => o.id);
}

function viewOf(o: Order, projectName: string | undefined) {
  const vendor = getVendor(o.vendorId);
  return {
    ...o,
    totalUsd: orderTotal(o.items),
    overdue: isOverdue(o),
    project: projectName ? { id: o.projectId, name: projectName } : null,
    vendor: vendor ? { id: vendor.id, name: vendor.name } : null,
  };
}
/** An order as the API and the agent show it: with the total, the names, and whether it is overdue. */
export type OrderView = ReturnType<typeof viewOf>;

export function orderViews(list: Order[]): OrderView[] {
  const projects = new Map(loadProjects().map((p) => [p.data.id, p.data.name]));
  return list.map((o) => viewOf(o, projects.get(o.projectId)));
}

export function orderView(o: Order): OrderView {
  return viewOf(o, loadProjects().find((p) => p.data.id === o.projectId)?.data.name);
}

/** An order change the agent proposed and the user has to confirm (see the order tools). */
export type OrderChange = { entity: "order" } & (
  | { action: "create"; input: OrderInput }
  | { action: "update"; id: string; patch: OrderPatch }
  | { action: "delete"; id: string }
);

/** Make a confirmed change. Returns the order as saved (or the deleted one). */
export function applyOrderChange(change: OrderChange): Promise<Order> {
  if (change.action === "create") return createOrder(change.input);
  if (change.action === "update") return updateOrder(change.id, change.patch);
  return deleteOrder(change.id);
}
