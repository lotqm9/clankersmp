// Animals as blocky models with original textures painted in code: a pink pig with a curly tail, a red-brown cow
// with a white face (Hereford-like), a cream-wool sheep with a dark face, and a white hen with a red comb.
// Positions are interpolated from 5-10 Hz server snapshots, rendered ~150 ms in the past; legs swing with speed,
// heads dip to graze or peck, chickens flap, and a hit flashes them red.

import * as THREE from "three";
import { AF, SPECS, type AnimalSnap } from "../../../shared/animals.ts";
import { mulberry32 } from "../../../shared/noise.ts";
import { entityMaterial } from "./shaders.ts";
import { canvasTexture } from "./textures.ts";

const PX = 1 / 16;
const T = 64; // texture size

export type Paint = (put: (x: number, y: number, c: string) => void, w: number, h: number, face: Face) => void;
export type Face = "top" | "bottom" | "front" | "back" | "left" | "right";

export interface BoxDef {
  u: number;
  v: number;
  w: number;
  h: number;
  d: number;
}

/** Face rectangles of a box unwrap, the usual layout (x, y, w, h in texels). */
export function faces(b: BoxDef): Record<Face, [number, number, number, number]> {
  const { u, v, w, h, d } = b;
  return {
    top: [u + d, v, w, d],
    bottom: [u + d + w, v, w, d],
    right: [u, v + d, d, h],
    front: [u + d, v + d, w, h],
    left: [u + d + w, v + d, d, h],
    back: [u + d + w + d, v + d, w, h],
  };
}

function hex(h: string): [number, number, number] {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export class Painter {
  readonly c = document.createElement("canvas");
  private img: ImageData;
  private rand: () => number;
  constructor(seed: number) {
    this.c.width = T;
    this.c.height = T;
    this.img = this.c.getContext("2d")!.createImageData(T, T);
    this.rand = mulberry32(seed);
  }
  /** One texel. `alpha` 255 is solid; v6 night mobs use 0 for holes and 191 for parts that glow in the dark. */
  px(x: number, y: number, col: string, jitter = 0.05, alpha = 255): void {
    if (x < 0 || y < 0 || x >= T || y >= T) return;
    const [r, g, b] = hex(col);
    const k = 1 + (this.rand() - 0.5) * 2 * jitter;
    const o = (y * T + x) * 4;
    this.img.data[o] = Math.min(255, r * k);
    this.img.data[o + 1] = Math.min(255, g * k);
    this.img.data[o + 2] = Math.min(255, b * k);
    this.img.data[o + 3] = alpha;
  }
  /** Paint every face of a box; `paint` draws extra detail per face in face-local texels. */
  box(b: BoxDef, base: string, paint?: Paint, jitter = 0.06): void {
    const f = faces(b);
    for (const name of Object.keys(f) as Face[]) {
      const [x0, y0, w, h] = f[name];
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) this.px(x0 + x, y0 + y, base, jitter);
      if (paint) paint((x, y, c) => x >= 0 && y >= 0 && x < w && y < h && this.px(x0 + x, y0 + y, c, jitter * 0.6), w, h, name);
    }
  }
  r(): number {
    return this.rand();
  }
  done(): HTMLCanvasElement {
    this.c.getContext("2d")!.putImageData(this.img, 0, 0);
    return this.c;
  }
}

// ------------------------------------------------------------------ model layouts (px, UV origins in a 64x64 texture)

interface Part {
  name: string;
  box: BoxDef;
  /** Box centre relative to its pivot (px). */
  at: [number, number, number];
  /** Pivot position relative to the animal's feet centre (px). */
  pivot: [number, number, number];
  parent?: string;
}

interface Model {
  parts: Part[];
  legs: string[]; // front-left, front-right, back-left, back-right (diagonal pairs swing together)
  head: string;
  wings?: string[];
  paint: (p: Painter) => void;
}

const PIG_BODY: BoxDef = { u: 0, v: 0, w: 10, h: 8, d: 14 };
const PIG_HEAD: BoxDef = { u: 0, v: 22, w: 8, h: 8, d: 7 };
const PIG_SNOUT: BoxDef = { u: 32, v: 22, w: 4, h: 3, d: 1 };
const PIG_LEG: BoxDef = { u: 32, v: 28, w: 4, h: 6, d: 4 };
const PIG_TAIL: BoxDef = { u: 48, v: 0, w: 1, h: 2, d: 1 };

