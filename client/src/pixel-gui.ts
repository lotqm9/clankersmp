// The in-game GUI's pixel art (update 7.2): the classic grey bevelled panels, recessed slots, arrows, the furnace
// flame, the hotbar and its selection box, tooltips and item counts, all drawn here in code at 1 GUI pixel per canvas
// pixel and scaled up crisply by the GUI scale (var(--s): 2, 3 or 4 screen pixels per GUI pixel). Layouts follow the
// classic screens' geometry (176 x 166 panels, 18-pixel slots). Our own drawings and colours; no game textures.

import { FONT_HEIGHT, drawText, textWidth } from "./pixel-font.ts";

export const C = {
  panel: "#c6c6c6",
  light: "#ffffff",
  shadow: "#555555",
  outline: "#000000",
  slotDark: "#373737",
  slotFill: "#8b8b8b",
  slotLight: "#ffffff",
  label: "#404040",
  arrow: "#8b8b8b",
  white: "#ffffff",
  textShadow: "#3f3f3f",
};

// ---------------------------------------------------------------- the GUI scale

/** The GUI scale: whole DEVICE pixels per GUI pixel (`dev`), and the same in CSS pixels (`s`, = var(--s)). */
export const GUI = { s: 3, dev: 3, dpr: 1 };

/** Like the classic automatic GUI scale: as many pixels per GUI pixel as leave a 320 x 240 GUI (2 to 4 CSS px),
 *  rounded to WHOLE device pixels so the pixel art stays crisp on 125% and 150% displays, and smaller again if the
 *  hotbar with its selection box (184 GUI pixels) or the biggest window (176 x 168) wouldn't fit, as on small
 *  phones. */
export function updateGuiScale(): void {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const dpr = window.devicePixelRatio || 1;
  const css = Math.max(2, Math.min(4, Math.floor(Math.min(w / 320, h / 240))));
  let dev = Math.max(1, Math.round(css * dpr));
  while (dev > 1 && (184 * dev > w * dpr || 176 * dev > (w - 8) * dpr || 168 * dev > (h - 8) * dpr)) dev--;
  GUI.dev = dev;
  GUI.dpr = dpr;
  GUI.s = dev / dpr;
  document.documentElement.style.setProperty("--s", `${GUI.s}px`);
}

/** A CSS pixel position rounded to the device pixel grid (for things that follow the mouse). */
export const snapPx = (v: number) => Math.round(v * GUI.dpr) / GUI.dpr;

type Ctx = CanvasRenderingContext2D;
const rect = (g: Ctx, x: number, y: number, w: number, h: number, c: string) => {
  if (w <= 0 || h <= 0) return;
  g.fillStyle = c;
  g.fillRect(x, y, w, h);
};
const px = (g: Ctx, x: number, y: number, c: string) => rect(g, x, y, 1, 1, c);

export function canvas(w: number, h: number): [HTMLCanvasElement, Ctx] {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d")!;
  g.imageSmoothingEnabled = false;
  return [c, g];
}

/** The raised panel: black outline with clipped corners, a 2-pixel light edge top-left, a dark edge bottom-right. */
export function drawPanel(g: Ctx, x: number, y: number, w: number, h: number, fill = C.panel): void {
  rect(g, x + 1, y + 1, w - 2, h - 2, fill);
  rect(g, x + 2, y, w - 4, 1, C.outline);
  rect(g, x + 2, y + h - 1, w - 4, 1, C.outline);
  rect(g, x, y + 2, 1, h - 4, C.outline);
  rect(g, x + w - 1, y + 2, 1, h - 4, C.outline);
  px(g, x + 1, y + 1, C.outline);
  px(g, x + w - 2, y + 1, C.outline);
  px(g, x + 1, y + h - 2, C.outline);
  px(g, x + w - 2, y + h - 2, C.outline);
  rect(g, x + 2, y + 1, w - 5, 1, C.light);
  rect(g, x + 1, y + 2, w - 4, 1, C.light);
  rect(g, x + 1, y + 3, 2, h - 6, C.light);
  rect(g, x + 3, y + h - 2, w - 5, 1, C.shadow);
  rect(g, x + 3, y + h - 3, w - 4, 1, C.shadow);
  rect(g, x + w - 3, y + 3, 2, h - 6, C.shadow);
  px(g, x + w - 3, y + 2, fill);
  px(g, x + 2, y + h - 3, fill);
}

