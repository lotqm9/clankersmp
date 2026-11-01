// Charity meter: how much SOL the coin's creator rewards have raised for the charity, read straight from
// Solana (no third-party API, no made-up numbers).
//
// How pump.fun charity coins route money (verified 2026-10-14 on two live charity coins):
//   bonding curve PDA ["bonding-curve", mint] (Pump program) -> its `creator` is the coin's fee-sharing config
//   sharing config PDA ["sharing-config", mint] (Pump Fees program) -> shareholders [{address, share_bps}]
//   the charity shareholder is a DonationFeePda (owned by the Pump Fees program) which keeps an on-chain
//   running total `total_donated` of everything it has forwarded to the donation relay (Donate.gg).
//   Fees not yet distributed wait in the creator vaults of the sharing config:
//     Pump:     PDA ["creator-vault", sharingConfig] (native SOL above rent)
//     PumpSwap: WSOL ATA of PDA ["creator_vault", sharingConfig] (PumpSwap program)
//
// raised = total_donated (already forwarded) + what sits in the donation PDA (cranked next)
//        + undistributed vault fees x the charity's share. Every term is an account balance anyone can check.

import { createHash } from "node:crypto";

export const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
export const PUMP_AMM_PROGRAM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
export const PUMP_FEE_PROGRAM = "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const WSOL_MINT = "So11111111111111111111111111111111111111112";

// ------------------------------------------------------------------ base58

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function b58decode(s: string): Uint8Array {
  let n = 0n;
  for (const ch of s) {
    const v = ALPHABET.indexOf(ch);
    if (v < 0) throw new Error("bad base58");
    n = n * 58n + BigInt(v);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.push(Number(n & 255n));
    n >>= 8n;
  }
  for (const ch of s) {
    if (ch !== "1") break;
    bytes.push(0);
  }
  return Uint8Array.from(bytes.reverse());
}

export function b58encode(b: Uint8Array): string {
  let n = 0n;
  for (const x of b) n = (n << 8n) | BigInt(x);
  let out = "";
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const x of b) {
    if (x !== 0) break;
    out = "1" + out;
  }
  return out;
}

// ------------------------------------------------------------------ ed25519 on-curve check (for PDAs)

const P = (1n << 255n) - 19n;
const D = (((-121665n * modpow(121666n, P - 2n)) % P) + P) % P;
const SQRT_M1 = modpow(2n, (P - 1n) / 4n);

function mod(a: bigint): bigint {
  const r = a % P;
  return r < 0n ? r + P : r;
}
function modpow(b: bigint, e: bigint): bigint {
  let r = 1n;
  b = ((b % P) + P) % P;
  while (e > 0n) {
    if (e & 1n) r = (r * b) % P;
    b = (b * b) % P;
    e >>= 1n;
  }
  return r;
}

/** True when the 32 bytes decompress to a point on the ed25519 curve (as curve25519-dalek decides). */
export function isOnCurve(bytes: Uint8Array): boolean {
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(i === 31 ? bytes[i] & 0x7f : bytes[i]);
  y = mod(y);
  const y2 = mod(y * y);
  const u = mod(y2 - 1n);
  const v = mod(D * y2 + 1n);
  // x = (u v^3)(u v^7)^((p-5)/8), then v x^2 must be +u or -u (sqrt_ratio_i).
  const v3 = mod(v * v * v);
  const v7 = mod(v3 * v3 * v);
  let x = mod(u * v3 * modpow(mod(u * v7), (P - 5n) / 8n));
  const vx2 = mod(v * x * x);
  if (vx2 === u) return true;
  if (vx2 === mod(-u)) {
    x = mod(x * SQRT_M1);
    return true;
  }
  return false;
}

