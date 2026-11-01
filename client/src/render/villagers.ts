// Villagers (update 11) as blocky folk of our own design: a round-cheeked face with a friendly smile, a hat and work
// clothes that tell the job, painted in code:
//   Farmer     a wide straw sun hat with a red band, a linen shirt under green overalls
//   Smith      a flat grey cap, a charcoal shirt under a leather apron
//   Librarian  a tall plum cap with a gold band, round gold spectacles, an indigo robe with gold trim
//   Fisher     a yellow rain hat, a blue coat with pale toggles, navy trousers
//   Mason      a red kerchief with white spots, a grey shirt and a dusty apron with a pocket
// Skin and hair vary from villager to villager. Snapshots are interpolated like the animals; limbs follow the speed,
// a customer gets a little wave of the hand, a poke flashes them red. A name tag (name and job) floats over them
// when you are near.

import * as THREE from "three";
import type { AnimalSnap } from "../../../shared/animals.ts";
import { JOBS, VF } from "../../../shared/villagers.ts";
import { Painter, boxGeometry, faces, type BoxDef, type Face } from "./animals.ts";
import { entityMaterial } from "./shaders.ts";
import { canvasTexture } from "./textures.ts";

const PX = 1 / 16;

type Put = (x: number, y: number, c: string) => void;

function face(p: Painter, b: BoxDef, f: Face, fn: (put: Put, w: number, h: number) => void): void {
  const [x0, y0, w, h] = faces(b)[f];
  fn((x, y, c) => {
    if (x >= 0 && y >= 0 && x < w && y < h) p.px(x0 + x, y0 + y, c, 0.03);
  }, w, h);
}

function box(p: Painter, b: BoxDef, base: string, detail?: (put: Put, w: number, h: number, f: Face) => void, jitter = 0.04): void {
  for (const f of ["top", "bottom", "front", "back", "left", "right"] as Face[]) {
    const [x0, y0, w, h] = faces(b)[f];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) p.px(x0 + x, y0 + y, base, jitter);
    if (detail) face(p, b, f, (put, ww, hh) => detail(put, ww, hh, f));
  }
}

// ------------------------------------------------------------------ layout (px, UVs in a 64 x 64 texture)

const HEAD: BoxDef = { u: 0, v: 0, w: 8, h: 8, d: 8 };
const BODY: BoxDef = { u: 16, v: 16, w: 8, h: 10, d: 4 };
const ARM_R: BoxDef = { u: 40, v: 16, w: 3, h: 10, d: 3 };
const ARM_L: BoxDef = { u: 52, v: 16, w: 3, h: 10, d: 3 };
const LEG_R: BoxDef = { u: 0, v: 16, w: 4, h: 10, d: 4 };
const LEG_L: BoxDef = { u: 0, v: 32, w: 4, h: 10, d: 4 };

interface HatPart {
  box: BoxDef;
  at: [number, number, number]; // centre, relative to the head's pivot (the neck)
}

/** Hats per job: their boxes live in the texture's lower right (32 .. 64). */
const HATS: HatPart[][] = [
  [
    { box: { u: 16, v: 32, w: 12, h: 1, d: 12 }, at: [0, 8.5, 0] }, // farmer: the straw brim
    { box: { u: 16, v: 46, w: 6, h: 3, d: 6 }, at: [0, 10.5, 0] }, // and its crown
  ],
  [
    { box: { u: 16, v: 32, w: 9, h: 2, d: 9 }, at: [0, 8, 0] }, // smith: a flat cap
    { box: { u: 40, v: 46, w: 4, h: 1, d: 3 }, at: [0, 7.5, 5.5] }, // with a visor
  ],
  [
    { box: { u: 16, v: 32, w: 9, h: 1, d: 9 }, at: [0, 8, 0] }, // librarian: a gold band
    { box: { u: 16, v: 46, w: 6, h: 5, d: 6 }, at: [0, 10.5, 0] }, // under a tall plum cap
  ],
  [
    { box: { u: 16, v: 32, w: 10, h: 1, d: 11 }, at: [0, 8, 0.5] }, // fisher: the rain hat's brim, longer at the back
    { box: { u: 16, v: 46, w: 8, h: 3, d: 8 }, at: [0, 9.5, 0] },
  ],
  [{ box: { u: 16, v: 32, w: 9, h: 2, d: 9 }, at: [0, 7.5, 0] }], // mason: a kerchief
];