/** A recessed slot frame of size w x h (18 for a slot, 26 for a big result slot): dark top-left, light bottom-right. */
export function drawSlot(g: Ctx, x: number, y: number, w = 18, h = 18, fill = C.slotFill): void {
  rect(g, x, y, w - 1, 1, C.slotDark);
  rect(g, x, y, 1, h - 1, C.slotDark);
  rect(g, x + 1, y + h - 1, w - 1, 1, C.slotLight);
  rect(g, x + w - 1, y + 1, 1, h - 1, C.slotLight);
  rect(g, x + 1, y + 1, w - 2, h - 2, fill);
  px(g, x + w - 1, y, C.slotFill);
  px(g, x, y + h - 1, C.slotFill);
}

/** A raised button (recipe book, tabs): like the panel but 1 pixel bevels. `down` draws it pressed. */
export function drawButton(g: Ctx, x: number, y: number, w: number, h: number, fill: string, down = false): void {
  rect(g, x, y, w, h, C.outline);
  rect(g, x + 1, y + 1, w - 2, h - 2, fill);
  rect(g, x + 1, y + 1, w - 3, 1, down ? C.shadow : C.light);
  rect(g, x + 1, y + 1, 1, h - 3, down ? C.shadow : C.light);
  rect(g, x + 2, y + h - 2, w - 3, 1, down ? C.light : C.shadow);
  rect(g, x + w - 2, y + 2, 1, h - 3, down ? C.light : C.shadow);
}

/** The crafting arrow (22 x 15), or the furnace's (24 x 17). */
export function drawArrow(g: Ctx, x: number, y: number, w: number, h: number, c: string): void {
  const mid = Math.floor(h / 2);
  const shaft = Math.max(2, Math.round(h / 3));
  const headW = Math.ceil(h / 2) + 1;
  rect(g, x, y + mid - Math.floor(shaft / 2), w - headW, shaft, c);
  for (let i = 0; i < headW; i++) {
    const half = mid - Math.round((i * mid) / headW);
    rect(g, x + w - headW + i, y + mid - half, 1, half * 2 + 1, c);
  }
}

const FLAME = [
  "......#.......",
  "......##......",
  ".....###......",
  ".....####.....",
  "....#####..#..",
  "....######.#..",
  "...#######.##.",
  "..##########..",
  "..###########.",
  ".############.",
  ".#############",
  ".#############",
  "..###########.",
  "...#########..",
];

/** The furnace flame (14 x 14): grey when out; lit, yellow at the heart to red at the edges. */
export function drawFlame(g: Ctx, x: number, y: number, lit: boolean): void {
  for (let r = 0; r < 14; r++)
    for (let c = 0; c < 14; c++) {
      if (FLAME[r][c] !== "#") continue;
      let col = C.arrow;
      if (lit) {
        const edge = FLAME[r][c - 1] !== "#" || FLAME[r][c + 1] !== "#" || (FLAME[r - 1]?.[c] ?? ".") !== "#";
        col = edge ? "#d8341d" : r < 7 ? "#ff8a1c" : r < 11 ? "#ffc13b" : "#fff3a6";
      }
      px(g, x + c, y + r, col);
    }
}

