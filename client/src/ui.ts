// DOM user interface in $STEVE Craft's look (the classic grey bevelled buttons, dirt screens, the KenneyMini pixel font,
// yellow highlights): the title card, pause and options, loading and error screens, the "what's new" toast, the
// player list with the charity meter, chat, the creative block picker and the survival screens (death, sleeping, the
// safe-zone toast, first-join tips). The in-game HUD is native pixel art (pixel-gui.ts): the classic hotbar strip and
// selection box with counts and durability, hearts/food/air, the held item's name in our pixel font.

import { BLOCKS, PICKER_ORDER, TEX } from "../../shared/blocks.ts";
import { CHAT_MAX } from "../../shared/constants.ts";
import { HUD_ARMOR, HUD_BUBBLE, HUD_FOOD, HUD_HEART } from "../../shared/item-textures.ts";
import { itemName, type Stack } from "../../shared/items.ts";
import type { CharityInfo, Stats } from "../../shared/protocol.ts";
import type { Settings } from "./settings.ts";
import { fillSlot } from "./inventory-ui.ts";
import { textEl } from "./pixel-font.ts";
import { attackBarImage, attackReadyImage, hotbarImage, selectionImage, updateGuiScale } from "./pixel-gui.ts";
import { blockIcon, layerCanvas } from "./render/textures.ts";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, parent?: HTMLElement, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  if (parent) parent.appendChild(e);
  return e;
}

/** The "$STEVE Craft" logo in the pixel font, with its yellow splash line. */
function logo(parent: HTMLElement, cls: string, splash = "Now survival!"): HTMLDivElement {
  const box = el("div", `logo ${cls}`, parent);
  el("div", "logo-word", box, "$STEVE Craft");
  if (splash) el("div", "splash", box, splash);
  return box;
}

export interface UIActions {
  resume(): void;
  backToTitle(): void;
  sendChat(text: string): void;
  chatClosed(): void;
  pickerClosed(): void;
  pickBlock(slot: number, id: number): void;
  settingsChanged(s: Settings): void;
  retry(): void;
  playTouch(): void;
  playDesktop(): void;
  click?(): void;
  // v11 voice chat
  voiceInfo(): { serverOn: boolean; mic: string; adminMuted: boolean; supported: boolean };
  /** Turn voice (the microphone) on or off: true if it is on now. */
  voiceMic(on: boolean): Promise<boolean>;
  voicePlayers(): { id: number; name: string; muted: boolean; talking: boolean }[];
  voiceMute(name: string, on: boolean): void;
}

/** v11: what the HUD's voice pill shows (null: voice off). */
export interface VoiceHud {
  talking: boolean;
  openMic: boolean;
  adminMuted: boolean;
  level: number;
  touch: boolean;
}

export interface WhatsNew {
  n: number;
  date: string;
  title: string;
  line: string;
  image: string;
}

interface ChatLine {
  el: HTMLDivElement;
  at: number;
}

export class UI {
  readonly root: HTMLElement;
  private actions: UIActions;
  private hud: HTMLDivElement;
  private hotbarEl: HTMLDivElement;
  private slots: HTMLDivElement[] = [];
  private heldName: HTMLDivElement;
  private selEl: HTMLDivElement;
  private heldTimer = 0;
  private serverEl: HTMLDivElement;
  private debugEl: HTMLDivElement;
  private noticeEl: HTMLDivElement;
  private noticeTimer = 0;
  private chatEl: HTMLDivElement;
  private chatLines: ChatLine[] = [];
  private chatInputWrap: HTMLDivElement;
  private chatInput: HTMLInputElement;
  private chatHistory: string[] = [];
  private historyPos = -1;
  private tabEl: HTMLDivElement;
  private waterEl: HTMLDivElement;
  private screen: HTMLDivElement | null = null;
  private tooltip: HTMLDivElement;
  private clickEl: HTMLDivElement;
  private titleEl: HTMLDivElement;
  private toastEl: HTMLDivElement | null = null;
  private statsEl: HTMLDivElement;
  private attackEl: HTMLDivElement;
  private attackKey = "";
  private hurtEl: HTMLDivElement;
  private sleepEl: HTMLDivElement;
  private sleepBar: HTMLDivElement;
  private zoneEl: HTMLDivElement;
  private zoneTimer = 0;
  private statsKey = "";
  private voiceEl: HTMLDivElement;
  private dirtUrl = "";
  chatOpen = false;
  pickerOpen = false;
  charity: CharityInfo | null = null;

