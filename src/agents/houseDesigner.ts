import { mkdir, readFile, writeFile } from "node:fs/promises";
import { DESIGN_MODEL, chatText, type Progress } from "../llm.ts";
import { PROJECT_ROOT } from "../paths.ts";
import { callout, card, esc, list, page, section } from "../report.ts";
import type { Listing } from "./landSearch.ts";
import {
  STRATEGY_LABEL,
  homes,
  houseTypeLine,
  loadStrategy,
  type Lot,
  type SiteStrategy,
} from "./sitePlanner.ts";
import type { ZoningRules } from "./zoning.ts";

export type { Lot };

export type Design = {
  model: string;
  dir: string;
  htmlPath: string;
  svgPath: string;
  complete: boolean;
  thinkingFallback: boolean;
};

const SYSTEM = `You are an experienced residential architect producing a concept site and house plan.
The number of homes and each house type's program were already decided; you design and draw them.
You draw the plan yourself as ONE standalone SVG document.

CANVAS: width="1600" height="1100" viewBox="0 0 1600 1100", white background rect first.
Use exactly these three panels, each inside a <g> with a light border and a title:

1. SITE PLAN panel: x 20..470, y 20..1080. Scale the whole lot to fit the panel.
   Draw the lot boundary, the street along the bottom edge with its name, dashed red setback
   lines labeled with their distances, EVERY home's footprint at its given size labeled with
   its home id and type (e.g. "H2 - Type A"), a driveway from each garage to the street
   (shared driveways are fine), a north arrow, and a scale bar.
   When subdividing, draw the proposed new lot lines as dashed blue lines with each lot's sq ft.
2. FLOOR PLAN panel: x 490..1180, y 20..1080. Draw ONE floor plan per HOUSE TYPE (not per home).
   With one type, draw it LARGE so it fills most of the panel (about 10 px per foot). With
   several types, split the panel into stacked areas, one per type, each titled like
   "Type A - 3 bed / 2 bath (x2)", scaled to fit its area. If a type has 2+ stories, draw its
   floors side by side within its area.
   Every room is a labeled rectangle: name on one line, dimensions (e.g. 14'x12') and sq ft
   on the next, centered, font-size 13 (11 if space is tight). Rooms share walls and must not
   overlap. Show doors as gaps with a swing arc, windows on exterior walls, stairs if
   multi-story, overall dimension lines on two sides, and the total sq ft per floor.
3. NOTES panel: x 1200..1580, y 20..1080, font-size 14, each line its own <text> with
   ~22 px line spacing. List the strategy and number of homes, zoning district, every rule and
   how the design complies (setbacks, total building coverage %, impervious cover %, height),
   lot size, sq ft per house type, and the approvals needed.

Rules:
- Respect every setback, the maximum building coverage, and the height limit you are given.
- Use the footprint size and program given for each house type.
- Room sizes must be realistic: bedrooms at least 10'x11', primary bedroom ~13'x15',
  living room ~16'x18', 2-car garage ~20'x22'. Room areas must add up to the footprint.
- Keep all text inside its panel; never let text overlap other text.
- Use only <svg>, <g>, <rect>, <line>, <polyline>, <polygon>, <path>, <circle>, <text>.
- Set width, height, and viewBox on the root <svg>, and include xmlns="http://www.w3.org/2000/svg".
- Respond with ONLY the SVG: start with <svg and end with </svg>. No markdown, no commentary.`;

export function estimateLot(lotSqft: number): Lot {
  const widthFt = Math.max(25, Math.round(Math.sqrt(lotSqft / 2.5) / 5) * 5);
  const depthFt = Math.round(lotSqft / widthFt);
  return { widthFt, depthFt };
}