/** Faint silhouettes in empty armour slots: helmet, chestplate, leggings, boots (16 x 16). */
const ARMOR_GHOST = [
  ["................", "................", "................", "....########....", "...##########...", "...##########...", "...###....###...", "...##......##...", "...##......##...", "................", "................", "................", "................", "................", "................", "................"],
  ["................", "................", "...###....###...", "..####....####..", "..############..", "..############..", "..###.####.###..", "......####......", ".....######.....", ".....######.....", ".....######.....", ".....######.....", "................", "................", "................", "................"],
  ["................", "................", "................", ".....######.....", ".....######.....", ".....##..##.....", ".....##..##.....", ".....##..##.....", ".....##..##.....", ".....##..##.....", ".....##..##.....", "................", "................", "................", "................", "................"],
  ["................", "................", "................", "................", "................", "................", "................", "....##....##....", "....##....##....", "....##....##....", "...###...###....", "..####..####....", "..####..####....", "................", "................", "................"],
];

export function drawGhost(g: Ctx, x: number, y: number, slot: number): void {
  const m = ARMOR_GHOST[slot];
  for (let r = 0; r < 16; r++) for (let c = 0; c < 16; c++) if (m[r][c] === "#") px(g, x + c, y + r, "#7a7a7a");
}

/** An empty armour slot's silhouette as an image (v6: it hides while a piece is worn there). */
export const ghostImage = (() => {
  const made: string[] = [];
  return (slot: number) => {
    if (!made[slot]) {
      const [cv, g] = canvas(16, 16);
      drawGhost(g, 0, 0, slot);
      made[slot] = cv.toDataURL();
    }
    return made[slot];
  };
})();

export const label = (g: Ctx, text: string, x: number, y: number) => drawText(g, text, x, y, C.label);

// ---------------------------------------------------------------- the screens

export interface Layout {
  w: number;
  h: number;
  /** Window slot index -> top-left of its 16 x 16 item area. */
  slots: Map<number, [number, number]>;
  big: Set<number>; // result/output slots drawn 26 x 26
  bg: string; // data URL
  arrow?: [number, number, number, number]; // furnace progress arrow box
  flame?: [number, number];
  book?: [number, number]; // recipe book button (20 x 18)
  preview?: [number, number, number, number]; // the player box (inside)
}

function inventoryRows(slots: Map<number, [number, number]>, start: number, y: number): void {
  for (let k = 0; k < 27; k++) slots.set(start + k, [8 + (k % 9) * 18, y + Math.floor(k / 9) * 18]);
  for (let k = 0; k < 9; k++) slots.set(start + 27 + k, [8 + k * 18, y + 58]);
}

const layoutCache = new Map<string, Layout>();

/** v9: the trade window: up to TRADE_ROWS offers of TRADE_ROW_H pixels from y 17, the inventory at TRADE_INV_Y. */
export const TRADE_ROWS = 5;
export const TRADE_ROW_H = 19;
export const TRADE_INV_Y = 17 + TRADE_ROWS * TRADE_ROW_H + 14;
const TRADE_H = TRADE_INV_Y + 58 + 16 + 7;

/** v9: the little arrow in a trade row (cost -> goods), and the red cross over a sold-out one. */
export const tradeSprites = (() => {
  let made: { arrow: string; cross: string } | null = null;
  return () => {
    if (made) return made;
    const [a, ag] = canvas(10, 9);
    drawArrow(ag, 0, 0, 10, 9, C.arrow);
    const [x, xg] = canvas(16, 16);
    for (let k = 0; k < 14; k++) {
      xg.fillStyle = "#c81e1e";
      xg.fillRect(1 + k, 1 + k, 2, 2);
      xg.fillRect(13 - k, 1 + k, 2, 2);
    }
    made = { arrow: a.toDataURL(), cross: x.toDataURL() };
    return made;
  };
})();