  constructor(root: HTMLElement, actions: UIActions) {
    this.root = root;
    this.actions = actions;
    this.setGuiScale();
    window.addEventListener("resize", () => this.setGuiScale());
    this.dirtUrl = layerCanvas(TEX.dirt, 0.3).toDataURL();

    this.hud = el("div", "hud hidden", root);
    el("div", "crosshair", this.hud);
    this.attackEl = el("div", "attackind hidden", this.hud);
    this.hotbarEl = el("div", "hotbar", this.hud);
    this.hotbarEl.style.backgroundImage = `url(${hotbarImage()})`;
    for (let i = 0; i < 9; i++) {
      const sl = el("div", "slot", this.hotbarEl);
      sl.style.left = `calc(var(--s) * ${3 + i * 20})`;
      this.slots.push(sl);
    }
    this.selEl = el("div", "hsel", this.hotbarEl);
    this.selEl.style.backgroundImage = `url(${selectionImage()})`;
    this.placeSel(0);
    this.statsEl = el("div", "stats", this.hud);
    this.heldName = el("div", "helditem", this.hud);
    this.serverEl = el("div", "serverinfo", this.hud);
    this.debugEl = el("div", "debug hidden", this.hud);
    this.noticeEl = el("div", "notice", this.hud);
    this.voiceEl = el("div", "voicepill hidden", this.hud);
    this.waterEl = el("div", "underwater hidden", root);
    root.prepend(this.waterEl);
    this.chatEl = el("div", "chat", root);
    this.chatInputWrap = el("div", "chatinput hidden", root);
    this.chatInput = el("input", "", this.chatInputWrap);
    this.chatInput.maxLength = CHAT_MAX;
    this.chatInput.spellcheck = false;
    this.chatInput.autocomplete = "off";
    this.chatInput.placeholder = "Say something nice, or / for commands";
    this.chatInput.addEventListener("keydown", (e) => this.onChatKey(e));
    this.tabEl = el("div", "tablist hidden", root);
    this.tooltip = el("div", "tooltip hidden", root);
    this.clickEl = el("div", "clicktoplay hidden", root);
    this.titleEl = el("div", "titlecard hidden", root);
    this.hurtEl = el("div", "hurtflash", root);
    root.prepend(this.hurtEl);
    this.sleepEl = el("div", "sleepveil", root);
    this.sleepBar = el("div", "sleepbar hidden", root);
    this.zoneEl = el("div", "zonetoast", root);
  }

  /** One GUI pixel for the pixel-art parts (hotbar, HUD, the in-game windows): the automatic GUI scale in whole
   *  device pixels (pixel-gui.ts). Watches the display's pixel ratio too (a window dragged to another monitor). */
  setGuiScale(): void {
    updateGuiScale();
    // Text and panels (sized in rem) grow with the window: 16 px up to 960 px tall, 24 px at 1440 px.
    const u = Math.max(0.875, Math.min(1.6, Math.min(window.innerHeight / 960, window.innerWidth / 1500)));
    document.documentElement.style.fontSize = `${(16 * u).toFixed(2)}px`;
    this.dprWatch?.removeEventListener("change", this.onDpr);
    this.dprWatch = matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    this.dprWatch.addEventListener("change", this.onDpr);
  }

  private dprWatch: MediaQueryList | null = null;
  private onDpr = () => {
    this.setGuiScale();
    window.dispatchEvent(new Event("guiscale"));
  };

  showHud(on: boolean): void {
    this.hud.classList.toggle("hidden", !on);
  }

  // ---------------------------------------------------------------- hotbar

  setHotbar(stacks: (Stack | null)[], selected: number): void {
    stacks.forEach((st, i) => {
      const s = this.slots[i];
      if (!s) return;
      const key = st ? `${st.id}:${st.n}:${st.d}` : "";
      if (s.dataset.key !== key) {
        s.dataset.key = key;
        fillSlot(s, st);
      }
      s.classList.toggle("sel", i === selected);
    });
    this.placeSel(selected);
  }

  /** The selection box over hotbar slot `i` (it is 24 GUI pixels, one wider than the cell on each side). */
  private placeSel(i: number): void {
    this.selEl.style.left = `calc(var(--s) * ${-2 + i * 20})`;
  }

  selectSlot(selected: number, id: number): void {
    this.slots.forEach((s, i) => s.classList.toggle("sel", i === selected));
    this.placeSel(selected);
    this.heldName.innerHTML = "";
    if (id) this.heldName.appendChild(textEl(itemName(id), "#ffffff", "#3f3f3f"));
    this.heldName.style.opacity = "1";
    clearTimeout(this.heldTimer);
    this.heldTimer = window.setTimeout(() => (this.heldName.style.opacity = "0"), 2000);
  }

  setServer(text: string): void {
    this.serverEl.innerHTML = "";
    el("span", "dot", this.serverEl);
    this.serverEl.appendChild(document.createTextNode(text));
  }

  setDebug(lines: string[] | null): void {
    this.debugEl.classList.toggle("hidden", !lines);
    if (!lines) return;
    this.debugEl.innerHTML = "";
    for (const l of lines) el("div", "", this.debugEl, l);
  }

  notice(text: string): void {
    this.noticeEl.textContent = text;
    this.noticeEl.style.opacity = "1";
    clearTimeout(this.noticeTimer);
    this.noticeTimer = window.setTimeout(() => (this.noticeEl.style.opacity = "0"), 3500);
  }

  setUnderwater(on: boolean): void {
    this.waterEl.classList.toggle("hidden", !on);
  }

  /** "Click to play" hint after a menu closes (a small pill over the world). */
  setClickToPlay(on: boolean, text = "Click to play"): void {
    this.clickEl.textContent = text;
    this.clickEl.classList.toggle("hidden", !on);
  }

