// Boats (v8), our own design: a little clinker rowboat with a pointed bow, plank seats, a teal stripe along
// its gunwales and two oars that dip as it is rowed. Built from boxes with a small painted atlas (no other game's
// art). Boats rowed by others are interpolated from 5-10 Hz snapshots (~150 ms behind, like animals); the one you
// row is drawn where your own prediction puts it. A hit rocks it.

import * as THREE from "three";
import { BF, FLOOR_Y, type BoatSnap } from "../../../shared/boats.ts";
import { mulberry32 } from "../../../shared/noise.ts";
import { entityMaterial } from "./shaders.ts";
import { canvasTexture } from "./textures.ts";

const PX = 1 / 16;
const S = 64; // atlas size

// atlas tiles (16 x 16 texels each): [u, v]
const HULL: [number, number] = [0, 0];
const DECK: [number, number] = [16, 0];
const RED: [number, number] = [32, 0];
const DARK: [number, number] = [48, 0];
const BLADE: [number, number] = [0, 16];
const SEAT: [number, number] = [16, 16];

let atlas: THREE.Texture | null = null;

function paintAtlas(): THREE.Texture {
  if (atlas) return atlas;
  const c = document.createElement("canvas");
  c.width = c.height = S;
  const ctx = c.getContext("2d")!;
  const img = ctx.createImageData(S, S);
  const r = mulberry32(8801);
  const px = (x: number, y: number, col: number[], k = 1) => {
    const o = (y * S + x) * 4;
    img.data[o] = Math.min(255, col[0] * k);
    img.data[o + 1] = Math.min(255, col[1] * k);
    img.data[o + 2] = Math.min(255, col[2] * k);
    img.data[o + 3] = 255;
  };
  const tile = ([u, v]: [number, number], f: (x: number, y: number) => [number[], number]) => {
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      const [col, k] = f(x, y);
      px(u + x, v + y, col, k);
    }
  };
  // the hull: overlapping strakes (horizontal boards), each with a dark lap line under it
  tile(HULL, (x, y) => [y % 4 === 3 ? [86, 58, 30] : [138, 96, 54], y % 4 === 0 ? 1.12 : 0.92 + r() * 0.16 + ((x * 5 + y) % 9 === 0 ? -0.12 : 0)]);
  // the floor: lengthwise boards, paler
  tile(DECK, (x, y) => [x % 4 === 3 ? [120, 88, 52] : [176, 134, 84], 0.9 + r() * 0.14]);
  // teal paint (Steve's shirt), a touch worn
  tile(RED, (_x, y) => [y < 2 ? [104, 210, 204] : [34, 163, 163], 0.88 + r() * 0.12]);
  // dark wood: the oar shafts and the oarlocks
  tile(DARK, () => [[82, 60, 38], 0.85 + r() * 0.2]);
  // the oar blades: light wood with a teal tip
  tile(BLADE, (_x, y) => [y > 11 ? [34, 163, 163] : [196, 156, 98], 0.9 + r() * 0.12]);
  // seats: planks across
  tile(SEAT, (x, y) => [y % 5 === 4 ? [110, 78, 44] : [160, 116, 68], 0.92 + r() * 0.12 + (x === 0 ? -0.1 : 0)]);
  ctx.putImageData(img, 0, 0);
  atlas = canvasTexture(c);
  return atlas;
}

type Tile = [number, number];

/** Push one box (px, boat space: x across, y up, z toward the bow) into flat arrays, every face mapped onto `tile`
 *  (faces longer than 16 texels stretch along their length). */
