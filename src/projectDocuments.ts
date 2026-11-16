/**
 * A project's documents: the PDFs the agent made for it. Two ways a PDF
 * belongs to a project:
 *
 *   - address: every slow job (design, estimate, timeline, feasibility,
 *     interior) writes into output/<time>_<address slug>/, so a folder made
 *     for the project's street address holds its documents;
 *   - chat:    a PDF the agent posts in a web chat opened from the project's
 *     page is filed under that project (src/web/output.ts calls fileDocuments),
 *     whatever address it is for. These are remembered in
 *     data/project-documents.json (PROJECT_DOCUMENTS_FILE in tests).
 *
 * Only PDFs inside output/ count; output/ is not committed, so neither is the
 * list of filed ones.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { PROJECT_ROOT } from "./paths.ts";
import type { Project } from "./superagent/skills/projects.ts";

export const OUTPUT_DIR = join(PROJECT_ROOT, "output");
const FILE =
  process.env.PROJECT_DOCUMENTS_FILE || join(PROJECT_ROOT, "data", "project-documents.json");

/** What each job's PDF is, by file name. */
const KINDS = {
  "plan.pdf": { kind: "plan", title: "Site and floor plan" },
  "materials.pdf": { kind: "estimate", title: "Material and cost estimate" },
  "timeline.pdf": { kind: "timeline", title: "Construction timeline" },
  "feasibility.pdf": { kind: "feasibility", title: "Feasibility report" },
  "interior.pdf": { kind: "interior", title: "3D interior views" },
} as const;
export const DOCUMENT_KINDS = [
  "plan",
  "estimate",
  "timeline",
  "feasibility",
  "interior",
  "other",
] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

const Filed = z.object({
  projectId: z.string(),
  /** Inside output/. */
  path: z.string(),
  title: z.string(),
  conversationId: z.string(),
  filedAt: z.string(),
});
type Filed = z.infer<typeof Filed>;

function load(): Filed[] {
  if (!existsSync(FILE)) return [];
  const parsed = z.array(Filed).safeParse(JSON.parse(readFileSync(FILE, "utf8")));
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new Error(`${FILE} is not valid: ${first?.path.join(".")}: ${first?.message}`);
  }
  return parsed.data;
}

const filed = load();

/** Writes are chained so two quick saves can't interleave and corrupt the file. */
let saving: Promise<void> = Promise.resolve();

function save(): Promise<void> {
  const snapshot = `${JSON.stringify(filed, null, 2)}\n`;
  saving = saving.then(async () => {
    mkdirSync(dirname(FILE), { recursive: true });
    await writeFile(`${FILE}.tmp`, snapshot);
    await rename(`${FILE}.tmp`, FILE);
  });
  return saving;
}

/** The path inside output/, or null if the file isn't a PDF in there. */
function insideOutput(path: string): string | null {
  const full = resolve(path);
  if (!full.startsWith(OUTPUT_DIR + sep) || !full.toLowerCase().endsWith(".pdf")) return null;
  return relative(OUTPUT_DIR, full);
}

/** File the PDFs among `files` under a project (files already filed there are skipped). */
export async function fileDocuments(
  projectId: string,
  conversationId: string,
  files: { path: string; title: string }[],
): Promise<void> {
  const now = new Date().toISOString();
  let added = false;
  for (const f of files) {
    const path = insideOutput(f.path);
    if (!path || filed.some((d) => d.projectId === projectId && d.path === path)) continue;
    filed.push({ projectId, path, title: f.title, conversationId, filedAt: now });
    added = true;
  }
  if (added) await save();
}

/** "8435 Corral Ln, Austin, TX 78745" -> "8435-corral-ln-austin-tx-78745" (as the job folders are named). */
const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/**
 * Whether a job folder (2026-11-11_10-34-33_12610-river-bnd-austin-tx-78732)
 * was made for this address: same street, same ZIP code. "TX 78745" and
 * "TX, 78745" make the same slug; the city may be missing or spelled out.
 */
function folderIsFor(folder: string, address: string): boolean {
  const name = folder.replace(/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_/, "");
  if (name === folder) return false;
  const street = slug(address.split(",")[0] ?? "");
  const zip = address.match(/\b\d{5}\b(?!.*\b\d{5}\b)/)?.[0];
  return !!street && name.startsWith(`${street}-`) && (!zip || name.endsWith(`-${zip}`));
}

/** The job folders made for an address (full paths), newest first. */
export function foldersFor(address: string): string[] {
  if (!existsSync(OUTPUT_DIR)) return [];
  return readdirSync(OUTPUT_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && folderIsFor(e.name, address))
    .map((e) => e.name)
    .sort()
    .reverse()
    .map((name) => join(OUTPUT_DIR, name));
}

export type ProjectDocument = {
  /** The path inside output/; also what the agent uses to name one. */
  path: string;
  title: string;
  kind: DocumentKind;
  fileName: string;
  sizeBytes: number;
  /** When the file was made. */
  createdAt: string;
  /** How it belongs to the project (both, if it was also posted in the project's chat). */
  sources: ("address" | "chat")[];
};

function describe(
  path: string,
  sources: ProjectDocument["sources"],
  title?: string,
): ProjectDocument | null {
  const full = join(OUTPUT_DIR, path);
  if (!existsSync(full)) return null;
  const stat = statSync(full);
  const fileName = basename(path);
  const known = KINDS[fileName as keyof typeof KINDS];
  return {
    path,
    title: known?.title ?? title?.replace(/\s*\(PDF\)$/, "") ?? fileName,
    kind: known?.kind ?? "other",
    fileName,
    sizeBytes: stat.size,
    createdAt: stat.mtime.toISOString(),
    sources,
  };
}

/** Every PDF of a project, newest first. */
export function projectDocuments(project: Project): ProjectDocument[] {
  const found = new Map<string, ProjectDocument>();
  for (const folder of foldersFor(project.data.site.address)) {
    for (const file of readdirSync(folder)) {
      if (!file.toLowerCase().endsWith(".pdf")) continue;
      const doc = describe(join(basename(folder), file), ["address"]);
      if (doc) found.set(doc.path, doc);
    }
  }
  for (const f of filed.filter((d) => d.projectId === project.data.id)) {
    const known = found.get(f.path);
    if (known) known.sources.push("chat");
    else {
      const doc = describe(f.path, ["chat"], f.title);
      if (doc) found.set(doc.path, doc);
    }
  }
  return [...found.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
