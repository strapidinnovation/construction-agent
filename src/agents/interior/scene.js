/* global window, document, console */
/**
 * Draws one furnished floor in three.js, seen from above with the roof off.
 * Runs inside headless Chrome; interiorDesigner.ts writes the page that loads
 * it, with the floor, furniture and style in window.SCENE.
 *
 * Units are feet. The plan's x is three.js X and the plan's y (down the
 * drawing) is three.js Z, so the camera looks straight down with -Z at the
 * top of the picture. Furniture is built facing +Z with its back at -Z.
 */
import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { GTAOPass } from "three/addons/postprocessing/GTAOPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";

const { floor, style, frame, image } = window.SCENE;
/** Walls are cut at this height so the rooms show. */
const WALL_H = 4.2;
const SILL = 2.4;
const SLAB = 0.45;

// --- small helpers -----------------------------------------------------------

let seed = 1234567;
const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const jitter = (amount) => (rand() - 0.5) * 2 * amount;

function tint(hex, light = 0, sat = 0) {
  const c = new THREE.Color(hex);
  const hsl = {};
  c.getHSL(hsl);
  c.setHSL(hsl.h, Math.min(1, Math.max(0, hsl.s + sat)), Math.min(1, Math.max(0, hsl.l + light)));
  return `#${c.getHexString()}`;
}

function canvasTexture(px, draw) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = px;
  draw(canvas.getContext("2d"), px);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

function noise(ctx, px, count, size, color, alpha) {
  ctx.fillStyle = color;
  for (let i = 0; i < count; i++) {
    ctx.globalAlpha = alpha * rand();
    const s = size * (0.5 + rand());
    ctx.fillRect(rand() * px, rand() * px, s, s);
  }
  ctx.globalAlpha = 1;
}

// --- textures (each covers `ft` feet of floor) --------------------------------

function planks(base) {
  const ft = 8;
  return {
    ft,
    map: canvasTexture(1024, (ctx, px) => {
      const per = px / ft;
      const width = 0.6 * per;
      for (let x = 0; x < px; x += width) {
        let y = -rand() * 5 * per;
        while (y < px) {
          const len = (3 + rand() * 4) * per;
          ctx.fillStyle = tint(base, jitter(0.05), jitter(0.04));
          ctx.fillRect(x, y, width, len);
          ctx.globalAlpha = 0.12;
          for (let g = 0; g < 7; g++) {
            ctx.strokeStyle = tint(base, -0.15 + jitter(0.05));
            ctx.lineWidth = 0.5 + rand();
            const gx = x + rand() * width;
            ctx.beginPath();
            ctx.moveTo(gx, y);
            ctx.bezierCurveTo(
              gx + jitter(4),
              y + len / 3,
              gx + jitter(4),
              y + (2 * len) / 3,
              gx + jitter(3),
              y + len,
            );
            ctx.stroke();
          }
          ctx.globalAlpha = 0.35;
          ctx.fillStyle = tint(base, -0.25);
          ctx.fillRect(x, y, width, 1.5);
          ctx.globalAlpha = 1;
          y += len;
        }
        ctx.globalAlpha = 0.4;
        ctx.fillStyle = tint(base, -0.25);
        ctx.fillRect(x, 0, 1.5, px);
        ctx.globalAlpha = 1;
      }
    }),
  };
}

