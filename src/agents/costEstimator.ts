import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { z } from "zod";
import { ESTIMATE_MODEL, chatJson } from "../llm.ts";
import { callout, card, esc, list, page, section } from "../report.ts";
import {
  STRATEGY_LABEL,
  houseTypeLine,
  loadStrategy,
  type HouseType,
  type SiteStrategy,
} from "./sitePlanner.ts";

export const CONSTRUCTION_TYPE =
  "Slab-on-grade concrete foundation, wood-frame walls (2x6 exterior, 2x4 interior), " +
  "engineered roof trusses, fiber-cement lap siding, architectural asphalt shingles";

const CONTINGENCY = 0.1;

const HouseSpecSchema = z.object({
  heatedSqft: z.number(),
  garageSqft: z.number(),
  stories: z.number().int(),
  footprintWidthFt: z.number(),
  footprintDepthFt: z.number(),
  exteriorWallPerimeterFt: z.number(),
  wallHeightFt: z.number(),
  roofType: z.string(),
  roofPitch: z.string(),
  roofAreaSqft: z.number(),
  bedrooms: z.number().int(),
  bathrooms: z.number(),
  rooms: z.array(z.object({ name: z.string(), widthFt: z.number(), depthFt: z.number() })),
  windows: z.number().int(),
  exteriorDoors: z.number().int(),
  interiorDoors: z.number().int(),
  drivewaySqft: z.number(),
  assumptions: z.array(z.string()),
});

const TradeSchema = z.object({
  materials: z.array(
    z.object({
      item: z.string(),
      specification: z.string(),
      quantity: z.number(),
      unit: z.string(),
      unitCostUsd: z.number(),
      notes: z.string(),
    }),
  ),
  labor: z.array(
    z.object({
      task: z.string(),
      crewHours: z.number(),
      hourlyRateUsd: z.number(),
    }),
  ),
});

export type HouseSpec = z.infer<typeof HouseSpecSchema>;

type Trade = { name: string; scope: string };

const TRADES: Trade[] = [
  {
    name: "Site work & foundation",
    scope:
      "clearing and grading fill, compacted select fill, gravel base, vapor barrier (poly), " +
      "form lumber and stakes, ready-mix concrete for slab and grade beams, rebar by size, " +
      "rebar chairs and tie wire, wire mesh or fibers, anchor bolts, termite pre-treatment, " +
      "under-slab plumbing sleeves, expansion joint, concrete for driveway and walkways, " +
      "silt fence and erosion control, construction entrance gravel",
  },
  {
    name: "Framing & sheathing",
    scope:
      "pressure-treated sill plates, 2x6 and 2x4 studs (precut), top and bottom plates, " +
      "headers and LVL beams, engineered roof trusses, ceiling joists or bracing, " +
      "OSB wall sheathing, OSB roof sheathing, fascia and sub-fascia lumber, blocking, " +
      "framing nails by type (16d, 8d, sheathing), structural screws, hurricane ties and straps, " +
      "joist and truss hangers, construction adhesive, sill seal gasket",
  },
  {
    name: "Roofing",
    scope:
      "architectural asphalt shingles (squares), synthetic underlayment, ice and water shield, " +
      "starter strip, ridge cap shingles, drip edge, step and valley flashing, pipe boots, " +
      "ridge vent and soffit vents, roofing nails, roofing sealant, gutters and downspouts",
  },
  {
    name: "Exterior envelope",
    scope:
      "house wrap and seam tape, window flashing tape, windows by size, exterior doors, " +
      "garage door and opener, fiber-cement lap siding, fiber-cement trim and corner boards, " +
      "soffit panels, siding nails, exterior caulk, exterior primer and paint",
  },
  {
    name: "Insulation & drywall",
    scope:
      "wall batt insulation (R-20 2x6 walls), attic blown-in insulation (R-38+), " +
      "spray foam or canned foam for gaps, garage-house wall fire-rated drywall, " +
      "1/2 in drywall for walls, 5/8 in for ceilings, moisture-resistant board for wet areas, " +
      "cement board for showers, drywall screws, joint compound, paper and mesh tape, " +
      "corner bead, texture",
  },
  {
    name: "Plumbing",
    scope:
      "water service line, PEX supply pipe by diameter, PEX fittings and manifold, " +
      "PVC drain-waste-vent pipe by diameter, DWV fittings, cleanouts, shutoff valves, " +
      "water heater (tank or tankless), expansion tank, toilets, bathroom sinks and faucets, " +
      "tub or shower valves and trim, shower pan, kitchen sink and faucet, garbage disposal, " +
      "dishwasher and ice maker connections, washer box, hose bibs, gas line if used, " +
      "pipe insulation, primer and cement, pipe straps",
  },
  {
    name: "Electrical",
    scope:
      "200A main panel and meter base, circuit breakers (AFCI/GFCI as code requires), " +
      "service entrance cable, grounding rods and clamps, Romex by gauge (14/2, 12/2, 10/3, 6/3), " +
      "outlet and switch boxes, receptacles, GFCI receptacles, switches and dimmers, cover plates, " +
      "light fixtures and recessed lights, ceiling fans, smoke and CO detectors, " +
      "exterior lights, doorbell, low-voltage/data cable, wire connectors, staples",
  },
  {
    name: "HVAC",
    scope:
      "heat pump or AC condenser sized for the heated sq ft (tons), air handler or furnace, " +
      "refrigerant line set, condensate line and pump, pad, flex and rigid ductwork, " +
      "supply and return registers, plenum boxes, duct mastic and foil tape, thermostat, " +
      "bathroom exhaust fans, kitchen range hood ducting, dryer vent, fresh-air intake",
  },
  {
    name: "Interior finishes",
    scope:
      "interior doors and hardware, door casing, baseboard, window trim, closet shelving and rods, " +
      "interior primer and paint (walls, ceilings, trim), caulk and wood filler, " +
      "flooring per room (LVP, carpet and pad, tile), tile underlayment, thinset, grout, " +
      "kitchen and bath cabinets, countertops, backsplash tile, cabinet hardware, " +
      "bathroom mirrors, towel bars and accessories, shower doors, stair parts if multi-story",
  },
];