  /** The title card over the live world, shown once on joining (before the first click captures the mouse). */
  showTitle(on: boolean, serverLine = "", touch = false): void {
    this.titleEl.classList.toggle("hidden", !on);
    if (!on) return;
    this.titleEl.innerHTML = "";
    const box = el("div", "title-box", this.titleEl);
    logo(box, "title-logo");
    el("p", "title-sub", box, "One shared world: survive and build with everyone.");
    el("div", "btn big", box, touch ? "Tap to play" : "Click to play");
    el("p", "title-server", box, serverLine);
    if (!touch) {
      const keys = el("div", "title-keys", box);
      for (const [k, v] of [
        ["WASD", "move"],
        ["Space", "jump"],
        ["Left click", "break"],
        ["Right click", "place"],
        ["E", "inventory"],
        ["T", "chat"],
      ]) {
        const span = el("span", "", keys);
        el("kbd", "", span, k);
        span.appendChild(document.createTextNode(v));
      }
    }
  }

  /** "Now playing" line when a music piece starts: small, bottom left above the chat, fades away. */
  nowPlaying(title: string): void {
    const t = el("div", "nowplaying", this.root);
    el("span", "note", t, "♪");
    t.appendChild(document.createTextNode(title));
    requestAnimationFrame(() => t.classList.add("in"));
    window.setTimeout(() => {
      t.classList.remove("in");
      window.setTimeout(() => t.remove(), 900);
    }, 5000);
  }

  // ---------------------------------------------------------------- survival HUD

  /** Hearts, food and (under water) air above the hotbar; v6: armour above the hearts when you wear any, and a
   *  sickly green food bar while queasy. Health can be fractional (armour): shown rounded up, like Java. Hidden in
   *  creative. */
  setStats(st: Stats, survival: boolean, armor = 0): void {
    this.root.classList.toggle("creative", !survival);
    const key = `${st.hp},${st.food},${st.air},${survival},${armor},${st.queasy ? 1 : 0}`;
    if (key === this.statsKey) return;
    this.statsKey = key;
    const box = this.statsEl;
    box.innerHTML = "";
    const hpShown = Math.ceil(st.hp - 1e-6);
    box.classList.toggle("low", hpShown <= 4 && hpShown > 0);
    const row = (cls: string) => el("div", `row ${cls}`, box);
    const hp = row("hp");
    for (let k = 0; k < 10; k++) {
      const v = hpShown - k * 2;
      icon(hp, v >= 2 ? "heart_full" : v === 1 ? "heart_half" : "heart_empty");
    }
    if (armor > 0) {
      const ar = row("armor");
      for (let k = 0; k < 10; k++) {
        const v = armor - k * 2;
        icon(ar, v >= 2 ? "armor_full" : v === 1 ? "armor_half" : "armor_empty");
      }
    }
    const food = row("right food");
    const q = st.queasy ? "q" : "";
    for (let k = 0; k < 10; k++) {
      const v = st.food - k * 2;
      icon(food, v >= 2 ? `food_full${q}` : v === 1 ? `food_half${q}` : "food_empty");
    }
    if (st.air < 300) {
      const air = row("right air");
      const full = Math.ceil((st.air * 10) / 300);
      for (let k = 0; k < 10; k++) if (k < full) icon(air, "bubble");
    }
  }

  /** v6: the attack indicator under the crosshair: the bar while a swing recharges, a spark when charged and aimed
   *  at something in reach. */
  setAttack(strength: number, ready: boolean): void {
    const show = strength < 0.999 || ready;
    const key = show ? (strength < 0.999 ? `b${Math.round(strength * 16)}` : "r") : "";
    if (key === this.attackKey) return;
    this.attackKey = key;
    this.attackEl.classList.toggle("hidden", !show);
    if (!show) return;
    const bar = strength < 0.999;
    this.attackEl.classList.toggle("ready", !bar);
    this.attackEl.style.backgroundImage = `url(${bar ? attackBarImage(strength * 16) : attackReadyImage()})`;
  }

  /** A red flash at the edges of the screen when you take damage. */
  hurtFlash(): void {
    this.hurtEl.classList.add("on");
    requestAnimationFrame(() => requestAnimationFrame(() => this.hurtEl.classList.remove("on")));
  }

  showDeath(msg: string, respawn: () => void, home: () => void): void {
    const s = el("div", "screen dead");
    const box = el("div", "dead-box", s);
    el("h1", "", box, "You died!");
    el("p", "", box, msg);
    el("p", "", box, "Everything you carried is where you fell. It stays there for 5 minutes.");
    const row = el("div", "buttons", box);
    this.button(row, "Respawn", respawn);
    this.button(row, "Title Screen", home);
    this.setScreen(s);
  }

  /** clankersmp: the AI a spectator watches died (in hardcore, for good). No buttons: nobody here can respawn it. */
  showGameOver(msg: string): void {
    const s = el("div", "screen dead");
    const box = el("div", "dead-box", s);
    el("h1", "", box, "Game over!");
    el("p", "", box, msg);
    this.setScreen(s);
  }

