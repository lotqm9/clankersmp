// Arrows (protocol v6): a Rattler's shot arrives once ({t: "arrow"}: where and how fast) and every client flies it
// with the same physics as the server (shared/mobs.ts arrowMove), so it needs no more traffic. The server says where
// it ended: stuck in a block (it stays there, quivering, for a minute) or gone (it hit someone, or vanished at the
// safe zone). v7: players' arrows fly the same way; a stuck one goes when someone picks it up ({t: "arrow_gone"}).
// A small model painted in code: a dark shaft, a grey head, pale fletching.

import * as THREE from "three";
import { arrowBlockHit, arrowMove, type ArrowState } from "../../../shared/mobs.ts";
import type { GetBlock } from "../../../shared/physics.ts";
import { Painter, boxGeometry, type BoxDef } from "./animals.ts";
import { entityMaterial } from "./shaders.ts";
import { canvasTexture } from "./textures.ts";

const PX = 1 / 16;
const SHAFT: BoxDef = { u: 0, v: 0, w: 1, h: 1, d: 13 };
const HEAD: BoxDef = { u: 0, v: 16, w: 2, h: 2, d: 3 };
const FLETCH: BoxDef = { u: 0, v: 24, w: 3, h: 3, d: 3 };
const STUCK_MS = 65000; // v7: a minute, like the server's (players' arrows go sooner if picked up)

let tex: THREE.Texture | null = null;
function texture(): THREE.Texture {
  if (!tex) {
    const p = new Painter(4242);
    p.box(SHAFT, "#6b4a2a", (put, w, h, f) => {
      if (f === "top" || f === "left") for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) put(x, y, "#86603a");
    });
    p.box(HEAD, "#8a8a92", (put, w, h) => put(Math.floor(w / 2), Math.floor(h / 2), "#c8c8d0"));
    p.box(FLETCH, "#e8e2d2", (put, w, h, f) => {
      if (f !== "top" && f !== "bottom") for (let x = 0; x < w; x++) put(x, h - 1, "#b8452f");
    });
    tex = canvasTexture(p.done());
  }
  return tex;
}

export class ArrowView {
  readonly id: number;
  readonly root = new THREE.Group();
  private s: ArrowState;
  private prev: ArrowState;
  private mat: THREE.ShaderMaterial;
  flying = true;
  private stuckAt = 0;
  private quiver = 0;

  constructor(id: number, s: ArrowState) {
    this.id = id;
    this.s = { ...s };
    this.prev = { ...s };
    this.mat = entityMaterial(texture());
    const shaft = new THREE.Mesh(boxGeometry(SHAFT), this.mat);
    const head = new THREE.Mesh(boxGeometry(HEAD), this.mat);
    head.position.z = 7 * PX;
    const fletch = new THREE.Mesh(boxGeometry(FLETCH), this.mat);
    fletch.position.z = -5.5 * PX;
    fletch.scale.set(1, 1, 1);
    this.root.add(shaft, head, fletch);
    this.place(1);
  }

  /** 20 Hz: fly (and stop at the first block, until the server says where it really ended). */
  tick(get: GetBlock): void {
    if (!this.flying) {
      if (this.quiver > 0) this.quiver--;
      return;
    }
    this.prev = { ...this.s };
    const t = arrowBlockHit(this.s, get);
    if (t >= 0) {
      this.s.x += this.s.vx * t;
      this.s.y += this.s.vy * t;
      this.s.z += this.s.vz * t;
      this.stick();
      return;
    }
    arrowMove(this.s, get);
  }

  private stick(): void {
    this.flying = false;
    this.stuckAt = performance.now();
    this.quiver = 7;
    this.prev = { ...this.s };
  }

  /** The server's word: where it ended, and whether it stuck in a block. Returns false when it should go now. */
  end(x: number, y: number, z: number, stuck: boolean): boolean {
    if (!stuck) return false;
    this.s.x = x;
    this.s.y = y;
    this.s.z = z;
    if (this.flying) this.stick();
    else this.prev = { ...this.s };
    return true;
  }

  /** Frame: position between ticks, nose along the flight. False when a stuck arrow has had its time. */
  update(partial: number, light: [number, number]): boolean {
    if (!this.flying && performance.now() - this.stuckAt > STUCK_MS) return false;
    this.place(this.flying ? partial : 1);
    if (this.quiver > 0) this.root.rotateX(Math.sin(this.quiver * 2.2) * 0.05 * this.quiver);
    this.mat.uniforms.uLight.value.set(light[0], light[1]);
    return true;
  }

  private place(partial: number): void {
    const a = this.prev;
    const b = this.s;
    this.root.position.set(a.x + (b.x - a.x) * partial, a.y + (b.y - a.y) * partial, a.z + (b.z - a.z) * partial);
    const yaw = Math.atan2(b.vx, b.vz);
    const pitch = Math.atan2(b.vy, Math.hypot(b.vx, b.vz));
    this.root.rotation.set(-pitch, yaw, 0, "YXZ");
  }

  get x(): number {
    return this.s.x;
  }
  get y(): number {
    return this.s.y;
  }
  get z(): number {
    return this.s.z;
  }

  dispose(): void {
    this.mat.dispose();
  }
}