export type MaterialLine = z.infer<typeof TradeSchema>["materials"][number] & { totalUsd: number };
export type LaborLine = z.infer<typeof TradeSchema>["labor"][number] & { totalUsd: number };

export type TradeEstimate = {
  name: string;
  materials: MaterialLine[];
  labor: LaborLine[];
  materialsUsd: number;
  laborUsd: number;
};

/** One house type; money is per home, multiply by count for the project. */
export type HouseEstimate = {
  type: string;
  name: string;
  count: number;
  spec: HouseSpec;
  trades: TradeEstimate[];
  failedTrades: string[];
  materialsUsd: number;
  laborUsd: number;
};

export type Estimate = {
  model: string;
  planDir: string;
  location: string;
  strategy: string;
  homes: number;
  heatedSqft: number;
  houses: HouseEstimate[];
  materialsUsd: number;
  laborUsd: number;
  contingencyUsd: number;
  totalUsd: number;
  markdownPath: string;
  htmlPath: string;
  jsonPath: string;
};

export type EstimateProgress = { step: string; index: number; total: number };

function svgLabels(svg: string): string[] {
  const labels = [...svg.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/gi)]
    .map((m) =>
      m[1]
        .replace(/<[^>]+>/g, "")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&#39;|&apos;/g, "'")
        .replace(/&quot;/g, '"')
        .trim(),
    )
    .filter(Boolean);
  return [...new Set(labels)].slice(0, 250);
}

type Plan = {
  brief: string;
  labels: string[];
  location: string;
  strategy: SiteStrategy | null;
};

async function loadPlan(dir: string): Promise<Plan> {
  const prompt = await readFile(`${dir}/prompt.txt`, "utf8");
  const brief = prompt.split(/\nUSER:\n/)[1]?.trim() ?? prompt;
  const svg = await readFile(`${dir}/plan.svg`, "utf8").catch(() => "");
  const address = brief.match(/- Address: (.+)/)?.[1]?.trim();
  return {
    brief,
    labels: svgLabels(svg),
    location: address || "the United States",
    strategy: await loadStrategy(dir),
  };
}