  /** Lying in bed: the screen fades to night-dark; a button to get up. */
  setSleep(on: boolean, text = "", leave?: () => void): void {
    this.sleepEl.classList.toggle("on", on);
    this.sleepBar.classList.toggle("hidden", !on);
    if (!on) return;
    this.sleepBar.innerHTML = "";
    el("p", "", this.sleepBar, text);
    if (leave) this.button(this.sleepBar, "Leave Bed", leave);
  }

  setSleepText(text: string): void {
    const p = this.sleepBar.querySelector("p");
    if (p) p.textContent = text;
  }

  /** Crossing the spawn border. */
  zoneToast(inside: boolean): void {
    const z = this.zoneEl;
    z.innerHTML = "";
    z.classList.toggle("wild", !inside);
    z.textContent = inside ? "Spawn · safe zone: no damage, no building" : "You left spawn · the wild isn't safe at night";
    z.classList.add("in");
    clearTimeout(this.zoneTimer);
    this.zoneTimer = window.setTimeout(() => z.classList.remove("in"), 3500);
  }

  /** First time on the server: how survival starts. */
  survivalTips(): void {
    const t = el("div", "tipcard", this.root);
    el("h3", "", t, "Survival: how to start");
    const ol = el("ol", "", t);
    for (const line of [
      "Punch a tree (hold left click) for logs.",
      "Press E: turn logs into planks, then 4 planks into a crafting table.",
      "Place the table, make a wooden pickaxe, then mine stone for better tools.",
      "Find coal for torches before night. Spawn is safe; the wild isn't.",
    ])
      el("li", "", ol, line);
    el("p", "k", t, "Hungry? Hold right click to eat. Your 3 apples are on the hotbar.");
    requestAnimationFrame(() => t.classList.add("in"));
    window.setTimeout(() => {
      t.classList.remove("in");
      window.setTimeout(() => t.remove(), 700);
    }, 20000);
  }

  // ---------------------------------------------------------------- what's new

  /** A small card in the top-left corner: the latest update, shown once per update on joining. */
  whatsNew(u: WhatsNew): void {
    this.toastEl?.remove();
    const t = el("div", "toast", this.root);
    const img = el("img", "toast-img", t);
    img.src = u.image;
    img.alt = "";
    const body = el("div", "toast-body", t);
    el("p", "toast-kicker", body, `What's new · Update ${u.n}`);
    el("p", "toast-title", body, u.title);
    el("p", "toast-line", body, u.line);
    this.toastEl = t;
    requestAnimationFrame(() => t.classList.add("in"));
    window.setTimeout(() => {
      t.classList.remove("in");
      window.setTimeout(() => t.remove(), 600);
    }, 12000);
  }

  // ---------------------------------------------------------------- chat

  addChat(parts: { text: string; cls?: string }[]): void {
    const line = el("div", "line", this.chatEl);
    for (const p of parts) el("span", p.cls ?? "", line, p.text);
    this.chatLines.push({ el: line, at: performance.now() });
    while (this.chatLines.length > 100) this.chatLines.shift()!.el.remove();
    this.tickChat();
  }

  /** Fade lines after 10 s; show the last 10 (20 while chat is open). */
  tickChat(): void {
    const now = performance.now();
    const visible = this.chatOpen ? 20 : 10;
    this.chatLines.forEach((l, i) => {
      const recent = i >= this.chatLines.length - visible;
      l.el.style.display = recent ? "" : "none";
      l.el.classList.toggle("fade", !this.chatOpen && now - l.at > 10000);
    });
  }

  openChat(prefix = ""): void {
    this.chatOpen = true;
    this.chatEl.classList.add("open");
    this.chatInputWrap.classList.remove("hidden");
    this.chatInput.value = prefix;
    this.historyPos = -1;
    setTimeout(() => {
      this.chatInput.focus();
      this.chatInput.setSelectionRange(prefix.length, prefix.length);
    }, 0);
    this.tickChat();
  }

  closeChat(): void {
    this.chatOpen = false;
    this.chatEl.classList.remove("open");
    this.chatInputWrap.classList.add("hidden");
    this.chatInput.blur();
    this.tickChat();
  }