const SKINS = ["#e8b893", "#c98f66", "#8f5b3c", "#f1cba9", "#b07650"];
const HAIR = ["#4a2f1c", "#1f1a17", "#a3532a", "#8c8780", "#6b4a2a", "#d7b56d"];

interface Outfit {
  shirt: string;
  sleeve: string;
  trousers: string;
  boots: string;
  front?: (put: Put, w: number, h: number) => void; // the body's front over the shirt
  back?: (put: Put, w: number, h: number) => void;
  hat: (p: Painter) => void;
}

const OUTFITS: Outfit[] = [
  {
    // farmer
    shirt: "#d9c9a3",
    sleeve: "#d9c9a3",
    trousers: "#4f7a3a",
    boots: "#5a3a22",
    front: (put, w, h) => {
      for (let y = 3; y < h; y++) for (let x = 1; x < w - 1; x++) put(x, y, "#4f7a3a"); // the bib
      for (let y = 0; y < 3; y++) {
        put(1, y, "#4f7a3a");
        put(w - 2, y, "#4f7a3a");
      }
      put(2, 3, "#c9b04a"); // brass buttons
      put(w - 3, 3, "#c9b04a");
      for (let x = 2; x < w - 2; x++) put(x, 6, "#3f6530"); // a pocket
    },
    back: (put, w, h) => {
      for (let y = 5; y < h; y++) for (let x = 0; x < w; x++) put(x, y, "#4f7a3a");
      for (let y = 0; y < 5; y++) {
        put(1 + y % 2, y, "#4f7a3a"); // crossed straps
        put(w - 2 - (y % 2), y, "#4f7a3a");
      }
    },
    hat: (p) => {
      const [brim, crown] = HATS[0];
      box(p, brim.box, "#e2c46a", (put, w, h, f) => {
        if (f === "top" || f === "bottom") for (let k = 0; k < 18; k++) put((k * 7) % w, (k * 5) % h, "#c9a94e");
      });
      box(p, crown.box, "#e2c46a", (put, w, h, f) => {
        if (f !== "top" && f !== "bottom") for (let x = 0; x < w; x++) put(x, h - 1, "#9c3b2a"); // the red band
        if (f === "top") put(2, 2, "#c9a94e");
      });
    },
  },
  {
    // smith
    shirt: "#3b3b40",
    sleeve: "#3b3b40",
    trousers: "#4a3524",
    boots: "#1f1b19",
    front: (put, w, h) => {
      for (let y = 2; y < h; y++) for (let x = 1; x < w - 1; x++) put(x, y, "#7a4f2e"); // the leather apron
      for (let y = 0; y < 2; y++) {
        put(2, y, "#5c3a20");
        put(w - 3, y, "#5c3a20");
      }
      for (let x = 1; x < w - 1; x++) put(x, 5, "#5c3a20"); // its belt
      put(3, 7, "#4a2f19");
      put(4, 8, "#4a2f19"); // a scorch mark
    },
    back: (put, w) => {
      for (let x = 0; x < w; x++) put(x, 5, "#5c3a20");
    },
    hat: (p) => {
      const [cap, visor] = HATS[1];
      box(p, cap.box, "#5a5550", (put, w, h, f) => {
        if (f === "top") for (let k = 0; k < 8; k++) put((k * 3 + 1) % w, (k * 5 + 2) % h, "#4a4642");
      });
      box(p, visor.box, "#46423e");
    },
  },
  {
    // librarian
    shirt: "#3d3f7a",
    sleeve: "#3d3f7a",
    trousers: "#3d3f7a",
    boots: "#2a2420",
    front: (put, w, h) => {
      for (let y = 0; y < h; y++) {
        put(3, y, "#c9a227"); // gold trim down the front
        put(4, y, y % 3 === 1 ? "#e8d49a" : "#c9a227");
      }
      for (let x = 0; x < w; x++) put(x, h - 1, "#2e2f5e");
    },
    back: (put, w, h) => {
      for (let x = 0; x < w; x++) put(x, h - 1, "#2e2f5e");
    },
    hat: (p) => {
      const [band, cap] = HATS[2];
      box(p, band.box, "#c9a227");
      box(p, cap.box, "#6b2f5f", (put, w, h, f) => {
        if (f === "top") put(Math.floor(w / 2), Math.floor(h / 2), "#c9a227"); // a gold button on top
        if (f !== "top" && f !== "bottom") for (let y = 1; y < h; y += 2) put(0, y, "#5a2650");
      });
    },
  },
  {
    // fisher
    shirt: "#2f5f8f",
    sleeve: "#2f5f8f",
    trousers: "#22314a",
    boots: "#2a2a2a",
    front: (put, w, h) => {
      for (let y = 0; y < h; y++) put(3, y, "#264d75");
      for (const y of [2, 5, 8]) {
        put(2, y, "#e8dcc0"); // toggles
        put(4, y, "#e8dcc0");
      }
      for (let x = 0; x < w; x++) put(x, h - 1, "#264d75");
    },
    hat: (p) => {
      const [brim, crown] = HATS[3];
      box(p, brim.box, "#e8c22a", (put, w, h, f) => {
        if (f === "top") for (let k = 0; k < 10; k++) put((k * 3) % w, (k * 7) % h, "#d2ad1e");
      });
      box(p, crown.box, "#e8c22a", (put, w, h, f) => {
        if (f !== "top" && f !== "bottom") for (let x = 0; x < w; x += 3) put(x, 1, "#d2ad1e"); // seams
      });
    },
  },
  {
    // mason
    shirt: "#8a8a86",
    sleeve: "#8a8a86",
    trousers: "#4e4e52",
    boots: "#3a2e24",
    front: (put, w, h) => {
      for (let y = 3; y < h; y++) for (let x = 1; x < w - 1; x++) put(x, y, "#b8b0a0"); // the dusty apron
      for (let x = 2; x < 6; x++) put(x, 6, "#9c9484"); // a pocket
      put(2, 5, "#7a7a76");
      put(5, 5, "#6e5a3c"); // a chisel and a pencil in it
      for (let k = 0; k < 6; k++) put(1 + ((k * 3) % 6), 7 + (k % 3), "#cfc8ba"); // stone dust
    },
    hat: (p) => {
      const [kerchief] = HATS[4];
      box(p, kerchief.box, "#b8322a", (put, w, h, f) => {
        for (let k = 0; k < 7; k++) put((k * 4 + 1) % w, (k * 3) % h, "#f2ece0"); // white spots
        void f;
      });
    },
  },
];