function buildPrompt(
  listing: Listing,
  lot: Lot,
  rules: ZoningRules,
  strategy: SiteStrategy,
): string {
  const pct = (v: number | null) => (v === null ? "no limit" : `${Math.round(v * 100)}%`);
  const lotSqft = lot.widthFt * lot.depthFt;
  const homeList = homes(strategy)
    .map((h) => `${h.id} (Type ${h.type.type})`)
    .join(", ");
  return `Design ${strategy.homes === 1 ? "a house" : `${strategy.homes} homes`} for this lot.

LOT
- Address: ${listing.address}
- Size: ${lot.widthFt} ft wide (street frontage) x ${lot.depthFt} ft deep = ${lotSqft.toLocaleString("en-US")} sq ft
- Street is along the front (bottom) edge of the site plan.

ZONING: ${rules.district} (${rules.districtName}), ${rules.jurisdiction}
- Front setback: ${rules.frontFt} ft
- Interior side setbacks: ${rules.interiorSideFt} ft each side
- Street side setback (corner lots only): ${rules.streetSideFt} ft
- Rear setback: ${rules.rearFt} ft
- Max building coverage: ${pct(rules.maxBuildingCoverage)} of lot area (garage counts)
- Max impervious cover: ${pct(rules.maxImperviousCover)} of lot area (house + driveway + patios)
- Max height: ${rules.maxHeightFt} ft
${rules.notes.map((n) => `- Note: ${n}`).join("\n")}

SITE STRATEGY: ${STRATEGY_LABEL[strategy.strategy]} (${strategy.homes} ${strategy.homes === 1 ? "home" : "homes"})
- Homes: ${homeList}
- Layout: ${strategy.layout}
- Approvals: ${strategy.approvals.join("; ") || "standard residential building permit"}

HOUSE TYPES
${strategy.houseTypes.map((t) => `- ${houseTypeLine(t)}`).join("\n")}
- Every type has a living room, kitchen with dining area, laundry, entry and storage; the
  primary bedroom has its own bathroom and closet. Garages are attached and face the street
  or the driveway.`;
}

function localTimestamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`
  );
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

function extractSvg(reply: string): { svg: string; complete: boolean } | null {
  const start = reply.search(/<svg[\s>]/i);
  if (start === -1) return null;

  let svg = reply.slice(start);
  const end = svg.toLowerCase().lastIndexOf("</svg>");
  const complete = end !== -1;
  if (complete) {
    svg = svg.slice(0, end + "</svg>".length);
  } else {
    // Drop any half-written tag, then close the root so browsers still render what was drawn.
    svg = svg.slice(0, svg.lastIndexOf(">") + 1);
    const openGroups = (svg.match(/<g[\s>]/g) ?? []).length - (svg.match(/<\/g>/g) ?? []).length;
    svg += "</g>".repeat(Math.max(0, openGroups)) + "</svg>";
  }

  if (!svg.includes("xmlns=")) {
    svg = svg.replace(/<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  }
  return { svg, complete };
}

function viewerHtml(
  dir: string,
  listing: Listing,
  lot: Lot,
  rules: ZoningRules,
  strategy: SiteStrategy,
  svg: string,
): string {
  const n = (v: number) => v.toLocaleString("en-US");
  const zoning = rules.verified
    ? callout(`Zoning rules from ${rules.source}.`)
    : callout("Zoning rules were entered by hand and are NOT verified against local code.", "warn");
  const heated = strategy.houseTypes.reduce((s, t) => s + t.heatedSqft * t.count, 0);

  const types = strategy.houseTypes
    .map(
      (t) =>
        `<tr><td><span class="badge k-work">Type ${esc(t.type)}</span> ${esc(t.name)}</td>` +
        `<td class="num">${t.count}</td><td class="num">${t.stories}</td>` +
        `<td class="num">${t.bedrooms} / ${t.bathrooms}</td><td class="num">${n(t.heatedSqft)}</td>` +
        `<td>${esc(t.garage)}</td><td class="num">${t.footprintWidthFt}' x ${t.footprintDepthFt}'</td></tr>`,
    )
    .join("");

  const body =
    `<div class="cards">` +
    card(
      "Strategy",
      `${strategy.homes} ${strategy.homes === 1 ? "home" : "homes"}`,
      STRATEGY_LABEL[strategy.strategy],
    ) +
    card("Heated area", `${n(heated)} sq ft`, "all homes") +
    card("Lot", `${n(lot.widthFt * lot.depthFt)} sq ft`, `${lot.widthFt}' x ${lot.depthFt}'`) +
    card("Zoning", rules.district, rules.districtName) +
    `</div>` +
    zoning +
    `<div class="plan-frame">${svg}</div><br>` +
    section(
      "Site strategy",
      `<p>${esc(strategy.reasoning)}</p><h4>Layout</h4><p>${esc(strategy.layout)}</p>` +
        (strategy.approvals.length ? `<h4>Approvals</h4>${list(strategy.approvals)}` : ""),
    ) +
    section(
      "House types",
      `<div class="table-scroll"><table><tr><th>Type</th><th class="num">Homes</th><th class="num">Stories</th>` +
        `<th class="num">Bed / bath</th><th class="num">Heated sq ft</th><th>Garage</th>` +
        `<th class="num">Footprint</th></tr>${types}</table></div>`,
    );

  return page({
    dir,
    file: "plan.html",
    title: listing.address,
    subtitle: `Concept plan drawn by ${esc(DESIGN_MODEL)}. Not a construction or permit drawing.`,
    body,
  });
}

/** Rebuilds plan.html from the saved inputs, strategy and drawing without calling the model. */
export async function renderHtml(dir: string): Promise<string | null> {
  const strategy = await loadStrategy(dir);
  if (!strategy) return null;
  const inputs = JSON.parse(await readFile(`${dir}/inputs.json`, "utf8")) as {
    listing: Listing;
    lot: Lot;
    rules: ZoningRules;
  };
  const svg = await readFile(`${dir}/plan.svg`, "utf8");
  const htmlPath = `${dir}/plan.html`;
  await writeFile(
    htmlPath,
    viewerHtml(dir, inputs.listing, inputs.lot, inputs.rules, strategy, svg),
  );
  return htmlPath;
}

export async function run(
  listing: Listing,
  lot: Lot,
  rules: ZoningRules,
  strategy: SiteStrategy,
  onProgress?: (p: Progress) => void,
): Promise<Design> {
  const prompt = buildPrompt(listing, lot, rules, strategy);
  const think = process.env.DESIGN_THINK !== "false";

  const dir = `${PROJECT_ROOT}output/${localTimestamp(new Date())}_${slugify(listing.address)}`;
  await mkdir(dir, { recursive: true });
  await writeFile(
    `${dir}/inputs.json`,
    JSON.stringify({ model: DESIGN_MODEL, think, listing, lot, rules }, null, 2),
  );
  await writeFile(`${dir}/strategy.json`, JSON.stringify(strategy, null, 2));
  await writeFile(
    `${dir}/prompt.txt`,
    `MODEL: ${DESIGN_MODEL}\n\nSYSTEM:\n${SYSTEM}\n\nUSER:\n${prompt}\n`,
  );

  let reply = await chatText(DESIGN_MODEL, SYSTEM, prompt, { think, onProgress });
  let extracted = extractSvg(reply.content);
  // Thinking can use up the whole output budget before any SVG is written.
  const thinkingFallback = think && !extracted;
  if (thinkingFallback) {
    reply = await chatText(DESIGN_MODEL, SYSTEM, prompt, { think: false, onProgress });
    extracted = extractSvg(reply.content);
  }
  await writeFile(`${dir}/raw.txt`, reply.content);

  if (!extracted) {
    throw new Error(`The model did not return an SVG drawing. Its reply is in ${dir}/raw.txt`);
  }
  const { svg, complete } = extracted;

  const design: Design = {
    model: DESIGN_MODEL,
    dir,
    htmlPath: `${dir}/plan.html`,
    svgPath: `${dir}/plan.svg`,
    complete: complete && !reply.truncated,
    thinkingFallback,
  };

  await writeFile(design.svgPath, svg);
  await writeFile(design.htmlPath, viewerHtml(dir, listing, lot, rules, strategy, svg));

  return design;
}