/** Plans made before the site planner existed have one house and no strategy.json. */
function houseTypesOf(plan: Plan): (HouseType | null)[] {
  return plan.strategy ? plan.strategy.houseTypes : [null];
}

async function readSpec(plan: Plan, house: HouseType | null): Promise<HouseSpec> {
  const focus =
    house && plan.strategy && plan.strategy.houseTypes.length > 1
      ? `\nThe plan has several house types. Produce the spec for ONE home of Type ${house.type} only.`
      : "\nProduce the spec for ONE home.";
  const system = `You are a residential construction estimator. Read a concept house plan and
produce the house specification an estimator needs. The plan's text labels were drawn by an AI
and may be incomplete or inconsistent: use them where they make sense, otherwise infer sensible
values from the design brief. Construction type: ${CONSTRUCTION_TYPE}.${focus}
drivewaySqft is this home's own driveway and walkways.
List every assumption you make (ceiling height, roof pitch, window count, etc.) in "assumptions".`;
  const user =
    `DESIGN BRIEF\n${plan.brief}\n\n` +
    (house ? `HOUSE TO SPECIFY\n${houseTypeLine(house)}\n\n` : "") +
    `TEXT LABELS FROM THE PLAN DRAWING\n${plan.labels.map((l) => `- ${l}`).join("\n")}`;
  const raw = await chatJson(system, user, z.toJSONSchema(HouseSpecSchema), {
    model: ESTIMATE_MODEL,
  });
  return HouseSpecSchema.parse(JSON.parse(raw));
}

export function specSummary(spec: HouseSpec): string {
  return [
    `- Heated area: ${spec.heatedSqft} sq ft, ${spec.stories} story(ies)`,
    `- Attached garage: ${spec.garageSqft} sq ft`,
    `- Footprint: ${spec.footprintWidthFt} ft x ${spec.footprintDepthFt} ft, exterior wall perimeter ${spec.exteriorWallPerimeterFt} ft, wall height ${spec.wallHeightFt} ft`,
    `- Roof: ${spec.roofType}, ${spec.roofPitch} pitch, ~${spec.roofAreaSqft} sq ft roof surface`,
    `- ${spec.bedrooms} bedrooms, ${spec.bathrooms} bathrooms`,
    `- Rooms: ${spec.rooms.map((r) => `${r.name} ${r.widthFt}x${r.depthFt}`).join("; ")}`,
    `- Windows: ${spec.windows}, exterior doors: ${spec.exteriorDoors}, interior doors: ${spec.interiorDoors}`,
    `- Driveway: ${spec.drivewaySqft} sq ft`,
    `- Construction: ${CONSTRUCTION_TYPE}`,
  ].join("\n");
}

function referenceMeasurements(spec: HouseSpec): string {
  const r = (n: number) => Math.round(n).toLocaleString("en-US");
  const slabSqft = spec.footprintWidthFt * spec.footprintDepthFt;
  const wallSqft = spec.exteriorWallPerimeterFt * spec.wallHeightFt * spec.stories;
  return [
    `- Roof surface: ${r(spec.roofAreaSqft)} sq ft = ${(spec.roofAreaSqft / 100).toFixed(1)} roofing squares (1 square = 100 sq ft)`,
    `- Slab area (house + garage): ${r(slabSqft)} sq ft; a 4 in slab is ${r((slabSqft * 4) / 12 / 27)} cu yd before grade beams`,
    `- Exterior wall area: ${r(wallSqft)} sq ft before window/door openings`,
    `- Exterior wall length: ${r(spec.exteriorWallPerimeterFt)} LF (sill plate length)`,
    `- Ceiling area: ${r(spec.heatedSqft)} sq ft heated`,
  ].join("\n");
}