function paint(job: number, skin: number, hair: number): HTMLCanvasElement {
  const p = new Painter(9100 + job * 31 + skin * 7 + hair);
  const o = OUTFITS[job];
  const sk = SKINS[skin];
  const hr = HAIR[hair];
  box(p, HEAD, sk, (put, w, h, f) => {
    if (f === "top") for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) put(x, y, hr);
    if (f === "back") for (let y = 0; y < 5; y++) for (let x = 0; x < w; x++) put(x, y, hr);
    if (f === "left" || f === "right") for (let y = 0; y < 3; y++) for (let x = 0; x < w; x++) if (y < 2 || x > 3) put(x, y, hr);
    if (f === "front") {
      for (let x = 0; x < w; x++) put(x, 0, hr); // a fringe
      put(0, 1, hr);
      put(w - 1, 1, hr);
      // eyes, rosy cheeks and a small smile: our own friendly face
      put(2, 4, "#2b2118");
      put(5, 4, "#2b2118");
      put(2, 3, "#f6eee4");
      put(5, 3, "#f6eee4");
      put(1, 5, "#e4867a");
      put(6, 5, "#e4867a");
      // a smile: the corners up
      put(2, 6, "#8a4636");
      put(5, 6, "#8a4636");
      put(3, 7, "#8a4636");
      put(4, 7, "#8a4636");
      if (job === 2) {
        // the librarian's spectacles: thin gold rims beside and over the eyes, a bridge between
        for (const [x, y] of [[1, 4], [3, 4], [4, 4], [6, 4], [2, 3], [5, 3]]) put(x, y, "#d4ad2c");
      }
    }
  });
  box(p, BODY, o.shirt, (put, w, h, f) => {
    if (f === "front" && o.front) o.front(put, w, h);
    if (f === "back" && o.back) o.back(put, w, h);
    if (f === "front") {
      put(3, 0, sk); // the open collar
      put(4, 0, sk);
    }
  });
  for (const arm of [ARM_R, ARM_L])
    box(p, arm, o.sleeve, (put, w, h, f) => {
      if (f === "bottom") for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) put(x, y, sk);
      if (f !== "top" && f !== "bottom") {
        for (let y = h - 2; y < h; y++) for (let x = 0; x < w; x++) put(x, y, sk); // hands
      }
    });
  for (const leg of [LEG_R, LEG_L])
    box(p, leg, o.trousers, (put, w, h, f) => {
      if (f === "bottom") for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) put(x, y, o.boots);
      if (f !== "top" && f !== "bottom") for (let y = h - 2; y < h; y++) for (let x = 0; x < w; x++) put(x, y, o.boots);
    });
  o.hat(p);
  return p.done();
}