function marbleVeins(ctx, px, color, count) {
  for (let i = 0; i < count; i++) {
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.08 + rand() * 0.22;
    ctx.lineWidth = 0.6 + rand() * 2.2;
    let x = rand() * px;
    let y = rand() * px;
    ctx.beginPath();
    ctx.moveTo(x, y);
    for (let s = 0; s < 8; s++) {
      const nx = x + jitter(px / 5) + px / 10;
      const ny = y + jitter(px / 5);
      ctx.quadraticCurveTo(x + jitter(px / 8), y + jitter(px / 8), nx, ny);
      x = nx;
      y = ny;
    }
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

function tiles(base, tileFt, grout, { veins = null, speckle = 0, vary = 0.03, hex = false } = {}) {
  const n = Math.max(1, Math.round(8 / tileFt));
  const ft = n * tileFt;
  return {
    ft,
    map: canvasTexture(1024, (ctx, px) => {
      const t = px / n;
      ctx.fillStyle = grout;
      ctx.fillRect(0, 0, px, px);
      for (let i = 0; i < n; i++)
        for (let j = 0; j < n; j++) {
          ctx.fillStyle = tint(base, jitter(vary));
          if (hex) {
            ctx.beginPath();
            const cx = i * t + t / 2 + (j % 2 ? t / 2 : 0);
            const cy = j * t + t / 2;
            for (let k = 0; k < 6; k++) {
              const a = (Math.PI / 3) * k + Math.PI / 6;
              ctx.lineTo(cx + Math.cos(a) * t * 0.55, cy + Math.sin(a) * t * 0.55);
            }
            ctx.fill();
          } else ctx.fillRect(i * t + 1.5, j * t + 1.5, t - 3, t - 3);
        }
      if (speckle) noise(ctx, px, speckle, 2, tint(base, -0.2), 0.5);
      if (veins) marbleVeins(ctx, px, veins, 26);
    }),
  };
}

function plain(base, speckle, size = 2) {
  return {
    ft: 6,
    map: canvasTexture(512, (ctx, px) => {
      ctx.fillStyle = base;
      ctx.fillRect(0, 0, px, px);
      noise(ctx, px, speckle, size, tint(base, -0.12), 0.35);
      noise(ctx, px, speckle / 2, size, tint(base, 0.08), 0.35);
    }),
  };
}

const FLOOR_TEX = {
  "light-oak": () => planks("#d9bc90"),
  "natural-oak": () => planks("#c39a6b"),
  walnut: () => planks("#7b5538"),
  "grey-oak": () => planks("#b5aa98"),
  travertine: () => tiles("#e3d5bb", 2, "#d2c3a6", { speckle: 4000, vary: 0.025 }),
  "white-marble": () => tiles("#f2f1ee", 2, "#dedcd8", { veins: "#8f949a", vary: 0.01 }),
  "grey-porcelain": () => tiles("#bdbab3", 2, "#a8a49d", { speckle: 1500 }),
  terracotta: () => tiles("#c47552", 1, "#dcc8ae", { vary: 0.05, speckle: 1500 }),
  slate: () => tiles("#5f6468", 1.5, "#4a4e51", { vary: 0.05, speckle: 2500 }),
  "polished-concrete": () => plain("#c2bfb8", 9000, 3),
  "carpet-beige": () => plain("#d8cab3", 30000, 1.5),
  "carpet-grey": () => plain("#b7b3ad", 30000, 1.5),
  "white-hex-tile": () => tiles("#f3f3f1", 0.5, "#d4d4d2", { hex: true, vary: 0.01 }),
};

const texCache = new Map();
function floorTex(name) {
  if (!texCache.has(name)) texCache.set(name, (FLOOR_TEX[name] ?? FLOOR_TEX["natural-oak"])());
  return texCache.get(name);
}

// --- materials ----------------------------------------------------------------

const matCache = new Map();
function cached(key, make) {
  if (!matCache.has(key)) matCache.set(key, make());
  return matCache.get(key);
}

const paint = (color, roughness = 0.75, extra = {}) =>
  cached(
    `paint${color}${roughness}${JSON.stringify(extra)}`,
    () => new THREE.MeshStandardMaterial({ color, roughness, ...extra }),
  );

const fabric = (color) =>
  cached(
    `fabric${color}`,
    () =>
      new THREE.MeshPhysicalMaterial({
        color,
        roughness: 0.9,
        sheen: 1,
        sheenRoughness: 0.45,
        sheenColor: new THREE.Color(tint(color, 0.18)),
      }),
  );

const woodGrain = (color) =>
  cached(`wood${color}`, () => {
    const map = canvasTexture(256, (ctx, px) => {
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, px, px);
      for (let i = 0; i < 60; i++) {
        ctx.globalAlpha = 0.08 + rand() * 0.1;
        ctx.fillStyle = tint(color, jitter(0.1));
        ctx.fillRect(0, rand() * px, px, 1 + rand() * 3);
      }
      ctx.globalAlpha = 1;
    });
    return new THREE.MeshStandardMaterial({ color: "#ffffff", map, roughness: 0.6 });
  });

const METALS = {
  brass: { color: "#b8955a", metalness: 1, roughness: 0.32 },
  chrome: { color: "#dcdcdc", metalness: 1, roughness: 0.12 },
  "matte-black": { color: "#262626", metalness: 0.4, roughness: 0.55 },
  stainless: { color: "#c9cbcd", metalness: 1, roughness: 0.28 },
};
const metal = () =>
  cached("metal", () => new THREE.MeshStandardMaterial(METALS[style.metal] ?? METALS.stainless));
const steel = () => cached("steel", () => new THREE.MeshStandardMaterial(METALS.stainless));
const glass = () =>
  cached(
    "glass",
    () =>
      new THREE.MeshPhysicalMaterial({
        color: "#d8edf3",
        transparent: true,
        opacity: 0.32,
        roughness: 0.05,
        metalness: 0,
        depthWrite: false,
      }),
  );
const white = () => paint("#f7f6f3", 0.25);
const wood = () => woodGrain(style.furnitureWood);
const doorWood = () => woodGrain(tint(style.furnitureWood, -0.04));

const COUNTERTOPS = {
  "white-marble": () => {
    const t = tiles("#f3f2ef", 8, "#f3f2ef", { veins: "#9aa0a6" });
    return new THREE.MeshStandardMaterial({ map: t.map, roughness: 0.2 });
  },
  "black-granite": () =>
    new THREE.MeshStandardMaterial({ map: plain("#2a2a2c", 12000, 2).map, roughness: 0.25 }),
  "white-quartz": () =>
    new THREE.MeshStandardMaterial({ map: plain("#efeeea", 4000, 1.5).map, roughness: 0.3 }),
  "butcher-block": () => woodGrain("#b98a59"),
  concrete: () =>
    new THREE.MeshStandardMaterial({ map: plain("#a19e98", 9000, 2).map, roughness: 0.6 }),
};
const countertop = () =>
  cached("counter", () => (COUNTERTOPS[style.countertop] ?? COUNTERTOPS["white-quartz"])());

const quilted = () =>
  cached("quilt", () => {
    const map = canvasTexture(256, (ctx, px) => {
      ctx.fillStyle = style.bedding;
      ctx.fillRect(0, 0, px, px);
      ctx.strokeStyle = tint(style.bedding, -0.12);
      ctx.lineWidth = 2;
      const step = px / 6;
      for (let i = -6; i <= 12; i++) {
        ctx.beginPath();
        ctx.moveTo(i * step, 0);
        ctx.lineTo(i * step + px, px);
        ctx.moveTo(i * step, px);
        ctx.lineTo(i * step + px, 0);
        ctx.stroke();
      }
    });
    map.repeat.set(2, 2);
    return new THREE.MeshPhysicalMaterial({
      map,
      roughness: 0.85,
      sheen: 0.6,
      sheenColor: new THREE.Color("#ffffff"),
    });
  });

const rugMat = () =>
  cached("rug", () => {
    const map = canvasTexture(512, (ctx, px) => {
      ctx.fillStyle = style.rug;
      ctx.fillRect(0, 0, px, px);
      noise(ctx, px, 40000, 1.5, tint(style.rug, -0.1), 0.5);
      noise(ctx, px, 20000, 1.5, tint(style.rug, 0.08), 0.5);
      ctx.strokeStyle = tint(style.rug, -0.15);
      ctx.lineWidth = 10;
      ctx.strokeRect(22, 22, px - 44, px - 44);
    });
    return new THREE.MeshStandardMaterial({ map, roughness: 1 });
  });

const plaster = () =>
  cached("plaster", () => {
    const map = canvasTexture(256, (ctx, px) => {
      ctx.fillStyle = style.wallColor;
      ctx.fillRect(0, 0, px, px);
      noise(ctx, px, 6000, 2, tint(style.wallColor, -0.05), 0.4);
      noise(ctx, px, 3000, 2, tint(style.wallColor, 0.04), 0.4);
    });
    map.repeat.set(0.5, 0.5);
    return new THREE.MeshStandardMaterial({ map, roughness: 0.95 });
  });

// --- geometry helpers -----------------------------------------------------------

function shadowed(mesh) {
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/** A box w x h x d whose bottom sits at height y, centered on (x, z). */
function box(parent, w, h, d, mat, x = 0, y = 0, z = 0) {
  const m = shadowed(new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat));
  m.position.set(x, y + h / 2, z);
  parent.add(m);
  return m;
}

function rbox(parent, w, h, d, r, mat, x = 0, y = 0, z = 0) {
  const radius = Math.max(0.001, Math.min(r, Math.min(w, h, d) / 2 - 0.002));
  const m = shadowed(new THREE.Mesh(new RoundedBoxGeometry(w, h, d, 3, radius), mat));
  m.position.set(x, y + h / 2, z);
  parent.add(m);
  return m;
}

function cyl(parent, rTop, rBottom, h, mat, x = 0, y = 0, z = 0, segments = 32) {
  const m = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(rTop, rBottom, h, segments), mat));
  m.position.set(x, y + h / 2, z);
  parent.add(m);
  return m;
}

