// Other players: blocky avatars with the original skin, head yaw/pitch, arm and leg swing, sneaking pose,
// arm swing when they dig or place, the block in their hand, and a nametag. Positions are interpolated
// from 10 Hz server snapshots, rendered ~120 ms in the past. v6: the armour they wear (render/armor.ts).

import * as THREE from "three";
import { I, itemDef } from "../../../shared/items.ts";
import { isFlatItem, isToolLike } from "./hand.ts";
import { FLAG, type PlayerInfo, type PlayerSnap } from "../../../shared/protocol.ts";
import { entityMaterial } from "./shaders.ts";
import { canvasTexture, makeSkin } from "./textures.ts";
import { wornMaterial } from "../../../shared/combat.ts";
import { ARMOR_BOX, PIECES, armorCanvas } from "./armor.ts";

const PX = 0.9375 / 16; // Java renders the player model at 15/16 scale

function boxUV(g: THREE.BoxGeometry, u: number, v: number, w: number, h: number, d: number): void {
  // three's BoxGeometry face order: +X, -X, +Y, -Y, +Z, -Z; each face: TL, TR, BL, BR.
  const rects: [number, number, number, number][] = [
    [u + d + w, v + d, u + d + w + d, v + d + h], // +X: the model's left side
    [u, v + d, u + d, v + d + h], // -X: right side
    [u + d, v, u + d + w, v + d], // top
    [u + d + w, v, u + d + w + w, v + d], // bottom
    [u + d, v + d, u + d + w, v + d + h], // front (+Z)
    [u + d + w + d, v + d, u + d + w + d + w, v + d + h], // back
  ];
  const uv = g.getAttribute("uv") as THREE.BufferAttribute;
  for (let f = 0; f < 6; f++) {
    const [x0, y0, x1, y1] = rects[f];
    const tl = [x0 / 64, 1 - y0 / 64];
    const tr = [x1 / 64, 1 - y0 / 64];
    const bl = [x0 / 64, 1 - y1 / 64];
    const br = [x1 / 64, 1 - y1 / 64];
    const o = f * 4;
    uv.setXY(o, tl[0], tl[1]);
    uv.setXY(o + 1, tr[0], tr[1]);
    uv.setXY(o + 2, bl[0], bl[1]);
    uv.setXY(o + 3, br[0], br[1]);
  }
  uv.needsUpdate = true;
}

const armorTextures = new Map<string, THREE.Texture>();
function armorTexture(material: number, layer: 1 | 2): THREE.Texture {
  const k = `${material}:${layer}`;
  let t = armorTextures.get(k);
  if (!t) armorTextures.set(k, (t = canvasTexture(armorCanvas(material, layer))));
  return t;
}

/** An armour box: the part's box, `grow` px bigger on every side, with the same UVs. */
function armorMesh(mat: THREE.Material, b: { u: number; v: number; w: number; h: number; d: number }, offY: number, grow: number): THREE.Mesh {
  const g = new THREE.BoxGeometry((b.w + grow * 2) * PX, (b.h + grow * 2) * PX, (b.d + grow * 2) * PX);
  boxUV(g, b.u, b.v, b.w, b.h, b.d);
  const m = new THREE.Mesh(g, mat);
  m.position.y = offY;
  return m;
}

function part(mat: THREE.Material, w: number, h: number, d: number, u: number, v: number, pivotY: number): { pivot: THREE.Group; mesh: THREE.Mesh } {
  const g = new THREE.BoxGeometry(w * PX, h * PX, d * PX);
  boxUV(g, u, v, w, h, d);
  const mesh = new THREE.Mesh(g, mat);
  mesh.position.y = pivotY;
  const pivot = new THREE.Group();
  pivot.add(mesh);
  return { pivot, mesh };
}

/** Where an item sits in the right hand of an avatar, relative to the arm's pivot (Java's ItemInHandLayer and the
 *  third-person display transforms: blocks turn (75, 45, 0), lift 2.5 px and scale 0.375; flat items lift 3 px,
 *  come 1 px forward and scale 0.55; tools and sticks turn (0, -90, 55), lift 4 px and scale 0.85). Our avatars are
 *  built y-up, front +Z; Java's model space is y-down, front -Z: a half turn about X between the two. */
