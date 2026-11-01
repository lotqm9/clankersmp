// Sky dome, sun, moon, stars and blocky clouds, all driven by the server's world time.

import * as THREE from "three";
import { DAY_TICKS, WORLD_SIZE } from "../../../shared/constants.ts";
import { mulberry32 } from "../../../shared/noise.ts";
import { U, cloudMaterial, skyMaterial } from "./shaders.ts";
import { moonTexture, sunTexture } from "./textures.ts";

/** Java's celestial angle: 0 at noon, 0.25 at sunset, 0.5 at midnight, 0.75 at sunrise (eased). */
export function celestialAngle(time: number): number {
  let f = (time % DAY_TICKS) / DAY_TICKS - 0.25;
  if (f < 0) f += 1;
  if (f > 1) f -= 1;
  const g = f;
  f = 1 - (Math.cos(f * Math.PI) + 1) / 2;
  return g + (f - g) / 3;
}

/** 1 in full daylight, 0 at night. */
export function daylight(time: number): number {
  const a = celestialAngle(time);
  return THREE.MathUtils.clamp(Math.cos(a * Math.PI * 2) * 2 + 0.5, 0, 1);
}

const DAY_ZENITH = new THREE.Color(0.47, 0.65, 1.0);
const DAY_HORIZON = new THREE.Color(0.73, 0.83, 1.0);
const NIGHT_ZENITH = new THREE.Color(0.0, 0.0, 0.02);
const NIGHT_HORIZON = new THREE.Color(0.03, 0.04, 0.09);
const SUNSET = new THREE.Color(0.98, 0.5, 0.2);
const WATER_FOG = new THREE.Color(0.05, 0.1, 0.35);

const CLOUD_Y = 116;
const CLOUD_CELL = 12;
const CLOUD_GRID = 64; // 64 * 12 = 768 blocks per tile
const CLOUD_SPAN = CLOUD_GRID * CLOUD_CELL;

export class Sky {
  readonly group = new THREE.Group();
  private dome: THREE.Mesh;
  private domeMat: THREE.ShaderMaterial;
  private stars: THREE.Points;
  private sun: THREE.Mesh;
  private moon: THREE.Mesh;
  private celestial = new THREE.Group();
  readonly clouds: THREE.Group;
  private cloudMat: THREE.ShaderMaterial;
  fogColor = new THREE.Color();
  dayLight = 1;

