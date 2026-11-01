// Night mobs (protocol v6) as blocky models with original textures painted in code:
//   Shambler: ash-lavender skin, a torn sackcloth hood and tunic with a rope belt, ragged trousers, bare shins, and
//             amber eyes that glow in the dark; it walks with its arms reaching forward when it has seen you
//   Rattler:  a bone figure under a plum hooded cloak, ember eyes, ribs and a spine, holding a bow it raises and
//             draws to shoot
//   Skitter:  a low indigo crawler with a striped abdomen, eight jointed legs, mandibles and four teal eyes
// Snapshots are interpolated ~150 ms behind like the animals; limbs follow the speed, a hit flashes them red, the
// dying ones tip over, and the eyes keep glowing in the dark (texels the entity shader draws unlit).

import * as THREE from "three";
import { MF, MOB, MOB_SPECS } from "../../../shared/mobs.ts";
import type { AnimalSnap } from "../../../shared/animals.ts";
import { Painter, boxGeometry, faces, type BoxDef, type Face } from "./animals.ts";
import { animateFire, fireGeometry, fireMaterial } from "./fire.ts";
import { entityMaterial } from "./shaders.ts";
import { canvasTexture } from "./textures.ts";

const PX = 1 / 16;
const GLOW = 191; // texel alpha the shader draws unlit

type Put = (x: number, y: number, c: string, a?: number) => void;

/** Paint one face of a box in face-local texels (alpha: 255 solid, 0 a hole, GLOW unlit). */
function face(p: Painter, b: BoxDef, f: Face, fn: (put: Put, w: number, h: number) => void): void {
  const [x0, y0, w, h] = faces(b)[f];
  fn((x, y, c, a = 255) => {
    if (x >= 0 && y >= 0 && x < w && y < h) p.px(x0 + x, y0 + y, c, a === 255 ? 0.035 : 0, a);
  }, w, h);
}

/** Paint every face with a base colour (and a little noise), then details per face. */
function box(p: Painter, b: BoxDef, base: string, detail?: (put: Put, w: number, h: number, f: Face) => void, jitter = 0.05): void {
  for (const f of ["top", "bottom", "front", "back", "left", "right"] as Face[]) {
    const [x0, y0, w, h] = faces(b)[f];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) p.px(x0 + x, y0 + y, base, jitter);
    if (detail) face(p, b, f, (put, ww, hh) => detail(put, ww, hh, f));
  }
}

/** Clear a face to nothing (holes in hoods and cloaks). */
function clear(p: Painter, b: BoxDef, f: Face): void {
  face(p, b, f, (put, w, h) => {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) put(x, y, "#000000", 0);
  });
}

// ------------------------------------------------------------------ layouts (UVs in a 64 x 64 texture)

const H_HEAD: BoxDef = { u: 0, v: 0, w: 8, h: 8, d: 8 };
const H_HOOD: BoxDef = { u: 32, v: 0, w: 8, h: 8, d: 8 };
const H_BODY: BoxDef = { u: 16, v: 16, w: 8, h: 12, d: 4 };
const H_ARM_R: BoxDef = { u: 40, v: 16, w: 4, h: 12, d: 4 };
const H_ARM_L: BoxDef = { u: 32, v: 48, w: 4, h: 12, d: 4 };
const H_LEG_R: BoxDef = { u: 0, v: 16, w: 4, h: 12, d: 4 };
const H_LEG_L: BoxDef = { u: 16, v: 48, w: 4, h: 12, d: 4 };

const R_BONE_ARM: BoxDef = { u: 40, v: 16, w: 2, h: 12, d: 2 };
const R_BONE_LEG: BoxDef = { u: 0, v: 16, w: 2, h: 12, d: 2 };
const R_CAPE: BoxDef = { u: 0, v: 32, w: 8, h: 14, d: 1 };
const R_BOW = { x: 48, y: 48, w: 16, h: 16 }; // a sprite for a flat quad

const S_THORAX: BoxDef = { u: 0, v: 0, w: 6, h: 6, d: 6 };
const S_ABDOMEN: BoxDef = { u: 0, v: 12, w: 10, h: 8, d: 12 };
const S_HEAD: BoxDef = { u: 32, v: 0, w: 8, h: 7, d: 7 };
const S_LEG: BoxDef = { u: 24, v: 32, w: 14, h: 2, d: 2 };
const S_FANG: BoxDef = { u: 0, v: 40, w: 2, h: 3, d: 2 };