const COW_BODY: BoxDef = { u: 0, v: 0, w: 12, h: 10, d: 18 };
const COW_HEAD: BoxDef = { u: 0, v: 28, w: 8, h: 8, d: 6 };
const COW_MUZZLE: BoxDef = { u: 28, v: 28, w: 6, h: 3, d: 1 };
const COW_HORN: BoxDef = { u: 44, v: 28, w: 1, h: 3, d: 1 };
const COW_LEG: BoxDef = { u: 0, v: 42, w: 4, h: 12, d: 4 };

const SHEEP_BODY: BoxDef = { u: 0, v: 0, w: 11, h: 9, d: 16 };
const SHEEP_HEAD: BoxDef = { u: 0, v: 25, w: 6, h: 6, d: 7 };
const SHEEP_CAP: BoxDef = { u: 26, v: 25, w: 7, h: 3, d: 5 };
const SHEEP_EAR: BoxDef = { u: 50, v: 25, w: 3, h: 1, d: 2 };
const SHEEP_LEG: BoxDef = { u: 0, v: 38, w: 3, h: 10, d: 3 };

const HEN_BODY: BoxDef = { u: 0, v: 0, w: 6, h: 6, d: 8 };
const HEN_HEAD: BoxDef = { u: 0, v: 14, w: 4, h: 5, d: 3 };
const HEN_BEAK: BoxDef = { u: 14, v: 14, w: 4, h: 2, d: 2 };
const HEN_WATTLE: BoxDef = { u: 26, v: 14, w: 2, h: 2, d: 1 };
const HEN_COMB: BoxDef = { u: 32, v: 14, w: 1, h: 2, d: 3 };
const HEN_WING: BoxDef = { u: 0, v: 22, w: 1, h: 4, d: 6 };
const HEN_LEG: BoxDef = { u: 14, v: 22, w: 1, h: 5, d: 1 };

