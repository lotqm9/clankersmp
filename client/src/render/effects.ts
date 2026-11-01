// Block outline, crack overlay and block particles; v6 also fire, critical-hit sparks, bone meal and smoke puffs.

import * as THREE from "three";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { B, BLOCKS, SOLID, TEX } from "../../../shared/blocks.ts";
import { WORLD_HEIGHT, WORLD_SIZE } from "../../../shared/constants.ts";
import { mulberry32 } from "../../../shared/noise.ts";
import { crackMaterial, particleMaterial } from "./shaders.ts";

export interface Box {
  x0: number;
  y0: number;
  z0: number;
  x1: number;
  y1: number;
  z1: number;
}

export class Selection {
  readonly outline: LineSegments2;
  readonly crack: THREE.Mesh;
  private lineMat: LineMaterial;
  private crackMat: THREE.ShaderMaterial;

  constructor(atlas: THREE.Texture) {
    const g = new LineSegmentsGeometry();
    const e = [
      [0, 0, 0, 1, 0, 0], [1, 0, 0, 1, 0, 1], [1, 0, 1, 0, 0, 1], [0, 0, 1, 0, 0, 0],
      [0, 1, 0, 1, 1, 0], [1, 1, 0, 1, 1, 1], [1, 1, 1, 0, 1, 1], [0, 1, 1, 0, 1, 0],
      [0, 0, 0, 0, 1, 0], [1, 0, 0, 1, 1, 0], [1, 0, 1, 1, 1, 1], [0, 0, 1, 0, 1, 1],
    ].flat();
    g.setPositions(e);
    this.lineMat = new LineMaterial({ color: 0x000000, linewidth: 2, transparent: true, opacity: 0.45, depthWrite: false });
    this.outline = new LineSegments2(g, this.lineMat);
    this.outline.visible = false;
    this.outline.renderOrder = 10;
    this.outline.frustumCulled = false;
    this.crackMat = crackMaterial(atlas);
    this.crack = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), this.crackMat);
    this.crack.visible = false;
    this.crack.renderOrder = 9;
  }

  setResolution(w: number, h: number): void {
    this.lineMat.resolution.set(w, h);
  }

  show(box: Box | null): void {
    if (!box) {
      this.outline.visible = false;
      return;
    }
    const e = 0.002;
    this.outline.visible = true;
    this.outline.position.set(box.x0 - e, box.y0 - e, box.z0 - e);
    this.outline.scale.set(box.x1 - box.x0 + 2 * e, box.y1 - box.y0 + 2 * e, box.z1 - box.z0 + 2 * e);
  }

  /** Crack overlay on the block's outline box (a full cube unless given, e.g. slabs and fences). */
  setCrack(x: number, y: number, z: number, stage: number, box?: Box): void {
    if (stage < 0) {
      this.crack.visible = false;
      return;
    }
    const b = box ?? { x0: 0, y0: 0, z0: 0, x1: 1, y1: 1, z1: 1 };
    this.crack.visible = true;
    this.crack.position.set(x + (b.x0 + b.x1) / 2, y + (b.y0 + b.y1) / 2, z + (b.z0 + b.z1) / 2);
    this.crack.scale.set(b.x1 - b.x0 + 0.004, b.y1 - b.y0 + 0.004, b.z1 - b.z0 + 0.004);
    this.crackMat.uniforms.uLayer.value = TEX.crack0 + Math.min(9, stage);
  }
}

const MAX = 3000;
const FULL: [number, number] = [1, 1]; // sparks glow

export class Particles {
  readonly points: THREE.Points;
  private pos = new Float32Array(MAX * 3);
  private prev = new Float32Array(MAX * 3);
  private vel = new Float32Array(MAX * 3);
  private life = new Int16Array(MAX);
  private grav = new Float32Array(MAX); // per particle: chips fall (0.04), fire and smoke rise (negative)
  private data = new Float32Array(MAX * 4);
  private light = new Float32Array(MAX * 2);
  private count = 0;
  private geom: THREE.BufferGeometry;
  private render = new Float32Array(MAX * 3);
  private rand = mulberry32(7);
  readonly material: THREE.ShaderMaterial;