  private onChatKey(e: KeyboardEvent): void {
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      const text = this.chatInput.value.trim();
      if (text) {
        this.actions.sendChat(text);
        this.chatHistory.push(text);
        if (this.chatHistory.length > 50) this.chatHistory.shift();
      }
      this.closeChat();
      this.actions.chatClosed();
    } else if (e.key === "Escape") {
      e.preventDefault();
      this.closeChat();
      this.actions.chatClosed();
    } else if (e.key === "ArrowUp" && this.chatHistory.length) {
      e.preventDefault();
      this.historyPos = this.historyPos < 0 ? this.chatHistory.length - 1 : Math.max(0, this.historyPos - 1);
      this.chatInput.value = this.chatHistory[this.historyPos];
    } else if (e.key === "ArrowDown" && this.historyPos >= 0) {
      e.preventDefault();
      this.historyPos++;
      if (this.historyPos >= this.chatHistory.length) {
        this.historyPos = -1;
        this.chatInput.value = "";
      } else this.chatInput.value = this.chatHistory[this.historyPos];
    }
  }

  // ---------------------------------------------------------------- player list

  private tabKey = "";

  showTab(on: boolean, serverName = "", names: string[] = [], me = "", cap = 50, charity: CharityInfo | null = null, talking: Set<string> = new Set(), muted: Set<string> = new Set()): void {
    this.tabEl.classList.toggle("hidden", !on);
    if (!on) {
      this.tabKey = "";
      return;
    }
    // Called every frame while Tab is held: rebuild only when something changed.
    const key = JSON.stringify([serverName, names, me, cap, charity, [...talking], [...muted]]);
    if (key === this.tabKey) return;
    this.tabKey = key;
    this.tabEl.innerHTML = "";
    const head = el("div", "head", this.tabEl);
    el("span", "", head, serverName);
    el("span", "count", head, `${names.length}/${cap} players`);
    const grid = el("div", "grid", this.tabEl);
    for (const n of names) {
      const row = el("div", [n === me ? "me" : "", talking.has(n) ? "talking" : "", muted.has(n) ? "muted" : ""].filter(Boolean).join(" "), grid, n);
      if (talking.has(n) && !muted.has(n)) row.title = "Talking";
      if (muted.has(n)) row.title = "Muted (voice)";
    }
    if (charity) this.charityMeter(this.tabEl, charity);
  }

  /** v11: the mic pill: "Hold V to talk", "Talking" with a level meter, "Open mic", or the admin's mute. */
  setVoice(v: VoiceHud | null): void {
    this.voiceEl.classList.toggle("hidden", !v);
    if (!v) return;
    this.voiceEl.classList.toggle("live", v.talking);
    this.voiceEl.classList.toggle("blocked", v.adminMuted);
    this.voiceEl.innerHTML = "";
    el("span", "mic", this.voiceEl);
    const text = v.adminMuted ? "Voice muted by an admin" : v.talking ? "Talking" : v.openMic ? "Open mic" : v.touch ? "Hold Talk to speak" : "Hold V to talk";
    el("span", "", this.voiceEl, text);
    const meter = el("span", "meter", this.voiceEl);
    el("span", "", meter).style.width = `${Math.round(Math.min(1, v.level) * 100)}%`;
  }

  /** "Raised for @GamersOutreach": the coin's on-chain total, read by the server about once a minute. */
  private charityMeter(parent: HTMLElement, c: CharityInfo): void {
    const box = el("div", "charity", parent);
    const title = el("div", "ctitle", box, "Raised for ");
    el("span", "", title, c.x ? `@${c.x}` : c.name || "charity");
    const bar = el("div", "bar", box);
    const fill = el("div", "fill", bar);
    const label = el("div", "amount", bar);
    if (c.state === "live" && typeof c.totalSol === "number") {
      const total = c.totalSol;
      const next = MILESTONES.find((m) => m > total) ?? Math.ceil(total / 10_000 + 1) * 10_000;
      fill.style.width = `${Math.max(2, Math.min(100, (total / next) * 100))}%`;
      label.textContent = `${fmtSol(total)} SOL`;
      const parts: string[] = [];
      if ((c.donatedSol ?? 0) > 0) parts.push(`${fmtSol(c.donatedSol ?? 0)} donated`);
      if ((c.pendingSol ?? 0) > 0) parts.push(`${fmtSol(c.pendingSol ?? 0)} on its way`);
      parts.push(`next milestone ${next.toLocaleString("en-US")} SOL`);
      el("div", "sub", box, parts.join(" · "));
    } else {
      fill.style.width = "0%";
      label.textContent = c.state === "prelaunch" ? "Starts at launch" : "Total not available yet";
    }
  }

  // ---------------------------------------------------------------- screens

  private setScreen(s: HTMLDivElement | null): void {
    this.screen?.remove();
    this.screen = s;
    if (s) this.root.appendChild(s);
  }

  get screenOpen(): boolean {
    return this.screen !== null;
  }

  closeScreen(): void {
    this.setScreen(null);
    this.pickerOpen = false;
    this.tooltip.classList.add("hidden");
  }

  /** Full-screen dirt page with the logo: loading, errors, the phone screen (like the classic menus). */
  private paperScreen(): { s: HTMLDivElement; col: HTMLDivElement } {
    const s = el("div", "screen dirt");
    s.style.backgroundImage = `url(${this.dirtUrl})`;
    const col = el("div", "col", s);
    logo(col, "screen-logo", "");
    el("div", "paper-foot", s, "$STEVE Craft · charity coin partnered with @GamersOutreach · stevepumpfun.com");
    return { s, col };
  }

  private button(parent: HTMLElement, label: string, onClick: () => void, cls = "btn"): HTMLButtonElement {
    const b = el("button", cls, parent, label);
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      this.actions.click?.();
      onClick();
    });
    return b;
  }

  showLoading(title: string, status: string, progress: number | null): void {
    let s = this.screen;
    if (!s || !s.dataset.loading) {
      const p = this.paperScreen();
      s = p.s;
      s.dataset.loading = "1";
      el("h1", "title", p.col);
      el("p", "status", p.col);
      const bar = el("div", "progress", p.col);
      el("div", "", bar);
      this.setScreen(s);
    }
    (s.querySelector(".title") as HTMLElement).textContent = title;
    (s.querySelector(".status") as HTMLElement).textContent = status;
    const bar = s.querySelector(".progress") as HTMLElement;
    bar.style.visibility = progress === null ? "hidden" : "visible";
    (bar.firstElementChild as HTMLElement).style.width = `${Math.round((progress ?? 0) * 100)}%`;
  }

  showMessage(title: string, detail: string, buttons: { label: string; onClick: () => void }[]): void {
    const { s, col } = this.paperScreen();
    el("h1", "", col, title);
    el("p", "detail", col, detail);
    const row = el("div", "buttons", col);
    buttons.forEach((b) => this.button(row, b.label, b.onClick));
    this.setScreen(s);
  }

  setMessageDetail(text: string): void {
    const d = this.screen?.querySelector(".detail");
    if (d) d.textContent = text;
  }

  private card(title: string): { s: HTMLDivElement; card: HTMLDivElement } {
    const s = el("div", "screen dim");
    const card = el("div", "card", s);
    const head = el("div", "card-head", card);
    el("h1", "", head, title);
    return { s, card };
  }

  showPause(settings: Settings, serverLine: string): void {
    const { s, card } = this.card("Game Menu");
    this.button(card, "Back to Game", () => this.actions.resume());
    this.button(card, "Options...", () => this.showSettings(settings, serverLine));
    this.button(card, "Back to Title Screen", () => this.actions.backToTitle());
    const foot = el("div", "card-foot", card);
    el("p", "server", foot, serverLine);
    if (this.charity) el("p", "charity-line", foot, charityLine(this.charity));
    xLink(foot, "Updates on X: @SteveOnPF");
    this.setScreen(s);
  }

  showSettings(settings: Settings, serverLine: string): void {
    const { s, card } = this.card("Options");
    card.classList.add("wide");
    const grid = el("div", "settings-grid", card);
    const save = () => this.actions.settingsChanged(settings);
    this.slider(grid, "FOV", (v) => `${Math.round(v)}`, settings.fov, 30, 110, 1, (v) => {
      settings.fov = v;
      save();
    });
    this.slider(grid, "Sensitivity", (v) => `${Math.round(v * 100)}%`, settings.sensitivity, 0.1, 2, 0.01, (v) => {
      settings.sensitivity = v;
      save();
    });
    this.slider(grid, "Sounds", (v) => `${Math.round(v * 100)}%`, settings.volume, 0, 1, 0.01, (v) => {
      settings.volume = v;
      save();
    });
    this.slider(grid, "Music", (v) => (v < 0.005 ? "Off" : `${Math.round(v * 100)}%`), settings.music ?? 0.5, 0, 1, 0.01, (v) => {
      settings.music = v;
      save();
    });
    this.slider(grid, "Render Distance", (v) => `${Math.round(v)} chunks`, settings.renderDistance, 2, 16, 1, (v) => {
      settings.renderDistance = Math.round(v);
      save();
    });
    this.slider(grid, "Brightness", (v) => (v < 0.05 ? "Moody" : v > 0.95 ? "Bright" : `+${Math.round(v * 100)}%`), settings.brightness, 0, 1, 0.01, (v) => {
      settings.brightness = v;
      save();
    });
    this.toggle(grid, "View Bobbing", settings.bobbing, (v) => {
      settings.bobbing = v;
      save();
    });
    // v11: voice chat
    const vi = this.actions.voiceInfo();
    el("h2", "settings-head", card, "Voice Chat");
    const vgrid = el("div", "settings-grid", card);
    if (!vi.serverOn) el("p", "settings-note", vgrid, "Voice chat is off on this server.");
    else if (!vi.supported) el("p", "settings-note", vgrid, "This browser can't use a microphone here.");
    else {
      const setMic = this.toggle(vgrid, "Microphone", vi.mic === "on", (v) => {
        void this.actions.voiceMic(v).then((on) => {
          if (on !== v) setMic(on);
        });
      });
      if (vi.adminMuted) el("p", "settings-note", vgrid, "An admin turned your voice off.");
    }
    this.toggle(vgrid, "Open Mic", settings.voiceOpenMic, (v) => {
      settings.voiceOpenMic = v;
      save();
    });
    this.toggle(vgrid, "Hear Voices", settings.voiceHear, (v) => {
      settings.voiceHear = v;
      save();
    });
    this.slider(vgrid, "Voice Volume", (v) => `${Math.round(v * 100)}%`, settings.voiceVolume, 0, 1, 0.01, (v) => {
      settings.voiceVolume = v;
      save();
    });
    el("p", "settings-note", card, "Open Mic off: hold V to talk.");
    this.button(card, "Mute or Unmute Players...", () => this.showVoicePlayers(settings, serverLine));
    this.button(card, "Done", () => this.showPause(settings, serverLine));
    this.setScreen(s);
  }

  /** v11: everyone on the server, with a mute button each (kept by name). */
  showVoicePlayers(settings: Settings, serverLine: string): void {
    const { s, card } = this.card("Voice: Players");
    card.classList.add("wide");
    const list = el("div", "voice-players", card);
    const players = this.actions.voicePlayers();
    if (!players.length) el("p", "settings-note", list, "Nobody else is on this server right now.");
    for (const p of players) {
      const row = el("div", `vrow${p.talking ? " talking" : ""}`, list);
      el("span", "vname", row, p.name);
      let muted = p.muted;
      const b = el("button", `vmute${muted ? " on" : ""}`, row, muted ? "Muted" : "Mute");
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        this.actions.click?.();
        muted = !muted;
        this.actions.voiceMute(p.name, muted);
        b.classList.toggle("on", muted);
        b.textContent = muted ? "Muted" : "Mute";
      });
    }
    this.button(card, "Back", () => this.showSettings(settings, serverLine));
    this.setScreen(s);
  }

  /** A classic option button ("View Bobbing: ON"); returns a setter (to put it back when the change didn't take,
   *  like a refused microphone). */
  private toggle(parent: HTMLElement, name: string, value: boolean, onChange: (v: boolean) => void): (v: boolean) => void {
    const row = el("button", "btn toggle", parent);
    const show = () => (row.textContent = `${name}: ${value ? "ON" : "OFF"}`);
    show();
    row.addEventListener("click", (e) => {
      e.stopPropagation();
      this.actions.click?.();
      value = !value;
      show();
      onChange(value);
    });
    return (v: boolean) => {
      value = v;
      show();
    };
  }

  /** A classic slider: a dark track with the knob, its label ("FOV: 70") written across it. */
  private slider(parent: HTMLElement, name: string, label: (v: number) => string, value: number, min: number, max: number, step: number, onChange: (v: number) => void): void {
    const wrap = el("div", "slider", parent);
    const knob = el("div", "knob", wrap);
    const lab = el("div", "label", wrap);
    const set = (v: number) => {
      v = Math.round(v / step) * step;
      v = Math.max(min, Math.min(max, v));
      const f = (v - min) / (max - min);
      knob.style.left = `calc(${f * 100}% - ${f} * var(--s) * 8)`;
      lab.textContent = `${name}: ${label(v)}`;
      return v;
    };
    set(value);
    const fromEvent = (e: PointerEvent) => {
      const r = wrap.getBoundingClientRect();
      const f = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
      onChange(set(min + f * (max - min)));
    };
    wrap.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      wrap.setPointerCapture(e.pointerId);
      fromEvent(e);
      const move = (ev: PointerEvent) => fromEvent(ev);
      const up = () => {
        wrap.removeEventListener("pointermove", move);
        wrap.removeEventListener("pointerup", up);
      };
      wrap.addEventListener("pointermove", move);
      wrap.addEventListener("pointerup", up);
    });
  }

  showPicker(hotbar: number[], selected: number): void {
    this.pickerOpen = true;
    const s = el("div", "screen dim");
    const panel = el("div", "card picker", s);
    const head = el("div", "card-head", panel);
    el("h1", "", head, "Creative Blocks");
    const grid = el("div", "grid", panel);
    let hover = -1;
    el("p", "hot-label", panel, "Your hotbar");
    const hot = el("div", "grid hotrow", panel);
    const drawHot = () => {
      hot.innerHTML = "";
      hotbar.forEach((id, i) => {
        const c = el("div", `cell${i === selected ? " sel" : ""}`, hot);
        if (id) c.appendChild(blockIcon(id));
        c.addEventListener("click", (e) => {
          e.stopPropagation();
          selected = i;
          drawHot();
        });
        this.tip(c, () => BLOCKS[hotbar[i]]?.name ?? "");
      });
    };
    for (const id of PICKER_ORDER) {
      const c = el("div", "cell", grid);
      c.appendChild(blockIcon(id));
      c.addEventListener("mouseenter", () => (hover = id));
      c.addEventListener("mouseleave", () => (hover = -1));
      c.addEventListener("click", (e) => {
        e.stopPropagation();
        hotbar[selected] = id;
        this.actions.pickBlock(selected, id);
        drawHot();
      });
      this.tip(c, () => BLOCKS[id].name);
    }
    drawHot();
    el("p", "hint", panel, "Click a block to put it in the highlighted slot. Hover + 1-9 also works. E or Esc closes.");
    s.addEventListener("click", (e) => {
      if (e.target === s) this.actions.pickerClosed();
    });
    (s as HTMLDivElement & { hoverId?: () => number }).hoverId = () => hover;
    this.setScreen(s);
  }

  pickerHover(): number {
    const s = this.screen as (HTMLDivElement & { hoverId?: () => number }) | null;
    return s?.hoverId ? s.hoverId() : -1;
  }

  private tip(target: HTMLElement, text: () => string): void {
    target.addEventListener("mousemove", (e) => {
      this.tooltip.textContent = text();
      this.tooltip.classList.toggle("hidden", !this.tooltip.textContent);
      this.tooltip.style.left = `${e.clientX + 14}px`;
      this.tooltip.style.top = `${e.clientY - 30}px`;
    });
    target.addEventListener("mouseleave", () => this.tooltip.classList.add("hidden"));
  }

  showMobile(): void {
    const { s, col } = this.paperScreen();
    el("h1", "", col, "Best with a keyboard and mouse");
    el("p", "detail", col, "$STEVE Craft is one shared survival world you play right in the browser. It plays best on a desktop or laptop.");
    const row = el("div", "buttons", col);
    this.button(row, "Play with keyboard and mouse", () => this.actions.playDesktop());
    this.button(row, "Try touch controls", () => this.actions.playTouch());
    this.button(row, "Back to Title Screen", () => this.actions.backToTitle());
    xLink(col, "Updates on X: @SteveOnPF");
    this.setScreen(s);
  }
}