const MODELS: Model[] = [
  {
    // pig
    parts: [
      { name: "body", box: PIG_BODY, at: [0, 0, 0], pivot: [0, 10, 0] },
      { name: "head", box: PIG_HEAD, at: [0, 0, 3.5], pivot: [0, 12, 7] },
      { name: "snout", box: PIG_SNOUT, at: [0, -1.5, 7.5], pivot: [0, 12, 7], parent: "head" },
      { name: "tail", box: PIG_TAIL, at: [0, 0, 0], pivot: [0, 12, -7.5] },
      { name: "fl", box: PIG_LEG, at: [0, -3, 0], pivot: [-3, 6, 5] },
      { name: "fr", box: PIG_LEG, at: [0, -3, 0], pivot: [3, 6, 5] },
      { name: "bl", box: PIG_LEG, at: [0, -3, 0], pivot: [-3, 6, -5] },
      { name: "br", box: PIG_LEG, at: [0, -3, 0], pivot: [3, 6, -5] },
    ],
    legs: ["fl", "fr", "bl", "br"],
    head: "head",
    paint(p) {
      const pink = "#e9a3a6";
      const dark = "#d48b91";
      const spot = "#cf7f87";
      p.box(PIG_BODY, pink, (put, w, h, f) => {
        for (let k = 0; k < (f === "top" ? 5 : 2); k++) {
          const x = Math.floor(p.r() * (w - 2));
          const y = Math.floor(p.r() * (h - 2));
          put(x, y, spot);
          put(x + 1, y, spot);
          put(x, y + 1, spot);
        }
        if (f === "bottom") for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) put(x, y, dark);
      });
      p.box(PIG_HEAD, pink, (put, w, h, f) => {
        if (f === "front") {
          put(1, 3, "#ffffff");
          put(2, 3, "#2b1d1f");
          put(w - 3, 3, "#2b1d1f");
          put(w - 2, 3, "#ffffff");
          for (let x = 0; x < w; x++) put(x, 0, dark);
          put(0, 1, dark);
          put(w - 1, 1, dark);
        }
        if (f === "top") {
          // ears folded forward
          for (const x of [0, 1, w - 2, w - 1]) for (let y = h - 3; y < h; y++) put(x, y, dark);
        }
      });
      p.box(PIG_SNOUT, "#f2b8bb", (put, w, _h, f) => {
        if (f === "front") {
          put(1, 1, "#9b5a60");
          put(w - 2, 1, "#9b5a60");
        }
      });
      p.box(PIG_LEG, pink, (put, w, h, f) => {
        if (f !== "top") for (let x = 0; x < w; x++) put(x, h - 1, "#9a6a6e");
      });
      p.box(PIG_TAIL, dark);
    },
  },
  {
    // cow (Hereford-like: red-brown, white face, white belly)
    parts: [
      { name: "body", box: COW_BODY, at: [0, 0, 0], pivot: [0, 17, 0] },
      { name: "head", box: COW_HEAD, at: [0, 0, 3], pivot: [0, 20, 9] },
      { name: "muzzle", box: COW_MUZZLE, at: [0, -2.5, 6.5], pivot: [0, 20, 9], parent: "head" },
      { name: "hornl", box: COW_HORN, at: [-4.5, 4.5, 2], pivot: [0, 20, 9], parent: "head" },
      { name: "hornr", box: COW_HORN, at: [4.5, 4.5, 2], pivot: [0, 20, 9], parent: "head" },
      { name: "fl", box: COW_LEG, at: [0, -6, 0], pivot: [-4, 12, 6.5] },
      { name: "fr", box: COW_LEG, at: [0, -6, 0], pivot: [4, 12, 6.5] },
      { name: "bl", box: COW_LEG, at: [0, -6, 0], pivot: [-4, 12, -6.5] },
      { name: "br", box: COW_LEG, at: [0, -6, 0], pivot: [4, 12, -6.5] },
    ],
    legs: ["fl", "fr", "bl", "br"],
    head: "head",
    paint(p) {
      const red = "#8f4c2c";
      const deep = "#6f3820";
      const white = "#ece5d6";
      p.box(COW_BODY, red, (put, w, h, f) => {
        if (f === "bottom") for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) put(x, y, white);
        if (f === "left" || f === "right") for (let x = 0; x < w; x++) for (let y = h - 2; y < h; y++) put(x, y, white);
        if (f === "front") for (let x = 2; x < w - 2; x++) for (let y = 3; y < h; y++) put(x, y, white); // white chest
        if (f === "top") for (let y = 0; y < h; y++) put(Math.floor(w / 2), y, deep); // darker spine
      });
      p.box(COW_HEAD, red, (put, w, h, f) => {
        if (f === "front") {
          for (let x = 1; x < w - 1; x++) for (let y = 0; y < h; y++) put(x, y, white); // white face
          put(1, 3, "#1e1512");
          put(w - 2, 3, "#1e1512");
          for (let x = 0; x < w; x++) put(x, 0, white);
        }
        if (f === "top") for (let x = 2; x < w - 2; x++) for (let y = 0; y < h; y++) put(x, y, white);
      });
      p.box(COW_MUZZLE, "#d8a79d", (put, w, _h, f) => {
        if (f === "front") {
          put(1, 1, "#6a4038");
          put(w - 2, 1, "#6a4038");
        }
      });
      p.box(COW_HORN, "#e6dcc3", (put, w, _h, f) => {
        if (f !== "bottom") for (let x = 0; x < w; x++) put(x, 0, "#a99e86");
      });
      p.box(COW_LEG, red, (put, w, h, f) => {
        if (f === "top") return;
        for (let x = 0; x < w; x++) for (let y = h - 4; y < h - 1; y++) put(x, y, white); // white socks
        for (let x = 0; x < w; x++) put(x, h - 1, "#3b2a22"); // hooves
      });
    },
  },
  {
    // sheep (cream wool, dark face and legs)
    parts: [
      { name: "body", box: SHEEP_BODY, at: [0, 0, 0], pivot: [0, 14.5, 0] },
      { name: "head", box: SHEEP_HEAD, at: [0, 0, 3.5], pivot: [0, 17, 7] },
      { name: "cap", box: SHEEP_CAP, at: [0, 3, 2.5], pivot: [0, 17, 7], parent: "head" },
      { name: "earl", box: SHEEP_EAR, at: [-4, 1.5, 1], pivot: [0, 17, 7], parent: "head" },
      { name: "earr", box: SHEEP_EAR, at: [4, 1.5, 1], pivot: [0, 17, 7], parent: "head" },
      { name: "fl", box: SHEEP_LEG, at: [0, -5, 0], pivot: [-3, 10, 5.5] },
      { name: "fr", box: SHEEP_LEG, at: [0, -5, 0], pivot: [3, 10, 5.5] },
      { name: "bl", box: SHEEP_LEG, at: [0, -5, 0], pivot: [-3, 10, -5.5] },
      { name: "br", box: SHEEP_LEG, at: [0, -5, 0], pivot: [3, 10, -5.5] },
    ],
    legs: ["fl", "fr", "bl", "br"],
    head: "head",
    paint(p) {
      const wool = "#ece6d8";
      const shade = "#d6cfbe";
      const face = "#3b3530";
      p.box(SHEEP_BODY, wool, (put, w, h) => {
        // curly wool: scattered shade clumps
        for (let k = 0; k < (w * h) / 5; k++) {
          const x = Math.floor(p.r() * w);
          const y = Math.floor(p.r() * h);
          put(x, y, shade);
          if (p.r() < 0.5) put(x + 1, y, shade);
        }
      }, 0.04);
      p.box(SHEEP_HEAD, face, (put, w, _h, f) => {
        if (f === "front") {
          put(1, 2, "#e8e2d4");
          put(2, 2, "#1a1715");
          put(w - 3, 2, "#1a1715");
          put(w - 2, 2, "#e8e2d4");
          put(2, 4, "#2a2522");
          put(w - 3, 4, "#2a2522");
        }
      });
      p.box(SHEEP_CAP, wool, (put, w, h) => {
        for (let k = 0; k < 6; k++) put(Math.floor(p.r() * w), Math.floor(p.r() * h), shade);
      });
      p.box(SHEEP_EAR, "#4a423c");
      p.box(SHEEP_LEG, face, (put, w, _h, f) => {
        if (f === "top") return;
        for (let x = 0; x < w; x++) for (let y = 0; y < 3; y++) put(x, y, shade); // wool at the top of the legs
      });
    },
  },
  {
    // hen
    parts: [
      { name: "body", box: HEN_BODY, at: [0, 0, 0], pivot: [0, 8, 0] },
      { name: "head", box: HEN_HEAD, at: [0, 2.5, 0], pivot: [0, 9, 4] },
      { name: "beak", box: HEN_BEAK, at: [0, 2.5, 2.5], pivot: [0, 9, 4], parent: "head" },
      { name: "wattle", box: HEN_WATTLE, at: [0, 0.5, 2], pivot: [0, 9, 4], parent: "head" },
      { name: "comb", box: HEN_COMB, at: [0, 6, -0.5], pivot: [0, 9, 4], parent: "head" },
      { name: "wingl", box: HEN_WING, at: [0, -2, 0], pivot: [-3.5, 10, 0] },
      { name: "wingr", box: HEN_WING, at: [0, -2, 0], pivot: [3.5, 10, 0] },
      { name: "fl", box: HEN_LEG, at: [0, -2.5, 0], pivot: [-1, 5, 1] },
      { name: "fr", box: HEN_LEG, at: [0, -2.5, 0], pivot: [1, 5, 1] },
    ],
    legs: ["fl", "fr"],
    head: "head",
    wings: ["wingl", "wingr"],
    paint(p) {
      const white = "#f3f0e8";
      const shade = "#dcd6c8";
      p.box(HEN_BODY, white, (put, w, h, f) => {
        if (f === "back") for (let x = 0; x < w; x++) put(x, 0, shade);
        for (let k = 0; k < 4; k++) put(Math.floor(p.r() * w), Math.floor(p.r() * h), shade);
      }, 0.03);
      p.box(HEN_HEAD, white, (put, w, _h, f) => {
        if (f === "front") {
          put(0, 1, "#1a1715");
          put(w - 1, 1, "#1a1715");
        }
        if (f === "left" || f === "right") put(1, 1, "#1a1715");
      });
      p.box(HEN_BEAK, "#f2a535");
      p.box(HEN_WATTLE, "#d33b2f");
      p.box(HEN_COMB, "#d33b2f");
      p.box(HEN_WING, shade, (put, w, h) => {
        for (let y = 0; y < h; y++) put(w - 1, y, "#cfc8b8");
      });
      p.box(HEN_LEG, "#e8a23a");
    },
  },
];

