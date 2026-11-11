import { z } from "zod";
import { chatJson, DESIGN_MODEL } from "./llm.ts";

export const Segment = z.object({
  x1: z.number(),
  y1: z.number(),
  x2: z.number(),
  y2: z.number(),
});
export const Opening = z.object({
  wall: z.number().int(),
  kind: z.enum(["door", "window", "opening"]),
  offset: z.number(),
  width: z.number(),
});
export const Room = z.object({
  name: z.string(),
  x: z.number(),
  y: z.number(),
  w: z.number().optional(),
  h: z.number().optional(),
});
export const Layout = z.object({
  reasoning: z.string(),
  walls: z.array(Segment.extend({ exterior: z.boolean() })),
  openings: z.array(Opening),
  rooms: z.array(Room),
});
export type Segment = z.infer<typeof Segment>;
export type Layout = z.infer<typeof Layout>;
export type Wall = Layout["walls"][number];

const TYPES = [
  "entry",
  "living",
  "dining",
  "kitchen",
  "half-bath",
  "stairs",
  "hall",
  "closet",
  "office",
] as const;
type RoomType = (typeof TYPES)[number];

type TreeNode =
  | { split: "front-back" | "left-right"; at: number; first: TreeNode; second: TreeNode }
  | { room: RoomType; name: string };
const TreeNode: z.ZodType<TreeNode> = z.lazy(() =>
  z.union([
    z.object({
      split: z.enum(["front-back", "left-right"]),
      at: z.number(),
      first: TreeNode,
      second: TreeNode,
    }),
    z.object({ room: z.enum(TYPES), name: z.string() }),
  ]),
);
const Tree = z.object({
  reasoning: z.string().max(500),
  plan: TreeNode,
  open: z.array(z.object({ a: z.string(), b: z.string() })).max(8),
});
type Tree = z.infer<typeof Tree>;

type Answer = {
  reasoning: string;
  splits: {
    area: string;
    direction: "front-back" | "left-right";
    at: number;
    first: string;
    second: string;
  }[];
  rooms: { area: string; type: RoomType; name: string }[];
  open: { a: string; b: string }[];
};

function flatten(t: Tree): Answer {
  const splits: Answer["splits"] = [];
  const rooms: Answer["rooms"] = [];
  const walk = (n: TreeNode, area: string) => {
    if ("split" in n) {
      const [a, b] = n.split === "front-back" ? ["front", "back"] : ["left", "right"];
      const first = `${area} > ${a}`;
      const second = `${area} > ${b}`;
      splits.push({ area, direction: n.split, at: n.at, first, second });
      walk(n.first, first);
      walk(n.second, second);
    } else rooms.push({ area, type: n.room, name: n.name });
  };
  walk(t.plan, "house");
  const areaOf = (name: string) =>
    rooms.find((r) => r.name.trim().toLowerCase() === name.trim().toLowerCase())?.area ?? name;
  return {
    reasoning: t.reasoning,
    splits,
    rooms,
    open: t.open.map((p) => ({ a: areaOf(p.a), b: areaOf(p.b) })),
  };
}

type Rect = { x0: number; y0: number; x1: number; y1: number };
export type PlacedRoom = Rect & { area: string; type: RoomType; name: string };
type Issue = { text: string; weight: number };

export type Plan = {
  layout: Layout;
  rooms: PlacedRoom[];
  issues: Issue[];
  score: number;
  answer: Tree;
};

const RULES: Record<
  RoomType,
  { minSide: number; minSqft: number; maxSqft: number; maxRatio?: number; daylight?: boolean }
> = {
  entry: { minSide: 5, minSqft: 25, maxSqft: 130, maxRatio: 3 },
  living: { minSide: 11, minSqft: 150, maxSqft: 420, maxRatio: 2.2, daylight: true },
  dining: { minSide: 9, minSqft: 80, maxSqft: 260, maxRatio: 2.2, daylight: true },
  kitchen: { minSide: 8, minSqft: 90, maxSqft: 280, maxRatio: 2.5, daylight: true },
  office: { minSide: 8, minSqft: 70, maxSqft: 160, maxRatio: 2, daylight: true },
  "half-bath": { minSide: 4, minSqft: 18, maxSqft: 50, maxRatio: 2.5 },
  stairs: { minSide: 3.5, minSqft: 36, maxSqft: 80 },
  hall: { minSide: 3.5, minSqft: 0, maxSqft: 220 },
  closet: { minSide: 2.5, minSqft: 0, maxSqft: 45 },
};
const REQUIRED: RoomType[] = ["entry", "living", "kitchen", "half-bath", "stairs"];
const PRIVATE: RoomType[] = ["half-bath", "closet", "office"];
const MAX_HALL_SHARE = 0.12;

