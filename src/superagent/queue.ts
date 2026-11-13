/**
 * A one-at-a-time job queue for slow work (house design, cost estimates and
 * timelines).
 *
 * Why a queue? The AI model runs on this computer through Ollama, which
 * effectively handles one request at a time. If three jobs ran together, every
 * one of them would be slower and could run out of memory. Instead, jobs wait
 * in line and run one after another, and each requester is told their place
 * in line. A conversation can have several jobs queued at once (e.g. a
 * timeline and then an estimate); only an exact duplicate is refused.
 *
 * Cancelling:
 *   - A job that is still WAITING is simply taken out of the line.
 *   - A job that is RUNNING can't be stopped instantly (the model may be in
 *     the middle of an answer), so it is flagged with an AbortSignal. The job
 *     checks that flag at every progress step and stops there.
 *
 * The queue itself only lives in memory. superagent.ts also saves each job in
 * the conversation's memory (sessions.ts), so jobs can be restarted after the
 * bot restarts.
 */

export type JobKind = "design" | "estimate" | "timeline" | "feasibility" | "interior";

export type Job = {
  /** Unique id; the "Cancel" button on the job's status message carries it. */
  id: string;
  /** The conversation the job belongs to (see conversationKey in sessions.ts). */
  key: string;
  /** Slack user id of the person who asked; used for the per-person limit. */
  user: string;
  kind: JobKind;
  /**
   * What the job works on: the property's listing URL. Two jobs of the same
   * kind on the same property are duplicates, and a waiting estimate can find
   * the design it depends on.
   */
  target: string;
  /** The property in words, e.g. "3218 Brass Buttons Trl", for messages and name matching. */
  subject: string;
  /** Short description for logs, e.g. "estimate 3218 Brass Buttons Trl". */
  label: string;
  /**
   * The work itself. `signal.aborted` becomes true when someone cancels the
   * running job; the job should check it and stop. It must handle its own
   * errors and report them to the user.
   */
  run: (signal: AbortSignal) => Promise<void>;
  /** Called if the job is cancelled while still waiting in line (it never runs). */
  dropped: () => Promise<void>;
};

/** What other code may know about a queued job (everything except the work itself). */
export type JobInfo = Omit<Job, "run" | "dropped"> & { running: boolean };

type Entry = Job & { controller: AbortController };

const waiting: Entry[] = [];
let running: Entry | undefined;

const info = (j: Entry): JobInfo => ({
  id: j.id,
  key: j.key,
  user: j.user,
  kind: j.kind,
  target: j.target,
  subject: j.subject,
  label: j.label,
  running: j === running,
});

/** A short random id like "m3x9k2a7". */
export function newJobId(): string {
  return Date.now().toString(36).slice(-4) + Math.random().toString(36).slice(2, 6);
}

/** Every job, the running one first, then the waiting ones in order. */
export function allJobs(): JobInfo[] {
  return [...(running ? [running] : []), ...waiting].map(info);
}

/** Is the same kind of job on the same property already waiting or running? */
export function findDuplicate(kind: JobKind, target: string): JobInfo | undefined {
  return allJobs().find((j) => j.kind === kind && j.target === target);
}

/** How many jobs this person currently has waiting or running, across all conversations. */
export function jobsForUser(user: string): number {
  return allJobs().filter((j) => j.user === user).length;
}

/** How many jobs a new job would have ahead of it if it were queued now. */
export function jobsAhead(): number {
  return waiting.length + (running ? 1 : 0);
}

/** Add a job to the end of the line; it starts as soon as everything ahead of it is done. */
export function enqueue(job: Job): void {
  console.log(`Queued "${job.label}" (${jobsAhead()} ahead)`);
  waiting.push({ ...job, controller: new AbortController() });
  void next();
}

export type CancelResult = { result: "removed" | "stopping"; job: JobInfo } | { result: "none" };

/**
 * Cancel a job.
 * - With `id` (the Cancel button): that exact job.
 * - Without (someone typed "cancel"): this conversation's running job, or if
 *   none is running, its most recently queued one.
 * "removed" = it was waiting and is now out of the line; "stopping" = it is
 * running and will stop at its next step; "none" = nothing to cancel.
 */
export function cancel(key: string, id?: string): CancelResult {
  const mine = (j: Entry) => (id ? j.id === id : j.key === key);
  if (running && mine(running)) {
    console.log(`Cancelling running job "${running.label}"`);
    running.controller.abort();
    return { result: "stopping", job: info(running) };
  }
  // The most recently queued match (search from the end of the line).
  let i = waiting.length - 1;
  while (i >= 0 && !mine(waiting[i]!)) i--;
  if (i < 0) return { result: "none" };
  const [job] = waiting.splice(i, 1);
  console.log(`Cancelled waiting job "${job!.label}"`);
  void job!.dropped();
  return { result: "removed", job: info(job!) };
}

/** Start the next job if nothing is running. Called after every enqueue and every finished job. */
async function next(): Promise<void> {
  if (running) return;
  running = waiting.shift();
  if (!running) return;

  const job = running;
  const started = Date.now();
  console.log(`Running "${job.label}"`);
  try {
    await job.run(job.controller.signal);
  } catch (err) {
    // Jobs report their own errors to Slack; this is only a safety net so one
    // broken job can never stop the queue.
    console.error(`Job "${job.label}" failed:`, err);
  } finally {
    console.log(`Finished "${job.label}" in ${Math.round((Date.now() - started) / 1000)}s`);
    running = undefined;
    void next();
  }
}