function pushBox(pos: number[], nrm: number[], uv: number[], idx: number[], b: number[], tile: Tile | Tile[]): void {
  const [x0, y0, z0, x1, y1, z1] = b.map((v) => v * PX);
  const faces: [number[], number[][]][] = [
    [[1, 0, 0], [[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]]],
    [[-1, 0, 0], [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]]],
    [[0, 1, 0], [[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]]],
    [[0, -1, 0], [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]]],
    [[0, 0, 1], [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]]],
    [[0, 0, -1], [[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]]],
  ];
  faces.forEach(([n, pts], f) => {
    const t = Array.isArray(tile[0]) ? (tile as Tile[])[f] : (tile as Tile);
    const w = Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1], pts[1][2] - pts[0][2]) / PX;
    const h = Math.hypot(pts[3][0] - pts[0][0], pts[3][1] - pts[0][1], pts[3][2] - pts[0][2]) / PX;
    const uw = Math.min(16, Math.max(1, w));
    const vh = Math.min(16, Math.max(1, h));
    const base = pos.length / 3;
    const tuv = [[0, vh], [uw, vh], [uw, 0], [0, 0]];
    for (let k = 0; k < 4; k++) {
      pos.push(...pts[k]);
      nrm.push(...n);
      uv.push((t[0] + tuv[k][0]) / S, 1 - (t[1] + tuv[k][1]) / S);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  });
}

