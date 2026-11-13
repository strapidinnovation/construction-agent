/**
 * Interior designer agent: a furnished 3D top view of every floor in a plan.
 *
 *   1. Read the floors   - the model copies each floor's rooms, doors, windows
 *                          and openings out of plan.svg; code turns them into
 *                          feet and works out the walls from the room edges.
 *   2. Pick a style      - the model chooses finishes and colors that suit the
 *                          house and its price point.
 *   3. Furnish           - the model places furniture from a fixed catalog in
 *                          each room; code checks every piece fits its room,
 *                          doesn't overlap another and keeps doorways clear.
 *   4. Render            - interior/scene.js builds the floor in three.js and
 *                          headless Chrome takes the picture (render.ts).
 *   5. PDF               - one picture per page, and nothing else.
 *
 * Everything the renderer needs is saved in interior.json, so the pictures can
 * be made again without the model (renderInterior).
 */
import { existsSync } from "node:fs";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { DESIGN_MODEL, chatJson } from "../llm.ts";
import { PROJECT_ROOT } from "../paths.ts";
import { printPdf, screenshotWebGl } from "../superagent/render.ts";
import type { Listing } from "./landSearch.ts";
import { loadStrategy, type SiteStrategy } from "./sitePlanner.ts";

const MAX_ATTEMPTS = 3;
const EXTERIOR_WALL_FT = 0.7;
const INTERIOR_WALL_FT = 0.4;
/** Pixel size of each picture: US Letter landscape proportions. */
const IMAGE = { width: 2200, height: 1700, scale: 1.5 };

// ---------------------------------------------------------------------------
// Step 1: reading the floors out of plan.svg.
// ---------------------------------------------------------------------------

const ROOM_KINDS = [
  "bedroom",
  "living",
  "family",
  "dining",
  "kitchen",
  "bath",
  "hall",
  "entry",
  "laundry",
  "closet",
  "garage",
  "stairs",
  "office",
  "loft",
  "storage",
  "porch",
  "other",
] as const;
type RoomKind = (typeof ROOM_KINDS)[number];

const OPENING_KINDS = ["door", "opening", "sliding-door", "garage-door", "window"] as const;

const Pt = z.object({ x: z.number(), y: z.number() });
type Pt = z.infer<typeof Pt>;

const FloorsSchema = z.object({
  floors: z.array(
    z.object({
      houseType: z.string(),
      level: z.number().int(),
      name: z.string(),
      pxPerFt: z.number(),
      rooms: z.array(
        z.object({
          name: z.string(),
          kind: z.enum(ROOM_KINDS),
          x: z.number(),
          y: z.number(),
          w: z.number(),
          h: z.number(),
          labelFt: z.object({ w: z.number(), d: z.number() }).nullable(),
        }),
      ),
      openings: z.array(
        z.object({
          kind: z.enum(OPENING_KINDS),
          a: Pt,
          b: Pt,
          leafEnd: Pt.nullable(),
          swingInto: z.string().nullable(),
        }),
      ),
      openPlan: z.array(z.object({ a: z.string(), b: z.string() })),
    }),
  ),
});
type DrawnFloor = z.infer<typeof FloorsSchema>["floors"][number];

export type Room = { name: string; kind: RoomKind; x: number; y: number; w: number; d: number };
export type Opening = {
  kind: (typeof OPENING_KINDS)[number];
  a: Pt;
  b: Pt;
  leafEnd: Pt | null;
  swingInto: string | null;
};
/** One floor in feet: x grows to the right, y grows down the drawing, origin at the top-left corner. */
export type Floor = {
  houseType: string;
  level: number;
  name: string;
  widthFt: number;
  depthFt: number;
  rooms: Room[];
  openings: Opening[];
  openPlan: { a: string; b: string }[];
};

const EXTRACT_SYSTEM = `You read the FLOOR PLAN panel of an architectural SVG drawing and return its floors as data.
The panel holds one floor plan per house type; a type with 2+ stories has its floors side by side.
Return every floor of every house type you are given.

For each floor:
- houseType: the type letter, e.g. "A". level: 1 for the ground floor, 2 for the floor above, ...
- name: e.g. "Ground floor".
- pxPerFt: the drawing scale in SVG units per foot (from a scale note, or a dimension line's length
  in SVG units divided by the feet it is labeled with).
- rooms: every room rectangle, copied from its SVG <rect>: x, y, w (width), h (height), in SVG units.
  Give its label as name, a kind, and labelFt: the size written in its label (14'x12' means w 14, d 12),
  or null when there is none. Include closets, halls, stairs and the garage. Leave out "open to
  below" or roof areas, the footprint outline, dimension lines and anything outside the floor.
- openings, in SVG units:
  - door: a door gap drawn with a swing arc. The arc is a path "M hx,hy L lx,ly A ... ex,ey":
    a = (hx,hy) the hinge, leafEnd = (lx,ly) the end of the open door leaf, b = (ex,ey) the other
    end of the gap. swingInto = the name of the room the arc is drawn in (or null if outside).
  - opening: a cased opening or a gap in a wall with no door; a and b are its two ends.
  - sliding-door and garage-door: a and b are its two ends.
  - window: a and b are the two ends of a window on an exterior wall.
  leafEnd and swingInto are null for everything except doors.
- openPlan: pairs of room names drawn as one open space with no wall between them (e.g. kitchen
  and dining separated only by a dashed line or nothing). Empty when there are none.
Copy the numbers from the SVG. Don't invent rooms or openings that aren't drawn.`;