// --- furniture (built facing +Z, back at -Z, centered on the origin) --------------

function bed(g, w, d) {
  const head = 0.35;
  box(g, w, 0.9, d - head, wood(), 0, 0, head / 2);
  rbox(g, w + 0.3, 3.3, head, 0.12, fabric(style.headboard), 0, 0, -d / 2 + head / 2);
  rbox(g, w - 0.15, 0.7, d - head - 0.15, 0.18, white(), 0, 0.85, head / 2);
  const duvet = d * 0.66;
  rbox(g, w + 0.05, 0.28, duvet, 0.13, quilted(), 0, 1.4, d / 2 - duvet / 2);
  const n = w > 4.5 ? 2 : 1;
  const pw = (w - 0.5) / n - 0.15;
  for (let i = 0; i < n; i++) {
    const x = -w / 2 + 0.25 + pw / 2 + i * (pw + 0.15);
    rbox(g, pw, 0.4, 1.25, 0.18, paint("#f6f3ec", 0.35), x, 1.5, -d / 2 + head + 0.85);
    const c = rbox(
      g,
      Math.min(1.3, pw * 0.6),
      0.35,
      0.75,
      0.16,
      fabric(style.accentFabric),
      x,
      1.6,
      -d / 2 + head + 1.75,
    );
    c.rotation.y = jitter(0.15);
  }
}