interface Part {
  name: string;
  box: BoxDef;
  at: [number, number, number]; // box centre relative to its pivot (px)
  pivot: [number, number, number]; // pivot relative to the feet (px)
  parent?: string;
  grow?: number;
}

// ------------------------------------------------------------------ painting

function paintShambler(p: Painter): void {
  const skin = "#8d8299";
  const skinD = "#776d85";
  const skinL = "#a89db5";
  const cloth = "#6e5a3c";
  const clothD = "#57462e";
  const stitch = "#3f3222";
  const hood = "#5c4a33";
  const hoodD = "#3d3022";
  box(p, H_HEAD, skin, (put, w, h, f) => {
    if (f === "front") {
      for (const x of [1, 2, 5, 6]) put(x, 3, "#2a2233");
      for (const x of [1, 2, 5, 6]) put(x, 4, "#3a3044");
      put(2, 3, "#ffb347", GLOW); // the eyes glow amber
      put(5, 3, "#ffb347", GLOW);
      put(3, 5, skinD);
      put(4, 5, skinD);
      for (let x = 2; x <= 5; x++) put(x, 6, x % 2 ? "#3a2a2e" : skinL); // a stitched mouth
      for (let x = 0; x < w; x++) put(x, h - 1, skinD);
    }
    if (f === "top") for (let k = 0; k < 9; k++) put((k * 5) % w, (k * 3) % h, "#4a4152");
    if (f === "left" || f === "right") put(4, 4, skinD);
  });
  // the hood: cloth all round, open at the face and the bottom
  box(p, H_HOOD, hood, (put, w, h, f) => {
    if (f === "front") {
      for (let y = 2; y < h; y++) for (let x = 1; x < w - 1; x++) put(x, y, "#000000", 0);
      for (let x = 1; x < w - 1; x++) put(x, 1, hoodD);
      for (let y = 2; y < h; y++) {
        put(0, y, hoodD);
        put(w - 1, y, hoodD);
      }
    }
    if (f === "left" || f === "right" || f === "back") for (let x = 0; x < w; x++) if (x % 3 === 1) put(x, h - 1, "#000000", 0); // ragged hem
    if (f === "top") for (let k = 0; k < 5; k++) put((k * 3 + 1) % w, (k * 5 + 2) % h, hoodD);
  }, 0.07);
  clear(p, H_HOOD, "bottom");
  box(p, H_BODY, cloth, (put, w, h, f) => {
    // patches, stitches, a rope belt, a frayed hem
    if (f === "front" || f === "back") {
      put(1, 2, clothD);
      put(2, 2, clothD);
      put(1, 3, clothD);
      put(5, 5, clothD);
      put(6, 5, clothD);
      put(6, 6, clothD);
      for (let y = 1; y < 7; y += 2) put(4, y, stitch);
      for (let x = 0; x < w; x++) put(x, 8, x === 3 || x === 4 ? "#7d6c48" : "#9b8a63");
      for (let x = 0; x < w; x++) if (x % 2 === 0) put(x, h - 1, clothD);
    }
    if (f === "front") {
      put(3, 0, skin);
      put(4, 0, skin);
      put(4, 9, "#9b8a63"); // the knot's ends
      put(4, 10, "#9b8a63");
    }
    if (f === "back") for (let y = 3; y < 6; y++) put(5, y, skinD); // a tear
    if (f === "left" || f === "right") for (let y = 0; y < h; y++) if (y === 8) for (let x = 0; x < w; x++) put(x, y, "#9b8a63");
  });
  for (const arm of [H_ARM_R, H_ARM_L])
    box(p, arm, skin, (put, w, h, f) => {
      if (f === "top") for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) put(x, y, cloth);
      if (f !== "top" && f !== "bottom") {
        for (let y = 0; y < 4; y++) for (let x = 0; x < w; x++) put(x, y, cloth);
        for (let x = 0; x < w; x++) if (x % 2) put(x, 4, cloth); // a torn sleeve
        for (let x = 0; x < w; x++) put(x, h - 2, skinD);
        put(1, h - 1, "#b8acc4");
      }
    });
  for (const leg of [H_LEG_R, H_LEG_L])
    box(p, leg, "#3d3a40", (put, w, h, f) => {
      if (f === "top") return;
      for (let y = 8; y < h; y++) for (let x = 0; x < w; x++) put(x, y, f === "bottom" ? skinD : skin); // bare shins
      for (let x = 0; x < w; x++) if (x % 2 === 0) put(x, 8, "#3d3a40"); // a ragged edge
      if (f !== "bottom") for (let x = 0; x < w; x++) put(x, h - 1, skinD);
    });
}

