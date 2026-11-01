// Player movement, ported from Java Edition's EntityLivingBase.moveEntityWithHeading / Entity.moveEntity.
//
// Units are blocks and ticks (20 per second). Velocities are blocks per tick. Collision is resolved one axis
// at a time (Y first, then the larger of X/Z last, as in 1.14+). There is no step-up onto full blocks.
// Shared by the client (prediction) and the tests; the server uses the helpers for sanity checks.

import { B, CLIMB, IS_WATER, SHAPE, SOLID } from "./blocks.ts";
import { pushCollision, type Nb } from "./shapes.ts";
import { CROUCH_HEIGHT, PLAYER_HEIGHT, PLAYER_WIDTH, WORLD_HEIGHT, WORLD_SIZE } from "./constants.ts";
import { flowAt, surfaceHeight } from "./water.ts";

export type GetBlock = (x: number, y: number, z: number) => number;

export interface PhysState {
  x: number; // feet centre
  y: number;
  z: number;
  vx: number; // blocks per tick
  vy: number;
  vz: number;
  onGround: boolean;
  inWater: boolean;
  collidedH: boolean;
  sneaking: boolean; // sneak held: slow, careful at edges, no footsteps
  crouched: boolean; // the crouching pose (1.5 tall): while sneaking, and whenever there is no room to stand
  sprinting: boolean;
  jumpTicks: number;
  walkDist: number; // horizontal distance * 0.6, drives bobbing and limb swing
  stepDist: number; // 3D distance * 0.6, drives footstep sounds
  nextStep: number;
  fallDist: number;
}

export interface MoveInput {
  forward: number; // -1..1 (W = +1)
  strafe: number; // -1..1 (A = +1, as in Java)
  jump: boolean;
  sneak: boolean;
  sprint: boolean; // sprint requested (double-tap W or the sprint key)
  yaw: number; // degrees, Java convention: 0 = +Z (south), 90 = -X (west)
}

export interface TickResult {
  step: boolean; // a footstep sound should play
  stepBlock: number; // block under the feet when stepping
  landed: boolean; // hit the ground this tick
  fell: number; // fall distance when landing
}

export const GRAVITY = 0.08;
export const DRAG_Y = 0.98;
export const JUMP_VELOCITY = 0.42;
export const WALK_SPEED = 0.1; // movement speed attribute
export const SPRINT_MULT = 1.3;
export const SNEAK_MULT = 0.3;
export const AIR_ACCEL = 0.02;
export const SPRINT_AIR_ACCEL = 0.026;
export const SLIPPERINESS = 0.6;
export const AIR_FRICTION = 0.91;
export const SPRINT_JUMP_BOOST = 0.2;
export const STEP_HEIGHT = 0.6; // Java's maxUpStep: slabs and stairs, never full blocks
const HALF_W = PLAYER_WIDTH / 2;
const EPS = 1e-7;

/** The player's box height in its current pose. */
export function playerHeight(s: { crouched: boolean }): number {
  return s.crouched ? CROUCH_HEIGHT : PLAYER_HEIGHT;
}

export function newPhysState(x: number, y: number, z: number): PhysState {
  return {
    x, y, z, vx: 0, vy: 0, vz: 0,
    onGround: false, inWater: false, collidedH: false, sneaking: false, crouched: false, sprinting: false,
    jumpTicks: 0, walkDist: 0, stepDist: 0, nextStep: 1, fallDist: 0,
  };
}

/** Has a collision shape here? Outside the world border on x/z, and below y = 0, everything is solid. */
export function solidAt(get: GetBlock, x: number, y: number, z: number): boolean {
  if (x < 0 || z < 0 || x >= WORLD_SIZE || z >= WORLD_SIZE || y < 0) return true;
  if (y >= WORLD_HEIGHT) return false;
  return SOLID[get(x, y, z)] === 1;
}

