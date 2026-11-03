// Survival for one shard (protocol v5). The server is the authority for every item and every point of health:
// inventories, windows (crafting, furnaces, chests), what breaking drops, tool wear, placing (it must be in your
// hand), eating, damage (falls, drowning, starving), death (everything drops where you died), respawning (your bed,
// or the hub), sleeping through the night, and the spawn safe zone (no building, no damage). Clients predict
// clicks with the same shared code (shared/inventory.ts) and the server's answer always wins.
// v6: combat (shared/combat.ts: the attack cooldown from the server's own clock, crits while falling, knockback),
// armour (worn in the inventory's armour slots: it softens mob hits and wears out; others see it), night-mob hits
// and arrows with knockback, spoiled flesh making you queasy, bone meal on saplings, no sleeping with monsters near.
// v7: farming (a hoe tills grass and dirt into farmland, seeds go on it, bone meal ripens wheat, landing on farmland
// can trample it), buckets (scoop up water and pour it out; milk a cow; milk settles a queasy stomach), cake (eat it
// a slice at a time), and the bow (draw and release: the power, the arrow and the wear all on the server's clock).

import { B, BLOCKS, CLIMB, IS_WATER, SOLID, cakeBites, isCake, isChest, isFarmland, isFlower, isFurnace, isPot, isSapling, isStorage, isWheat, potFor, pottedFlower, wheatAge } from "../../shared/blocks.ts";
import { BOW_SPEED, KNOCKBACK, SPRINT_KNOCKBACK, afterArmor, afterProtection, armorOf, armorValue, armorWear, attackStrength, bowPower, isCrit, packArmor, swingDamage } from "../../shared/combat.ts";
import { planEnchant, shelvesAround, type EnchantPlan } from "../../shared/enchanting.ts";
import { ANIMAL } from "../../shared/animals.ts";
import { hydrated } from "./farm.ts";
import { EYE_HEIGHT, SNEAK_EYE_HEIGHT, WORLD_SIZE, cellX, cellY, cellZ, idx, inWorld } from "../../shared/constants.ts";
import { Menu, addToInventory, newPlayerInv, type Click, type Items, type PlayerInv } from "../../shared/inventory.ts";
import { I, SMELT, SMELT_TICKS, fromWire, fuelTicks, isHoe, itemDef, maxDurability, toWire, type Stack, type WireStack } from "../../shared/items.ts";
import { hash2 } from "../../shared/noise.ts";
import { blockDrops, breakTicks, toolWearForBlock } from "../../shared/mining.ts";
import { eyeInWater } from "../../shared/physics.ts";
import { FLAG, type GameMode, type Stats, type WindowKind } from "../../shared/protocol.ts";
import { bed as bedState, isBed, isDoor, door as doorState, partnerCell } from "../../shared/shapes.ts";
import { EAT_TICKS, EXHAUST, FallTracker, HURT_TICKS, MAX_AIR, MAX_FOOD, MAX_HP, QUEASY_TICKS, SAFE_FALL, deathMessage, eat, exhaust, groundedAlong, newBody, tickAir, tickFood, type Body } from "../../shared/survival.ts";
import { THROW_DELAY } from "../../shared/drops.ts";
import { RECIPES, canMake, layoutFor, recipeSize } from "../../shared/recipes.ts";
import { animalDrops, type Animal } from "./animals.ts";
import { mobDrops, type Mob } from "./mobs.ts";
import { litFurnace } from "./containers.ts";
import type { Player, Shard } from "./shard.ts";
import type { Villager } from "./villagers.ts";
import { TALK_REACH_SERVER, villagerTitle } from "../../shared/villagers.ts";
import { TRADES } from "../../shared/trades.ts";

/** What is saved per player key (with the position). */
export interface SurvivalData {
  inv: WireStack[];
  armor?: WireStack[];
  hp: number;
  food: number;
  sat: number;
  exh: number;
  air: number;
  bed: [number, number, number] | null;
  gm?: GameMode;
  dead?: boolean;
}

/** Per-player survival state (lives on the Player). */
export interface SurvivalState {
  gm: GameMode;
  inv: PlayerInv;
  sel: number;
  body: Body;
  hurtUntil: number; // tick
  dead: boolean;
  bed: [number, number, number] | null;
  cursor: { s: Stack | null };
  win: { w: number; menu: Menu; kind: WindowKind; cell: number; vid?: number } | null; // v9: vid, the villager traded with
  winSeq: number;
  dirty: Set<number>; // inventory slots to send
  statsDirty: boolean;
  lastStats: string;
  eatStart: number; // ms (Date.now()), -1 = not eating
  eatItem: number;
  fall: FallTracker;
  sleeping: boolean;
  sleepSince: number;
  first: boolean;
  lastX: number;
  lastY: number;
  lastZ: number;
  wasGrounded: boolean;
  clicks: { n: number; at: number }; // rate limit
  lastSwing: number; // v6: the tick of the last swing (the attack cooldown runs from it)
  dy: number; // v6: the last move's vertical change (falling, for crits)
  drawStart: number; // v7: the tick the bow was drawn, -1 = not drawing
}

export const FIRST_KIT: Stack[] = [{ id: I.APPLE, n: 3, d: 0 }];
const NIGHT_START = 12542;
const NIGHT_END = 23459;

export function newSurvival(): SurvivalState {
  return {
    gm: "survival", inv: newPlayerInv(), sel: 0, body: newBody(), hurtUntil: 0, dead: false, bed: null, cursor: { s: null },
    win: null, winSeq: 0, dirty: new Set(), statsDirty: true, lastStats: "", eatStart: -1, eatItem: 0, fall: new FallTracker(),
    sleeping: false, sleepSince: 0, first: false, lastX: 0, lastY: 0, lastZ: 0, wasGrounded: true, clicks: { n: 0, at: 0 },
    lastSwing: -100, dy: 0, drawStart: -1,
  };
}

export class Survival {
  private sh: Shard;
  /** Players looking into each container cell. */
  private viewers = new Map<number, Set<Player>>();
  private sleepers = 0;

  constructor(sh: Shard) {
    this.sh = sh;
    sh.containers.onChange = (cell, items) => this.containerChanged(cell, items);
    sh.animals.onDeath = (a) => this.animalDied(a);
    // v7: eggs
    sh.animals.onEgg = (a) => {
      this.sh.items.spawn({ id: I.EGG, n: 1, d: 0 }, a.x, a.y + 0.3, a.z, (Math.random() - 0.5) * 0.1, 0.15, (Math.random() - 0.5) * 0.1);
      this.sh.broadcastNearPoint(a.x, a.z, { t: "fx", k: "pickup", x: +a.x.toFixed(2), y: +(a.y + 0.3).toFixed(2), z: +a.z.toFixed(2) }, 16);
    };
  }

  /** v6: wires the night mobs' hits and deaths to the players (Shard calls this once the mob manager exists). */
  attachMobs(): void {
    const mh = this.sh.mobs.hooks;
    mh.hurtPlayer = (id, dmg, cause, fx, fz, dx, dz) => {
      const p = this.sh.players.get(id);
      if (p) this.damage(p, dmg, cause, fx, fz, { armor: true, kb: [dx * KNOCKBACK, 0.4, dz * KNOCKBACK] });
    };
    mh.died = (m, byPlayer) => this.mobDied(m, byPlayer);
    // v7: players' arrows hit animals too, the archer hears what they did, and stuck ones can be picked up
    mh.animalsNear = (x, z, r) => {
      const out = [];
      for (const a of this.sh.animals.animals.values()) {
        if (a.dying || Math.abs(a.x - x) > r || Math.abs(a.z - z) > r) continue;
        out.push({ id: a.id, x: a.x, y: a.y, z: a.z, w: a.hw * 2, h: a.h });
      }
      return out;
    };
    mh.hurtAnimal = (id, dmg, fx, fz) => {
      const a = this.sh.animals.animals.get(id);
      if (!a) return { dealt: 0, killed: false };
      const hp = a.hp;
      const killed = this.sh.animals.hit(a, fx, fz, dmg);
      return { dealt: hp - a.hp, killed };
    };
    mh.arrowStruck = (a, id, mob, dealt, killed) => {
      const p = a.player !== undefined ? this.sh.players.get(a.player) : undefined;
      if (p) this.sh.send(p, { t: "struck", id, mob, dmg: +dealt.toFixed(2), crit: !!a.crit && dealt > 0, kills: killed });
    };
    mh.pickupArrow = (id) => {
      const p = this.sh.players.get(id);
      if (!p || p.sv.dead || p.sv.gm !== "survival") return false;
      const s = p.sv;
      const before = s.inv.inv.slice();
      const probe = before.map((x) => (x ? { ...x } : null));
      if (addToInventory(probe, { id: I.ARROW, n: 1, d: 0 }) > 0) return false; // no room
      this.give(p, { id: I.ARROW, n: 1, d: 0 });
      return true;
    };
    mh.arrowGone = (st, player) => {
      this.sh.broadcastNearPoint(st.x, st.z, { t: "arrow_gone", id: st.id }, 96);
      if (player) this.sh.broadcastNearPoint(st.x, st.z, { t: "fx", k: "pickup", x: +st.x.toFixed(2), y: +st.y.toFixed(2), z: +st.z.toFixed(2) }, 24);
    };
  }

  // ---------------------------------------------------------------- join / leave / save

