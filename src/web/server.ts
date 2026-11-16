/**
 * The HTTP API for the web UI (Express): projects (dashboard and project
 * screens) and chat with the agent. src/main.ts starts it on HTTP_PORT.
 *
 *   GET    /health
 *   GET    /projects?filter=all|delayed|behind|attention|on-hold&completed=true
 *   GET    /projects/summary
 *   GET    /projects/:id                 (an id, or a name like "river bend")
 *   GET    /projects/:id/documents       (the PDFs made for it, newest first; open them at their url)
 *   GET    /vendors?type=&status=&stage=&q=
 *   GET    /vendors/:id
 *   POST   /vendors                      { name, type, trade, stages, contact?, ... }
 *   PATCH  /vendors/:id                  (only the fields given change)
 *   DELETE /vendors/:id
 *   GET    /orders?projectId=&vendorId=&status=&open=true&q=
 *   GET    /orders/:id                   ("PO-1012")
 *   POST   /orders                       { projectId, vendorId, title, items, stage?, neededBy?, notes? }
 *   PATCH  /orders/:id                   (only the fields given change; status only moves forward)
 *   DELETE /orders/:id                   (only while "created"; cancel it after that)
 *   GET    /payments?projectId=&vendorId=&kind=&state=&q=   (with pending / overdue / completed totals)
 *   GET    /payments/:id                 ("PMT-1012")
 *   POST   /payments                     { kind, projectId, vendorId?, title, amountUsd, proposedDate, ... }
 *   PATCH  /payments/:id                 (only the fields given change)
 *   DELETE /payments/:id                 (only while pending)
 *   GET    /conversations                (chat sidebar, newest first)
 *   POST   /conversations                { projectId? }
 *   GET    /conversations/:id            (with every message)
 *   DELETE /conversations/:id
 *   POST   /conversations/:id/messages   { text }
 *   POST   /conversations/:id/actions    { actionId, value }   (a button under a message)
 *   GET    /conversations/:id/stream     (Server-Sent Events: "message" with each new or changed message)
 *   GET    /files/:token                 (plan images and PDFs linked from messages)
 *
 * Sending a message returns at once; the agent's replies arrive on the
 * stream (and are in the conversation's messages). The agent can work for an
 * hour and resumes after a restart, so the stream is per conversation, not
 * per request: the chat screen keeps it open while it is shown.
 *
 * There are no logins: this is a local test setup, so every request is the
 * same user (WEB_USER).
 */
import express, { type ErrorRequestHandler, type Request, type Response } from "express";
import { join } from "node:path";
import { z } from "zod";
import { answerMission, approveMission, cancelMission } from "../superagent/agent/agent.ts";
import {
  activeMission,
  activeMissions,
  getMission,
  waitingMission,
} from "../superagent/agent/missions.ts";
import {
  MISSION_ANSWER_ACTION,
  MISSION_CANCEL_BUTTON,
  MISSION_GO_BUTTON,
} from "../superagent/agent/missionUi.ts";
import {
  createOrder,
  deleteOrder,
  getOrder,
  listOrders,
  ORDER_STATUSES,
  OrderError,
  OrderInput,
  OrderPatch,
  orderView,
  orderViews,
  updateOrder,
} from "../orders.ts";
import {
  createPayment,
  deletePayment,
  getPayment,
  listPayments,
  PAYMENT_KINDS,
  PAYMENT_STATES,
  PaymentError,
  PaymentInput,
  PaymentPatch,
  paymentSummary,
  paymentView,
  paymentViews,
  updatePayment,
} from "../payments.ts";
import { OUTPUT_DIR, projectDocuments } from "../projectDocuments.ts";
import { PROJECT_FILTERS, STAGES } from "../superagent/skills/projects.ts";
import {
  createVendor,
  deleteVendor,
  getVendor,
  listVendors,
  updateVendor,
  VENDOR_STATUSES,
  VENDOR_TYPES,
  VendorError,
  VendorInput,
  VendorPatch,
} from "../vendors.ts";
import {
  CANCEL_BUTTON,
  DESIGN_BUTTON,
  errorReply,
  ESTIMATE_BUTTON,
  FEASIBILITY_BUTTON,
  INTERIOR_BUTTON,
  TIMELINE_BUTTON,
} from "../superagent/slackUi.ts";
import {
  cancelJob,
  handleMessage,
  startDesign,
  startEstimate,
  startFeasibility,
  startInterior,
  startTimeline,
  type Ctx,
} from "../superagent/superagent.ts";
import {
  allConversations,
  createConversation,
  deleteConversation,
  getConversation,
  newMessageId,
  setTitle,
  subscribe,
  upsertMessage,
  type Conversation,
} from "./conversations.ts";
import { fileForToken, fileUrl, webCtx, webKey, WEB_USER } from "./output.ts";
import { lookupProject, projectCounts, projectDetail, projectList } from "./projects.ts";