// Neighbour lookup for shapes that connect (fences, panes); reuses one closure.
let nbGet: GetBlock = () => 0;
let nbX = 0;
let nbY = 0;
let nbZ = 0;
const nbFn: Nb = (dx, dy, dz) => {
  const x = nbX + dx;
  const y = nbY + dy;
  const z = nbZ + dz;
  if (x < 0 || z < 0 || x >= WORLD_SIZE || z >= WORLD_SIZE || y < 0 || y >= WORLD_HEIGHT) return B.AIR;
  return nbGet(x, y, z);
};

const boxes: number[] = []; // flat: x0, y0, z0, x1, y1, z1 per box

/** Collision boxes of every cell touching the region. One extra layer below: fences are 1.5 blocks tall. */
function collectBoxes(get: GetBlock, minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number, out: number[]): number {
  out.length = 0;
  const x0 = Math.floor(minX);
  const x1 = Math.floor(maxX);
  const y0 = Math.floor(minY) - 1;
  const y1 = Math.floor(maxY);
  const z0 = Math.floor(minZ);
  const z1 = Math.floor(maxZ);
  nbGet = get;
  for (let bx = x0; bx <= x1; bx++) {
    for (let bz = z0; bz <= z1; bz++) {
      for (let by = y0; by <= y1; by++) {
        if (bx < 0 || bz < 0 || bx >= WORLD_SIZE || bz >= WORLD_SIZE || by < 0) {
          if (by >= y0 + 1 || by < 0) out.push(bx, by, bz, bx + 1, by + 1, bz + 1);
          continue;
        }
        if (by >= WORLD_HEIGHT) continue;
        const id = get(bx, by, bz);
        const kind = SHAPE[id];
        if (kind === 0) continue;
        if (kind === 1) {
          if (by >= y0 + 1) out.push(bx, by, bz, bx + 1, by + 1, bz + 1);
          continue;
        }
        nbX = bx;
        nbY = by;
        nbZ = bz;
        pushCollision(id, bx, by, bz, nbFn, out);
      }
    }
  }
  return out.length / 6;
}

const probe: number[] = [];

/** True when the box overlaps any collision shape (touching faces do not count). */
export function boxHitsSolid(get: GetBlock, minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): boolean {
  const n = collectBoxes(get, minX + EPS, minY + EPS, minZ + EPS, maxX - EPS, maxY - EPS, maxZ - EPS, probe);
  for (let i = 0; i < n; i++) {
    const o = i * 6;
    if (probe[o + 3] > minX + EPS && probe[o] < maxX - EPS && probe[o + 4] > minY + EPS && probe[o + 1] < maxY - EPS && probe[o + 5] > minZ + EPS && probe[o + 2] < maxZ - EPS) return true;
  }
  return false;
}

// ---- per-axis clipping against the gathered boxes (Java's VoxelShape collide, with its 1e-7 tolerance)

function clipY(n: number, b: number[], minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number, dy: number): number {
  if (dy === 0) return 0;
  for (let i = 0; i < n; i++) {
    const o = i * 6;
    if (b[o + 3] > minX && b[o] < maxX && b[o + 5] > minZ && b[o + 2] < maxZ) {
      if (dy > 0 && maxY <= b[o + 1] + EPS) {
        const d = b[o + 1] - maxY;
        if (d < dy) dy = d;
      } else if (dy < 0 && minY >= b[o + 4] - EPS) {
        const d = b[o + 4] - minY;
        if (d > dy) dy = d;
      }
    }
  }
  return Math.abs(dy) < EPS ? 0 : dy;
}

function clipX(n: number, b: number[], minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number, dx: number): number {
  if (dx === 0) return 0;
  for (let i = 0; i < n; i++) {
    const o = i * 6;
    if (b[o + 4] > minY && b[o + 1] < maxY && b[o + 5] > minZ && b[o + 2] < maxZ) {
      if (dx > 0 && maxX <= b[o] + EPS) {
        const d = b[o] - maxX;
        if (d < dx) dx = d;
      } else if (dx < 0 && minX >= b[o + 3] - EPS) {
        const d = b[o + 3] - minX;
        if (d > dx) dx = d;
      }
    }
  }
  return Math.abs(dx) < EPS ? 0 : dx;
}