/** Group nearly equal coordinates and map each to its group's average. */
function snapper(values: number[], tol: number): (v: number) => number {
  const sorted = [...values].sort((a, b) => a - b);
  const groups: number[][] = [];
  for (const v of sorted) {
    const last = groups.at(-1);
    if (last && v - last.at(-1)! <= tol) last.push(v);
    else groups.push([v]);
  }
  const centers = groups.map((g) => g.reduce((s, v) => s + v, 0) / g.length);
  return (v) => {
    let best = v;
    let dist = tol;
    for (const c of centers) {
      if (Math.abs(c - v) <= dist) {
        best = c;
        dist = Math.abs(c - v);
      }
    }
    return Math.round(best * 100) / 100;
  };
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)]! : NaN;
};

/** Turn a floor drawn in SVG units into feet, with room edges that meet exactly. */
function toFeet(f: DrawnFloor): Floor {
  // The room labels ("14'x12'") pin down the scale better than a single scale note.
  const ratios = f.rooms.flatMap((r) => {
    if (!r.labelFt) return [];
    const [a, b] = [Math.max(r.w, r.h), Math.min(r.w, r.h)];
    const [la, lb] = [Math.max(r.labelFt.w, r.labelFt.d), Math.min(r.labelFt.w, r.labelFt.d)];
    return la > 0 && lb > 0 ? [a / la, b / lb] : [];
  });
  const fromLabels = median(ratios);
  const scale = ratios.length >= 3 && fromLabels > 0 ? fromLabels : f.pxPerFt;

  const minX = Math.min(...f.rooms.map((r) => r.x));
  const minY = Math.min(...f.rooms.map((r) => r.y));
  const ft = (p: Pt): Pt => ({ x: (p.x - minX) / scale, y: (p.y - minY) / scale });

  const raw = f.rooms.map((r) => ({
    name: r.name,
    kind: r.kind,
    x: (r.x - minX) / scale,
    y: (r.y - minY) / scale,
    w: r.w / scale,
    d: r.h / scale,
  }));
  const snapX = snapper(
    raw.flatMap((r) => [r.x, r.x + r.w]),
    0.75,
  );
  const snapY = snapper(
    raw.flatMap((r) => [r.y, r.y + r.d]),
    0.75,
  );
  const rooms = raw.map((r) => {
    const x = snapX(r.x);
    const y = snapY(r.y);
    return { ...r, x, y, w: snapX(r.x + r.w) - x, d: snapY(r.y + r.d) - y };
  });

  return {
    houseType: f.houseType,
    level: f.level,
    name: f.name,
    widthFt: Math.max(...rooms.map((r) => r.x + r.w)),
    depthFt: Math.max(...rooms.map((r) => r.y + r.d)),
    rooms,
    openings: f.openings.map((o) => ({
      kind: o.kind,
      a: ft(o.a),
      b: ft(o.b),
      leafEnd: o.leafEnd ? ft(o.leafEnd) : null,
      swingInto: o.swingInto,
    })),
    openPlan: f.openPlan,
  };
}

function floorProblems(floors: Floor[], strategy: SiteStrategy): string[] {
  const errors: string[] = [];
  for (const t of strategy.houseTypes) {
    const mine = floors.filter((f) => f.houseType === t.type);
    if (mine.length !== t.stories)
      errors.push(`Type ${t.type} has ${t.stories} floors, but you returned ${mine.length}.`);
  }
  for (const f of floors) {
    const where = `Type ${f.houseType} level ${f.level}`;
    if (f.rooms.length < 2) errors.push(`${where}: return every room on the floor.`);
    if (f.widthFt < 10 || f.depthFt < 10 || f.widthFt > 200 || f.depthFt > 200)
      errors.push(
        `${where}: the floor works out to ${Math.round(f.widthFt)} x ${Math.round(f.depthFt)} ft; check pxPerFt and the room coordinates.`,
      );
    for (let i = 0; i < f.rooms.length; i++)
      for (let j = i + 1; j < f.rooms.length; j++) {
        const a = f.rooms[i]!;
        const b = f.rooms[j]!;
        const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        const oy = Math.min(a.y + a.d, b.y + b.d) - Math.max(a.y, b.y);
        if (ox > 1 && oy > 1)
          errors.push(
            `${where}: rooms "${a.name}" and "${b.name}" overlap; copy each room's own rectangle.`,
          );
      }
  }
  return errors;
}

async function readFloors(svg: string, strategy: SiteStrategy): Promise<Floor[]> {
  const types = strategy.houseTypes
    .map(
      (t) =>
        `- Type ${t.type}: ${t.name}, ${t.stories} ${t.stories === 1 ? "story" : "stories"}, ${t.bedrooms} bed / ${t.bathrooms} bath, footprint ${t.footprintWidthFt}' x ${t.footprintDepthFt}'`,
    )
    .join("\n");
  const base = `HOUSE TYPES\n${types}\n\nSVG\n${svg}`;
  const schema = z.toJSONSchema(FloorsSchema);
  let feedback = "";
  let errors: string[] = [];
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const raw = await chatJson(EXTRACT_SYSTEM, base + feedback, schema, { model: DESIGN_MODEL });
      const drawn = FloorsSchema.parse(JSON.parse(raw)).floors.filter((f) => f.rooms.length);
      const floors = drawn
        .map(toFeet)
        .sort((a, b) =>
          a.houseType === b.houseType ? a.level - b.level : a.houseType.localeCompare(b.houseType),
        );
      errors = floorProblems(floors, strategy);
      if (!errors.length) return floors;
    } catch (err) {
      errors = [err instanceof Error ? err.message : String(err)];
    }
    feedback = `\n\nA previous reading had these problems, fix them:\n${errors.map((e) => `- ${e}`).join("\n")}`;
  }
  throw new Error(`Couldn't read the floor plans from the drawing: ${errors.join(" ")}`);
}