async function estimateTrade(
  trade: Trade,
  spec: HouseSpec,
  location: string,
): Promise<TradeEstimate> {
  const system = `You are a residential construction estimator doing a detailed quantity takeoff
for new construction at ${location}, using current local prices in USD.
Scope: ${trade.name} only.

List EVERY raw material this scope needs, one line per distinct material/size. Use this checklist
and add anything else the scope requires: ${trade.scope}.
- Quantities must follow from the house spec, include a normal waste factor, and use the units
  materials are bought in (each, LF, sq ft, sheets, boxes, bags, cu yd, squares, rolls, gallons...).
- unitCostUsd is the typical contractor price per unit for that area.
- Then list the labor tasks for this scope with crew hours and a typical local hourly crew rate.
- Do not include items that belong to other trades.`;
  const user =
    `HOUSE SPEC\n${specSummary(spec)}\n\n` +
    `REFERENCE MEASUREMENTS (base your quantities on these, then add waste)\n${referenceMeasurements(spec)}`;

  const raw = await chatJson(system, user, z.toJSONSchema(TradeSchema), { model: ESTIMATE_MODEL });
  const parsed = TradeSchema.parse(JSON.parse(raw));

  const money = (n: number) => Math.round(n * 100) / 100;
  const materials = parsed.materials
    .filter((m) => m.quantity > 0 && m.unitCostUsd >= 0)
    .map((m) => ({ ...m, totalUsd: money(m.quantity * m.unitCostUsd) }));
  const labor = parsed.labor
    .filter((l) => l.crewHours > 0 && l.hourlyRateUsd >= 0)
    .map((l) => ({ ...l, totalUsd: money(l.crewHours * l.hourlyRateUsd) }));
  return {
    name: trade.name,
    materials,
    labor,
    materialsUsd: money(materials.reduce((s, m) => s + m.totalUsd, 0)),
    laborUsd: money(labor.reduce((s, l) => s + l.totalUsd, 0)),
  };
}

const usd = (n: number) =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
const usd2 = (n: number) =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const qty = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 2 });
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

function houseSection(lines: string[], h: HouseEstimate) {
  const { spec } = h;
  const perHome = h.materialsUsd + h.laborUsd;
  lines.push(`## Type ${h.type}: ${cell(h.name)} (x${h.count})`, "");
  lines.push(
    `${spec.stories} story, ${spec.bedrooms} bed / ${spec.bathrooms} bath, ` +
      `${qty(spec.heatedSqft)} sq ft heated + ${qty(spec.garageSqft)} sq ft garage`,
    "",
  );

  lines.push("### Cost by trade (per home)", "");
  lines.push("| Trade | Material items | Materials | Labor | Total |", "|---|---:|---:|---:|---:|");
  for (const t of h.trades) {
    lines.push(
      `| ${t.name} | ${t.materials.length} | ${usd(t.materialsUsd)} | ${usd(t.laborUsd)} | ${usd(t.materialsUsd + t.laborUsd)} |`,
    );
  }
  const itemCount = h.trades.reduce((s, t) => s + t.materials.length, 0);
  lines.push(
    `| **Per home** | **${itemCount}** | **${usd(h.materialsUsd)}** | **${usd(h.laborUsd)}** | **${usd(perHome)}** |`,
  );
  if (h.count > 1) {
    lines.push(`| **x${h.count} homes** | | | | **${usd(perHome * h.count)}** |`);
  }
  lines.push("");
  if (h.failedTrades.length > 0) {
    lines.push(
      `**Missing trades:** ${h.failedTrades.join(", ")} could not be estimated (the model returned ` +
        "invalid data). Their costs are not included.",
      "",
    );
  }

  lines.push("### House spec used", "");
  lines.push(specSummary(spec), "");
  lines.push("#### Reference measurements", "", referenceMeasurements(spec), "");
  lines.push("#### Rooms", "", "| Room | Size | Area |", "|---|---|---:|");
  for (const r of spec.rooms) {
    lines.push(
      `| ${cell(r.name)} | ${qty(r.widthFt)}' x ${qty(r.depthFt)}' | ${qty(r.widthFt * r.depthFt)} sq ft |`,
    );
  }
  lines.push("", "#### Assumptions", "");
  for (const a of spec.assumptions) lines.push(`- ${a}`);
  lines.push("");

  for (const t of h.trades) {
    lines.push(`### ${t.name} (Type ${h.type}, per home)`, "");
    lines.push("#### Materials", "");
    lines.push("| Item | Specification | Qty | Unit | Unit cost | Total | Notes |");
    lines.push("|---|---|---:|---|---:|---:|---|");
    for (const m of t.materials) {
      lines.push(
        `| ${cell(m.item)} | ${cell(m.specification)} | ${qty(m.quantity)} | ${cell(m.unit)} | ${usd2(m.unitCostUsd)} | ${usd(m.totalUsd)} | ${cell(m.notes)} |`,
      );
    }
    lines.push(`| **Materials subtotal** | | | | | **${usd(t.materialsUsd)}** | |`, "");
    lines.push("#### Labor", "");
    lines.push("| Task | Crew hours | Rate | Total |", "|---|---:|---:|---:|");
    for (const l of t.labor) {
      lines.push(
        `| ${cell(l.task)} | ${qty(l.crewHours)} | ${usd2(l.hourlyRateUsd)}/hr | ${usd(l.totalUsd)} |`,
      );
    }
    lines.push(`| **Labor subtotal** | | | **${usd(t.laborUsd)}** |`, "");
  }
}