const room = (type: RoomType, name: string): TreeNode => ({ room: type, name });
const cut = (
  split: "front-back" | "left-right",
  at: number,
  first: TreeNode,
  second: TreeNode,
): TreeNode => ({ split, at, first, second });

const EXAMPLE: Tree = {
  reasoning:
    "Entry and living face the street. Stairs, a short hall, the half bath and a pantry run along the left; dining and kitchen are open to each other and to the living room.",
  plan: cut(
    "front-back",
    14,
    cut("left-right", 8, room("entry", "Entry"), room("living", "Living")),
    cut(
      "left-right",
      8,
      cut(
        "front-back",
        12,
        cut("left-right", 4, room("stairs", "Stairs"), room("hall", "Hall")),
        cut("front-back", 6, room("half-bath", "Half bath"), room("closet", "Pantry")),
      ),
      cut("front-back", 11, room("dining", "Dining"), room("kitchen", "Kitchen")),
    ),
  ),
  open: [
    { a: "Living", b: "Dining" },
    { a: "Dining", b: "Kitchen" },
  ],
};

const HINTS = [
  "Put the entry and stairs on the left side and the living room at the front right.",
  "Put the entry near the middle of the front, with the living room on one side and an office or dining room on the other.",
  "Put the stairs and half bath along the right side and the kitchen across the rear.",
  "Put the living room across the rear facing the yard, with the kitchen and dining toward the front.",
];

function system(w: number, d: number): string {
  return `You are an architect planning the GROUND FLOOR of a two-story house inside a ${w} ft wide x ${d} ft deep rectangle.
The street and front door are at the front. "Left" and "right" are as seen from the street.

Describe the plan as a tree of cuts, the way architects zone a plan:
- "plan" is the whole ${w} x ${d} house. Each node is either a cut or a room.
- A cut node splits its rectangle in two: {"split": ..., "at": ..., "first": node, "second": node}.
  "front-back": a cut parallel to the street. "at" = depth in ft of the FRONT part. first = front part, second = back part.
  "left-right": a cut running front to back. "at" = width in ft of the LEFT part. first = left part, second = right part.
  "at" is measured inside the rectangle being cut. Each part must be at least 3 ft.
- A room node is {"room": type, "name": label}. Every cut becomes a wall.
- Keep cutting until every room has its own rectangle. A typical ground floor has 7 to 9 rooms.
- "open" lists pairs of room names with no door between them, for open-plan living, dining and kitchen.
  Code adds the doors, archways, windows and front door.

Room types and good sizes (width x depth):
- entry: 6-9 ft wide, 25-130 sq ft, must touch the front.
- living: at least 11 ft each way, 150-420 sq ft, on an outside wall.
- dining: at least 9 ft each way, 80-260 sq ft, on an outside wall.
- kitchen: at least 8 ft each way, 90-280 sq ft, on an outside wall, next to dining.
- half-bath: about 5 x 6 ft (18-50 sq ft), next to a hall or the entry.
- stairs: about 4 x 12 ft (the long side at least 10 ft), next to the entry or a hall.
- hall: 3.5-4 ft wide, only as much as needed (under ${Math.round(MAX_HALL_SHARE * 100)}% of the floor).
- closet (pantry or coat closet) and office are optional.
Keep main rooms close to square: the long side at most about twice the short side.

Example for a 30 x 37 ft house. Use it as a pattern for the format, not as the answer:
${JSON.stringify(EXAMPLE)}`;
}

const fmt = (n: number) => (Number.isInteger(n) ? `${n}` : n.toFixed(1));
const width = (r: Rect) => r.x1 - r.x0;
const depth = (r: Rect) => r.y1 - r.y0;
const dims = (r: Rect) => `${fmt(width(r))} x ${fmt(depth(r))} ft`;
const sqft = (r: Rect) => Math.round(width(r) * depth(r));
const segLength = (s: Segment) => Math.hypot(s.x2 - s.x1, s.y2 - s.y1);

