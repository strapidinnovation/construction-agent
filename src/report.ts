import { existsSync } from "node:fs";

export const esc = (s: string | number) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

export const usd = (n: number) =>
  `${n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;

export const card = (label: string, value: string, note = "") =>
  `<div class="card"><span class="label">${esc(label)}</span><strong>${esc(value)}</strong>` +
  (note ? `<span class="note">${esc(note)}</span>` : "") +
  "</div>";

export const section = (title: string, body: string) =>
  `<section><h2>${esc(title)}</h2>${body}</section>`;

export const callout = (text: string, kind: "info" | "warn" = "info") =>
  `<div class="callout ${kind}">${esc(text)}</div>`;

export const list = (items: string[]) =>
  items.length ? `<ul>${items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>` : "";

const PAGES = [
  { file: "plan.html", source: "plan.svg", label: "Plan" },
  { file: "materials.html", source: "estimate.json", label: "Cost estimate" },
  { file: "timeline.html", source: "timeline.json", label: "Timeline" },
  { file: "feasibility.html", source: "feasibility.json", label: "Feasibility" },
];

/** Tabs to the other reports in the same plan folder whose data exists. */
function nav(dir: string, current: string): string {
  const links = PAGES.filter((p) => p.file === current || existsSync(`${dir}/${p.source}`)).map(
    (p) => `<a href="${p.file}"${p.file === current ? ' class="active"' : ""}>${esc(p.label)}</a>`,
  );
  return `<nav>${links.join("")}</nav>`;
}

export function page(opts: {
  dir: string;
  file: string;
  title: string;
  subtitle: string;
  body: string;
}): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(opts.title)}</title>
<style>${CSS}</style>
</head>
<body>
<header>
  <div class="wrap">
    <p class="eyebrow">Construction assistant</p>
    <h1>${esc(opts.title)}</h1>
    <p class="sub">${opts.subtitle}</p>
    ${nav(opts.dir, opts.file)}
  </div>
</header>
<main class="wrap">
${opts.body}
<footer>Generated ${esc(new Date().toLocaleString("en-US"))}. AI-generated concept material, not a construction document.</footer>
</main>
</body>
</html>
`;
}