  constructor(atlas: THREE.Texture) {
    this.geom = new THREE.BufferGeometry();
    this.geom.setAttribute("position", new THREE.BufferAttribute(this.render, 3).setUsage(THREE.DynamicDrawUsage));
    this.geom.setAttribute("pdata", new THREE.BufferAttribute(this.data, 4).setUsage(THREE.DynamicDrawUsage));
    this.geom.setAttribute("plight", new THREE.BufferAttribute(this.light, 2).setUsage(THREE.DynamicDrawUsage));
    this.geom.setDrawRange(0, 0);
    this.material = particleMaterial(atlas);
    this.points = new THREE.Points(this.geom, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 3;
  }

  setScale(viewportHeight: number, fovDeg: number): void {
    this.material.uniforms.uScale.value = viewportHeight / 2 / Math.tan((fovDeg * Math.PI) / 360);
  }

  private add(x: number, y: number, z: number, vx: number, vy: number, vz: number, layer: number, size: number, life: number, light: [number, number], grav = 0.04): void {
    if (this.count >= MAX) return;
    const i = this.count++;
    this.grav[i] = grav;
    this.pos[i * 3] = this.prev[i * 3] = x;
    this.pos[i * 3 + 1] = this.prev[i * 3 + 1] = y;
    this.pos[i * 3 + 2] = this.prev[i * 3 + 2] = z;
    this.vel[i * 3] = vx;
    this.vel[i * 3 + 1] = vy;
    this.vel[i * 3 + 2] = vz;
    this.life[i] = life;
    this.data[i * 4] = layer;
    this.data[i * 4 + 1] = Math.floor(this.rand() * 13) / 16;
    this.data[i * 4 + 2] = Math.floor(this.rand() * 13) / 16;
    this.data[i * 4 + 3] = size;
    this.light[i * 2] = light[0];
    this.light[i * 2 + 1] = light[1];
  }

  private layerFor(id: number): number {
    if (id === B.GRASS) return TEX.dirt;
    return BLOCKS[id]?.tex[0] ?? TEX.stone;
  }

  /** Java's destroy effect: a 4x4x4 burst of little texture chips. */
  breakBlock(x: number, y: number, z: number, id: number, light: [number, number]): void {
    const layer = this.layerFor(id);
    const r = this.rand;
    for (let i = 0; i < 4; i++)
      for (let j = 0; j < 4; j++)
        for (let k = 0; k < 4; k++) {
          const px = x + (i + 0.5) / 4;
          const py = y + (j + 0.5) / 4;
          const pz = z + (k + 0.5) / 4;
          let vx = px - x - 0.5 + (r() * 2 - 1) * 0.4;
          let vy = py - y - 0.5 + (r() * 2 - 1) * 0.4;
          let vz = pz - z - 0.5 + (r() * 2 - 1) * 0.4;
          const f = (r() + r() + 1) * 0.15;
          const len = Math.sqrt(vx * vx + vy * vy + vz * vz) || 1;
          vx = (vx / len) * f * 0.4;
          vy = (vy / len) * f * 0.4 + 0.1;
          vz = (vz / len) * f * 0.4;
          this.add(px, py, pz, vx, vy, vz, layer, 0.1 + r() * 0.1, Math.floor(4 / (r() * 0.9 + 0.1)), light);
        }
  }

  /** Small chips flying off the face being dug. */
  hitFace(x: number, y: number, z: number, face: number, id: number, light: [number, number]): void {
    const r = this.rand;
    let px = x + r() * 0.8 + 0.1;
    let py = y + r() * 0.8 + 0.1;
    let pz = z + r() * 0.8 + 0.1;
    if (face === 0) px = x + 1.05;
    if (face === 1) px = x - 0.05;
    if (face === 2) py = y + 1.05;
    if (face === 3) py = y - 0.05;
    if (face === 4) pz = z + 1.05;
    if (face === 5) pz = z - 0.05;
    this.add(px, py, pz, (r() - 0.5) * 0.08, r() * 0.05, (r() - 0.5) * 0.08, this.layerFor(id), 0.06 + r() * 0.06, Math.floor(4 / (r() * 0.9 + 0.1)), light);
  }

  /** Crumbs of the food you're eating, in front of your face. */
  food(x: number, y: number, z: number, yaw: number, pitch: number, layer: number, light: [number, number]): void {
    const r = this.rand;
    const fx = -Math.sin((yaw * Math.PI) / 180) * Math.cos((pitch * Math.PI) / 180);
    const fz = Math.cos((yaw * Math.PI) / 180) * Math.cos((pitch * Math.PI) / 180);
    const fy = -Math.sin((pitch * Math.PI) / 180);
    for (let i = 0; i < 5; i++) {
      this.add(x + fx * 0.45 + (r() - 0.5) * 0.15, y + fy * 0.45, z + fz * 0.45 + (r() - 0.5) * 0.15, fx * 0.05 + (r() - 0.5) * 0.06, 0.05 + r() * 0.06, fz * 0.05 + (r() - 0.5) * 0.06, layer, 0.05 + r() * 0.04, 10 + Math.floor(r() * 8), light);
    }
  }

  /** Java spawns a burst of the block under you when you land from a height. */
  landing(x: number, y: number, z: number, id: number, count: number, light: [number, number]): void {
    const r = this.rand;
    for (let i = 0; i < count; i++) {
      const a = r() * Math.PI * 2;
      const sp = 0.05 + r() * 0.15;
      this.add(x + (r() - 0.5) * 0.6, y + 0.05, z + (r() - 0.5) * 0.6, Math.cos(a) * sp, 0.1 + r() * 0.15, Math.sin(a) * sp, this.layerFor(id), 0.08 + r() * 0.08, Math.floor(4 / (r() * 0.9 + 0.1)), light);
    }
  }

  /** A critical hit: a burst of pale sparks around the target. */
  crit(x: number, y: number, z: number): void {
    const r = this.rand;
    for (let i = 0; i < 16; i++) {
      const a = r() * Math.PI * 2;
      const sp = 0.12 + r() * 0.2;
      this.add(x, y, z, Math.cos(a) * sp, 0.1 + r() * 0.25, Math.sin(a) * sp, TEX.fx_crit, 0.05 + r() * 0.05, 8 + Math.floor(r() * 10), FULL, 0.03);
    }
  }

  /** Bone meal on a sapling: green sparkles drifting up. */
  green(x: number, y: number, z: number): void {
    const r = this.rand;
    for (let i = 0; i < 12; i++)
      this.add(x + (r() - 0.5) * 0.9, y + r() * 0.6, z + (r() - 0.5) * 0.9, 0, 0.01 + r() * 0.03, 0, TEX.fx_green, 0.05 + r() * 0.04, 20 + Math.floor(r() * 20), FULL, -0.001);
  }

  /** A mob is gone: a puff of grey smoke where it fell. */
  poof(x: number, y: number, z: number, w: number, h: number): void {
    const r = this.rand;
    for (let i = 0; i < 22; i++)
      this.add(x + (r() - 0.5) * w, y + r() * h, z + (r() - 0.5) * w, (r() - 0.5) * 0.08, 0.02 + r() * 0.06, (r() - 0.5) * 0.08, TEX.fx_smoke, 0.1 + r() * 0.12, 14 + Math.floor(r() * 14), [0.85, 0.3], -0.003);
  }

  /** The little trail of block chips behind a sprinting player. */
  sprint(x: number, y: number, z: number, vx: number, vz: number, id: number, light: [number, number]): void {
    const r = this.rand;
    this.add(x + (r() - 0.5) * 0.6, y + 0.1, z + (r() - 0.5) * 0.6, -vx * 0.5 + (r() - 0.5) * 0.05, 0.08 + r() * 0.06, -vz * 0.5 + (r() - 0.5) * 0.05, this.layerFor(id), 0.07 + r() * 0.06, Math.floor(4 / (r() * 0.9 + 0.1)), light);
  }

  tick(get: (x: number, y: number, z: number) => number): void {
    let n = this.count;
    for (let i = 0; i < n; i++) {
      if (--this.life[i] <= 0) {
        n--;
        this.copy(n, i);
        i--;
        continue;
      }
      const o = i * 3;
      this.prev[o] = this.pos[o];
      this.prev[o + 1] = this.pos[o + 1];
      this.prev[o + 2] = this.pos[o + 2];
      this.vel[o + 1] -= this.grav[i];
      let nx = this.pos[o] + this.vel[o];
      let ny = this.pos[o + 1] + this.vel[o + 1];
      let nz = this.pos[o + 2] + this.vel[o + 2];
      const solid = (px: number, py: number, pz: number) => {
        const bx = Math.floor(px);
        const by = Math.floor(py);
        const bz = Math.floor(pz);
        if (bx < 0 || bz < 0 || bx >= WORLD_SIZE || bz >= WORLD_SIZE || by < 0 || by >= WORLD_HEIGHT) return false;
        return SOLID[get(bx, by, bz)] === 1;
      };
      if (solid(this.pos[o], ny, this.pos[o + 2])) {
        ny = this.vel[o + 1] < 0 ? Math.floor(this.pos[o + 1]) + 0.02 : this.pos[o + 1];
        this.vel[o + 1] = 0;
        this.vel[o] *= 0.7;
        this.vel[o + 2] *= 0.7;
      }
      if (solid(nx, ny, this.pos[o + 2])) {
        nx = this.pos[o];
        this.vel[o] = 0;
      }
      if (solid(nx, ny, nz)) {
        nz = this.pos[o + 2];
        this.vel[o + 2] = 0;
      }
      this.pos[o] = nx;
      this.pos[o + 1] = ny;
      this.pos[o + 2] = nz;
      this.vel[o] *= 0.98;
      this.vel[o + 1] *= 0.98;
      this.vel[o + 2] *= 0.98;
    }
    this.count = n;
  }

  private copy(from: number, to: number): void {
    for (let k = 0; k < 3; k++) {
      this.pos[to * 3 + k] = this.pos[from * 3 + k];
      this.prev[to * 3 + k] = this.prev[from * 3 + k];
      this.vel[to * 3 + k] = this.vel[from * 3 + k];
    }
    for (let k = 0; k < 4; k++) this.data[to * 4 + k] = this.data[from * 4 + k];
    this.light[to * 2] = this.light[from * 2];
    this.light[to * 2 + 1] = this.light[from * 2 + 1];
    this.life[to] = this.life[from];
    this.grav[to] = this.grav[from];
  }

  update(partial: number): void {
    const n = this.count;
    for (let i = 0; i < n * 3; i++) this.render[i] = this.prev[i] + (this.pos[i] - this.prev[i]) * partial;
    this.geom.setDrawRange(0, n);
    (this.geom.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
    (this.geom.getAttribute("pdata") as THREE.BufferAttribute).needsUpdate = true;
    (this.geom.getAttribute("plight") as THREE.BufferAttribute).needsUpdate = true;
  }
}
