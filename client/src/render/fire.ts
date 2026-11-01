// v6: the flames on a burning mob, the classic way: a stack of fire sheets around it that always face the camera,
// each one a little higher, narrower and farther back, alternating two fires (mirrored every other pair), drawn
// full bright. The fire itself is ours (shared/fire-texture.ts), animated at 20 frames a second.

import * as THREE from "three";
import { FIRE_FRAMES, fireSheet } from "../../../shared/fire-texture.ts";

let material: THREE.MeshBasicMaterial | null = null;
const geometries = new Map<string, THREE.BufferGeometry>();

/** The shared material: every burning mob shows the same frame, like the classic animated textures. */
export function fireMaterial(): THREE.MeshBasicMaterial {
  if (material) return material;
  const s = fireSheet();
  const tex = new THREE.DataTexture(s.rgba, s.width, s.height, THREE.RGBAFormat);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.NoColorSpace;
  tex.repeat.set(1, 1 / FIRE_FRAMES);
  tex.needsUpdate = true;
  material = new THREE.MeshBasicMaterial({ map: tex, alphaTest: 0.5, side: THREE.DoubleSide, fog: false });
  return material;
}

/** Show the frame for this moment (one a tick). */
export function animateFire(now: number): void {
  if (!material) return;
  const f = Math.floor(now / 50) % FIRE_FRAMES;
  material.map!.offset.y = f / FIRE_FRAMES;
}

/** The sheets for a mob `w` wide and `h` tall, in the group's space: x across, y up, z away from the camera (the
 *  group is turned to the camera's yaw). Sized like the classic fire: sheets 1.4 x the mob's width. */
export function fireGeometry(w: number, h: number): THREE.BufferGeometry {
  const key = `${w}:${h}`;
  const cached = geometries.get(key);
  if (cached) return cached;
  const s = w * 1.4;
  const pos: number[] = [];
  const uv: number[] = [];
  const index: number[] = [];
  let left = h / s;
  let half = 0.5;
  let y = 0;
  let z = -0.3 + Math.floor(h / s) * 0.02;
  for (let i = 0; left > 0; i++) {
    // fire 0 or 1 (a hair inside its half of the sheet, so the edges never pick up the other one)
    const u0 = (i % 2 === 0 ? 0 : 0.5) + 0.001;
    const u1 = u0 + 0.498;
    const [uR, uL] = Math.floor(i / 2) % 2 === 0 ? [u0, u1] : [u1, u0];
    const b = pos.length / 3;
    // the frame is stored top row first: v 0 is its top, 1 its bottom (the texture's repeat and offset pick it)
    pos.push(half * s, y * s, z * s, -half * s, y * s, z * s, -half * s, (y + 1.4) * s, z * s, half * s, (y + 1.4) * s, z * s);
    uv.push(uR, 0.998, uL, 0.998, uL, 0.002, uR, 0.002);
    index.push(b, b + 1, b + 2, b, b + 2, b + 3);
    left -= 0.45;
    y += 0.45;
    half *= 0.9;
    z += 0.03;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(index);
  geometries.set(key, g);
  return g;
}