const HEARTBEAT_MS = 15_000;
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/** The request body, checked against `schema`. */
function body<T>(req: Request, schema: z.ZodType<T>): T {
  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new HttpError(400, `${first?.path.join(".") || "body"}: ${first?.message}`);
  }
  return parsed.data;
}

function conversationOr404(id: string): Conversation {
  const c = getConversation(id);
  if (!c) throw new HttpError(404, `No conversation ${id}.`);
  return c;
}

const listItem = (c: Conversation) => ({
  id: c.id,
  title: c.title,
  projectId: c.projectId ?? null,
  createdAt: c.createdAt,
  updatedAt: c.updatedAt,
  messageCount: c.messages.length,
  busy: activeMissions(webKey(c.id)).length > 0,
});

function addUserMessage(conversationId: string, text: string) {
  const now = new Date().toISOString();
  const message = {
    id: newMessageId(),
    role: "user" as const,
    kind: "text" as const,
    text,
    createdAt: now,
    updatedAt: now,
  };
  upsertMessage(conversationId, message);
  return message;
}

/** Run something for a conversation; a failure becomes an error reply in the chat, as in Slack. */
async function inChat(ctx: Ctx, work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (err) {
    console.error(err);
    await ctx.out.reply(errorReply(err));
  }
}

// ---------------------------------------------------------------------------
// Chat.
// ---------------------------------------------------------------------------

const MessageBody = z.object({ text: z.string().trim().min(1).max(4000) });

async function postMessage(c: Conversation, text: string) {
  const isFirst = !c.messages.some((m) => m.role === "user");
  const message = addUserMessage(c.id, text);
  if (isFirst) setTitle(c.id, text.length > 60 ? `${text.slice(0, 59)}…` : text);

  // A chat opened from a project screen is about that project.
  let goal = text;
  if (isFirst && c.projectId) {
    const found = lookupProject(c.projectId);
    if (found.kind === "found") goal = `About the project "${found.project.data.name}": ${text}`;
  }
  // The message may answer (or cancel) a mission that is waiting; its status message carries on.
  const key = webKey(c.id);
  const mission = waitingMission(key, WEB_USER) ?? activeMission(key);
  const ctx = webCtx(c.id, WEB_USER, mission?.id);
  console.log(`Web message in ${ctx.key}: "${text}"`);
  await inChat(ctx, () => handleMessage(ctx, goal));
  return message;
}

const ActionBody = z.object({ actionId: z.string().min(1), value: z.string().default("") });

/** A button under a message: the same actions as the Slack buttons (see src/slack.ts). */
async function runAction(c: Conversation, actionId: string, value: string): Promise<void> {
  const ctx = webCtx(c.id);
  const planDir = value || undefined;

  /** The mission a mission button is for, and a ctx that reports on it. */
  const missionHere = (id: string) => {
    const m = getMission(id);
    if (!m || m.key !== webKey(c.id))
      throw new HttpError(404, `No mission ${id} in this conversation.`);
    return { m, ctx: webCtx(c.id, WEB_USER, id) };
  };

  if (actionId === MISSION_GO_BUTTON) {
    const { ctx } = missionHere(value);
    return inChat(ctx, () => approveMission(ctx, value));
  }
  if (actionId === MISSION_CANCEL_BUTTON) {
    const { ctx } = missionHere(value);
    return inChat(ctx, () => cancelMission(ctx, value));
  }
  if (MISSION_ANSWER_ACTION.test(actionId)) {
    const [id = "", index = ""] = value.split("|");
    const { m, ctx } = missionHere(id);
    const answer = m.pendingQuestion?.options[Number(index)];
    if (answer === undefined) throw new HttpError(409, "That question has already been answered.");
    addUserMessage(c.id, answer);
    return inChat(ctx, () => answerMission(ctx, id, answer));
  }
  if (actionId === DESIGN_BUTTON)
    return inChat(ctx, () =>
      startDesign(ctx, /^\d+$/.test(value) ? { number: Number(value) } : { url: value }, ""),
    );
  if (actionId === ESTIMATE_BUTTON) return inChat(ctx, () => startEstimate(ctx, { planDir }));
  if (actionId === TIMELINE_BUTTON) return inChat(ctx, () => startTimeline(ctx, "", { planDir }));
  if (actionId === FEASIBILITY_BUTTON) return inChat(ctx, () => startFeasibility(ctx, { planDir }));
  if (actionId === INTERIOR_BUTTON) return inChat(ctx, () => startInterior(ctx, { planDir }));
  if (actionId === CANCEL_BUTTON) return inChat(ctx, () => cancelJob(ctx, value || undefined));
  throw new HttpError(400, `Unknown action "${actionId}".`);
}

