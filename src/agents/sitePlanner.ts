import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { DESIGN_MODEL, chatJson } from "../llm.ts";
import type { Listing } from "./landSearch.ts";
import { allowedTypes, housingTypesText } from "./siteRules.ts";
import { HOUSING_TYPES, type HousingType, type ZoningRules } from "./zoning.ts";

export type Lot = { widthFt: number; depthFt: number };

// The drawing and the downstream agents can't handle a whole subdivision in one plan.
const MAX_HOMES = 10;
const MAX_ATTEMPTS = 3;
const MIN_HEATED = 800;
const MAX_HEATED = 3500;
const GARAGE_SQFT = { "2-car": 440, "1-car": 260, none: 0 } as const;
/** Parking spaces per home: the garage plus one on the driveway. */
const PARKING_SPACES = { "2-car": 3, "1-car": 2, none: 1 } as const;

const HouseTypeSchema = z.object({
  name: z.string(),
  count: z.number().int(),
  stories: z.number().int(),
  bedrooms: z.number().int(),
  bathrooms: z.number(),
  heatedSqft: z.number(),
  garage: z.enum(["2-car", "1-car", "none"]),
});

const StrategySchema = z.object({
  reasoning: z.string(),
  strategy: z.enum(["single-house", "multiple-homes-one-lot", "subdivide"]),
  housingType: z.enum(HOUSING_TYPES),
  layout: z.string(),
  houseTypes: z.array(HouseTypeSchema),
  approvals: z.array(z.string()),
});

type ModelStrategy = z.infer<typeof StrategySchema>;
type ModelHouseType = z.infer<typeof HouseTypeSchema>;

export type HouseType = ModelHouseType & {
  type: string;
  footprintWidthFt: number;
  footprintDepthFt: number;
};

export type SiteStrategy = Omit<ModelStrategy, "houseTypes" | "housingType"> & {
  /** Missing in plans made before site rules research. */
  housingType?: HousingType;
  model: string;
  homes: number;
  houseTypes: HouseType[];
};

export type SiteLimits = {
  lotSqft: number;
  buildableWidthFt: number;
  buildableDepthFt: number;
  maxFootprintSqft: number;
  maxStories: number;
  homesOnOneLot: number;
  homesOnOneLotNote: string;
  maxLotsIfSubdivided: number;
  maxLotsNote: string;
  /** Total heated floor area allowed by the floor area ratio, if the rules set one. */
  maxFloorAreaSqft: number | null;
  parkingPerUnit: number | null;
  /** Housing types the research marked "no"; plans may not use them. */
  forbiddenTypes: HousingType[];
};