function toMarkdown(e: Estimate): string {
  const perSqft = e.heatedSqft > 0 ? e.totalUsd / e.heatedSqft : 0;
  const lines: string[] = [];

  lines.push(`# Material & Cost Estimate`, "");
  lines.push(`**Location:** ${e.location}  `);
  lines.push(`**Plan:** \`${basename(e.planDir)}\`  `);
  lines.push(`**Estimated by:** ${e.model} on ${new Date().toLocaleString("en-US")}  `);
  lines.push(
    `**Site plan:** ${e.strategy}, ${e.homes} ${e.homes === 1 ? "home" : "homes"}, ` +
      `${qty(e.heatedSqft)} sq ft heated in total`,
    "",
  );
  lines.push(
    "> Prices, quantities and labor hours were estimated by an AI model, not quoted by suppliers " +
      "or contractors. Use this as a rough budget, not a bid.",
    "",
  );
  if (e.homes > 1) {
    lines.push(
      "> Each house type is estimated once and multiplied by its count. Site work and driveways are " +
        "counted per home; shared driveways and utility runs could lower the real total.",
      "",
    );
  }

  lines.push("## Project summary", "");
  lines.push(
    "| House type | Homes | Heated sq ft each | Materials each | Labor each | Subtotal |",
    "|---|---:|---:|---:|---:|---:|",
  );
  for (const h of e.houses) {
    lines.push(
      `| Type ${h.type}: ${cell(h.name)} | ${h.count} | ${qty(h.spec.heatedSqft)} | ${usd(h.materialsUsd)} | ${usd(h.laborUsd)} | ${usd((h.materialsUsd + h.laborUsd) * h.count)} |`,
    );
  }
  lines.push(
    `| **Subtotal** | **${e.homes}** | | **${usd(e.materialsUsd)}** | **${usd(e.laborUsd)}** | **${usd(e.materialsUsd + e.laborUsd)}** |`,
  );
  lines.push(`| Contingency (${CONTINGENCY * 100}%) | | | | | ${usd(e.contingencyUsd)} |`);
  lines.push(`| **Total** | | | | | **${usd(e.totalUsd)}** |`, "");
  lines.push(`Approximate cost per heated sq ft: **${usd(perSqft)}**`, "");
  if (e.homes > 1) {
    lines.push("The materials and labor columns in the subtotal row are for all homes.", "");
  }

  for (const h of e.houses) houseSection(lines, h);

  lines.push("## Not included", "");
  lines.push(
    "- Land cost, permits and impact fees, utility tap fees, surveys, engineering and architectural fees",
    "- Subdivision/replat fees and any new streets or utility extensions",
    "- Appliances, window coverings, landscaping, fencing, furniture",
    "- Builder overhead and profit, financing, insurance, dumpsters and site toilets",
    "",
  );
  return lines.join("\n");
}

