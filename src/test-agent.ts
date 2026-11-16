/**
 * Console test for the agent, without the browser. Each goal runs in a web
 * conversation exactly as if typed in the chat (handleMessage with the web
 * Output), and every message the chat would show is printed. It uses its own
 * memory and conversation files in /tmp, so it never touches real chats.
 *
 *   node --import tsx src/test-agent.ts "compare Brass Buttons and Corral Lane"
 *   node --import tsx src/test-agent.ts "find the best lot under 250k in Austin, TX" --approve
 *   node --import tsx src/test-agent.ts --suite        (a set of goals using quick tools)
 *
 * --same sends all the goals in ONE conversation (to test follow-ups like "yes, do that").
 * --approve clicks "Go" on proposed plans (slow jobs then really run: minutes each).
 * --answer="..." is sent once as the reply to the agent's first question or
 * plan (to a plan, it's a change request), as if typed in the chat.
 */
import { mkdirSync } from "node:fs";

// Must be set before the modules that read them are loaded (hence the dynamic imports below).
process.env.SESSIONS_FILE ??= "/tmp/superagent-test/sessions.json";
process.env.MISSIONS_DIR ??= "/tmp/superagent-test/missions";
process.env.CONVERSATIONS_DIR ??= "/tmp/superagent-test/conversations";
mkdirSync(process.env.MISSIONS_DIR, { recursive: true });

const { handleMessage } = await import("./superagent/superagent.ts");
const { approveMission, answerMission, settled } = await import("./superagent/agent/agent.ts");
const { allMissions } = await import("./superagent/agent/missions.ts");
const { createConversation, subscribe } = await import("./web/conversations.ts");
const { webCtx, webKey } = await import("./web/output.ts");
type ChatMessage = import("./web/conversations.ts").ChatMessage;

const args = process.argv.slice(2);
const approve = args.includes("--approve");
const answer = args.find((a) => a.startsWith("--answer="))?.slice("--answer=".length);

const SUITE = [
  "Which delayed projects have open permit or inspection issues, and what's the next step on each?",
  "Compare the plans for 3218 Brass Buttons Trl and 8446 Corral Ln and tell me which is the better investment",
  "Find land under 300k in Austin, TX and tell me which lots have no flood or soil problems",
  "Find the best lot under 250k in Austin, TX to build on and sell",
  "find me a good lot to build on and check if it floods",
];

const indent = (text: string) => text.replace(/^/gm, "    ");

/** Print a chat message as it appears or changes; status lines only when their last line changes. */
function printer(): (m: ChatMessage) => void {
  const lastStatus = new Map<string, string>();
  return (m) => {
    if (m.role !== "agent") return;
    if (m.kind === "status") {
      const now = m.text.split("\n").at(-1) ?? "";
      if (lastStatus.get(m.id) !== now) console.log(`  status: ${now}`);
      lastStatus.set(m.id, now);
    } else if (m.kind === "files") {
      console.log(`  FILES: ${(m.files ?? []).map((f) => f.name).join(", ")}\n${indent(m.text)}`);
    } else {
      const buttons = m.actions?.length
        ? `\n    [${m.actions.map((a) => a.label).join("] [")}]`
        : "";
      console.log(`\n  REPLY:\n${indent(m.text)}${buttons}`);
    }
  };
}

async function runGoal(goal: string, conversationId: string): Promise<void> {
  console.log(`\n${"=".repeat(100)}\nGOAL: ${goal}\n${"=".repeat(100)}`);
  const ctx = webCtx(conversationId);
  const started = Date.now();
  await handleMessage(ctx, goal);

  const mission = allMissions()
    .filter((m) => m.key === webKey(conversationId) && Date.parse(m.createdAt) >= started)
    .at(-1);
  if (!mission) {
    console.log("\n  (Answered without the agent: help or cancel.)");
    return;
  }
  let answered = false;
  for (;;) {
    await settled(mission.id);
    const waiting = mission.state === "waiting-approval" || mission.state === "waiting-answer";
    if (waiting && answer && !answered) {
      answered = true;
      console.log(`\n  >>> replying "${answer}"`);
      await answerMission(ctx, mission.id, answer);
    } else if (mission.state === "waiting-approval" && approve) {
      console.log("\n  >>> clicking Go");
      await approveMission(ctx, mission.id);
    } else break;
  }
  console.log(
    `\n  RESULT: ${mission.state} after ${mission.modelCalls} model turns in ${Math.round((Date.now() - started) / 1000)}s`,
  );
  console.log(
    `  STEPS:\n${mission.steps.map((s) => `    - [${s.state}] ${s.text}`).join("\n") || "    (none)"}`,
  );
}

const goals = args.includes("--suite") ? SUITE : args.filter((a) => !a.startsWith("--"));
if (!goals.length) {
  console.log(
    'Usage: node --import tsx src/test-agent.ts "<goal>" ["<goal>" ...] [--same] [--approve] [--answer="..."] | --suite',
  );
  process.exit(1);
}
const same = args.includes("--same");
let conversation = createConversation();
let unsubscribe = subscribe(conversation.id, printer());
for (const [i, goal] of goals.entries()) {
  if (i > 0 && !same) {
    unsubscribe();
    conversation = createConversation();
    unsubscribe = subscribe(conversation.id, printer());
  }
  await runGoal(goal, conversation.id);
}
process.exit(0);