function paintRattler(p: Painter): void {
  const bone = "#e7dcc4";
  const boneD = "#cbbf9f";
  const dark = "#1c1a22";
  const cloak = "#3b2a4a";
  const cloakD = "#2c1f38";
  const cloakL = "#4b3860";
  box(p, H_HEAD, bone, (put, w, h, f) => {
    if (f === "front") {
      for (let y = 2; y <= 4; y++) for (const x of [1, 2, 5, 6]) put(x, y, dark);
      put(2, 3, "#ff5a2e", GLOW); // ember eyes
      put(5, 3, "#ff5a2e", GLOW);
      put(3, 5, dark);
      put(4, 5, dark);
      for (let x = 1; x <= 6; x++) put(x, 6, x % 2 ? bone : "#3a3530"); // teeth
      for (let x = 0; x < w; x++) put(x, h - 1, boneD);
    } else if (f !== "bottom") {
      put(2, 2, "#b8ad90");
      put(3, 3, "#b8ad90");
      put(5, 1, "#b8ad90");
    }
  });
  box(p, H_HOOD, cloak, (put, w, h, f) => {
    if (f === "front") {
      for (let y = 1; y < h; y++) for (let x = 1; x < w - 1; x++) put(x, y, "#000000", 0);
      for (let x = 0; x < w; x++) put(x, 0, cloakL);
      for (let y = 1; y < h; y++) {
        put(0, y, cloakL);
        put(w - 1, y, cloakL);
      }
    }
    if (f === "top") for (let k = 0; k < 6; k++) put((k * 3) % w, (k * 5 + 1) % h, cloakD);
  }, 0.06);
  clear(p, H_HOOD, "bottom");
  // the ribcage: a spine, ribs, a pelvis; the cloak hangs down the back
  box(p, H_BODY, dark, (put, w, h, f) => {
    if (f === "front") {
      for (let y = 0; y < 9; y++) {
        put(3, y, bone);
        put(4, y, bone);
      }
      for (const y of [1, 3, 5, 7]) for (let x = 1; x < w - 1; x++) put(x, y, x === 3 || x === 4 ? bone : boneD);
      for (let y = 9; y < h; y++) for (let x = 1; x < w - 1; x++) put(x, y, y === 9 || x === 1 || x === w - 2 ? bone : dark);
    } else if (f === "back") {
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) put(x, y, cloak);
    } else if (f === "top") {
      for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) put(x, y, y >= h - 2 ? cloak : boneD);
    } else if (f === "left" || f === "right") {
      for (const y of [1, 3, 5, 7]) put(1, y, boneD);
      for (let y = 0; y < h; y++) put(w - 1, y, cloakD);
    }
  });
  for (const b of [R_BONE_ARM, R_BONE_LEG])
    box(p, b, bone, (put, w, h, f) => {
      if (f === "top" || f === "bottom") return;
      for (let x = 0; x < w; x++) {
        put(x, 5, boneD);
        put(x, 6, boneD);
        put(x, h - 1, boneD);
      }
    });
  box(p, R_CAPE, cloak, (put, w, h, f) => {
    if (f === "front" || f === "back") {
      for (let y = 2; y < h; y += 3) put(2, y, cloakD);
      for (let y = 1; y < h; y += 4) put(5, y, cloakL);
      for (let x = 0; x < w; x++) if (x % 3 === 2) put(x, h - 1, "#000000", 0);
    }
  }, 0.06);
  // the bow: a curved limb of dark wood with a pale string (a sprite with holes)
  const B0 = R_BOW;
  for (let y = 0; y < B0.h; y++) for (let x = 0; x < B0.w; x++) p.px(B0.x + x, B0.y + y, "#000000", 0, 0);
  const limb: [number, number][] = [[9, 1], [10, 2], [10, 3], [11, 4], [11, 5], [11, 6], [11, 7], [11, 8], [11, 9], [11, 10], [11, 11], [10, 12], [10, 13], [9, 14]];
  for (const [x, y] of limb) {
    p.px(B0.x + x, B0.y + y, y === 7 || y === 8 ? "#3b2a1a" : "#6b4a2a", 0.05);
    p.px(B0.x + x - 1, B0.y + y, "#8a6238", 0.05);
  }
  for (let y = 1; y <= 14; y++) p.px(B0.x + 6, B0.y + y, "#d9d4c7", 0.02);
}