/** Box geometry with UVs from a box unwrap in a 64 x 64 texture (`grow`: px added on every side, like armour). */
export function boxGeometry(b: BoxDef, grow = 0): THREE.BoxGeometry {
  const g = new THREE.BoxGeometry((b.w + grow * 2) * PX, (b.h + grow * 2) * PX, (b.d + grow * 2) * PX);
  const f = faces(b);
  // three's face order: +X, -X, +Y, -Y, +Z, -Z. The model faces +Z; +X is its left side.
  const order: Face[] = ["left", "right", "top", "bottom", "front", "back"];
  const uv = g.getAttribute("uv") as THREE.BufferAttribute;
  order.forEach((name, i) => {
    const [x, y, w, h] = f[name];
    const x0 = x / T;
    const x1 = (x + w) / T;
    const y0 = 1 - y / T;
    const y1 = 1 - (y + h) / T;
    const o = i * 4;
    uv.setXY(o, x0, y0);
    uv.setXY(o + 1, x1, y0);
    uv.setXY(o + 2, x0, y1);
    uv.setXY(o + 3, x1, y1);
  });
  uv.needsUpdate = true;
  return g;
}

const textures: THREE.Texture[] = [];
const geometries = new Map<string, THREE.BoxGeometry>();

function textureFor(kind: number): THREE.Texture {
  if (!textures[kind]) {
    const p = new Painter(9100 + kind);
    MODELS[kind].paint(p);
    textures[kind] = canvasTexture(p.done());
  }
  return textures[kind];
}