// ---------------------------------------------------------------------------
// Walls: worked out from the room edges, with the openings cut out.
// ---------------------------------------------------------------------------

export type WallPiece = {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  t: number;
  kind: "wall" | "window" | "sliding-door" | "garage-door";
};
export type DoorLeaf = { hinge: Pt; end: Pt };

type Line = { horizontal: boolean; at: number; from: number; to: number; exterior: boolean };

function roomAt(rooms: Room[], x: number, y: number): Room | undefined {
  return rooms.find((r) => x > r.x && x < r.x + r.w && y > r.y && y < r.y + r.d);
}

function wallLines(f: Floor): Line[] {
  const open = (a?: Room, b?: Room) =>
    !!a &&
    !!b &&
    f.openPlan.some(
      (p) => (p.a === a.name && p.b === b.name) || (p.a === b.name && p.b === a.name),
    );
  const lines: Line[] = [];
  for (const horizontal of [true, false]) {
    const edges = f.rooms.flatMap((r) =>
      horizontal
        ? [
            { at: r.y, from: r.x, to: r.x + r.w },
            { at: r.y + r.d, from: r.x, to: r.x + r.w },
          ]
        : [
            { at: r.x, from: r.y, to: r.y + r.d },
            { at: r.x + r.w, from: r.y, to: r.y + r.d },
          ],
    );
    for (const at of [...new Set(edges.map((e) => e.at))]) {
      const mine = edges.filter((e) => e.at === at);
      const cuts = [...new Set(mine.flatMap((e) => [e.from, e.to]))].sort((a, b) => a - b);
      for (let i = 0; i + 1 < cuts.length; i++) {
        const [p, q] = [cuts[i]!, cuts[i + 1]!];
        if (q - p < 0.05 || !mine.some((e) => e.from <= p + 0.01 && e.to >= q - 0.01)) continue;
        const mid = (p + q) / 2;
        const one = horizontal ? roomAt(f.rooms, mid, at - 0.25) : roomAt(f.rooms, at - 0.25, mid);
        const two = horizontal ? roomAt(f.rooms, mid, at + 0.25) : roomAt(f.rooms, at + 0.25, mid);
        if (open(one, two)) continue;
        const exterior = !one || !two;
        const last = lines.at(-1);
        if (
          last &&
          last.horizontal === horizontal &&
          last.at === at &&
          last.exterior === exterior &&
          Math.abs(last.to - p) < 0.01
        )
          last.to = q;
        else lines.push({ horizontal, at, from: p, to: q, exterior });
      }
    }
  }
  return lines;
}

/** The walls of a floor, with gaps for doors and openings and glass for windows. */
export function buildWalls(f: Floor): { walls: WallPiece[]; doors: DoorLeaf[] } {
  type Span = Line & { kind: WallPiece["kind"]; openFrom: boolean; openTo: boolean };
  let spans: Span[] = wallLines(f).map((l) => ({
    ...l,
    kind: "wall",
    openFrom: false,
    openTo: false,
  }));
  const doors: DoorLeaf[] = [];

  for (const o of f.openings) {
    const horizontal = Math.abs(o.a.x - o.b.x) >= Math.abs(o.a.y - o.b.y);
    const at = horizontal ? (o.a.y + o.b.y) / 2 : (o.a.x + o.b.x) / 2;
    const lo = horizontal ? Math.min(o.a.x, o.b.x) : Math.min(o.a.y, o.b.y);
    const hi = horizontal ? Math.max(o.a.x, o.b.x) : Math.max(o.a.y, o.b.y);
    if (hi - lo < 0.5) continue;
    const host = spans
      .filter((s) => s.horizontal === horizontal && s.kind === "wall" && Math.abs(s.at - at) < 1.25)
      .filter((s) => s.from < hi - 0.1 && s.to > lo + 0.1)
      .sort((a, b) => Math.abs(a.at - at) - Math.abs(b.at - at))[0];
    if (!host) continue;
    if (o.kind === "window" && !host.exterior) continue;

    const a = Math.max(lo, host.from);
    const b = Math.min(hi, host.to);
    const next: Span[] = [];
    if (a - host.from > 0.05) next.push({ ...host, to: a, openTo: o.kind !== "window" });
    if (o.kind !== "door" && o.kind !== "opening")
      next.push({ ...host, from: a, to: b, kind: o.kind, openFrom: true, openTo: true });
    if (host.to - b > 0.05) next.push({ ...host, from: b, openFrom: o.kind !== "window" });
    spans = spans.flatMap((s) => (s === host ? next : [s]));

    if (o.kind === "door") {
      const onWall = (p: Pt): Pt => (horizontal ? { x: p.x, y: host.at } : { x: host.at, y: p.y });
      const hinge = onWall(o.a);
      const width = Math.hypot(o.b.x - o.a.x, o.b.y - o.a.y);
      let end = o.leafEnd;
      if (!end) {
        // No leaf drawn: swing it into the named room, perpendicular to the wall.
        const room = f.rooms.find((r) => r.name === o.swingInto);
        const side = room
          ? Math.sign((horizontal ? room.y + room.d / 2 : room.x + room.w / 2) - host.at) || 1
          : 1;
        end = horizontal
          ? { x: hinge.x, y: hinge.y + side * width }
          : { x: hinge.x + side * width, y: hinge.y };
      }
      doors.push({ hinge, end });
    }
  }

  const walls = spans.map((s) => {
    const t = s.exterior ? EXTERIOR_WALL_FT : INTERIOR_WALL_FT;
    // Solid walls run past their ends by half a thickness so corners close; not into a doorway.
    const from = s.from - (s.kind === "wall" && !s.openFrom ? t / 2 : 0);
    const to = s.to + (s.kind === "wall" && !s.openTo ? t / 2 : 0);
    return s.horizontal
      ? { x1: from, y1: s.at, x2: to, y2: s.at, t, kind: s.kind }
      : { x1: s.at, y1: from, x2: s.at, y2: to, t, kind: s.kind };
  });
  return { walls, doors };
}