// ---------------------------------------------------------------- HUD icons (9x9 pixel art, drawn once)

const iconUrls = new Map<string, string>();

function drawIcon(mask: string[], fill: Record<string, string>, half = false): string {
  const c = document.createElement("canvas");
  c.width = c.height = 9;
  const ctx = c.getContext("2d")!;
  for (let y = 0; y < 9; y++)
    for (let x = 0; x < 9; x++) {
      let ch = mask[y][x];
      if (ch === ".") continue;
      if (half && x > 4 && ch !== "o") ch = "e";
      const col = fill[ch];
      if (!col) continue;
      ctx.fillStyle = col;
      ctx.fillRect(x, y, 1, 1);
    }
  return c.toDataURL();
}

function iconUrl(name: string): string {
  let u = iconUrls.get(name);
  if (u) return u;
  const heart = { o: "#2a0b08", "#": "#e2252b", h: "#ffb3b0", e: "#5a2622" };
  const heartEmpty = { o: "#2a0b08", "#": "#3d1714", h: "#3d1714", e: "#3d1714" };
  const food = { o: "#2b1608", "#": "#c4742e", h: "#f0b06a", w: "#f2ede2", e: "#4a3020" };
  const queasy = { o: "#17240b", "#": "#7e9a3a", h: "#b9d36a", w: "#dfe8c8", e: "#33401f" };
  const armor = { o: "#15171c", "#": "#c3c8d2", h: "#ffffff", e: "#363a44" };
  const armorEmpty = { o: "#15171c", "#": "#2a2d35", h: "#2a2d35", e: "#2a2d35" };
  const foodEmpty = { o: "#2b1608", "#": "#3c2a1c", h: "#3c2a1c", w: "#3c2a1c", e: "#3c2a1c" };
  const bubble = { o: "#14324a", "#": "#5ab4f0", h: "#e6f6ff", b: "#2f86c8" };
  switch (name) {
    case "heart_full":
      u = drawIcon(HUD_HEART, heart);
      break;
    case "heart_half":
      u = drawIcon(HUD_HEART, heart, true);
      break;
    case "heart_empty":
      u = drawIcon(HUD_HEART, heartEmpty);
      break;
    case "food_full":
      u = drawIcon(HUD_FOOD, food);
      break;
    case "food_half":
      u = drawIcon(HUD_FOOD, food, true);
      break;
    case "food_empty":
      u = drawIcon(HUD_FOOD, foodEmpty);
      break;
    case "food_fullq":
      u = drawIcon(HUD_FOOD, queasy);
      break;
    case "food_halfq":
      u = drawIcon(HUD_FOOD, queasy, true);
      break;
    case "armor_full":
      u = drawIcon(HUD_ARMOR, armor);
      break;
    case "armor_half":
      u = drawIcon(HUD_ARMOR, armor, true);
      break;
    case "armor_empty":
      u = drawIcon(HUD_ARMOR, armorEmpty);
      break;
    default:
      u = drawIcon(HUD_BUBBLE, bubble);
  }
  iconUrls.set(name, u);
  return u;
}