export function siteLimits(lot: Lot, rules: ZoningRules): SiteLimits {
  const lotSqft = lot.widthFt * lot.depthFt;
  const research = rules.research;
  const forbiddenTypes = (research?.housingTypes ?? [])
    .filter((t) => t.allowed === "no")
    .map((t) => t.type);
  const severalAllowed = allowedTypes(rules).some(
    (t) => t.type !== "single-family" && t.type !== "small-lot-subdivision",
  );
  const buildableWidthFt = Math.max(0, lot.widthFt - 2 * rules.interiorSideFt);
  const buildableDepthFt = Math.max(0, lot.depthFt - rules.frontFt - rules.rearFt);
  const buildableSqft = buildableWidthFt * buildableDepthFt;
  const maxFootprintSqft = Math.round(
    rules.maxBuildingCoverage === null
      ? buildableSqft
      : Math.min(buildableSqft, lotSqft * rules.maxBuildingCoverage),
  );

  let homesOnOneLot: number;
  let homesOnOneLotNote: string;
  if (lotSqft < rules.minLotSqft) {
    homesOnOneLot = 1;
    homesOnOneLotNote = `lot is below the ${rules.minLotSqft.toLocaleString("en-US")} sq ft standard lot size, so only 1 home`;
  } else if (research && !severalAllowed && (rules.maxUnits ?? 1) <= 1) {
    homesOnOneLot = 1;
    homesOnOneLotNote = "the rules allow only one dwelling on a lot here";
  } else if (rules.maxUnits !== null) {
    homesOnOneLot = rules.maxUnits;
    homesOnOneLotNote = `zoning allows up to ${rules.maxUnits} dwelling unit(s) per lot`;
  } else {
    homesOnOneLot = Math.max(1, Math.floor(lotSqft / 2500));
    homesOnOneLotNote =
      "no fixed unit cap in the rules data; assuming 1 home per 2,500 sq ft of land";
  }

  const byArea = Math.floor(lotSqft / rules.minSubdivisionLotSqft);
  const byWidth = rules.minLotWidthFt ? Math.floor(lot.widthFt / rules.minLotWidthFt) : byArea;
  let maxLots = Math.max(1, Math.min(byArea, byWidth));
  let maxLotsNote = `smallest new lot ${rules.minSubdivisionLotSqft.toLocaleString("en-US")} sq ft${rules.minLotWidthFt ? `, at least ${rules.minLotWidthFt} ft wide` : ""}`;
  if (forbiddenTypes.includes("small-lot-subdivision")) {
    maxLots = 1;
    maxLotsNote = "the rules don't allow subdividing into smaller lots here";
  }

  return {
    lotSqft,
    buildableWidthFt,
    buildableDepthFt,
    maxFootprintSqft,
    maxStories: Math.max(
      1,
      Math.min(3, rules.maxStories ?? 3, Math.floor((rules.maxHeightFt - 5) / 10)),
    ),
    homesOnOneLot: Math.min(homesOnOneLot, MAX_HOMES),
    homesOnOneLotNote,
    maxLotsIfSubdivided: Math.min(MAX_HOMES, maxLots),
    maxLotsNote,
    maxFloorAreaSqft: rules.maxFar ? Math.floor(lotSqft * rules.maxFar) : null,
    parkingPerUnit: rules.parkingPerUnit ?? null,
    forbiddenTypes,
  };
}

function groundFloorSqft(t: ModelHouseType): number {
  return Math.ceil(t.heatedSqft / Math.max(1, t.stories) + GARAGE_SQFT[t.garage]);
}

/** Ground-floor outline (house + attached garage), about 1:1.25, narrowed to fit the buildable width. */
function footprint(t: ModelHouseType, l: SiteLimits): { widthFt: number; depthFt: number } {
  const area = groundFloorSqft(t);
  const widthFt = Math.max(
    1,
    Math.min(Math.floor(l.buildableWidthFt), Math.ceil(Math.sqrt(area / 1.25))),
  );
  return { widthFt, depthFt: Math.ceil(area / widthFt) };
}

const SYSTEM = `You are a residential development planner. Given a piece of land and its zoning
limits, decide what to build to get the most value for the owner.

Choose one strategy:
- "single-house": one home on the lot.
- "multiple-homes-one-lot": several homes on the existing lot, up to the per-lot unit limit.
  No subdivision needed.
- "subdivide": split the land into new lots, one home per lot. Needs a subdivision/replat
  approval from the city, which adds months.

How to optimize:
- Build as many homes as the rules and a livable layout allow. A single house is right only when
  the rules or the lot size don't allow more.
- Prefer "multiple-homes-one-lot" over "subdivide" when they give a similar number of homes.
  Subdividing is worth the extra approval time when it gives clearly more homes.
- Use the per-home table to see how many homes really fit; do not assume single-story homes.
- Size each home to what sells in this area: ${MIN_HEATED.toLocaleString("en-US")} to ${MAX_HEATED.toLocaleString("en-US")} sq ft heated, usually 1,200 to 2,800.
  Give every home parking and access to the street (shared driveways are fine).
- Use 1 to 3 house types. Identical homes share one type with a count.
- Bedrooms must fit the heated area (about 300 sq ft per bedroom plus 300).

Ground floor: each home's ground floor is heatedSqft / stories + garage (2-car 440 sq ft,
1-car 260 sq ft). The ground floors of all homes together must fit the max building footprint;
use the per-home table below. More stories or smaller garages let more homes fit.

Legal housing types: when the rules list which housing types are allowed, only use a type marked
"yes" or "conditional" (meet the condition, and list the approval it needs). Never use one
marked "no". "housingType" is the legal type the plan uses: e.g. "single-family" for one house,
"adu" for a house plus an accessory unit, "duplex", "triplex-fourplex" or "townhouse" for
several homes on one lot, "small-lot-subdivision" when subdividing. Respect the floor area ratio
and parking rules when given.

"reasoning" comes first: two or three sentences comparing the options against the limits and
saying why your choice is the best use of the land.
"layout": one or two sentences on where the homes sit on the land and how they reach the street.
"approvals": permits and approvals this strategy needs, short items.`;