function geometry(boxes: [number[], Tile | Tile[]][]): THREE.BufferGeometry {
  const pos: number[] = [];
  const nrm: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  for (const [b, t] of boxes) pushBox(pos, nrm, uv, idx, b, t);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

let hullGeo: THREE.BufferGeometry | null = null;
let oarGeo: THREE.BufferGeometry | null = null;

/** The hull, in px, the bow toward +z. Its floor is at FLOOR_Y (just above the water line). */
function hullGeometry(): THREE.BufferGeometry {
  if (hullGeo) return hullGeo;
  const F = FLOOR_Y * 16; // 4.48
  // sides: hull planks outside, the red stripe as a cap on the gunwale
  const side: Tile[] = [HULL, HULL, RED, HULL, HULL, HULL];
  hullGeo = geometry([
    [[-9, 0, -13, 9, 2, 11], HULL], // keel and bottom
    [[-8, 2, -12, 8, F, 11], [DECK, DECK, DECK, DECK, DECK, DECK]], // the floor, over the water line
    [[-10, 1, -13, -8, 9, 11], side], // port side
    [[8, 1, -13, 10, 9, 11], side], // starboard side
    [[-10, 1, -15, 10, 9, -13], [HULL, HULL, RED, HULL, HULL, HULL]], // the transom (stern)
    [[-8, 1, 11, 8, 9, 13], [HULL, HULL, RED, HULL, HULL, HULL]], // the bow, narrowing to a point
    [[-6, 2, 13, 6, 9.5, 15], [HULL, HULL, RED, HULL, HULL, HULL]],
    [[-3, 3, 15, 3, 10, 17], [HULL, HULL, RED, HULL, HULL, HULL]],
    [[-1, 4, 17, 1, 10.5, 18], RED], // the stem post, painted
    [[-8, 6, 2, 8, 7.5, 4.5], SEAT], // the seats
    [[-8, 6, -9, 8, 7.5, -6.5], SEAT],
    [[-10.5, 8.5, -1.5, -9.5, 10, 0.5], DARK], // oarlocks
    [[9.5, 8.5, -1.5, 10.5, 10, 0.5], DARK],
  ]);
  return hullGeo;
}

/** An oar, from its oarlock outward (+x) and down: a shaft and a blade with a red tip. */
function oarGeometry(): THREE.BufferGeometry {
  if (oarGeo) return oarGeo;
  oarGeo = geometry([
    [[-6, -0.5, -0.5, 14, 0.5, 0.5], DARK],
    [[12, -2, -0.4, 19, 2, 0.4], BLADE],
  ]);
  return oarGeo;
}

interface Snap {
  t: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  flags: number;
}

export class BoatView {
  readonly id: number;
  readonly root = new THREE.Group();
  private hull: THREE.Mesh;
  private oarL = new THREE.Group();
  private oarR = new THREE.Group();
  private mat: THREE.ShaderMaterial;
  private snaps: Snap[] = [];
  x = 0;
  y = 0;
  z = 0;
  yaw = 0;
  flags = 0;
  /** Drawn from our own prediction (we row it), not from snapshots. */
  local: { x: number; y: number; z: number; yaw: number; px: number; py: number; pz: number; pyaw: number } | null = null;
  private phaseL = 0;
  private phaseR = 0;
  private rowAmt = 0;
  private wobble = 0;
  localHurt = 0;

  constructor(s: BoatSnap) {
    this.id = s.id;
    this.mat = entityMaterial(paintAtlas());
    this.hull = new THREE.Mesh(hullGeometry(), this.mat);
    this.root.add(this.hull);
    for (const [g, side] of [[this.oarL, -1], [this.oarR, 1]] as [THREE.Group, number][]) {
      const oar = new THREE.Mesh(oarGeometry(), this.mat);
      if (side < 0) oar.scale.x = -1;
      g.add(oar);
      g.position.set(side * 10 * PX, 9.2 * PX, -0.5 * PX);
      this.root.add(g);
    }
    this.x = s.x;
    this.y = s.y;
    this.z = s.z;
    this.yaw = s.yaw;
    this.flags = s.flags;
    this.root.position.set(s.x, s.y, s.z);
  }

  push(s: BoatSnap, t: number): void {
    this.snaps.push({ t, x: s.x, y: s.y, z: s.z, yaw: s.yaw, flags: s.flags });
    if (this.snaps.length > 20) this.snaps.shift();
  }

  /** We row it: draw it from our prediction (`partial` blends the last two ticks). */
  setLocal(x: number, y: number, z: number, yaw: number, flags: number): void {
    const l = this.local;
    this.local = { x, y, z, yaw, px: l ? l.x : x, py: l ? l.y : y, pz: l ? l.z : z, pyaw: l ? l.yaw : yaw };
    this.flags = (this.flags & BF.HURT) | flags;
  }

  /** 20 Hz: the oars. */
  tick(): void {
    const rowing = (this.flags & (BF.ROW_L | BF.ROW_R)) !== 0;
    this.rowAmt += ((rowing ? 1 : 0) - this.rowAmt) * 0.3;
    if (this.flags & BF.ROW_L) this.phaseL += 0.42;
    if (this.flags & BF.ROW_R) this.phaseR += 0.42;
    if (this.flags & BF.HURT || performance.now() < this.localHurt) this.wobble = Math.min(1, this.wobble + 0.5);
    else this.wobble *= 0.8;
  }

  update(renderTime: number, partial: number, light: [number, number]): void {
    const l = this.local;
    if (l) {
      this.x = l.px + (l.x - l.px) * partial;
      this.y = l.py + (l.y - l.py) * partial;
      this.z = l.pz + (l.z - l.pz) * partial;
      let d = l.yaw - l.pyaw;
      d = ((((d + 180) % 360) + 360) % 360) - 180;
      this.yaw = l.pyaw + d * partial;
    } else if (this.snaps.length) {
      const snaps = this.snaps;
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
    // our model's bow points +z, like Java's yaw 0
    this.root.rotation.set(0, (-this.yaw * Math.PI) / 180, 0, "YXZ");
    if (this.wobble > 0.01) this.root.rotateZ(Math.sin(performance.now() / 45) * 0.12 * this.wobble);
    // the oars: resting low over the water, sweeping back and dipping as they row
    for (const [g, ph, side] of [[this.oarL, this.phaseL, -1], [this.oarR, this.phaseR, 1]] as [THREE.Group, number, number][]) {
      const sweep = Math.sin(ph) * 0.55 * this.rowAmt;
      const dip = (0.42 + Math.max(0, Math.cos(ph)) * 0.18 * this.rowAmt) * side;
      g.rotation.set(0, sweep * side, -dip, "YXZ");
    }
    this.mat.uniforms.uLight.value.set(light[0], light[1]);
    const hurt = this.wobble > 0.3;
    this.mat.uniforms.uTint.value.setRGB(1, hurt ? 0.6 : 1, hurt ? 0.6 : 1);
  }

  dispose(): void {
    this.mat.dispose();
  }
}