function clipZ(n: number, b: number[], minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number, dz: number): number {
  if (dz === 0) return 0;
  for (let i = 0; i < n; i++) {
    const o = i * 6;
    if (b[o + 3] > minX && b[o] < maxX && b[o + 4] > minY && b[o + 1] < maxY) {
      if (dz > 0 && maxZ <= b[o + 2] + EPS) {
        const d = b[o + 2] - maxZ;
        if (d < dz) dz = d;
      } else if (dz < 0 && minZ >= b[o + 5] - EPS) {
        const d = b[o + 5] - minZ;
        if (d > dz) dz = d;
      }
    }
  }
  return Math.abs(dz) < EPS ? 0 : dz;
}

const res: [number, number, number] = [0, 0, 0];

/** Collide a movement against the gathered boxes: Y first, then the smaller of X/Z, then the larger. */
function collideBox(n: number, minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number, dx: number, dy: number, dz: number): [number, number, number] {
  dy = clipY(n, boxes, minX, minY, minZ, maxX, maxY, maxZ, dy);
  minY += dy;
  maxY += dy;
  if (Math.abs(dx) < Math.abs(dz)) {
    dz = clipZ(n, boxes, minX, minY, minZ, maxX, maxY, maxZ, dz);
    minZ += dz;
    maxZ += dz;
    dx = clipX(n, boxes, minX, minY, minZ, maxX, maxY, maxZ, dx);
  } else {
    dx = clipX(n, boxes, minX, minY, minZ, maxX, maxY, maxZ, dx);
    minX += dx;
    maxX += dx;
    dz = clipZ(n, boxes, minX, minY, minZ, maxX, maxY, maxZ, dz);
  }
  res[0] = dx;
  res[1] = dy;
  res[2] = dz;
  return res;
}

function anyWater(get: GetBlock, minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): boolean {
  const x0 = Math.floor(minX);
  const x1 = Math.floor(maxX);
  const y0 = Math.max(0, Math.floor(minY));
  const y1 = Math.min(WORLD_HEIGHT - 1, Math.floor(maxY));
  const z0 = Math.floor(minZ);
  const z1 = Math.floor(maxZ);
  for (let bx = x0; bx <= x1; bx++)
    for (let bz = z0; bz <= z1; bz++)
      for (let by = y0; by <= y1; by++) {
        if (bx < 0 || bz < 0 || bx >= WORLD_SIZE || bz >= WORLD_SIZE) continue;
        if (IS_WATER[get(bx, by, bz)]) return true;
      }
  return false;
}

/** Water surface height inside a water block: full under water, 8/9 for a source, lower for thinner flowing water. */
export function waterSurface(get: GetBlock, bx: number, by: number, bz: number): number {
  const above = by + 1 < WORLD_HEIGHT ? get(bx, by + 1, bz) : B.AIR;
  if (IS_WATER[above]) return by + 1;
  const id = get(bx, by, bz);
  return by + (id === B.WATER ? 8 / 9 : surfaceHeight(id, above));
}

/** Java's handleWaterMovement: the box shrunk by 0.4 vertically and 0.001 sideways touches water. */
export function isInWater(get: GetBlock, x: number, y: number, z: number): boolean {
  const minX = x - HALF_W + 0.001;
  const maxX = x + HALF_W - 0.001;
  const minZ = z - HALF_W + 0.001;
  const maxZ = z + HALF_W - 0.001;
  const minY = y + 0.4 + 0.001;
  const maxY = y + PLAYER_HEIGHT - 0.4 - 0.001;
  const x0 = Math.floor(minX);
  const x1 = Math.floor(maxX);
  const z0 = Math.floor(minZ);
  const z1 = Math.floor(maxZ);
  const y0 = Math.max(0, Math.floor(minY));
  const y1 = Math.min(WORLD_HEIGHT - 1, Math.floor(maxY));
  for (let bx = x0; bx <= x1; bx++)
    for (let bz = z0; bz <= z1; bz++)
      for (let by = y0; by <= y1; by++) {
        if (bx < 0 || bz < 0 || bx >= WORLD_SIZE || bz >= WORLD_SIZE) continue;
        if (IS_WATER[get(bx, by, bz)] && minY < waterSurface(get, bx, by, bz)) return true;
      }
  return false;
}

