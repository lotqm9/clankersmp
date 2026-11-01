// The player in the inventory's box (update 7.2): your avatar in 3D, its body and head turning toward the mouse like
// the classic inventory (body yaw = atan(dx / 40) x 20 degrees, the head twice that, the same for pitch and a lean),
// the arms swaying a little. Drawn with the 2D canvas, no second WebGL context: under an orthographic view every face
// of a box is an exact affine image of its skin rectangle (setTransform + drawImage), so the faces are painted back to
// front, each from a copy of its texture shaded for the way it faces. 2 GUI pixels per skin pixel, crisp at any GUI
// scale. Our own skins; v6: the armour you wear, on top (render/armor.ts).

import { wornMaterial } from "../../shared/combat.ts";
import { ARMOR_BOX, PIECES, armorCanvas } from "./render/armor.ts";
import { makeSkin } from "./render/textures.ts";

type V3 = [number, number, number];
type M3 = [number, number, number, number, number, number, number, number, number]; // row-major

const rotX = (a: number): M3 => {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [1, 0, 0, 0, c, -s, 0, s, c];
};
const rotY = (a: number): M3 => {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [c, 0, s, 0, 1, 0, -s, 0, c];
};
const rotZ = (a: number): M3 => {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [c, -s, 0, s, c, 0, 0, 0, 1];
};
const I3: M3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
function mul(a: M3, b: M3): M3 {
  const o = new Array(9).fill(0) as M3;
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
  return o;
}
const app = (m: M3, v: V3): V3 => [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];

type PartId = keyof typeof ARMOR_BOX;

/** The classic player model in skin pixels: y up from the feet, the front facing +Z (toward you). */
const PARTS: { id: PartId; min: V3; max: V3; pivot: V3 }[] = [
  { id: "legR", min: [-4, 0, -2], max: [0, 12, 2], pivot: [-2, 12, 0] },
  { id: "legL", min: [0, 0, -2], max: [4, 12, 2], pivot: [2, 12, 0] },
  { id: "body", min: [-4, 12, -2], max: [4, 24, 2], pivot: [0, 24, 0] },
  { id: "armR", min: [-8, 12, -2], max: [-4, 24, 2], pivot: [-5, 22, 0] },
  { id: "armL", min: [4, 12, -2], max: [8, 24, 2], pivot: [5, 22, 0] },
  { id: "head", min: [-4, 24, -4], max: [4, 32, 4], pivot: [0, 24, 0] },
];

interface Face {
  p0: V3; // the texture's top-left corner
  u: V3; // model-space step per texel along the texture's x
  v: V3; // per texel along its y
  n: V3; // outward normal
  tex: [number, number, number, number]; // skin rectangle x, y, w, h
}

/** The six faces of a box (grown by `g` px on every side) mapped onto its skin rectangles (the classic unwrap). */
function faces(min: V3, max: V3, uv: { u: number; v: number; w: number; h: number; d: number }, g = 0): Face[] {
  const [x0, y0, z0] = [min[0] - g, min[1] - g, min[2] - g];
  const [x1, y1, z1] = [max[0] + g, max[1] + g, max[2] + g];
  const { u, v, w, h, d } = uv;
  const sw = (x1 - x0) / w; // model px per texel (1 unless grown)
  const sh = (y1 - y0) / h;
  const sd = (z1 - z0) / d;
  return [
    { p0: [x0, y1, z1], u: [sw, 0, 0], v: [0, -sh, 0], n: [0, 0, 1], tex: [u + d, v + d, w, h] }, // front
    { p0: [x1, y1, z0], u: [-sw, 0, 0], v: [0, -sh, 0], n: [0, 0, -1], tex: [u + d + w + d, v + d, w, h] }, // back
    { p0: [x0, y1, z0], u: [0, 0, sd], v: [0, -sh, 0], n: [-1, 0, 0], tex: [u, v + d, d, h] }, // the model's right side
    { p0: [x1, y1, z1], u: [0, 0, -sd], v: [0, -sh, 0], n: [1, 0, 0], tex: [u + d + w, v + d, d, h] }, // its left side
    { p0: [x0, y1, z0], u: [sw, 0, 0], v: [0, 0, sd], n: [0, 1, 0], tex: [u + d, v, w, d] }, // top
    { p0: [x0, y0, z1], u: [sw, 0, 0], v: [0, 0, -sd], n: [0, -1, 0], tex: [u + d + w, v, w, d] }, // bottom
  ];
}

const SKIN_FACES = PARTS.map((p) => faces(p.min, p.max, ARMOR_BOX[p.id]));

const LEVELS = 12; // shading steps, 0.45 .. 1
const shadedCache = new Map<HTMLCanvasElement, HTMLCanvasElement[]>();
/** Copies of a texture darkened for each shading step (only where it is opaque: holes stay holes). */
function shaded(src: HTMLCanvasElement): HTMLCanvasElement[] {
  let list = shadedCache.get(src);
  if (list) return list;
  list = [];
  for (let k = 0; k < LEVELS; k++) {
    const b = 0.45 + (0.55 * k) / (LEVELS - 1);
    const c = document.createElement("canvas");
    c.width = src.width;
    c.height = src.height;
    const g = c.getContext("2d")!;
    g.drawImage(src, 0, 0);
    g.globalCompositeOperation = "source-atop";
    g.fillStyle = `rgba(0, 0, 0, ${(1 - b).toFixed(3)})`;
    g.fillRect(0, 0, c.width, c.height);
    list.push(c);
  }
  shadedCache.set(src, list);
  return list;
}