function specList(spec: HouseSpec): string {
  const items: [string, string][] = [
    ["Heated area", `${qty(spec.heatedSqft)} sq ft`],
    ["Stories", String(spec.stories)],
    ["Bedrooms / baths", `${spec.bedrooms} / ${spec.bathrooms}`],
    ["Garage", `${qty(spec.garageSqft)} sq ft`],
    ["Footprint", `${qty(spec.footprintWidthFt)}' x ${qty(spec.footprintDepthFt)}'`],
    [
      "Wall perimeter",
      `${qty(spec.exteriorWallPerimeterFt)} ft, ${qty(spec.wallHeightFt)} ft walls`,
    ],
    ["Roof", `${spec.roofType}, ${spec.roofPitch}, ${qty(spec.roofAreaSqft)} sq ft`],
    [
      "Windows / doors",
      `${spec.windows} windows, ${spec.exteriorDoors} ext, ${spec.interiorDoors} int`,
    ],
    ["Driveway", `${qty(spec.drivewaySqft)} sq ft`],
  ];
  return (
    `<dl class="spec">` +
    items.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join("") +
    `</dl>`
  );
}

function tradeDetails(t: TradeEstimate): string {
  const materials = t.materials
    .map(
      (m) =>
        `<tr><td>${esc(m.item)}</td><td>${esc(m.specification)}</td><td class="num">${qty(m.quantity)}</td>` +
        `<td>${esc(m.unit)}</td><td class="num">${usd2(m.unitCostUsd)}</td><td class="num">${usd(m.totalUsd)}</td>` +
        `<td>${esc(m.notes)}</td></tr>`,
    )
    .join("");
  const labor = t.labor
    .map(
      (l) =>
        `<tr><td>${esc(l.task)}</td><td class="num">${qty(l.crewHours)}</td>` +
        `<td class="num">${usd2(l.hourlyRateUsd)}/hr</td><td class="num">${usd(l.totalUsd)}</td></tr>`,
    )
    .join("");
  return (
    `<details open><summary><span class="title">${esc(t.name)}</span>` +
    `<span class="meta">${t.materials.length} items · ${usd(t.materialsUsd + t.laborUsd)}</span></summary>` +
    `<div class="content"><h4>Materials</h4><div class="table-scroll"><table class="lines">` +
    `<thead><tr><th>Item</th><th>Specification</th><th class="num">Qty</th><th>Unit</th><th class="num">Unit cost</th>` +
    `<th class="num">Total</th><th>Notes</th></tr></thead>${materials}` +
    `<tr class="total"><td colspan="5">Materials subtotal</td><td class="num">${usd(t.materialsUsd)}</td><td></td></tr>` +
    `</table></div><h4>Labor</h4><div class="table-scroll"><table>` +
    `<thead><tr><th>Task</th><th class="num">Crew hours</th><th class="num">Rate</th><th class="num">Total</th></tr></thead>${labor}` +
    `<tr class="total"><td colspan="3">Labor subtotal</td><td class="num">${usd(t.laborUsd)}</td></tr>` +
    `</table></div></div></details>`
  );
}