function stream(req: Request, res: Response, c: Conversation): void {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  res.write("retry: 3000\n\n");
  const unsubscribe = subscribe(c.id, (message) => {
    res.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
  });
  const heartbeat = setInterval(() => res.write(": ping\n\n"), HEARTBEAT_MS);
  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
}

// ---------------------------------------------------------------------------
// Routes.
// ---------------------------------------------------------------------------

const FilterParam = z.enum(PROJECT_FILTERS).default("all");

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use((req, res, next) => {
  res.set({
    "access-control-allow-origin": CORS_ORIGIN,
    "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "access-control-allow-headers": "content-type",
  });
  if (req.method === "OPTIONS") return void res.sendStatus(204);
  next();
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/projects", (req, res) => {
  const filter = FilterParam.safeParse(req.query.filter ?? undefined);
  if (!filter.success)
    throw new HttpError(400, `filter must be one of ${PROJECT_FILTERS.join(", ")}.`);
  res.json({ projects: projectList(filter.data, req.query.completed === "true") });
});

app.get("/projects/summary", (_req, res) => {
  res.json(projectCounts());
});

app.get("/projects/:id", (req, res) => {
  const { id } = req.params;
  const found = lookupProject(id);
  if (found.kind === "ambiguous")
    throw new HttpError(409, `"${id}" matches more than one project.`, { options: found.options });
  if (found.kind === "not-found")
    throw new HttpError(404, `No project "${id}".`, { names: found.names });
  res.json(projectDetail(found.project));
});

app.get("/projects/:id/documents", (req, res) => {
  const found = lookupProject(req.params.id);
  if (found.kind !== "found") throw new HttpError(404, `No project "${req.params.id}".`);
  const documents = projectDocuments(found.project).map((d) => ({
    ...d,
    url: fileUrl(join(OUTPUT_DIR, d.path)),
  }));
  res.json({ documents });
});

const VendorQuery = z.object({
  type: z.enum(VENDOR_TYPES).optional(),
  status: z.enum(VENDOR_STATUSES).optional(),
  stage: z.enum(STAGES).optional(),
  q: z.string().trim().min(1).optional(),
});

app.get("/vendors", (req, res) => {
  const query = VendorQuery.safeParse(req.query);
  if (!query.success) {
    const first = query.error.issues[0];
    throw new HttpError(400, `${first?.path.join(".")}: ${first?.message}`);
  }
  res.json({ vendors: listVendors(query.data) });
});

app.get("/vendors/:id", (req, res) => {
  const vendor = getVendor(req.params.id);
  if (!vendor) throw new HttpError(404, `No vendor ${req.params.id}.`);
  res.json(vendor);
});

app.post("/vendors", async (req, res) => {
  res.status(201).json(await createVendor(body(req, VendorInput)));
});

app.patch("/vendors/:id", async (req, res) => {
  res.json(await updateVendor(req.params.id, body(req, VendorPatch)));
});

app.delete("/vendors/:id", async (req, res) => {
  await deleteVendor(req.params.id);
  res.json({ deleted: req.params.id });
});

const OrderQuery = z.object({
  projectId: z.string().trim().min(1).optional(),
  vendorId: z.string().trim().min(1).optional(),
  status: z.enum(ORDER_STATUSES).optional(),
  open: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
  q: z.string().trim().min(1).optional(),
});

function orderOr404(id: string) {
  const order = getOrder(id);
  if (!order) throw new HttpError(404, `No order ${id}.`);
  return order;
}

app.get("/orders", (req, res) => {
  const query = OrderQuery.safeParse(req.query);
  if (!query.success) {
    const first = query.error.issues[0];
    throw new HttpError(400, `${first?.path.join(".")}: ${first?.message}`);
  }
  res.json({ orders: orderViews(listOrders(query.data)) });
});

app.get("/orders/:id", (req, res) => {
  res.json(orderView(orderOr404(req.params.id)));
});

app.post("/orders", async (req, res) => {
  res.status(201).json(orderView(await createOrder(body(req, OrderInput))));
});