function place(
  a: Answer,
  w: number,
  d: number,
): { rooms: PlacedRoom[]; cuts: Segment[]; errors: string[] } {
  const errors: string[] = [];
  const splits = new Map<string, Answer["splits"][number]>();
  for (const s of a.splits) {
    if (splits.has(s.area)) errors.push(`Area "${s.area}" is split twice; split it once.`);
    splits.set(s.area, s);
  }
  const assigned = new Map<string, Answer["rooms"][number]>();
  for (const r of a.rooms) {
    if (assigned.has(r.area)) errors.push(`Area "${r.area}" has two rooms; give it one.`);
    assigned.set(r.area, r);
  }
  const rooms: PlacedRoom[] = [];
  const cuts: Segment[] = [];
  const seen = new Set<string>();
  const visit = (area: string, r: Rect) => {
    if (seen.has(area)) {
      errors.push(`The name "${area}" is used for two parts; every part needs its own name.`);
      return;
    }
    seen.add(area);
    const s = splits.get(area);
    const room = assigned.get(area);
    if (s && room)
      errors.push(
        `Area "${area}" is both split and given a room; rooms go only on parts that are not split.`,
      );
    if (s) {
      const along = s.direction === "front-back" ? depth(r) : width(r);
      const start = s.direction === "front-back" ? r.y0 : r.x0;
      let at = s.at;
      if ((at < 3 || at > along - 3) && at - start >= 3 && at - start <= along - 3) at -= start;
      const what =
        s.direction === "front-back"
          ? `${fmt(along)} ft deep (front to back)`
          : `${fmt(along)} ft wide (left to right)`;
      if (along < 6) {
        errors.push(`"${area}" is only ${what}, too small to cut in two; make it a single room.`);
        return;
      }
      at = Math.min(Math.max(at, 3), along - 3);
      if (s.direction === "front-back") {
        const y = r.y0 + at;
        cuts.push({ x1: r.x0, y1: y, x2: r.x1, y2: y });
        visit(s.first, { ...r, y1: y });
        visit(s.second, { ...r, y0: y });
      } else {
        const x = r.x0 + at;
        cuts.push({ x1: x, y1: r.y0, x2: x, y2: r.y1 });
        visit(s.first, { ...r, x1: x });
        visit(s.second, { ...r, x0: x });
      }
    } else if (room) {
      rooms.push({ ...r, area, type: room.type, name: room.name.trim() || room.type });
    } else {
      errors.push(`Part "${area}" (${dims(r)}) is not split and has no room; give it a room.`);
    }
  };
  visit("house", { x0: 0, y0: 0, x1: w, y1: d });
  for (const k of splits.keys())
    if (!seen.has(k))
      errors.push(
        `"${k}" is split but is not a part of "house" or of another split; use names created by earlier splits.`,
      );
  for (const k of assigned.keys())
    if (!seen.has(k))
      errors.push(`Room area "${k}" is not a part created by any split; use the split part names.`);
  if (!errors.length)
    for (const t of REQUIRED) {
      if (rooms.some((r) => r.type === t)) continue;
      const host = [...rooms].sort((p, q) => sqft(q) - sqft(p))[0];
      const size = t === "half-bath" ? "about 5 x 6 ft" : t === "stairs" ? "about 4 x 12 ft" : "";
      errors.push(
        host
          ? `Add a room of type "${t}"${size ? ` (${size})` : ""}: for example, replace the room "${host.name}" (${dims(host)}) with a cut node whose two parts are "${host.name}" and the new ${t}.`
          : `Add a room of type "${t}".`,
      );
    }
  return { rooms, cuts, errors };
}

function shared(a: Rect, b: Rect): Segment | undefined {
  const e = 1e-6;
  for (const [x, ok] of [
    [a.x1, Math.abs(a.x1 - b.x0) < e],
    [a.x0, Math.abs(a.x0 - b.x1) < e],
  ] as const) {
    const y0 = Math.max(a.y0, b.y0);
    const y1 = Math.min(a.y1, b.y1);
    if (ok && y1 - y0 > e) return { x1: x, y1: y0, x2: x, y2: y1 };
  }
  for (const [y, ok] of [
    [a.y1, Math.abs(a.y1 - b.y0) < e],
    [a.y0, Math.abs(a.y0 - b.y1) < e],
  ] as const) {
    const x0 = Math.max(a.x0, b.x0);
    const x1 = Math.min(a.x1, b.x1);
    if (ok && x1 - x0 > e) return { x1: x0, y1: y, x2: x1, y2: y };
  }
  return undefined;
}

