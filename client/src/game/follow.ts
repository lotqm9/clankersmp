// clankersmp: a spectator's camera, locked to the eyes of the AI it watches. The server sends the AI's body with the
// tick it saw it in, every tick it moved. Those samples are played back about 100 ms late on a clock that runs with
// the frames and is only nudged toward the stream (it jumps only after a hidden tab or a stall), then eased a little:
// the AI steps on its own timer, so one server tick can hold two of its steps and the next none.

import { TICK_MS } from "../../../shared/constants.ts";
import type { PlayerSnap } from "../../../shared/protocol.ts";
import { wrapDeg } from "../render/players.ts";

const DELAY = 100; // ms behind the newest sample
const EASE_MS = 30; // each of the two easing stages (the position, the yaw and the pitch)
const JUMP = 8; // blocks from one sample to the next: a teleport (respawn, /spawn), not a step

interface Sample {
  tick: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  flags: number;
}

export class FollowCam {
  x = 0;
  y = 0;
  z = 0;
  yaw = 0;
  pitch = 0;
  /** The AI's flags (FLAG.SNEAK, GROUND, EAT, ...) at the moment on screen. */
  flags = 0;
  private samples: Sample[] = [];
  private offset: number | null = null; // client ms minus server tick * TICK_MS, for the quickest packets
  private clock: number | null = null; // the server tick on screen (fractional)
  private mx = 0; // the first easing stage
  private my = 0;
  private mz = 0;
  private myaw = 0;
  private mpitch = 0;
  private cut = false; // the next frame goes straight to the sample (a teleport)

  /** One sample of the AI's body, seen by the server at `tick`, arriving now. */
  push(s: PlayerSnap, tick: number, now: number): void {
    const off = now - tick * TICK_MS;
    if (this.offset === null || off < this.offset) this.offset = off;
    else this.offset += (off - this.offset) * 0.01;
    const q = this.samples;
    const last = q[q.length - 1];
    const next = { tick, x: s.x, y: s.y, z: s.z, yaw: s.yaw, pitch: s.pitch, flags: s.flags };
    if (last && tick <= last.tick) {
      if (tick === last.tick) q[q.length - 1] = next;
      return;
    }
    if (last && Math.hypot(s.x - last.x, s.y - last.y, s.z - last.z) > JUMP) {
      q.length = 0;
      this.cut = true;
    } else if (last && tick - last.tick > 3) q.push({ ...last, tick: tick - 1 }); // it stood still until just now
    q.push(next);
    if (q.length > 60) q.shift();
  }

  /** Be there now (another AI, the first frame): nothing eases across the jump. */
  jump(x: number, y: number, z: number, yaw: number, pitch: number, flags = 0): void {
    this.samples = [{ tick: 0, x, y, z, yaw, pitch, flags }];
    this.x = this.mx = x;
    this.y = this.my = y;
    this.z = this.mz = z;
    this.yaw = this.myaw = yaw;
    this.pitch = this.mpitch = pitch;
    this.flags = flags;
    this.cut = false;
  }

  /** Where the eyes are this frame (dt: ms since the last one). */
  update(now: number, dt: number): void {
    const q = this.samples;
    if (!q.length) return;
    let c = Infinity; // no stream yet: the newest sample
    if (this.offset !== null) {
      const target = (now - DELAY - this.offset) / TICK_MS;
      if (this.clock === null || Math.abs(target - this.clock) > 5) this.clock = target; // a hidden tab, a stall
      else this.clock += dt / TICK_MS + (target - this.clock) * Math.min(1, dt / 1000);
      c = this.clock;
    }
    while (q.length > 2 && q[1].tick <= c) q.shift();
    const a = q[0];
    const b = q.length > 1 && c > a.tick ? q[1] : a;
    const k = b === a ? 0 : Math.min(1, (c - a.tick) / (b.tick - a.tick));
    const tx = a.x + (b.x - a.x) * k;
    const ty = a.y + (b.y - a.y) * k;
    const tz = a.z + (b.z - a.z) * k;
    const tyaw = a.yaw + wrapDeg(b.yaw - a.yaw) * k;
    const tpitch = a.pitch + (b.pitch - a.pitch) * k;
    this.flags = k < 1 ? a.flags : b.flags;
    if (this.cut) {
      this.cut = false;
      this.x = this.mx = tx;
      this.y = this.my = ty;
      this.z = this.mz = tz;
      this.yaw = this.myaw = tyaw;
      this.pitch = this.mpitch = tpitch;
      return;
    }
    // two stages: the speed (and the turn) changes smoothly too, not just the place
    const e = 1 - Math.exp(-dt / EASE_MS);
    this.mx += (tx - this.mx) * e;
    this.my += (ty - this.my) * e;
    this.mz += (tz - this.mz) * e;
    this.myaw = (this.myaw + wrapDeg(tyaw - this.myaw) * e + 360) % 360; // the short way round
    this.mpitch += (tpitch - this.mpitch) * e;
    this.x += (this.mx - this.x) * e;
    this.y += (this.my - this.y) * e;
    this.z += (this.mz - this.z) * e;
    this.yaw = (this.yaw + wrapDeg(this.myaw - this.yaw) * e + 360) % 360;
    this.pitch += (this.mpitch - this.pitch) * e;
  }
}