  /** Fill a joining player's survival state from what was saved (or start fresh, with the first-join kit). */
  init(p: Player, data: SurvivalData | undefined): void {
    const s = p.sv;
    if (!data) {
      s.first = true;
      for (const st of FIRST_KIT) addToInventory(s.inv.inv, { ...st });
      return;
    }
    s.inv.inv = Array.from({ length: 36 }, (_, k) => fromWire(data.inv?.[k]));
    s.inv.armor = Array.from({ length: 4 }, (_, k) => fromWire(data.armor?.[k]));
    const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === "number" && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d);
    s.body.hp = num(data.hp, 0, MAX_HP, MAX_HP);
    s.body.food = num(data.food, 0, MAX_FOOD, MAX_FOOD);
    s.body.sat = num(data.sat, 0, MAX_FOOD, 5);
    s.body.exh = num(data.exh, 0, 40, 0);
    s.body.air = num(data.air, -20, MAX_AIR, MAX_AIR);
    s.bed = Array.isArray(data.bed) && data.bed.length === 3 && data.bed.every(Number.isInteger) ? data.bed : null;
    s.gm = data.gm === "creative" ? "creative" : "survival";
    if (data.dead || s.body.hp <= 0) {
      // died and left before respawning: come back at the bed or the hub, fresh
      s.body = newBody();
      const at = this.respawnPoint(p);
      p.x = p.vx = at.x;
      p.y = p.vy = at.y;
      p.z = p.vz = at.z;
    }
  }

  data(p: Player): SurvivalData {
    const s = p.sv;
    return {
      inv: s.inv.inv.map(toWire),
      armor: s.inv.armor.map(toWire),
      hp: s.body.hp,
      food: s.body.food,
      sat: +s.body.sat.toFixed(2),
      exh: +s.body.exh.toFixed(3),
      air: s.body.air,
      bed: s.bed,
      gm: s.gm === "creative" ? "creative" : undefined,
      dead: s.dead || undefined,
    };
  }

  /** Leaving: windows close (their items go back into the inventory, or drop). */
  leave(p: Player): void {
    this.closeWindow(p, false);
    this.closePlayerGrid(p);
    if (p.sv.sleeping) this.wake(p);
  }

  stats(p: Player): Stats {
    const b = p.sv.body;
    const st: Stats = { hp: +b.hp.toFixed(2), food: b.food, sat: +b.sat.toFixed(1), air: Math.max(0, b.air) };
    if (b.queasy > 0) st.queasy = true;
    return st;
  }

  held(p: Player): Stack | null {
    return p.sv.inv.inv[p.sv.sel] ?? null;
  }

  heldId(p: Player): number {
    return this.held(p)?.id ?? 0;
  }

  /** Inside the spawn safe zone (v10: the bigger hub, less the tiles kept for players' builds; shared/hub12.ts). */
  inSafe(x: number, z: number): boolean {
    return this.sh.zone.contains(x, z);
  }

  private markSlot(p: Player, s: number): void {
    p.sv.dirty.add(s);
    if (s === p.sv.sel) this.updateHeld(p);
  }

  /** v6: what someone wears changed (a click in the inventory, wear, death): tell everyone, with a clank nearby. */
  private updateArmor(p: Player, sound: boolean): void {
    const v = packArmor(p.sv.inv.armor);
    if (v === p.armor) return;
    const more = (v & ~p.armor) !== 0;
    p.armor = v;
    this.sh.broadcast({ t: "wear", id: p.id, armor: v }, p);
    if (sound && more) this.sh.broadcastNear(p, { t: "fx", k: "equip", x: p.x, y: p.y + 1, z: p.z }, 16, true);
  }

  private updateHeld(p: Player): void {
    const id = this.heldId(p);
    if (id !== p.held) {
      p.held = id;
      p.version++;
    }
  }

  private setGm(p: Player, mode: GameMode): void {
    p.sv.gm = mode;
    this.sh.send(p, { t: "gm", mode });
    if (mode === "creative") {
      p.sv.body = newBody();
      p.sv.statsDirty = true;
    }
  }

  setGameMode(p: Player, mode: GameMode): void {
    this.setGm(p, mode);
  }

  // ---------------------------------------------------------------- messages

  onMessage(p: Player, msg: { t: string; [k: string]: unknown }): void {
    switch (msg.t) {
      case "sel": {
        const s = msg.s;
        if (!Number.isInteger(s) || (s as number) < 0 || (s as number) > 8) return;
        // v6: a different item in hand starts the attack cooldown over (Java's: no swapping to dodge it)
        if ((p.sv.inv.inv[p.sv.sel]?.id ?? 0) !== (p.sv.inv.inv[s as number]?.id ?? 0)) p.sv.lastSwing = this.sh.tickCount;
        p.sv.sel = s as number;
        if (p.sv.eatStart >= 0) this.stopEating(p);
        if (p.sv.drawStart >= 0) this.stopDrawing(p);
        this.updateHeld(p);
        break;
      }
      case "bow":
        this.onBow(p, msg.a as string);
        break;
      case "click":
        this.onClick(p, msg.w as number, msg.n as number, msg.c as Click);
        break;
      case "close":
        if (msg.w === 0) this.closePlayerGrid(p);
        else if (p.sv.win && p.sv.win.w === msg.w) this.closeWindow(p, false);
        break;
      case "eat":
        this.onEat(p, msg.a as string);
        break;
      case "drop":
        this.dropHeld(p, msg.all === true);
        break;
      case "respawn":
        if (!p.agent || process.env.HARDCORE !== "1") this.respawn(p); // clankersmp: one life
        break;
      case "wake":
        if (p.sv.sleeping) this.wake(p);
        break;
      case "trade":
        this.onTrade(p, msg.w as number, msg.o as number, msg.all === true);
        break;
      case "cset": {
        // creative: put any block or item in a hotbar slot
        if (p.sv.gm !== "creative") return;
        const s = msg.s as number;
        const id = msg.id as number;
        if (!Number.isInteger(s) || s < 0 || s > 8) return;
        if (id === 0) p.sv.inv.inv[s] = null;
        else if (itemDef(id)) p.sv.inv.inv[s] = { id, n: Math.min(64, itemDef(id)!.stack), d: 0 };
        this.markSlot(p, s);
        break;
      }
    }
  }

  // ---------------------------------------------------------------- windows

  private nextWin(p: Player): number {
    p.sv.winSeq = (p.sv.winSeq % 200) + 1;
    return p.sv.winSeq;
  }

  /** v9: a villager's trade window: its offers over your inventory. */
  openTrade(p: Player, v: Villager): void {
    const s = p.sv;
    if (s.dead) return;
    if (s.win?.kind === "trade" && s.win.vid === v.id) return; // already open (a second click on the way)
    this.closeWindow(p, false);
    this.closePlayerGrid(p);
    const w = this.nextWin(p);
    const menu = new Menu("trade", s.inv);
    s.win = { w, menu, kind: "trade", cell: -1, vid: v.id };
    this.sh.villagers.startTalk(v, p.id, p.x, p.z);
    this.sh.send(p, { t: "open", w, kind: "trade", title: villagerTitle(v.def.name, v.job), items: menu.contents().map(toWire), cursor: toWire(s.cursor.s), vid: v.id, offers: this.sh.villagers.offers(v) });
  }

  /** v9: trade offer `o` in the open trade window, once or (`all`) as many times as it can. The server's own copy
   *  of the inventory pays and receives (shared/trades.ts): nothing is created, and a refused trade changes
   *  nothing. Everyone looking at the same villager sees the new stock. */
  private onTrade(p: Player, w: number, o: number, all: boolean): void {
    const s = p.sv;
    if (s.dead || !Number.isInteger(w) || !Number.isInteger(o)) return;
    const now = this.sh.tickCount;
    if (now - s.clicks.at >= 20) s.clicks = { n: 0, at: now };
    if (++s.clicks.n > 40) return this.sh.violation(p, "click rate");
    if (!s.win || s.win.w !== w || s.win.kind !== "trade" || s.win.vid === undefined) {
      this.sh.send(p, { t: "close", w });
      return;
    }
    const v = this.sh.villager(s.win.vid);
    if (!v) return this.closeWindow(p, true);
    const n = this.sh.villagers.trade(v, o, s.inv.inv, all);
    this.sh.send(p, { t: "win", w, n: -1, items: s.win.menu.contents().map(toWire), cursor: toWire(s.cursor.s) });
    this.updateHeld(p);
    this.sh.broadcastNearPoint(v.x, v.z, { t: "fx", k: n ? "trade" : "trade_no", id: v.id, x: +v.x.toFixed(2), y: +(v.y + 1.4).toFixed(2), z: +v.z.toFixed(2) }, 16);
    if (n) this.pushOffers(v);
  }

  /** v9: the villager's stock changed: every open trade window on it gets the new offers. */
  pushOffers(v: Villager): void {
    const offers = this.sh.villagers.offers(v);
    for (const q of this.sh.players.values()) if (q.sv.win?.kind === "trade" && q.sv.win.vid === v.id) this.sh.send(q, { t: "offers", w: q.sv.win.w, offers });
  }

  /** Open a crafting table, furnace or chest window for the block at (x, y, z). */
  openContainer(p: Player, x: number, y: number, z: number): boolean {
    const id = this.sh.getBlock(x, y, z);
    const cell = idx(x, y, z);
    let kind: WindowKind;
    let container: Items;
    let title: string;
    if (id === B.CRAFTING_TABLE) {
      kind = "crafting";
      container = new Array(9).fill(null);
      title = "Crafting";
    } else if (isFurnace(id)) {
      kind = "furnace";
      container = this.sh.containers.furnace(cell).items;
      title = "Furnace";
    } else if (isChest(id)) {
      kind = "chest";
      container = this.sh.containers.chest(cell);
      title = "Chest";
    } else if (id === B.BARREL) {
      // v8: a barrel holds as much as a chest
      kind = "chest";
      container = this.sh.containers.chest(cell);
      title = "Barrel";
    } else return false;
    if (p.sv.dead) return true;
    this.closeWindow(p, false);
    this.closePlayerGrid(p);
    const w = this.nextWin(p);
    const menu = new Menu(kind, p.sv.inv, container);
    p.sv.win = { w, menu, kind, cell };
    if (kind !== "crafting") {
      let set = this.viewers.get(cell);
      if (!set) this.viewers.set(cell, (set = new Set()));
      set.add(p);
    }
    this.sh.send(p, { t: "open", w, kind, title, items: menu.contents().map(toWire), cursor: toWire(p.sv.cursor.s) });
    if (kind === "furnace") this.sendFurnace(p, cell);
    if (kind === "chest") this.sh.broadcastNear(p, { t: "fx", k: "level", id: 1, x: x + 0.5, y: y + 0.5, z: z + 0.5 }, 24, true);
    return true;
  }

  private sendFurnace(p: Player, cell: number): void {
    const f = this.sh.containers.furnaces.get(cell);
    if (!f || !p.sv.win) return;
    this.sh.send(p, { t: "furnace", w: p.sv.win.w, burn: f.burnMax ? +(f.burn / f.burnMax).toFixed(3) : 0, cook: +(f.cook / SMELT_TICKS).toFixed(3) });
  }

  private onClick(p: Player, w: number, n: number, c: Click): void {
    const s = p.sv;
    if (s.dead || !c || typeof c !== "object") return;
    const now = this.sh.tickCount;
    if (now - s.clicks.at >= 20) s.clicks = { n: 0, at: now };
    if (++s.clicks.n > 40) return this.sh.violation(p, "click rate");
    let menu: Menu;
    if (w === 0) {
      if (s.win) return this.resendWindow(p); // the client thinks its inventory is open, but a container is
      menu = new Menu("player", s.inv);
    } else {
      if (!s.win || s.win.w !== w) {
        this.sh.send(p, { t: "close", w });
        return;
      }
      menu = s.win.menu;
    }
    if (s.gm === "creative" && c.m === "fill") return;
    const res = menu.click(c, s.cursor);
    for (const d of res.drops) this.throwStack(p, d);
    if (res.crafted.length) exhaust(s.body, 0);
    this.sh.send(p, { t: "win", w, n: Number.isInteger(n) ? n : 0, items: menu.contents().map(toWire), cursor: toWire(s.cursor.s) });
    this.updateHeld(p);
    if (w === 0) this.updateArmor(p, true);
    if (s.win && w !== 0 && s.win.kind !== "crafting") {
      const cell = s.win.cell;
      if (s.win.kind === "furnace") this.sh.containers.wake(cell);
      this.pushToViewers(cell, p);
    }
  }

  private resendWindow(p: Player): void {
    const s = p.sv;
    if (!s.win) return;
    this.sh.send(p, { t: "win", w: s.win.w, n: -1, items: s.win.menu.contents().map(toWire), cursor: toWire(s.cursor.s) });
  }

  /** A container's contents changed: everyone else looking at it gets the new contents. */
  private pushToViewers(cell: number, except: Player | null): void {
    const set = this.viewers.get(cell);
    if (!set) return;
    for (const q of set) {
      if (q === except || !q.sv.win || q.sv.win.cell !== cell) continue;
      this.sh.send(q, { t: "win", w: q.sv.win.w, n: -1, items: q.sv.win.menu.contents().map(toWire), cursor: toWire(q.sv.cursor.s) });
    }
  }

  private containerChanged(cell: number, items: boolean): void {
    const set = this.viewers.get(cell);
    if (!set) return;
    for (const q of set) {
      if (!q.sv.win || q.sv.win.cell !== cell) continue;
      if (items) this.sh.send(q, { t: "win", w: q.sv.win.w, n: -1, items: q.sv.win.menu.contents().map(toWire), cursor: toWire(q.sv.cursor.s) });
      if (items || this.sh.tickCount % 4 === 0) this.sendFurnace(q, cell);
    }
  }

  /** Close the container window: the crafting grid and the cursor go back into the inventory (or drop). */
  closeWindow(p: Player, tell: boolean): void {
    const s = p.sv;
    if (!s.win) return;
    const { w, menu, cell, kind, vid } = s.win;
    for (const d of menu.close(s.cursor)) this.throwStack(p, d);
    s.win = null;
    if (vid !== undefined) {
      const v = this.sh.villager(vid);
      if (v) this.sh.villagers.endTalk(v, p.id);
    }
    this.viewers.get(cell)?.delete(p);
    if (tell) this.sh.send(p, { t: "close", w });
    this.sendInventory(p);
    if (kind === "chest") this.sh.broadcastNear(p, { t: "fx", k: "level", id: 0, x: cellX(cell) + 0.5, y: cellY(cell) + 0.5, z: cellZ(cell) + 0.5 }, 24, true);
  }

  /** Closing the inventory (E): the 2x2 grid and the cursor go back. */
  closePlayerGrid(p: Player): void {
    const s = p.sv;
    if (!s.inv.craft.some(Boolean) && !s.cursor.s) return;
    const m = new Menu("player", s.inv);
    for (const d of m.close(s.cursor)) this.throwStack(p, d);
    this.sendInventory(p);
  }

  /** Re-send every slot (the 36 of the inventory and, v6, the 4 armour slots: after a death or a reset they are
   *  empty, and the client must stop showing them worn). */
  sendInventory(p: Player): void {
    for (let k = 0; k < 40; k++) p.sv.dirty.add(k);
    this.updateHeld(p);
  }

  // ---------------------------------------------------------------- drops

  /** Throw a stack out of the player's hands, the way they look (Q, or dropped out of a window). */
  throwStack(p: Player, st: Stack): void {
    const yaw = (p.yaw * Math.PI) / 180;
    const pitch = (p.pitch * Math.PI) / 180;
    const dx = -Math.sin(yaw) * Math.cos(pitch);
    const dz = Math.cos(yaw) * Math.cos(pitch);
    const dy = -Math.sin(pitch);
    const ey = p.y + (p.flags & FLAG.SNEAK ? SNEAK_EYE_HEIGHT : EYE_HEIGHT) - 0.3;
    this.sh.items.spawn(st, p.x, ey, p.z, dx * 0.3, dy * 0.3 + 0.1, dz * 0.3, THROW_DELAY, p.key);
  }

  private dropHeld(p: Player, all: boolean): void {
    const s = p.sv;
    if (s.dead || s.win) return;
    const st = s.inv.inv[s.sel];
    if (!st) return;
    const n = all ? st.n : 1;
    s.inv.inv[s.sel] = st.n - n > 0 ? { ...st, n: st.n - n } : null;
    this.markSlot(p, s.sel);
    this.throwStack(p, { ...st, n });
  }

  /** An item entity touched the player: put it in the inventory. Returns what didn't fit. */
  give(p: Player, st: Stack): number {
    const s = p.sv;
    if (s.dead) return st.n;
    const before = s.inv.inv.slice();
    const left = addToInventory(s.inv.inv, st);
    for (let k = 0; k < 36; k++) if (s.inv.inv[k] !== before[k]) this.markSlot(p, k);
    return left;
  }

  // ---------------------------------------------------------------- building

  /** May this player change blocks here? (The safe zone is no-build for everyone but creative admins.) */
  canEdit(p: Player, x: number, z: number): boolean {
    if (p.sv.gm === "creative" && this.sh.adminBuild(p)) return true;
    return !this.inSafe(x + 0.5, z + 0.5);
  }

  /** Placing `id`: the matching item must be in the player's hand (survival takes one). */
  takeForPlace(p: Player, id: number): boolean {
    if (p.sv.dead) return false;
    if (p.sv.gm === "creative") return true;
    const st = this.held(p);
    // v7: water is poured from a water bucket (a block item for it alone is creative only)
    if (id === B.WATER) return !!st && st.id === I.WATER_BUCKET;
    // v13: the smith's lava sets into obsidian where it's poured (the shard checks there's water beside it)
    if (id === B.OBSIDIAN && st?.id === I.LAVA_BUCKET) return true;
    const want = BLOCKS[id]?.item;
    if (!st || st.id !== want) return false;
    return true;
  }

  consumePlaced(p: Player): void {
    if (p.sv.gm === "creative") return;
    const s = p.sv;
    const st = s.inv.inv[s.sel];
    if (!st) return;
    // v7: a water bucket poured out is an empty bucket again
    const rem = itemDef(st.id)?.remainder;
    if (rem && st.n === 1) s.inv.inv[s.sel] = { id: rem, n: 1, d: 0 };
    else s.inv.inv[s.sel] = st.n > 1 ? { ...st, n: st.n - 1 } : null;
    this.markSlot(p, s.sel);
  }

  /** Ticks this player needs to break a block (creative: instant). */
  breakTicksFor(p: Player, block: number): number {
    if (p.sv.gm === "creative") return BLOCKS[block] && block !== B.BEDROCK ? 0 : -1;
    const f = p.flags;
    return breakTicks(block, this.heldId(p), (f & FLAG.WATER) !== 0 && this.headInWater(p), (f & FLAG.GROUND) !== 0);
  }

  private headInWater(p: Player): boolean {
    return eyeInWater(this.sh.getBlock, p.x, p.y + (p.flags & FLAG.SNEAK ? SNEAK_EYE_HEIGHT : EYE_HEIGHT), p.z);
  }

  /** After a player broke (x, y, z): drops for the block (and for anything that popped off), tool wear, hunger,
   *  and a container's contents. `olds` are the cells' blocks before the change. */
  afterBreak(p: Player, x: number, y: number, z: number, changes: [number, number, number, number][], olds: number[]): void {
    const s = p.sv;
    const main = olds[0];
    const cell = idx(x, y, z);
    if (isFurnace(main) || isStorage(main)) {
      for (const st of this.sh.containers.remove(cell)) this.sh.items.dropAt(st, x, y, z);
      this.closeViewers(cell);
    }
    if (s.gm === "creative") return;
    const held = this.heldId(p);
    for (const st of blockDrops(main, held, Math.random)) this.sh.items.dropAt(st, x, y, z);
    const partner = partnerCell(main, x, y, z);
    for (let k = 1; k < changes.length; k++) {
      const [cx, cy, cz, nid] = changes[k];
      const old = olds[k];
      if (nid !== B.AIR && !IS_WATER[nid]) continue;
      if (partner && cx === partner[0] && cy === partner[1] && cz === partner[2]) continue;
      if (isDoor(old) && doorState(old).upper) continue; // a popped door drops once (its lower half)
      if (isBed(old) && bedState(old).head) continue;
      for (const st of blockDrops(old, 0, Math.random)) this.sh.items.dropAt(st, cx, cy, cz);
    }
    exhaust(s.body, EXHAUST.breakBlock);
    this.wearHeld(p, toolWearForBlock(main, held));
  }

  /** Tool damage; a tool that runs out breaks (with a sound for everyone near). */
  private wearHeld(p: Player, n: number): void {
    if (n <= 0 || p.sv.gm === "creative") return;
    const s = p.sv;
    const st = s.inv.inv[s.sel];
    const t = st ? itemDef(st.id)?.tool : undefined;
    if (!st || !t) return;
    const d = st.d + n;
    if (d >= t.durability) {
      s.inv.inv[s.sel] = null;
      this.sh.send(p, { t: "fx", k: "tool_break", id: st.id });
      this.sh.broadcastNear(p, { t: "fx", k: "tool_break", id: st.id, x: p.x, y: p.y + 1, z: p.z }, 24);
    } else s.inv.inv[s.sel] = { ...st, d };
    this.markSlot(p, s.sel);
  }

  /** A container block went away: whoever was looking into it is shown out. */
  closeViewers(cell: number): void {
    const set = this.viewers.get(cell);
    if (!set) return;
    for (const q of [...set]) if (q.sv.win?.cell === cell) this.closeWindow(q, true);
    this.viewers.delete(cell);
  }

  /** Right click on a block (not a door): crafting tables, furnaces, chests, beds; v6: bone meal on a sapling;
   *  v7: a hoe on grass or dirt, bone meal on wheat, a slice of cake, an empty bucket on a water source. */
  useBlock(p: Player, x: number, y: number, z: number): boolean {
    const id = this.sh.getBlock(x, y, z);
    const held = this.heldId(p);
    if (isSapling(id) && held === I.BONE_MEAL) {
      this.boneMeal(p, x, y, z);
      return true;
    }
    if (isWheat(id) && held === I.BONE_MEAL) return this.boneMealCrop(p, x, y, z, id);
    if ((id === B.GRASS || id === B.DIRT) && isHoe(held)) return this.till(p, x, y, z);
    if (isCake(id)) return this.eatCake(p, x, y, z, id);
    if (id === B.WATER && held === I.BUCKET) return this.scoopWater(p, x, y, z);
    // v8: a shovel makes a path, bone meal on grass grows grass and flowers, flowers go in pots (and come back out),
    // the village chime rings
    if ((id === B.GRASS || id === B.DIRT) && itemDef(held)?.tool?.kind === "shovel") return this.makePath(p, x, y, z);
    if (id === B.GRASS && held === I.BONE_MEAL) return this.boneMealGrass(p, x, y, z);
    if (isPot(id)) return this.usePot(p, x, y, z, id, held);
    if (id === B.VILLAGE_CHIME) return this.ringChime(p, x, y, z);
    // v13: the enchanting table, with something enchantable in hand: the best level the shelves allow and you can pay
    if (id === B.ENCHANTING_TABLE) {
      const r = this.enchant(p, 0, [x, y, z]);
      this.sh.notice(p, r.id ? `Enchanted: ${itemDef(r.id)?.name} for ${r.cost} rubies.` : `The table can't enchant that: ${r.why}.`);
      return true;
    }
    if (isBed(id)) {
      this.useBed(p, x, y, z, id);
      return true;
    }
    return this.openContainer(p, x, y, z);
  }

  // ---------------------------------------------------------------- v8: paths, flowers, pots, the chime

  /** A shovel on grass or dirt with air above: a dirt path (a pixel lower, like the classic ones). */
  private makePath(p: Player, x: number, y: number, z: number): boolean {
    if (p.sv.dead || this.sh.getBlock(x, y + 1, z) !== B.AIR || !this.canEdit(p, x, z)) return false;
    this.sh.setBlock(idx(x, y, z), B.DIRT_PATH, p);
    this.wearHeld(p, 1);
    this.sh.broadcastNear(p, { t: "fx", k: "path", x: x + 0.5, y: y + 1, z: z + 0.5 }, 24);
    return true;
  }

  /** Bone meal on grass: tall grass and flowers spring up around it. The flowers are the kinds already growing
   *  near (so bluebells spread where you plant them), or dandelions and poppies. */
  private boneMealGrass(p: Player, x: number, y: number, z: number): boolean {
    const s = p.sv;
    if (s.dead || this.sh.getBlock(x, y + 1, z) !== B.AIR || !this.canEdit(p, x, z)) return false;
    if (s.gm !== "creative") {
      const st = s.inv.inv[s.sel];
      if (!st || st.id !== I.BONE_MEAL) return false;
      s.inv.inv[s.sel] = st.n > 1 ? { ...st, n: st.n - 1 } : null;
      this.markSlot(p, s.sel);
    }
    const near: number[] = [];
    for (let dz = -6; dz <= 6; dz++)
      for (let dx = -6; dx <= 6; dx++)
        for (let dy = -2; dy <= 2; dy++) {
          const id = this.sh.getBlock(x + dx, y + 1 + dy, z + dz);
          if (isFlower(id) && !near.includes(id)) near.push(id);
        }
    const kinds = near.length ? near : [B.DANDELION, B.POPPY];
    const seed = (Date.now() & 0xffff) ^ (x * 31 + z * 17);
    for (let k = 0; k < 24; k++) {
      const gx = x + Math.round((hash2(k, seed, 1) + hash2(k, seed, 2) - 1) * 3);
      const gz = z + Math.round((hash2(k, seed, 3) + hash2(k, seed, 4) - 1) * 3);
      for (const gy of [y, y + 1, y - 1]) {
        if (this.sh.getBlock(gx, gy, gz) !== B.GRASS || this.sh.getBlock(gx, gy + 1, gz) !== B.AIR || !this.canEdit(p, gx, gz)) continue;
        const r = hash2(k, seed, 5);
        this.sh.setBlock(idx(gx, gy + 1, gz), r < 0.7 ? B.TALL_GRASS : kinds[Math.floor(hash2(k, seed, 6) * kinds.length)], p);
        break;
      }
    }
    this.sh.broadcastNear(p, { t: "fx", k: "bone_meal", x: x + 0.5, y: y + 1.2, z: z + 0.5 }, 32, true);
    return true;
  }

  /** A flower in your hand goes into an empty pot; an empty hand takes a potted flower back out. */
  private usePot(p: Player, x: number, y: number, z: number, id: number, held: number): boolean {
    const s = p.sv;
    if (s.dead || !this.canEdit(p, x, z)) return false;
    if (id === B.FLOWER_POT) {
      const potted = potFor(held);
      if (potted < 0) return false;
      if (s.gm !== "creative") {
        const st = s.inv.inv[s.sel]!;
        s.inv.inv[s.sel] = st.n > 1 ? { ...st, n: st.n - 1 } : null;
        this.markSlot(p, s.sel);
      }
      this.sh.setBlock(idx(x, y, z), potted, p);
    } else {
      if (held !== 0) return false;
      const flower = pottedFlower(id);
      this.sh.setBlock(idx(x, y, z), B.FLOWER_POT, p);
      if (s.gm !== "creative") {
        const left = this.give(p, { id: flower, n: 1, d: 0 });
        if (left) this.sh.items.dropAt({ id: flower, n: left, d: 0 }, x, y, z);
      }
    }
    this.sh.broadcastNear(p, { t: "fx", k: "pot", x: x + 0.5, y: y + 0.4, z: z + 0.5 }, 24, true);
    return true;
  }

  private chimeRung = new Map<number, number>();
  /** The village chime rings for everyone near (at most twice a second per chime). Anywhere, the hub too. */
  private ringChime(p: Player, x: number, y: number, z: number): boolean {
    if (p.sv.dead) return false;
    const cell = idx(x, y, z);
    const t = this.sh.tickCount;
    if (t - (this.chimeRung.get(cell) ?? -100) < 10) return true;
    this.chimeRung.set(cell, t);
    if (this.chimeRung.size > 256) this.chimeRung.clear();
    this.sh.broadcastNearPoint(x + 0.5, z + 0.5, { t: "fx", k: "chime", x: x + 0.5, y: y + 0.7, z: z + 0.5 }, 64);
    return true;
  }

  // ---------------------------------------------------------------- combat with animals

  /** A swing (at anything, or at nothing) starts the attack cooldown over. */
  swung(p: Player): void {
    p.sv.lastSwing = this.sh.tickCount;
  }

  /** The swing that is landing now: its strength (the server's own clock since the last swing), whether it is a
   *  critical hit (judged from the moves the server accepted), and its damage. Starts the cooldown over. */
  private strike(p: Player): { dmg: number; strength: number; crit: boolean; kb: number } {
    const s = p.sv;
    const id = this.heldId(p);
    const strength = attackStrength(this.sh.tickCount - s.lastSwing, id);
    const fx = Math.floor(p.x);
    const fz = Math.floor(p.z);
    const climbing = CLIMB[this.sh.getBlock(fx, Math.floor(p.y), fz)] === 1 || CLIMB[this.sh.getBlock(fx, Math.floor(p.y + 1), fz)] === 1;
    const sprinting = (p.flags & FLAG.SPRINT) !== 0;
    const crit = isCrit(strength, { falling: s.dy < 0 && !s.wasGrounded, onGround: s.wasGrounded, climbing, inWater: (p.flags & FLAG.WATER) !== 0, sprinting });
    s.lastSwing = this.sh.tickCount;
    const dmg = s.gm === "creative" ? 100 : swingDamage(id, strength, crit);
    return { dmg, strength, crit, kb: KNOCKBACK + (sprinting && strength > 0.9 ? SPRINT_KNOCKBACK : 0) };
  }

  /** After a landed hit: hunger, and weapon wear (swords 1, other tools 2). */
  private afterStrike(p: Player): void {
    const s = p.sv;
    exhaust(s.body, EXHAUST.attack);
    const t = itemDef(this.heldId(p))?.tool;
    if (t && s.gm !== "creative") this.wearHeld(p, t.kind === "sword" ? 1 : 2);
  }

  hitAnimal(p: Player, a: Animal): void {
    const s = p.sv;
    if (s.dead) return;
    const k = this.strike(p);
    const hp = a.hp;
    const killed = this.sh.animals.hit(a, p.x, p.z, k.dmg);
    this.sh.send(p, { t: "struck", id: a.id, mob: false, dmg: +(hp - a.hp).toFixed(2), crit: k.crit, kills: killed });
    if (k.crit) this.sh.broadcastNear(p, { t: "fx", k: "crit", x: a.x, y: a.y + a.h * 0.6, z: a.z }, 32);
    this.afterStrike(p);
  }

  /** v6: a player hits a night mob (reach and rate are checked by the shard). */
  hitMob(p: Player, m: Mob): void {
    const s = p.sv;
    if (s.dead) return;
    const k = this.strike(p);
    const r = this.sh.mobs.damage(m, k.dmg, { x: p.x, z: p.z, kb: k.kb, player: p.id });
    this.sh.send(p, { t: "struck", id: m.id, mob: true, dmg: +r.dealt.toFixed(2), crit: k.crit && r.dealt > 0, kills: r.killed });
    if (k.crit && r.dealt > 0) this.sh.broadcastNear(p, { t: "fx", k: "crit", x: m.x, y: m.y + m.h * 0.6, z: m.z }, 32);
    this.afterStrike(p);
  }

  private animalDied(a: Animal): void {
    for (const st of animalDrops(a.kind)) this.sh.items.spawn(st, a.x, a.y + 0.4, a.z, (Math.random() - 0.5) * 0.15, 0.25, (Math.random() - 0.5) * 0.15);
  }

  private mobDied(m: Mob, byPlayer: boolean): void {
    for (const st of mobDrops(m.kind, byPlayer)) this.sh.items.spawn(st, m.x, m.y + 0.4, m.z, (Math.random() - 0.5) * 0.15, 0.25, (Math.random() - 0.5) * 0.15);
    this.sh.broadcastNearPoint(m.x, m.z, { t: "fx", k: "mob_die", id: m.kind, x: m.x, y: m.y + m.h * 0.5, z: m.z }, 32);
  }

  /** Bone meal on a sapling: used up, and about half the time the tree grows at once (if it has room). */
  private boneMeal(p: Player, x: number, y: number, z: number): void {
    const s = p.sv;
    if (s.dead) return;
    if (s.gm !== "creative") {
      const st = s.inv.inv[s.sel];
      if (!st || st.id !== I.BONE_MEAL) return;
      s.inv.inv[s.sel] = st.n > 1 ? { ...st, n: st.n - 1 } : null;
      this.markSlot(p, s.sel);
    }
    this.sh.broadcastNear(p, { t: "fx", k: "bone_meal", x: x + 0.5, y: y + 0.3, z: z + 0.5 }, 32, true);
    if (Math.random() < 0.45) this.sh.growSapling(idx(x, y, z));
  }

  // ---------------------------------------------------------------- v7: farming, cake, buckets

  /** A hoe on grass or dirt with air above: farmland (watered at once if water is near). */
  private till(p: Player, x: number, y: number, z: number): boolean {
    const s = p.sv;
    if (s.dead || this.sh.getBlock(x, y + 1, z) !== B.AIR || !this.canEdit(p, x, z)) return false;
    this.sh.setBlock(idx(x, y, z), hydrated(this.sh.getBlock, x, y, z) ? B.FARMLAND + 1 : B.FARMLAND, p);
    this.wearHeld(p, 1);
    this.sh.broadcastNear(p, { t: "fx", k: "till", x: x + 0.5, y: y + 1, z: z + 0.5 }, 24); // (the tiller heard it already)
    return true;
  }

  /** Bone meal on wheat: two to five stages at once, like the classic game. */
  private boneMealCrop(p: Player, x: number, y: number, z: number, id: number): boolean {
    const s = p.sv;
    if (s.dead || wheatAge(id) >= 7 || !this.canEdit(p, x, z)) return false;
    if (s.gm !== "creative") {
      const st = s.inv.inv[s.sel];
      if (!st || st.id !== I.BONE_MEAL) return false;
      s.inv.inv[s.sel] = st.n > 1 ? { ...st, n: st.n - 1 } : null;
      this.markSlot(p, s.sel);
    }
    const age = Math.min(7, wheatAge(id) + 2 + Math.floor(Math.random() * 4));
    this.sh.setBlock(idx(x, y, z), B.WHEAT + age, p);
    this.sh.broadcastNear(p, { t: "fx", k: "bone_meal", x: x + 0.5, y: y + 0.3, z: z + 0.5 }, 32, true);
    return true;
  }

  /** A slice of cake: 2 hunger, 0.4 saturation; the last slice takes the cake. Only when hungry (creative: any time). */
  private eatCake(p: Player, x: number, y: number, z: number, id: number): boolean {
    const s = p.sv;
    if (s.dead) return false;
    if (s.gm !== "creative" && s.body.food >= MAX_FOOD) return false;
    if (s.gm !== "creative") {
      eat(s.body, 2, 0.4);
      s.statsDirty = true;
    }
    const bites = cakeBites(id) + 1;
    this.sh.setBlock(idx(x, y, z), bites >= 7 ? B.AIR : B.CAKE + bites, p);
    this.sh.broadcastNear(p, { t: "fx", k: "eat", x: x + 0.5, y: y + 0.5, z: z + 0.5 }, 16, true);
    return true;
  }

  /** An empty bucket on a water source: the water is taken up (the rest of it runs off on its own). */
  private scoopWater(p: Player, x: number, y: number, z: number): boolean {
    const s = p.sv;
    if (s.dead || !this.canEdit(p, x, z)) return false;
    this.sh.setBlock(idx(x, y, z), B.AIR, p);
    if (s.gm !== "creative") this.convertHeld(p, I.WATER_BUCKET);
    this.sh.broadcastNear(p, { t: "fx", k: "bucket_fill", x: x + 0.5, y: y + 0.5, z: z + 0.5 }, 24);
    return true;
  }

  /** v7: an empty bucket on a cow: milk (reach and rate are checked by the shard). */
  milkCow(p: Player, a: Animal): void {
    const s = p.sv;
    if (s.dead || a.dying || a.kind !== ANIMAL.COW || this.heldId(p) !== I.BUCKET) return;
    if (s.gm !== "creative") this.convertHeld(p, I.MILK_BUCKET);
    this.sh.broadcastNear(p, { t: "fx", k: "bucket_fill", x: a.x, y: a.y + 1, z: a.z }, 24);
  }

  /** The held item becomes `id` (one of a stack: the new one goes in the inventory, or drops if it is full). */
  private convertHeld(p: Player, id: number): void {
    const s = p.sv;
    const st = s.inv.inv[s.sel];
    if (!st) return;
    if (st.n === 1) {
      s.inv.inv[s.sel] = { id, n: 1, d: 0 };
      this.markSlot(p, s.sel);
      return;
    }
    s.inv.inv[s.sel] = { ...st, n: st.n - 1 };
    this.markSlot(p, s.sel);
    const left = this.give(p, { id, n: 1, d: 0 });
    if (left) this.throwStack(p, { id, n: left, d: 0 });
  }

  // ---------------------------------------------------------------- v7: the bow

  /** The first arrows in the inventory (the hotbar, then the rest), or -1. */
  private findArrow(p: Player): number {
    const inv = p.sv.inv.inv;
    for (let k = 0; k < 36; k++) if (inv[k]?.id === I.ARROW) return k;
    return -1;
  }

  /** Draw ("start") and loose ("release") the bow. The server times the draw itself: an arrow from your eyes the way
   *  you look, its speed from how long you drew (Java's curve: full after a second, then a critical arrow); one
   *  arrow used up (survival) and a point of wear on the bow. */
  private onBow(p: Player, a: string): void {
    const s = p.sv;
    if (s.dead) return;
    if (a === "start") {
      const st = this.held(p);
      if (!st || st.id !== I.BOW || s.eatStart >= 0) return;
      if (this.inSafe(p.x, p.z)) return; // the hub is a safe zone: no arrows there (they would vanish at once)
      if (s.gm !== "creative" && this.findArrow(p) < 0) return;
      s.drawStart = this.sh.tickCount;
      p.sflags |= FLAG.EAT; // using the held item: others see the bow drawn
      p.version++;
      return;
    }
    if (a !== "release") return this.stopDrawing(p);
    if (s.drawStart < 0) return;
    const ticks = this.sh.tickCount - s.drawStart;
    this.stopDrawing(p);
    const st = this.held(p);
    if (!st || st.id !== I.BOW || this.inSafe(p.x, p.z)) return;
    const power = bowPower(ticks);
    if (power < 0.1) return;
    const slot = s.gm === "creative" ? -1 : this.findArrow(p);
    if (s.gm !== "creative") {
      if (slot < 0) return;
      const ar = s.inv.inv[slot]!;
      s.inv.inv[slot] = ar.n > 1 ? { ...ar, n: ar.n - 1 } : null;
      this.markSlot(p, slot);
    }
    const yaw = (p.yaw * Math.PI) / 180;
    const pitch = (p.pitch * Math.PI) / 180;
    let dx = -Math.sin(yaw) * Math.cos(pitch);
    let dy = -Math.sin(pitch);
    let dz = Math.cos(yaw) * Math.cos(pitch);
    // a little spread, like Java's inaccuracy of 1
    const g = () => (Math.random() + Math.random() + Math.random() - 1.5) * 0.0075 * 1.4;
    dx += g();
    dy += g();
    dz += g();
    const l = Math.hypot(dx, dy, dz) || 1;
    const v = power * BOW_SPEED;
    const ey = p.y + (p.flags & FLAG.SNEAK ? SNEAK_EYE_HEIGHT : EYE_HEIGHT) - 0.1;
    this.sh.mobs.shootPlayerArrow(p.id, p.x + (dx / l) * 0.3, ey, p.z + (dz / l) * 0.3, (dx / l) * v, (dy / l) * v, (dz / l) * v, power >= 1, s.gm === "survival");
    this.wearItem(p, 1);
  }

  private stopDrawing(p: Player): void {
    p.sv.drawStart = -1;
    if (p.sflags & FLAG.EAT && p.sv.eatStart < 0) {
      p.sflags &= ~FLAG.EAT;
      p.version++;
    }
  }

  /** Wear on the held item when it is not a tool (the bow): it breaks at its durability. */
  private wearItem(p: Player, n: number): void {
    if (p.sv.gm === "creative") return;
    const s = p.sv;
    const st = s.inv.inv[s.sel];
    if (!st) return;
    const max = maxDurability(st.id);
    if (!max) return;
    if (st.d + n >= max) {
      s.inv.inv[s.sel] = null;
      this.sh.send(p, { t: "fx", k: "tool_break", id: st.id });
      this.sh.broadcastNear(p, { t: "fx", k: "tool_break", id: st.id, x: p.x, y: p.y + 1, z: p.z }, 24);
    } else s.inv.inv[s.sel] = { ...st, d: st.d + n };
    this.markSlot(p, s.sel);
  }

  // ---------------------------------------------------------------- eating

  private onEat(p: Player, a: string): void {
    const s = p.sv;
    if (s.dead) return;
    if (a === "start") {
      const st = this.held(p);
      const def = st ? itemDef(st.id) : undefined;
      const food = def?.food;
      // v7: a drink (milk) goes down at any hunger
      if (def?.drink) {
        s.eatStart = Date.now();
        s.eatItem = st!.id;
        p.sflags |= FLAG.EAT;
        p.version++;
        return;
      }
      if (!food || (s.body.food >= MAX_FOOD && s.gm !== "creative")) return;
      s.eatStart = Date.now();
      s.eatItem = st!.id;
      p.sflags |= FLAG.EAT;
      p.version++;
    } else if (a === "finish") {
      const st = this.held(p);
      if (s.eatStart < 0 || !st || st.id !== s.eatItem) return this.stopEating(p);
      // wall-clock time (the tick loop can run a little slow): at least 75% of the 1.6 s
      if (Date.now() - s.eatStart < EAT_TICKS * 50 * 0.75) return this.stopEating(p);
      const def = itemDef(st.id);
      if (def?.drink) {
        // milk: a queasy stomach settles; the bucket is left
        s.body.queasy = 0;
        s.statsDirty = true;
        if (s.gm !== "creative") {
          s.inv.inv[s.sel] = def.remainder ? { id: def.remainder, n: 1, d: 0 } : null;
          this.markSlot(p, s.sel);
        }
        this.sh.broadcastNear(p, { t: "fx", k: "drink", x: p.x, y: p.y + 1.5, z: p.z }, 16);
        return this.stopEating(p);
      }
      const food = def?.food;
      if (!food) return this.stopEating(p);
      eat(s.body, food.hunger, food.sat);
      if (food.queasy && Math.random() < food.queasy) s.body.queasy = QUEASY_TICKS;
      if (s.gm !== "creative") {
        s.inv.inv[s.sel] = st.n > 1 ? { ...st, n: st.n - 1 } : null;
        this.markSlot(p, s.sel);
      }
      s.statsDirty = true;
      this.sh.broadcastNear(p, { t: "fx", k: "burp", x: p.x, y: p.y + 1.5, z: p.z }, 16, true);
      this.stopEating(p);
    } else this.stopEating(p);
  }

  private stopEating(p: Player): void {
    p.sv.eatStart = -1;
    if (p.sflags & FLAG.EAT) {
      p.sflags &= ~FLAG.EAT;
      p.version++;
    }
  }

  // ---------------------------------------------------------------- health

  /** Damage (falls, drowning, starving; v6: night mobs and arrows). Nothing hurts in creative or in the safe zone.
   *  `armor`: worn armour softens it (and wears); `kb`: knockback velocity for the client to take. */
  damage(p: Player, amount: number, cause: string, fromX?: number, fromZ?: number, opts: { armor?: boolean; kb?: [number, number, number] } = {}): void {
    const s = p.sv;
    if (s.dead || s.gm === "creative" || amount <= 0) return;
    if (this.inSafe(p.x, p.z)) return;
    if (this.sh.tickCount < s.hurtUntil) return;
    if (opts.armor) {
      const a = armorOf(s.inv.armor);
      if (a.points > 0) {
        this.wearArmor(p, amount);
        amount = afterArmor(amount, a.points, a.tough);
      }
      amount = afterProtection(amount, a.prot); // v13
    } else if (cause === "fall") amount = afterProtection(amount, armorOf(s.inv.armor).prot); // v13: like Java, falls too
    s.body.hp = Math.max(0, s.body.hp - amount);
    s.hurtUntil = this.sh.tickCount + HURT_TICKS;
    exhaust(s.body, EXHAUST.damage);
    s.statsDirty = true;
    p.sflags |= FLAG.HURT;
    p.hurtFlagUntil = this.sh.tickCount + 10;
    p.version++;
    const msg: { t: "hurt"; cause: string; dx?: number; dz?: number; kb?: [number, number, number] } = { t: "hurt", cause };
    if (fromX !== undefined && fromZ !== undefined) {
      msg.dx = +(fromX - p.x).toFixed(2);
      msg.dz = +(fromZ - p.z).toFixed(2);
    }
    if (opts.kb) msg.kb = opts.kb.map((v) => +v.toFixed(3)) as [number, number, number];
    this.sh.send(p, msg);
    if (s.sleeping) this.wake(p);
    if (s.body.hp <= 0) this.die(p, cause);
  }

  /** Every worn piece wears from a hit it softened; a piece that runs out breaks. */
  private wearArmor(p: Player, damage: number): void {
    const s = p.sv;
    const n = armorWear(damage);
    let broke = false;
    s.inv.armor.forEach((st, k) => {
      const a = st ? itemDef(st.id)?.armor : undefined;
      if (!st || !a) return;
      const d = st.d + n;
      if (d >= a.durability) {
        s.inv.armor[k] = null;
        broke = true;
        this.sh.send(p, { t: "fx", k: "tool_break", id: st.id });
        this.sh.broadcastNear(p, { t: "fx", k: "tool_break", id: st.id, x: p.x, y: p.y + 1, z: p.z }, 24);
      } else s.inv.armor[k] = { ...st, d };
      s.dirty.add(36 + k);
    });
    if (broke) this.updateArmor(p, false);
  }

  die(p: Player, cause: string): void {
    const s = p.sv;
    if (s.dead) return;
    if (p.riding) this.sh.dismount(p); // v8: out of the boat first
    this.closeWindow(p, true);
    this.closePlayerGrid(p);
    if (s.sleeping) this.wake(p);
    this.stopEating(p);
    this.stopDrawing(p);
    s.dead = true;
    s.body.hp = 0;
    s.statsDirty = true;
    // everything you carried drops where you fell
    const all = [...s.inv.inv, ...s.inv.armor, ...s.inv.craft, s.cursor.s];
    for (const st of all) {
      if (!st) continue;
      const a = Math.random() * Math.PI * 2;
      const v = Math.random() * 0.25;
      this.sh.items.spawn(st, p.x, p.y + 0.6, p.z, Math.cos(a) * v, 0.2, Math.sin(a) * v, THROW_DELAY);
    }
    s.inv.inv.fill(null);
    s.inv.armor.fill(null);
    s.inv.craft.fill(null);
    s.cursor.s = null;
    this.sendInventory(p);
    this.updateArmor(p, false);
    p.sflags = (p.sflags | FLAG.DEAD) & ~FLAG.EAT;
    p.version++;
    const msg = deathMessage(p.name, cause);
    if (p.agent) this.sh.agentDied(p, msg);
    this.sh.send(p, { t: "dead", msg });
    this.sh.system(msg);
  }

  // ---------------------------------------------------------------- clankersmp crafting

  /** An AI's crafting: a recipe made `times` times straight from its inventory, with the same recipes and the same
   *  rule as the windows (3x3 recipes need a crafting table within reach). Returns how many were made. */
  craft(p: Player, rid: string, times: number): number {
    const s = p.sv;
    if (s.dead || s.win) return 0;
    const r = RECIPES.find((x) => x.id === rid);
    if (!r) return 0;
    const [w, h] = recipeSize(r);
    if ((w > 2 || h > 2) && !this.tableNear(p)) {
      this.sh.notice(p, "That needs a crafting table within reach.");
      return 0;
    }
    let made = 0;
    for (; made < times; made++) {
      const have = new Map<number, number>();
      for (const st of s.inv.inv) if (st) have.set(st.id, (have.get(st.id) ?? 0) + st.n);
      if (!canMake(r, have)) break;
      for (const id of layoutFor(r, 3, have) ?? []) if (id) this.takeOne(p, id);
      const left = this.give(p, { ...r.out });
      if (left > 0) this.throwStack(p, { ...r.out, n: left });
    }
    return made;
  }

  /** An AI puts on the best armour it carries: each piece better than what it wears in that slot goes on, and the
   *  old one goes back into the inventory. */
  wearBest(p: Player): number {
    const s = p.sv;
    if (s.dead || s.win) return 0;
    let n = 0;
    for (let k = 0; k < 36; k++) {
      const st = s.inv.inv[k];
      const a = st ? itemDef(st.id)?.armor : undefined;
      if (!st || !a) continue;
      const cur = s.inv.armor[a.slot];
      if (cur && armorValue(cur.id) >= armorValue(st.id)) continue; // v13: Protection counts too
      s.inv.armor[a.slot] = st;
      s.inv.inv[k] = cur ?? null;
      this.markSlot(p, k);
      this.markSlot(p, 36 + a.slot);
      n++;
    }
    if (n) this.updateArmor(p, true);
    return n;
  }

  /** An AI takes an item in hand: selected if it is on the hotbar, else swapped into the selected slot. */
  hold(p: Player, id: number): boolean {
    const s = p.sv;
    if (s.dead || s.win) return false;
    const inv = s.inv.inv;
    const k = inv.findIndex((st, i) => i < 9 && st?.id === id);
    if (k >= 0) {
      if (k !== s.sel) this.onMessage(p, { t: "sel", s: k });
      return true;
    }
    const from = inv.findIndex((st) => st?.id === id);
    if (from < 0) return false;
    [inv[s.sel], inv[from]] = [inv[from], inv[s.sel]];
    this.markSlot(p, from);
    this.markSlot(p, s.sel);
    return true;
  }

  /** An AI hits another AI (reach and rate are checked by the shard): the same swing as on a mob, with knockback. */
  hitPlayer(p: Player, q: Player): void {
    if (p.sv.dead || q.sv.dead) return;
    const k = this.strike(p);
    const hp = q.sv.body.hp;
    const len = Math.hypot(q.x - p.x, q.z - p.z) || 1;
    this.damage(q, k.dmg, "player:" + p.name, p.x, p.z, { armor: true, kb: [((q.x - p.x) / len) * k.kb, 0.36, ((q.z - p.z) / len) * k.kb] });
    this.sh.send(p, { t: "struck", id: q.id, mob: false, dmg: +(hp - q.sv.body.hp).toFixed(2), crit: k.crit, kills: q.sv.dead });
    if (k.crit) this.sh.broadcastNear(p, { t: "fx", k: "crit", x: q.x, y: q.y + 1.1, z: q.z }, 32);
    this.afterStrike(p);
  }

  /** An AI's smelting: n of an item in a furnace within reach, the fuel taken from its inventory up front (coal
   *  first). The results come out when a real furnace would be done with them (10 s each): into its inventory, or
   *  onto the furnace if it has gone or died meanwhile. */
  smelt(p: Player, id: number, n: number): { n: number; ms: number; why?: string } {
    const s = p.sv;
    const out = SMELT[id];
    if (s.dead || s.win) return { n: 0, ms: 0, why: "busy" };
    if (!out) return { n: 0, ms: 0, why: "that doesn't smelt" };
    const furnace = this.blockNear(p, isFurnace);
    if (!furnace) return { n: 0, ms: 0, why: "no furnace within reach" };
    const inv = s.inv.inv;
    const count = (want: number) => inv.reduce((a, st) => a + (st && st.id === want ? st.n : 0), 0);
    n = Math.min(n, count(id));
    if (!n) return { n: 0, ms: 0, why: "none to smelt" };
    // fuel: whole items, the longest burning first, enough for the whole batch (fewer items if it runs short)
    const fuels = [...new Set(inv.filter((st): st is Stack => !!st && st.id !== id && fuelTicks(st.id) > 0).map((st) => st.id))].sort((a, b) => fuelTicks(b) - fuelTicks(a));
    let burn = 0;
    const take: number[] = [];
    for (const f of fuels) for (let k = count(f); k > 0 && burn < n * SMELT_TICKS; k--) {
      take.push(f);
      burn += fuelTicks(f);
    }
    n = Math.min(n, Math.floor(burn / SMELT_TICKS));
    if (!n) return { n: 0, ms: 0, why: "no fuel (coal, charcoal, planks or logs)" };
    for (let k = 0, used = 0; k < take.length && used < n * SMELT_TICKS; k++) {
      this.takeOne(p, take[k]);
      used += fuelTicks(take[k]);
    }
    for (let k = 0; k < n; k++) this.takeOne(p, id);
    const ms = n * SMELT_TICKS * 50;
    const [fx, fy, fz] = furnace;
    setTimeout(() => {
      const st = { id: out, n, d: 0 };
      if (this.sh.players.get(p.id) === p && !p.sv.dead) {
        const left = this.give(p, st);
        if (left > 0) this.sh.items.spawn({ ...st, n: left }, fx + 0.5, fy + 1.1, fz + 0.5, 0, 0.2, 0);
      } else this.sh.items.spawn(st, fx + 0.5, fy + 1.1, fz + 0.5, 0, 0.2, 0);
    }, ms);
    return { n, ms };
  }

  /** v13: enchant what this player holds at an enchanting table within reach (`at`: the one clicked): level `want`, or
   *  the best the bookshelves round the table allow and its rubies pay for. The rubies go, the held item becomes its
   *  enchanted self (keeping its wear), and everyone near sees the table's glyphs. */
  enchant(p: Player, want: number, at?: [number, number, number], armorSlot = -1): EnchantPlan {
    const s = p.sv;
    if (s.dead || s.win) return { id: 0, level: 0, cost: 0, kind: null, why: "busy" };
    const table = at ?? this.blockNear(p, (id) => id === B.ENCHANTING_TABLE);
    if (!table) return { id: 0, level: 0, cost: 0, kind: null, why: "no enchanting table within reach" };
    // what it holds, or (an agent, which has no screen to take armour off with) a piece it wears
    const worn = armorSlot >= 0 && armorSlot < 4;
    const st = worn ? s.inv.armor[armorSlot] : this.held(p);
    if (!st) return { id: 0, level: 0, cost: 0, kind: null, why: worn ? "nothing worn there" : "nothing in hand to enchant" };
    const rubies = s.inv.inv.reduce((n, x) => n + (x && x.id === I.RUBY && x.d === 0 ? x.n : 0), 0);
    const plan = planEnchant(st.id, s.gm === "creative" ? 99 : rubies, shelvesAround(this.sh.getBlock, table[0], table[1], table[2]), Math.max(0, Math.floor(want) || 0));
    if (!plan.id) return plan;
    if (s.gm !== "creative") for (let k = 0; k < plan.cost; k++) this.takeOne(p, I.RUBY);
    if (worn) {
      s.inv.armor[armorSlot] = { id: plan.id, n: 1, d: st.d };
      s.dirty.add(36 + armorSlot);
    } else {
      s.inv.inv[s.sel] = { id: plan.id, n: 1, d: st.d };
      this.markSlot(p, s.sel);
    }
    this.sh.broadcastNearPoint(table[0] + 0.5, table[2] + 0.5, { t: "fx", k: "enchant", id: plan.level, x: table[0] + 0.5, y: table[1] + 1.1, z: table[2] + 0.5 }, 32);
    return plan;
  }

  /** Agents: take everything from the chest (or barrel) within reach. No window: an agent has no screen. */
  agentLoot(p: Player): { got: [number, number][]; why?: string } {
    const s = p.sv;
    if (s.dead || s.win) return { got: [], why: "busy" };
    const c = this.blockNear(p, isStorage);
    if (!c) return { got: [], why: "no chest within reach" };
    const cell = idx(c[0], c[1], c[2]);
    const items = this.sh.containers.chest(cell);
    const got: [number, number][] = [];
    for (let k = 0; k < items.length; k++) {
      const st = items[k];
      if (!st) continue;
      const left = this.give(p, { ...st });
      if (st.n - left > 0) got.push([st.id, st.n - left]);
      items[k] = left > 0 ? { ...st, n: left } : null;
    }
    if (got.length) {
      this.sh.containers.onChange(cell, true);
      this.sh.containers.save();
      this.updateHeld(p);
    }
    return { got, why: got.length ? undefined : items.some(Boolean) ? "no room in your inventory" : "the chest is empty" };
  }

  /** Agents: the nearest villager within `r` blocks, where it stands and what it trades. */
  agentTrades(p: Player, r = 24, job = -1): { vid: number; name: string; job: number; x: number; y: number; z: number; offers: ReturnType<Shard["villagers"]["offers"]> } | null {
    let best: Villager | null = null;
    let bd = r;
    for (const v of this.sh.villagers.villagers.values()) {
      if (job >= 0 && v.job !== job) continue; // v13: a villager of that trade (the smith sells lava)
      const d = Math.hypot(v.x - p.x, v.z - p.z);
      if (d < bd && Math.abs(v.y - p.y) < 8) [bd, best] = [d, v];
    }
    if (!best) return null;
    return { vid: best.id, name: best.def.name, job: best.job, x: +best.x.toFixed(1), y: +best.y.toFixed(1), z: +best.z.toFixed(1), offers: this.sh.villagers.offers(best) };
  }

  /** Agents: offer `o` of villager `vid`, up to `times` times, standing next to it. */
  agentTrade(p: Player, vid: number, o: number, times: number): { n: number; why?: string } {
    const s = p.sv;
    if (s.dead || s.win) return { n: 0, why: "busy" };
    const v = this.sh.villager(vid);
    if (!v) return { n: 0, why: "that villager is gone" };
    if (Math.hypot(v.x - p.x, v.y - p.y, v.z - p.z) > TALK_REACH_SERVER + 1.5) return { n: 0, why: "too far from the villager" };
    const before = s.inv.inv.slice();
    let n = 0;
    for (let k = 0; k < times; k++) {
      if (!this.sh.villagers.trade(v, o, s.inv.inv, false)) break;
      n++;
    }
    for (let k = 0; k < 36; k++) if (s.inv.inv[k] !== before[k]) this.markSlot(p, k);
    if (n) {
      this.updateHeld(p);
      this.pushOffers(v);
      this.sh.villagers.startTalk(v, p.id, p.x, p.z);
    }
    this.sh.broadcastNearPoint(v.x, v.z, { t: "fx", k: n ? "trade" : "trade_no", id: v.id, x: +v.x.toFixed(2), y: +(v.y + 1.4).toFixed(2), z: +v.z.toFixed(2) }, 16);
    const off = TRADES[v.job]?.[o];
    return { n, why: n ? undefined : !off ? "no such offer" : v.stock[o] <= 0 ? "sold out" : "you can't pay for it (or have no room)" };
  }

  /** The nearest block within reach of the eyes that passes `test`. */
  private blockNear(p: Player, test: (id: number) => boolean): [number, number, number] | null {
    const ex = p.x;
    const ey = p.y + EYE_HEIGHT;
    const ez = p.z;
    for (let y = Math.floor(ey) - 5; y <= Math.floor(ey) + 5; y++)
      for (let z = Math.floor(ez) - 5; z <= Math.floor(ez) + 5; z++)
        for (let x = Math.floor(ex) - 5; x <= Math.floor(ex) + 5; x++) {
          if (!inWorld(x, y, z) || !test(this.sh.getBlock(x, y, z))) continue;
          if ((x + 0.5 - ex) ** 2 + (y + 0.5 - ey) ** 2 + (z + 0.5 - ez) ** 2 <= 5 * 5) return [x, y, z];
        }
    return null;
  }

  private takeOne(p: Player, id: number): void {
    const inv = p.sv.inv.inv;
    for (let k = 35; k >= 0; k--) {
      const st = inv[k];
      if (!st || st.id !== id) continue;
      inv[k] = st.n > 1 ? { ...st, n: st.n - 1 } : null;
      this.markSlot(p, k);
      return;
    }
  }

  private tableNear(p: Player): boolean {
    const ex = p.x;
    const ey = p.y + EYE_HEIGHT;
    const ez = p.z;
    for (let y = Math.floor(ey) - 5; y <= Math.floor(ey) + 5; y++)
      for (let z = Math.floor(ez) - 5; z <= Math.floor(ez) + 5; z++)
        for (let x = Math.floor(ex) - 5; x <= Math.floor(ex) + 5; x++) {
          if (!inWorld(x, y, z) || this.sh.getBlock(x, y, z) !== B.CRAFTING_TABLE) continue;
          if ((x + 0.5 - ex) ** 2 + (y + 0.5 - ey) ** 2 + (z + 0.5 - ez) ** 2 <= 5 * 5) return true;
        }
    return false;
  }

  /** Where a player comes back: next to their bed if it's still there and there's room, else the hub. */
  private respawnPoint(p: Player): { x: number; y: number; z: number; yaw: number; bed: boolean } {
    const s = p.sv;
    if (s.bed) {
      const [bx, by, bz] = s.bed;
      if (inWorld(bx, by, bz) && isBed(this.sh.getBlock(bx, by, bz))) {
        for (const [dx, dz] of [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1], [-2, 0], [2, 0], [0, -2], [0, 2]]) {
          const x = bx + dx;
          const z = bz + dz;
          for (const y of [by, by + 1, by - 1]) {
            if (!inWorld(x, y, z) || !inWorld(x, y + 1, z)) continue;
            const below = this.sh.getBlock(x, y - 1, z);
            if (!SOLID[below] || SOLID[this.sh.getBlock(x, y, z)] || SOLID[this.sh.getBlock(x, y + 1, z)]) continue;
            if (IS_WATER[this.sh.getBlock(x, y, z)]) continue;
            return { x: x + 0.5, y, z: z + 0.5, yaw: 0, bed: true };
          }
        }
      }
    }
    const sp = this.sh.info.spawn;
    return { x: sp.x, y: sp.y, z: sp.z, yaw: 180, bed: false };
  }

  private respawn(p: Player): void {
    const s = p.sv;
    if (!s.dead) return;
    const at = this.respawnPoint(p);
    if (s.bed && !at.bed) {
      this.sh.notice(p, "Your bed was missing or blocked, so you're back at spawn.");
      s.bed = null;
    }
    s.dead = false;
    s.body = newBody();
    s.statsDirty = true;
    s.fall.reset();
    p.sflags &= ~(FLAG.DEAD | FLAG.HURT);
    this.sh.teleport(p, at.x, at.y, at.z);
    p.yaw = at.yaw;
    p.version++;
    this.sh.send(p, { t: "respawned", x: at.x, y: at.y, z: at.z, yaw: at.yaw });
  }

  // ---------------------------------------------------------------- beds and the night

  private isNight(): boolean {
    const t = this.sh.worldTime();
    return t >= NIGHT_START && t <= NIGHT_END;
  }

  private useBed(p: Player, x: number, y: number, z: number, id: number): void {
    const s = p.sv;
    if (s.dead) return;
    // the bed's foot is its "home" cell
    const st = bedState(id);
    let fx = x;
    let fz = z;
    if (st.head) {
      const pc = partnerCell(id, x, y, z);
      if (pc) [fx, , fz] = pc;
    }
    const was = s.bed;
    s.bed = [fx, y, fz];
    if (!was || was[0] !== fx || was[1] !== y || was[2] !== fz) this.sh.notice(p, "Respawn point set.");
    if (!this.isNight()) {
      this.sh.notice(p, "You can only sleep at night (your respawn point is set).");
      return;
    }
    if (this.sh.mobs.hostileNear(x + 0.5, y, z + 0.5, 8, 5)) {
      this.sh.notice(p, "You can't sleep now: there are monsters nearby.");
      return;
    }
    if (s.sleeping) return;
    s.sleeping = true;
    s.sleepSince = this.sh.tickCount;
    p.sflags |= FLAG.SLEEP;
    this.sh.teleport(p, x + 0.5, y + 0.5625, z + 0.5);
    p.version++;
    this.sleepChanged();
  }

  wake(p: Player): void {
    const s = p.sv;
    if (!s.sleeping) return;
    s.sleeping = false;
    p.sflags &= ~FLAG.SLEEP;
    p.version++;
    // stand up next to the bed
    const at = this.respawnPoint(p);
    if (at.bed) this.sh.teleport(p, at.x, at.y, at.z);
    this.sleepChanged();
  }

  private sleepChanged(): void {
    let sleeping = 0;
    let awake = 0;
    for (const q of this.sh.players.values()) {
      if (q.sv.dead) continue;
      if (q.sv.sleeping) sleeping++;
      else awake++;
    }
    const needed = Math.ceil((sleeping + awake) / 2);
    this.sleepers = sleeping;
    for (const q of this.sh.players.values()) this.sh.send(q, { t: "sleep", on: sleeping > 0, sleeping, needed, you: q.sv.sleeping });
  }

  /** Every second: enough sleepers for long enough skips to morning; daylight wakes everyone. */
  private sleepTick(): void {
    if (!this.sleepers) return;
    const list = [...this.sh.players.values()].filter((q) => !q.sv.dead);
    const sleeping = list.filter((q) => q.sv.sleeping);
    if (!this.isNight()) {
      for (const q of sleeping) this.wake(q);
      return;
    }
    const needed = Math.ceil(list.length / 2);
    if (sleeping.length >= needed && sleeping.every((q) => this.sh.tickCount - q.sv.sleepSince >= 100)) {
      this.sh.skipToMorning();
      for (const q of sleeping) this.wake(q);
      this.sh.system("The night was skipped. Good morning!");
    }
  }

  // ---------------------------------------------------------------- movement

  /** After a valid move: hunger from moving, falls, waking up if they walk off. */
  onMoved(p: Player, px: number, py: number, pz: number): void {
    const s = p.sv;
    if (s.dead) return;
    s.dy = p.y - py;
    if (s.sleeping && Math.hypot(p.x - px, p.z - pz) > 0.3) this.wake(p);
    const horiz = Math.hypot(p.x - px, p.z - pz);
    if (p.flags & FLAG.SPRINT) exhaust(s.body, EXHAUST.sprintPerBlock * horiz);
    else if (p.flags & FLAG.WATER) exhaust(s.body, EXHAUST.swimPerBlock * horiz);
    const grounded = groundedAlong(this.sh.getBlock, p.x, p.y, p.z, px, pz);
    if (s.wasGrounded && p.y - py > 0.33 && !(p.flags & FLAG.WATER)) exhaust(s.body, p.flags & FLAG.SPRINT ? EXHAUST.sprintJump : EXHAUST.jump);
    // falls: the highest point since the last time on the ground, against where they land
    const fx = Math.floor(p.x);
    const fz = Math.floor(p.z);
    const feet = this.sh.getBlock(fx, Math.floor(p.y), fz);
    const head = this.sh.getBlock(fx, Math.floor(p.y + 1), fz);
    const soft = IS_WATER[feet] || IS_WATER[head] || CLIMB[feet] || CLIMB[head] || s.sleeping || s.gm === "creative";
    let d = s.fall.update(p.y, py, grounded, !!soft, (p.flags & FLAG.GROUND) !== 0);
    // v8: a hay bale takes most of a fall (a fifth of the damage, like the classic one)
    if (d > 0 && this.sh.getBlock(fx, Math.floor(p.y - 0.01), fz) === B.HAY_BALE) d = Math.ceil(Math.max(0, s.fall.landed - SAFE_FALL) * 0.2);
    if (d > 0) this.damage(p, d, "fall");
    // v7: landing on farmland from more than half a block can trample it back to dirt (the higher, the likelier)
    if (s.fall.landed > 0.5) {
      const by = Math.floor(p.y - 0.01);
      if (isFarmland(this.sh.getBlock(fx, by, fz)) && Math.random() < s.fall.landed - 0.5) this.sh.farm.toDirt(fx, by, fz);
    }
    s.wasGrounded = grounded;
  }

  // ---------------------------------------------------------------- tick

  tick(): void {
    const t = this.sh.tickCount;
    for (const p of this.sh.players.values()) {
      const s = p.sv;
      if (p.hurtFlagUntil && t >= p.hurtFlagUntil) {
        p.hurtFlagUntil = 0;
        p.sflags &= ~FLAG.HURT;
        p.version++;
      }
      if (!s.dead && s.gm === "survival") {
        const safe = this.inSafe(p.x, p.z);
        const f = tickFood(s.body, safe);
        if (f.changed) s.statsDirty = true;
        if (f.starve) this.damage(p, f.starve, "starve");
        const under = this.headInWater(p);
        const airBefore = s.body.air;
        const drown = tickAir(s.body, under);
        if (s.body.air !== airBefore && (s.body.air % 10 === 0 || s.body.air >= MAX_AIR || s.body.air <= 0)) s.statsDirty = true;
        if (drown) this.damage(p, drown, "drown");
        if (p.y < -10) this.damage(p, 4, "void");
      }
      // windows: walk away from a container (or it goes away) and it closes
      if (s.win && s.win.kind === "trade" && t % 10 === 0) {
        const v = s.win.vid !== undefined ? this.sh.villager(s.win.vid) : undefined;
        if (!v || (v.x - p.x) ** 2 + (v.y - p.y) ** 2 + (v.z - p.z) ** 2 > (TALK_REACH_SERVER + 2) ** 2) this.closeWindow(p, true);
      } else if (s.win && t % 10 === 0) {
        const c = s.win.cell;
        const id = this.sh.world[c];
        const ok = s.win.kind === "crafting" ? id === B.CRAFTING_TABLE : s.win.kind === "furnace" ? isFurnace(id) : isStorage(id);
        const dx = cellX(c) + 0.5 - p.x;
        const dy = cellY(c) + 0.5 - p.y - 1;
        const dz = cellZ(c) + 0.5 - p.z;
        if (!ok || dx * dx + dy * dy + dz * dz > 8 * 8) this.closeWindow(p, true);
      }
      if (s.statsDirty) {
        const st = this.stats(p);
        const key = `${st.hp},${st.food},${st.sat},${st.air},${st.queasy ? 1 : 0}`;
        if (key !== s.lastStats) {
          s.lastStats = key;
          this.sh.send(p, { t: "stats", s: st });
        }
        s.statsDirty = false;
      }
      if (s.dirty.size) {
        const list: [number, WireStack][] = [];
        for (const k of s.dirty) list.push([k, toWire(k >= 36 ? s.inv.armor[k - 36] : s.inv.inv[k])]);
        s.dirty.clear();
        this.sh.send(p, { t: "slots", list });
      }
    }
    this.sh.containers.tick((cell, lit) => {
      const id = this.sh.world[cell];
      if (isFurnace(id)) this.sh.setBlock(cell, litFurnace(id, lit), null, true);
    });
    if (t % 20 === 0) this.sleepTick();
  }

  /** Every item that exists for this shard's online players (anti-dupe tests). */
  playerTotals(): Map<string, number> {
    const m = new Map<string, number>();
    for (const p of this.sh.players.values()) {
      for (const st of [...p.sv.inv.inv, ...p.sv.inv.armor, ...p.sv.inv.craft, p.sv.cursor.s, ...(p.sv.win?.kind === "crafting" ? p.sv.win.menu.contents().slice(1, 10) : [])]) {
        if (!st) continue;
        const k = `${st.id}:${st.d}`;
        m.set(k, (m.get(k) ?? 0) + st.n);
      }
    }
    return m;
  }

  /** A world reset: everyone's survival state starts over. */
  reset(): void {
    for (const p of this.sh.players.values()) {
      this.closeWindow(p, true);
      const gm = p.sv.gm;
      Object.assign(p.sv, newSurvival(), { gm });
      this.sendInventory(p);
      this.updateArmor(p, false);
      p.sv.statsDirty = true;
    }
    this.viewers.clear();
  }

  /** World size guard for drops thrown at the border. */
  static clampXZ(v: number): number {
    return Math.max(0.3, Math.min(WORLD_SIZE - 0.3, v));
  }
}