function contains(w: Segment, x: number, y: number): boolean {
  const e = 1e-6;
  const cross = (w.x2 - w.x1) * (y - w.y1) - (w.y2 - w.y1) * (x - w.x1);
  return (
    Math.abs(cross) < e &&
    x >= Math.min(w.x1, w.x2) - e &&
    x <= Math.max(w.x1, w.x2) + e &&
    y >= Math.min(w.y1, w.y2) - e &&
    y <= Math.max(w.y1, w.y2) + e
  );
}

function addOn(
  walls: Wall[],
  openings: Layout["openings"],
  seg: Segment,
  kind: Layout["openings"][number]["kind"],
  size: number,
  at = 0.5,
): void {
  const i = walls.findIndex((w) => contains(w, seg.x1, seg.y1) && contains(w, seg.x2, seg.y2));
  const w = walls[i];
  if (!w) return;
  const n = segLength(w);
  const ux = (w.x2 - w.x1) / n;
  const uy = (w.y2 - w.y1) / n;
  const t1 = (seg.x1 - w.x1) * ux + (seg.y1 - w.y1) * uy;
  const t2 = (seg.x2 - w.x1) * ux + (seg.y2 - w.y1) * uy;
  const lo = Math.min(t1, t2);
  const len = Math.abs(t2 - t1);
  const offset = Math.min(Math.max(lo + len * at - size / 2, lo + 1), lo + len - 1 - size);
  openings.push({ wall: i, kind, offset: Math.round(offset * 4) / 4, width: size });
}

function exteriorEdges(r: Rect, w: number, d: number): { side: string; seg: Segment }[] {
  const out: { side: string; seg: Segment }[] = [];
  if (r.y0 === 0) out.push({ side: "front", seg: { x1: r.x0, y1: 0, x2: r.x1, y2: 0 } });
  if (r.x1 === w) out.push({ side: "right", seg: { x1: w, y1: r.y0, x2: w, y2: r.y1 } });
  if (r.y1 === d) out.push({ side: "rear", seg: { x1: r.x0, y1: d, x2: r.x1, y2: d } });
  if (r.x0 === 0) out.push({ side: "left", seg: { x1: 0, y1: r.y0, x2: 0, y2: r.y1 } });
  return out;
}