/** What the site rules research found that bears on what to build. */
function researchText(rules: ZoningRules): string {
  const r = rules.research;
  if (!r) return "";
  const lines = [
    `\n\nHOUSING TYPES ALLOWED (researched, ${r.confidence} confidence)`,
    housingTypesText(rules),
  ];
  if (r.overlays.length)
    lines.push("OVERLAYS", ...r.overlays.map((o) => `  - ${o.name}: ${o.effect}`));
  if (r.stateLaws.length) lines.push("STATE LAWS", ...r.stateLaws.map((s) => `  - ${s}`));
  if (r.designStandards.length)
    lines.push("DESIGN STANDARDS", ...r.designStandards.map((s) => `  - ${s}`));
  return lines.join("\n");
}

function limitsText(listing: Listing, lot: Lot, rules: ZoningRules, l: SiteLimits): string {
  const n = (v: number) => Math.round(v).toLocaleString("en-US");
  const maxHomes = Math.max(l.homesOnOneLot, l.maxLotsIfSubdivided);
  const perHome = Array.from({ length: maxHomes }, (_, i) => {
    const k = i + 1;
    const ground = l.maxFootprintSqft / k;
    const stories = Math.min(2, l.maxStories);
    const heated = Math.min(
      MAX_HEATED,
      Math.floor(((ground - GARAGE_SQFT["1-car"]) * stories) / 50) * 50,
    );
    const example =
      heated >= MIN_HEATED
        ? `fits e.g. a ${stories}-story ${n(heated)} sq ft home with a 1-car garage`
        : "too small for a home";
    return `  - ${k} ${k === 1 ? "home" : "homes"}: up to ${n(ground)} sq ft of ground floor each (${example})`;
  }).join("\n");
  return `LAND
- Address: ${listing.address}
- Asking price: ${listing.priceUsd ? `$${n(listing.priceUsd)}` : "unknown"}
- Lot: ${lot.widthFt} ft street frontage x ${lot.depthFt} ft deep = ${n(l.lotSqft)} sq ft

ZONING: ${rules.district} (${rules.districtName}), ${rules.jurisdiction}
- Setbacks: front ${rules.frontFt} ft, sides ${rules.interiorSideFt} ft, rear ${rules.rearFt} ft
- Max height: ${rules.maxHeightFt} ft (at most ${l.maxStories} stories)
${rules.notes.map((x) => `- Note: ${x}`).join("\n")}${researchText(rules)}

LIMITS (already calculated, treat as hard limits)
- Buildable area inside setbacks: ${n(l.buildableWidthFt)} ft wide x ${n(l.buildableDepthFt)} ft deep
- Max total building footprint (all homes + garages): ${n(l.maxFootprintSqft)} sq ft
- Homes allowed on the existing lot: ${l.homesOnOneLot} (${l.homesOnOneLotNote})
- New lots possible if subdivided: ${l.maxLotsIfSubdivided} (${l.maxLotsNote})${l.maxFloorAreaSqft ? `\n- Max total heated floor area (floor area ratio ${rules.maxFar}): ${n(l.maxFloorAreaSqft)} sq ft` : ""}${l.parkingPerUnit ? `\n- Parking: ${l.parkingPerUnit} spaces per home (a garage space counts, plus one driveway space)` : ""}
- Ground floor available per home:
${perHome}${maxHomes >= MAX_HOMES ? `\n- This concept plan covers at most ${MAX_HOMES} homes; if more fit, plan the first phase and say so.` : ""}`;
}