  constructor() {
    this.domeMat = skyMaterial();
    this.dome = new THREE.Mesh(new THREE.SphereGeometry(300, 32, 16), this.domeMat);
    this.dome.renderOrder = -20;
    this.dome.frustumCulled = false;
    this.group.add(this.dome);

    // Stars
    const rand = mulberry32(99);
    const n = 1500;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const u = rand() * 2 - 1;
      const t = rand() * Math.PI * 2;
      const r = Math.sqrt(1 - u * u);
      pos[i * 3] = r * Math.cos(t) * 260;
      pos[i * 3 + 1] = u * 260;
      pos[i * 3 + 2] = r * Math.sin(t) * 260;
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    this.stars = new THREE.Points(
      sg,
      new THREE.PointsMaterial({ color: 0xffffff, size: 1.6, sizeAttenuation: false, transparent: true, depthWrite: false, depthTest: true, opacity: 0, fog: false }),
    );
    this.stars.renderOrder = -19;
    this.stars.frustumCulled = false;
    this.celestial.add(this.stars);

    const sunMat = new THREE.MeshBasicMaterial({ map: sunTexture(), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: true, fog: false });
    this.sun = new THREE.Mesh(new THREE.PlaneGeometry(48, 48), sunMat);
    this.sun.position.set(0, 220, 0);
    this.sun.rotation.x = Math.PI / 2;
    this.sun.renderOrder = -18;
    const moonMat = new THREE.MeshBasicMaterial({ map: moonTexture(), transparent: true, depthWrite: false, depthTest: true, fog: false });
    this.moon = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), moonMat);
    this.moon.position.set(0, -220, 0);
    this.moon.rotation.x = -Math.PI / 2;
    this.moon.renderOrder = -18;
    this.celestial.add(this.sun, this.moon);
    this.celestial.renderOrder = -18;
    this.group.add(this.celestial);
    for (const o of [this.sun, this.moon]) o.frustumCulled = false;

    this.cloudMat = cloudMaterial();
    this.clouds = new THREE.Group();
    const geo = buildClouds();
    for (let i = 0; i < 4; i++) {
      const m = new THREE.Mesh(geo, this.cloudMat);
      m.renderOrder = 5;
      m.frustumCulled = false;
      this.clouds.add(m);
    }
  }

  /** time: world ticks (fractional), cam: camera position, underwater: eye in water. */
  update(time: number, cam: THREE.Vector3, renderDistance: number, underwater: boolean, gamma: number): void {
    const angle = celestialAngle(time);
    const d = daylight(time);
    this.dayLight = d;
    this.group.position.copy(cam);

    // Sun path: rises in the east (+X), sets in the west (-X), passing overhead.
    this.celestial.rotation.set(0, 0, angle * Math.PI * 2);
    const sunDir = new THREE.Vector3(-Math.sin(angle * Math.PI * 2), Math.cos(angle * Math.PI * 2), 0);

    const zenith = NIGHT_ZENITH.clone().lerp(DAY_ZENITH, d);
    const horizon = NIGHT_HORIZON.clone().lerp(DAY_HORIZON, d);
    // Sunrise/sunset glow when the sun is near the horizon.
    const c = Math.cos(angle * Math.PI * 2);
    const glow = c > -0.4 && c < 0.4 ? Math.pow(1 - Math.abs(c) / 0.4, 1.5) : 0;
    this.domeMat.uniforms.uZenith.value.copy(zenith);
    this.domeMat.uniforms.uHorizon.value.copy(horizon);
    this.domeMat.uniforms.uVoid.value.copy(horizon).multiplyScalar(0.55);
    this.domeMat.uniforms.uSunDir.value.copy(sunDir);
    this.domeMat.uniforms.uGlow.value.copy(SUNSET);
    this.domeMat.uniforms.uGlowAmt.value = glow;

    (this.stars.material as THREE.PointsMaterial).opacity = Math.max(0, 1 - d * 1.6) * 0.85;

    // Fog colour: the horizon, warmed toward the sun at sunrise/sunset.
    this.fogColor.copy(horizon).lerp(SUNSET, glow * 0.25);
    const rd = renderDistance * 16;
    U.uFogColor.value.copy(underwater ? WATER_FOG.clone().multiplyScalar(0.3 + d * 0.7) : this.fogColor);
    U.uFogNear.value = underwater ? 0 : Math.max(24, rd * 0.62);
    U.uFogFar.value = underwater ? 18 : rd;
    // Lightmap: sky light dims to ~0.2 at night and takes a cool tint.
    U.uSky.value = 0.2 + 0.8 * d;
    U.uSkyTint.value.setRGB(0.72 + 0.28 * d, 0.76 + 0.24 * d, 0.95 + 0.05 * d);
    U.uGamma.value = gamma;

    // Clouds drift east at 0.03 blocks per tick, tiled so they always cover the view.
    const drift = (time * 0.03) % CLOUD_SPAN;
    const baseX = Math.floor((cam.x - drift) / CLOUD_SPAN) * CLOUD_SPAN + drift;
    const baseZ = Math.floor(cam.z / CLOUD_SPAN) * CLOUD_SPAN;
    const kids = this.clouds.children;
    let k = 0;
    for (let ix = -1; ix <= 0; ix++)
      for (let iz = -1; iz <= 0; iz++) {
        const ox = cam.x - baseX > CLOUD_SPAN / 2 ? 1 : 0;
        const oz = cam.z - baseZ > CLOUD_SPAN / 2 ? 1 : 0;
        kids[k++].position.set(baseX + (ix + ox) * CLOUD_SPAN, CLOUD_Y, baseZ + (iz + oz) * CLOUD_SPAN);
      }
    const cb = 0.15 + 0.85 * d;
    this.cloudMat.uniforms.uCloudColor.value.setRGB(cb, cb, cb * 1.02 > 1 ? 1 : cb * 1.02).lerp(SUNSET, glow * 0.25);
    this.cloudMat.uniforms.uCloudFar.value = Math.max(220, rd * 2.2);
  }
}