export function thirdPersonHeld(id: number): THREE.Matrix4 {
  const D = Math.PI / 180;
  const t = new THREE.Matrix4();
  const m = new THREE.Matrix4().makeScale(0.9375, 0.9375, 0.9375);
  m.multiply(t.makeRotationX(Math.PI));
  m.multiply(t.makeRotationX(-90 * D));
  m.multiply(t.makeRotationY(180 * D));
  m.multiply(t.makeTranslation(1 / 16, 0.125, -0.625));
  let tr: [number, number, number];
  let rot: [number, number, number];
  let sc: number;
  if (isToolLike(id)) [tr, rot, sc] = [[0, 4, 0.5], [0, -90, 55], 0.85];
  else if (id === I.BOW) [tr, rot, sc] = [[-1, -2, 2.5], [-80, 260, -40], 0.9]; // v7: upright, string to the body
  else if (isFlatItem(id)) [tr, rot, sc] = [[0, 3, 1], [0, 0, 0], 0.55];
  else [tr, rot, sc] = [[0, 2.5, 0], [75, 45, 0], 0.375];
  m.multiply(t.makeTranslation(tr[0] / 16, tr[1] / 16, tr[2] / 16));
  m.multiply(t.makeRotationFromEuler(new THREE.Euler(rot[0] * D, rot[1] * D, rot[2] * D, "XYZ")));
  m.multiply(t.makeScale(sc, sc, sc));
  return m;
}

const skinCache = new Map<number, THREE.ShaderMaterial>();
function skinMaterial(variant: number): THREE.ShaderMaterial {
  let m = skinCache.get(variant);
  if (!m) {
    m = entityMaterial(canvasTexture(makeSkin(variant)));
    skinCache.set(variant, m);
  }
  return m;
}

export function nameTag(name: string): THREE.Sprite {
  const c = document.createElement("canvas");
  const font = `32px KenneyMini, monospace`;
  const ctx = c.getContext("2d")!;
  ctx.font = font;
  const w = Math.ceil(ctx.measureText(name).width) + 16;
  c.width = w;
  c.height = 44;
  ctx.font = font;
  ctx.fillStyle = "rgba(0,0,0,0.38)";
  ctx.fillRect(0, 0, w, 44);
  ctx.fillStyle = "#ffffff";
  ctx.textBaseline = "middle";
  ctx.fillText(name, 8, 24);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.NoColorSpace;
  tex.minFilter = THREE.LinearFilter;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false });
  const s = new THREE.Sprite(mat);
  const h = 0.3;
  s.scale.set((w / 44) * h, h, 1);
  s.renderOrder = 20;
  return s;
}

/** v11: the speaking icon over a talking player's head (our own pixel glyph: a speaker and two sound waves in white
 *  on the name tag's dark pill). One texture for everyone. */
let talkTex: THREE.CanvasTexture | null = null;
function talkTexture(): THREE.CanvasTexture {
  if (talkTex) return talkTex;
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  g.fillStyle = "rgba(0,0,0,0.55)";
  g.fillRect(2, 8, 60, 48);
  g.fillStyle = "#ffffff";
  const px = (x: number, y: number, w = 1, h = 1) => g.fillRect(8 + x * 4, 12 + y * 4, w * 4, h * 4);
  // the speaker: a box and its cone
  px(1, 4, 2, 2);
  px(3, 3, 1, 4);
  px(4, 2, 1, 6);
  // two waves
  px(6, 3, 1, 1);
  px(7, 4, 1, 2);
  px(6, 6, 1, 1);
  px(8, 1, 1, 1);
  px(9, 2, 1, 1);
  px(10, 3, 1, 4);
  px(9, 7, 1, 1);
  px(8, 8, 1, 1);
  talkTex = new THREE.CanvasTexture(c);
  talkTex.colorSpace = THREE.NoColorSpace;
  talkTex.magFilter = THREE.NearestFilter;
  talkTex.minFilter = THREE.LinearFilter;
  return talkTex;
}

interface Snap {
  t: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  flags: number;
  held: number;
}