function geometryFor(kind: number, b: BoxDef): THREE.BoxGeometry {
  const k = `${kind}:${b.u},${b.v},${b.w},${b.h},${b.d}`;
  let g = geometries.get(k);
  if (!g) {
    g = boxGeometry(b);
    geometries.set(k, g);
  }
  return g;
}

interface Snap {
  t: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  flags: number;
}

export class AnimalView {
  readonly id: number;
  readonly kind: number;
  readonly root = new THREE.Group();
  private parts = new Map<string, THREE.Group>();
  private mat: THREE.ShaderMaterial;
  private snaps: Snap[] = [];
  x = 0;
  y = 0;
  z = 0;
  yaw = 0;
  flags = 0;
  private lastX = 0;
  private lastZ = 0;
  private limbPos = 0;
  private limbAmt = 0;
  private eatAmt = 0;
  private flap = 0;
  private deadAmt = 0;
  /** Until when our own hit shows its red flash (before the server's HURT flag arrives). */
  localHurt = 0;

  constructor(s: AnimalSnap) {
    this.id = s.id;
    this.kind = s.kind;
    this.mat = entityMaterial(textureFor(s.kind));
    const model = MODELS[s.kind];
    for (const p of model.parts) {
      const pivot = new THREE.Group();
      pivot.position.set(p.pivot[0] * PX, p.pivot[1] * PX, p.pivot[2] * PX);
      const mesh = new THREE.Mesh(geometryFor(s.kind, p.box), this.mat);
      mesh.position.set(p.at[0] * PX, p.at[1] * PX, p.at[2] * PX);
      pivot.add(mesh);
      if (p.parent) {
        // Parts that ride on another part share its pivot: hang the mesh on the parent pivot instead.
        const parent = this.parts.get(p.parent)!;
        parent.add(mesh);
        continue;
      }
      this.parts.set(p.name, pivot);
      this.root.add(pivot);
    }
    if (s.kind === 0) this.parts.get("tail")!.rotation.x = 0.6;
    this.x = this.lastX = s.x;
    this.y = s.y;
    this.z = this.lastZ = s.z;
    this.yaw = s.yaw;
    this.flags = s.flags;
    this.root.position.set(this.x, this.y, this.z);
    this.root.rotation.y = (-this.yaw * Math.PI) / 180;
  }

