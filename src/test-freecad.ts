import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { examplePlan, Layout, planFloor, type Wall } from "./floorPlanner.ts";
import { DESIGN_MODEL } from "./llm.ts";

const FREECAD =
  process.env.FREECAD_CMD || "/Applications/FreeCAD.app/Contents/Resources/bin/freecadcmd";
const CHROME =
  process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const W = 30;
const D = 37;

function wallLength(w: Wall): number {
  return Math.hypot(w.x2 - w.x1, w.y2 - w.y1);
}

function freecadScript(layout: Layout, out: string): string {
  return `
import json, math
import FreeCAD as App, Part, Arch, Draft
from importers import importIFC

L = json.loads(r'''${JSON.stringify(layout)}''')
OUT = r'''${out}'''
FT = 304.8
H = 9 * FT
CUT = 4 * FT

doc = App.newDocument("House")
def thick(w):
    return (0.5 if w["exterior"] else 0.375) * FT

def host_half(w, x, y):
    for o in L["walls"]:
        if o is w:
            continue
        on_x = min(o["x1"], o["x2"]) - 1e-6 <= x <= max(o["x1"], o["x2"]) + 1e-6
        on_y = min(o["y1"], o["y2"]) - 1e-6 <= y <= max(o["y1"], o["y2"]) + 1e-6
        if on_x and on_y:
            return thick(o) / 2
    return 0

walls = []
for w in L["walls"]:
    t = thick(w)
    a = App.Vector(w["x1"]*FT, w["y1"]*FT, 0)
    b = App.Vector(w["x2"]*FT, w["y2"]*FT, 0)
    u = (b - a).normalize()
    line = Draft.make_line(a - u * host_half(w, w["x1"], w["y1"]), b + u * host_half(w, w["x2"], w["y2"]))
    wall = Arch.makeWall(line, width=t, height=H, align="Center")
    wall.Label = ("Exterior" if w["exterior"] else "Interior") + " wall"
    walls.append(wall)
doc.recompute()

openings = []
for o in L["openings"]:
    w, wall = L["walls"][o["wall"]], walls[o["wall"]]
    dx, dy = w["x2"] - w["x1"], w["y2"] - w["y1"]
    n = math.hypot(dx, dy)
    door = o["kind"] == "door"
    sill = 3 * FT if o["kind"] == "window" else 0
    height = 4 * FT if o["kind"] == "window" else 6.8 * FT
    width = o["width"] * FT
    t = wall.Width.Value
    turn = App.Rotation(App.Vector(0, 0, 1), math.degrees(math.atan2(dy, dx)))
    pos = App.Vector((w["x1"] + dx/n*o["offset"])*FT, (w["y1"] + dy/n*o["offset"])*FT, sill)
    if o["kind"] == "opening":
        box = doc.addObject("Part::Box", "Opening")
        box.Length, box.Width, box.Height = width, 3 * t, 7 * FT
        box.Placement = App.Placement(pos + turn.multVec(App.Vector(0, -1.5 * t, 0)), turn)
        Arch.removeComponents([box], wall)
        continue
    rot = turn.multiply(App.Rotation(App.Vector(1, 0, 0), 90))
    pos = pos + rot.multVec(App.Vector(0, 0, -t/2))
    win = Arch.makeWindowPreset("Simple door" if door else "Fixed",
        width=width, height=height, h1=50, h2=50, h3=50, w1=t, w2=40, o1=0, o2=t/2,
        placement=App.Placement(pos, rot))
    win.Label = o["kind"].capitalize()
    win.Hosts = [wall]
    openings.append(win)
doc.recompute()

site = Arch.makeFloor(walls + openings, name="Ground floor")
doc.recompute()
for obj in doc.Objects:
    if obj.TypeId in ("Sketcher::SketchObject", "Part::Box") or obj.Name.startswith("Line"):
        obj.Visibility = False
doc.saveAs(OUT + "/house.FCStd")
importIFC.export([site], OUT + "/house.ifc")

solid = walls[0].Shape
for wall in walls[1:]:
    solid = solid.fuse(wall.Shape)
solid = solid.removeSplitter()
cut = solid.common(Part.makeBox(1e6, 1e6, CUT, App.Vector(-5e5, -5e5, 0)))
paths = []
for face in cut.Faces:
    if abs(face.normalAt(0, 0).z - 1) < 1e-6 and abs(face.CenterOfMass.z - CUT) < 1:
        for wire in face.Wires:
            paths.append([[v.Point.x / FT, v.Point.y / FT] for v in wire.OrderedVertexes])
with open(OUT + "/plan-cut.json", "w") as f:
    json.dump({"paths": paths, "openings": [[o.Label] for o in openings]}, f)
print("FREECAD_OK", len(walls), "walls", len(openings), "openings", len(paths), "outlines")
`;
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
}