/** Is the eye position under the water surface? Used for underwater fog. */
export function eyeInWater(get: GetBlock, x: number, eyeY: number, z: number): boolean {
  const bx = Math.floor(x);
  const by = Math.floor(eyeY);
  const bz = Math.floor(z);
  if (bx < 0 || bz < 0 || bx >= WORLD_SIZE || bz >= WORLD_SIZE || by < 0 || by >= WORLD_HEIGHT) return false;
  return IS_WATER[get(bx, by, bz)] === 1 && eyeY < waterSurface(get, bx, by, bz);
}

/** Java's moveFlying: adds input acceleration in the facing direction. */
function moveRelative(s: PhysState, strafe: number, forward: number, friction: number, yaw: number): void {
  let f = strafe * strafe + forward * forward;
  if (f >= 1.0e-4) {
    f = Math.sqrt(f);
    if (f < 1) f = 1;
    f = friction / f;
    strafe *= f;
    forward *= f;
    const rad = (yaw * Math.PI) / 180;
    const sin = Math.sin(rad);
    const cos = Math.cos(rad);
    s.vx += strafe * cos - forward * sin;
    s.vz += forward * cos + strafe * sin;
  }
}

/** Java's moveEntity with sneak edge-guarding and per-axis collision. Returns the actual displacement. */
function move(s: PhysState, get: GetBlock, dx: number, dy: number, dz: number): void {
  const ox = dx;
  const oy = dy;
  const oz = dz;
  let minX = s.x - HALF_W;
  let maxX = s.x + HALF_W;
  let minY = s.y;
  let maxY = s.y + playerHeight(s);
  let minZ = s.z - HALF_W;
  let maxZ = s.z + HALF_W;

  // Sneaking on the ground: back off any motion that would leave no ground under the box.
  if (s.onGround && s.sneaking) {
    const step = 0.05;
    const down = 1.0;
    while (dx !== 0 && !boxHitsSolid(get, minX + dx, minY - down, minZ, maxX + dx, maxY - down, maxZ)) {
      if (dx < step && dx >= -step) dx = 0;
      else if (dx > 0) dx -= step;
      else dx += step;
    }
    while (dz !== 0 && !boxHitsSolid(get, minX, minY - down, minZ + dz, maxX, maxY - down, maxZ + dz)) {
      if (dz < step && dz >= -step) dz = 0;
      else if (dz > 0) dz -= step;
      else dz += step;
    }
    while (dx !== 0 && dz !== 0 && !boxHitsSolid(get, minX + dx, minY - down, minZ + dz, maxX + dx, maxY - down, maxZ + dz)) {
      if (dx < step && dx >= -step) dx = 0;
      else if (dx > 0) dx -= step;
      else dx += step;
      if (dz < step && dz >= -step) dz = 0;
      else if (dz > 0) dz -= step;
      else dz += step;
    }
  }
  const sx = dx;
  const sz = dz;
  void ox;
  void oz;

  // Gather once for everything this tick may touch, including a step up.
  const n = collectBoxes(
    get,
    Math.min(minX, minX + dx) - EPS, Math.min(minY, minY + dy) - EPS, Math.min(minZ, minZ + dz) - EPS,
    Math.max(maxX, maxX + dx) + EPS, Math.max(maxY, maxY + dy, maxY + STEP_HEIGHT) + EPS, Math.max(maxZ, maxZ + dz) + EPS,
    boxes,
  );
  let [rx, ry, rz] = collideBox(n, minX, minY, minZ, maxX, maxY, maxZ, dx, dy, dz);

  // Step up onto anything up to 0.6 tall (slabs, stairs) like Java 1.14+; full blocks still need a jump.
  const hitXZ = Math.abs(rx - dx) > 1e-7 || Math.abs(rz - dz) > 1e-7;
  const landed = Math.abs(ry - dy) > 1e-7 && dy < 0;
  if (hitXZ && (s.onGround || landed)) {
    const up = collideBox(n, minX, minY, minZ, maxX, maxY, maxZ, dx, STEP_HEIGHT, dz).slice() as [number, number, number];
    const stepOnly = clipY(n, boxes, Math.min(minX, minX + dx), minY, Math.min(minZ, minZ + dz), Math.max(maxX, maxX + dx), maxY, Math.max(maxZ, maxZ + dz), STEP_HEIGHT);
    if (stepOnly < STEP_HEIGHT) {
      const v = collideBox(n, minX, minY + stepOnly, minZ, maxX, maxY + stepOnly, maxZ, dx, 0, dz);
      if (v[0] * v[0] + v[2] * v[2] > up[0] * up[0] + up[2] * up[2]) {
        up[0] = v[0];
        up[1] = stepOnly;
        up[2] = v[2];
      }
    }
    if (up[0] * up[0] + up[2] * up[2] > rx * rx + rz * rz) {
      const down = clipY(n, boxes, minX + up[0], minY + up[1], minZ + up[2], maxX + up[0], maxY + up[1], maxZ + up[2], -up[1] + dy);
      rx = up[0];
      ry = up[1] + down;
      rz = up[2];
    }
  }
  dx = rx;
  dy = ry;
  dz = rz;
  minX += dx;
  maxX += dx;
  minY += dy;
  maxY += dy;
  minZ += dz;
  maxZ += dz;

  const px = s.x;
  const py = s.y;
  const pz = s.z;
  s.x = (minX + maxX) / 2;
  s.y = minY;
  s.z = (minZ + maxZ) / 2;

  // Compared with a tolerance, as in 1.14+ (Mth.equal), so float noise is never a collision.
  const hitX = Math.abs(sx - dx) > 1e-7;
  const hitZ = Math.abs(sz - dz) > 1e-7;
  s.collidedH = hitX || hitZ;
  const collidedV = Math.abs(oy - dy) > 1e-7;
  s.onGround = collidedV && oy < 0;
  // Like Java, the sneak guard's trimming does not count as a collision and keeps the velocity.
  if (hitX) s.vx = 0;
  if (hitZ) s.vz = 0;
  if (collidedV) s.vy = 0;

  // Java zeroes the vertical part unless on a ladder, so both distances are horizontal.
  const mx = s.x - px;
  const mz = s.z - pz;
  void py;
  const horiz = Math.sqrt(mx * mx + mz * mz) * 0.6;
  s.walkDist += horiz;
  s.stepDist += horiz;
}