export class PlayerPreview {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private skin: HTMLCanvasElement;
  private k = 0; // device pixels per GUI pixel
  private dx = 0; // the mouse from the player's eyes, GUI pixels
  private dy = 0;
  private armor = 0; // packArmor
  private raf = 0;
  private lastKey = "";
  private readonly w: number;
  private readonly h: number;
  private readonly feet: [number, number];

  /** A w x h GUI-pixel box; the feet stand at `feet` (GUI pixels inside the box). */
  constructor(variant: number, w: number, h: number, feet: [number, number]) {
    this.w = w;
    this.h = h;
    this.feet = feet;
    this.skin = makeSkin(variant);
    this.canvas = document.createElement("canvas");
    this.canvas.className = "mcplayer";
    this.ctx = this.canvas.getContext("2d")!;
  }

  /** Device pixels per GUI pixel (the canvas matches the screen's pixels exactly). */
  setScale(dev: number): void {
    if (dev === this.k) return;
    this.k = dev;
    this.canvas.width = this.w * dev;
    this.canvas.height = this.h * dev;
    this.lastKey = "";
  }

  /** Where the mouse is, in GUI pixels from the player's eyes (x right, y down). */
  lookAt(dx: number, dy: number): void {
    this.dx = dx;
    this.dy = dy;
  }

  /** What you wear (shared/combat.ts packArmor). */
  setArmor(packed: number): void {
    if (packed === this.armor) return;
    this.armor = packed;
    this.lastKey = "";
  }

  start(): void {
    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      this.draw(performance.now() / 50);
    };
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  /** Draw at `ticks` (20 per second): the arms' idle sway needs a few frames a second, the mouse needs every one. */
  draw(ticks: number): void {
    const k = this.k;
    if (!k) return;
    const t = Math.floor(ticks * 2) / 2; // the sway moves in half ticks: 40 fps at most when the mouse is still
    const key = `${t}|${this.dx.toFixed(1)}|${this.dy.toFixed(1)}|${this.armor}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    const g = this.ctx;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.canvas.width, this.canvas.height);
    g.imageSmoothingEnabled = false;
    const D = Math.PI / 180;
    // the classic inventory: the body turns atan(dx/40) x 20 degrees, the head as much again; the same for the pitch,
    // and the whole model leans by it too (from the feet)
    const ax = Math.atan(this.dx / 40) * 20 * D;
    const ay = Math.atan(this.dy / 40) * 20 * D;
    const bodyR = mul(rotX(ay), rotY(ax));
    const swayZ = Math.cos(t * 0.09) * 0.05 + 0.05;
    const swayX = Math.sin(t * 0.067) * 0.05;
    const local: Partial<Record<PartId, M3>> = {
      head: mul(rotY(ax), rotX(ay)),
      armR: mul(rotZ(-swayZ), rotX(swayX)),
      armL: mul(rotZ(swayZ), rotX(-swayX)),
    };
    const px = 2 * k; // device pixels per skin pixel
    const [fx, fy] = this.feet;
    const ox = fx * k;
    const oy = fy * k;
    type Q = { depth: number; a: number; b: number; c: number; d: number; e: number; f: number; tex: Face["tex"]; src: HTMLCanvasElement[]; level: number };
    const list: Q[] = [];
    const emit = (part: (typeof PARTS)[number], fs: Face[], src: HTMLCanvasElement[], bias: number) => {
      const R = local[part.id] ?? I3;
      const A = mul(bodyR, R);
      const tr = app(bodyR, sub(part.pivot, app(R, part.pivot)));
      for (const f of fs) {
        const n = app(A, f.n);
        if (n[2] <= 1e-4) continue; // facing away
        const U = app(A, f.u);
        const V = app(A, f.v);
        const P = add(app(A, f.p0), tr);
        const [, , tw, th] = f.tex;
        const centre = add(P, add(scale(U, tw / 2), scale(V, th / 2)));
        // light: brightest on top, a little less facing you, darker on the sides, darkest underneath
        const shade = Math.max(0.45, Math.min(1, 0.6 + 0.32 * n[2] + 0.4 * n[1]));
        const level = Math.round(((shade - 0.45) / 0.55) * (LEVELS - 1));
        list.push({ depth: centre[2] + bias, a: U[0] * px, b: -U[1] * px, c: V[0] * px, d: -V[1] * px, e: ox + P[0] * px, f: oy - P[1] * px, tex: f.tex, src, level });
      }
    };
    const skin = shaded(this.skin);
    PARTS.forEach((part, i) => emit(part, SKIN_FACES[i], skin, 0));
    for (const piece of PIECES) {
      const mat = wornMaterial(this.armor, piece.slot);
      if (mat < 0) continue;
      const src = shaded(armorCanvas(mat, piece.layer));
      for (const part of PARTS) if (piece.parts.includes(part.id)) emit(part, faces(part.min, part.max, ARMOR_BOX[part.id], piece.grow), src, 0.01 + piece.grow * 0.01);
    }
    list.sort((p, q) => p.depth - q.depth);
    const grow = 0.6 / px; // half a device pixel over each edge, so neighbouring faces leave no hairline seams
    for (const q of list) {
      g.setTransform(q.a, q.b, q.c, q.d, q.e, q.f);
      const [sx, sy, sw, sh] = q.tex;
      g.drawImage(q.src[q.level], sx, sy, sw, sh, -grow, -grow, sw + grow * 2, sh + grow * 2);
    }
    g.setTransform(1, 0, 0, 1, 0, 0);
  }
}
