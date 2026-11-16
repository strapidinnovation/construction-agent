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

/** Links to the other reports in the same plan folder whose data exists (screen only). */
function nav(dir: string, current: string): string {
  const links = PAGES.filter((p) => p.file === current || existsSync(`${dir}/${p.source}`)).map(
    (p) => `<a href="${p.file}"${p.file === current ? ' class="active"' : ""}>${esc(p.label)}</a>`,
  );
  return `<nav>${links.join("")}</nav>`;
}

/** A CSS string literal, for the running headers printed in the page margins. */
const cssString = (s: string) => `"${s.replace(/[\\"]/g, "\\$&").replace(/\s+/g, " ")}"`;

/**
 * One report page. `kind` is the document type ("Feasibility report"), `title`
 * its subject (usually the address) and `meta` the label/value pairs shown
 * under the title. Printed copies repeat kind and title at the top of every
 * page after the first, with page numbers at the bottom.
 */
export function page(opts: {
  dir: string;
  file: string;
  kind: string;
  title: string;
  meta: [string, string][];
  date?: Date;
  body: string;
}): string {
  const date = (opts.date ?? new Date()).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
  const meta = [["Date", date], ...opts.meta]
    .map(([k, v]) => `<div><dt>${esc(k!)}</dt><dd>${esc(v!)}</dd></div>`)
    .join("");
  const running = `@page { @top-left { content: ${cssString(opts.kind)}; } @top-right { content: ${cssString(opts.title)}; } }`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(opts.kind)}: ${esc(opts.title)}</title>
<style>${CSS}${running}</style>
</head>
<body>
<div class="sheet">
${nav(opts.dir, opts.file)}
<header class="title-block">
  <p class="kind">${esc(opts.kind)}</p>
  <h1>${esc(opts.title)}</h1>
  <dl class="doc-meta">${meta}</dl>
