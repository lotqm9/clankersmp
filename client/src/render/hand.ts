// What you hold in first person, animated like Java's ItemInHandRenderer: equip dip, swing, bob and the sway that
// lags behind the camera. Blocks are small cubes, items and tools flat extruded sprites, with Java's first-person
// display transforms; an empty hand shows your own arm in your skin (Java's renderPlayerArm), never a block.

import * as THREE from "three";
import { B, BLOCKS, RENDER, TEX } from "../../../shared/blocks.ts";
import { I, itemDef } from "../../../shared/items.ts";
import { faceUV, flatItem, isDoor, itemBoxes, rotateTop } from "../../../shared/shapes.ts";
import { T, buildTextureLayers } from "../../../shared/textures.ts";
import { entityMaterial, heldMaterial } from "./shaders.ts";
import { canvasTexture, makeSkin } from "./textures.ts";

const FACE_SHADE = [0.6, 0.6, 1.0, 0.5, 0.8, 0.8];
// +X, -X, +Y, -Y, +Z, -Z; corners BL, BR, TR, TL (outside view), unit cube centred on the origin.
const CORNERS = [
  [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]],
  [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]],
  [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]],
  [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]],
  [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]],
  [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]],
];
const UVS = [
  [0, 16],
  [16, 16],
  [16, 0],
  [0, 0],
];

const geoCache = new Map<number, THREE.BufferGeometry>();

/** Drawn as a flat sprite in the hand: every non-block item (tools, food, materials), plants, torches, doors,
 *  ladders and glass panes. */
export function isFlatItem(id: number): boolean {
  if (id >= 256) return true;
  return RENDER[id] === 4 || RENDER[id] === 5 || flatItem(id);
}

/** Something to draw in the hand (0 = an empty hand: the arm). */
export const holdsItem = (id: number) => id > 0 && !!itemDef(id);

/** Items held like a tool (diagonal in the hand), not like a block. */
export function isToolLike(id: number): boolean {
  return !!itemDef(id)?.tool || id === 256 /* stick */;
}

/** The texture layer of a flat item. */
function spriteLayer(id: number): number {
  if (id >= 256) return itemDef(id)?.tex ?? TEX.stick;
  return BLOCKS[id]?.tex[0] ?? TEX.stick;
}

const layerGeoCache = new Map<number, THREE.BufferGeometry>();

/** v7: the flat, extruded sprite of one texture layer (the bow's pull frames, which are not items of their own). */
export function layerGeometry(layer: number): THREE.BufferGeometry {
  const hit = layerGeoCache.get(layer);
  if (hit) return hit;
  const g = buildGeometry(-1, layer);
  layerGeoCache.set(layer, g);
  return g;
}

/** Geometry for a block as an item: a cube, the block's model (stairs, slabs, fences, beds), or a flat
 *  double-sided sprite (plants, torches, doors, ladders, panes). */
export function itemGeometry(id: number): THREE.BufferGeometry {
  const hit = geoCache.get(id);
  if (hit) return hit;
  const g = buildGeometry(id, -1);
  geoCache.set(id, g);
  return g;
}