/** The classic layout for a window kind. */
export function layoutFor(kind: string, title: string): Layout {
  const key = `${kind}|${title}`;
  const hit = layoutCache.get(key);
  if (hit) return hit;
  const slots = new Map<number, [number, number]>();
  const big = new Set<number>();
  const w = 176;
  const h = kind === "chest" ? 168 : kind === "trade" ? TRADE_H : 166;
  const [cv, g] = canvas(w, h);
  drawPanel(g, 0, 0, w, h);
  const L: Partial<Layout> = {};
  if (kind === "player") {
    // the player box, armour column, 2x2 grid -> result
    drawSlot(g, 25, 7, 51, 72, "#000000");
    L.preview = [26, 8, 49, 70];
    for (let k = 0; k < 4; k++) slots.set(5 + k, [8, 8 + k * 18]);
    slots.set(1, [98, 18]);
    slots.set(2, [116, 18]);
    slots.set(3, [98, 36]);
    slots.set(4, [116, 36]);
    slots.set(0, [154, 28]);
    label(g, "Crafting", 97, 8);
    drawArrow(g, 135, 29, 16, 13, C.arrow);
    inventoryRows(slots, 9, 84);
    L.book = [104, 61];
  } else if (kind === "crafting") {
    for (let k = 0; k < 9; k++) slots.set(1 + k, [30 + (k % 3) * 18, 17 + Math.floor(k / 3) * 18]);
    slots.set(0, [124, 35]);
    big.add(0);
    label(g, title, 29, 6);
    drawArrow(g, 90, 35, 22, 15, C.arrow);
    label(g, "Inventory", 8, 72);
    inventoryRows(slots, 10, 84);
    L.book = [5, 34];
  } else if (kind === "furnace") {
    slots.set(0, [56, 17]);
    slots.set(1, [56, 53]);
    slots.set(2, [116, 35]);
    big.add(2);
    label(g, title, Math.floor((w - textWidth(title)) / 2), 6);
    drawFlame(g, 57, 37, false);
    drawArrow(g, 79, 35, 24, 17, C.arrow);
    L.flame = [57, 37];
    L.arrow = [79, 35, 24, 17];
    label(g, "Inventory", 8, 72);
    inventoryRows(slots, 3, 84);
  } else if (kind === "trade") {
    // v9: a villager's offers in a recessed list (drawn by the UI), your inventory under it
    label(g, title, 8, 6);
    drawSlot(g, 7, 16, 162, TRADE_ROWS * TRADE_ROW_H + 2);
    label(g, "Inventory", 8, TRADE_INV_Y - 11);
    inventoryRows(slots, 0, TRADE_INV_Y);
  } else {
    for (let k = 0; k < 27; k++) slots.set(k, [8 + (k % 9) * 18, 18 + Math.floor(k / 9) * 18]);
    label(g, title, 8, 6);
    label(g, "Inventory", 8, 74);
    inventoryRows(slots, 27, 85);
  }
  for (const [k, [x, y]] of slots) {
    if (big.has(k)) drawSlot(g, x - 5, y - 5, 26, 26);
    else drawSlot(g, x - 1, y - 1);
  }
  const out: Layout = { w, h, slots, big, bg: cv.toDataURL(), ...L };
  layoutCache.set(key, out);
  return out;
}

/** The furnace's lit flame and the white progress arrow, as images to clip over the panel. */
export const furnaceSprites = (() => {
  let made: { flame: string; arrow: string } | null = null;
  return () => {
    if (made) return made;
    const [f, fg] = canvas(14, 14);
    drawFlame(fg, 0, 0, true);
    const [a, ag] = canvas(24, 17);
    drawArrow(ag, 0, 0, 24, 17, C.white);
    made = { flame: f.toDataURL(), arrow: a.toDataURL() };
    return made;
  };
})();

/** The recipe book button (20 x 18): a raised button with a red book on it. */
export function bookButton(pressed: boolean): string {
  const [cv, g] = canvas(20, 18);
  drawButton(g, 0, 0, 20, 18, "#a9a9a9", pressed);
  const o = pressed ? 1 : 0;
  rect(g, 5 + o, 4 + o, 10, 10, "#7c1d16");
  rect(g, 6 + o, 4 + o, 8, 9, "#d8402f");
  rect(g, 6 + o, 12 + o, 9, 2, "#f2ede2");
  rect(g, 8 + o, 6 + o, 4, 1, "#ff9d8c");
  px(g, 14 + o, 12 + o, "#7c1d16");
  return cv.toDataURL();
}

