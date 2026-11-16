/**
 * Design revisions: a design change order (add a bathroom, a room, a story)
 * makes a new plan folder in output/ from the project's current design, with
 * its own plan, estimate and (for projects still in planning) timeline. The
 * original folder is never changed.
 *
 * A revision folder holds revision.json, which says what it revises and the
 * state of its change order:
 *
 *   proposed   made, waiting for the user's answer in the chat
 *   pending    saved as a change order waiting for the client's approval
 *   approved   the change order was approved: this is now the current design
 *   rejected   the change order was rejected
 *   discarded  the user didn't save it as a change order
 *
 * Only approved revisions count as the current plan (for the agent's reports,
 * new estimates and the project's "Current" documents); a folder without
 * revision.json is an ordinary design.
 */
import { existsSync, readFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const REVISION_STATUSES = [
  "proposed",
  "pending",
  "approved",
  "rejected",
  "discarded",
] as const;
export type RevisionStatus = (typeof REVISION_STATUSES)[number];

export type Revision = {
  /** The folder name (in output/) of the design it revises. */
  basedOn: string;
  title: string;
  /** What changed, as asked for. */
  changes: string[];
  changeOrderId: string | null;
  status: RevisionStatus;
  createdAt: string;
};

const FILE = "revision.json";

export function readRevision(dir: string): Revision | null {
  const path = join(dir, FILE);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Revision;
  } catch {
    return null;
  }
}

export async function writeRevision(dir: string, revision: Revision): Promise<void> {
  const path = join(dir, FILE);
  await writeFile(`${path}.tmp`, `${JSON.stringify(revision, null, 2)}\n`);
  await rename(`${path}.tmp`, path);
}

/** Change a revision's change order and status (no-op if the folder isn't a revision). */
export async function markRevision(
  dir: string,
  change: Pick<Revision, "status"> & Partial<Pick<Revision, "changeOrderId">>,
): Promise<void> {
  const revision = readRevision(dir);
  if (revision) await writeRevision(dir, { ...revision, ...change });
}

/** Whether a plan folder is a current design: an ordinary one, or an approved revision. */
export function isCurrentPlan(dir: string): boolean {
  const revision = readRevision(dir);
  return !revision || revision.status === "approved";
}