/** One 50 ms tick of player movement. Mutates `s`. */
export function tickPlayer(s: PhysState, input: MoveInput, get: GetBlock): TickResult {
  const result: TickResult = { step: false, stepBlock: 0, landed: false, fell: 0 };
  const wasOnGround = s.onGround;

  // Pose (Java 1.14+): crouching while sneak is held, and also whenever standing up would hit something
  // (crawl out from under a 1.5-high gap and you stay crouched until there is room).
  s.sneaking = input.sneak;
  s.crouched = s.sneaking || boxHitsSolid(get, s.x - HALF_W, s.y, s.z - HALF_W, s.x + HALF_W, s.y + PLAYER_HEIGHT, s.z + HALF_W);
  // Sprint state (EntityPlayerSP.onLivingUpdate). Crouched means slow (isMovingSlowly).
  let forward = input.forward;
  let strafe = input.strafe;
  if (s.crouched) {
    forward *= SNEAK_MULT;
    strafe *= SNEAK_MULT;
  }
  if (!s.sprinting && input.sprint && forward >= 0.8 && !s.crouched && !s.collidedH) s.sprinting = true;
  if (s.sprinting && (forward < 0.8 || s.collidedH || s.crouched)) s.sprinting = false;

  forward *= 0.98;
  strafe *= 0.98;

  // Tiny velocities snap to zero (LivingEntity.aiStep; 0.003 since 1.9, which gives the 1.2522 jump).
  if (Math.abs(s.vx) < 0.003) s.vx = 0;
  if (Math.abs(s.vy) < 0.003) s.vy = 0;
  if (Math.abs(s.vz) < 0.003) s.vz = 0;

  s.inWater = isInWater(get, s.x, s.y, s.z);

  // Jumping.
  if (s.jumpTicks > 0) s.jumpTicks--;
  if (input.jump) {
    if (s.inWater) {
      s.vy += 0.04;
    } else if (s.onGround && s.jumpTicks === 0) {
      s.vy = JUMP_VELOCITY;
      if (s.sprinting) {
        const rad = (input.yaw * Math.PI) / 180;
        s.vx -= Math.sin(rad) * SPRINT_JUMP_BOOST;
        s.vz += Math.cos(rad) * SPRINT_JUMP_BOOST;
      }
      s.jumpTicks = 10;
    }
  } else {
    s.jumpTicks = 0;
  }

  const yBefore = s.y;
  if (s.inWater) {
    // Running water pushes you along, like the classic current.
    const [fx, fz] = flowAt(safeGetter(get), s.x, s.y + 0.4, s.z);
    s.vx += fx;
    s.vz += fz;
    moveRelative(s, strafe, forward, 0.02, input.yaw);
    move(s, get, s.vx, s.vy, s.vz);
    s.vx *= 0.8;
    s.vy *= 0.8;
    s.vz *= 0.8;
    s.vy -= 0.02;
    if (s.collidedH && offsetIsFree(get, s, s.vx, s.vy + 0.6 - s.y + yBefore, s.vz)) s.vy = 0.3;
  } else {
    let friction = AIR_FRICTION;
    if (wasOnGround) friction = slipperinessBelow(get, s) * AIR_FRICTION;
    const accelFactor = 0.16277136 / (friction * friction * friction);
    const speed = wasOnGround
      ? WALK_SPEED * (s.sprinting ? SPRINT_MULT : 1) * accelFactor
      : s.sprinting ? SPRINT_AIR_ACCEL : AIR_ACCEL;
    moveRelative(s, strafe, forward, speed, input.yaw);
    const climbing = onLadder(get, s);
    if (climbing) {
      // Java: limit sideways speed and the slide down; sneaking holds you in place.
      s.vx = Math.max(-0.15, Math.min(0.15, s.vx));
      s.vz = Math.max(-0.15, Math.min(0.15, s.vz));
      s.fallDist = 0;
      if (s.vy < -0.15) s.vy = -0.15;
      if (s.sneaking && s.vy < 0) s.vy = 0;
    }
    move(s, get, s.vx, s.vy, s.vz);
    if (climbing && (s.collidedH || input.jump)) s.vy = 0.2;
    s.vy -= GRAVITY;
    s.vy *= DRAG_Y;
    s.vx *= friction;
    s.vz *= friction;
  }

  // Fall tracking.
  if (s.onGround) {
    if (!wasOnGround) {
      result.landed = true;
      result.fell = s.fallDist;
    }
    s.fallDist = 0;
  } else if (s.y < yBefore && !s.inWater) {
    s.fallDist += yBefore - s.y;
  } else if (s.inWater) {
    s.fallDist = 0;
  }

  // Footsteps: every 1/0.6 blocks walked on the ground, never while sneaking.
  if (s.onGround && !s.sneaking && s.stepDist > s.nextStep) {
    const below = blockBelow(get, s);
    if (below !== B.AIR && !IS_WATER[below]) {
      s.nextStep = Math.floor(s.stepDist) + 1;
      result.step = true;
      result.stepBlock = below;
    }
  }
  return result;
}