function validate(s: ModelStrategy, l: SiteLimits): string[] {
  const errors: string[] = [];
  const homes = s.houseTypes.reduce((sum, t) => sum + t.count, 0);

  if (s.houseTypes.length === 0) errors.push("houseTypes is empty.");
  if (s.houseTypes.length > 3) errors.push("Use at most 3 house types.");
  if (homes > MAX_HOMES) errors.push(`Plan at most ${MAX_HOMES} homes.`);
  if (l.forbiddenTypes.includes(s.housingType))
    errors.push(`The rules don't allow "${s.housingType}" here. Use an allowed housing type.`);
  if (s.strategy === "single-house" && homes !== 1) {
    errors.push(`"single-house" must have exactly 1 home, you planned ${homes}.`);
  }
  if (s.strategy === "multiple-homes-one-lot") {
    if (homes < 2) errors.push(`"multiple-homes-one-lot" needs at least 2 homes.`);
    if (homes > l.homesOnOneLot) {
      errors.push(
        `Only ${l.homesOnOneLot} home(s) are allowed on the existing lot, you planned ${homes}.`,
      );
    }
  }
  if (s.strategy === "subdivide") {
    if (l.maxLotsIfSubdivided < 2) errors.push(`The land can't be subdivided: ${l.maxLotsNote}.`);
    else if (homes > l.maxLotsIfSubdivided) {
      errors.push(
        `Subdividing allows at most ${l.maxLotsIfSubdivided} lots, you planned ${homes} homes.`,
      );
    }
  }

  let total = 0;
  for (const t of s.houseTypes) {
    if (t.count < 1) errors.push(`"${t.name}": count must be at least 1.`);
    if (t.stories < 1 || t.stories > l.maxStories) {
      errors.push(`"${t.name}": stories must be 1 to ${l.maxStories}.`);
      continue;
    }
    if (t.heatedSqft < MIN_HEATED || t.heatedSqft > MAX_HEATED) {
      errors.push(
        `"${t.name}": keep each home between ${MIN_HEATED} and ${MAX_HEATED} sq ft heated, not ${t.heatedSqft}.`,
      );
    }
    if (t.bedrooms < 1 || t.bedrooms > 6) errors.push(`"${t.name}": bedrooms must be 1 to 6.`);
    else if (t.heatedSqft < 300 + t.bedrooms * 300) {
      errors.push(
        `"${t.name}": ${t.heatedSqft} sq ft is too small for ${t.bedrooms} bedrooms ` +
          `(needs about ${300 + t.bedrooms * 300}).`,
      );
    }
    if (t.bathrooms < 1) errors.push(`"${t.name}": needs at least 1 bathroom.`);
    if (l.parkingPerUnit && PARKING_SPACES[t.garage] < Math.ceil(l.parkingPerUnit)) {
      errors.push(
        `"${t.name}": each home needs ${l.parkingPerUnit} parking spaces; a ${t.garage} garage plus ` +
          `the driveway gives ${PARKING_SPACES[t.garage]}. Use a bigger garage.`,
      );
    }

    const ground = groundFloorSqft(t);
    total += ground * Math.max(0, t.count);
    if (footprint(t, l).depthFt > l.buildableDepthFt) {
      errors.push(
        `"${t.name}": a ${ground} sq ft ground floor does not fit the ${l.buildableWidthFt}x` +
          `${l.buildableDepthFt} ft buildable area. Add a story or make the home smaller.`,
      );
    }
  }
  if (total > l.maxFootprintSqft) {
    errors.push(
      `The ground floors of all homes add up to ${total} sq ft (heatedSqft / stories + garage, ` +
        `times count), over the ${l.maxFootprintSqft} sq ft limit. Use more stories, smaller ` +
        "homes, smaller garages or fewer homes.",
    );
  }
  const floorArea = s.houseTypes.reduce((sum, t) => sum + t.heatedSqft * Math.max(0, t.count), 0);
  if (l.maxFloorAreaSqft !== null && floorArea > l.maxFloorAreaSqft) {
    errors.push(
      `The homes add up to ${floorArea} sq ft heated, over the ${l.maxFloorAreaSqft} sq ft the ` +
        "floor area ratio allows. Use smaller or fewer homes.",
    );
  }
  return errors;
}