/** The recipe book panel (147 x 166). */
export function bookPanel(): string {
  const [cv, g] = canvas(147, 166);
  drawPanel(g, 0, 0, 147, 166);
  label(g, "Recipe Book", 8, 6);
  return cv.toDataURL();
}

const buttonCache = new Map<string, string>();

/** A raised button image of any size and fill (tabs, recipe cells, page arrows). */
export function buttonImage(w: number, h: number, fill: string, down = false): string {
  const key = `${w}x${h}|${fill}|${down}`;
  let u = buttonCache.get(key);
  if (!u) {
    const [cv, g] = canvas(w, h);
    drawButton(g, 0, 0, w, h, fill, down);
    u = cv.toDataURL();
    buttonCache.set(key, u);
  }
  return u;
}

/** A small arrow glyph (page buttons): left or right, 7 x 9. */
export function pageArrow(left: boolean): string {
  const [cv, g] = canvas(7, 9);
  for (let i = 0; i < 4; i++) {
    const x = left ? 1 + i : 5 - i;
    rect(g, x, 4 - i, 1, i * 2 + 1, C.label);
  }
  return cv.toDataURL();
}

// ---------------------------------------------------------------- hotbar and HUD

/** The hotbar strip (182 x 22): a dark translucent frame with nine recessed cells. */
export const hotbarImage = (() => {
  let u = "";
  return () => {
    if (u) return u;
    const [cv, g] = canvas(182, 22);
    rect(g, 0, 0, 182, 22, "rgba(16, 16, 18, 0.62)");
    rect(g, 0, 0, 182, 1, "#1b1b1e");
    rect(g, 0, 21, 182, 1, "#1b1b1e");
    rect(g, 0, 0, 1, 22, "#1b1b1e");
    rect(g, 181, 0, 1, 22, "#1b1b1e");
    for (let i = 0; i < 9; i++) {
      const x = 1 + i * 20;
      rect(g, x, 1, 20, 1, "#7b7b80");
      rect(g, x, 1, 1, 20, "#7b7b80");
      rect(g, x + 1, 20, 19, 1, "#3a3a3f");
      rect(g, x + 19, 2, 1, 19, "#3a3a3f");
      rect(g, x + 2, 2, 17, 1, "rgba(0,0,0,0.35)");
      rect(g, x + 2, 2, 1, 17, "rgba(0,0,0,0.35)");
    }
    u = cv.toDataURL();
    return u;
  };
})();

/** The selection box (24 x 24): a thick light frame. */
export const selectionImage = (() => {
  let u = "";
  return () => {
    if (u) return u;
    const [cv, g] = canvas(26, 26);
    const o = 1;
    rect(g, o, o, 24, 24, "#0e0e10");
    rect(g, o + 1, o + 1, 22, 22, "#f4f4f4");
    rect(g, o + 3, o + 3, 18, 18, "#9c9ca0");
    g.clearRect(o + 4, o + 4, 16, 16);
    u = cv.toDataURL();
    return u;
  };
})();

/** v6 the attack indicator under the crosshair: a 16 x 4 bar filling as the swing recharges. */
export const attackBarImage = (() => {
  const made = new Map<number, string>();
  return (fill: number) => {
    const f = Math.max(0, Math.min(16, Math.round(fill)));
    let u = made.get(f);
    if (!u) {
      const [cv, g] = canvas(16, 4);
      rect(g, 0, 0, 16, 4, "rgba(20, 20, 24, 0.75)");
      rect(g, 1, 1, 14, 2, "rgba(90, 90, 98, 0.85)");
      rect(g, 1, 1, Math.round((f / 16) * 14), 2, "#f2f2f2");
      u = cv.toDataURL();
      made.set(f, u);
    }
    return u;
  };
})();