const textures = new Map<string, THREE.Texture>();
function textureFor(job: number, skin: number, hair: number): THREE.Texture {
  const k = `${job}:${skin}:${hair}`;
  let t = textures.get(k);
  if (!t) textures.set(k, (t = canvasTexture(paint(job, skin, hair))));
  return t;
}

const geometries = new Map<string, THREE.BufferGeometry>();
function geometryFor(b: BoxDef): THREE.BufferGeometry {
  const k = `${b.u},${b.v},${b.w},${b.h},${b.d}`;
  let g = geometries.get(k);
  if (!g) geometries.set(k, (g = boxGeometry(b)));
  return g;
}

/** A villager's name tag: the name, and the job under it in gold. Hidden behind walls (unlike players'). */
export function villagerTag(name: string, job: number): THREE.Sprite {
  const c = document.createElement("canvas");
  const top = `32px KenneyMini, monospace`;
  const sub = `22px KenneyMini, monospace`;
  const g = c.getContext("2d")!;
  g.font = top;
  const w1 = g.measureText(name).width;
  g.font = sub;
  const jobName = JOBS[job]?.name ?? "Villager";
  const w2 = g.measureText(jobName).width;
  const w = Math.ceil(Math.max(w1, w2)) + 20;
  c.width = w;
  c.height = 70;
  g.fillStyle = "rgba(0,0,0,0.38)";
  g.fillRect(0, 0, w, 70);
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.font = top;
  g.fillStyle = "#ffffff";
  g.fillText(name, w / 2, 24);
  g.font = sub;
  g.fillStyle = "#ffff55";
  g.fillText(jobName, w / 2, 52);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.NoColorSpace;
  tex.minFilter = THREE.LinearFilter;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: true, depthWrite: false });
  const s = new THREE.Sprite(mat);
  const h = 0.42;
  s.scale.set((w / 70) * h, h, 1);
  s.renderOrder = 20;
  return s;
}

interface Snap {
  t: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  flags: number;
}

export class VillagerView {
  readonly id: number;
  readonly job: number;
  readonly name: string;
  readonly root = new THREE.Group();
  private body = new THREE.Group();
  private parts = new Map<string, THREE.Group>();
  private mat: THREE.ShaderMaterial;
  private snaps: Snap[] = [];
  readonly tag: THREE.Sprite;
  x = 0;
  y = 0;
  z = 0;
  yaw = 0;
  flags = 0;
  private lastX = 0;
  private lastZ = 0;
  private limbPos = 0;
  private limbAmt = 0;
  private wave = 0;
  private age = Math.random() * 100;
  localHurt = 0;

