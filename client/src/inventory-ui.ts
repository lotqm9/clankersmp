// The inventory and container screens (protocol v5; the native classic look since update 7.2): your inventory with
// the player box, armour column and 2x2 crafting grid, the crafting table, the furnace and the chest, drawn as the
// classic grey bevelled panels with recessed slots on an exact pixel grid (client/src/pixel-gui.ts, our own art),
// scaled crisply by the GUI scale. Every click becomes a shared/inventory.ts Click: the game predicts it on its own
// copy and sends it to the server, whose answer always wins. The recipe book opens beside the panel from the book
// button (below it, or over it, when the screen is too narrow) and lays a recipe out for you.
//
// Mouse: left click picks up / places / swaps, right click takes half / places one, shift-click moves a stack
// across, drag with a stack spreads it (left: evenly, right: one each; the split shows while you drag), double-click
// (two LEFT clicks within 250 ms) gathers. Keys while hovering: 1-9 swap with the hotbar, Q throws one (Ctrl+Q the
// stack). Clicking outside drops what you hold.
// Touch: tap = left click, press and hold = right click (half / one), double tap gathers; an X closes the window.

import { fuelTicks, itemDef, itemName, sameItem, type Stack } from "../../shared/items.ts";
import { Menu, newPlayerInv, type Click } from "../../shared/inventory.ts";
import { RECIPES, canMake, recipeNeeds, recipeSize, type Recipe } from "../../shared/recipes.ts";
import type { WindowKind } from "../../shared/protocol.ts";
import { B } from "../../shared/blocks.ts";
import { I, toolId } from "../../shared/items.ts";
import { itemIcon } from "./render/textures.ts";
import { textEl } from "./pixel-font.ts";
import { PlayerPreview } from "./player-preview.ts";
import { C, GUI, TRADE_ROWS, TRADE_ROW_H, bookButton, bookPanel, buttonImage, closeImage, countImage, durabilityImage, furnaceSprites, ghostImage, layoutFor, pageArrow, snapPx, tooltipImage, tradeSprites, type Layout } from "./pixel-gui.ts";
import { canAfford, type WireOffer } from "../../shared/trades.ts";
import { packArmor } from "../../shared/combat.ts";
import { maxDurability } from "../../shared/items.ts";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, parent?: HTMLElement, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  if (parent) parent.appendChild(e);
  return e;
}

/** Place an element at GUI-pixel coordinates inside a GUI panel (crisp at any GUI scale). */
function at(e: HTMLElement, x: number, y: number, w?: number, h?: number): HTMLElement {
  e.style.left = `calc(var(--s) * ${x})`;
  e.style.top = `calc(var(--s) * ${y})`;
  if (w !== undefined) e.style.width = `calc(var(--s) * ${w})`;
  if (h !== undefined) e.style.height = `calc(var(--s) * ${h})`;
  return e;
}

/** A pressable pixel button: pointerdown runs it (and nothing under it gets the press). */
function onPress(e: HTMLElement, fn: (ev: PointerEvent) => void): void {
  e.addEventListener("pointerdown", (ev) => {
    ev.stopPropagation();
    ev.preventDefault();
    if (ev.button !== 0) return;
    fn(ev);
  });
}

/** A throwaway copy of a window (its contents and kind), to show what a click would do without doing it. */
function scratchMenu(menu: Menu, kind: WindowKind): Menu {
  const size = kind === "crafting" ? 9 : kind === "furnace" ? 3 : kind === "chest" ? 27 : 0; // (trade: none)
  const m = new Menu(kind, newPlayerInv(), size ? new Array(size).fill(null) : null);
  m.setContents(menu.contents());
  return m;
}

export interface InvActions {
  click(c: Click): void;
  /** v9: trade offer `o` once, or (`all`, shift-click) as many times as it can. */
  trade?(o: number, all: boolean): void;
  close(): void;
  sound(): void;
}

const CATS: [Recipe["cat"] | "all", string, number][] = [
  ["all", "All recipes", B.CRAFTING_TABLE],
  ["basics", "Basics", B.TORCH],
  ["tools", "Tools", toolId(1, 0)],
  ["combat", "Combat", toolId(2, 3)],
  ["building", "Building", B.BRICKS],
  ["materials", "Materials", I.IRON_INGOT],
];
const PER_PAGE = 20;
const BOOK_W = 147;
const BOOK_H = 166;
const LONG_PRESS_MS = 420;

