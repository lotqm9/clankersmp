// Receives section meshes from the worker and keeps one three.js Mesh per section (solid + water).

import * as THREE from "three";
import { CHUNK, CHUNKS, SECTIONS } from "../../../shared/constants.ts";
import type { MeshArrays } from "../worker/mesher.ts";

interface Section {
  cx: number;
  cy: number;
  cz: number;
  solid: THREE.Mesh | null;
  water: THREE.Mesh | null;
}

interface MeshMsg {
  key: number;
  cx: number;
  cy: number;
  cz: number;
  solid: MeshArrays | null;
  water: MeshArrays | null;
}

const RADIUS = Math.sqrt(3) * CHUNK * 0.5 + 1;

export class ChunkManager {
  readonly worker: Worker;
  readonly group = new THREE.Group();
  private sections = new Map<number, Section>();
  private received = new Set<number>();
  private solidMat: THREE.Material;
  private waterMat: THREE.Material;
  pending = 0;
  meshUpdates = 0;
  onReady: (() => void) | null = null;
  onLight: ((id: number, values: number[]) => void) | null = null;
  onError: ((msg: string) => void) | null = null;
  vertexCount = 0;

  constructor(solidMat: THREE.Material, waterMat: THREE.Material) {
    this.solidMat = solidMat;
    this.waterMat = waterMat;
    this.worker = new Worker(new URL("../worker/mesher.worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (e) => this.onMessage(e.data);
    this.worker.onerror = (e) => {
      console.error("mesher worker error", e.message);
      this.onError?.(e.message || "terrain worker crashed");
    };
    this.group.matrixAutoUpdate = false;
  }

  /** Hands the worker its own copy of the world (generated + edited on the main thread). */
  init(blocks: Uint8Array, x: number, y: number, z: number, radius: number): void {
    const copy = blocks.slice();
    this.worker.postMessage({ type: "init", blocks: copy, x, y, z, radius }, [copy.buffer]);
  }

  /** Mesh radius in chunks (render distance + 1). */
  setRadius(radius: number): void {
    this.worker.postMessage({ type: "radius", radius });
  }

  replaceWorld(blocks: Uint8Array): void {
    const copy = blocks.slice();
    this.worker.postMessage({ type: "full", blocks: copy }, [copy.buffer]);
  }

  /** Flat list x,y,z,id,... */
  setBlocks(list: number[]): void {
    if (list.length) this.worker.postMessage({ type: "set", list });
  }

  updatePos(x: number, y: number, z: number): void {
    this.worker.postMessage({ type: "pos", x, y, z });
  }

  /** Ask the worker for light values (sky << 4 | block) at cell indices; answered via onLight. */
  requestLight(id: number, cells: number[]): void {
    this.worker.postMessage({ type: "light", id, cells });
  }

  private onMessage(m: { type: string; list?: MeshMsg[]; pending?: number; id?: number; values?: number[]; keys?: number[] }): void {
    if (m.type === "ready") {
      this.onReady?.();
      return;
    }
    if (m.type === "drop") {
      for (const k of m.keys ?? []) {
        this.received.delete(k);
        const sec = this.sections.get(k);
        if (!sec) continue;
        sec.solid = this.swap(sec.solid, null, this.solidMat, sec as unknown as MeshMsg, 0);
        sec.water = this.swap(sec.water, null, this.waterMat, sec as unknown as MeshMsg, 1);
        this.sections.delete(k);
      }
      return;
    }
    if (m.type === "light") {
      this.onLight?.(m.id ?? 0, m.values ?? []);
      return;
    }
    if (m.type !== "meshes" || !m.list) return;
    this.pending = m.pending ?? 0;
    for (const s of m.list) {
      this.received.add(s.key);
      let sec = this.sections.get(s.key);
      if (!sec) {
        if (!s.solid && !s.water) continue;
        sec = { cx: s.cx, cy: s.cy, cz: s.cz, solid: null, water: null };
        this.sections.set(s.key, sec);
      }
      sec.solid = this.swap(sec.solid, s.solid, this.solidMat, s, 0);
      sec.water = this.swap(sec.water, s.water, this.waterMat, s, 1);
      this.meshUpdates++;
      if (!sec.solid && !sec.water) this.sections.delete(s.key);
    }
  }

  private swap(old: THREE.Mesh | null, data: MeshArrays | null, mat: THREE.Material, s: MeshMsg, order: number): THREE.Mesh | null {
    if (old) {
      this.vertexCount -= old.geometry.getAttribute("position").count;
      old.geometry.dispose();
      if (!data) {
        this.group.remove(old);
        return null;
      }
    }
    if (!data) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(data.pos, 3));
    g.setAttribute("uvp", new THREE.BufferAttribute(data.uv, 4));
    g.setAttribute("data", new THREE.BufferAttribute(data.data, 4));
    g.setIndex(new THREE.BufferAttribute(data.index, 1));
    g.boundingSphere = new THREE.Sphere(
      new THREE.Vector3(s.cx * CHUNK + CHUNK / 2, s.cy * CHUNK + CHUNK / 2, s.cz * CHUNK + CHUNK / 2),
      RADIUS,
    );
    this.vertexCount += data.pos.length / 3;
    if (old) {
      old.geometry = g;
      return old;
    }
    const mesh = new THREE.Mesh(g, mat);
    mesh.matrixAutoUpdate = false;
    mesh.renderOrder = order;
    mesh.frustumCulled = true;
    this.group.add(mesh);
    return mesh;
  }

  /** How many sections within `r` chunks of (x, z) have been meshed at least once (for the loading bar). */
  progressAround(x: number, z: number, r: number): { done: number; total: number } {
    const pcx = Math.floor(x / CHUNK);
    const pcz = Math.floor(z / CHUNK);
    let done = 0;
    let total = 0;
    for (let cz = pcz - r; cz <= pcz + r; cz++)
      for (let cx = pcx - r; cx <= pcx + r; cx++) {
        if (cx < 0 || cz < 0 || cx >= CHUNKS || cz >= CHUNKS) continue;
        for (let cy = 0; cy < SECTIONS; cy++) {
          total++;
          if (this.received.has((cy * CHUNKS + cz) * CHUNKS + cx)) done++;
        }
      }
    return { done, total };
  }

  /** Hide sections beyond the render distance (horizontal, in chunks). */
  updateVisibility(x: number, z: number, renderDistance: number): void {
    const r = (renderDistance + 0.5) * CHUNK;
    for (const s of this.sections.values()) {
      const dx = s.cx * CHUNK + CHUNK / 2 - x;
      const dz = s.cz * CHUNK + CHUNK / 2 - z;
      const vis = dx * dx + dz * dz <= r * r;
      if (s.solid) s.solid.visible = vis;
      if (s.water) s.water.visible = vis;
    }
  }
}