export class RemotePlayer {
  readonly id: number;
  readonly name: string;
  readonly skin: number;
  readonly root = new THREE.Group();
  private body: THREE.Group;
  private torso: THREE.Group;
  private head: THREE.Group;
  private armR: THREE.Group;
  private armL: THREE.Group;
  private legR: THREE.Group;
  private legL: THREE.Group;
  private tag: THREE.Sprite;
  /** clankersmp: the player the spectator follows; its own tag would fill the third-person camera. */
  ownTag = false;
  /** v11: the speaking icon (shown while the server says they are talking; it pulses while we hear them). */
  private talkIcon: THREE.Sprite;
  private talkingOn = false;
  private talkingLive = false;
  private heldMesh: THREE.Mesh | null = null;
  private heldId = -1;
  private mat: THREE.ShaderMaterial;
  private snaps: Snap[] = [];
  x = 0;
  y = 0;
  z = 0;
  yaw = 0;
  pitch = 0;
  flags = 0;
  bodyYaw = 0;
  private limbPos = 0;
  private limbAmt = 0;
  private lastX = 0;
  private lastZ = 0;
  private swing = 0;
  private swinging = false;
  private sneakAmt = 0;
  private lastRender = 0;
  private armor: { slot: number; layer: 1 | 2; mat: THREE.ShaderMaterial | null; meshes: THREE.Mesh[]; worn: number }[] = [];
  private armorPacked = -1;

  constructor(info: PlayerInfo, heldFactory: (id: number) => THREE.Mesh | null, withTag = true) {
    this.id = info.id;
    this.name = info.name;
    this.skin = info.skin;
    this.heldFactory = heldFactory;
    this.mat = skinMaterial(info.skin).clone(); // per player: its own light and hurt tint
    const m = this.mat;
    this.body = new THREE.Group();
    this.root.add(this.body);
    // Torso (8x12x4) from y 12..24 px, pivoting at the neck (it leans forward from there when crouching)
    const torso = part(m, 8, 12, 4, 16, 16, -6 * PX);
    torso.pivot.position.y = 24 * PX;
    this.torso = torso.pivot;
    this.body.add(this.torso);
    // Head pivots at the neck (24 px)
    const head = part(m, 8, 8, 8, 0, 0, 4 * PX);
    head.pivot.position.y = 24 * PX;
    this.head = head.pivot;
    this.body.add(this.head);
    // Arms pivot at the shoulders (22 px), 6 px either side
    const armR = part(m, 4, 12, 4, 40, 16, -4 * PX);
    armR.pivot.position.set(-6 * PX, 22 * PX, 0);
    this.armR = armR.pivot;
    const armL = part(m, 4, 12, 4, 32, 48, -4 * PX);
    armL.pivot.position.set(6 * PX, 22 * PX, 0);
    this.armL = armL.pivot;
    this.body.add(this.armR, this.armL);
    // Legs pivot at the hips (12 px), 2 px either side
    const legR = part(m, 4, 12, 4, 0, 16, -6 * PX);
    legR.pivot.position.set(-2 * PX, 12 * PX, 0);
    this.legR = legR.pivot;
    const legL = part(m, 4, 12, 4, 16, 48, -6 * PX);
    legL.pivot.position.set(2 * PX, 12 * PX, 0);
    this.legL = legL.pivot;
    this.root.add(this.legR, this.legL);
    this.tag = nameTag(info.name || " ");
    this.tag.position.y = 2.15;
    if (withTag) this.root.add(this.tag);
    this.talkIcon = new THREE.Sprite(new THREE.SpriteMaterial({ map: talkTexture(), transparent: true, depthTest: false, depthWrite: false }));
    this.talkIcon.scale.set(0.46, 0.46, 1);
    this.talkIcon.renderOrder = 21;
    this.talkIcon.visible = false;
    if (withTag) this.root.add(this.talkIcon);
    this.x = this.lastX = info.x;
    this.y = info.y;
    this.z = this.lastZ = info.z;
    this.yaw = this.bodyYaw = info.yaw;
    this.pitch = info.pitch;
    this.setHeld(info.held);
    this.setArmor(info.armor ?? 0);
    this.root.position.set(this.x, this.y, this.z);
  }