// ---------------------------------------------------------------------------
// Step 2: the style.
// ---------------------------------------------------------------------------

const FLOOR_MATERIALS = [
  "light-oak",
  "natural-oak",
  "walnut",
  "grey-oak",
  "travertine",
  "white-marble",
  "grey-porcelain",
  "terracotta",
  "slate",
  "polished-concrete",
  "carpet-beige",
  "carpet-grey",
  "white-hex-tile",
] as const;
const FloorMaterial = z.enum(FLOOR_MATERIALS);
const Hex = z.string().describe('A color like "#3f6b4e"');

const StyleSchema = z.object({
  name: z.string(),
  reasoning: z.string(),
  wallColor: Hex,
  floors: z.object({
    living: FloorMaterial,
    bedroom: FloorMaterial,
    kitchen: FloorMaterial,
    bath: FloorMaterial,
    hall: FloorMaterial,
    utility: FloorMaterial,
    garage: FloorMaterial,
  }),
  sofaFabric: Hex,
  accentFabric: Hex,
  bedding: Hex,
  headboard: Hex,
  rug: Hex,
  furnitureWood: Hex,
  cabinets: Hex,
  countertop: z.enum([
    "white-marble",
    "black-granite",
    "white-quartz",
    "butcher-block",
    "concrete",
  ]),
  metal: z.enum(["brass", "chrome", "matte-black", "stainless"]),
  carColor: Hex,
});
export type Style = z.infer<typeof StyleSchema>;

const FLOOR_GROUP: Record<RoomKind, keyof Style["floors"]> = {
  living: "living",
  family: "living",
  dining: "living",
  office: "living",
  loft: "living",
  other: "living",
  bedroom: "bedroom",
  closet: "bedroom",
  kitchen: "kitchen",
  bath: "bath",
  hall: "hall",
  entry: "hall",
  stairs: "hall",
  laundry: "utility",
  storage: "utility",
  garage: "garage",
  porch: "garage",
};

const STYLE_SYSTEM = `You are an interior designer choosing the finishes and furniture colors for a new home.
Pick ONE coherent style that suits the house, its location and its price point: e.g. warm modern,
Scandinavian, coastal, modern farmhouse, mid-century, luxury contemporary. Entry-level homes get
durable, simple finishes (vinyl-look oak, carpet in bedrooms, porcelain tile, quartz); expensive
homes get richer ones (wide oak or walnut, marble, brass). Bathrooms and kitchens need tile or stone.
Colors must work together: walls light and warm, one confident fabric color for the sofa and
dining chairs, a softer accent for cushions and pillows. "reasoning": one sentence on why it suits.`;

const isHex = (s: string) => /^#[0-9a-f]{6}$/i.test(s);

async function chooseStyle(
  listing: Listing,
  strategy: SiteStrategy,
  salePrice: number | null,
): Promise<Style> {
  const t = strategy.houseTypes[0]!;
  const prompt = [
    `Location: ${listing.address}`,
    `Land price: $${listing.priceUsd.toLocaleString("en-US")}`,
    `Homes: ${strategy.houseTypes.map((h) => `${h.count} x ${h.name} (${h.bedrooms} bed / ${h.bathrooms} bath, ${h.heatedSqft} sq ft)`).join("; ")}`,
    salePrice
      ? `Expected sale price per home: $${Math.round(salePrice).toLocaleString("en-US")}`
      : `Typical home: ${t.heatedSqft} sq ft`,
  ].join("\n");
  const raw = await chatJson(STYLE_SYSTEM, prompt, z.toJSONSchema(StyleSchema), {
    model: DESIGN_MODEL,
  });
  const style = StyleSchema.parse(JSON.parse(raw));
  const fallback: Record<string, string> = {
    wallColor: "#efe9df",
    sofaFabric: "#2f6b4f",
    accentFabric: "#9b7a8f",
    bedding: "#f3efe6",
    headboard: "#e6ddcc",
    rug: "#c9bba5",
    furnitureWood: "#6b4a32",
    cabinets: "#b7a99a",
    carColor: "#2b3440",
  };
  for (const [key, value] of Object.entries(fallback)) {
    const k = key as keyof Style;
    if (typeof style[k] === "string" && !isHex(style[k] as string))
      (style as Record<string, unknown>)[k] = value;
  }
  return style;
}

// ---------------------------------------------------------------------------
// Step 3: furniture.
// ---------------------------------------------------------------------------

type CatalogEntry = {
  w: number;
  d: number;
  minW?: number;
  maxW?: number;
  minD?: number;
  maxD?: number;
  note: string;
};

