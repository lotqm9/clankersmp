// Dropped items (protocol v5): the server sends where they are; we draw them bobbing and slowly turning, blocks as
// small cubes and other items as thick sprites, more copies for bigger stacks (like the classic game), and when
// someone picks one up it flies into them.

import * as THREE from "three";
import type { ItemSnap } from "../../../shared/drops.ts";
import { isFlatItem, itemGeometry } from "./hand.ts";

interface Snap {
  t: number;
  x: number;
  y: number;
  z: number;
}

export class DropView {
  readonly id: number;
  item: number;
  n: number;
  readonly root = new THREE.Group();
  private mat: THREE.ShaderMaterial;
  private copies: THREE.Mesh[] = [];
  private snaps: Snap[] = [];
  private phase = Math.random() * Math.PI * 2;
  x = 0;
  y = 0;
  z = 0;
  /** Flying into a player: where to, and when it started (ms). */
  flying: { to: () => [number, number, number]; t0: number; from: [number, number, number] } | null = null;

  constructor(s: ItemSnap, mat: THREE.ShaderMaterial) {
    this.id = s.id;
    this.item = s.item;
    this.n = s.n;
    this.mat = mat;
    this.x = s.x;
    this.y = s.y;
    this.z = s.z;
    this.build();
  }

  private build(): void {
    for (const m of this.copies) this.root.remove(m);
    this.copies = [];
    const geo = itemGeometry(this.item);
    const flat = isFlatItem(this.item);
    const k = this.n >= 33 ? 4 : this.n >= 17 ? 3 : this.n >= 2 ? 2 : 1;
    for (let c = 0; c < k; c++) {
      const m = new THREE.Mesh(geo, this.mat);
      m.scale.setScalar(flat ? 0.5 : 0.25);
      // extra copies sit a little apart (stacked sprites, or a small heap of blocks)
      if (flat) m.position.set(c * 0.03, c * 0.02, -c * 0.06);
      else m.position.set(((c * 37) % 7) / 7 * 0.16 - 0.08, c * 0.05, ((c * 53) % 5) / 5 * 0.16 - 0.08);
      this.root.add(m);
      this.copies.push(m);
    }
  }

  push(s: ItemSnap, t: number): void {
    if (s.item !== this.item || copiesFor(s.n) !== copiesFor(this.n)) {
      this.item = s.item;
      this.n = s.n;
      this.build();
    }
    this.n = s.n;
    this.snaps.push({ t, x: s.x, y: s.y, z: s.z });
    if (this.snaps.length > 12) this.snaps.shift();
  }

  /** Returns false when it has finished flying into a player (remove it). */
  update(renderTime: number, now: number): boolean {
    if (this.flying) {
      const f = this.flying;
      const k = Math.min(1, (now - f.t0) / 150);
      const [tx, ty, tz] = f.to();
      this.root.position.set(f.from[0] + (tx - f.from[0]) * k, f.from[1] + (ty + 0.8 - f.from[1]) * k, f.from[2] + (tz - f.from[2]) * k);
      this.root.scale.setScalar(1 - k * 0.6);
      return k < 1;
    }
    const s = this.snaps;
    if (s.length) {
      let a = s[0];
      let b = s[s.length - 1];
      for (let i = 0; i < s.length - 1; i++)
        if (s[i].t <= renderTime && s[i + 1].t >= renderTime) {
          a = s[i];
          b = s[i + 1];
          break;
        }
      if (renderTime >= b.t) a = b;
      const span = b.t - a.t;
      const k = span > 0 ? THREE.MathUtils.clamp((renderTime - a.t) / span, 0, 1) : 1;
      this.x = a.x + (b.x - a.x) * k;
      this.y = a.y + (b.y - a.y) * k;
      this.z = a.z + (b.z - a.z) * k;
    }
    const bob = Math.sin(now / 320 + this.phase) * 0.05 + 0.13;
    this.root.position.set(this.x, this.y + bob, this.z);
    this.root.rotation.y = now / 1100 + this.phase;
    return true;
  }

  setLight(sky: number, block: number): void {
    this.mat.uniforms.uLight.value.set(sky, block);
  }

  startFlying(to: () => [number, number, number]): void {
    this.flying = { to, t0: performance.now(), from: [this.root.position.x, this.root.position.y, this.root.position.z] };
  }

  dispose(): void {
    this.mat.dispose();
  }
}

const copiesFor = (n: number) => (n >= 33 ? 4 : n >= 17 ? 3 : n >= 2 ? 2 : 1);