  /** v6: what they wear (shared/combat.ts packArmor): each piece shows in its material, or not at all. */
  setArmor(packed: number): void {
    if (packed === this.armorPacked) return;
    this.armorPacked = packed;
    const pivots: Record<string, [THREE.Group, number]> = {
      head: [this.head, 4 * PX],
      body: [this.torso, -6 * PX],
      armR: [this.armR, -4 * PX],
      armL: [this.armL, -4 * PX],
      legR: [this.legR, -6 * PX],
      legL: [this.legL, -6 * PX],
    };
    for (const piece of PIECES) {
      let a = this.armor.find((x) => x.slot === piece.slot);
      const material = wornMaterial(packed, piece.slot);
      if (material < 0) {
        if (a) for (const m of a.meshes) m.visible = false;
        continue;
      }
      if (!a) {
        a = { slot: piece.slot, layer: piece.layer, mat: entityMaterial(armorTexture(material, piece.layer)), meshes: [], worn: material };
        for (const name of piece.parts) {
          const [pivot, offY] = pivots[name];
          const mesh = armorMesh(a.mat!, ARMOR_BOX[name], offY, piece.grow);
          pivot.add(mesh);
          a.meshes.push(mesh);
        }
        this.armor.push(a);
      } else if (a.worn !== material) {
        a.mat!.uniforms.map.value = armorTexture(material, piece.layer);
        a.worn = material;
      }
      for (const m of a.meshes) m.visible = true;
    }
  }

  private heldFactory: (id: number) => THREE.Mesh | null;

  setHeld(id: number): void {
    if (id === this.heldId) return;
    this.heldId = id;
    if (this.heldMesh) {
      this.armR.remove(this.heldMesh);
      this.heldMesh = null;
    }
    if (!id || !itemDef(id)) return;
    const m = this.heldFactory(id);
    if (!m) return;
    m.matrixAutoUpdate = false;
    m.matrix.copy(thirdPersonHeld(id));
    this.armR.add(m);
    this.heldMesh = m;
  }

  push(s: PlayerSnap, t: number): void {
    this.snaps.push({ t, x: s.x, y: s.y, z: s.z, yaw: s.yaw, pitch: s.pitch, flags: s.flags, held: s.held });
    if (this.snaps.length > 30) this.snaps.shift();
  }

  teleport(x: number, y: number, z: number): void {
    this.snaps.length = 0;
    this.x = this.lastX = x;
    this.y = y;
    this.z = this.lastZ = z;
  }

  startSwing(): void {
    this.swing = 0;
    this.swinging = true;
  }

  /** Called every client tick (20 Hz): limb animation, like Java's walkAnimation. */
  tick(): void {
    const dx = this.x - this.lastX;
    const dz = this.z - this.lastZ;
    this.lastX = this.x;
    this.lastZ = this.z;
    const dist = Math.min(1, Math.sqrt(dx * dx + dz * dz) * 4);
    this.limbAmt += (dist - this.limbAmt) * 0.4;
    this.limbPos += this.limbAmt;
    if (this.swinging) {
      this.swing += 1 / 6;
      if (this.swing >= 1) {
        this.swing = 0;
        this.swinging = false;
      }
    }
    // Body turns toward the movement direction; the head may lead it by up to 50 degrees.
    if (dx * dx + dz * dz > 0.0025) {
      const moveYaw = (Math.atan2(-dx, dz) * 180) / Math.PI;
      this.bodyYaw = approachAngle(this.bodyYaw, moveYaw, 30);
    }
    let diff = wrapDeg(this.yaw - this.bodyYaw);
    if (diff > 50) this.bodyYaw += diff - 50;
    if (diff < -50) this.bodyYaw += diff + 50;
    diff = wrapDeg(this.yaw - this.bodyYaw);
    this.bodyYaw = wrapDeg(this.bodyYaw + diff * 0.1);
  }

