/**
 * Console test for the agent, without Slack. Messages go through the same
 * path as in Slack (router -> agent), and everything the bot would post is
 * printed instead. It uses its own memory files in /tmp, so it never touches
 * the bot's real conversations.
 *
 *   node --import tsx src/test-agent.ts "compare Brass Buttons and Corral Lane"
 *   node --import tsx src/test-agent.ts "find the best lot under 250k in Austin, TX" --approve
 *   node --import tsx src/test-agent.ts --suite        (a set of goals using quick tools)
 *
 *   node --import tsx src/test-agent.ts --digest       (the scheduled morning digest)
 *
 * --same sends all the goals in ONE conversation (to test follow-ups like "yes, do that").
 * --approve clicks "Go" on proposed plans (slow jobs then really run: minutes each).
 * --answer="..." is sent once as the reply to the agent's first question or
 * plan (to a plan, it's a change request), as if typed in Slack.
 */
import { mkdirSync } from "node:fs";

// Must be set before the modules that read them are loaded (hence the dynamic imports below).
process.env.SESSIONS_FILE ??= "/tmp/superagent-test/sessions.json";
process.env.MISSIONS_DIR ??= "/tmp/superagent-test/missions";
mkdirSync(process.env.MISSIONS_DIR, { recursive: true });

const { handleMessage } = await import("./superagent/superagent.ts");
const { approveMission, answerMission, settled, startMission } =
  await import("./superagent/agent/agent.ts");
const { allMissions } = await import("./superagent/agent/missions.ts");
const { DIGEST_GOAL } = await import("./superagent/agent/schedule.ts");
type Ctx = import("./superagent/superagent.ts").Ctx;
type Reply = import("./superagent/slackUi.ts").Reply;

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

/** Readable text of a Slack reply: its sections, without the layout JSON. */
function show(reply: Reply): string {
  const parts = (reply.blocks ?? []).flatMap((b) => {
    if (b.type === "section") return [b.text?.text ?? "", ...(b.fields ?? []).map((f) => f.text)];
    if (b.type === "context")
      return b.elements.map((e) => ("text" in e ? `(${e.text})` : "")).filter(Boolean);
    if (b.type === "actions")
      return [`[${b.elements.map((e) => ("text" in e && e.text ? e.text.text : "")).join("] [")}]`];
    return [];
  });
  return (parts.length ? parts.join("\n") : reply.text).replace(/^/gm, "    ");
}

function consoleCtx(key: string): Ctx {
  const output = (label: string) => {
    let last = "";
    return {
      async reply(r: Reply) {
        console.log(`\n  ${label} REPLY:\n${show(r)}`);
      },
      async status(text: string) {
        // Only print the line that changed, so the log stays readable.
        const now = text.split("\n").at(-1) ?? "";
        if (now !== last) console.log(`  ${label} status: ${now}`);
        last = now;
      },
      async upload(files: { path: string }[], comment: string) {
        console.log(`  ${label} UPLOAD: ${files.map((f) => f.path).join(", ")} (${comment})`);
      },
    };
  };
  let jobs = 0;
  return {
    key,
    user: "UTEST",
    out: output("[agent]"),
    makeOutput: () => output(`[job ${++jobs}]`),
  };
}

async function runGoal(goal: string, key: string, digest = false): Promise<void> {
  console.log(`\n${"=".repeat(100)}\nGOAL: ${goal}\n${"=".repeat(100)}`);
  const ctx = consoleCtx(key);
  const started = Date.now();
  if (digest) await startMission(ctx, goal, { unattended: true });
  else await handleMessage(ctx, goal);

  const mission = allMissions()
    .filter((m) => m.key === key && Date.parse(m.createdAt) >= started)
    .at(-1);
  if (!mission) {
    console.log("\n  (The router didn't treat this as a goal; no mission was started.)");
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

const run = Date.now().toString(36);
if (args.includes("--digest")) {
  await runGoal(DIGEST_GOAL, `TEST-${run}-digest`, true);
  process.exit(0);
}
const goals = args.includes("--suite") ? SUITE : args.filter((a) => !a.startsWith("--"));
if (!goals.length) {
  console.log(
    'Usage: node --import tsx src/test-agent.ts "<goal>" ["<goal>" ...] [--same] [--approve] [--answer="..."] | --suite | --digest',
  );
  process.exit(1);
}
const same = args.includes("--same");
for (const [i, goal] of goals.entries())
  await runGoal(goal, same ? `TEST-${run}` : `TEST-${run}-${i}`);
process.exit(0);