function paintSkitter(p: Painter): void {
  const body = "#24213a";
  const thorax = "#2b2742";
  const stripe = "#6c4fa3";
  const speck = "#9b8cc9";
  box(p, S_THORAX, thorax, (put, w, h, f) => {
    if (f === "top") for (let x = 1; x < w - 1; x++) put(x, Math.floor(h / 2), stripe);
  });
  box(p, S_ABDOMEN, body, (put, w, h, f) => {
    if (f === "top") {
      // chevrons down the back
      for (let k = 0; k < 4; k++) {
        const y = 1 + k * 3;
        for (let x = 0; x < w; x++) if (Math.abs(x - (w - 1) / 2) <= 1 + k * 0.5 && Math.abs(x - (w - 1) / 2) >= k * 0.5 - 0.5) put(x, y, stripe);
      }
      for (let k = 0; k < 6; k++) put((k * 7 + 2) % w, (k * 5 + 1) % h, speck);
    }
    if (f === "back") {
      for (let x = 2; x < w - 2; x++) put(x, 2, stripe);
      put(4, 5, speck);
      put(5, 5, speck);
    }
    if (f === "left" || f === "right") for (let x = 1; x < w - 1; x += 3) put(x, 1, stripe);
  });
  box(p, S_HEAD, "#2e2a46", (put, w, _h, f) => {
    if (f === "front") {
      for (const [x, y] of [[2, 2], [5, 2], [3, 3], [4, 3]]) put(x, y, "#5ff2d6", GLOW); // four teal eyes
      put(1, 1, "#5ff2d6", GLOW);
      put(6, 1, "#5ff2d6", GLOW);
      for (let x = 0; x < w; x++) put(x, 5, "#3a3555");
    }
    if (f === "top") for (let x = 2; x < w - 2; x++) put(x, 3, stripe);
  });
  box(p, S_LEG, "#1b1a2a", (put, w, h, f) => {
    if (f === "top" || f === "front" || f === "back") {
      for (let y = 0; y < h; y++) {
        put(5, y, "#3a3555");
        put(6, y, "#3a3555");
        put(w - 1, y, "#3a3555");
      }
    }
  });
  box(p, S_FANG, "#3a3555", (put, w, h, f) => {
    if (f !== "top") for (let x = 0; x < w; x++) put(x, h - 1, speck);
  });
}

// ------------------------------------------------------------------ models

interface Model {
  parts: Part[];
  paint: (p: Painter) => void;
}

const LEG_Z = [2.5, 0.8, -0.8, -2.5];
const LEG_FAN = [0.75, 0.28, -0.28, -0.75];