/** Outside the world reads as stone (for neighbour lookups at the border). */
function safeGetter(get: GetBlock): GetBlock {
  return (x, y, z) => (x < 0 || z < 0 || x >= WORLD_SIZE || z >= WORLD_SIZE || y < 0 || y >= WORLD_HEIGHT ? B.STONE : get(x, y, z));
}

function offsetIsFree(get: GetBlock, s: PhysState, dx: number, dy: number, dz: number): boolean {
  const minX = s.x - HALF_W + dx;
  const maxX = s.x + HALF_W + dx;
  const minY = s.y + dy;
  const maxY = s.y + playerHeight(s) + dy;
  const minZ = s.z - HALF_W + dz;
  const maxZ = s.z + HALF_W + dz;
  return !boxHitsSolid(get, minX, minY, minZ, maxX, maxY, maxZ) && !anyWater(get, minX, minY, minZ, maxX, maxY, maxZ);
}

function slipperinessBelow(_get: GetBlock, _s: PhysState): number {
  return SLIPPERINESS; // no ice yet; every block uses the default 0.6
}

/** Is the player in a ladder cell (feet or head)? */
export function onLadder(get: GetBlock, s: PhysState): boolean {
  const bx = Math.floor(s.x);
  const bz = Math.floor(s.z);
  if (bx < 0 || bz < 0 || bx >= WORLD_SIZE || bz >= WORLD_SIZE) return false;
  for (const y of [Math.floor(s.y), Math.floor(s.y + 1)]) {
    if (y >= 0 && y < WORLD_HEIGHT && CLIMB[get(bx, y, bz)]) return true;
  }
  return false;
}