function nightstand(g, w, d) {
  box(g, w, 1.9, d, wood());
  box(g, w + 0.05, 0.06, d + 0.05, metal(), 0, 1.9);
  cyl(g, 0.16, 0.2, 0.9, metal(), 0, 1.96, -0.05);
  cyl(
    g,
    0.38,
    0.5,
    0.55,
    paint("#f4ecdc", 0.8, { emissive: "#3a2f1a", emissiveIntensity: 0.4 }),
    0,
    2.75,
    -0.05,
  );
}

function wardrobe(g, w, d) {
  box(g, w, 3.9, d, wood());
  box(g, w - 0.2, 0.04, d - 0.2, woodGrain(tint(style.furnitureWood, 0.05)), 0, 3.9);
}

function dresser(g, w, d) {
  box(g, w, 2.8, d, wood());
  cyl(g, 0.25, 0.2, 0.9, paint("#e9e4da", 0.4), -w / 3, 2.8);
  rbox(g, 1.1, 0.25, 0.8, 0.05, paint("#5c6b7a", 0.6), w / 4, 2.8);
}

function desk(g, w, d) {
  box(g, w, 0.12, d, wood(), 0, 2.4);
  for (const sx of [-1, 1])
    for (const sz of [-1, 1])
      box(g, 0.12, 2.4, 0.12, metal(), sx * (w / 2 - 0.15), 0, sz * (d / 2 - 0.15));
  rbox(g, 1.5, 0.3, 1.5, 0.12, fabric(style.accentFabric), 0, 1.5, d / 2 - 0.2);
  rbox(g, 1.5, 1.5, 0.25, 0.1, fabric(style.accentFabric), 0, 1.8, d / 2 + 0.5);
  rbox(g, 1.4, 0.06, 0.95, 0.03, paint("#30343a", 0.4), -w / 5, 2.52, -0.1);
}

function sofaPart(g, w, d, { left = true, right = true } = {}, x = 0, z = 0) {
  const f = fabric(style.sofaFabric);
  rbox(g, w, 1.15, d, 0.2, f, x, 0, z);
  rbox(g, w, 2.6, 0.75, 0.25, f, x, 0, z - d / 2 + 0.375);
  if (left) rbox(g, 0.7, 2.05, d, 0.25, f, x - w / 2 + 0.35, 0, z);
  if (right) rbox(g, 0.7, 2.05, d, 0.25, f, x + w / 2 - 0.35, 0, z);
  const inner = w - (left ? 0.7 : 0) - (right ? 0.7 : 0);
  const n = Math.max(1, Math.round(inner / 2.6));
  const cw = inner / n;
  const start = x - w / 2 + (left ? 0.7 : 0);
  for (let i = 0; i < n; i++) {
    rbox(g, cw - 0.06, 0.45, d - 0.8, 0.2, f, start + cw * (i + 0.5), 1.1, z + 0.38);
  }
  return { start, inner };
}

function sofa(g, w, d) {
  const { start, inner } = sofaPart(g, w, d);
  for (const t of [0.22, 0.78]) {
    const c = rbox(
      g,
      1.35,
      1.15,
      0.4,
      0.17,
      fabric(style.accentFabric),
      start + inner * t,
      1.5,
      -d / 2 + 0.95,
    );
    c.rotation.x = -0.35;
  }
}

function sofaL(g, w, d) {
  const sd = 3.1;
  const f = fabric(style.sofaFabric);
  const { start, inner } = sofaPart(g, w, sd, { left: true, right: false }, 0, -d / 2 + sd / 2);
  // The chaise along the right side, with its back against the right wall.
  const cz = (-d / 2 + sd + d / 2) / 2;
  rbox(g, sd, 1.15, d - sd, 0.2, f, w / 2 - sd / 2, 0, cz);
  rbox(g, 0.75, 2.6, d, 0.25, f, w / 2 - 0.375, 0, 0);
  rbox(g, sd, 2.05, 0.7, 0.25, f, w / 2 - sd / 2, 0, d / 2 - 0.35);
  rbox(g, sd - 0.85, 0.45, d - sd - 0.75, 0.2, f, w / 2 - sd / 2 - 0.35, 1.1, cz - 0.3);
  for (const t of [0.2, 0.55]) {
    const c = rbox(
      g,
      1.35,
      1.15,
      0.4,
      0.17,
      fabric(style.accentFabric),
      start + inner * t,
      1.5,
      -d / 2 + 0.95,
    );
    c.rotation.x = -0.35;
  }
}

function armchair(g, w, d) {
  sofaPart(g, w, d);
}

