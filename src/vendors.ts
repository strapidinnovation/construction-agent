/**
 * Vendors: the subcontractors, suppliers and consultants the builder works
 * with (dummy data for now). Each vendor lists the construction stages it can
 * work on (the same 12 stages projects use), so it can later be assigned to a
 * project's stages.
 *
 * They live in data/vendors.json (VENDORS_FILE in tests), loaded and checked
 * against the schema at startup and kept in a Map; every change is written
 * back. The web API (src/web/server.ts) creates, reads, updates and deletes them.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { ordersForVendor } from "./orders.ts";
import { PROJECT_ROOT } from "./paths.ts";
import { paymentsForVendor } from "./payments.ts";
import { bestMatch } from "./superagent/match.ts";
import { loadProjects, STAGES } from "./superagent/skills/projects.ts";

const FILE = process.env.VENDORS_FILE || join(PROJECT_ROOT, "data", "vendors.json");

export const VENDOR_TYPES = ["subcontractor", "supplier", "consultant"] as const;
export const VENDOR_STATUSES = ["active", "inactive"] as const;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "dates must be YYYY-MM-DD");

const contactFields = {
  name: z.string().trim().max(120).nullable(),
  phone: z.string().trim().max(40).nullable(),
  email: z.email().nullable(),
};

/**
 * What a client may set on a vendor, without defaults. Zod applies a field's
 * default even inside .partial(), so the patch schema must be built from this.
 */
const fields = {
  name: z.string().trim().min(1).max(120),
  type: z.enum(VENDOR_TYPES),
  /** What they do, e.g. "Concrete & foundations", "Roof trusses". */
  trade: z.string().trim().min(1).max(120),
  /** The construction stages they can work on. */
  stages: z.array(z.enum(STAGES)).min(1),
  /** Where they work, e.g. "Austin metro". */
  serviceArea: z.string().trim().max(120).nullable(),
  licenseNumber: z.string().trim().max(60).nullable(),
  insuranceExpires: isoDate.nullable(),
  /** The builder's own rating, 1 to 5. */
  rating: z.number().min(1).max(5).nullable(),
  status: z.enum(VENDOR_STATUSES),
  notes: z.string().max(2000),
};

/** A new vendor: name, type, trade and stages are required; the rest have defaults. */
export const VendorInput = z
  .object({
    ...fields,
    contact: z
      .object({
        name: contactFields.name.default(null),
        phone: contactFields.phone.default(null),
        email: contactFields.email.default(null),
      })
      .default({ name: null, phone: null, email: null }),
    serviceArea: fields.serviceArea.default(null),
    licenseNumber: fields.licenseNumber.default(null),
    insuranceExpires: fields.insuranceExpires.default(null),
    rating: fields.rating.default(null),
    status: fields.status.default("active"),
    notes: fields.notes.default(""),
  })
  .strict();
export type VendorInput = z.infer<typeof VendorInput>;

/** A partial change: only the fields given are changed (contact fields one by one). */
export const VendorPatch = z
  .object({ ...fields, contact: z.object(contactFields).partial().strict() })
  .partial()
  .strict();
export type VendorPatch = z.infer<typeof VendorPatch>;

const Vendor = VendorInput.safeExtend({
  id: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Vendor = z.infer<typeof Vendor>;

/** Why a change was refused (the API turns these into 404 / 409 responses). */
export class VendorError extends Error {
  constructor(
    readonly kind: "not-found" | "duplicate" | "in-use",
    message: string,
  ) {
    super(message);
  }
}

function load(): Map<string, Vendor> {
  if (!existsSync(FILE)) return new Map();
  const parsed = z.array(Vendor).safeParse(JSON.parse(readFileSync(FILE, "utf8")));
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new Error(`${FILE} is not valid: ${first?.path.join(".")}: ${first?.message}`);
  }
  return new Map(parsed.data.map((v) => [v.id, v]));
}

const vendors = load();

/** Writes are chained so two quick saves can't interleave and corrupt the file. */
let saving: Promise<void> = Promise.resolve();

function save(): Promise<void> {
  const snapshot = `${JSON.stringify([...vendors.values()], null, 2)}\n`;
  saving = saving.then(async () => {
    mkdirSync(dirname(FILE), { recursive: true });
    await writeFile(`${FILE}.tmp`, snapshot);
    await rename(`${FILE}.tmp`, FILE);
  });
  return saving;
}

/** "Capitol Concrete, Inc." -> "capitol-concrete-inc", with -2, -3… if taken. */
function newId(name: string): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "vendor";
  let id = base;
  for (let n = 2; vendors.has(id); n++) id = `${base}-${n}`;
  return id;
}

function checkUniqueName(name: string, exceptId?: string): void {
  const taken = [...vendors.values()].find(
    (v) => v.id !== exceptId && v.name.toLowerCase() === name.toLowerCase(),
  );
  if (taken) throw new VendorError("duplicate", `A vendor named "${taken.name}" already exists.`);
}