const MODELS: Model[] = [
  {
    // Shambler
    parts: [
      { name: "body", box: H_BODY, at: [0, -6, 0], pivot: [0, 24, 0] },
      { name: "head", box: H_HEAD, at: [0, 4, 0], pivot: [0, 24, 0] },
      { name: "hood", box: H_HOOD, at: [0, 4, 0], pivot: [0, 24, 0], parent: "head", grow: 0.5 },
      { name: "armR", box: H_ARM_R, at: [0, -4, 0], pivot: [-6, 22, 0] },
      { name: "armL", box: H_ARM_L, at: [0, -4, 0], pivot: [6, 22, 0] },
      { name: "legR", box: H_LEG_R, at: [0, -6, 0], pivot: [-2, 12, 0] },
      { name: "legL", box: H_LEG_L, at: [0, -6, 0], pivot: [2, 12, 0] },
    ],
    paint: paintShambler,
  },
  {
    // Rattler
    parts: [
      { name: "body", box: H_BODY, at: [0, -6, 0], pivot: [0, 24, 0] },
      { name: "cape", box: R_CAPE, at: [0, -7, -2.6], pivot: [0, 24, 0], parent: "body" },
      { name: "head", box: H_HEAD, at: [0, 4, 0], pivot: [0, 24, 0] },
      { name: "hood", box: H_HOOD, at: [0, 4, 0], pivot: [0, 24, 0], parent: "head", grow: 0.5 },
      { name: "armR", box: R_BONE_ARM, at: [0, -4, 0], pivot: [-5, 22, 0] },
      { name: "armL", box: R_BONE_ARM, at: [0, -4, 0], pivot: [5, 22, 0] },
      { name: "legR", box: R_BONE_LEG, at: [0, -6, 0], pivot: [-2, 12, 0] },
      { name: "legL", box: R_BONE_LEG, at: [0, -6, 0], pivot: [2, 12, 0] },
    ],
    paint: paintRattler,
  },
  {
    // Skitter
    parts: [
      { name: "thorax", box: S_THORAX, at: [0, 0, 0], pivot: [0, 9, 0] },
      { name: "abdomen", box: S_ABDOMEN, at: [0, 1, -6], pivot: [0, 9, -3] },
      { name: "head", box: S_HEAD, at: [0, 0, 3.5], pivot: [0, 9, 3] },
      { name: "fangR", box: S_FANG, at: [-1.5, -3.5, 7.5], pivot: [0, 9, 3], parent: "head" },
      { name: "fangL", box: S_FANG, at: [1.5, -3.5, 7.5], pivot: [0, 9, 3], parent: "head" },
      ...[0, 1, 2, 3].flatMap((i): Part[] => [
        { name: `legR${i}`, box: S_LEG, at: [-7, 0, 0], pivot: [-3, 9, LEG_Z[i]] },
        { name: `legL${i}`, box: S_LEG, at: [7, 0, 0], pivot: [3, 9, LEG_Z[i]] },
      ]),
    ],
    paint: paintSkitter,
  },
];

const textures: THREE.Texture[] = [];
const geometries = new Map<string, THREE.BufferGeometry>();

function textureFor(kind: number): THREE.Texture {
  if (!textures[kind]) {
    const p = new Painter(7300 + kind);
    MODELS[kind].paint(p);
    textures[kind] = canvasTexture(p.done());
  }
  return textures[kind];
}

function geometryFor(b: BoxDef, grow = 0): THREE.BufferGeometry {
  const k = `${b.u},${b.v},${b.w},${b.h},${b.d},${grow}`;
  let g = geometries.get(k);
  if (!g) {
    g = boxGeometry(b, grow);
    geometries.set(k, g);
  }
  return g;
}