</header>
<main>
${opts.body}
</main>
<footer>Prepared by SuperAgent on ${esc(date)}. Concept-level material produced with AI models; verify figures with suppliers, contractors and the city before relying on them. Not a construction document.</footer>
</div>
</body>
</html>
`;
}

const CSS = `
:root {
  --ink: #1f2328; --muted: #5d6470; --faint: #8a919c;
  --rule: #1f2328; --line: #d9dce1; --hair: #eceef1;
  --accent: #1f4e79; --accent-tint: #f1f5f9;
  --green: #2e7d32; --amber: #a86400; --red: #b3261e;
  --sans: "Avenir Next", "Avenir", "Helvetica Neue", Arial, sans-serif;
  --serif: Charter, "Bitstream Charter", "Iowan Old Style", Georgia, serif;
}
* { box-sizing: border-box; }
html { background: #e9ebee; }
body { margin: 0; color: var(--ink); font: 15px/1.5 var(--sans); font-variant-numeric: tabular-nums;
  -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.sheet { max-width: 1040px; margin: 32px auto; background: #fff; padding: 0 56px 40px;
  border-top: 6px solid var(--accent); box-shadow: 0 1px 3px rgba(0,0,0,.12); }

nav { display: flex; gap: 22px; padding: 16px 0 0; font-size: 13px; }
nav a { color: var(--muted); text-decoration: none; padding-bottom: 4px; border-bottom: 2px solid transparent; }
nav a:hover { color: var(--ink); }
nav a.active { color: var(--accent); border-bottom-color: var(--accent); font-weight: 600; }

.title-block { padding: 34px 0 0; margin-bottom: 30px; }
.title-block .kind { margin: 0 0 6px; font-family: var(--sans); color: var(--accent); font-weight: 600; font-size: 15px; }
.title-block h1 { margin: 0 0 18px; font-size: 32px; line-height: 1.15; font-weight: 600; letter-spacing: -.01em; }
.doc-meta { display: flex; flex-wrap: wrap; gap: 0; margin: 0; border-top: 1.5px solid var(--rule);
  border-bottom: 1px solid var(--line); }
.doc-meta div { padding: 8px 22px 9px; border-left: 1px solid var(--line); }
.doc-meta div:first-child { padding-left: 0; border-left: 0; }
.doc-meta dt { font-size: 11.5px; color: var(--muted); }
.doc-meta dd { margin: 1px 0 0; font-size: 14px; font-weight: 600; }

main { counter-reset: section; }
section { margin: 0 0 30px; }
h2 { counter-increment: section; margin: 0 0 14px;
  padding-top: 12px; border-top: 1.5px solid var(--rule); font-size: 19px; font-weight: 600; }
h2::before { content: counter(section); display: inline-block; min-width: 30px; color: var(--accent); font-size: 15px; }
h3 { margin: 22px 0 8px; font-size: 15px; font-weight: 600; }
h4 { margin: 16px 0 6px; font-size: 13px; font-weight: 600; color: var(--muted); }
p { margin: 0 0 12px; font-family: var(--serif); font-size: 15.5px; line-height: 1.6; max-width: 46em; }
p.note { font-family: var(--sans); color: var(--muted); font-size: 12.5px; margin: 2px 0 8px; }
ul { margin: 0 0 12px; padding-left: 20px; font-family: var(--serif); font-size: 15px; line-height: 1.55; max-width: 48em; }
li { margin-bottom: 4px; } li::marker { color: var(--accent); }
a { color: var(--accent); }

.cards { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(0, 1fr); margin: 0 0 20px;
  border-top: 1.5px solid var(--rule); border-bottom: 1px solid var(--line); }
.card { padding: 12px 16px 13px; border-left: 1px solid var(--line); }
.card:first-child { border-left: 0; padding-left: 0; }
.card .label { display: block; color: var(--muted); font-size: 12px; }
.card strong { display: block; margin-top: 3px; font-size: 22px; line-height: 1.2; font-weight: 600; letter-spacing: -.01em; }
.card .note { display: block; margin-top: 3px; color: var(--muted); font-size: 11.5px; line-height: 1.35; }

.callout { margin: 0 0 16px; padding: 10px 14px; background: var(--accent-tint);
  border-left: 3px solid var(--accent); font-size: 14px; line-height: 1.5; max-width: 52em; }
.callout.warn { background: #fbf5ea; border-left-color: var(--amber); }

table { width: 100%; border-collapse: collapse; font-size: 13.5px; margin: 0 0 6px; }
th { text-align: left; vertical-align: bottom; color: var(--muted); font-weight: 600; font-size: 12px;
  padding: 7px 10px 6px; border-bottom: 1px solid var(--rule); }
td { padding: 7px 10px; border-bottom: 1px solid var(--hair); vertical-align: top; line-height: 1.4; }
th:first-child, td:first-child { padding-left: 0; }
th:last-child, td:last-child { padding-right: 0; }
td.num, th.num { text-align: right; white-space: nowrap; }
tr.total td, tr.total th, tbody > tr:last-child > th { font-weight: 600; color: var(--ink); border-top: 1px solid var(--rule);
  border-bottom: 0; }
.table-scroll { overflow-x: auto; }
table:not(:has(th)) { max-width: 640px; }
table.lines { table-layout: fixed; }
table.lines th:nth-child(1) { width: 17%; } table.lines th:nth-child(2) { width: 23%; }
table.lines th:nth-child(3) { width: 7%; } table.lines th:nth-child(4) { width: 7%; }
table.lines th:nth-child(5) { width: 9%; } table.lines th:nth-child(6) { width: 9%; }
table.lines td:nth-child(7) { color: var(--muted); }
.quote { color: var(--muted); font-size: 12px; font-style: italic; }

details { margin: 16px 0; }
details > summary { cursor: pointer; list-style: none; display: flex; justify-content: space-between; gap: 12px;
  align-items: baseline; padding: 0 0 6px; border-bottom: 1px solid var(--line); font-weight: 600; font-size: 15px; }
details > summary::-webkit-details-marker { display: none; }
details > summary::before { content: "▸"; color: var(--faint); font-size: 11px; transition: transform .15s; }
details[open] > summary::before { transform: rotate(90deg); }
details > summary .title { flex: 1; }
details > summary .meta { color: var(--muted); font-weight: 500; font-size: 13px; }
details > .content { padding: 4px 0 0; }

.badge { display: inline-block; padding: 1px 6px; font-family: var(--sans); border: 1px solid currentColor; border-radius: 3px;
  font-size: 11px; font-weight: 600; line-height: 1.4; white-space: nowrap; color: var(--muted); }
.badge.k-work { color: var(--accent); }
.badge.k-inspection { color: var(--amber); }
.badge.k-wait { color: #6b5b95; }
.badge.k-milestone, .badge.v-green { color: var(--green); }
.badge.crit, .badge.v-red { color: var(--red); }
.badge.v-amber { color: var(--amber); }
.badge.v-unknown { color: var(--faint); }

.bars { display: grid; gap: 7px; max-width: 760px; }
.bar-row { display: grid; grid-template-columns: 200px 1fr 96px; gap: 14px; align-items: center; font-size: 13.5px; }
.bar-track { height: 8px; background: var(--hair); }
.bar-fill { height: 100%; background: var(--accent); }
.bar-row .amount { text-align: right; font-weight: 600; }

.spec { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0 28px; margin: 0 0 8px; }
.spec div { padding: 6px 0; border-bottom: 1px solid var(--hair); }
.spec dt { color: var(--muted); font-size: 12px; } .spec dd { margin: 1px 0 0; font-weight: 600; font-size: 13.5px; }

.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { padding: 2px 8px; border: 1px solid #e5b8b4; border-radius: 3px; color: var(--red); font-size: 12px; font-weight: 600; }

.milestones { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  border-top: 1.5px solid var(--rule); }
.milestone { padding: 9px 14px 10px 0; border-bottom: 1px solid var(--hair); }
.milestone strong { display: block; font-size: 13.5px; font-weight: 600; }
.milestone strong::before { content: ""; display: inline-block; width: 7px; height: 7px; margin-right: 7px;
  background: var(--green); transform: rotate(45deg) translateY(-2px); }
.milestone .date { color: var(--muted); font-size: 12.5px; padding-left: 15px; }

table.gantt { table-layout: fixed; font-size: 12px; }
table.gantt th:first-child { width: 230px; }
table.gantt th.scale { position: relative; height: 22px; padding: 0; }
table.gantt .tick { position: absolute; top: 0; bottom: 0; padding: 4px 0 0 4px; border-left: 1px solid var(--line);
  font-weight: 500; white-space: nowrap; }
table.gantt td { border: 0; padding: 0; }
table.gantt .gantt-phase td { padding: 10px 0 3px; font-weight: 600; font-size: 12.5px; border-bottom: 1px solid var(--hair); }
table.gantt td.name { padding: 2px 12px 2px 0; color: #3d434c; line-height: 1.25; }
.gantt-track { position: relative; height: 19px; background: var(--grid); }
.gantt-bar { position: absolute; top: calc(50% - 5px); height: 10px; background: #8fa9c7; min-width: 3px; }
.gantt-bar.k-inspection { background: #d99a2b; } .gantt-bar.k-wait { background: #b9b0d0; }
.gantt-bar.crit { background: var(--red); }
.gantt-bar.k-milestone { width: 10px !important; height: 10px; transform: rotate(45deg); background: var(--green); }
.legend { display: flex; gap: 18px; flex-wrap: wrap; color: var(--muted); font-size: 12px; margin-bottom: 10px; }
.legend i { display: inline-block; width: 14px; height: 8px; margin-right: 6px; vertical-align: 0; }

.plan-frame { border: 1px solid var(--line); padding: 10px; margin: 0 0 24px; }
.plan-frame svg { max-width: 100%; height: auto; display: block; }

footer { margin-top: 36px; padding-top: 10px; border-top: 1px solid var(--line); color: var(--muted);
  font-size: 12px; line-height: 1.5; }

@media screen and (max-width: 760px) {
  .sheet { padding: 0 20px 24px; margin: 0; }
  .bar-row { grid-template-columns: 1fr; }
  .cards { grid-auto-flow: row; grid-template-columns: 1fr 1fr; }
  .spec { grid-template-columns: 1fr 1fr; }
  .gantt-head, .gantt-row { grid-template-columns: 140px 1fr; }
}

@page {
  size: letter; margin: 0.8in 0.7in 0.75in;
  @top-left { font: 600 8pt var(--sans); color: #1f4e79; vertical-align: bottom; padding-bottom: 10pt; }
  @top-right { font: 8pt var(--sans); color: #5d6470; vertical-align: bottom; padding-bottom: 10pt; }
  @bottom-left { content: "SuperAgent. Concept-level material, not a construction document.";
    font: 7.5pt var(--sans); color: #8a919c; vertical-align: top; padding-top: 10pt; }
  @bottom-right { content: "Page " counter(page) " of " counter(pages);
    font: 7.5pt var(--sans); color: #5d6470; vertical-align: top; padding-top: 10pt; }
}
@page :first { @top-left { content: none; } @top-right { content: none; } }

@media print {
  html { background: none; }
  body { font-size: 9pt; }
  .sheet { max-width: none; margin: 0; padding: 0; box-shadow: none; border-top: 0; }
  nav { display: none; }
  .title-block { padding: 0; margin-bottom: 18pt; border-top: 4pt solid var(--accent); padding-top: 14pt; }
  .title-block .kind { font-size: 10pt; }
  .title-block h1 { font-size: 21pt; margin-bottom: 12pt; }
  .doc-meta dt { font-size: 7.5pt; } .doc-meta dd { font-size: 9pt; }
  section { margin-bottom: 18pt; }
  h2 { font-size: 12.5pt; margin-bottom: 9pt; padding-top: 7pt; }
  h2::before { font-size: 10pt; min-width: 18pt; }
  h3 { font-size: 10pt; margin: 12pt 0 5pt; }
  h4 { font-size: 8.5pt; margin: 10pt 0 4pt; }
  p { font-size: 9.5pt; max-width: none; }
  p.note { font-size: 8pt; }
  ul { font-size: 9.5pt; max-width: none; }
  .cards { margin-bottom: 12pt; }
  .card { padding: 7pt 10pt 8pt; }
  .card .label { font-size: 7.5pt; } .card strong { font-size: 14pt; } .card .note { font-size: 7.5pt; }
  .callout { font-size: 8.5pt; padding: 6pt 9pt; max-width: none; margin-bottom: 10pt; }
  table { font-size: 8pt; }
  th { font-size: 7.5pt; padding: 4pt 6pt 3pt; }
  td { padding: 3.5pt 6pt; line-height: 1.3; }
  thead { display: table-header-group; }
  .table-scroll { overflow: visible; }
  details { margin: 10pt 0; }
  details > summary { display: block; font-size: 10pt; padding-bottom: 3pt; }
  details > summary::before { display: none; }
  details > summary .meta { float: right; font-size: 8pt; }
  .badge { font-size: 7pt; padding: 0 4pt; }
  .quote { font-size: 7.5pt; }
  .bar-row { font-size: 8.5pt; grid-template-columns: 150pt 1fr 60pt; gap: 10pt; }
  .bars { gap: 4pt; }
  .bar-track { height: 6pt; }
  .spec dt { font-size: 7.5pt; } .spec dd { font-size: 8.5pt; } .spec div { padding: 3pt 0; }
  .milestone strong { font-size: 8.5pt; } .milestone .date { font-size: 8pt; }
  table.gantt { font-size: 7pt; }
  table.gantt th:first-child { width: 200pt; }
  table.gantt th.scale { height: 14pt; }
  table.gantt .tick { font-size: 7pt; padding-top: 2pt; }
  table.gantt .gantt-phase td { font-size: 8pt; padding: 6pt 0 2pt; }
  table.gantt td.name { padding: 1pt 8pt 1pt 0; }
  .gantt-track { height: 11pt; }
  .gantt-bar { height: 6pt; top: calc(50% - 3pt); }
  .gantt-bar.k-milestone { width: 6pt !important; height: 6pt; }
  .legend { font-size: 7.5pt; }
  footer { font-size: 7.5pt; margin-top: 18pt; }

  .card, .plan-frame, tr, .milestone, .bar-row, .spec div, .callout { break-inside: avoid; }
  h2, h3, h4, details > summary, .gantt-phase { break-after: avoid; }
  /* Chrome ignores break-after: avoid, so each heading reserves room for a few
     lines below it, which moves a heading near the page end to the next page. */
  h2, h3, h4, details > summary { break-inside: avoid; }
  h2::after, h3::after, h4::after, details > summary::after {
    content: ""; display: block; height: 70pt; margin-bottom: -70pt; }
  table:not(:has(th)) { max-width: 4.6in; }
}
`;