  constructor(s: AnimalSnap, name: string) {
    this.id = s.id;
    this.job = Math.max(0, Math.min(JOBS.length - 1, s.kind));
    this.name = name;
    const skin = (s.id * 7 + 3) % SKINS.length;
    const hair = (s.id * 5 + 1) % HAIR.length;
    this.mat = entityMaterial(textureFor(this.job, skin, hair));
    const add = (name: string, b: BoxDef, at: [number, number, number], pivot: [number, number, number], parent?: string) => {
      const mesh = new THREE.Mesh(geometryFor(b), this.mat);
      mesh.position.set(at[0] * PX, at[1] * PX, at[2] * PX);
      if (parent) {
        this.parts.get(parent)!.add(mesh);
        return;
      }
      const g = new THREE.Group();
      g.position.set(pivot[0] * PX, pivot[1] * PX, pivot[2] * PX);
      g.add(mesh);
      this.parts.set(name, g);
      this.body.add(g);
    };
    add("legR", LEG_R, [0, -5, 0], [-2, 10, 0]);
    add("legL", LEG_L, [0, -5, 0], [2, 10, 0]);
    add("body", BODY, [0, -5, 0], [0, 20, 0]);
    add("head", HEAD, [0, 4, 0], [0, 20, 0]);
    add("armR", ARM_R, [0, -4.5, 0], [-5.5, 19.5, 0]);
    add("armL", ARM_L, [0, -4.5, 0], [5.5, 19.5, 0]);
    for (const h of HATS[this.job]) add("", h.box, h.at, [0, 0, 0], "head");
    this.root.add(this.body);
    this.tag = villagerTag(name, this.job);
    this.tag.position.y = 2.2;
    this.root.add(this.tag);
    this.x = this.lastX = s.x;
    this.y = s.y;
    this.z = this.lastZ = s.z;
    this.yaw = s.yaw;
    this.flags = s.flags;
    this.root.position.set(this.x, this.y, this.z);
  }

  push(s: AnimalSnap, t: number): void {
    this.snaps.push({ t, x: s.x, y: s.y, z: s.z, yaw: s.yaw, flags: s.flags });
    if (this.snaps.length > 20) this.snaps.shift();
  }

  tick(): void {
    const dx = this.x - this.lastX;
    const dz = this.z - this.lastZ;
    this.lastX = this.x;
    this.lastZ = this.z;
    const dist = Math.min(1, Math.sqrt(dx * dx + dz * dz) * 6);
    this.limbAmt += (dist - this.limbAmt) * 0.4;
    this.limbPos += this.limbAmt;
    this.wave += ((this.flags & VF.TALK ? 1 : 0) - this.wave) * 0.15;
    this.age++;
  }

  /** Interpolate, pose and light it; the tag shows within `tagRange` blocks of the camera. */
  update(renderTime: number, partial: number, light: [number, number], cam: THREE.Vector3, tagRange = 10): void {
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
    const lp = this.limbPos + this.limbAmt * partial;
    const la = this.limbAmt;
    const t = this.age + partial;
    const P = this.parts;
    P.get("legR")!.rotation.x = Math.cos(lp * 0.6662) * 1.2 * la;
    P.get("legL")!.rotation.x = Math.cos(lp * 0.6662 + Math.PI) * 1.2 * la;
    const swingR = Math.cos(lp * 0.6662 + Math.PI) * 0.7 * la;
    const swingL = Math.cos(lp * 0.6662) * 0.7 * la;
    // talking: the right hand goes up and waves
    const w = this.wave;
    P.get("armR")!.rotation.set(swingR * (1 - w) - 2.75 * w, 0, -0.06 - (0.25 + Math.sin(t * 0.45) * 0.3) * w);
    P.get("armL")!.rotation.set(swingL, 0, 0.06);
    P.get("head")!.rotation.set(Math.sin(t * 0.05) * 0.05, Math.sin(t * 0.021) * 0.25 * (1 - w), 0);
    const hurt = (this.flags & VF.HURT) !== 0 || performance.now() < this.localHurt;
    this.mat.uniforms.uTint.value.setRGB(1, hurt ? 0.5 : 1, hurt ? 0.5 : 1);
    this.mat.uniforms.uLight.value.set(light[0], light[1]);
    const d2 = (cam.x - this.x) ** 2 + (cam.y - this.y - 1.6) ** 2 + (cam.z - this.z) ** 2;
    this.tag.visible = d2 < tagRange * tagRange;
  }

  dispose(): void {
    this.mat.dispose();
    (this.tag.material as THREE.SpriteMaterial).map?.dispose();
    this.tag.material.dispose();
  }
}