export async function plan(listing: Listing, lot: Lot, rules: ZoningRules): Promise<SiteStrategy> {
  const limits = siteLimits(lot, rules);
  const base = limitsText(listing, lot, rules, limits);
  const schema = z.toJSONSchema(StrategySchema);

  let feedback = "";
  let lastErrors: string[] = [];
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let raw: string;
    let parsed: ModelStrategy;
    try {
      raw = await chatJson(SYSTEM, base + feedback, schema, { model: DESIGN_MODEL });
      parsed = StrategySchema.parse(JSON.parse(raw));
    } catch (err) {
      lastErrors = [err instanceof Error ? err.message : String(err)];
      continue;
    }

    lastErrors = validate(parsed, limits);
    if (lastErrors.length === 0) {
      const houseTypes = parsed.houseTypes.map((t, i) => {
        const fp = footprint(t, limits);
        return {
          ...t,
          type: String.fromCharCode(65 + i),
          footprintWidthFt: fp.widthFt,
          footprintDepthFt: fp.depthFt,
        };
      });
      return {
        ...parsed,
        model: DESIGN_MODEL,
        homes: houseTypes.reduce((s, t) => s + t.count, 0),
        houseTypes,
      };
    }
    feedback =
      "\n\nCHECK BEFORE ANSWERING (a draft for this land made these mistakes, avoid them):\n" +
      lastErrors.map((e) => `- ${e}`).join("\n");
  }
  throw new Error(`The model could not produce a valid site plan: ${lastErrors.join(" ")}`);
}

export type Home = { id: string; type: HouseType };

export function homes(s: SiteStrategy): Home[] {
  const list: Home[] = [];
  for (const t of s.houseTypes) {
    for (let i = 0; i < t.count; i++) list.push({ id: `H${list.length + 1}`, type: t });
  }
  return list;
}

export function houseTypeLine(t: HouseType): string {
  const garage = t.garage === "none" ? "no garage" : `${t.garage} garage`;
  return (
    `Type ${t.type} "${t.name}" x${t.count}: ${t.stories} story, ${t.bedrooms} bed / ${t.bathrooms} bath, ` +
    `${t.heatedSqft.toLocaleString("en-US")} sq ft heated, ${garage}, ` +
    `footprint ${t.footprintWidthFt} ft x ${t.footprintDepthFt} ft`
  );
}

export { HOUSING_TYPE_LABEL } from "./zoning.ts";

export const STRATEGY_LABEL: Record<SiteStrategy["strategy"], string> = {
  "single-house": "One house",
  "multiple-homes-one-lot": "Several homes on the existing lot",
  subdivide: "Subdivide into new lots, one home each",
};

export async function loadStrategy(planDir: string): Promise<SiteStrategy | null> {
  const path = `${planDir}/strategy.json`;
  if (!existsSync(path)) return null;
  return JSON.parse(await readFile(path, "utf8")) as SiteStrategy;
}