/** Solana findProgramAddress. */
export function findPda(seeds: Uint8Array[], programId: string): string {
  const program = b58decode(programId);
  for (let bump = 255; bump >= 0; bump--) {
    const h = createHash("sha256");
    for (const s of seeds) h.update(s);
    h.update(Uint8Array.of(bump));
    h.update(program);
    h.update(Buffer.from("ProgramDerivedAddress"));
    const out = new Uint8Array(h.digest());
    if (!isOnCurve(out)) return b58encode(out);
  }
  throw new Error("no viable bump");
}

const seed = (s: string) => new Uint8Array(Buffer.from(s));

export function ata(owner: string, mint: string, tokenProgram = TOKEN_PROGRAM): string {
  return findPda([b58decode(owner), b58decode(tokenProgram), b58decode(mint)], ATA_PROGRAM);
}

// ------------------------------------------------------------------ RPC

interface RpcAccount {
  owner: string;
  lamports: number;
  data: Buffer;
}

async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error(`rpc ${method} http ${r.status}`);
  const j = (await r.json()) as { result?: T; error?: { message: string } };
  if (j.error) throw new Error(`rpc ${method}: ${j.error.message}`);
  return j.result as T;
}

async function getAccounts(url: string, keys: string[]): Promise<(RpcAccount | null)[]> {
  const res = await rpc<{ value: ({ owner: string; lamports: number; data: [string, string] } | null)[] }>(url, "getMultipleAccounts", [
    keys,
    { encoding: "base64", commitment: "confirmed" },
  ]);
  return res.value.map((a) => (a ? { owner: a.owner, lamports: a.lamports, data: Buffer.from(a.data[0], "base64") } : null));
}

const rentCache = new Map<number, number>();
async function rentExempt(url: string, len: number): Promise<number> {
  const hit = rentCache.get(len);
  if (hit !== undefined) return hit;
  const v = await rpc<number>(url, "getMinimumBalanceForRentExemption", [len]);
  rentCache.set(len, v);
  return v;
}

function readPubkey(b: Buffer, o: number): string {
  return b58encode(new Uint8Array(b.subarray(o, o + 32)));
}

/** SPL token account: amount (u64) at offset 64. */
function tokenAmount(a: RpcAccount | null): bigint {
  if (!a || a.data.length < 72) return 0n;
  return a.data.readBigUInt64LE(64);
}

const DONATION_DISC = createHash("sha256").update("account:DonationFeePda").digest().subarray(0, 8);
const SHARING_DISC = createHash("sha256").update("account:SharingConfig").digest().subarray(0, 8);

export interface CharityReading {
  state: "prelaunch" | "live" | "unavailable";
  totalSol?: number;
  donatedSol?: number;
  pendingSol?: number;
  updatedAt?: number; // ms epoch of the chain read
  note?: string;
}