/** Sizes in feet: w side to side as you face the piece, d front to back. */
const CATALOG = {
  "bed-king": { w: 6.7, d: 7, note: "king bed, headboard at the back" },
  "bed-queen": { w: 5.3, d: 7, note: "queen bed" },
  "bed-twin": { w: 3.4, d: 6.6, note: "twin bed" },
  nightstand: { w: 1.7, d: 1.4, note: "bedside table with a lamp, beside the bed head" },
  wardrobe: { w: 4, d: 2, minW: 2.5, maxW: 9, note: "wardrobe against a wall" },
  dresser: { w: 5, d: 1.7, minW: 3, maxW: 6, note: "chest of drawers" },
  desk: { w: 4, d: 2, minW: 3, maxW: 6, note: "desk with a chair in front" },
  sofa: { w: 7, d: 3.1, minW: 5, maxW: 9, note: "sofa" },
  "sofa-l": {
    w: 9,
    d: 6.5,
    minW: 7,
    maxW: 11,
    minD: 5,
    maxD: 8,
    note: "L-shaped sofa; the long arm is at the back, the short arm on the right",
  },
  armchair: { w: 2.8, d: 2.8, note: "armchair" },
  "coffee-table": { w: 4, d: 2, minW: 3, maxW: 5, note: "coffee table in front of the sofa" },
  "side-table": { w: 1.6, d: 1.6, note: "small side table" },
  "tv-unit": { w: 6, d: 1.4, minW: 4, maxW: 8, note: "TV console against a wall, facing the sofa" },
  bookshelf: { w: 3, d: 1.2, minW: 2, maxW: 8, note: "bookshelf against a wall" },
  rug: {
    w: 8,
    d: 10,
    minW: 3,
    maxW: 14,
    minD: 3,
    maxD: 16,
    note: "rug; may go under beds, sofas and tables",
  },
  plant: { w: 1.6, d: 1.6, note: "potted plant, good in corners" },
  "dining-set": {
    w: 6,
    d: 3.3,
    minW: 3,
    maxW: 9,
    minD: 3,
    maxD: 4.5,
    note: "dining table; chairs are added around it and need 1.6 ft on every side (the footprint is w+3.2 by d+3.2)",
  },
  island: {
    w: 6,
    d: 3,
    minW: 4,
    maxW: 10,
    minD: 2.5,
    maxD: 4.5,
    note: "kitchen island; stools are added along its front, which need 1.6 ft",
  },
  counter: {
    w: 6,
    d: 2,
    minW: 1.5,
    maxW: 20,
    note: "kitchen base cabinets with worktop against a wall",
  },
  "counter-sink": { w: 4, d: 2, minW: 2.5, maxW: 12, note: "counter run with a sink in it" },
  "counter-hob": { w: 4, d: 2, minW: 2.5, maxW: 12, note: "counter run with a cooktop in it" },
  fridge: { w: 3, d: 2.5, note: "fridge, against a wall" },
  bathtub: {
    w: 5,
    d: 2.6,
    minW: 4.5,
    maxW: 6,
    note: "bathtub; usually along a wall, long side at the back",
  },
  shower: { w: 3, d: 3, minW: 3, maxW: 6, minD: 3, maxD: 5, note: "shower with glass screen" },
  toilet: { w: 1.6, d: 2.4, note: "toilet, back against a wall" },
  vanity: {
    w: 3,
    d: 1.8,
    minW: 2,
    maxW: 7,
    note: "vanity with basin; 5 ft or wider gets two basins",
  },
  "washer-dryer": { w: 4.6, d: 2.3, note: "washer and dryer side by side" },
  car: { w: 6.2, d: 15, note: "car parked in the garage, front toward the garage door" },
  stairs: {
    w: 3.5,
    d: 10,
    minW: 3,
    maxW: 5,
    minD: 6,
    maxD: 14,
    note: "straight stair; climbs from the front edge toward the back",
  },
  bench: { w: 4, d: 1.4, minW: 2, maxW: 6, note: "bench, e.g. in an entry" },
  cabinet: { w: 3, d: 1.6, minW: 1.5, maxW: 10, note: "storage cabinet or shelving" },
} satisfies Record<string, CatalogEntry>;
type ItemKind = keyof typeof CATALOG;
const ITEM_KINDS = Object.keys(CATALOG) as [ItemKind, ...ItemKind[]];

const FurnishSchema = z.object({
  items: z.array(
    z.object({
      room: z.string(),
      kind: z.enum(ITEM_KINDS),
      x: z.number(),
      y: z.number(),
      w: z.number().nullable(),
      d: z.number().nullable(),
      rotation: z.number(),
    }),
  ),
});

/** A placed piece in floor feet: (x, y) is its center, rot in degrees clockwise (0 = back toward the top). */
export type Item = {
  kind: ItemKind;
  room: string;
  x: number;
  y: number;
  w: number;
  d: number;
  rot: number;
};

const FURNISH_SYSTEM = `You are an interior designer furnishing one floor of a new home, seen from above.
Coordinates are in feet. Each room is given with its size; place pieces with (x, y) = the CENTER
of the piece, measured from the room's top-left corner (x to the right, y down).
rotation says which wall the piece's BACK is against: 0 = back toward the top wall (it faces down),
90 = back toward the right wall, 180 = back toward the bottom wall, 270 = back toward the left wall.
w and d are the piece's own width and depth (before rotation); use null for the standard size.
With rotation 90 or 270 the piece takes d along x and w along y.

CATALOG (standard w x d in feet)
{CATALOG}

Furnish every room the way a real home is lived in:
- Bedrooms: a bed with its headboard against a solid wall (not under a door swing), two nightstands
  (one for a twin), a rug under the bed, a wardrobe or dresser. A desk in a small or secondary room is nice.
- Living/family: a sofa or L-sofa facing a TV unit, a coffee table between them, a rug, an armchair
  if there is room, a plant in a corner.
- Kitchen: counters along the walls with one counter-sink and one counter-hob, a fridge, and an island
  if the kitchen is at least 12 ft in both directions. Dining: a dining-set.
- Bath: a toilet, a vanity, and a bathtub or shower. Laundry: washer-dryer. Garage: one car per bay.
- Rooms of kind "stairs" already have their stair; put nothing there. Halls and entries: at most a bench or plant.
- Closets and storage: a cabinet or nothing.
Hard rules: every piece fully inside its room (pieces may touch the walls); pieces don't overlap
(except a rug under furniture); keep each door's swing (a square as wide as the door, on the side it
opens into) and a 2.5 ft path in front of every doorway free.`;