function build(tree: Tree, w: number, d: number): Plan | { errors: string[] } {
  const a = flatten(tree);
  const { rooms, cuts, errors } = place(a, w, d);
  if (errors.length) return { errors };

  const walls: Wall[] = [
    { x1: 0, y1: 0, x2: w, y2: 0, exterior: true },
    { x1: w, y1: 0, x2: w, y2: d, exterior: true },
    { x1: w, y1: d, x2: 0, y2: d, exterior: true },
    { x1: 0, y1: d, x2: 0, y2: 0, exterior: true },
    ...cuts.map((c) => ({ ...c, exterior: false })),
  ];
  const openings: Layout["openings"] = [];
  const issues: Issue[] = [];
  const hard: string[] = [];
  const byArea = new Map(rooms.map((r) => [r.area, r]));
  const isPrivate = (r: PlacedRoom) => PRIVATE.includes(r.type);

  const group = new Map(rooms.map((r) => [r, r]));
  const root = (r: PlacedRoom): PlacedRoom => {
    let p = r;
    while (group.get(p) !== p) p = group.get(p)!;
    return p;
  };
  for (const pair of a.open) {
    const ra = byArea.get(pair.a);
    const rb = byArea.get(pair.b);
    if (!ra || !rb) {
      issues.push({
        text: `"open" pair "${pair.a}" / "${pair.b}" uses a name that is not a room name.`,
        weight: 1,
      });
      continue;
    }
    if (isPrivate(ra) || isPrivate(rb)) {
      issues.push({
        text: `"${ra.name}" and "${rb.name}" are marked open, but a ${isPrivate(ra) ? ra.type : rb.type} needs a door; remove that pair.`,
        weight: 2,
      });
      continue;
    }
    const s = shared(ra, rb);
    if (!s || segLength(s) < 4) {
      issues.push({
        text: `"${ra.name}" and "${rb.name}" are marked open but share ${s ? `only ${fmt(segLength(s))} ft of` : "no"} wall.`,
        weight: 1,
      });
      continue;
    }
    addOn(walls, openings, s, "opening", Math.min(segLength(s) - 2, 12));
    group.set(root(ra), root(rb));
  }

  const entry = rooms.find((r) => r.type === "entry")!;
  const front = exteriorEdges(entry, w, d).find((e) => e.side === "front");
  if (!front)
    hard.push(
      `The entry (${dims(entry)}) must touch the front; put it in a front part of the house.`,
    );
  else if (segLength(front.seg) < 5)
    hard.push(
      `The entry's front wall is ${fmt(segLength(front.seg))} ft; it needs at least 5 ft for the front door.`,
    );
  else addOn(walls, openings, front.seg, "door", 3);

  const reached = new Set(rooms.filter((r) => root(r) === root(entry)));
  const doorFrom = new Map<PlacedRoom, PlacedRoom>();
  const cost = (u: PlacedRoom, v: PlacedRoom) => {
    if (isPrivate(v)) {
      const order: Partial<Record<RoomType, number>> = { hall: 0, entry: 1, living: 2, stairs: 2 };
      if (v.type === "closet" && u.type === "kitchen") return 1;
      return order[u.type] ?? 5;
    }
    return u.type === "hall" || u.type === "entry"
      ? 0
      : u.type === "living" || u.type === "stairs"
        ? 1
        : 2;
  };
  for (;;) {
    let best: { u: PlacedRoom; v: PlacedRoom; s: Segment; c: number } | undefined;
    for (const u of reached) {
      if (isPrivate(u)) continue;
      for (const v of rooms) {
        if (reached.has(v)) continue;
        const s = shared(u, v);
        if (!s || segLength(s) < 3.5) continue;
        const c = cost(u, v);
        if (!best || c < best.c) best = { u, v, s, c };
      }
    }
    if (!best) break;
    const { u, v, s } = best;
    const len = segLength(s);
    if (isPrivate(v)) addOn(walls, openings, s, "door", v.type === "office" ? 3 : 2.5);
    else addOn(walls, openings, s, "opening", Math.min(len - 1.5, 5));
    doorFrom.set(v, u);
    for (const r of rooms) if (root(r) === root(v)) reached.add(r);
  }
  for (const r of rooms)
    if (!reached.has(r))
      hard.push(
        `"${r.name}" (${dims(r)}) cannot be reached: it shares no 3.5 ft stretch of wall with a room connected to the entry (closets, baths and offices do not lead anywhere).`,
      );

  for (const r of rooms) {
    const rule = RULES[r.type];
    for (const e of exteriorEdges(r, w, d)) {
      const len = segLength(e.seg);
      if (r.type === "entry" && e.side === "front") continue;
      if (r.type === "half-bath" && len >= 4) addOn(walls, openings, e.seg, "window", 2);
      if (!rule.daylight || len < 4) continue;
      const n = len >= 15 ? 2 : 1;
      const size = Math.min(5, Math.max(3, Math.floor((len * 0.6) / n)), len / n - 2);
      if (size < 2) continue;
      for (let k = 0; k < n; k++) addOn(walls, openings, e.seg, "window", size, (k + 0.5) / n);
    }
    if (rule.daylight && !exteriorEdges(r, w, d).some((e) => segLength(e.seg) >= 4))
      issues.push({
        text: `"${r.name}" has no outside wall for windows; move it to an outside wall.`,
        weight: 2,
      });
  }

  for (const r of rooms) {
    const rule = RULES[r.type];
    const short = Math.min(width(r), depth(r));
    const long = Math.max(width(r), depth(r));
    const area = sqft(r);
    const label = `"${r.name}" is ${dims(r)} (${area} sq ft)`;
    if (short < rule.minSide)
      issues.push({
        text: `${label}; its narrow side must be at least ${rule.minSide} ft.`,
        weight: 3,
      });
    if (area < rule.minSqft)
      issues.push({
        text: `${label}; a ${r.type} needs at least ${rule.minSqft} sq ft.`,
        weight: 2,
      });
    if (area > rule.maxSqft)
      issues.push({
        text: `${label}; a ${r.type} should be at most ${rule.maxSqft} sq ft. Cut it again and use the rest for another room (hall, closet, office or a different room).`,
        weight: 2,
      });
    if (rule.maxRatio && long / short > rule.maxRatio)
      issues.push({
        text: `${label}, too long and narrow; keep the long side under ${rule.maxRatio} times the short side.`,
        weight: 2,
      });
    if (r.type === "stairs" && long < 10)
      issues.push({
        text: `${label}; a straight stair needs a run of at least 10 ft (about 4 x 12).`,
        weight: 3,
      });
  }

  const halls = rooms.filter((r) => r.type === "hall").reduce((s, r) => s + sqft(r), 0);
  if (halls > MAX_HALL_SHARE * w * d)
    issues.push({
      text: `Halls take ${halls} sq ft (${Math.round((halls / (w * d)) * 100)}% of the floor); keep them under ${Math.round(MAX_HALL_SHARE * 100)}%.`,
      weight: 2,
    });
  const touching = (t1: RoomType, t2: RoomType[], min = 3) =>
    rooms
      .filter((r) => r.type === t1)
      .every((r) =>
        rooms.some(
          (o) =>
            t2.includes(o.type) && segLength(shared(r, o) ?? { x1: 0, y1: 0, x2: 0, y2: 0 }) >= min,
        ),
      );
  if (!rooms.some((r) => r.type === "dining"))
    issues.push({ text: `Add a dining room (type "dining").`, weight: 2 });
  else if (!touching("kitchen", ["dining"]))
    issues.push({ text: `The kitchen should share a wall with the dining room.`, weight: 2 });
  if (!touching("stairs", ["entry", "hall", "living"]))
    issues.push({
      text: `The stairs should be next to the entry, a hall or the living room.`,
      weight: 2,
    });
  if (!touching("entry", ["living", "hall"], 3.5))
    issues.push({ text: `The entry should open to the living room or a hall.`, weight: 1 });
  for (const [v, u] of doorFrom)
    if (v.type === "half-bath" && (u.type === "kitchen" || u.type === "dining"))
      issues.push({
        text: `"${v.name}" can only be entered from the ${u.type}; put it next to a hall or the entry.`,
        weight: 2,
      });

  if (hard.length) return { errors: hard };
  const layout: Layout = {
    reasoning: a.reasoning,
    walls,
    openings,
    rooms: rooms.map((r) => ({
      name: r.name,
      x: (r.x0 + r.x1) / 2,
      y: (r.y0 + r.y1) / 2,
      w: width(r),
      h: depth(r),
    })),
  };
  return { layout, rooms, issues, score: issues.reduce((s, i) => s + i.weight, 0), answer: tree };
}