function coffeeTable(g, w, d) {
  for (const sx of [-1, 1])
    for (const sz of [-1, 1])
      box(g, 0.1, 1.4, 0.1, metal(), sx * (w / 2 - 0.08), 0, sz * (d / 2 - 0.08));
  box(g, w, 0.06, d, metal(), 0, 0.35);
  box(g, w - 0.1, 0.06, d - 0.1, glass(), 0, 1.4);
  rbox(g, 0.9, 0.2, 0.6, 0.05, paint("#3d4b5c", 0.6), w / 5, 1.46, 0.1);
  cyl(g, 0.22, 0.18, 0.4, paint("#e8e2d6", 0.3), -w / 4, 1.46, -0.15);
}

function sideTable(g, w) {
  cyl(g, w / 2, w / 2, 0.08, metal(), 0, 1.7);
  cyl(g, 0.08, 0.08, 1.7, metal());
  cyl(g, w / 3, w / 3, 0.06, metal());
}

function tvUnit(g, w, d) {
  box(g, w, 1.7, d, wood());
  box(g, w * 0.78, 2.2, 0.14, paint("#141414", 0.25), 0, 1.7, -d / 2 + 0.25);
}

function bookshelf(g, w, d) {
  box(g, w, 3.9, d, wood());
  const colors = ["#8c3b2f", "#2f4c6b", "#d9c9a3", "#4f6b4a", "#c58b4a"];
  for (let x = -w / 2 + 0.3; x < w / 2 - 0.3; x += 0.6)
    box(g, 0.45, 0.06, d * 0.8, paint(colors[Math.floor(rand() * colors.length)]), x, 3.9);
}

function rug(g, w, d) {
  const m = box(g, w, 0.05, d, rugMat());
  m.castShadow = false;
}

function plant(g, w) {
  cyl(g, w * 0.3, w * 0.24, 1.3, paint("#e9e4dc", 0.5));
  const greens = ["#3f6d3a", "#4f7f42", "#335c30", "#5a8a4a"];
  for (let i = 0; i < 9; i++) {
    const r = w * (0.22 + rand() * 0.12);
    const m = shadowed(
      new THREE.Mesh(
        new THREE.IcosahedronGeometry(r, 1),
        paint(greens[i % 4], 0.8, { flatShading: true }),
      ),
    );
    m.position.set(jitter(w * 0.25), 1.6 + rand() * 1.4, jitter(w * 0.25));
    g.add(m);
  }
}

function diningSet(g, w, d) {
  const top =
    style.countertop === "white-marble" || style.countertop === "white-quartz"
      ? countertop()
      : wood();
  rbox(g, w, 0.15, d, 0.05, top, 0, 2.35);
  box(g, w - 0.3, 0.03, 0.05, metal(), 0, 2.5, 0);
  cyl(g, 0.3, 0.6, 2.35, metal(), -w / 4, 0, 0);
  cyl(g, 0.3, 0.6, 2.35, metal(), w / 4, 0, 0);
  const chair = (x, z, angle) => {
    const c = new THREE.Group();
    rbox(c, 1.5, 0.25, 1.45, 0.1, fabric(style.sofaFabric), 0, 1.45, 0);
    rbox(c, 1.5, 1.5, 0.25, 0.1, fabric(style.sofaFabric), 0, 1.6, 0.65);
    for (const sx of [-1, 1])
      for (const sz of [-1, 1]) box(c, 0.08, 1.45, 0.08, metal(), sx * 0.6, 0, sz * 0.58);
    c.position.set(x, 0, z);
    c.rotation.y = angle;
    g.add(c);
  };
  const perSide = Math.max(1, Math.floor(w / 2.2));
  for (let i = 0; i < perSide; i++) {
    const x = -w / 2 + (w / perSide) * (i + 0.5);
    chair(x, -d / 2 - 0.6, Math.PI);
    chair(x, d / 2 + 0.6, 0);
  }
  if (w >= 5 && d >= 3) {
    chair(-w / 2 - 0.6, 0, -Math.PI / 2);
    chair(w / 2 + 0.6, 0, Math.PI / 2);
  }
}

function cabinet(g, w, d, h = 2.9) {
  box(g, w, h, d, paint(style.cabinets, 0.55));
  box(g, w + 0.04, 0.13, d + 0.06, countertop(), 0, h);
}

function counter(g, w, d) {
  cabinet(g, w, d);
}

function counterSink(g, w, d) {
  cabinet(g, w, d);
  const sw = Math.min(2.8, w - 0.6);
  box(g, sw, 0.04, 1.3, paint("#8e9296", 0.3, { metalness: 0.9 }), 0, 3.03, 0.05);
  box(g, sw - 0.15, 0.02, 1.15, paint("#5f6366", 0.35, { metalness: 0.9 }), 0, 3.07, 0.05);
  cyl(g, 0.06, 0.06, 0.9, metal(), 0, 3.03, -d / 2 + 0.25);
}