/** One full read. Throws on RPC failure so the caller can keep the last good value. */
export async function readCharity(mint: string, url: string): Promise<CharityReading> {
  const mintKey = b58decode(mint);
  if (mintKey.length !== 32) return { state: "unavailable", note: "COIN_CA is not a valid address" };
  const curvePda = findPda([seed("bonding-curve"), mintKey], PUMP_PROGRAM);
  const sharingPda = findPda([seed("sharing-config"), mintKey], PUMP_FEE_PROGRAM);
  const [curve, sharing] = await getAccounts(url, [curvePda, sharingPda]);
  if (!curve) return { state: "unavailable", note: "coin not found on chain yet" };
  const creator = readPubkey(curve.data, 49); // 8 discriminator + 5 x u64 + bool
  if (!sharing || creator !== sharingPda || !sharing.data.subarray(0, 8).equals(SHARING_DISC)) {
    return { state: "unavailable", note: "creator rewards are not routed through a fee-sharing config" };
  }
  // SharingConfig: disc(8) bump(1) version(1) status(1) mint(32) admin(32) admin_revoked(1) vec<{pubkey,u16}>
  const d = sharing.data;
  let o = 8 + 1 + 1 + 1;
  if (readPubkey(d, o) !== mint) return { state: "unavailable", note: "sharing config mint mismatch" };
  o += 32 + 32 + 1;
  const n = d.readUInt32LE(o);
  o += 4;
  const holders: { address: string; bps: number }[] = [];
  for (let i = 0; i < n && o + 34 <= d.length; i++, o += 34) holders.push({ address: readPubkey(d, o), bps: d.readUInt16LE(o + 32) });

  const accounts = await getAccounts(url, holders.map((h) => h.address));
  let charityBps = 0;
  let donated = 0n;
  let pending = 0n;
  const pendingKeys: string[] = [];
  for (let i = 0; i < holders.length; i++) {
    const a = accounts[i];
    if (!a || a.owner !== PUMP_FEE_PROGRAM || !a.data.subarray(0, 8).equals(DONATION_DISC)) continue;
    // DonationFeePda: disc(8) bump(1) version(1) config_id(32) base_mint(32) quote_mint(32) creator(32)
    //                 total_donated(u64 @138) last_crank_ts(i64)
    if (readPubkey(a.data, 42) !== mint) continue;
    const quote = readPubkey(a.data, 74);
    if (quote !== WSOL_MINT) continue; // only SOL-quoted donations are summed in SOL
    charityBps += holders[i].bps;
    donated += a.data.readBigUInt64LE(138);
    const rent = await rentExempt(url, a.data.length);
    if (a.lamports > rent) pending += BigInt(a.lamports - rent);
    pendingKeys.push(ata(holders[i].address, WSOL_MINT));
  }
  if (charityBps === 0) return { state: "unavailable", note: "no donation shareholder in the fee-sharing config" };

  // Undistributed fees in both creator vaults of the sharing config.
  const pumpVault = findPda([seed("creator-vault"), b58decode(sharingPda)], PUMP_PROGRAM);
  const ammAuthority = findPda([seed("creator_vault"), b58decode(sharingPda)], PUMP_AMM_PROGRAM);
  const ammVaultAta = ata(ammAuthority, WSOL_MINT);
  const vaults = await getAccounts(url, [pumpVault, ammVaultAta, ...pendingKeys]);
  let undistributed = 0n;
  if (vaults[0]) {
    const rent = await rentExempt(url, vaults[0].data.length);
    if (vaults[0].lamports > rent) undistributed += BigInt(vaults[0].lamports - rent);
  }
  undistributed += tokenAmount(vaults[1]);
  for (let k = 0; k < pendingKeys.length; k++) pending += tokenAmount(vaults[2 + k]);
  pending += (undistributed * BigInt(charityBps)) / 10000n;

  const donatedSol = Number(donated) / 1e9;
  const pendingSol = Number(pending) / 1e9;
  return { state: "live", donatedSol, pendingSol, totalSol: donatedSol + pendingSol, updatedAt: Date.now() };
}

/** Keeps a reading fresh (about once a minute) and tells listeners when it changes. */
export class CharityMeter {
  private mint: string;
  private url: string;
  private everyMs: number;
  current: CharityReading;
  private timer: ReturnType<typeof setInterval> | null = null;
  onChange: (r: CharityReading) => void = () => {};

  constructor(mint: string, url: string, everyMs = 60_000) {
    this.mint = mint.trim();
    this.url = url;
    this.everyMs = everyMs;
    this.current = this.mint ? { state: "unavailable", note: "first read pending" } : { state: "prelaunch" };
  }

  start(): void {
    if (!this.mint) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.everyMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async refresh(): Promise<void> {
    try {
      const r = await readCharity(this.mint, this.url);
      // A failed or partial read never replaces a good number with a guess; "unavailable" carries no amount.
      if (r.state === "live" || this.current.state !== "live") {
        const changed = JSON.stringify({ ...r, updatedAt: 0 }) !== JSON.stringify({ ...this.current, updatedAt: 0 });
        this.current = r;
        if (changed) this.onChange(r);
      }
    } catch (e) {
      console.log(new Date().toISOString(), "charity read failed:", (e as Error).message);
    }
  }
}