export class InventoryUI {
  private root: HTMLElement;
  private actions: InvActions;
  private screen: HTMLDivElement | null = null;
  private wrap: HTMLDivElement | null = null;
  private panel: HTMLDivElement | null = null;
  private layout: Layout | null = null;
  private slotEls: HTMLDivElement[] = [];
  private cursorEl: HTMLDivElement | null = null;
  private tipEl: HTMLDivElement | null = null;
  private menu: Menu | null = null;
  private cursor: { s: Stack | null } = { s: null };
  kind: WindowKind = "player";
  private hover = -1;
  private drag: { b: 0 | 1; list: number[] } | null = null;
  /** While spreading: what stays on the cursor (n 0 = nothing left: the classic yellow 0). */
  private dragLeft: Stack | null = null;
  private lastClick: { s: number; at: number; b: number } = { s: -1, at: 0, b: -1 };
  private touchPress: { k: number; timer: number; long: boolean } | null = null;
  private flame: HTMLDivElement | null = null;
  private arrow: HTMLDivElement | null = null;
  private recipesEl: HTMLDivElement | null = null;
  private tradeEl: HTMLDivElement | null = null; // v9: the trade window's offer list
  private tradeKey = "";
  private offers: WireOffer[] = [];
  private preview: PlayerPreview | null = null;
  private ghosts = new Map<number, HTMLDivElement>(); // v6: empty armour slots' silhouettes
  private cat: Recipe["cat"] | "all" = "all";
  private onlyCan = false;
  private page = 0;
  private mx = 0;
  private my = 0;
  private skin = 0;
  private readonly relayoutBound = () => this.relayout();
  private readonly releaseBound = (e: PointerEvent) => this.release(e);
  private readonly cancelBound = () => this.cancelPress();

  constructor(root: HTMLElement, actions: InvActions) {
    this.root = root;
    this.actions = actions;
  }

  get isOpen(): boolean {
    return this.screen !== null;
  }

  /** Your skin, for the player box in the inventory. */
  setSkin(variant: number): void {
    this.skin = variant;
  }

