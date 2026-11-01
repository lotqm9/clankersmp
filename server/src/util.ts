import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** Token bucket: `burst` tokens, refilled at `perSec`. */
export class Bucket {
  private tokens: number;
  private last: number;
  private burst: number;
  private perSec: number;
  constructor(burst: number, perSec: number) {
    this.burst = burst;
    this.perSec = perSec;
    this.tokens = burst;
    this.last = Date.now();
  }
  take(n = 1): boolean {
    const now = Date.now();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.perSec);
    this.last = now;
    if (this.tokens >= n) {
      this.tokens -= n;
      return true;
    }
    return false;
  }
}

export function sha(s: string, len = 12): string {
  return createHash("sha256").update(s).digest("hex").slice(0, len);
}

export function randomToken(): string {
  return randomBytes(16).toString("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function log(...args: unknown[]): void {
  console.log(new Date().toISOString(), ...args);
}

/** Origins compare case-insensitively and with or without a trailing slash ("https://WWW.x.fun/" = "https://www.x.fun"). */
export const normOrigin = (o: string) => o.trim().toLowerCase().replace(/\/+$/, "");