function counterHob(g, w, d) {
  cabinet(g, w, d);
  box(g, Math.min(2.5, w - 0.4), 0.03, 1.7, paint("#151515", 0.15), 0, 3.03, 0);
  for (const [x, z, r] of [
    [-0.6, -0.4, 0.33],
    [0.6, -0.4, 0.25],
    [-0.6, 0.4, 0.25],
    [0.6, 0.4, 0.33],
  ]) {
    const ring = shadowed(
      new THREE.Mesh(new THREE.TorusGeometry(r, 0.04, 8, 32), paint("#4a4a4a", 0.4)),
    );
    ring.rotation.x = Math.PI / 2;
    ring.position.set(x, 3.08, z);
    g.add(ring);
  }
}

function island(g, w, d) {
  box(g, w, 2.9, d, paint(style.cabinets, 0.55));
  box(g, w + 0.1, 0.13, d + 0.8, countertop(), 0, 2.9, 0.4);
  const n = Math.max(1, Math.floor(w / 2));
  for (let i = 0; i < n; i++) {
    const x = -w / 2 + (w / n) * (i + 0.5);
    cyl(g, 0.07, 0.07, 2.1, metal(), x, 0, d / 2 + 0.95);
    cyl(g, 0.58, 0.55, 0.28, fabric(style.sofaFabric), x, 2.1, d / 2 + 0.95);
  }
}

function fridge(g, w, d) {
  rbox(g, w, 3.9, d, 0.06, steel());
  box(g, 0.02, 0.01, d - 0.1, paint("#7a7d80"), 0, 3.9);
}

function bathtub(g, w, d) {
  rbox(g, w, 1.8, d, 0.22, white());
  rbox(g, w - 0.5, 0.06, d - 0.5, 0.25, paint("#e6ecef", 0.15), 0, 1.76);
  cyl(g, 0.07, 0.07, 0.6, metal(), -w / 2 + 0.35, 1.8, 0);
  box(g, w * 0.45, 3.9, 0.05, glass(), -w / 2 + (w * 0.45) / 2, 0, d / 2 - 0.05);
}

function shower(g, w, d) {
  box(g, w, 0.2, d, white());
  box(g, w - 0.3, 0.02, d - 0.3, paint("#dfe3e4", 0.3), 0, 0.2);
  cyl(g, 0.12, 0.12, 0.03, metal(), 0, 0.22, 0);
  box(g, w, 3.9, 0.05, glass(), 0, 0.2, d / 2 - 0.03);
  box(g, 0.05, 3.9, d * 0.6, glass(), w / 2 - 0.03, 0.2, d / 2 - d * 0.3);
  cyl(g, 0.3, 0.3, 0.05, metal(), 0, 3.6, -d / 2 + 0.6);
}

function toilet(g, w, d) {
  box(g, w * 0.95, 2.6, 0.6, white(), 0, 0, -d / 2 + 0.3);
  const bowl = cyl(g, 0.62, 0.5, 1.35, white(), 0, 0, 0.25);
  bowl.scale.z = 1.3;
  const seat = cyl(g, 0.6, 0.6, 0.06, paint("#ffffff", 0.2), 0, 1.35, 0.25);
  seat.scale.z = 1.3;
}

function vanity(g, w, d) {
  box(g, w, 2.7, d, wood());
  box(g, w + 0.05, 0.1, d + 0.05, countertop(), 0, 2.7);
  const n = w >= 5 ? 2 : 1;
  for (let i = 0; i < n; i++) {
    const x = n === 1 ? 0 : i === 0 ? -w / 4 : w / 4;
    const b = cyl(g, 0.6, 0.5, 0.18, white(), x, 2.8, 0.1);
    b.scale.z = 0.75;
    cyl(g, 0.05, 0.05, 0.5, metal(), x, 2.8, -d / 2 + 0.2);
  }
}

function washerDryer(g, w, d) {
  for (const sx of [-1, 1]) {
    rbox(g, w / 2 - 0.08, 3, d, 0.06, white(), sx * (w / 4), 0, 0);
    box(g, w / 2 - 0.3, 0.02, 0.4, paint("#9aa3ab", 0.4), sx * (w / 4), 3, -d / 2 + 0.3);
  }
}

function car(g, w, d) {
  const body = paint(style.carColor, 0.3, { metalness: 0.6 });
  rbox(g, w, 2.3, d, 0.6, body, 0, 0.5);
  rbox(g, w - 0.7, 1.5, d * 0.52, 0.45, paint("#20262c", 0.08, { metalness: 0.3 }), 0, 2.6, -0.4);
  rbox(g, w - 1.1, 0.1, d * 0.3, 0.05, body, 0, 4.1, -0.6);
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) {
      const wheel = cyl(
        g,
        1.05,
        1.05,
        0.7,
        paint("#1b1b1b", 0.8),
        sx * (w / 2 - 0.3),
        0,
        sz * (d / 2 - 2.7),
      );
      wheel.rotation.z = Math.PI / 2;
      wheel.position.y = 1.05;
    }
}