  open(kind: WindowKind, title: string, menu: Menu, cursor: { s: Stack | null }, offers?: WireOffer[]): void {
    this.closeDom();
    this.offers = offers ?? [];
    this.kind = kind;
    this.menu = menu;
    this.cursor = cursor;
    const L = layoutFor(kind, title);
    this.layout = L;
    const s = el("div", "screen inv-screen mc");
    const wrap = el("div", "mcwrap", s);
    this.wrap = wrap;
    const grid = kind === "player" || kind === "crafting";
    if (grid) {
      this.recipesEl = el("div", "mcpanel mcbook recipes", wrap);
      this.recipesEl.style.backgroundImage = `url(${bookPanel()})`;
      let show = false;
      try {
        show = localStorage.getItem("steve_craft_recipes") === "1";
      } catch {
        /* fine */
      }
      this.recipesEl.classList.toggle("hidden", !show);
    }
    const panel = el("div", `mcpanel inv ${kind}`, wrap);
    this.panel = panel;
    panel.style.width = `calc(var(--s) * ${L.w})`;
    panel.style.height = `calc(var(--s) * ${L.h})`;
    panel.style.backgroundImage = `url(${L.bg})`;
    this.slotEls = new Array(menu.size);
    for (const [k, [x, y]] of L.slots) {
      if (menu.slotKind(k) === "armor") {
        // the silhouette under an empty armour slot (it hides while a piece is worn)
        const g = at(el("div", "mcghost", panel), x, y, 16, 16) as HTMLDivElement;
        g.style.backgroundImage = `url(${ghostImage(k - 5)})`;
        this.ghosts.set(k, g);
      }
      const d = this.slot(k);
      at(d, x, y, 16, 16);
      panel.appendChild(d);
    }
    if (L.preview) {
      const [x, y, w, h] = L.preview;
      const box = at(el("div", "mcpreview", panel), x, y, w, h);
      // the classic spot: feet at (51, 75) in the panel, the eyes 50 pixels above
      this.preview = new PlayerPreview(this.skin, w, h, [51 - x, 75 - y]);
      box.appendChild(this.preview.canvas);
    }
    if (L.flame) {
      const sp = furnaceSprites();
      this.flame = at(el("div", "mcflame", panel), L.flame[0], L.flame[1], 14, 14) as HTMLDivElement;
      const i = el("i", "", this.flame);
      i.style.backgroundImage = `url(${sp.flame})`;
      const [ax, ay, aw, ah] = L.arrow!;
      this.arrow = at(el("div", "mcarrow", panel), ax, ay, aw, ah) as HTMLDivElement;
      const j = el("i", "", this.arrow);
      j.style.backgroundImage = `url(${sp.arrow})`;
      this.setFurnace(0, 0);
    }
    if (kind === "trade") {
      this.tradeEl = el("div", "trades", panel) as HTMLDivElement;
      at(this.tradeEl, 8, 17, 160, TRADE_ROWS * TRADE_ROW_H);
    }
    if (L.book && grid) {
      const b = at(el("div", "mcbookbtn rb-toggle", panel), L.book[0], L.book[1], 20, 18) as HTMLDivElement;
      b.style.backgroundImage = `url(${bookButton(this.bookOpen())})`;
      onPress(b, () => this.toggleBook());
      b.addEventListener("pointerenter", () => this.showText(["Recipe Book"]));
      b.addEventListener("pointerleave", () => this.hideTip());
    }
    // touch screens: an X closes the window (keyboards have E and Esc)
    const x = at(el("div", "mcclose"), L.w - 17, 3, 14, 14) as HTMLDivElement;
    x.style.backgroundImage = `url(${closeImage()})`;
    onPress(x, () => {
      this.actions.sound();
      this.actions.close();
    });
    panel.appendChild(x);
    this.cursorEl = el("div", "cursor-item hidden", s);
    this.tipEl = el("div", "mctip hidden", s);
    // clicks outside the panels drop the cursor stack
    s.addEventListener("pointerdown", (e) => {
      if (e.target !== s && e.target !== wrap) return;
      if (this.cursor.s) this.actions.click({ m: "out", b: e.button === 2 ? 1 : 0 });
    });
    s.addEventListener("pointermove", (e) => {
      this.mx = e.clientX;
      this.my = e.clientY;
      this.placeCursor();
      this.placeTip();
      this.aimPreview();
    });
    s.addEventListener("contextmenu", (e) => e.preventDefault());
    window.addEventListener("pointerup", this.releaseBound);
    window.addEventListener("pointercancel", this.cancelBound);
    window.addEventListener("resize", this.relayoutBound);
    window.addEventListener("guiscale", this.relayoutBound);
    // the mouse starts in the middle of the screen (the pointer was locked), like the classic game
    this.mx = window.innerWidth / 2;
    this.my = window.innerHeight / 2;
    this.screen = s;
    this.root.appendChild(s);
    this.relayout();
    this.preview?.start();
    this.render();
  }

  private bookOpen(): boolean {
    return !!this.recipesEl && !this.recipesEl.classList.contains("hidden");
  }

  private toggleBook(): void {
    this.actions.sound();
    const on = !this.bookOpen();
    this.recipesEl?.classList.toggle("hidden", !on);
    try {
      localStorage.setItem("steve_craft_recipes", on ? "1" : "0");
    } catch {
      /* fine */
    }
    this.relayout();
    this.panel?.querySelector<HTMLElement>(".mcbookbtn")?.style.setProperty("background-image", `url(${bookButton(on)})`);
  }

  /** Fit the window to the screen: the recipe book beside the panel, below it, or (small phones) over it. */
  private relayout(): void {
    const wrap = this.wrap;
    const L = this.layout;
    if (!wrap || !L) return;
    const s = GUI.s;
    const W = window.innerWidth;
    const H = window.innerHeight;
    let mode = "side";
    if (this.bookOpen()) {
      if ((L.w + 2 + BOOK_W) * s + 8 <= W) mode = "side";
      else if ((L.h + 2 + BOOK_H) * s + 8 <= H) mode = "stack";
      else mode = "over";
    }
    wrap.dataset.mode = mode;
    this.preview?.setScale(GUI.dev);
    this.aimPreview();
    this.placeCursor();
  }

  /** The player in the box looks at the mouse (from its eyes: 51, 25 in the panel). */
  private aimPreview(): void {
    if (!this.preview || !this.panel) return;
    const r = this.panel.getBoundingClientRect();
    const s = GUI.s;
    this.preview.lookAt((this.mx - (r.left + 51 * s)) / s, (this.my - (r.top + 25 * s)) / s);
  }