const catalogText = () =>
  (Object.entries(CATALOG) as [ItemKind, CatalogEntry][])
    .filter(([k]) => k !== "stairs")
    .map(
      ([k, c]) =>
        `- ${k}: ${c.w} x ${c.d}${c.minW ? ` (w ${c.minW}-${c.maxW ?? c.w})` : ""}${c.minD ? ` (d ${c.minD}-${c.maxD ?? c.d})` : ""}: ${c.note}`,
    )
    .join("\n");

/** Which wall of the room an opening sits on, and where along it (room-relative feet). */
function openingsOf(f: Floor, r: Room): string[] {
  const out: string[] = [];
  for (const o of f.openings) {
    const horizontal = Math.abs(o.a.x - o.b.x) >= Math.abs(o.a.y - o.b.y);
    const at = horizontal ? (o.a.y + o.b.y) / 2 : (o.a.x + o.b.x) / 2;
    const lo = horizontal ? Math.min(o.a.x, o.b.x) : Math.min(o.a.y, o.b.y);
    const hi = horizontal ? Math.max(o.a.x, o.b.x) : Math.max(o.a.y, o.b.y);
    const [start, end] = horizontal ? [r.x, r.x + r.w] : [r.y, r.y + r.d];
    if (hi <= start + 0.2 || lo >= end - 0.2) continue;
    let wall: string | null = null;
    if (horizontal && Math.abs(at - r.y) < 1) wall = "top";
    else if (horizontal && Math.abs(at - (r.y + r.d)) < 1) wall = "bottom";
    else if (!horizontal && Math.abs(at - r.x) < 1) wall = "left";
    else if (!horizontal && Math.abs(at - (r.x + r.w)) < 1) wall = "right";
    if (!wall) continue;
    const from = (Math.max(lo, start) - start).toFixed(1);
    const to = (Math.min(hi, end) - start).toFixed(1);
    const axis = horizontal ? "x" : "y";
    const swing =
      o.kind === "door"
        ? o.swingInto === r.name
          ? ", swings into this room"
          : ", swings away"
        : "";
    out.push(`${o.kind} on the ${wall} wall at ${axis} ${from}-${to}${swing}`);
  }
  for (const p of f.openPlan)
    if (p.a === r.name || p.b === r.name)
      out.push(`open to ${p.a === r.name ? p.b : p.a} (no wall)`);
  return out;
}

function floorText(f: Floor): string {
  return f.rooms
    .map((r) => {
      const ops = openingsOf(f, r);
      return `- "${r.name}" (${r.kind}): ${r.w.toFixed(1)} x ${r.d.toFixed(1)} ft${ops.length ? `\n    ${ops.join("\n    ")}` : ""}`;
    })
    .join("\n");
}

type Rect = { x0: number; y0: number; x1: number; y1: number };

/** The floor area a piece takes, including the chairs and stools it brings. */
function footprint(it: Item): Rect {
  let [x0, x1, y0, y1] = [-it.w / 2, it.w / 2, -it.d / 2, it.d / 2];
  if (it.kind === "dining-set") [x0, x1, y0, y1] = [x0 - 1.6, x1 + 1.6, y0 - 1.6, y1 + 1.6];
  if (it.kind === "island") y1 += 1.6;
  const corners = [
    [x0, y0],
    [x1, y0],
    [x0, y1],
    [x1, y1],
  ].map(([x, y]) => {
    const a = (it.rot * Math.PI) / 180;
    return [x! * Math.cos(a) - y! * Math.sin(a) + it.x, x! * Math.sin(a) + y! * Math.cos(a) + it.y];
  });
  return {
    x0: Math.min(...corners.map((c) => c[0]!)),
    x1: Math.max(...corners.map((c) => c[0]!)),
    y0: Math.min(...corners.map((c) => c[1]!)),
    y1: Math.max(...corners.map((c) => c[1]!)),
  };
}

const overlap = (a: Rect, b: Rect) =>
  Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) *
  Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));

/** Areas that must stay free in front of doorways: the door swing, or a path through an opening. */
function doorZones(f: Floor): Rect[] {
  const zones: Rect[] = [];
  for (const o of f.openings) {
    if (o.kind === "window" || o.kind === "garage-door") continue;
    const horizontal = Math.abs(o.a.x - o.b.x) >= Math.abs(o.a.y - o.b.y);
    const width = Math.hypot(o.b.x - o.a.x, o.b.y - o.a.y);
    const depth = o.kind === "door" ? Math.max(width, 2.5) : 2.5;
    const [lo, hi] = horizontal
      ? [Math.min(o.a.x, o.b.x), Math.max(o.a.x, o.b.x)]
      : [Math.min(o.a.y, o.b.y), Math.max(o.a.y, o.b.y)];
    const at = horizontal ? (o.a.y + o.b.y) / 2 : (o.a.x + o.b.x) / 2;
    // Both sides of the doorway: the swing on one, the path on the other.
    for (const side of [-1, 1]) {
      const d = side * depth;
      zones.push(
        horizontal
          ? { x0: lo + 0.3, x1: hi - 0.3, y0: Math.min(at, at + d), y1: Math.max(at, at + d) }
          : { x0: Math.min(at, at + d), x1: Math.max(at, at + d), y0: lo + 0.3, y1: hi - 0.3 },
      );
    }
  }
  return zones;
}

const SOFT = new Set<ItemKind>(["rug"]);