export function examplePlan(): Plan {
  const result = build(EXAMPLE, 30, 37);
  if ("errors" in result) throw new Error(result.errors.join("\n"));
  return result;
}

function roomList(rooms: PlacedRoom[]): string {
  return rooms
    .map((r) => `- ${r.name} (area "${r.area}"): ${dims(r)} = ${sqft(r)} sq ft`)
    .join("\n");
}

export type PlanOptions = {
  width: number;
  depth: number;
  candidates?: number;
  attempts?: number;
  log?: (line: string) => void;
};

export async function planFloor(opts: PlanOptions): Promise<Plan> {
  const { width: w, depth: d, candidates = 4, attempts = 3, log = console.log } = opts;
  const schema = z.toJSONSchema(Tree);
  const sys = system(w, d);
  let best: Plan | undefined;
  for (let c = 0; c < candidates; c++) {
    const task = `Plan the ground floor. ${HINTS[c % HINTS.length]}`;
    let user = task;
    let mine: Plan | undefined;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const started = Date.now();
      let answer: Tree;
      try {
        answer = Tree.parse(
          JSON.parse(
            await chatJson(sys, user, schema, {
              model: DESIGN_MODEL,
              numPredict: 3000,
              temperature: 0.6,
            }),
          ),
        );
      } catch (err) {
        log(
          `  candidate ${c + 1}.${attempt}: no usable answer (${(err as Error).message.slice(0, 80)})`,
        );
        user = task;
        continue;
      }
      const secs = Math.round((Date.now() - started) / 1000);
      const result = build(answer, w, d);
      let problems: string[];
      let rooms = "";
      if ("errors" in result) {
        problems = result.errors;
        log(`  candidate ${c + 1}.${attempt}: invalid, ${problems.length} problems (${secs}s)`);
      } else {
        if (!mine || result.score < mine.score) mine = result;
        problems = result.issues.map((i) => i.text);
        rooms = `This plan produced these rooms:\n${roomList(result.rooms)}\n\n`;
        log(`  candidate ${c + 1}.${attempt}: valid, score ${result.score} (${secs}s)`);
        if (result.score === 0) break;
      }
      for (const p of problems) log(`      - ${p}`);
      user = `${task}\n\nCHECK BEFORE ANSWERING. Write the reasoning about the house itself, without mentioning earlier answers or these checks.\n${rooms}Problems to fix:\n- ${problems.join("\n- ")}\n\nPlan to fix:\n${JSON.stringify({ ...answer, reasoning: undefined })}`;
    }
    if (mine && (!best || mine.score < best.score)) best = mine;
  }
  if (!best) throw new Error(`No valid floor plan from ${candidates} candidates.`);
  return best;
}