  push(s: AnimalSnap, t: number): void {
    this.snaps.push({ t, x: s.x, y: s.y, z: s.z, yaw: s.yaw, flags: s.flags });
    if (this.snaps.length > 20) this.snaps.shift();
  }

  get spec() {
    return SPECS[this.kind];
  }

  /** 20 Hz: limb animation from the distance moved. */
  tick(): void {
    const dx = this.x - this.lastX;
    const dz = this.z - this.lastZ;
    this.lastX = this.x;
    this.lastZ = this.z;
    const dist = Math.min(1, Math.sqrt(dx * dx + dz * dz) * (this.kind === 3 ? 8 : 6));
    this.limbAmt += (dist - this.limbAmt) * 0.4;
    this.limbPos += this.limbAmt * (this.kind === 3 ? 1.6 : 1);
    this.eatAmt += ((this.flags & AF.EAT ? 1 : 0) - this.eatAmt) * 0.25;
    const flapping = !(this.flags & AF.GROUND) || (this.flags & AF.PANIC) !== 0;
    this.flap = flapping ? this.flap + 1.1 : this.flap * 0.7;
  }

  update(renderTime: number, partial: number, light: [number, number]): void {
    const snaps = this.snaps;
    if (snaps.length) {
      let a = snaps[0];
      let b = snaps[snaps.length - 1];
      for (let i = 0; i < snaps.length - 1; i++) {
        if (snaps[i].t <= renderTime && snaps[i + 1].t >= renderTime) {
          a = snaps[i];
          b = snaps[i + 1];
          break;
        }
      }
      if (renderTime >= b.t) a = b;
      const span = b.t - a.t;
      const k = span > 0 ? THREE.MathUtils.clamp((renderTime - a.t) / span, 0, 1) : 1;
      this.x = a.x + (b.x - a.x) * k;
      this.y = a.y + (b.y - a.y) * k;
      this.z = a.z + (b.z - a.z) * k;
      let dy = b.yaw - a.yaw;
      dy = ((((dy + 180) % 360) + 360) % 360) - 180;
      this.yaw = a.yaw + dy * k;
      this.flags = (renderTime >= b.t ? b : a).flags;
      while (snaps.length > 2 && snaps[1].t < renderTime - 1000) snaps.shift();
    }
    this.root.position.set(this.x, this.y, this.z);
    this.root.rotation.y = (-this.yaw * Math.PI) / 180;
    const model = MODELS[this.kind];
    const lp = this.limbPos + this.limbAmt * partial;
    const la = this.limbAmt;
    model.legs.forEach((name, i) => {
      const phase = model.legs.length === 2 ? (i === 0 ? 0 : Math.PI) : i === 0 || i === 3 ? 0 : Math.PI;
      this.parts.get(name)!.rotation.x = Math.cos(lp * 0.6662 + phase) * 1.2 * la;
    });
    const head = this.parts.get(model.head)!;
    const peck = this.kind === 3 ? Math.max(0, Math.sin(performance.now() / 70)) * 0.9 : Math.sin(performance.now() / 160) * 0.08;
    head.rotation.x = this.eatAmt * (this.kind === 3 ? 0.4 + peck : 0.95 + peck);
    if (model.wings) {
      const w = Math.sin(this.flap) * Math.min(1, this.flap) * 1.1;
      this.parts.get(model.wings[0])!.rotation.z = -Math.abs(w);
      this.parts.get(model.wings[1])!.rotation.z = Math.abs(w);
    }
    // dying (v5): it tips over onto its side, red
    const dead = (this.flags & AF.DEAD) !== 0;
    this.deadAmt = dead ? Math.min(1, this.deadAmt + 0.08) : 0;
    if (this.deadAmt > 0) this.root.rotateZ((Math.PI / 2) * Math.min(1, this.deadAmt * this.deadAmt * 1.6));
    const hurt = dead || (this.flags & AF.HURT) !== 0 || performance.now() < this.localHurt;
    this.mat.uniforms.uTint.value.setRGB(1, hurt ? 0.45 : 1, hurt ? 0.45 : 1);
    this.mat.uniforms.uLight.value.set(light[0], light[1]);
  }

  dispose(): void {
    this.mat.dispose();
  }
}