function icon(parent: HTMLElement, name: string): void {
  const d = el("div", "ic", parent);
  d.style.backgroundImage = `url(${iconUrl(name)})`;
}

/** A link to the X account (opens in a new tab). */
function xLink(parent: HTMLElement, text: string): void {
  const a = el("a", "xlink", parent, text);
  a.href = "https://x.com/SteveOnPF";
  a.target = "_blank";
  a.rel = "noopener";
  a.addEventListener("click", (e) => e.stopPropagation());
}

const MILESTONES = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

export function charityTitle(c: CharityInfo): string {
  const who = c.name ? c.name + (c.x ? ` (@${c.x})` : "") : c.x ? `@${c.x}` : "charity";
  return `Raised for ${who}`;
}

export function charityLine(c: CharityInfo): string {
  if (c.state === "live" && typeof c.totalSol === "number") return `${charityTitle(c)}: ${fmtSol(c.totalSol)} SOL`;
  if (c.state === "prelaunch") return `The coin's fees go to ${c.name || "charity"}. The meter starts at launch.`;
  return `The coin's fees go to ${c.name || "charity"}.`;
}

export function fmtSol(v: number): string {
  if (v < 1) return v.toFixed(3);
  if (v < 100) return v.toFixed(2);
  if (v < 10_000) return v.toFixed(1);
  return Math.round(v).toLocaleString("en-US");
}