/** The block the player stands on (Java looks 0.2 below the feet). */
export function blockBelow(get: GetBlock, s: PhysState): number {
  const bx = Math.floor(s.x);
  const by = Math.floor(s.y - 0.2);
  const bz = Math.floor(s.z);
  if (bx < 0 || bz < 0 || bx >= WORLD_SIZE || bz >= WORLD_SIZE || by < 0 || by >= WORLD_HEIGHT) return B.AIR;
  return get(bx, by, bz);
}

/** Does a block cell overlap the player's box? (Placement never goes inside a player.) */
export function cellIntersectsPlayer(bx: number, by: number, bz: number, px: number, py: number, pz: number, shrink = 0, height = PLAYER_HEIGHT): boolean {
  return (
    bx + 1 > px - HALF_W + shrink &&
    bx < px + HALF_W - shrink &&
    by + 1 > py + shrink &&
    by < py + height - shrink &&
    bz + 1 > pz - HALF_W + shrink &&
    bz < pz + HALF_W - shrink
  );
}

/** Does a block's actual shape at (bx,by,bz) overlap a player's box? (Placement never goes inside a player.) */
export function shapeIntersectsPlayer(id: number, bx: number, by: number, bz: number, px: number, py: number, pz: number, get: GetBlock, shrink = 0, height = PLAYER_HEIGHT): boolean {
  if (SHAPE[id] === 0) return false;
  if (SHAPE[id] === 1) return cellIntersectsPlayer(bx, by, bz, px, py, pz, shrink, height);
  const out: number[] = [];
  nbGet = get;
  nbX = bx;
  nbY = by;
  nbZ = bz;
  pushCollision(id, bx, by, bz, nbFn, out);
  for (let o = 0; o < out.length; o += 6) {
    if (out[o + 3] > px - HALF_W + shrink && out[o] < px + HALF_W - shrink && out[o + 4] > py + shrink && out[o + 1] < py + height - shrink && out[o + 5] > pz - HALF_W + shrink && out[o + 2] < pz + HALF_W - shrink) return true;
  }
  return false;
}