/** The problem with each piece, by index (pieces without problems are left out). */
function furnitureProblems(f: Floor, items: Item[]): Map<number, string> {
  const problems = new Map<number, string>();
  const zones = doorZones(f);
  const rects = items.map(footprint);
  const name = (i: number) => `${items[i]!.kind} in "${items[i]!.room}" (item ${i + 1})`;
  items.forEach((it, i) => {
    const r = f.rooms.find((room) => room.name === it.room);
    if (!r) return problems.set(i, `${name(i)}: there is no room with that name.`);
    const box = rects[i]!;
    const tol = 0.25;
    const out = [
      r.x - box.x0 > tol && `left by ${(r.x - box.x0).toFixed(1)} ft`,
      box.x1 - (r.x + r.w) > tol && `right by ${(box.x1 - r.x - r.w).toFixed(1)} ft`,
      r.y - box.y0 > tol && `top by ${(r.y - box.y0).toFixed(1)} ft`,
      box.y1 - (r.y + r.d) > tol && `bottom by ${(box.y1 - r.y - r.d).toFixed(1)} ft`,
    ].filter(Boolean);
    if (out.length)
      return problems.set(i, `${name(i)} sticks out of the room on the ${out.join(", ")}.`);
    if (SOFT.has(it.kind) || it.kind === "car" || it.kind === "stairs") return;
    for (let j = 0; j < i; j++) {
      if (SOFT.has(items[j]!.kind) || problems.has(j)) continue;
      if (overlap(box, rects[j]!) > 0.3)
        return problems.set(i, `${name(i)} overlaps the ${name(j)}.`);
    }
    if (zones.some((z) => overlap(box, z) > 0.3))
      return problems.set(i, `${name(i)} blocks a doorway or door swing.`);
  });
  return problems;
}

function toItems(f: Floor, raw: z.infer<typeof FurnishSchema>["items"]): Item[] {
  return raw.flatMap((p) => {
    const r = f.rooms.find((room) => room.name === p.room);
    const c: CatalogEntry = CATALOG[p.kind];
    const clamp = (v: number | null, std: number, lo?: number, hi?: number) =>
      v === null || lo === undefined ? std : Math.min(hi ?? std, Math.max(lo, v));
    const rot = (((Math.round(p.rotation / 90) * 90) % 360) + 360) % 360;
    return [
      {
        kind: p.kind,
        room: p.room,
        x: (r?.x ?? 0) + p.x,
        y: (r?.y ?? 0) + p.y,
        w: clamp(p.w, c.w, c.minW, c.maxW),
        d: clamp(p.d, c.d, c.minD, c.maxD),
        rot,
      },
    ];
  });
}

/** A straight stair filling each stair room, climbing along its long side. */
function stairsOf(f: Floor): Item[] {
  const c = CATALOG.stairs;
  return f.rooms
    .filter((r) => r.kind === "stairs")
    .map((r) => {
      const long = Math.max(r.w, r.d);
      const short = Math.min(r.w, r.d);
      return {
        kind: "stairs" as const,
        room: r.name,
        x: r.x + r.w / 2,
        y: r.y + r.d / 2,
        w: Math.min(c.maxW, Math.max(c.minW, short - 0.6)),
        d: Math.min(c.maxD, long - 0.6),
        rot: r.d >= r.w ? 0 : 90,
      };
    })
    .filter((it) => it.d >= c.minD);
}

async function furnish(f: Floor, style: Style): Promise<{ items: Item[]; dropped: string[] }> {
  const system = FURNISH_SYSTEM.replace("{CATALOG}", catalogText());
  const base = `STYLE: ${style.name}\n\nFLOOR: ${f.name}, ${f.widthFt.toFixed(0)} x ${f.depthFt.toFixed(0)} ft\nROOMS\n${floorText(f)}`;
  const schema = z.toJSONSchema(FurnishSchema);
  const stairs = stairsOf(f);
  let feedback = "";
  // Rooms don't share floor area, so each room keeps its best attempt on its own.
  const best = new Map<string, { good: Item[]; dropped: string[] }>();
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let items: Item[];
    try {
      const raw = await chatJson(system, base + feedback, schema, { model: DESIGN_MODEL });
      items = toItems(f, FurnishSchema.parse(JSON.parse(raw)).items).filter(
        (it) => it.kind !== "stairs",
      );
    } catch (err) {
      feedback = `\n\nYour last answer failed: ${err instanceof Error ? err.message : String(err)}`;
      continue;
    }
    const all = [...stairs, ...items];
    const problems = furnitureProblems(f, all);
    for (const r of f.rooms) {
      const mine = all.map((it, i) => [it, i] as const).filter(([it]) => it.room === r.name);
      const good = mine.filter(([, i]) => !problems.has(i)).map(([it]) => it);
      const dropped = mine.filter(([, i]) => problems.has(i)).map(([, i]) => problems.get(i)!);
      const prev = best.get(r.name);
      if (
        !prev ||
        good.length > prev.good.length ||
        (good.length === prev.good.length && dropped.length < prev.dropped.length)
      )
        best.set(r.name, { good, dropped });
    }
    if (!problems.size) break;
    feedback =
      "\n\nCHECK BEFORE ANSWERING (a draft of this floor had these problems; move or resize those pieces, keep the rest):\n" +
      [...problems.values()].map((p) => `- ${p}`).join("\n");
  }
  // Pieces that still don't fit are left out rather than drawn through walls.
  const kept = [...best.values()];
  const items = kept.flatMap((b) => b.good);
  return { items: items.length ? items : stairs, dropped: kept.flatMap((b) => b.dropped) };
}

// ---------------------------------------------------------------------------
// Steps 4 and 5: pictures and PDF.
// ---------------------------------------------------------------------------

/** `dropped` lists the pieces left out because they never fit. */
export type InteriorFloor = Floor & {
  walls: WallPiece[];
  doors: DoorLeaf[];
  items: Item[];
  dropped: string[];
};
export type Interior = { model: string; createdAt: string; style: Style; floors: InteriorFloor[] };

export type InteriorResult = {
  pdfPath: string;
  images: string[];
  style: Style;
  floors: number;
  seconds: number;
};