function buildClouds(): THREE.BufferGeometry {
  // Tileable value noise -> cloud cells.
  const rand = mulberry32(4242);
  const G = 16;
  const grid = new Float32Array(G * G);
  for (let i = 0; i < grid.length; i++) grid[i] = rand();
  const sample = (x: number, y: number) => {
    const fx = (x / CLOUD_GRID) * G;
    const fy = (y / CLOUD_GRID) * G;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = fx - x0;
    const ty = fy - y0;
    const at = (a: number, b: number) => grid[(((b % G) + G) % G) * G + (((a % G) + G) % G)];
    const sx = tx * tx * (3 - 2 * tx);
    const sy = ty * ty * (3 - 2 * ty);
    const a = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * sx;
    const b = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * sx;
    return a + (b - a) * sy;
  };
  const cell = new Uint8Array(CLOUD_GRID * CLOUD_GRID);
  for (let y = 0; y < CLOUD_GRID; y++)
    for (let x = 0; x < CLOUD_GRID; x++) {
      const v = sample(x, y) * 0.75 + rand() * 0.25;
      cell[y * CLOUD_GRID + x] = v > 0.62 ? 1 : 0;
    }
  const filled = (x: number, y: number) => cell[(((y % CLOUD_GRID) + CLOUD_GRID) % CLOUD_GRID) * CLOUD_GRID + (((x % CLOUD_GRID) + CLOUD_GRID) % CLOUD_GRID)] === 1;
  const pos: number[] = [];
  const shade: number[] = [];
  const idx: number[] = [];
  const H = 4;
  const quad = (p: number[][], s: number) => {
    const b = pos.length / 3;
    for (const v of p) {
      pos.push(v[0], v[1], v[2]);
      shade.push(s);
    }
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  };
  for (let y = 0; y < CLOUD_GRID; y++)
    for (let x = 0; x < CLOUD_GRID; x++) {
      if (!filled(x, y)) continue;
      const x0 = x * CLOUD_CELL;
      const x1 = x0 + CLOUD_CELL;
      const z0 = y * CLOUD_CELL;
      const z1 = z0 + CLOUD_CELL;
      quad([[x0, H, z1], [x1, H, z1], [x1, H, z0], [x0, H, z0]], 1.0);
      quad([[x0, 0, z0], [x1, 0, z0], [x1, 0, z1], [x0, 0, z1]], 0.7);
      if (!filled(x + 1, y)) quad([[x1, 0, z1], [x1, 0, z0], [x1, H, z0], [x1, H, z1]], 0.85);
      if (!filled(x - 1, y)) quad([[x0, 0, z0], [x0, 0, z1], [x0, H, z1], [x0, H, z0]], 0.85);
      if (!filled(x, y + 1)) quad([[x0, 0, z1], [x1, 0, z1], [x1, H, z1], [x0, H, z1]], 0.9);
      if (!filled(x, y - 1)) quad([[x1, 0, z0], [x0, 0, z0], [x0, H, z0], [x1, H, z0]], 0.9);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("shade", new THREE.Float32BufferAttribute(shade, 1));
  g.setIndex(idx);
  return g;
}

export const WORLD_CENTER = WORLD_SIZE / 2;