export type VendorFilter = {
  type?: (typeof VENDOR_TYPES)[number];
  status?: (typeof VENDOR_STATUSES)[number];
  stage?: (typeof STAGES)[number];
  /** Matches the name, trade or contact name. */
  q?: string;
};

/** Vendors matching `filter`, by name. */
export function listVendors(filter: VendorFilter = {}): Vendor[] {
  const q = filter.q?.toLowerCase();
  return [...vendors.values()]
    .filter(
      (v) =>
        (!filter.type || v.type === filter.type) &&
        (!filter.status || v.status === filter.status) &&
        (!filter.stage || v.stages.includes(filter.stage)) &&
        (!q || [v.name, v.trade, v.contact.name ?? ""].some((s) => s.toLowerCase().includes(q))),
    )
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function getVendor(id: string): Vendor | undefined {
  return vendors.get(id);
}

export async function createVendor(input: VendorInput): Promise<Vendor> {
  checkUniqueName(input.name);
  const now = new Date().toISOString();
  const vendor: Vendor = { id: newId(input.name), ...input, createdAt: now, updatedAt: now };
  vendors.set(vendor.id, vendor);
  await save();
  return vendor;
}

export async function updateVendor(id: string, patch: VendorPatch): Promise<Vendor> {
  const prev = vendors.get(id);
  if (!prev) throw new VendorError("not-found", `No vendor ${id}.`);
  if (patch.name !== undefined) checkUniqueName(patch.name, id);
  const next: Vendor = {
    ...prev,
    ...patch,
    contact: { ...prev.contact, ...patch.contact },
    updatedAt: new Date().toISOString(),
  };
  vendors.set(id, next);
  await save();
  return next;
}

/** Names of the projects this vendor is assigned to. */
export function projectsUsingVendor(id: string): string[] {
  return loadProjects()
    .filter((p) => p.data.vendors.some((a) => a.vendorId === id))
    .map((p) => p.data.name);
}

/** Why a vendor can't be deleted (projects, orders or payments name it), or null if it can. */
export function vendorInUse(id: string): string | null {
  const vendor = vendors.get(id);
  if (!vendor) return null;
  const projects = projectsUsingVendor(id);
  const count = (n: number, what: string) => `${n} ${what}${n === 1 ? "" : "s"}`;
  const orders = ordersForVendor(id).length;
  const payments = paymentsForVendor(id).length;
  const has = [
    ...(orders ? [count(orders, "order")] : []),
    ...(payments ? [count(payments, "payment")] : []),
  ];
  const uses = [
    ...(projects.length ? [`is assigned to ${projects.join(", ")}`] : []),
    ...(has.length ? [`has ${has.join(" and ")}`] : []),
  ];
  return uses.length
    ? `${vendor.name} ${uses.join(" and ")}, so it can't be deleted. Set its status to "inactive" instead.`
    : null;
}

/** Delete a vendor. Refused while a project, an order or a payment names it. */
export async function deleteVendor(id: string): Promise<void> {
  const vendor = vendors.get(id);
  if (!vendor) throw new VendorError("not-found", `No vendor ${id}.`);
  const inUse = vendorInUse(id);
  if (inUse) throw new VendorError("in-use", inUse);
  vendors.delete(id);
  await save();
}

/**
 * Find one vendor from a loosely typed name ("capitol", "the truss supplier"
 * won't work, "Central Texas Truss" will), using the shared matcher.
 */
export function findVendor(
  query: string,
):
  | { kind: "found"; vendor: Vendor }
  | { kind: "ambiguous"; options: Vendor[] }
  | { kind: "not-found"; names: string[] } {
  const all = listVendors();
  const exact = vendors.get(query);
  if (exact) return { kind: "found", vendor: exact };
  const result = bestMatch(query, all, (v) => [v.name, v.id.replace(/-/g, " ")], {
    extraFiller: ["vendor", "company", "co", "inc", "llc"],
  });
  if (result.kind === "found") return { kind: "found", vendor: result.item };
  if (result.kind === "ambiguous") return { kind: "ambiguous", options: result.items };
  return { kind: "not-found", names: all.map((v) => v.name) };
}

/** A vendor change the agent proposed and the user has to confirm (see the vendor tools). */
export type VendorChange =
  | { action: "create"; input: VendorInput }
  | { action: "update"; id: string; patch: VendorPatch }
  | { action: "delete"; id: string };

/** Make a confirmed change. Returns the vendor as saved (or the deleted one). */
export async function applyVendorChange(change: VendorChange): Promise<Vendor> {
  if (change.action === "create") return createVendor(change.input);
  if (change.action === "update") return updateVendor(change.id, change.patch);
  const vendor = vendors.get(change.id);
  if (!vendor) throw new VendorError("not-found", `No vendor ${change.id}.`);
  await deleteVendor(change.id);
  return vendor;
}