app.patch("/orders/:id", async (req, res) => {
  res.json(orderView(await updateOrder(req.params.id, body(req, OrderPatch))));
});

app.delete("/orders/:id", async (req, res) => {
  const order = await deleteOrder(req.params.id);
  res.json({ deleted: order.id });
});

const PaymentQuery = z.object({
  projectId: z.string().trim().min(1).optional(),
  vendorId: z.string().trim().min(1).optional(),
  kind: z.enum(PAYMENT_KINDS).optional(),
  state: z.enum(PAYMENT_STATES).optional(),
  q: z.string().trim().min(1).optional(),
});

function paymentOr404(id: string) {
  const payment = getPayment(id);
  if (!payment) throw new HttpError(404, `No payment ${id}.`);
  return payment;
}

app.get("/payments", (req, res) => {
  const query = PaymentQuery.safeParse(req.query);
  if (!query.success) {
    const first = query.error.issues[0];
    throw new HttpError(400, `${first?.path.join(".")}: ${first?.message}`);
  }
  const { state, ...rest } = query.data;
  const all = listPayments(rest);
  res.json({
    payments: paymentViews(state ? listPayments(query.data) : all),
    summary: paymentSummary(all),
  });
});

app.get("/payments/:id", (req, res) => {
  res.json(paymentView(paymentOr404(req.params.id)));
});

app.post("/payments", async (req, res) => {
  res.status(201).json(paymentView(await createPayment(body(req, PaymentInput))));
});

app.patch("/payments/:id", async (req, res) => {
  res.json(paymentView(await updatePayment(req.params.id, body(req, PaymentPatch))));
});

app.delete("/payments/:id", async (req, res) => {
  const payment = await deletePayment(req.params.id);
  res.json({ deleted: payment.id });
});

app.get("/conversations", (_req, res) => {
  res.json({ conversations: allConversations().map(listItem) });
});

app.post("/conversations", (req, res) => {
  const { projectId } = body(req, z.object({ projectId: z.string().optional() }));
  if (projectId && lookupProject(projectId).kind !== "found")
    throw new HttpError(404, `No project "${projectId}".`);
  res.status(201).json(createConversation(projectId));
});

app.get("/conversations/:id", (req, res) => {
  res.json(conversationOr404(req.params.id));
});

app.delete("/conversations/:id", async (req, res) => {
  const c = conversationOr404(req.params.id);
  await deleteConversation(c.id);
  res.json({ deleted: c.id });
});

app.post("/conversations/:id/messages", async (req, res) => {
  const c = conversationOr404(req.params.id);
  const { text } = body(req, MessageBody);
  res.status(202).json(await postMessage(c, text));
});

app.post("/conversations/:id/actions", async (req, res) => {
  const c = conversationOr404(req.params.id);
  const { actionId, value } = body(req, ActionBody);
  await runAction(c, actionId, value);
  res.status(202).json({ ok: true });
});

app.get("/conversations/:id/stream", (req, res) => {
  stream(req, res, conversationOr404(req.params.id));
});

app.get("/files/:token", (req, res) => {
  const path = fileForToken(req.params.token);
  if (!path) throw new HttpError(404, "No such file.");
  res.sendFile(path);
});

app.use((req) => {
  throw new HttpError(404, `No route ${req.method} ${req.path}.`);
});

const onError: ErrorRequestHandler = (err: unknown, _req, res, next) => {
  if (res.headersSent) return next(err);
  if (err instanceof VendorError)
    return void res.status(err.kind === "not-found" ? 404 : 409).json({ error: err.message });
  if (err instanceof OrderError || err instanceof PaymentError) {
    const status = { "not-found": 404, "bad-reference": 400, "not-allowed": 409 }[err.kind];
    return void res.status(status).json({ error: err.message });
  }
  if (err instanceof HttpError)
    return void res.status(err.status).json({ error: err.message, ...err.extra });
  // Bad JSON or a body over the limit, from express.json().
  const status = (err as { status?: number }).status;
  if (status && status < 500) {
    const message =
      status === 413 ? "Request body is too large." : "Request body is not valid JSON.";
    return void res.status(status).json({ error: message });
  }
  console.error(err);
  res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
};
app.use(onError);

/** Start the API. Resolves once it is listening. */
export function startServer(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    app.listen(port, (err?: Error) => {
      if (err) return reject(err);
      console.log(`Web API on http://localhost:${port} (user "${WEB_USER}", CORS ${CORS_ORIGIN}).`);
      resolve();
    });
  });
}