/** Does the player's box overlap solid blocks? Used by the server to reject positions inside walls. */
export function playerInsideSolid(get: GetBlock, x: number, y: number, z: number, shrink = 0.1, height = PLAYER_HEIGHT): boolean {
  return boxHitsSolid(get, x - HALF_W + shrink, y + shrink, z - HALF_W + shrink, x + HALF_W - shrink, y + height - shrink, z + HALF_W - shrink);
}

// ------------------------------------------------------------------ other bodies (animals)

/** Any axis-aligned body: feet centre, half width, height, velocity in blocks per tick. */
export interface Body {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  hw: number;
  h: number;
  onGround: boolean;
  collidedH: boolean;
}

/** Move a body by (dx, dy, dz) with the same per-axis collision and 0.6 step-up as players. Sets onGround /
 *  collidedH and zeroes the velocity on the axes that hit something. */
export function moveBody(get: GetBlock, b: Body, dx: number, dy: number, dz: number, stepUp = STEP_HEIGHT): void {
  let minX = b.x - b.hw;
  let maxX = b.x + b.hw;
  let minY = b.y;
  let maxY = b.y + b.h;
  let minZ = b.z - b.hw;
  let maxZ = b.z + b.hw;
  const n = collectBoxes(
    get,
    Math.min(minX, minX + dx) - EPS, Math.min(minY, minY + dy) - EPS, Math.min(minZ, minZ + dz) - EPS,
    Math.max(maxX, maxX + dx) + EPS, Math.max(maxY, maxY + dy, maxY + stepUp) + EPS, Math.max(maxZ, maxZ + dz) + EPS,
    boxes,
  );
  let [rx, ry, rz] = collideBox(n, minX, minY, minZ, maxX, maxY, maxZ, dx, dy, dz);
  const hitXZ = Math.abs(rx - dx) > 1e-7 || Math.abs(rz - dz) > 1e-7;
  if (stepUp > 0 && hitXZ && (b.onGround || (Math.abs(ry - dy) > 1e-7 && dy < 0))) {
    const up = collideBox(n, minX, minY, minZ, maxX, maxY, maxZ, dx, stepUp, dz).slice() as [number, number, number];
    if (up[0] * up[0] + up[2] * up[2] > rx * rx + rz * rz) {
      const down = clipY(n, boxes, minX + up[0], minY + up[1], minZ + up[2], maxX + up[0], maxY + up[1], maxZ + up[2], -up[1] + dy);
      rx = up[0];
      ry = up[1] + down;
      rz = up[2];
    }
  }
  minX += rx;
  maxX += rx;
  minY += ry;
  minZ += rz;
  maxZ += rz;
  b.x = (minX + maxX) / 2;
  b.y = minY;
  b.z = (minZ + maxZ) / 2;
  const hitX = Math.abs(dx - rx) > 1e-7;
  const hitZ = Math.abs(dz - rz) > 1e-7;
  const hitY = Math.abs(dy - ry) > 1e-7;
  b.collidedH = hitX || hitZ;
  b.onGround = hitY && dy < 0;
  if (hitX) b.vx = 0;
  if (hitZ) b.vz = 0;
  if (hitY) b.vy = 0;
}

/** Is any water inside the box (feet to mid-height)? */
export function bodyInWater(get: GetBlock, b: Body): boolean {
  return anyWater(get, b.x - b.hw + 0.001, b.y + 0.1, b.z - b.hw + 0.001, b.x + b.hw - 0.001, b.y + b.h * 0.5, b.z + b.hw - 0.001);
}

/** Does the body overlap a collision shape? */
export function bodyInsideSolid(get: GetBlock, b: Body, shrink = 0.05): boolean {
  return boxHitsSolid(get, b.x - b.hw + shrink, b.y + shrink, b.z - b.hw + shrink, b.x + b.hw - shrink, b.y + b.h - shrink, b.z + b.hw - shrink);
}