/** Build the geometry for item `id`, or (id -1) for the flat sprite of texture `layer`. */
function buildGeometry(id: number, layer: number): THREE.BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  const data: number[] = [];
  const index: number[] = [];
  const flat = id < 0 || isFlatItem(id);
  const quad = (pts: number[][], uvs: number[][], layer: number, shade: number) => {
    const b = pos.length / 3;
    for (let k = 0; k < 4; k++) {
      pos.push(pts[k][0], pts[k][1], pts[k][2]);
      uv.push(uvs[k][0], uvs[k][1], 0, 0);
      data.push(layer, 240, 0, shade * 255);
    }
    index.push(b, b + 1, b + 2, b, b + 2, b + 3);
  };
  const sprite = (p: number[][], L: number) => {
    quad(p, UVS, L, 1);
    quad([p[1], p[0], p[3], p[2]], [UVS[1], UVS[0], UVS[3], UVS[2]], L, 0.8);
  };
  if (isDoor(id)) {
    // Both halves, stacked: half as wide as it is tall.
    sprite([[-0.25, 0, 0], [0.25, 0, 0], [0.25, 0.5, 0], [-0.25, 0.5, 0]], TEX.door_upper);
    sprite([[-0.25, -0.5, 0], [0.25, -0.5, 0], [0.25, 0, 0], [-0.25, 0, 0]], TEX.door_lower);
  } else if (flat) {
    // An extruded sprite, one texel thick, with an edge face for every opaque texel on the outline (like the
    // classic item models): it reads as a solid object from any angle.
    const L = id < 0 ? layer : spriteLayer(id);
    const img = buildTextureLayers()[L];
    const th = 1 / 32;
    quad([[-0.5, -0.5, th], [0.5, -0.5, th], [0.5, 0.5, th], [-0.5, 0.5, th]], UVS, L, 1);
    quad([[0.5, -0.5, -th], [-0.5, -0.5, -th], [-0.5, 0.5, -th], [0.5, 0.5, -th]], [UVS[1], UVS[0], UVS[3], UVS[2]], L, 0.8);
    const solid = (x: number, y: number) => x >= 0 && y >= 0 && x < T && y < T && img[(y * T + x) * 4 + 3] >= 128;
    for (let py = 0; py < T; py++)
      for (let px = 0; px < T; px++) {
        if (!solid(px, py)) continue;
        const x0 = px / T - 0.5;
        const x1 = (px + 1) / T - 0.5;
        const y0 = 0.5 - (py + 1) / T;
        const y1 = 0.5 - py / T;
        const u0 = px + 0.25;
        const u1 = px + 0.75;
        const v0 = py + 0.25;
        const v1 = py + 0.75;
        const uv = [[u0, v1], [u1, v1], [u1, v0], [u0, v0]];
        if (!solid(px, py - 1)) quad([[x0, y1, th], [x1, y1, th], [x1, y1, -th], [x0, y1, -th]], uv, L, 0.95);
        if (!solid(px, py + 1)) quad([[x0, y0, -th], [x1, y0, -th], [x1, y0, th], [x0, y0, th]], uv, L, 0.6);
        if (!solid(px - 1, py)) quad([[x0, y0, -th], [x0, y0, th], [x0, y1, th], [x0, y1, -th]], uv, L, 0.75);
        if (!solid(px + 1, py)) quad([[x1, y0, th], [x1, y0, -th], [x1, y1, -th], [x1, y1, th]], uv, L, 0.7);
      }
  } else {
    for (const mb of itemBoxes(id === B.FURNACE ? B.FURNACE + 2 : id) ?? []) {
      const lo = [mb.b[0], mb.b[1], mb.b[2]];
      const hi = [mb.b[3], mb.b[4], mb.b[5]];
      for (let f = 0; f < 6; f++) {
        const pts: number[][] = [];
        const uvs: number[][] = [];
        for (const c of CORNERS[f]) {
          const px = c[0] ? hi[0] : lo[0];
          const py = c[1] ? hi[1] : lo[1];
          const pz = c[2] ? hi[2] : lo[2];
          pts.push([px / 16 - 0.5, py / 16 - 0.5, pz / 16 - 0.5]);
          let [u, v] = faceUV(f, px, py, pz);
          if (f === 2 && mb.topRot) [u, v] = rotateTop(u, v, mb.topRot);
          uvs.push([u, v]);
        }
        quad(pts, uvs, mb.tex[f], FACE_SHADE[f]);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uvp", new THREE.Float32BufferAttribute(uv, 4));
  g.setAttribute("data", new THREE.Float32BufferAttribute(data, 4));
  g.setIndex(index);
  return g;
}

/** The 64 x 64 skin layout's box unwrap on a BoxGeometry (three's face order +X, -X, +Y, -Y, +Z, -Z; front = +Z). */
export function skinBoxUV(g: THREE.BoxGeometry, u: number, v: number, w: number, h: number, d: number): void {
  const rects: [number, number, number, number][] = [
    [u + d + w, v + d, u + d + w + d, v + d + h],
    [u, v + d, u + d, v + d + h],
    [u + d, v, u + d + w, v + d],
    [u + d + w, v, u + d + w + w, v + d],
    [u + d, v + d, u + d + w, v + d + h],
    [u + d + w + d, v + d, u + d + w + d + w, v + d + h],
  ];
  const uv = g.getAttribute("uv") as THREE.BufferAttribute;
  for (let f = 0; f < 6; f++) {
    const [x0, y0, x1, y1] = rects[f];
    const o = f * 4;
    uv.setXY(o, x0 / 64, 1 - y0 / 64);
    uv.setXY(o + 1, x1 / 64, 1 - y0 / 64);
    uv.setXY(o + 2, x0 / 64, 1 - y1 / 64);
    uv.setXY(o + 3, x1 / 64, 1 - y1 / 64);
  }
  uv.needsUpdate = true;
}

const DEG = Math.PI / 180;
const wrapDeg = (a: number) => ((((a + 180) % 360) + 360) % 360) - 180;

export class Hand {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(70, 1, 0.05, 10);
  readonly material: THREE.ShaderMaterial;
  private root = new THREE.Group();
  private item: THREE.Mesh;
  /** The right arm (empty hand), in Java model space: 4 x 12 x 4 px from the skin's right-arm unwrap. */
  private arm = new THREE.Group();
  private armMat: THREE.ShaderMaterial | null = null;
  private skin = -1;
  // the sway: the hand lags behind the camera (Java's xBob / yBob)
  private yBob = 0;
  private xBob = 0;
  private yBobO = 0;
  private xBobO = 0;
  private yaw = 0;
  private pitch = 0;
  private prevYaw = 0;
  private prevPitch = 0;
  private current = -1;
  private equip = 0; // 0 = held, 1 = lowered
  private prevEquip = 0;
  private swing = 0;
  private prevSwing = 0;
  private swinging = false;
  private pendingId = -1;
  /** 12.1: ticks spent eating (-1: not eating) and the meal's length, for Java's eat pose. */
  private eatTicks = -1;
  private prevEatTicks = -1;
  private eatLength = 32;
  /** v7: how far the bow is drawn (-1: not drawing): its frame and the pose. */
  private draw = -1;
  private drawFrame = -1;

  constructor(atlas: THREE.Texture) {
    this.material = heldMaterial(atlas);
    this.item = new THREE.Mesh(new THREE.BufferGeometry(), this.material);
    this.root.add(this.item);
    this.scene.add(this.root);
    this.arm.matrixAutoUpdate = false;
    this.arm.visible = false;
    this.scene.add(this.arm);
  }

  /** Your skin, for the bare arm. */
  setSkin(variant: number): void {
    if (variant === this.skin) return;
    this.skin = variant;
    this.arm.clear();
    this.armMat = entityMaterial(canvasTexture(makeSkin(variant)));
    // Java's right arm: box (-3, -2, -2) to (1, 10, 2) px in model space (y down, front -Z), pivot (-5, 2, 0).
    // Built y-up / front +Z like the avatars, then turned into model space by a half turn about X.
    const g = new THREE.BoxGeometry(4 / 16, 12 / 16, 4 / 16);
    skinBoxUV(g, 40, 16, 4, 12, 4);
    g.translate(-1 / 16, -4 / 16, 0);
    g.rotateX(Math.PI);
    this.arm.add(new THREE.Mesh(g, this.armMat));
  }

  /** The camera's angles each tick (degrees, Java convention), for the sway. */
  look(yaw: number, pitch: number): void {
    if (!this.looked) {
      this.looked = true;
      this.yBob = this.yBobO = this.prevYaw = yaw;
      this.xBob = this.xBobO = this.prevPitch = pitch;
    }
    this.yaw = yaw;
    this.pitch = pitch;
  }
  private looked = false;

  setAspect(a: number): void {
    this.camera.aspect = a;
    this.camera.updateProjectionMatrix();
  }

  /** Request a new held block: the old one dips out and the new one rises in. */
  setItem(id: number): void {
    if (id === this.current && this.pendingId < 0) return;
    this.pendingId = id;
  }

  /** Eating (or drinking) for `ticks`: the item comes up to the mouth and bobs with each bite. */
  setEating(on: boolean, ticks = 32): void {
    this.eatTicks = this.prevEatTicks = on ? 0 : -1;
    this.eatLength = ticks;
  }

  /** 12.1: the meal is done: the item drops a little and comes back up, instead of snapping back from the mouth. */
  finishEating(): void {
    this.eatTicks = this.prevEatTicks = -1;
    if (this.pendingId < 0) this.equip = this.prevEquip = 0.6;
  }

  /** v7: drawing the bow, `pull` 0..1 (seconds drawn, at most 1), or -1 when it is loosed or put away. The bow comes
   *  in to the middle and its string goes back in three steps, like the classic one. */
  setDraw(pull: number): void {
    this.draw = pull;
    const frame = pull < 0 ? -1 : pull >= 0.9 ? 3 : pull >= 0.65 ? 2 : 1;
    if (frame === this.drawFrame) return;
    this.drawFrame = frame;
    if (this.current === I.BOW) this.item.geometry = frame < 0 ? itemGeometry(I.BOW) : layerGeometry(TEX.bow + frame);
  }

  startSwing(): void {
    if (!this.swinging || this.swing >= 0.5) {
      this.swing = 0;
      this.prevSwing = 0;
      this.swinging = true;
    }
  }

  /** 20 Hz. */
  tick(): void {
    // Java LocalPlayer: xBob/yBob follow the view halfway each tick
    this.prevYaw = this.yaw;
    this.prevPitch = this.pitch;
    this.yBobO = this.yBob;
    this.xBobO = this.xBob;
    this.yBob += wrapDeg(this.yaw - this.yBob) * 0.5;
    this.xBob += (this.pitch - this.xBob) * 0.5;
    this.prevEquip = this.equip;
    this.prevSwing = this.swing;
    this.prevEatTicks = this.eatTicks;
    if (this.eatTicks >= 0) this.eatTicks = Math.min(this.eatLength, this.eatTicks + 1);
    if (this.pendingId >= 0) {
      this.equip = Math.min(1, this.equip + 0.4);
      if (this.equip >= 1) {
        this.current = this.pendingId;
        this.pendingId = -1;
        if (holdsItem(this.current)) this.item.geometry = itemGeometry(this.current);
        if (this.current !== I.BOW) this.drawFrame = -1;
      }
    } else {
      this.equip = Math.max(0, this.equip - 0.4);
    }
    if (this.swinging) {
      this.swing += 1 / 6;
      if (this.swing >= 1) {
        this.swing = 0;
        this.swinging = false;
      }
    }
  }

  update(partial: number, bob: { x: number; y: number; rz: number; rx: number }, light: [number, number]): void {
    const e = this.prevEquip + (this.equip - this.prevEquip) * partial;
    let s = this.swinging ? this.prevSwing + (this.swing - this.prevSwing) * partial : 0;
    if (s > 1) s = 1;
    const sq = Math.sqrt(s);
    const deg = DEG;
    const m = new THREE.Matrix4();
    const t = new THREE.Matrix4();
    // View bobbing applies to the hand too.
    m.makeTranslation(bob.x, bob.y, 0);
    m.multiply(t.makeRotationZ(bob.rz * deg));
    m.multiply(t.makeRotationX(bob.rx * deg));
    // The sway: the hand trails the camera a little when you look around (Java: 0.1 of the lag, in degrees).
    const yaw = this.prevYaw + wrapDeg(this.yaw - this.prevYaw) * partial;
    const pitch = this.prevPitch + (this.pitch - this.prevPitch) * partial;
    const yb = this.yBobO + wrapDeg(this.yBob - this.yBobO) * partial;
    const xb = this.xBobO + (this.xBob - this.xBobO) * partial;
    m.multiply(t.makeRotationX((pitch - xb) * 0.1 * deg));
    m.multiply(t.makeRotationY(wrapDeg(yaw - yb) * 0.1 * deg));
    const empty = this.current >= 0 && !holdsItem(this.current);
    this.arm.visible = empty && !!this.armMat;
    this.item.visible = this.current >= 0 && !empty;
    if (this.armMat) this.armMat.uniforms.uLight.value.set(light[0], light[1]);
    this.material.uniforms.uLight.value.set(light[0], light[1]);
    if (empty) {
      // Java's renderPlayerArm (right arm), then the arm part at its pivot with HumanoidModel's idle arm bob
      const a = new THREE.Matrix4().copy(m);
      a.multiply(t.makeTranslation(-0.3 * Math.sin(sq * Math.PI) + 0.64, 0.4 * Math.sin(sq * Math.PI * 2) - 0.6 - e * 0.6, -0.4 * Math.sin(s * Math.PI) - 0.72));
      a.multiply(t.makeRotationY(45 * deg));
      a.multiply(t.makeRotationY(Math.sin(sq * Math.PI) * 70 * deg));
      a.multiply(t.makeRotationZ(Math.sin(s * s * Math.PI) * -20 * deg));
      a.multiply(t.makeTranslation(-1, 3.6, 3.5));
      a.multiply(t.makeRotationZ(120 * deg));
      a.multiply(t.makeRotationX(200 * deg));
      a.multiply(t.makeRotationY(-135 * deg));
      a.multiply(t.makeTranslation(5.6, 0, 0));
      a.multiply(t.makeTranslation(-5 / 16, 2 / 16, 0));
      a.multiply(t.makeRotationZ(0.1));
      this.arm.matrix.copy(a);
      this.arm.matrixWorldNeedsUpdate = true;
      return;
    }
    const drawing = this.draw >= 0 && this.current === I.BOW;
    const eating = this.eatTicks >= 0 && !drawing;
    if (!drawing && !eating) m.multiply(t.makeTranslation(-0.4 * Math.sin(sq * Math.PI), 0.2 * Math.sin(sq * Math.PI * 2), -0.2 * Math.sin(s * Math.PI)));
    if (eating) {
      // 12.1, Java's applyEatTransform: the item swings in to the mouth over the first couple of ticks (1 - left^27),
      // turned to face you, then bobs once every 4 ticks, in time with the bite sounds and crumbs
      const used = this.prevEatTicks + (this.eatTicks - this.prevEatTicks) * partial;
      const left = Math.max(0, this.eatLength - used); // Java: the use ticks remaining
      const f1 = Math.min(1, left / this.eatLength);
      if (f1 < 0.8) m.multiply(t.makeTranslation(0, Math.abs(Math.cos((left / 4) * Math.PI) * 0.1), 0));
      const f3 = 1 - Math.pow(f1, 27);
      m.multiply(t.makeTranslation(f3 * 0.6, f3 * -0.5, 0));
      m.multiply(t.makeRotationY(f3 * 90 * deg));
      m.multiply(t.makeRotationX(f3 * 10 * deg));
      m.multiply(t.makeRotationZ(f3 * 30 * deg));
    }
    m.multiply(t.makeTranslation(0.56, -0.52 - e * 0.6, -0.72));
    if (drawing) {
      // v7, the classic bow pose: in toward the middle and turned so the arrow points at the crosshair, the bow
      // pulled back and stretched a little along the draw, with a slight tremble once the pull is up
      const k = Math.min(1, this.draw);
      const f = Math.min(1, (k * k + 2 * k) / 3);
      m.multiply(t.makeTranslation(-0.2785682, 0.18344387, 0.15731531));
      m.multiply(t.makeRotationX(-13.935 * deg));
      m.multiply(t.makeRotationY(35.3 * deg));
      m.multiply(t.makeRotationZ(-9.785 * deg));
      if (f > 0.1) m.multiply(t.makeTranslation(0, Math.sin((performance.now() / 50 - 0.1) * 1.3) * (f - 0.1) * 0.004, 0));
      m.multiply(t.makeTranslation(0, 0, f * 0.04));
      m.multiply(t.makeScale(1, 1, 1 + f * 0.2));
      m.multiply(t.makeRotationY(-45 * deg));
    } else {
      const f = Math.sin(s * s * Math.PI);
      const f1 = Math.sin(sq * Math.PI);
      m.multiply(t.makeRotationY((45 + f * -20) * deg));
      m.multiply(t.makeRotationZ(f1 * -20 * deg));
      m.multiply(t.makeRotationX(f1 * -80 * deg));
      m.multiply(t.makeRotationY(-45 * deg));
    }
    // Java's first-person display transforms: items and tools (item/generated, item/handheld) translate
    // (1.13, 3.2, 1.13) px, turn (0, -90, 25) and scale 0.68; blocks turn 45 degrees and scale 0.4.
    const flat = this.current >= 0 && isFlatItem(this.current);
    if (flat) {
      m.multiply(t.makeTranslation(1.13 / 16, 3.2 / 16, 1.13 / 16));
      m.multiply(t.makeRotationFromEuler(new THREE.Euler(0, -90 * deg, 25 * deg, "XYZ")));
      m.multiply(t.makeScale(0.68, 0.68, 0.68));
    } else {
      m.multiply(t.makeRotationY(45 * deg));
      m.multiply(t.makeScale(0.4, 0.4, 0.4));
    }
    this.root.matrixAutoUpdate = false;
    this.root.matrix.copy(m);
    this.root.matrixWorldNeedsUpdate = true;
  }
}

/** A small mesh for a block held by another player. */
export function heldBlockMesh(id: number, material: THREE.Material): THREE.Mesh {
  return new THREE.Mesh(itemGeometry(id), material);
}