/** Fully charged while aiming at something in reach: a small spark (our own mark). */
export const attackReadyImage = (() => {
  let u = "";
  return () => {
    if (u) return u;
    const [cv, g] = canvas(9, 9);
    const m = ["....#....", "....#....", "...###...", "..#####..", "#########", "..#####..", "...###...", "....#....", "....#...."];
    for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) if (m[r][c] === "#") px(g, c, r, r === 4 || c === 4 ? "#ffffff" : "#e8e8ec");
    u = cv.toDataURL();
    return u;
  };
})();

// ---------------------------------------------------------------- tooltips and counts

/** A tooltip (dark plum box, violet border): the first line white, the rest grey. */
export function tooltipImage(lines: string[]): { url: string; w: number; h: number } {
  const tw = Math.max(...lines.map(textWidth));
  const lh = FONT_HEIGHT + 2;
  const w = tw + 8;
  const h = lines.length * lh + 6 + (lines.length > 1 ? 2 : 0);
  const [cv, g] = canvas(w, h);
  rect(g, 1, 0, w - 2, h, "rgba(20, 8, 26, 0.95)");
  rect(g, 0, 1, w, h - 2, "rgba(20, 8, 26, 0.95)");
  const grad = g.createLinearGradient(0, 1, 0, h - 1);
  grad.addColorStop(0, "#7440b4");
  grad.addColorStop(1, "#3a1b62");
  g.fillStyle = grad;
  g.fillRect(1, 1, w - 2, 1);
  g.fillRect(1, h - 2, w - 2, 1);
  g.fillRect(1, 1, 1, h - 2);
  g.fillRect(w - 2, 1, 1, h - 2);
  lines.forEach((t, i) => drawText(g, t, 4, 3 + i * lh + (i > 0 ? 2 : 0), i === 0 ? "#ffffff" : "#a8a8b0", i === 0 ? "#3f3f3f" : "#2a2a30"));
  return { url: cv.toDataURL(), w, h };
}

const countCache = new Map<string, string>();

/** Item count text (white with a shadow) as an image over the 16 x 16 item area, like the classic counts: the
 *  digits end on the icon's last column (x 15) and their shadow falls on the slot's edge (x 16); rows 9-15, shadow
 *  16. A yellow count is the classic "0 left on the cursor" while spreading a stack. */
export function countImage(n: number, color = "#ffffff"): string {
  const t = String(n);
  const key = `${t}|${color}`;
  let u = countCache.get(key);
  if (!u) {
    const [cv, g] = canvas(18, 18);
    drawText(g, t, 16 - textWidth(t), 9, color, color === "#ffffff" ? C.textShadow : "#3f3f15");
    u = cv.toDataURL();
    countCache.set(key, u);
  }
  return u;
}

/** A small raised close button (14 x 14) with an X: touch screens get it on every in-game window. */
export const closeImage = (() => {
  const made = new Map<boolean, string>();
  return (down = false) => {
    let u = made.get(down);
    if (u) return u;
    const [cv, g] = canvas(14, 14);
    drawButton(g, 0, 0, 14, 14, down ? "#8b8b8b" : "#b4b4b4", down);
    const o = down ? 1 : 0;
    const X = ["#......#", "##....##", ".##..##.", "..####..", "..####..", ".##..##.", "##....##", "#......#"];
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) if (X[r][c] === "#") px(g, 3 + c + o, 3 + r + o, C.label);
    u = cv.toDataURL();
    made.set(down, u);
    return u;
  };
})();

/** The durability bar under an item (13 x 2 at the bottom of the 16 x 16 icon area), green to red. */
export function durabilityImage(frac: number): string {
  const [cv, g] = canvas(16, 16);
  rect(g, 2, 13, 13, 2, "#000000");
  const w = Math.max(1, Math.round(13 * frac));
  const hue = Math.max(0, Math.min(1, frac)) * 120;
  rect(g, 2, 13, w, 1, `hsl(${hue}, 100%, 50%)`);
  return cv.toDataURL();
}
