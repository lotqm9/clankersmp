// Combat (protocol v6): Java Edition 1.9+ rules on Normal difficulty, used by the server (the authority), by the
// client for the attack indicator, and by the tests.
//   - the attack cooldown: every item has an attack speed (an empty hand 4 a second, swords 1.6, axes 0.8-1);
//     strength = clamp((ticks since your last swing + 0.5) / (20 / speed)), and a hit does damage x (0.2 + 0.8 x
//     strength^2): spamming does little, a charged swing does it all
//   - a critical hit (x1.5) needs a charged swing (strength over 0.9) while falling: in the air, going down, not on
//     a ladder, not in water, not sprinting
//   - knockback: 0.4 away from the attacker and a little up; a charged sprinting hit knocks harder (+0.5)
//   - armour: points and toughness take damage off: d x (1 - min(20, max(points / 5, points - d / (2 + tough / 4)))
//     / 25); every piece worn wears by max(1, floor(d / 4)) per hit it softens
//   - after taking damage, 10 ticks (half a second) where only a harder hit gets through (for the difference)

import { HAND_DAMAGE, HAND_SPEED, itemDef, type Stack } from "./items.ts";

export const INVULNERABLE_TICKS = 10;

/** Attacks per second with this item in hand at full strength. */
export function attackSpeedOf(id: number): number {
  return itemDef(id)?.tool?.attackSpeed ?? HAND_SPEED;
}

/** Full-strength attack damage (half hearts) with this item in hand. */
export function attackDamageOf(id: number): number {
  return itemDef(id)?.tool?.damage ?? HAND_DAMAGE;
}

/** Ticks for a full charge with this item. */
export const cooldownTicks = (id: number) => 20 / attackSpeedOf(id);

/** How charged a swing is (0..1), `ticks` after the previous swing. */
export function attackStrength(ticks: number, id: number): number {
  return Math.max(0, Math.min(1, (ticks + 0.5) / cooldownTicks(id)));
}

export interface CritState {
  falling: boolean; // in the air and moving down (a fall in progress)
  onGround: boolean;
  climbing: boolean;
  inWater: boolean;
  sprinting: boolean;
}

/** A charged swing while falling is a critical hit. */
export function isCrit(strength: number, s: CritState): boolean {
  return strength > 0.9 && s.falling && !s.onGround && !s.climbing && !s.inWater && !s.sprinting;
}

/** The damage of a swing (half hearts, fractional like Java). */
export function swingDamage(id: number, strength: number, crit: boolean): number {
  return attackDamageOf(id) * (0.2 + strength * strength * 0.8) * (crit ? 1.5 : 1);
}

export const KNOCKBACK = 0.4;
export const SPRINT_KNOCKBACK = 0.5;

/** Armour points and toughness of what is worn (4 slots: head, chest, legs, feet). */
export function armorOf(armor: (Stack | null)[]): { points: number; tough: number } {
  let points = 0;
  let tough = 0;
  for (const st of armor) {
    const a = st ? itemDef(st.id)?.armor : undefined;
    if (!a) continue;
    points += a.points;
    tough += a.tough;
  }
  return { points, tough };
}

/** Damage left after armour (Java's formula). */
export function afterArmor(damage: number, points: number, tough: number): number {
  if (points <= 0 || damage <= 0) return damage;
  const f = Math.min(20, Math.max(points / 5, points - damage / (2 + tough / 4)));
  return damage * (1 - f / 25);
}

/** How much each worn armour piece wears from one hit of `damage` (before armour). */
export const armorWear = (damage: number) => Math.max(1, Math.floor(damage / 4));

/** Packs what someone wears into one number for the other players (4 bits per slot: 0 none, 1 + material). */
export function packArmor(armor: (Stack | null)[]): number {
  let v = 0;
  armor.forEach((st, slot) => {
    const a = st ? itemDef(st.id)?.armor : undefined;
    if (a && a.slot === slot) v |= (a.material + 1) << (slot * 4);
  });
  return v;
}

/** The material (0 leather, 1 iron, 2 diamond) worn in a slot, or -1. */
export const wornMaterial = (packed: number, slot: number) => ((packed >> (slot * 4)) & 15) - 1;

/** v7: the bow's power from how long it was drawn (ticks): Java's curve, full after 20 ticks (a second). Under 0.1
 *  nothing is shot. */
export function bowPower(ticks: number): number {
  const f = Math.max(0, ticks) / 20;
  return Math.min(1, (f * f + f * 2) / 3);
}
/** Arrow speed (blocks a tick) at full power. */
export const BOW_SPEED = 3;