const CSS = `
:root {
  --bg: #f4f6fa; --panel: #fff; --ink: #18212f; --muted: #667085; --line: #e6e9ef;
  --accent: #2563eb; --accent-soft: #e8efff; --crit: #dc2626; --ok: #16a34a;
  --warn-bg: #fff7e6; --warn-line: #f5b54a; --radius: 14px;
  --shadow: 0 1px 2px rgba(16,24,40,.06), 0 4px 16px rgba(16,24,40,.06);
}
* { box-sizing: border-box; }
body { margin: 0; font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, sans-serif;
  background: var(--bg); color: var(--ink); }
.wrap { max-width: 1240px; margin: 0 auto; padding: 0 28px; }
header { background: linear-gradient(135deg, #0f2a5f 0%, #1d4ed8 60%, #3b82f6 100%); color: #fff;
  padding: 36px 0 0; }
header .eyebrow { margin: 0; text-transform: uppercase; letter-spacing: .12em; font-size: 12px; opacity: .75; }
header h1 { margin: 6px 0 4px; font-size: 30px; letter-spacing: -.01em; }
header .sub { margin: 0 0 22px; opacity: .85; font-size: 14px; }
nav { display: flex; gap: 4px; }
nav a { color: #dbe6ff; text-decoration: none; padding: 10px 18px; border-radius: 10px 10px 0 0;
  font-weight: 600; font-size: 14px; }
nav a:hover { background: rgba(255,255,255,.12); color: #fff; }
nav a.active { background: var(--bg); color: var(--ink); }
main { padding-top: 26px; padding-bottom: 40px; }
section { background: var(--panel); border-radius: var(--radius); box-shadow: var(--shadow);
  padding: 24px 26px; margin-bottom: 22px; }
h2 { margin: 0 0 16px; font-size: 19px; }
h3 { margin: 22px 0 10px; font-size: 16px; }
h4 { margin: 16px 0 8px; font-size: 14px; color: var(--muted); text-transform: uppercase; letter-spacing: .05em; }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 16px; margin-bottom: 22px; }
.card { background: var(--panel); border-radius: var(--radius); box-shadow: var(--shadow); padding: 18px 20px;
  border-top: 4px solid var(--accent); }
.card .label { display: block; color: var(--muted); font-size: 13px; font-weight: 500; }
.card strong { display: block; font-size: 25px; margin-top: 4px; letter-spacing: -.01em; }
.card .note { display: block; color: var(--muted); font-size: 12px; margin-top: 2px; }
.callout { border-radius: 10px; padding: 12px 16px; margin-bottom: 16px; font-size: 14px;
  background: var(--accent-soft); border-left: 4px solid var(--accent); }
.callout.warn { background: var(--warn-bg); border-left-color: var(--warn-line); }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th { text-align: left; color: var(--muted); font-weight: 600; font-size: 12px; text-transform: uppercase;
  letter-spacing: .04em; border-bottom: 2px solid var(--line); padding: 10px 10px; white-space: nowrap; }
td { border-bottom: 1px solid var(--line); padding: 9px 10px; vertical-align: top; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
tr:hover td { background: #f9fafb; }
tr.total td { font-weight: 700; background: #f8fafc; border-top: 2px solid var(--line); }
.table-scroll { overflow-x: auto; }
details { border: 1px solid var(--line); border-radius: 10px; margin: 10px 0; background: #fcfcfd; }
details > summary { cursor: pointer; padding: 12px 16px; font-weight: 600; list-style: none;
  display: flex; justify-content: space-between; gap: 12px; }
details > summary::-webkit-details-marker { display: none; }
details > summary::before { content: "▸"; color: var(--muted); margin-right: 8px; transition: transform .15s; }
details[open] > summary::before { transform: rotate(90deg); }
details > summary .title { flex: 1; }
details > summary .meta { color: var(--muted); font-weight: 500; font-variant-numeric: tabular-nums; }
details > .content { padding: 0 16px 16px; }
.badge { display: inline-block; padding: 2px 9px; border-radius: 999px; font-size: 12px; font-weight: 600;
  background: #eef2f6; color: #344054; white-space: nowrap; }
.badge.k-work { background: #e8efff; color: #1d4ed8; }
.badge.k-inspection { background: #fef3c7; color: #92400e; }
.badge.k-wait { background: #ede9fe; color: #5b21b6; }
.badge.k-milestone { background: #dcfce7; color: #166534; }
.badge.crit { background: #fee2e2; color: #b91c1c; }
.badge.v-green { background: #dcfce7; color: #166534; }
.badge.v-amber { background: #fef3c7; color: #92400e; }
.badge.v-red { background: #fee2e2; color: #b91c1c; }
.badge.v-unknown { background: #eef2f6; color: #475467; }
p.note { color: var(--muted); font-size: 13px; margin: 2px 0 8px; }
.bars { display: grid; gap: 10px; }
.bar-row { display: grid; grid-template-columns: 210px 1fr 110px; gap: 14px; align-items: center; font-size: 14px; }
.bar-track { background: #eef2f6; border-radius: 999px; height: 12px; overflow: hidden; }
.bar-fill { height: 100%; border-radius: 999px; background: linear-gradient(90deg, #3b82f6, #1d4ed8); }
.bar-row .amount { text-align: right; font-variant-numeric: tabular-nums; font-weight: 600; }
.spec { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px 22px; margin: 0; }
.spec div { border-bottom: 1px dashed var(--line); padding-bottom: 6px; }
.spec dt { color: var(--muted); font-size: 12px; } .spec dd { margin: 0; font-weight: 600; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { background: #fee2e2; color: #991b1b; border-radius: 999px; padding: 3px 10px; font-size: 12px; font-weight: 600; }
.milestones { display: flex; flex-wrap: wrap; gap: 12px; }
.milestone { flex: 1 1 200px; border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px;
  border-left: 4px solid var(--ok); }
.milestone .date { color: var(--muted); font-size: 13px; }
.gantt { font-size: 12px; }
.gantt-head, .gantt-row { display: grid; grid-template-columns: 280px 1fr; align-items: center; }
.gantt-head .scale { position: relative; height: 22px; border-bottom: 1px solid var(--line); }
.gantt-head .tick { position: absolute; top: 0; font-size: 11px; color: var(--muted); padding-left: 4px;
  border-left: 1px solid var(--line); height: 100%; }
.gantt-phase { padding: 12px 0 4px; font-weight: 700; font-size: 13px; color: var(--ink); }
.gantt-row { min-height: 22px; }
.gantt-row .name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding-right: 12px; color: #344054; }
.gantt-track { position: relative; height: 22px; background: var(--grid); }
.gantt-bar { position: absolute; top: 5px; height: 12px; border-radius: 4px; background: #60a5fa; min-width: 3px; }
.gantt-bar.k-inspection { background: #f59e0b; } .gantt-bar.k-wait { background: #a78bfa; }
.gantt-bar.crit { background: var(--crit); }
.gantt-bar.k-milestone { top: 4px; width: 12px !important; height: 12px; border-radius: 2px; transform: rotate(45deg);
  background: var(--ok); }
.legend { display: flex; gap: 16px; flex-wrap: wrap; color: var(--muted); font-size: 12px; margin-bottom: 10px; }
.legend i { display: inline-block; width: 12px; height: 12px; border-radius: 3px; margin-right: 5px; vertical-align: -2px; }
.plan-frame { background: #fff; border-radius: var(--radius); box-shadow: var(--shadow); padding: 14px; overflow: auto; }
.plan-frame svg { max-width: 100%; height: auto; display: block; }
footer { color: var(--muted); font-size: 12px; text-align: center; padding: 16px 0; }
@media (max-width: 760px) { .bar-row { grid-template-columns: 1fr; } .gantt-head, .gantt-row { grid-template-columns: 150px 1fr; } }
@media print {
  body { background: #fff; } header { background: none; color: var(--ink); } nav { display: none; }
  /* Sections may split across pages (long schedules and cost tables can't fit
     on one page anyway); only small blocks are kept whole, which avoids big
     blank gaps where a whole section would otherwise jump to the next page. */
  section, .card, .plan-frame { box-shadow: none; border: 1px solid var(--line); }
  section { break-inside: auto; }
  .card, .plan-frame, tr, details > summary, h2, h3 { break-inside: avoid; }
  h2, h3, details > summary { break-after: avoid; }
  /* On screen wide tables scroll sideways; on paper they'd be cut off. */
  .table-scroll { overflow: visible; }
}
`;