function planSvg(paths: number[][][], layout: Layout): string {
  const pad = 5;
  const fy = (y: number) => (D - y).toFixed(2);
  const d = paths
    .map((p) => "M " + p.map(([x, y]) => `${x!.toFixed(2)},${fy(y!)}`).join(" L ") + " Z")
    .join(" ");
  const swings = layout.openings
    .filter((o) => o.kind === "door")
    .map((o) => {
      const w = layout.walls[o.wall]!;
      const n = wallLength(w);
      const ux = (w.x2 - w.x1) / n;
      const uy = (w.y2 - w.y1) / n;
      const x0 = w.x1 + ux * o.offset;
      const y0 = w.y1 + uy * o.offset;
      const x1 = x0 + ux * o.width;
      const y1 = y0 + uy * o.width;
      const px = x0 - uy * o.width;
      const py = y0 + ux * o.width;
      return `<path d="M ${x0},${fy(y0)} L ${px},${fy(py)} A ${o.width} ${o.width} 0 0 1 ${x1},${fy(y1)}" class="swing"/>`;
    })
    .join("");
  const windows = layout.openings
    .filter((o) => o.kind === "window")
    .map((o) => {
      const w = layout.walls[o.wall]!;
      const n = wallLength(w);
      const ux = (w.x2 - w.x1) / n;
      const uy = (w.y2 - w.y1) / n;
      const x0 = w.x1 + ux * o.offset;
      const y0 = w.y1 + uy * o.offset;
      return `<line x1="${x0}" y1="${fy(y0)}" x2="${x0 + ux * o.width}" y2="${fy(y0 + uy * o.width)}" class="glass"/>`;
    })
    .join("");
  const labels = layout.rooms
    .map((r) => {
      const name = esc(r.name.toUpperCase());
      if (r.w === undefined || r.h === undefined)
        return `<text x="${r.x}" y="${fy(r.y)}" class="room">${name}</text>`;
      const size = Math.min(0.75, (r.w - 0.8) / (r.name.length * 0.68));
      const y = D - r.y;
      return `<text x="${r.x}" y="${y.toFixed(2)}" class="room" style="font-size:${size.toFixed(2)}px">${name}</text><text x="${r.x}" y="${(y + Math.max(size, 0.5) * 1.3).toFixed(2)}" class="size" style="font-size:${Math.min(0.6, size).toFixed(2)}px">${r.w}' x ${r.h}'</text>`;
    })
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-pad} ${-pad} ${W + 2 * pad} ${D + 2 * pad}">
  <style>
    .wall{fill:#1d2433;fill-rule:evenodd}
    .swing{fill:none;stroke:#5b6b85;stroke-width:0.06}
    .glass{stroke:#3d8bfd;stroke-width:0.18}
    .room{font:600 0.75px system-ui,sans-serif;fill:#334;text-anchor:middle;letter-spacing:0.03px}
    .size{font:0.6px system-ui,sans-serif;fill:#778;text-anchor:middle}
    .dim{stroke:#889;stroke-width:0.05}
    .dimt{font:0.9px system-ui,sans-serif;fill:#556;text-anchor:middle}
  </style>
  <path d="${d}" class="wall"/>
  ${windows}
  ${swings}
  ${labels}
  <line x1="0" y1="${D + 2}" x2="${W}" y2="${D + 2}" class="dim"/>
  <text x="${W / 2}" y="${D + 3.3}" class="dimt">${W}' - 0"</text>
  <line x1="-2" y1="0" x2="-2" y2="${D}" class="dim"/>
  <text x="-3" y="${D / 2}" class="dimt" transform="rotate(-90 -3 ${D / 2})">${D}' - 0"</text>
  <text x="${W / 2}" y="${-2}" class="dimt">REAR</text>
  <text x="${W / 2}" y="${D + 4.6}" class="dimt">FRONT (STREET)</text>
</svg>`;
}

function pageHtml(svg: string, layout: Layout, notes: string[]): string {
  const schedule = layout.rooms
    .map(
      (r) =>
        `<tr><td>${esc(r.name)}</td><td>${r.w !== undefined && r.h !== undefined ? `${r.w}' x ${r.h}'</td><td>${Math.round(r.w * r.h)} sq ft` : "</td><td>"}</td></tr>`,
    )
    .join("");
  const remarks = notes.length
    ? `<h2>Open design issues</h2><ul>${notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>`
    : "";
  return `<!doctype html><html><head><meta charset="utf-8"><title>Ground floor plan</title>
<style>
  @page{size:letter;margin:0.5in}
  body{font-family:system-ui,sans-serif;color:#1d2433;margin:24px auto;max-width:900px}
  header{border-bottom:3px solid #1d2433;padding-bottom:8px;margin-bottom:12px}
  h1{font-size:20px;margin:0} .sub{color:#667;font-size:12px;margin-top:4px}
  svg{width:100%;max-height:6.6in;display:block}
  table{border-collapse:collapse;font-size:11px;margin-top:6px;white-space:nowrap;flex:none}
  td{padding:2px 14px 2px 0;border-bottom:1px solid #e3e6ec} td:last-child{text-align:right}
  .bottom{display:flex;gap:32px;align-items:flex-start}
  .reason{font-size:11px;color:#556;max-width:420px;margin-top:6px}
  h2{font-size:12px;margin:8px 0 2px} ul{font-size:11px;color:#8a4b00;margin:0;padding-left:16px}
  @media print{body{margin:0}}
</style></head><body>
<header><h1>Type A &mdash; Ground floor plan</h1>
<div class="sub">${W}' x ${D}' footprint (${W * D} sq ft) &middot; drawn by ${esc(DESIGN_MODEL)}, modeled in FreeCAD &middot; ${new Date().toLocaleDateString()}</div></header>
${svg}
<div class="bottom"><table>${schedule}</table>
<div><div class="reason">${esc(layout.reasoning)}</div>${remarks}</div></div>
</body></html>`;
}

const out = resolve(
  "output",
  `freecad-test-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}`,
);
mkdirSync(out, { recursive: true });

const fixture = process.argv[2];
let layout: Layout;
let notes: string[] = [];
if (fixture === "example") {
  const plan = examplePlan();
  console.log(`Using the prompt's example plan (score ${plan.score})`);
  layout = plan.layout;
  notes = plan.issues.map((i) => i.text);
} else if (fixture) {
  layout = Layout.parse(JSON.parse(readFileSync(fixture, "utf8")));
  console.log(`Using layout from ${fixture}`);
} else {
  const candidates = Number(process.env.CANDIDATES) || 4;
  console.log(`Asking ${DESIGN_MODEL} for ${candidates} candidate plans...`);
  const plan = await planFloor({ width: W, depth: D, candidates });
  console.log(`Best plan: score ${plan.score} (0 = no design issues)`);
  layout = plan.layout;
  notes = plan.issues.map((i) => i.text);
  writeFileSync(join(out, "plan.json"), JSON.stringify(plan.answer, null, 2));
}
writeFileSync(join(out, "layout.json"), JSON.stringify(layout, null, 2));

console.log("Building the model in FreeCAD...");
writeFileSync(join(out, "build.py"), freecadScript(layout, out));
try {
  const log = execFileSync(FREECAD, [join(out, "build.py")], {
    encoding: "utf8",
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  console.log(`  ${/FREECAD_OK[^\r\n]*/.exec(log)?.[0] ?? "done"}`);
} catch (err) {
  const e = err as { stdout?: string; stderr?: string };
  writeFileSync(join(out, "freecad.log"), `${e.stdout ?? ""}\n${e.stderr ?? ""}`);
  throw new Error(`FreeCAD failed; see ${join(out, "freecad.log")}`, {
    cause: err,
  });
}

const cut = JSON.parse(readFileSync(join(out, "plan-cut.json"), "utf8")) as {
  paths: number[][][];
};
const html = join(out, "plan.html");
writeFileSync(html, pageHtml(planSvg(cut.paths, layout), layout, notes));

console.log("Printing the PDF...");
execFileSync(
  CHROME,
  [
    "--headless",
    "--disable-gpu",
    "--no-pdf-header-footer",
    `--print-to-pdf=${join(out, "plan.pdf")}`,
    pathToFileURL(html).href,
  ],
  { stdio: "ignore" },
);

console.log(`Done: ${out}\n  plan.pdf, plan.html, house.FCStd, house.ifc, layout.json`);