/** The bow: a flat quad with the sprite (seen from both sides). */
function bowGeometry(): THREE.BufferGeometry {
  let g = geometries.get("bow");
  if (!g) {
    g = new THREE.PlaneGeometry(14 * PX, 14 * PX);
    const uv = g.getAttribute("uv") as THREE.BufferAttribute;
    const { x, y, w, h } = R_BOW;
    const u0 = x / 64;
    const u1 = (x + w) / 64;
    const v0 = 1 - y / 64;
    const v1 = 1 - (y + h) / 64;
    uv.setXY(0, u0, v0);
    uv.setXY(1, u1, v0);
    uv.setXY(2, u0, v1);
    uv.setXY(3, u1, v1);
    uv.needsUpdate = true;
    geometries.set("bow", g);
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

export class MobView {
  readonly id: number;
  readonly kind: number;
  readonly root = new THREE.Group(); // where it stands (the model turns and tips over inside; its fire stays upright)
  private body = new THREE.Group();
  private fire: THREE.Mesh | null = null;
  private parts = new Map<string, THREE.Group>();
  private mat: THREE.ShaderMaterial;
  private bowMat: THREE.ShaderMaterial | null = null;
  private bow: THREE.Mesh | null = null;
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
  private reach = 0; // arms forward (Shambler), bow up (Rattler)
  private attack = 0;
  private deadAmt = 0;
  private age = Math.random() * 100;
  /** Until when our own hit shows its red flash (before the server's HURT flag arrives). */
  localHurt = 0;

  constructor(s: AnimalSnap) {
    this.id = s.id;
    this.kind = s.kind;
    this.mat = entityMaterial(textureFor(s.kind));
    for (const p of MODELS[s.kind].parts) {
      const mesh = new THREE.Mesh(geometryFor(p.box, p.grow ?? 0), this.mat);
      mesh.position.set(p.at[0] * PX, p.at[1] * PX, p.at[2] * PX);
      if (p.parent) {
        this.parts.get(p.parent)!.add(mesh);
        continue;
      }
      const pivot = new THREE.Group();
      pivot.position.set(p.pivot[0] * PX, p.pivot[1] * PX, p.pivot[2] * PX);
      pivot.add(mesh);
      this.parts.set(p.name, pivot);
      this.body.add(pivot);
    }
    this.root.add(this.body);
    if (s.kind === MOB.RATTLER) {
      this.bowMat = entityMaterial(textureFor(s.kind));
      this.bowMat.side = THREE.DoubleSide;
      const bow = new THREE.Mesh(bowGeometry(), this.bowMat);
      // in the left hand; it stays upright and faces forward whatever the arm does (update counter-turns it)
      bow.position.set(0, -10.5 * PX, 0);
      this.parts.get("armL")!.add(bow);
      this.bow = bow;
    }
    if (s.kind === MOB.SKITTER) {
      for (let i = 0; i < 4; i++) {
        this.parts.get(`legR${i}`)!.rotation.set(0, LEG_FAN[i], 0.6, "YZX");
        this.parts.get(`legL${i}`)!.rotation.set(0, -LEG_FAN[i], -0.6, "YZX");
      }
    }
    this.x = this.lastX = s.x;
    this.y = s.y;
    this.z = this.lastZ = s.z;
    this.yaw = s.yaw;
    this.flags = s.flags;
    this.root.position.set(this.x, this.y, this.z);
    this.body.rotation.y = (-this.yaw * Math.PI) / 180;
  }

  get spec() {
    return MOB_SPECS[this.kind];
  }

  get burning(): boolean {
    return (this.flags & MF.BURN) !== 0;
  }

  push(s: AnimalSnap, t: number): void {
    this.snaps.push({ t, x: s.x, y: s.y, z: s.z, yaw: s.yaw, flags: s.flags });
    if (this.snaps.length > 20) this.snaps.shift();
  }

  /** 20 Hz: limbs from the distance moved, and the poses easing in and out. */
  tick(): void {
    const dx = this.x - this.lastX;
    const dz = this.z - this.lastZ;
    this.lastX = this.x;
    this.lastZ = this.z;
    const climbing = (this.flags & MF.CLIMB) !== 0;
    const dist = Math.min(1, Math.sqrt(dx * dx + dz * dz) * 5 + (climbing ? 0.8 : 0));
    this.limbAmt += (dist - this.limbAmt) * 0.4;
    this.limbPos += this.limbAmt * (this.kind === MOB.SKITTER ? 1.8 : 1);
    this.reach += ((this.flags & MF.AGGRO ? 1 : 0) - this.reach) * 0.2;
    this.attack += ((this.flags & MF.ATTACK ? 1 : 0) - this.attack) * 0.35;
    this.age++;
  }

  /** Interpolate, pose, and light it; `camYaw` (degrees) turns its fire to face the camera. */
  update(renderTime: number, partial: number, light: [number, number], camYaw = 0): void {
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
    this.body.rotation.set(0, (-this.yaw * Math.PI) / 180, 0);
    // on fire (the undead in daylight): the classic sheets of flame around it
    if (this.burning) {
      if (!this.fire) {
        this.fire = new THREE.Mesh(fireGeometry(this.spec.w, this.spec.h), fireMaterial());
        this.root.add(this.fire);
      }
      this.fire.visible = true;
      this.fire.rotation.y = (-camYaw * Math.PI) / 180;
      animateFire(performance.now());
    } else if (this.fire) this.fire.visible = false;
    const lp = this.limbPos + this.limbAmt * partial;
    const la = this.limbAmt;
    const t = this.age + partial;
    const P = this.parts;
    if (this.kind === MOB.SKITTER) {
      for (let i = 0; i < 4; i++) {
        const ph = i % 2 === 0 ? 0 : Math.PI;
        const swing = Math.cos(lp * 0.6662 * 2 + ph + i * 0.6) * 0.4 * la;
        const lift = Math.max(0, Math.sin(lp * 0.6662 * 2 + ph + i * 0.6)) * 0.4 * la;
        P.get(`legR${i}`)!.rotation.set(0, LEG_FAN[i] + swing, 0.6 - lift, "YZX");
        P.get(`legL${i}`)!.rotation.set(0, -LEG_FAN[i] - swing, -0.6 + lift, "YZX");
      }
      P.get("head")!.rotation.x = Math.sin(t * 0.9) * 0.15 * this.attack - 0.05;
      P.get("abdomen")!.rotation.x = Math.sin(t * 0.08) * 0.04;
    } else {
      const legR = P.get("legR")!;
      const legL = P.get("legL")!;
      legR.rotation.x = Math.cos(lp * 0.6662) * 1.4 * la;
      legL.rotation.x = Math.cos(lp * 0.6662 + Math.PI) * 1.4 * la;
      const armR = P.get("armR")!;
      const armL = P.get("armL")!;
      const swingR = Math.cos(lp * 0.6662 + Math.PI) * 0.8 * la;
      const swingL = Math.cos(lp * 0.6662) * 0.8 * la;
      const sway = Math.sin(t * 0.067) * 0.05;
      const sideZ = Math.cos(t * 0.09) * 0.05 + 0.05;
      if (this.kind === MOB.SHAMBLER) {
        // arms reach forward once it has seen you, and lunge when it hits
        const fwd = -Math.PI / 2 + 0.12;
        const lunge = Math.sin(Math.min(1, this.attack) * Math.PI) * 0.6;
        armR.rotation.set((swingR * 0.5 + 0.15) * (1 - this.reach) + (fwd + sway - lunge) * this.reach, 0, -sideZ);
        armL.rotation.set((swingL * 0.5 + 0.15) * (1 - this.reach) + (fwd - sway - lunge) * this.reach, 0, sideZ);
        P.get("body")!.rotation.x = 0.12 + 0.08 * this.reach;
        P.get("head")!.rotation.set(0.1 + Math.sin(t * 0.05) * 0.04, Math.sin(t * 0.031) * 0.12, 0);
      } else {
        // Rattler: the bow comes up and is drawn
        const up = Math.max(this.reach * 0.6, this.attack);
        armL.rotation.set(swingL * (1 - up) - (Math.PI / 2) * up, 0.1 * up, sideZ * (1 - up));
        armR.rotation.set(swingR * (1 - up) - (Math.PI / 2 - 0.25) * up, -0.35 * up * this.attack, -sideZ * (1 - up));
        if (this.bow) this.bow.rotation.set(-armL.rotation.x, -armL.rotation.y, -armL.rotation.z, "ZYX");
        P.get("head")!.rotation.set(Math.sin(t * 0.05) * 0.03, Math.sin(t * 0.027) * 0.15 * (1 - up), 0);
      }
    }
    // dying: it tips over, red
    const dead = (this.flags & MF.DEAD) !== 0;
    this.deadAmt = dead ? Math.min(1, this.deadAmt + 0.08) : 0;
    if (this.deadAmt > 0) this.body.rotateZ((Math.PI / 2) * Math.min(1, this.deadAmt * this.deadAmt * 1.6));
    const hurt = dead || (this.flags & MF.HURT) !== 0 || performance.now() < this.localHurt;
    for (const m of [this.mat, this.bowMat]) {
      if (!m) continue;
      m.uniforms.uTint.value.setRGB(1, hurt ? 0.45 : 1, hurt ? 0.45 : 1);
      m.uniforms.uLight.value.set(light[0], light[1]);
    }
  }

  dispose(): void {
    this.mat.dispose();
    this.bowMat?.dispose();
  }
}