const SCENE_JS = join(PROJECT_ROOT, "src", "agents", "interior", "scene.js");
const THREE_DIR = join(PROJECT_ROOT, "node_modules", "three");

/** The picture file for one floor, e.g. interior-A-1.png. */
const imageName = (f: Floor) => `interior-${f.houseType}-${f.level}.png`;

function sceneHtml(
  floor: InteriorFloor,
  style: Style,
  frame: { widthFt: number; depthFt: number },
): string {
  const imports = {
    three: pathToFileURL(join(THREE_DIR, "build", "three.module.js")).href,
    "three/addons/": pathToFileURL(join(THREE_DIR, "examples", "jsm")).href + "/",
  };
  const data = {
    floor,
    style: {
      ...style,
      floorOf: Object.fromEntries(
        floor.rooms.map((r) => [r.name, style.floors[FLOOR_GROUP[r.kind]]]),
      ),
    },
    frame,
    image: IMAGE,
  };
  return `<!doctype html><html><head><meta charset="utf-8">
<style>html,body{margin:0;background:#fff;overflow:hidden}</style>
<script type="importmap">${JSON.stringify({ imports })}</script>
<script>window.SCENE = ${JSON.stringify(data).replace(/</g, "\\u003c")};</script>
</head><body><script type="module" src="${pathToFileURL(SCENE_JS).href}"></script></body></html>`;
}

/** Draw every floor and put the pictures in interior.pdf. */
async function render(
  dir: string,
  interior: Interior,
  onStep: (s: string) => void,
): Promise<string[]> {
  const images: string[] = [];
  for (const [i, floor] of interior.floors.entries()) {
    onStep(
      `Rendering the 3D view of ${floor.name.toLowerCase()} (type ${floor.houseType}), ${i + 1} of ${interior.floors.length}…`,
    );
    // Floors of one house type share a scale, so upper floors line up with the ground floor.
    const same = interior.floors.filter((f) => f.houseType === floor.houseType);
    const frame = {
      widthFt: Math.max(...same.map((f) => f.widthFt)),
      depthFt: Math.max(...same.map((f) => f.depthFt)),
    };
    const html = join(dir, `.interior-${floor.houseType}-${floor.level}.html`);
    await writeFile(html, sceneHtml(floor, interior.style, frame));
    try {
      await screenshotWebGl(html, join(dir, imageName(floor)), IMAGE);
    } finally {
      await rm(html, { force: true });
    }
    // A blank white picture compresses to almost nothing: the scene failed to draw.
    if ((await stat(join(dir, imageName(floor)))).size < 50_000)
      throw new Error(`The 3D view of ${floor.name} came out blank (three.js failed to draw it).`);
    images.push(join(dir, imageName(floor)));
  }

  const pages = interior.floors
    .map((f) => `<div class="p"><img src="${imageName(f)}"></div>`)
    .join("");
  const html = join(dir, ".interior-print.html");
  await writeFile(
    html,
    `<!doctype html><html><head><meta charset="utf-8"><style>
@page{size:letter landscape;margin:0}
html,body{margin:0;background:#fff}
.p{width:11in;height:8.5in;overflow:hidden;break-after:page}
.p:last-child{break-after:auto}
img{display:block;width:100%;height:100%;object-fit:contain}
</style></head><body>${pages}</body></html>`,
  );
  try {
    await printPdf(html, join(dir, "interior.pdf"));
  } finally {
    await rm(html, { force: true });
  }
  return images;
}

async function readJson<T>(path: string): Promise<T | null> {
  return existsSync(path) ? (JSON.parse(await readFile(path, "utf8")) as T) : null;
}

export async function run(
  dir: string,
  onStep: (s: string) => void = () => {},
): Promise<InteriorResult> {
  const started = Date.now();
  const strategy = await loadStrategy(dir);
  const inputs = await readJson<{ listing: Listing }>(join(dir, "inputs.json"));
  if (!strategy || !inputs || !existsSync(join(dir, "plan.svg")))
    throw new Error(
      "This plan folder has no finished design (plan.svg, strategy.json, inputs.json).",
    );
  const feasibility = await readJson<{ houses?: { valuePerHome: number }[] }>(
    join(dir, "feasibility.json"),
  );

  onStep("Reading the floor plans…");
  const svg = await readFile(join(dir, "plan.svg"), "utf8");
  const [floors, style] = await Promise.all([
    readFloors(svg, strategy),
    chooseStyle(inputs.listing, strategy, feasibility?.houses?.[0]?.valuePerHome ?? null),
  ]);

  onStep(
    `Furnishing ${floors.length} ${floors.length === 1 ? "floor" : "floors"} in a ${style.name.toLowerCase()} style…`,
  );
  const furnished = await Promise.all(floors.map((f) => furnish(f, style)));
  const interior: Interior = {
    model: DESIGN_MODEL,
    createdAt: new Date().toISOString(),
    style,
    floors: floors.map((f, i) => ({ ...f, ...buildWalls(f), ...furnished[i]! })),
  };
  await writeFile(join(dir, "interior.json"), JSON.stringify(interior, null, 2));

  const images = await render(dir, interior, onStep);
  return {
    pdfPath: join(dir, "interior.pdf"),
    images,
    style,
    floors: interior.floors.length,
    seconds: Math.round((Date.now() - started) / 1000),
  };
}

/** Make the pictures and PDF again from interior.json, without the model. */
export async function renderInterior(dir: string): Promise<string[] | null> {
  const interior = await readJson<Interior>(join(dir, "interior.json"));
  if (!interior) return null;
  for (const f of interior.floors) Object.assign(f, buildWalls(f));
  return render(dir, interior, () => {});
}