  private slot(k: number): HTMLDivElement {
    const kind = this.menu?.slotKind(k);
    const d = el("div", `islot${kind === "result" || kind === "output" ? " result" : ""}`);
    d.dataset.s = String(k);
    d.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.pointerType === "touch") this.touchDown(k);
      else this.mouseDown(k, e);
    });
    d.addEventListener("pointerenter", () => {
      this.hover = k;
      if (this.canDragTo(k)) {
        this.drag!.list.push(k);
        this.renderDrag();
      }
      this.showTip(k);
    });
    d.addEventListener("pointerleave", () => {
      if (this.hover === k) this.hover = -1;
      this.hideTip();
    });
    this.slotEls[k] = d;
    return d;
  }

  private mouseDown(k: number, e: PointerEvent): void {
    if (e.button !== 0 && e.button !== 2) return;
    this.press(k, e.button === 2 ? 1 : 0, e.shiftKey, true);
  }

  /** One click on slot k, as the classic game reads it. */
  private press(k: number, b: 0 | 1, shift: boolean, mayDrag: boolean): void {
    const now = performance.now();
    const kind = this.menu?.slotKind(k);
    const out = kind === "result" || kind === "output";
    if (shift) {
      this.actions.click({ m: "shift", s: k });
    } else if (b === 0 && this.cursor.s && this.lastClick.s === k && this.lastClick.b === 0 && now - this.lastClick.at < 250) {
      // a double-click: two LEFT clicks on the same slot within 250 ms (Java), not a right click then a left one
      this.actions.click({ m: "collect", s: k });
    } else if (mayDrag && this.cursor.s && !out) {
      // maybe the start of a drag: decided when the button comes up
      this.drag = { b, list: [k] };
      this.renderDrag();
    } else {
      this.actions.click({ m: "pick", s: k, b });
    }
    this.lastClick = { s: k, at: now, b };
  }

  /** Touch: a tap is a left click (on release), pressing and holding is a right click. */
  private touchDown(k: number): void {
    this.cancelPress();
    const p = { k, timer: 0, long: false };
    p.timer = window.setTimeout(() => {
      p.long = true;
      navigator.vibrate?.(8);
      this.press(k, 1, false, false);
    }, LONG_PRESS_MS);
    this.touchPress = p;
    this.hover = k;
    this.showTip(k);
  }

  private cancelPress(): void {
    if (this.touchPress) clearTimeout(this.touchPress.timer);
    this.touchPress = null;
    if (this.drag) {
      // a cancelled drag: put the real contents back
      this.drag = null;
      this.dragLeft = null;
      for (const s of this.slotEls) s?.classList.remove("dragged");
      this.render();
    }
  }

  /** A button or finger came up anywhere: finish a touch tap or a drag. */
  private release(e: PointerEvent): void {
    const p = this.touchPress;
    if (p && e.pointerType === "touch") {
      this.touchPress = null;
      clearTimeout(p.timer);
      if (!p.long) this.press(p.k, 0, false, false);
      this.hover = -1;
      this.hideTip();
      return;
    }
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    this.dragLeft = null;
    for (const s of this.slotEls) s?.classList.remove("dragged");
    if (d.list.length >= 2) this.actions.click({ m: "drag", b: d.b, list: d.list });
    else this.actions.click({ m: "pick", s: d.list[0], b: d.b });
    this.render();
  }

  /** Can a drag spread onto slot k? Like Java: an empty slot or the same item, and never more slots than items. */
  private canDragTo(k: number): boolean {
    const d = this.drag;
    const cur = this.cursor.s;
    const menu = this.menu;
    if (!d || !cur || !menu || d.list.includes(k) || d.list.length >= cur.n) return false;
    const kind = menu.slotKind(k);
    if (kind === "result" || kind === "output" || kind === "armor") return false;
    if (kind === "fuel" && !(fuelTicks(cur.id) > 0)) return false;
    const st = menu.get(k);
    return !st || sameItem(st, cur);
  }

  /** While dragging: highlight the slots and show the split there and what is left on the cursor. */
  private renderDrag(): void {
    const d = this.drag;
    const menu = this.menu;
    const cur = this.cursor.s;
    if (!d || !menu || !cur) return;
    for (const k of d.list) this.slotEls[k]?.classList.add("dragged");
    if (d.list.length < 2) return;
    const m = scratchMenu(menu, this.kind);
    const c: { s: Stack | null } = { s: { ...cur } };
    m.click({ m: "drag", b: d.b, list: d.list }, c);
    for (const k of d.list) {
      const e = this.slotEls[k];
      if (!e) continue;
      e.dataset.key = "drag";
      fillSlot(e, m.get(k));
    }
    this.dragLeft = c.s ?? { ...cur, n: 0 };
    if (this.cursorEl) {
      this.cursorEl.dataset.key = "drag";
      fillSlot(this.cursorEl, this.dragLeft);
    }
    this.placeCursor();
  }

  /** Keys while the screen is open: 1-9 swap the hovered slot with the hotbar, Q throws. */
  key(code: string, ctrl: boolean): boolean {
    if (!this.isOpen) return false;
    if (/^Digit[1-9]$/.test(code) && this.hover >= 0) {
      this.actions.click({ m: "swap", s: this.hover, h: Number(code.slice(5)) - 1 });
      return true;
    }
    if (code === "KeyQ" && this.hover >= 0 && !this.cursor.s) {
      this.actions.click({ m: "throw", s: this.hover, all: ctrl });
      return true;
    }
    return false;
  }

  /** Draw every slot, the cursor stack and the recipe book from the window's current contents. */
  render(): void {
    const menu = this.menu;
    if (!menu || !this.screen) return;
    const items = menu.contents();
    items.forEach((st, k) => {
      const d = this.slotEls[k];
      if (!d) return;
      const key = st ? `${st.id}:${st.n}:${st.d}` : "";
      if (d.dataset.key === key) return;
      d.dataset.key = key;
      fillSlot(d, st);
    });
    if (this.cursorEl) {
      const st = this.cursor.s;
      const key = st ? `${st.id}:${st.n}:${st.d}` : "";
      if (this.cursorEl.dataset.key !== key) {
        this.cursorEl.dataset.key = key;
        fillSlot(this.cursorEl, st);
      }
      this.placeCursor();
    }
    if (this.drag) this.renderDrag();
    if (this.hover >= 0) this.showTip(this.hover);
    for (const [k, g] of this.ghosts) g.classList.toggle("hidden", !!items[k]);
    if (this.preview && this.kind === "player") this.preview.setArmor(packArmor([5, 6, 7, 8].map((k) => items[k] ?? null)));
    this.renderRecipes();
    this.renderTrades();
  }

  // ---------------------------------------------------------------- v9: trading

  /** A villager's stock changed (someone traded): redraw its offers. */
  setOffers(offers: WireOffer[]): void {
    this.offers = offers;
    this.tradeKey = "";
    this.renderTrades();
  }

  /** The offers as pixel buttons: what it costs, an arrow, what you get, how many are left. A row you can't afford
   *  is dimmed; a sold-out one is crossed out. Click: trade once; shift-click: as many times as you can. */
  private renderTrades(): void {
    const box = this.tradeEl;
    if (!box || this.kind !== "trade") return;
    const inv = this.menu ? this.menu.contents().slice(0, 36) : [];
    // the window's slots are 0-26 the inventory, 27-35 the hotbar: back to the inventory's own order for counting
    const items = [...inv.slice(27, 36), ...inv.slice(0, 27)];
    const key = JSON.stringify(this.offers) + "|" + items.map((s) => (s ? `${s.id}:${s.n}` : "")).join(",");
    if (key === this.tradeKey) return;
    this.tradeKey = key;
    box.innerHTML = "";
    const sp = tradeSprites();
    const icon = (parent: HTMLElement, id: number, n: number, x: number) => {
      const slot = at(el("div", "islot tic", parent), x, 1, 16, 16) as HTMLDivElement;
      fillSlot(slot, { id, n, d: 0 });
      slot.style.pointerEvents = "none";
    };
    this.offers.slice(0, TRADE_ROWS).forEach((o, k) => {
      const out = o.n <= 0;
      const can = !out && canAfford(items, { buy: o.a, buy2: o.b, sell: o.r, max: o.m });
      const row = at(el("div", `mcbtn trow${can ? " can" : ""}${out ? " out" : ""}`, box), 0, k * TRADE_ROW_H, 160, 18) as HTMLDivElement;
      row.style.backgroundImage = `url(${buttonImage(160, 18, out ? "#7a7a7a" : "#a9a9a9")})`;
      if (!can) row.style.opacity = out ? "0.75" : "0.82";
      icon(row, o.a[0], o.a[1], 3);
      if (o.b) icon(row, o.b[0], o.b[1], 21);
      const ar = at(el("i", "", row), 44, 5, 10, 9);
      ar.style.backgroundImage = `url(${sp.arrow})`;
      icon(row, o.r[0], o.r[1], 60);
      if (out) {
        const x = at(el("i", "", row), 60, 1, 16, 16);
        x.style.backgroundImage = `url(${sp.cross})`;
      }
      const left = textEl(out ? "Sold out" : `${o.n} left`, out ? "#ffcfcf" : "#ffffff", "#3f3f3f");
      at(left, 84, 5);
      row.appendChild(left);
      const label = `${o.a[1]} ${itemName(o.a[0])}${o.b ? ` + ${o.b[1]} ${itemName(o.b[0])}` : ""} for ${o.r[1]} ${itemName(o.r[0])}`;
      const tip = [label, out ? "Sold out: back in stock soon" : can ? `${o.n} left · shift-click for as many as you can` : `You need ${o.a[1]} ${itemName(o.a[0])}${o.b ? ` and ${o.b[1]} ${itemName(o.b[0])}` : ""}`];
      row.addEventListener("pointerenter", () => this.showText(tip));
      row.addEventListener("pointerleave", () => this.hideTip());
      row.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.button !== 0) return;
        this.actions.sound();
        this.actions.trade?.(k, e.shiftKey);
      });
    });
  }

  private placeCursor(): void {
    const c = this.cursorEl;
    if (!c) return;
    c.style.transform = `translate(${snapPx(this.mx)}px, ${snapPx(this.my)}px)`;
    const shown = this.drag && this.dragLeft ? true : !!this.cursor.s;
    c.classList.toggle("hidden", !shown);
    if (shown) this.hideTip();
  }

  private hideTip(): void {
    this.tipEl?.classList.add("hidden");
  }

  /** Show a pixel tooltip near the mouse. */
  private showText(lines: string[]): void {
    if (!this.tipEl || this.cursor.s) return;
    const t = tooltipImage(lines);
    this.tipEl.style.backgroundImage = `url(${t.url})`;
    this.tipEl.style.width = `calc(var(--s) * ${t.w})`;
    this.tipEl.style.height = `calc(var(--s) * ${t.h})`;
    this.tipEl.classList.remove("hidden");
    this.placeTip();
  }

  private placeTip(): void {
    const t = this.tipEl;
    if (!t || t.classList.contains("hidden")) return;
    // like the classic game: 12 GUI pixels right of the mouse and 12 up, kept on screen
    const s = GUI.s;
    const w = t.offsetWidth;
    const h = t.offsetHeight;
    let x = this.mx + 12 * s;
    let y = this.my - 12 * s;
    if (x + w > window.innerWidth - 4) x = this.mx - 16 * s - w;
    if (x < 4) x = 4;
    if (y + h > window.innerHeight - 4) y = window.innerHeight - 4 - h;
    if (y < 4) y = 4;
    t.style.transform = `translate(${snapPx(x)}px, ${snapPx(y)}px)`;
  }

  private showTip(k: number): void {
    const st = this.menu?.get(k);
    if (!this.tipEl) return;
    if (!st || this.cursor.s) return this.hideTip();
    const def = itemDef(st.id);
    const lines = [itemName(st.id)];
    const max = maxDurability(st.id);
    if (def?.tool) lines.push(`${def.tool.damage} attack damage · ${def.tool.attackSpeed} per second`);
    if (def?.armor) lines.push(`+${def.armor.points} armor${def.armor.tough ? ` · +${def.armor.tough} toughness` : ""}`);
    if (max) lines.push(`Durability: ${max - st.d} / ${max}`);
    if (def?.food) lines.push(`Food: ${def.food.hunger / 2} drumsticks${def.food.queasy ? " · may make you queasy" : ""}`);
    this.showText(lines);
  }

  setFurnace(burn: number, cook: number): void {
    if (this.flame) {
      // the flame burns down from the top: show its lower `burn` part
      const f = Math.max(0, Math.min(1, burn));
      const i = this.flame.firstElementChild as HTMLElement;
      const hide = 14 - Math.round(f * 14);
      i.style.clipPath = `inset(calc(var(--s) * ${hide}) 0 0 0)`;
      i.style.visibility = f > 0 ? "visible" : "hidden";
    }
    if (this.arrow) {
      const f = Math.max(0, Math.min(1, cook));
      const i = this.arrow.firstElementChild as HTMLElement;
      const show = Math.round(f * 24);
      i.style.clipPath = `inset(0 calc(var(--s) * ${24 - show}) 0 0)`;
    }
  }

  // ---------------------------------------------------------------- recipe book

  private recipeKey = "";

  private renderRecipes(): void {
    const box = this.recipesEl;
    const menu = this.menu;
    if (!box || !menu) return;
    const size = this.kind === "crafting" ? 3 : 2;
    const have = new Map<number, number>();
    for (let k = 0; k < menu.size; k++) {
      if (menu.slotKind(k) === "result") continue;
      const st = menu.get(k);
      if (st && st.d === 0) have.set(st.id, (have.get(st.id) ?? 0) + st.n);
    }
    const key = JSON.stringify([[...have], this.cat, this.onlyCan, size, this.page]);
    if (key === this.recipeKey) return;
    this.recipeKey = key;
    box.innerHTML = "";
    // category tabs
    CATS.forEach(([c, label, icon], i) => {
      const t = at(el("div", `mcbtn rb-tab${this.cat === c ? " on" : ""}`, box), 8 + i * 22, 17, 21, 20) as HTMLDivElement;
      t.style.backgroundImage = `url(${buttonImage(21, 20, this.cat === c ? "#8b8b8b" : "#b4b4b4", this.cat === c)})`;
      const ic = itemIcon(icon);
      ic.className = "rbi";
      at(ic, 3, 2, 16, 16);
      t.appendChild(ic);
      onPress(t, () => {
        this.cat = c;
        this.page = 0;
        this.actions.sound();
        this.renderRecipes();
      });
      t.addEventListener("pointerenter", () => this.showText([label]));
      t.addEventListener("pointerleave", () => this.hideTip());
    });
    const shown = RECIPES.filter((r) => this.cat === "all" || r.cat === this.cat)
      .map((r) => {
        const [w, h] = recipeSize(r);
        const fits = w <= size && h <= size;
        const can = canMake(r, have);
        return { r, fits, can };
      })
      .filter((x) => !this.onlyCan || (x.can && x.fits))
      .sort((a, b) => Number(b.can && b.fits) - Number(a.can && a.fits));
    const pages = Math.max(1, Math.ceil(shown.length / PER_PAGE));
    if (this.page >= pages) this.page = pages - 1;
    shown.slice(this.page * PER_PAGE, (this.page + 1) * PER_PAGE).forEach(({ r, fits, can }, n) => {
      const fill = can && fits ? "#b4b4b4" : can ? "#7d7d84" : "#a65a52";
      const cell = at(el("div", `rb-item mcbtn${can && fits ? " can" : can ? " table" : ""}`, box), 11 + (n % 5) * 25, 42 + Math.floor(n / 5) * 25, 25, 25) as HTMLDivElement;
      cell.dataset.r = r.id;
      cell.style.backgroundImage = `url(${buttonImage(25, 25, fill)})`;
      const ic = itemIcon(r.out.id);
      ic.className = "rbi";
      at(ic, 4, 4, 16, 16);
      cell.appendChild(ic);
      if (r.out.n > 1) {
        const cnt = at(el("div", "cnt"), 4, 4, 18, 18);
        cnt.style.backgroundImage = `url(${countImage(r.out.n)})`;
        cell.appendChild(cnt);
      }
      onPress(cell, (e) => {
        if (!fits || !can) return;
        this.actions.click({ m: "fill", r: r.id, all: e.shiftKey });
        // over the panel (small screens) the book would hide the grid it just filled: put it away
        if (this.wrap?.dataset.mode === "over") this.toggleBook();
      });
      cell.addEventListener("pointerenter", () => {
        const lines = [`${itemName(r.out.id)}${r.out.n > 1 ? ` x${r.out.n}` : ""}`];
        for (const [ing, k] of recipeNeeds(r)) lines.push(`${k} ${itemName(ing[0])}${ing.length > 1 ? " (any kind)" : ""}`);
        lines.push(!fits ? "Needs a crafting table" : !can ? "You need more" : "Click: fill the grid · Shift: all you can");
        this.showText(lines);
      });
      cell.addEventListener("pointerleave", () => this.hideTip());
    });
    if (!shown.length) {
      const msg = at(textEl(this.onlyCan ? "Nothing craftable yet." : "No recipes here.", C.label), 11, 50);
      box.appendChild(msg);
      if (this.onlyCan) box.appendChild(at(textEl("Punch a tree for logs!", C.label), 11, 62));
    }
    // "craftable only" toggle and the pages
    const only = at(el("div", `mcbtn rb-only${this.onlyCan ? " on" : ""}`, box), 8, 146, 62, 14) as HTMLDivElement;
    only.style.backgroundImage = `url(${buttonImage(62, 14, this.onlyCan ? "#8b8b8b" : "#b4b4b4", this.onlyCan)})`;
    only.appendChild(at(textEl("Craftable", this.onlyCan ? "#ffffff" : C.label, this.onlyCan ? "#3f3f3f" : null), 8, 3));
    onPress(only, () => {
      this.onlyCan = !this.onlyCan;
      this.page = 0;
      this.actions.sound();
      this.renderRecipes();
    });
    only.addEventListener("pointerenter", () => this.showText([this.onlyCan ? "Showing what you can make" : "Showing all recipes"]));
    only.addEventListener("pointerleave", () => this.hideTip());
    if (pages > 1) {
      for (const [dx, d] of [[86, -1], [128, 1]] as [number, number][]) {
        const b = at(el("div", "mcbtn rb-page", box), dx, 146, 12, 14) as HTMLDivElement;
        b.style.backgroundImage = `url(${buttonImage(12, 14, "#b4b4b4")})`;
        const ar = at(el("i", ""), 2, 2, 7, 9);
        ar.style.backgroundImage = `url(${pageArrow(d < 0)})`;
        b.appendChild(ar);
        onPress(b, () => {
          this.page = (this.page + d + pages) % pages;
          this.actions.sound();
          this.renderRecipes();
        });
      }
      box.appendChild(at(textEl(`${this.page + 1}/${pages}`, C.label), 101, 149));
    }
    // over the panel (small screens): its own X puts the book away
    const x = at(el("div", "mcclose bookclose", box), BOOK_W - 18, 3, 14, 14) as HTMLDivElement;
    x.style.backgroundImage = `url(${closeImage()})`;
    onPress(x, () => this.toggleBook());
  }

  private closeDom(): void {
    this.preview?.stop();
    this.preview = null;
    if (this.touchPress) clearTimeout(this.touchPress.timer);
    this.touchPress = null;
    window.removeEventListener("pointerup", this.releaseBound);
    window.removeEventListener("pointercancel", this.cancelBound);
    window.removeEventListener("resize", this.relayoutBound);
    window.removeEventListener("guiscale", this.relayoutBound);
    this.screen?.remove();
    this.screen = null;
    this.wrap = null;
    this.panel = null;
    this.layout = null;
    this.slotEls = [];
    this.ghosts.clear();
    this.cursorEl = null;
    this.tipEl = null;
    this.flame = this.arrow = null;
    this.recipesEl = null;
    this.recipeKey = "";
    this.tradeEl = null;
    this.tradeKey = "";
    this.drag = null;
    this.dragLeft = null;
    this.hover = -1;
  }

  close(): void {
    this.closeDom();
    this.menu = null;
  }
}

/** An item in a slot (inventory, hotbar or cursor): its 16 x 16 icon, the count bottom-right in white with a
 *  shadow, and the durability bar, all in GUI pixels. A count of 0 is the yellow "nothing left" of a drag. */
export function fillSlot(d: HTMLElement, st: Stack | null): void {
  d.innerHTML = "";
  if (!st) return;
  const ic = itemIcon(st.id);
  ic.className = "ic";
  d.appendChild(ic);
  const max = maxDurability(st.id);
  if (max && st.d > 0) {
    const bar = el("div", "dur", d as HTMLDivElement);
    bar.style.backgroundImage = `url(${durabilityImage(1 - st.d / max)})`;
  }
  if (st.n > 1 || st.n === 0) {
    const cnt = el("div", "cnt", d as HTMLDivElement);
    cnt.style.backgroundImage = `url(${st.n === 0 ? countImage(0, "#ffff55") : countImage(st.n)})`;
  }
}