function toHtml(e: Estimate): string {
  const perSqft = e.heatedSqft > 0 ? e.totalUsd / e.heatedSqft : 0;

  const byTrade = new Map<string, number>();
  for (const h of e.houses) {
    for (const t of h.trades) {
      byTrade.set(t.name, (byTrade.get(t.name) ?? 0) + (t.materialsUsd + t.laborUsd) * h.count);
    }
  }
  const maxTrade = Math.max(1, ...byTrade.values());
  const bars = [...byTrade]
    .sort((a, b) => b[1] - a[1])
    .map(
      ([name, v]) =>
        `<div class="bar-row"><span>${esc(name)}</span><div class="bar-track">` +
        `<div class="bar-fill" style="width:${((v / maxTrade) * 100).toFixed(1)}%"></div></div>` +
        `<span class="amount">${usd(v)}</span></div>`,
    )
    .join("");

  const typeRows = e.houses
    .map(
      (h) =>
        `<tr><td><span class="badge k-work">Type ${esc(h.type)}</span> ${esc(h.name)}</td><td class="num">${h.count}</td>` +
        `<td class="num">${qty(h.spec.heatedSqft)}</td><td class="num">${usd(h.materialsUsd)}</td>` +
        `<td class="num">${usd(h.laborUsd)}</td><td class="num">${usd((h.materialsUsd + h.laborUsd) * h.count)}</td></tr>`,
    )
    .join("");

  const houses = e.houses
    .map((h) => {
      const failed = h.failedTrades.length
        ? callout(
            `Could not estimate ${h.failedTrades.join(", ")} (the model returned invalid data); not included.`,
            "warn",
          )
        : "";
      const rooms = h.spec.rooms
        .map(
          (r) =>
            `<tr><td>${esc(r.name)}</td><td>${qty(r.widthFt)}' x ${qty(r.depthFt)}'</td>` +
            `<td class="num">${qty(r.widthFt * r.depthFt)} sq ft</td></tr>`,
        )
        .join("");
      return section(
        `Type ${h.type}: ${h.name} (x${h.count})`,
        `<div class="cards">` +
          card("Per home", usd(h.materialsUsd + h.laborUsd), "materials + labor") +
          card("All homes of this type", usd((h.materialsUsd + h.laborUsd) * h.count)) +
          card("Material items", String(h.trades.reduce((s, t) => s + t.materials.length, 0))) +
          `</div>` +
          failed +
          `<h3>House spec</h3>${specList(h.spec)}` +
          `<details open><summary><span class="title">Rooms, reference measurements and assumptions</span></summary>` +
          `<div class="content"><h4>Rooms</h4><table><tr><th>Room</th><th>Size</th><th class="num">Area</th></tr>${rooms}</table>` +
          `<h4>Reference measurements</h4>${list(
            referenceMeasurements(h.spec)
              .split("\n")
              .map((l) => l.replace(/^- /, "")),
          )}` +
          `<h4>Assumptions</h4>${list(h.spec.assumptions)}</div></details>` +
          `<h3>Trades (per home)</h3>${h.trades.map(tradeDetails).join("")}`,
      );
    })
    .join("");

  const body =
    `<div class="cards">` +
    card("Estimated total", usd(e.totalUsd), `incl. ${CONTINGENCY * 100}% contingency`) +
    card("Cost per sq ft", usd(perSqft), "heated area") +
    card("Homes", String(e.homes), e.strategy) +
    card("Materials", usd(e.materialsUsd)) +
    card("Labor", usd(e.laborUsd)) +
    `</div>` +
    callout(
      "Prices, quantities and labor hours were estimated by an AI model, not quoted by suppliers or contractors. Use this as a rough budget, not a bid.",
    ) +
    (e.homes > 1
      ? callout(
          "Each house type is estimated once and multiplied by its count. Site work and driveways are counted per home; shared driveways and utility runs could lower the real total.",
        )
      : "") +
    section("Where the money goes", `<div class="bars">${bars}</div>`) +
    section(
      "Project summary",
      `<div class="table-scroll"><table><tr><th>House type</th><th class="num">Homes</th>` +
        `<th class="num">Heated sq ft each</th><th class="num">Materials each</th><th class="num">Labor each</th>` +
        `<th class="num">Subtotal</th></tr>${typeRows}` +
        `<tr><td colspan="5">Contingency (${CONTINGENCY * 100}%)</td><td class="num">${usd(e.contingencyUsd)}</td></tr>` +
        `<tr class="total"><td colspan="5">Total</td><td class="num">${usd(e.totalUsd)}</td></tr></table></div>`,
    ) +
    houses +
    section(
      "Not included",
      list([
        "Land cost, permits and impact fees, utility tap fees, surveys, engineering and architectural fees",
        "Subdivision/replat fees and any new streets or utility extensions",
        "Appliances, window coverings, landscaping, fencing, furniture",
        "Builder overhead and profit, financing, insurance, dumpsters and site toilets",
      ]),
    );

  return page({
    dir: e.planDir,
    file: "materials.html",
    kind: "Material and cost estimate",
    title: e.location,
    meta: [
      ["Homes", String(e.homes)],
      ["Heated area", `${qty(e.heatedSqft)} sq ft`],
      ["Estimated by", e.model],
    ],
    body,
  });
}

export async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch {
    return await fn();
  }
}