function stairs(g, w, d) {
  const steps = Math.max(5, Math.round(d / 0.85));
  const run = d / steps;
  const tread = woodGrain(tint(style.furnitureWood, 0.12));
  for (let i = 0; i < steps; i++) {
    const h = ((i + 1) / steps) * (WALL_H - 0.3);
    box(
      g,
      w,
      h,
      run,
      i % 2 ? tread : woodGrain(tint(style.furnitureWood, 0.09)),
      0,
      0,
      d / 2 - run * (i + 0.5),
    );
  }
  box(g, 0.08, 0.08, d, metal(), w / 2 - 0.1, WALL_H - 0.2, 0);
}

function bench(g, w, d) {
  box(g, w, 1.4, d, wood());
  rbox(g, w - 0.2, 0.2, d - 0.15, 0.08, fabric(style.accentFabric), 0, 1.4);
}

function storage(g, w, d) {
  box(g, w, 3, d, wood());
}

const BUILDERS = {
  "bed-king": bed,
  "bed-queen": bed,
  "bed-twin": bed,
  nightstand,
  wardrobe,
  dresser,
  desk,
  sofa,
  "sofa-l": sofaL,
  armchair,
  "coffee-table": coffeeTable,
  "side-table": sideTable,
  "tv-unit": tvUnit,
  bookshelf,
  rug,
  plant,
  "dining-set": diningSet,
  island,
  counter,
  "counter-sink": counterSink,
  "counter-hob": counterHob,
  fridge,
  bathtub,
  shower,
  toilet,
  vanity,
  "washer-dryer": washerDryer,
  car,
  stairs,
  bench,
  cabinet: storage,
};

// --- the floor ------------------------------------------------------------------

/** A flat floor rectangle whose texture lines up across rooms (UVs from world position). */
function floorQuad(x0, z0, x1, z1, y, tex) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute(
    "position",
    new THREE.Float32BufferAttribute([x0, y, z0, x1, y, z0, x0, y, z1, x1, y, z1], 3),
  );
  geo.setAttribute(
    "normal",
    new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0], 3),
  );
  const u = (x) => x / tex.ft;
  geo.setAttribute(
    "uv",
    new THREE.Float32BufferAttribute(
      [u(x0), -u(z0), u(x1), -u(z0), u(x0), -u(z1), u(x1), -u(z1)],
      2,
    ),
  );
  geo.setIndex([0, 2, 1, 1, 2, 3]);
  const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: tex.map, roughness: 0.55 }));
  m.receiveShadow = true;
  return m;
}

/** A box along the segment (x1, z1) -> (x2, z2). */
function along(parent, x1, z1, x2, z2, h, t, mat, y = 0, offset = 0) {
  const len = Math.hypot(x2 - x1, z2 - z1);
  const m = shadowed(new THREE.Mesh(new THREE.BoxGeometry(len, h, t), mat));
  const angle = -Math.atan2(z2 - z1, x2 - x1);
  m.rotation.y = angle;
  m.position.set(
    (x1 + x2) / 2 - Math.sin(angle) * offset,
    y + h / 2,
    (z1 + z2) / 2 - Math.cos(angle) * offset,
  );
  parent.add(m);
  return m;
}

function wallPiece(scene, w) {
  const frameMat = paint("#fbfbfa", 0.35);
  if (w.kind === "wall") return along(scene, w.x1, w.y1, w.x2, w.y2, WALL_H, w.t, plaster());
  if (w.kind === "garage-door") {
    along(scene, w.x1, w.y1, w.x2, w.y2, WALL_H, 0.22, paint("#e7e4de", 0.6));
    return;
  }
  const sill = w.kind === "sliding-door" ? 0.02 : SILL;
  if (sill > 0.1) along(scene, w.x1, w.y1, w.x2, w.y2, sill, w.t, plaster());
  along(scene, w.x1, w.y1, w.x2, w.y2, WALL_H - sill, 0.05, glass(), sill);
  along(scene, w.x1, w.y1, w.x2, w.y2, 0.12, w.t + 0.12, frameMat, sill);
  for (const side of [-1, 1])
    along(
      scene,
      w.x1,
      w.y1,
      w.x2,
      w.y2,
      0.12,
      0.12,
      frameMat,
      WALL_H - 0.12,
      side * (w.t / 2 - 0.06),
    );
  const len = Math.hypot(w.x2 - w.x1, w.y2 - w.y1);
  const ux = (w.x2 - w.x1) / len;
  const uz = (w.y2 - w.y1) / len;
  const posts = [0, ...(len > 4 ? [len / 2] : []), len];
  for (const p of posts) {
    const px = w.x1 + ux * p;
    const pz = w.y1 + uz * p;
    along(
      scene,
      px - ux * 0.09,
      pz - uz * 0.09,
      px + ux * 0.09,
      pz + uz * 0.09,
      WALL_H - sill,
      w.t,
      frameMat,
      sill,
    );
  }
}