  /** Interpolate to render time and pose the model. v8 `seat`: they sit in a boat (feet there, facing its bow);
   *  `rowing`: their arms pull the oars. */
  update(renderTime: number, partial: number, camPos: THREE.Vector3, light: [number, number], seat: { x: number; y: number; z: number; yaw: number } | null = null, rowing = false): void {
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
      this.yaw = a.yaw + wrapDeg(b.yaw - a.yaw) * k;
      this.pitch = a.pitch + (b.pitch - a.pitch) * k;
      this.flags = b.flags;
      this.setHeld(b.held);
      while (snaps.length > 2 && snaps[1].t < renderTime - 1000) snaps.shift();
    }
    const sneaking = (this.flags & FLAG.SNEAK) !== 0;
    // v5: dead players aren't drawn; sleeping ones lie on their back on the bed; eating raises the arm
    this.root.visible = (this.flags & FLAG.DEAD) === 0;
    const asleep = (this.flags & FLAG.SLEEP) !== 0;
    // A quick ease into and out of the crouch (~80 ms), the same at any frame rate.
    const dtMs = this.lastRender ? Math.min(100, Math.max(0, renderTime - this.lastRender)) : 100;
    this.lastRender = renderTime;
    this.sneakAmt += ((sneaking ? 1 : 0) - this.sneakAmt) * (1 - Math.exp(-dtMs / 40));
    if (Math.abs(this.sneakAmt - (sneaking ? 1 : 0)) < 0.002) this.sneakAmt = sneaking ? 1 : 0;
    if (seat) {
      // v8: seated in a boat: where the boat says, the body square to the bow
      this.x = this.lastX = seat.x;
      this.y = seat.y;
      this.z = this.lastZ = seat.z;
      this.bodyYaw = seat.yaw;
      let d = wrapDeg(this.yaw - seat.yaw);
      if (d > 105) d = 105;
      if (d < -105) d = -105;
      this.yaw = seat.yaw + d;
      this.sneakAmt = 0;
    }
    this.root.position.set(this.x, this.y, this.z);
    this.root.rotation.set(0, (-this.bodyYaw * Math.PI) / 180, 0, "YXZ");
    if (asleep) {
      // lying flat, head toward where they face, centred on the bed
      const yr = (this.bodyYaw * Math.PI) / 180;
      this.root.rotation.set(-Math.PI / 2, (-this.bodyYaw * Math.PI) / 180, 0, "YXZ");
      this.root.position.set(this.x + Math.sin(yr) * 0.9, this.y + 0.1, this.z - Math.cos(yr) * 0.9);
    }
    const headYaw = (-wrapDeg(this.yaw - this.bodyYaw) * Math.PI) / 180;
    this.head.rotation.set((this.pitch * Math.PI) / 180, headYaw, 0, "YXZ");
    const lp = this.limbPos + this.limbAmt * partial;
    const la = this.limbAmt;
    this.armR.rotation.x = Math.cos(lp * 0.6662 + Math.PI) * 2 * la * 0.5;
    this.armL.rotation.x = Math.cos(lp * 0.6662) * 2 * la * 0.5;
    this.legR.rotation.x = Math.cos(lp * 0.6662) * 1.4 * la;
    this.legL.rotation.x = Math.cos(lp * 0.6662 + Math.PI) * 1.4 * la;
    this.armR.rotation.z = 0;
    this.armL.rotation.z = 0;
    this.armR.rotation.y = 0;
    this.armL.rotation.y = 0;
    this.armR.rotation.order = "XYZ";
    this.armL.rotation.order = "XYZ";
    if (this.heldMesh) this.armR.rotation.x = this.armR.rotation.x * 0.5 - 0.31;
    if (this.flags & FLAG.EAT && this.heldId === I.BOW) {
      // v7: drawing a bow: both arms up along the look, the left hand forward on the bow, the right at the string
      const pr = (this.pitch * Math.PI) / 180;
      this.armR.rotation.set(-Math.PI / 2 + pr, -0.1 + headYaw, 0, "ZYX");
      this.armL.rotation.set(-Math.PI / 2 + pr, 0.5 + headYaw, 0, "ZYX");
    } else if (this.flags & FLAG.EAT) {
      this.armR.rotation.x = -1.15 + Math.sin(performance.now() / 70) * 0.18;
      this.armR.rotation.z = 0.25;
    }
    if (this.swinging) {
      const f = this.swing + partial / 6;
      const s = Math.sin(Math.sqrt(f) * Math.PI);
      this.armR.rotation.x -= Math.sin(f * Math.PI) * 1.2 + s * 0.5;
      this.armR.rotation.z = Math.sin(f * Math.PI) * -0.4;
    }
    // Crouch, like the classic pose: the torso leans ~28 degrees forward from the neck (hips go back), the head
    // stays level and drops so its centre sits at the 1.27 eye height (top at the 1.5 box), the arms follow the
    // torso, the legs move back under the hips with the feet on the ground, and the nametag drops with the box.
    const sa = this.sneakAmt;
    const drop = 0.125 * sa;
    this.torso.rotation.x = 0.5 * sa;
    this.torso.position.y = (24 - 3.2 * sa) * PX - drop;
    this.head.position.y = (24 - 4.2 * sa) * PX - drop;
    this.armR.position.y = this.armL.position.y = (22 - 3.2 * sa) * PX - drop;
    this.armR.rotation.x += 0.4 * sa;
    this.armL.rotation.x += 0.4 * sa;
    this.legR.position.z = this.legL.position.z = -4 * PX * sa;
    this.legR.position.y = this.legL.position.y = 12 * PX - 0.03 * sa;
    this.tag.position.y = 2.15 - 0.3 * sa;
    if (seat) {
      // sitting: legs out in front along the floor of the boat, arms forward (pulling the oars when rowing)
      this.legR.rotation.set(-1.45, 0, 0.08);
      this.legL.rotation.set(-1.45, 0, -0.08);
      const pull = rowing ? Math.sin(performance.now() / 150) * 0.35 : 0;
      if (!this.swinging) {
        this.armR.rotation.set(-0.75 + pull, 0, -0.12);
        this.armL.rotation.set(-0.75 + pull, 0, 0.12);
      }
      this.tag.position.y = 2.15;
    } else {
      this.legR.rotation.y = this.legL.rotation.y = 0;
      this.legR.rotation.z = this.legL.rotation.z = 0;
    }
    const d = camPos.distanceTo(this.root.position);
    this.tag.visible = d < 64 && !this.ownTag;
    this.talkIcon.visible = this.talkingOn && d < 64;
    this.talkIcon.position.y = this.tag.position.y + 0.42;
    const pulse = this.talkingLive ? 1 + 0.12 * Math.abs(Math.sin(performance.now() / 110)) : 1;
    this.talkIcon.scale.set(0.46 * pulse, 0.46 * pulse, 1);
    // Sneaking players' names are dim and hidden behind walls (no see-through nametag), like the classic game.
    const tm = this.tag.material as THREE.SpriteMaterial;
    tm.opacity = sneaking ? 0.45 : 1;
    tm.depthTest = sneaking;
    this.mat.uniforms.uLight.value.set(light[0], light[1]);
    const hurt = (this.flags & FLAG.HURT) !== 0;
    this.mat.uniforms.uTint.value.setRGB(1, hurt ? 0.45 : 1, hurt ? 0.45 : 1);
    for (const a of this.armor) {
      if (!a.mat) continue;
      a.mat.uniforms.uLight.value.set(light[0], light[1]);
      a.mat.uniforms.uTint.value.setRGB(1, hurt ? 0.45 : 1, hurt ? 0.45 : 1);
    }
  }

  /** v11: talking (the server says so), and whether we are hearing them right now (the icon pulses). */
  setTalking(on: boolean, live: boolean): void {
    this.talkingOn = on || live;
    this.talkingLive = live;
  }

  get talking(): boolean {
    return this.talkingOn;
  }

  dispose(): void {
    this.tag.material.map?.dispose();
    this.tag.material.dispose();
    this.talkIcon.material.dispose();
    this.mat.dispose();
    for (const a of this.armor) {
      a.mat?.dispose();
      for (const m of a.meshes) m.geometry.dispose();
    }
  }
}

export function wrapDeg(a: number): number {
  a %= 360;
  if (a >= 180) a -= 360;
  if (a < -180) a += 360;
  return a;
}

function approachAngle(from: number, to: number, maxStep: number): number {
  const d = wrapDeg(to - from);
  return from + Math.max(-maxStep, Math.min(maxStep, d));
}