/** Spec of the largest house type, used to pace the schedule. */
export async function readPlanSpec(
  planDir: string,
): Promise<{ spec: HouseSpec; location: string }> {
  const plan = await loadPlan(planDir);
  const largest = houseTypesOf(plan).reduce((a, b) =>
    a && b && b.heatedSqft > a.heatedSqft ? b : a,
  );
  return { spec: await withRetry(() => readSpec(plan, largest)), location: plan.location };
}

type LegacyEstimate = Omit<Estimate, "houses" | "homes" | "heatedSqft" | "strategy"> & {
  spec: HouseSpec;
  trades: TradeEstimate[];
  failedTrades: string[];
};

/** Reads estimate.json, including ones written before multi-home plans existed. */
export async function loadEstimate(planDir: string): Promise<Estimate> {
  const data = JSON.parse(await readFile(`${planDir}/estimate.json`, "utf8")) as
    Estimate | LegacyEstimate;
  if ("houses" in data) return data;
  const { spec, trades, failedTrades, ...rest } = data;
  return {
    ...rest,
    strategy: STRATEGY_LABEL["single-house"],
    homes: 1,
    heatedSqft: spec.heatedSqft,
    houses: [
      {
        type: "A",
        name: "House",
        count: 1,
        spec,
        trades,
        failedTrades,
        materialsUsd: data.materialsUsd,
        laborUsd: data.laborUsd,
      },
    ],
  };
}

/** Rebuilds materials.html from a saved estimate.json without calling the model. */
export async function renderHtml(planDir: string): Promise<string> {
  const estimate = { ...(await loadEstimate(planDir)), planDir };
  const htmlPath = `${planDir}/materials.html`;
  await writeFile(htmlPath, toHtml(estimate));
  return htmlPath;
}

export async function run(
  planDir: string,
  onProgress?: (p: EstimateProgress) => void,
): Promise<Estimate> {
  const plan = await loadPlan(planDir);
  const types = houseTypesOf(plan);
  const total = types.length * (TRADES.length + 1);
  let step = 0;
  const tag = (house: HouseType | null) =>
    types.length > 1 && house ? `Type ${house.type}: ` : "";

  const houses: HouseEstimate[] = [];
  for (const house of types) {
    onProgress?.({ step: `${tag(house)}Reading the plan`, index: ++step, total });
    const spec = await withRetry(() => readSpec(plan, house));

    const trades: TradeEstimate[] = [];
    const failedTrades: string[] = [];
    for (const trade of TRADES) {
      onProgress?.({ step: `${tag(house)}${trade.name}`, index: ++step, total });
      try {
        trades.push(await withRetry(() => estimateTrade(trade, spec, plan.location)));
      } catch {
        failedTrades.push(trade.name);
      }
    }
    houses.push({
      type: house?.type ?? "A",
      name: house?.name ?? "House",
      count: house?.count ?? 1,
      spec,
      trades,
      failedTrades,
      materialsUsd: trades.reduce((s, t) => s + t.materialsUsd, 0),
      laborUsd: trades.reduce((s, t) => s + t.laborUsd, 0),
    });
  }

  const materialsUsd = houses.reduce((s, h) => s + h.materialsUsd * h.count, 0);
  const laborUsd = houses.reduce((s, h) => s + h.laborUsd * h.count, 0);
  const contingencyUsd = (materialsUsd + laborUsd) * CONTINGENCY;
  const estimate: Estimate = {
    model: ESTIMATE_MODEL,
    planDir,
    location: plan.location,
    strategy: STRATEGY_LABEL[plan.strategy?.strategy ?? "single-house"],
    homes: houses.reduce((s, h) => s + h.count, 0),
    heatedSqft: houses.reduce((s, h) => s + h.spec.heatedSqft * h.count, 0),
    houses,
    materialsUsd,
    laborUsd,
    contingencyUsd,
    totalUsd: materialsUsd + laborUsd + contingencyUsd,
    markdownPath: `${planDir}/materials.md`,
    htmlPath: `${planDir}/materials.html`,
    jsonPath: `${planDir}/estimate.json`,
  };

  await writeFile(estimate.markdownPath, toMarkdown(estimate));
  await writeFile(estimate.htmlPath, toHtml(estimate));
  await writeFile(estimate.jsonPath, JSON.stringify(estimate, null, 2));
  return estimate;
}