function door(scene, d) {
  along(scene, d.hinge.x, d.hinge.y, d.end.x, d.end.y, WALL_H - 0.15, 0.15, doorWood());
}

function placeItem(scene, it) {
  const build = BUILDERS[it.kind];
  if (!build) return;
  const g = new THREE.Group();
  build(g, it.w, it.d);
  g.position.set(it.x, 0, it.y);
  g.rotation.y = (-it.rot * Math.PI) / 180;
  scene.add(g);
}

/** A soft, blurred shadow under the whole house, like a product shot. */
function dropShadow(scene) {
  const pad = 6;
  const w = floor.widthFt + pad * 2;
  const d = floor.depthFt + pad * 2;
  const canvas = document.createElement("canvas");
  canvas.width = 1024;
  canvas.height = Math.round((1024 * d) / w);
  const ctx = canvas.getContext("2d");
  const s = canvas.width / w;
  ctx.filter = `blur(${Math.round(1.6 * s)}px)`;
  ctx.fillStyle = "rgba(60,50,40,0.7)";
  ctx.beginPath();
  for (const r of floor.rooms)
    ctx.rect((pad + r.x + 0.8) * s, (pad + r.y + 1.2) * s, r.w * s, r.d * s);
  ctx.fill();
  const tex = new THREE.CanvasTexture(canvas);
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(w, d),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }),
  );
  m.rotation.x = -Math.PI / 2;
  m.position.set(floor.widthFt / 2, -SLAB - 0.01, floor.depthFt / 2);
  scene.add(m);
}

function build() {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#ffffff");

  // One slab per room, so floors smaller than the one below keep their own outline.
  const ext = 0.35;
  const slab = plaster();
  for (const r of floor.rooms)
    box(scene, r.w + ext * 2, SLAB, r.d + ext * 2, slab, r.x + r.w / 2, -SLAB, r.y + r.d / 2);
  for (const r of floor.rooms) {
    const tex = floorTex(style.floorOf[r.name]);
    scene.add(floorQuad(r.x, r.y, r.x + r.w, r.y + r.d, 0.01, tex));
  }
  for (const w of floor.walls) wallPiece(scene, w);
  for (const d of floor.doors) door(scene, d);
  for (const it of floor.items) placeItem(scene, it);

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(400, 400),
    new THREE.ShadowMaterial({ opacity: 0.12 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(floor.widthFt / 2, -SLAB, floor.depthFt / 2);
  ground.receiveShadow = true;
  scene.add(ground);
  dropShadow(scene);
  return scene;
}

function lights(scene, renderer) {
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.35;

  const size = Math.max(floor.widthFt, floor.depthFt);
  const sun = new THREE.DirectionalLight("#fff0da", 1.45);
  sun.position.set(floor.widthFt / 2 - size * 0.5, size * 1.6, floor.depthFt / 2 - size * 0.7);
  sun.target.position.set(floor.widthFt / 2, 0, floor.depthFt / 2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  const half = size * 0.8;
  Object.assign(sun.shadow.camera, {
    left: -half,
    right: half,
    top: half,
    bottom: -half,
    near: 1,
    far: size * 5,
  });
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.03;
  sun.shadow.radius = 5;
  sun.shadow.blurSamples = 16;
  scene.add(sun, sun.target);
  scene.add(new THREE.HemisphereLight("#fffaf2", "#d9d1c5", 0.4));
}

function camera() {
  const aspect = image.width / image.height;
  const fov = 18;
  const fill = 0.8;
  const tan = Math.tan(((fov / 2) * Math.PI) / 180);
  const height = Math.max(frame.depthFt / fill, frame.widthFt / (fill * aspect)) / (2 * tan);
  const cam = new THREE.PerspectiveCamera(fov, aspect, 1, height * 3);
  cam.position.set(floor.widthFt / 2, height + WALL_H / 2, floor.depthFt / 2);
  cam.up.set(0, 0, -1);
  cam.lookAt(floor.widthFt / 2, 0, floor.depthFt / 2);
  return cam;
}

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(image.width, image.height);
// No tone mapping: every tone-mapping curve turns the white background grey,
// so the lights are balanced to keep the brightest surfaces just under white.
renderer.toneMapping = THREE.NoToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.VSMShadowMap;
document.body.appendChild(renderer.domElement);

const scene = build();
lights(scene, renderer);
const cam = camera();
try {
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, cam));
  const ao = new GTAOPass(scene, cam, image.width, image.height);
  ao.updateGtaoMaterial({ radius: 1.5, distanceExponent: 1, thickness: 1, scale: 1 });
  ao.blendIntensity = 0.85;
  composer.addPass(ao);
  composer.addPass(new OutputPass());
  composer.render();
} catch (err) {
  console.error(err);
  renderer.render(scene, cam);
}
document.title = "done";
