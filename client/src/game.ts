// The game: owns the connection, the client copy of the world, the local player (20 Hz Java physics with
// render interpolation), block interaction, other players, rendering and the UI.

import * as THREE from "three";
import { B, BLOCKS, IS_WATER, ITEM_OF, RENDER, SOLID, isCake, isChest, isFurnace, isPot, isSapling, isTrapdoor, isWheat, potFor, wheatAge, type SoundGroup } from "../../shared/blocks.ts";
import {
  CROUCH_HEIGHT,
  EYE_HEIGHT,
  PLAYER_HEIGHT,
  MAX_PLAYERS_PER_SHARD,
  PROTOCOL_NAME,
  PROTOCOL_VERSION,
  ENTITY_REACH,
  REACH,
  SNEAK_EYE_HEIGHT,
  SPAWN_X,
  SPAWN_Z,
  TICK_MS,
  VOLUME,
  WORLD_HEIGHT,
  WORLD_SIZE,
  idx,
  inWorld,
} from "../../shared/constants.ts";
import { blockBelow, eyeInWater, newPhysState, playerHeight, shapeIntersectsPlayer, tickPlayer, waterSurface, type MoveInput, type PhysState } from "../../shared/physics.ts";
import { BF, BOAT_H, BOAT_W, OP_BOATS, OP_BOATS_GONE, decodeBoats, newBoat, paddles, seatPos, tickBoat, type BoatBody, type BoatInput, type BoatSnap } from "../../shared/boats.ts";
import { BoatView } from "./render/boats.ts";
import { hydratedAt } from "../../shared/farming.ts";
import { FLAG, OP, decodeBlocks, decodePlayers, encodeMove, readBlockEntries, type C2S, type GameMode, type PlayerInfo, type S2C, type ShardInfo, type Stats, type WindowKind } from "../../shared/protocol.ts";
import { Menu, newPlayerInv, type Click, type Items, type PlayerInv } from "../../shared/inventory.ts";
import { I, fromWire, isHoe, itemDef, itemName, type Stack } from "../../shared/items.ts";
import { MF, MOB_SPECS, OP_MOBS, OP_MOBS_GONE } from "../../shared/mobs.ts";
import { armorOf, attackStrength, packArmor } from "../../shared/combat.ts";
import { breakTicks } from "../../shared/mining.ts";
import { SafeZone } from "../../shared/hub12.ts";
import { EAT_TICKS, MAX_FOOD } from "../../shared/survival.ts";
import { OP_ITEMS, OP_ITEMS_GONE, OP_ITEM_PICKUP, decodeIds, decodeItems, decodePickups, type ItemSnap } from "../../shared/drops.ts";
import { DropView } from "./render/drops.ts";
import { InventoryUI } from "./inventory-ui.ts";
import updates from "virtual:updates";
import { bed, breakChanges, door, isBed, isDoor, isOpen, isOpenable, placeChanges, placementState, slabBase, toggleOpenable } from "../../shared/shapes.ts";
import { generateWorld, hashBlocks, type GenInfo } from "../../shared/worldgen.ts";
import { AF, OP_ANIMALS, OP_ANIMALS_GONE, SPECS, cellHitsAnimal, decodeAnimals, decodeGone, rayHitsBox, type AnimalSnap } from "../../shared/animals.ts";
import { AnimalView } from "./render/animals.ts";
import { MobView } from "./render/mobs.ts";
import { VillagerView } from "./render/villagers.ts";
import { OP_VILLAGERS, OP_VILLAGERS_GONE, TALK_REACH, VF, VILLAGER_H, VILLAGER_W } from "../../shared/villagers.ts";
import type { VillagerDef } from "../../shared/villages.ts";
import { ArrowView } from "./render/arrows.ts";
import { Sound } from "./audio.ts";
import { Music } from "./music.ts";
import { embedded, requestedFollow, requestedShard, requestedView, resolveServerUrl } from "./config.ts";
import { FollowCam } from "./game/follow.ts";
import { raycast, selectionBox, type Hit } from "./game/raycast.ts";
import { Net, inflateRaw } from "./net.ts";
import { ChunkManager } from "./render/chunks.ts";
import { Particles, Selection } from "./render/effects.ts";
import { Hand, heldBlockMesh } from "./render/hand.ts";
import { RemotePlayer, wrapDeg } from "./render/players.ts";
import { Scenery } from "./render/scenery.ts";
import { U, chunkMaterial, heldMaterial, waterMaterial } from "./render/shaders.ts";
import { Sky, celestialAngle } from "./render/sky.ts";
import { blockTextureArray } from "./render/textures.ts";
import { clientToken, loadSettings, rememberName, saveSettings, storedName, type Settings } from "./settings.ts";
import { UI } from "./ui.ts";
import { VoiceChat } from "./voice.ts";
import { OP_VOICE, decodeVoice } from "../../shared/voice.ts";

type State = "loading" | "play" | "paused" | "chat" | "picker" | "inventory" | "dead" | "closed";

interface Dig {
  x: number;
  y: number;
  z: number;
  id: number;
  face: number;
  progress: number;
  prev: number;
  ticks: number;
}

const DEG = Math.PI / 180;

export class Game {
  private canvas: HTMLCanvasElement;
  private ui: UI;
  private sound = new Sound();
  /** v11: proximity voice chat (client/src/voice.ts). */
  private voice!: VoiceChat;
  private voiceMutesDirty = true;
  private voiceKey = "";
  private touchTalk = false;
  private talkBtn: HTMLDivElement | null = null;
  private music = new Music();
  private settings: Settings;
  private net: Net | null = null;
  private state: State = "loading";
  private touchMode = false;

  // world
  private blocks = new Uint8Array(VOLUME);
  private info!: GenInfo;
  private worldReady = false;
  private pendingBlocks: number[] = [];
  private predicted = new Map<number, number>(); // cell -> time of our own prediction

  // rendering
  private renderer!: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(70, 1, 0.05, 700);
  private chunks!: ChunkManager;
  private sky!: Sky;
  private scenery!: Scenery;
  private selection!: Selection;
  private particles!: Particles;
  private hand!: Hand;
  private othersGroup = new THREE.Group();
  private heldMat!: THREE.ShaderMaterial;
  private atlas!: THREE.DataArrayTexture;
  private renderDist = 8;
  private frameTimes: number[] = [];
  private fps = 0;
  private lastFpsAt = 0;
  private frames = 0;
  private slowSince = 0;
  private fastSince = 0;

  // local player
  private myId = 0;
  private myName = "";
  private phys: PhysState = newPhysState(SPAWN_X, 64, SPAWN_Z);
  private prev = { x: 0, y: 0, z: 0 };
  private yaw = 180;
  private pitch = 0;
  private eye = EYE_HEIGHT;
  private prevEye = EYE_HEIGHT;
  private bob = 0;
  private prevBob = 0;
  private prevWalk = 0;
  private fovMod = 1;
  private prevFovMod = 1;
  private slot = 0;
  private keys = new Set<string>();
  private mouse = 0;
  private lastWTap = 0;
  private sprintToggle = false;
  private lastMove = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, flags: 0, held: 0, at: 0 };
  private tickCount = 0;
  private touch = { fwd: 0, strafe: 0, jump: false, sneak: false };
  private lightHere: [number, number] = [1, 0];

  // interaction
  private target: Hit | null = null;
  private dig: Dig | null = null;
  private destroyDelay = 0;
  private placeDelay = 0;

  // animals (server-owned; we interpolate and draw them)
  private animals = new Map<number, AnimalView>();
  private animalGroup = new THREE.Group();
  private animalOffset: number | null = null;
  private animalFlags = new Map<number, number>();
  private pendingAnimals: { s: AnimalSnap; t: number }[] = [];
  private animalLight = new Map<number, [number, number]>();
  private targetAnimal: AnimalView | null = null;
  private hitHeld = false;
  private myHits = new Map<number, number>(); // animal id -> when we hit it (our own hurt sound already played)
  private lastAnimalSound = 0;

  // night mobs and their arrows (v6, server-owned; we interpolate and draw them)
  private mobs = new Map<number, MobView>();
  private mobGroup = new THREE.Group();
  private mobOffset: number | null = null;
  private mobFlags = new Map<number, number>();
  private pendingMobs: { s: AnimalSnap; t: number }[] = [];
  private mobLight = new Map<number, [number, number]>();
  private targetMob: MobView | null = null;
  // v9 villagers
  private villagers = new Map<number, VillagerView>();
  private villagerGroup = new THREE.Group();
  private villagerOffset: number | null = null;
  private villagerFlags = new Map<number, number>();
  private pendingVillagers: { s: AnimalSnap; t: number }[] = [];
  private villagerLight = new Map<number, [number, number]>();
  private villagerDefs = new Map<number, VillagerDef>();
  private targetVillager: VillagerView | null = null;
  private targetVillagerDist = 99;
  private lastVillagerSound = 0;
  private myMobHits = new Map<number, number>();
  private lastMobSound = 0;
  private arrows = new Map<number, ArrowView>();
  private arrowGroup = new THREE.Group();
  private lastSwingTick = -100; // the attack cooldown runs from the last swing (as on the server)

  // v8 boats: the server's boats (interpolated), who sits where, and ours (the one we row is predicted here)
  private boats = new Map<number, BoatView>();
  private boatGroup = new THREE.Group();
  private boatOffset: number | null = null;
  private pendingBoats: { s: BoatSnap; t: number }[] = [];
  private boatLight = new Map<number, [number, number]>();
  private targetBoat: BoatView | null = null;
  private rides = new Map<number, { b: number; s: number }>(); // player id -> boat, seat
  private ride: { id: number; seat: number } | null = null;
  private myBoat: BoatBody | null = null; // set while we row
  private boatRows = 0;
  private lastBoatSent = { x: 0, y: 0, z: 0, yaw: 0, r: 0, at: 0 };
  private lastRideYaw: number | null = null;
  private paddleAt = new Map<number, number>(); // boat id -> tick of its last oar sound
  private rideHinted = false;

  // survival (v5): the server owns these; we keep a predicted copy
  private gm: GameMode = "survival";
  private inv: PlayerInv = newPlayerInv();
  private cursor: { s: Stack | null } = { s: null };
  private stats: Stats = { hp: 20, food: 20, sat: 5, air: 300 };
  private win: { w: number; kind: WindowKind; menu: Menu } | null = null;
  private invUI!: InventoryUI;
  private clickSeq = 0;
  private dead = false;
  private sleeping = false;
  private eating: { ticks: number; item: number } | null = null;
  /** v7: drawing the bow since this tick (the server keeps its own clock; this one is for the pull and the zoom). */
  private drawing: { start: number } | null = null;
  private insideSafe: boolean | null = null;
  private hurtTime = 0;
  private hurtYaw = 0;
  private drops = new Map<number, DropView>();
  private dropGroup = new THREE.Group();
  private dropOffset: number | null = null;
  private dropLight = new Map<number, [number, number]>();

  // others
  private others = new Map<number, RemotePlayer>();
  private snapOffset: number | null = null;
  private otherLight = new Map<number, [number, number]>();
  private otherSteps = new Map<number, { x: number; z: number; d: number }>();

  // server
  private shard: ShardInfo = { n: 1, players: 1, cap: MAX_PLAYERS_PER_SHARD };
  private timeBase = { time: 6000, at: performance.now() };
  private rtt = 0;
  private debug = false;
  private tabHeld = false;
  private acc = 0;
  private lastFrame = performance.now();
  private hasLock = false;
  private unlockedAt = 0;
  private hudHidden = false;
  private camBack = 4; // clankersmp: the third-person camera's distance behind the AI, eased
  private camClose = false; // too tight behind it: looking out of its eyes for now
  private view = requestedView(); // 0 first person, 1 third person (behind), 2 third person (front)
  private self: RemotePlayer | null = null;

  // clankersmp: a spectator (?follow=name) sees through the eyes of one AI: no body, no controls. The camera plays
  // back that AI's body (game/follow.ts); its HUD comes in `fol`, its digging in `fdig`, its hurts and death forwarded.
  private spec = requestedFollow(); // the AI we watch (the welcome may name another)
  private embed = this.spec !== null && embedded();
  private folId = 0; // its player id (0: not in the world)
  private fol: Extract<S2C, { t: "fol" }> | null = null;
  private folDeath = "";
  private folDig: Dig | null = null;
  private folEat = -1; // ticks it has been eating (-1: it isn't)
  private fcam = new FollowCam();

  constructor(canvas: HTMLCanvasElement, uiRoot: HTMLElement) {
    this.canvas = canvas;
    this.settings = loadSettings();
    // clankersmp spectators see at full brightness: an AI sealed in a hole at night is still worth watching
    if (this.spec !== null) {
      this.settings = { ...this.settings, brightness: 1 };
      U.uFloor.value = 0.3;
    }
    this.renderDist = this.settings.renderDistance;
    this.sound.setVolume(this.settings.volume);
    this.music.setVolume(this.settings.music ?? 0.5);
    this.music.onTrack = (title) => this.ui.nowPlaying(title);
    this.ui = new UI(uiRoot, {
      resume: () => this.resume(),
      backToTitle: () => this.backToTitle(),
      sendChat: (t) => this.net?.send({ t: "chat", text: t }),
      chatClosed: () => this.afterOverlayClosed(),
      pickerClosed: () => this.closePicker(),
      pickBlock: (slot, id) => this.setSlotBlock(slot, id),
      settingsChanged: (s) => this.applySettings(s),
      voiceInfo: () => ({ serverOn: this.voice.serverOn, mic: this.voice.mic, adminMuted: this.voice.adminMuted, supported: this.voice.supported }),
      voiceMic: (on) => {
        if (on) return this.voice.enableMic();
        this.voice.disableMic();
        return Promise.resolve(false);
      },
      voicePlayers: () =>
        [...this.others.values()].map((o) => ({ id: o.id, name: o.name, muted: this.voice.muted.has(o.name), talking: this.voice.talking.has(o.id) })).sort((a, b) => a.name.localeCompare(b.name)),
      voiceMute: (name, on) => this.setVoiceMute(name, on),
      retry: () => location.reload(),
      click: () => {
        this.unlockAudio();
        this.sound.click();
      },
      playTouch: () => {
        this.touchMode = true;
        this.ui.closeScreen();
        void this.start();
      },
      playDesktop: () => {
        this.touchMode = false;
        this.ui.closeScreen();
        void this.start();
      },
    });
    // v11: voice chat (the mic stays off until the player turns voice on)
    this.voice = new VoiceChat({
      sendJson: (m) => this.net?.send(m as C2S),
      sendBin: (b) => this.net?.sendBin(b),
      positionOf: (id) => {
        const o = this.others.get(id);
        return o ? { x: o.x, y: o.y + 1.5, z: o.z } : null;
      },
      nameOf: (id) => this.others.get(id)?.name ?? null,
      changed: () => (this.voiceKey = ""),
      notice: (t) => this.ui.notice(t),
    });
    this.voice.openMic = this.settings.voiceOpenMic;
    this.voice.setHear(this.settings.voiceHear);
    this.voice.setVolume(this.settings.voiceVolume);
    this.voice.muted = new Set(this.settings.voiceMuted);
    this.invUI = new InventoryUI(uiRoot, {
      click: (c) => this.windowClick(c),
      trade: (o, all) => {
        if (this.win && this.win.kind === "trade") this.net?.send({ t: "trade", w: this.win.w, o, all });
      },
      close: () => this.closeInventory(),
      sound: () => {
        this.unlockAudio();
        this.sound.click();
      },
    });
  }

  // ================================================================== survival: inventory and windows

  private heldId(): number {
    return this.inv.inv[this.slot]?.id ?? 0;
  }

  private hotbarStacks(): (Stack | null)[] {
    return this.inv.inv.slice(0, 9);
  }

  /** The hotbar, the held item and the hand after the inventory changed. */
  private refreshHotbar(): void {
    this.ui.setHotbar(this.hotbarStacks(), this.slot);
    const id = this.heldId();
    this.hand.setItem(id);
    this.self?.setHeld(id);
    if (this.eating && this.eating.item !== id) this.stopEating();
  }

  private openInventory(): void {
    this.cancelDrawing();
    if (this.gm === "creative") return this.openPicker();
    this.state = "inventory";
    this.keys.clear();
    this.mouse = 0;
    this.stopEating();
    document.exitPointerLock?.();
    const menu = new Menu("player", this.inv);
    this.win = { w: 0, kind: "player", menu };
    this.invUI.open("player", "Inventory", menu, this.cursor);
  }

  /** E / Esc, or the server closed it: the grid and the cursor go back (the server does the same). */
  private closeInventory(fromServer = false): void {
    const w = this.win;
    if (!w) return;
    if (!fromServer) this.net?.send({ t: "close", w: w.w });
    w.menu.close(this.cursor);
    this.win = null;
    this.invUI.close();
    this.refreshHotbar();
    if (w.kind === "chest") this.sound.chest(false);
    if (this.state === "inventory") this.afterOverlayClosed();
  }

  /** A click in a window: predicted here with the shared rules, then sent; the server's answer replaces ours. */
  private windowClick(c: Click): void {
    const w = this.win;
    if (!w) return;
    this.unlockAudio();
    const n = ++this.clickSeq;
    w.menu.click(c, this.cursor);
    this.net?.send({ t: "click", w: w.w, n, c });
    this.invUI.render();
    this.refreshHotbar();
  }

  /** Swap inventory slot k (0-35) with hotbar slot h without the screen open (tools and tests). */
  swapToHotbar(k: number, h: number): void {
    const menu = new Menu("player", this.inv);
    const s = k < 9 ? menu.hotStart + k : k;
    const c: Click = { m: "swap", s, h };
    menu.click(c, this.cursor);
    this.net?.send({ t: "click", w: 0, n: ++this.clickSeq, c });
    this.net?.send({ t: "close", w: 0 });
    this.refreshHotbar();
  }

  private applyWindow(m: Extract<S2C, { t: "win" }>): void {
    const items = m.items.map((x) => fromWire(x));
    const w = this.win;
    if (w && w.w === m.w) {
      w.menu.setContents(items);
      this.cursor.s = fromWire(m.cursor);
      this.invUI.render();
    } else if (m.w === 0) {
      // a late answer for the inventory we already closed: its inventory part still counts
      new Menu("player", this.inv).setContents(items);
    }
    this.refreshHotbar();
  }

  private openContainer(m: Extract<S2C, { t: "open" }>): void {
    if (this.win) {
      this.win.menu.close(this.cursor);
      this.invUI.close();
    }
    const size = m.kind === "crafting" ? 9 : m.kind === "furnace" ? 3 : m.kind === "trade" ? 0 : 27;
    const container: Items | null = size ? new Array(size).fill(null) : null;
    const menu = new Menu(m.kind, this.inv, container);
    menu.setContents(m.items.map((x) => fromWire(x)));
    this.cursor.s = fromWire(m.cursor);
    this.win = { w: m.w, kind: m.kind, menu };
    this.state = "inventory";
    this.keys.clear();
    this.mouse = 0;
    this.stopEating();
    document.exitPointerLock?.();
    this.invUI.open(m.kind, m.title, menu, this.cursor, m.offers);
    if (m.kind === "chest") this.sound.chest(true);
    if (m.kind === "trade") this.sound.villager("say", undefined);
  }

  /** Which way the camera looks (degrees): our yaw, or the opposite in the front view (F5 twice). */
  private camYaw(): number {
    return this.view === 2 ? this.yaw + 180 : this.yaw;
  }

  /** Armour points worn (for the HUD row). */
  private armorPoints(): number {
    return armorOf(this.inv.armor).points;
  }

  /** What we wear changed: the HUD row and our own avatar (F5). */
  private armorChanged(): void {
    this.ui.setStats(this.stats, this.gm === "survival", this.armorPoints());
    this.self?.setArmor(packArmor(this.inv.armor));
  }

  private onStats(s: Stats): void {
    const before = this.stats;
    this.stats = s;
    this.ui.setStats(s, this.gm === "survival", this.armorPoints());
    if (s.hp > before.hp && this.dead) return;
  }

  private onHurt(m: Extract<S2C, { t: "hurt" }>): void {
    if (m.kb && !this.spec) {
      // v6 knockback (Java's: half the speed you had, plus the push; a little hop when on the ground)
      const p = this.phys;
      p.vx = p.vx / 2 + m.kb[0];
      p.vz = p.vz / 2 + m.kb[2];
      if (p.onGround) p.vy = Math.min(0.4, p.vy / 2 + m.kb[1]);
    }
    this.ui.hurtFlash();
    this.sound.hurt();
    this.hurtTime = 10;
    this.hurtYaw = m.dx !== undefined && m.dz !== undefined ? (Math.atan2(-m.dx, m.dz) * 180) / Math.PI - this.yaw : 0;
    this.stopEating();
  }

  private onDead(msg: string): void {
    this.cancelDrawing();
    this.dead = true;
    if (this.win) {
      this.win.menu.close(this.cursor);
      this.win = null;
      this.invUI.close();
    }
    this.stopEating();
    this.setSleeping(false);
    this.state = "dead";
    this.keys.clear();
    this.mouse = 0;
    this.cancelDig();
    document.exitPointerLock?.();
    this.ui.showDeath(msg, () => this.net?.send({ t: "respawn" }), () => this.backToTitle());
  }

  private onRespawned(m: Extract<S2C, { t: "respawned" }>): void {
    this.dead = false;
    this.phys.x = this.prev.x = m.x;
    this.phys.y = this.prev.y = m.y;
    this.phys.z = this.prev.z = m.z;
    this.phys.vx = this.phys.vy = this.phys.vz = 0;
    this.phys.fallDist = 0;
    this.yaw = m.yaw;
    this.pitch = 0;
    this.ui.closeScreen();
    this.state = "play";
    this.chunks.updatePos(m.x, m.y, m.z);
    if (!this.touchMode) {
      this.lock();
      setTimeout(() => {
        if (!this.hasLock && this.state === "play") this.ui.setClickToPlay(true, "Click to play");
      }, 300);
    }
  }

  private setSleeping(on: boolean, text = ""): void {
    if (this.sleeping === on && !on) return;
    this.sleeping = on;
    this.ui.setSleep(on, text, () => this.net?.send({ t: "wake" }));
  }

  private onSleep(m: Extract<S2C, { t: "sleep" }>): void {
    const text = m.sleeping ? `${m.sleeping} of ${m.needed} needed asleep${m.sleeping >= m.needed ? ": the night will pass" : ""}` : "";
    if (m.you) {
      if (!this.sleeping) this.setSleeping(true, text);
      else this.ui.setSleepText(text);
    } else {
      if (this.sleeping) this.setSleeping(false);
      if (m.on && m.sleeping) this.ui.notice(`${text}. Find a bed to help skip the night.`);
    }
  }

  // ---- eating

  private canEat(id: number): boolean {
    const def = itemDef(id);
    if (def?.drink) return true; // v7: milk goes down at any hunger
    const f = def?.food;
    return !!f && (this.stats.food < MAX_FOOD || this.gm === "creative");
  }

  private startEating(): void {
    const id = this.heldId();
    if (this.eating || !this.canEat(id)) return;
    this.eating = { ticks: 0, item: id };
    this.net?.send({ t: "eat", a: "start" });
    this.hand.setEating(true, EAT_TICKS);
  }

  private stopEating(): void {
    if (!this.eating) return;
    this.eating = null;
    this.net?.send({ t: "eat", a: "abort" });
    this.hand.setEating(false);
  }

  private eatTick(): void {
    const e = this.eating;
    if (!e) return;
    if (!(this.mouse & 4) || this.state !== "play" || this.heldId() !== e.item) return this.stopEating();
    e.ticks++;
    if (e.ticks % 4 === 0 && e.ticks > 6) {
      const def = itemDef(e.item);
      if (def?.drink) {
        if (e.ticks % 8 === 0) this.sound.drink();
      } else {
        this.sound.eat();
        if (def) this.particles.food(this.phys.x, this.phys.y + this.eye - 0.3, this.phys.z, this.yaw, this.pitch, def.tex, this.lightHere);
      }
    }
    if (e.ticks >= EAT_TICKS) {
      this.net?.send({ t: "eat", a: "finish" });
      this.eating = null;
      this.hand.finishEating();
      this.placeDelay = 4;
    }
  }

  // ---- dropped items

  private onItems(list: ItemSnap[], t: number): void {
    for (const s of list) {
      let d = this.drops.get(s.id);
      if (!d) {
        d = new DropView(s, heldMaterial(this.atlas));
        this.drops.set(s.id, d);
        this.dropGroup.add(d.root);
      }
      d.push(s, t);
    }
  }

  private removeDrop(id: number): void {
    const d = this.drops.get(id);
    if (!d) return;
    this.dropGroup.remove(d.root);
    d.dispose();
    this.drops.delete(id);
    this.dropLight.delete(id);
  }

  private onPickups(list: [number, number][]): void {
    for (const [itemId, playerId] of list) {
      const d = this.drops.get(itemId);
      if (!d) continue;
      if (playerId === this.myId || playerId === this.folId) {
        d.startFlying(() => [this.phys.x, this.phys.y, this.phys.z]);
        this.sound.pickup();
      } else {
        const o = this.others.get(playerId);
        if (!o) {
          this.removeDrop(itemId);
          continue;
        }
        d.startFlying(() => [o.x, o.y, o.z]);
      }
    }
  }

  /** v10: the bigger hub's safe zone (less the tiles kept for players' builds, as the server says). */
  private zone = new SafeZone();
  private inSafeZone(x: number, z: number): boolean {
    return this.zone.contains(x, z);
  }

  // ================================================================== boot

  async boot(): Promise<void> {
    if (this.spec) {
      // clankersmp: a spectator goes straight in, on any device
      this.ui.root.classList.toggle("embed", this.embed);
      return this.start();
    }
    // Only phones and tablets get the touch screen. Touchscreen laptops report a coarse pointer too
    // (Laith 2026-10-14: "its saying im touch screen on a laptop with keyboard and mouse"), so a
    // desktop OS, or any mouse/trackpad/hover, always means keyboard and mouse.
    const ua = navigator.userAgent;
    const mobileOS = /Android|iPhone|iPod|iPad|Mobile|Silk|Kindle/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
    const hasMouse = matchMedia("(any-pointer: fine)").matches || matchMedia("(any-hover: hover)").matches;
    const q = new URLSearchParams(location.search);
    const phone = q.has("touch") || (mobileOS && !hasMouse);
    if (phone && !q.has("desktop")) {
      this.ui.showMobile();
      return;
    }
    await this.start();
  }

  private async start(): Promise<void> {
    this.ui.showLoading("Joining the world", "Connecting to the server", null);
    try {
      await document.fonts.load("16px KenneyMini");
    } catch {
      /* fonts optional */
    }
    let welcome: Extract<S2C, { t: "welcome" }>;
    let edits: Uint8Array;
    const url = await resolveServerUrl();
    if (!url) {
      this.startingSoon("The shared world is being set up. It opens very soon!");
      return;
    }
    try {
      const net = new Net(url);
      net.watchOnly = this.spec !== null;
      this.net = net;
      await net.connect(8000);
      const got = await this.handshake(net);
      welcome = got.welcome;
      edits = got.edits;
    } catch (e) {
      const err = e as Error & { kicked?: boolean; server?: number };
      this.net?.close();
      this.net = null;
      if (err.kicked && /updated/i.test(err.message)) {
        // Version mismatch. A newer server means this page is old: load the new game (once, so a stale cache
        // cannot loop). An older server (it does not say its version) is about to be updated: wait for it.
        if (typeof err.server === "number" && err.server > PROTOCOL_VERSION) {
          if (reloadOnceForUpdate()) return;
        } else {
          this.startingSoon("The clankersmp server is updating to the new version.");
          return;
        }
      }
      if (err.kicked && this.spec) {
        this.startingSoon(err.message); // a spectator just tries again (too many watching, a restart)
      } else if (err.kicked) {
        this.ui.showMessage("Can't join right now", err.message, [
          { label: "Try again", onClick: () => location.reload() },
          { label: "Back to Title Screen", onClick: () => this.backToTitle() },
        ]);
      } else {
        this.startingSoon("Can't reach the clankersmp server right now. It may be restarting.");
      }
      return;
    }
    this.myId = welcome.id;
    this.myName = welcome.name;
    this.gm = welcome.gm ?? "survival";
    if (this.spec) {
      // the server picks another AI when the one asked for isn't in the world; the HUD comes in `fol`
      this.spec = welcome.spec ?? this.spec;
    } else {
      this.inv.inv = (welcome.inv ?? []).map((w) => fromWire(w));
      while (this.inv.inv.length < 36) this.inv.inv.push(null);
      this.inv.armor = (welcome.armor ?? []).map((w) => fromWire(w));
      while (this.inv.armor.length < 4) this.inv.armor.push(null);
      this.slot = welcome.sel ?? 0;
      if (welcome.stats) this.stats = welcome.stats;
      rememberName(welcome.name);
    }
    this.shard = welcome.shard;
    this.timeBase = { time: welcome.time, at: performance.now() };

    this.ui.showLoading("Joining the world", "Generating terrain", 0.15);
    await nextFrame();
    const gen = generateWorld(welcome.seed, this.blocks, { villages: welcome.villages ?? [], hub: welcome.hub ?? { keep: [], roads: welcome.villages ?? [] } });
    this.zone = new SafeZone(welcome.hub?.keep ?? []);
    this.info = gen.info;
    for (const v of gen.info.villages.list) for (const d of v.villagers) this.villagerDefs.set(d.id, d);
    const hash = hashBlocks(this.blocks);
    const editList = readBlockEntries(edits);
    for (let o = 0; o + 3 < editList.length; o += 4) this.blocks[idx(editList[o], editList[o + 1], editList[o + 2])] = editList[o + 3];
    let fullWorld: Uint8Array | null = null;
    if (hash !== welcome.genHash) {
      // Different JS engine produced different terrain: ask the server for the whole world.
      this.ui.showLoading("Joining the world", "Downloading the world", 0.2);
      fullWorld = await this.requestFullWorld();
      this.blocks.set(fullWorld);
    }
    this.worldReady = true;
    if (this.pendingBlocks.length) {
      const list = this.pendingBlocks;
      this.pendingBlocks = [];
      this.applyBlockList(list, false);
    }

    const you = welcome.you;
    this.phys = newPhysState(you.x, you.y, you.z);
    this.prev = { x: you.x, y: you.y, z: you.z };
    this.yaw = you.yaw;
    this.pitch = you.pitch;

    this.ui.showLoading("Joining the world", "Building terrain", 0.25);
    this.initRenderer();
    this.chunks.init(this.blocks, you.x, you.y, you.z, this.settings.renderDistance + 1);
    for (const p of welcome.players) this.addOther(p);
    // v11: voice: what the server allows, what we can play (the mic stays off until the player turns it on)
    this.voice.serverOn = welcome.voice?.on ?? false;
    this.voice.adminMuted = welcome.voice?.adminMuted ?? false;
    this.voice.syncState(true);
    this.voiceMutesDirty = true;
    for (const [pid, bid, seat] of welcome.rides ?? []) this.rides.set(pid, { b: bid, s: seat });
    for (const { s, t } of this.pendingBoats.splice(0)) this.onBoat(s, t);
    for (const { s, t } of this.pendingAnimals.splice(0)) this.onAnimal(s, t);
    for (const { s, t } of this.pendingMobs.splice(0)) this.onMob(s, t);
    for (const { s, t } of this.pendingVillagers.splice(0)) this.onVillager(s, t);
    // Our own avatar, shown in third person (F5).
    this.self = new RemotePlayer(
      { id: -1, name: "", x: you.x, y: you.y, z: you.z, yaw: you.yaw, pitch: you.pitch, skin: welcome.skin, held: this.heldId() },
      (id) => heldBlockMesh(id, this.heldMat),
      false,
    );
    this.self.root.visible = false;
    this.scene.add(this.self.root);
    this.ui.setHotbar(this.hotbarStacks(), this.slot);
    this.armorChanged();
    this.updateServerLine();
    this.hand.setSkin(welcome.skin);
    this.invUI.setSkin(welcome.skin);
    this.hand.setItem(this.heldId());
    if (this.spec) {
      this.fcam.jump(you.x, you.y, you.z, you.yaw, you.pitch);
      this.watch(welcome.players.find((q) => q.name === this.spec)?.id ?? 0);
    }

    // Wait until the area around the player is meshed.
    const t0 = performance.now();
    await new Promise<void>((resolve) => {
      const check = () => {
        const p = this.chunks.progressAround(you.x, you.z, 2);
        this.ui.showLoading("Joining the world", "Building terrain", 0.25 + 0.75 * (p.done / Math.max(1, p.total)));
        if (p.done >= p.total || performance.now() - t0 > 20000) resolve();
        else setTimeout(check, 50);
      };
      check();
    });

    this.ui.closeScreen();
    this.ui.showHud(true);
    if (this.spec) {
      // no title card, tips or controls: straight to the AI's view
      this.state = "play";
      this.bindWatching();
      if (this.fol) this.onFol(this.fol);
    } else {
      const tip = this.touchMode ? "Stick to walk, drag to look, Dig and Place to build." : "E for your inventory and crafting, T to chat, Tab for players, F5 to see yourself.";
      this.ui.addChat([{ text: `Welcome to clankersmp, ${this.myName}! `, cls: "y" }, { text: tip, cls: "g" }]);
      this.bindInput();
      window.addEventListener("beforeunload", this.beforeUnload);
      this.state = "play";
      this.ui.showTitle(true, `Server ${this.shard.n} · ${this.shard.players} player${this.shard.players === 1 ? "" : "s"} online`, this.touchMode);
      if (this.touchMode) setTimeout(() => this.ui.showTitle(false), 2500);
      this.showWhatsNew();
      if (welcome.first && this.gm === "survival") setTimeout(() => this.ui.survivalTips(), 2500);
      if (this.touchMode) this.setupTouch();
    }
    this.lastFrame = performance.now();
    requestAnimationFrame(this.frame);
    setInterval(() => this.net?.send({ t: "ping", c: performance.now() }), 5000);
  }

  /** The latest update, once per update number (kept in localStorage), a moment after joining. */
  private showWhatsNew(): void {
    const latest = updates[0];
    if (!latest) return;
    let seen = 0;
    try {
      seen = Number(localStorage.getItem("steve_craft_seen_update") ?? 0);
      localStorage.setItem("steve_craft_seen_update", String(latest.n));
    } catch {
      /* storage blocked: show it every time, which is harmless */
    }
    if (seen >= latest.n) return;
    setTimeout(() => this.ui.whatsNew(latest), 1200);
  }

  private retryTimer = 0;

  /** Clear "starting soon" screen that checks again on its own instead of hanging on "Joining the world". */
  private startingSoon(detail: string): void {
    window.clearInterval(this.retryTimer);
    let left = this.spec ? 5 : 15;
    const line = () => `${detail} Checking again in ${left}s.`;
    this.ui.showMessage("Server starting soon", line(), [
      {
        label: "Try again now",
        onClick: () => {
          window.clearInterval(this.retryTimer);
          void this.start();
        },
      },
      { label: "Back to Title Screen", onClick: () => this.backToTitle() },
    ]);
    this.retryTimer = window.setInterval(() => {
      left--;
      if (left <= 0) {
        window.clearInterval(this.retryTimer);
        void this.start();
      } else this.ui.setMessageDetail(line());
    }, 1000);
  }

  private handshake(net: Net): Promise<{ welcome: Extract<S2C, { t: "welcome" }>; edits: Uint8Array }> {
    return new Promise((resolve, reject) => {
      let welcome: Extract<S2C, { t: "welcome" }> | null = null;
      let edits: Uint8Array | null = null;
      const timer = setTimeout(() => reject(new Error("The server did not answer.")), 15000);
      const done = () => {
        if (welcome && edits) {
          clearTimeout(timer);
          resolve({ welcome, edits });
        }
      };
      net.onJson = (m) => {
        if (m.t === "welcome") {
          welcome = m;
          done();
        } else if (m.t === "kick") {
          clearTimeout(timer);
          const err = new Error(m.reason) as Error & { kicked?: boolean; server?: number };
          err.kicked = true;
          err.server = m.server;
          reject(err);
        } else {
          this.onJson(m);
        }
      };
      net.onBin = (op, view, buf) => {
        if (op === OP.EDITS) {
          const z = new Uint8Array(buf, 5);
          inflateRaw(z).then((raw) => {
            edits = raw;
            done();
          }, reject);
        } else this.onBin(op, view, buf);
      };
      net.onClose = () => reject(new Error("The connection closed."));
      if (this.spec) net.send({ t: "hello", g: PROTOCOL_NAME, v: PROTOCOL_VERSION, follow: this.spec });
      else net.send({ t: "hello", g: PROTOCOL_NAME, v: PROTOCOL_VERSION, name: storedName(), token: clientToken(), shard: requestedShard() });
    }).then((r) => {
      net.onJson = (m) => this.onJson(m);
      net.onBin = (op, view, buf) => this.onBin(op, view, buf);
      net.onClose = (code, reason) => this.onClosed(code, reason);
      return r as { welcome: Extract<S2C, { t: "welcome" }>; edits: Uint8Array };
    });
  }

  private worldWaiter: ((b: Uint8Array) => void) | null = null;

  private requestFullWorld(): Promise<Uint8Array> {
    return new Promise((resolve) => {
      this.worldWaiter = resolve;
      this.net?.send({ t: "resync" });
    });
  }

  private initRenderer(): void {
    const r = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: false, powerPreference: "high-performance" });
    this.canvas.addEventListener("webglcontextlost", (e) => {
      e.preventDefault();
      this.ui.showMessage("Graphics reset", "The browser reset the graphics card. Reloading...", []);
      setTimeout(() => location.reload(), 1500);
    });
    r.outputColorSpace = THREE.LinearSRGBColorSpace;
    r.autoClear = false;
    r.info.autoReset = false; // count both passes (world + hand) for F3
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    this.renderer = r;
    const atlas = blockTextureArray();
    atlas.anisotropy = Math.min(4, r.capabilities.getMaxAnisotropy());
    this.atlas = atlas;
    const solid = chunkMaterial(atlas);
    const water = waterMaterial(atlas);
    this.chunks = new ChunkManager(solid, water);
    this.chunks.onLight = (id, values) => this.onLight(id, values);
    this.chunks.onError = () => this.ui.notice("Terrain worker stopped. Please refresh the page.");
    this.sky = new Sky();
    this.scenery = new Scenery(solid, water, this.info);
    const latest = updates[0];
    if (latest) this.scenery.setLatestUpdate({ n: latest.n, title: latest.title, line: latest.line, date: latest.date });
    this.selection = new Selection(atlas);
    this.particles = new Particles(atlas);
    this.hand = new Hand(atlas);
    this.heldMat = heldMaterial(atlas);
    this.scene.add(this.sky.group, this.sky.clouds, this.chunks.group, this.scenery.group, this.othersGroup, this.animalGroup, this.mobGroup, this.arrowGroup, this.dropGroup, this.boatGroup, this.villagerGroup);
    this.scene.add(this.selection.outline, this.selection.crack, this.particles.points);
    this.camera.rotation.order = "YXZ";
    this.onResize();
    window.addEventListener("resize", () => this.onResize());
  }

  private onResize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.hand.setAspect(w / h);
    const pr = this.renderer.getPixelRatio();
    this.selection.setResolution(w * pr, h * pr);
    this.particles.setScale(h * pr, this.settings.fov);
  }

  // ================================================================== network

  private onJson(m: S2C): void {
    switch (m.t) {
      case "join":
        this.addOther(m.p);
        this.voiceMutesDirty = true;
        if (this.spec && m.p.name === this.spec && this.state !== "loading") this.watch(m.p.id); // its body came back (a restart)
        break;
      case "leave": {
        const o = this.others.get(m.id);
        if (o) {
          this.othersGroup.remove(o.root);
          o.dispose();
          this.others.delete(m.id);
        }
        if (m.id === this.folId) this.folDig = null; // the camera stays where it was
        break;
      }
      case "chat":
        if (m.kind === "player") this.ui.addChat([{ text: `${m.from}  `, cls: "n" }, { text: m.text }]);
        else if (m.kind === "join" || m.kind === "leave") this.ui.addChat([{ text: m.text, cls: "y" }]);
        else this.ui.addChat([{ text: m.text, cls: "y" }]);
        break;
      case "time":
        this.timeBase = { time: m.time, at: performance.now() };
        break;
      case "tp":
        this.phys.x = this.prev.x = m.x;
        this.phys.y = this.prev.y = m.y;
        this.phys.z = this.prev.z = m.z;
        this.phys.vx = this.phys.vy = this.phys.vz = 0;
        this.phys.fallDist = 0;
        break;
      case "swing":
        this.others.get(m.id)?.startSwing();
        if (this.spec && m.id === this.folId) {
          this.hand.startSwing();
          this.lastSwingTick = this.tickCount;
        }
        break;
      case "count":
        this.shard = m.shard;
        this.updateServerLine();
        break;
      case "charity":
        break; // ($STEVE Craft's charity meter: not part of clankersmp)
      case "pong":
        this.rtt = performance.now() - m.c;
        break;
      case "notice":
        this.ui.notice(m.text);
        this.ui.addChat([{ text: m.text, cls: "g" }]);
        break;
      case "kick":
        this.kicked = m.reason;
        break;
      case "reload":
        this.ui.notice(m.reason);
        setTimeout(() => location.reload(), 1500);
        break;
      // ---- survival (v5)
      case "slots": {
        let wear = false;
        for (const [k, w] of m.list) {
          if (k >= 0 && k < 36) this.inv.inv[k] = fromWire(w);
          else if (k >= 36 && k < 40) {
            this.inv.armor[k - 36] = fromWire(w);
            wear = true;
          }
        }
        if (this.win) this.invUI.render();
        this.refreshHotbar();
        if (wear) this.armorChanged();
        break;
      }
      // ---- v6: armour on others, arrows, what our hits did
      case "wear":
        this.others.get(m.id)?.setArmor(m.armor);
        break;
      case "arrow": {
        if (!this.chunks) break;
        const a = new ArrowView(m.id, { x: m.x, y: m.y, z: m.z, vx: m.vx, vy: m.vy, vz: m.vz });
        this.arrows.set(m.id, a);
        this.arrowGroup.add(a.root);
        this.sound.bow({ x: m.x, y: m.y, z: m.z });
        break;
      }
      case "arrow_gone":
        // v7: a stuck arrow was picked up (or its minute is up)
        this.removeArrow(m.id);
        break;
      // v8: boats
      case "ride":
        this.onRide(m.p, m.b, m.s);
        break;
      case "boat_tp":
        if (this.myBoat && this.ride && this.ride.id === m.id) Object.assign(this.myBoat, { x: m.x, y: m.y, z: m.z, yaw: m.yaw, vx: 0, vy: 0, vz: 0, dyaw: 0 });
        break;
      case "arrow_end": {
        const a = this.arrows.get(m.id);
        if (!a) break;
        if (!a.end(m.x, m.y, m.z, m.stuck)) this.removeArrow(m.id);
        else this.sound.arrowHit({ x: m.x, y: m.y, z: m.z });
        break;
      }
      case "struck": {
        const t = m.mob ? this.mobs.get(m.id) : this.animals.get(m.id);
        if (t && m.crit) this.particles.crit(t.x, t.y + t.spec.h * 0.6, t.z);
        if (m.dmg > 0) this.sound.attack(m.crit ? "crit" : m.dmg >= 3 ? "strong" : "weak");
        break;
      }
      case "open":
        this.openContainer(m);
        break;
      case "win":
        this.applyWindow(m);
        if (m.w === 0) this.armorChanged();
        break;
      case "close":
        if (this.win && this.win.w === m.w) this.closeInventory(true);
        break;
      case "furnace":
        if (this.win && this.win.w === m.w) this.invUI.setFurnace(m.burn, m.cook);
        break;
      case "offers":
        if (this.win && this.win.w === m.w) this.invUI.setOffers(m.offers);
        break;
      // v11 voice
      case "talking":
        this.voice.talking = new Set(m.ids);
        this.voiceKey = "";
        break;
      case "vcodec":
        this.voice.adpcmHint = m.adpcm;
        break;
      case "vstate":
        this.voice.adminMuted = m.adminMuted;
        this.voice.syncState();
        this.voiceKey = "";
        break;
      case "stats":
        this.onStats(m.s);
        break;
      case "hurt":
        this.onHurt(m);
        break;
      case "dead":
        if (this.spec) {
          this.folDeath = m.msg;
          if (this.state !== "loading") this.watchDead(true);
        } else this.onDead(m.msg);
        break;
      case "respawned":
        this.onRespawned(m);
        break;
      case "gm":
        this.gm = m.mode;
        this.ui.setStats(this.stats, this.gm === "survival", this.armorPoints());
        this.ui.notice(m.mode === "creative" ? "Creative mode (admin)" : "Survival mode");
        break;
      case "sleep":
        this.onSleep(m);
        break;
      case "fol":
        this.onFol(m);
        break;
      case "fdig":
        this.onFdig(m);
        break;
      case "fx": {
        const at = m.x !== undefined ? { x: m.x, y: m.y ?? 0, z: m.z ?? 0 } : undefined;
        if (m.k === "tool_break") {
          this.sound.toolBreak(at);
          if (!at) this.ui.notice(`Your ${itemName(m.id ?? 0)} broke.`);
        } else if (m.k === "burp") this.sound.burp(at);
        else if (m.k === "level") this.sound.chest(m.id === 1, at);
        else if (m.k === "crit" && at) this.particles.crit(at.x, at.y, at.z);
        else if (m.k === "equip") this.sound.equip(at);
        else if (m.k === "bone_meal" && at) this.particles.green(at.x, at.y, at.z);
        // v7 (the player who did it heard it already: these come from someone else)
        else if (m.k === "till") this.sound.till(at);
        else if (m.k === "bucket_fill" || m.k === "bucket_empty") this.sound.bucket(m.k === "bucket_fill", at);
        else if (m.k === "drink") this.sound.drink(at);
        else if (m.k === "pickup") this.sound.play("pickup", 0.28, 1.2 + Math.random() * 0.6, at);
        // v8
        else if (m.k === "chime") this.sound.chime(at);
        else if (m.k === "trade") this.sound.trade(true, at);
        else if (m.k === "trade_no") this.sound.trade(false, at);
        else if (m.k === "boat_place") this.sound.boatPlace(at);
        else if (m.k === "boat_break" && at) {
          this.sound.boatBreak(at);
          this.particles.breakBlock(Math.floor(at.x), Math.floor(at.y), Math.floor(at.z), B.OAK_PLANKS, this.lightHere);
        } else if (m.k === "path") this.sound.till(at);
        else if (m.k === "pot") this.sound.place("stone", at);
        else if (m.k === "mob_die" && at) {
          const spec = MOB_SPECS[m.id ?? 0];
          if (spec) {
            this.particles.poof(at.x, at.y - spec.h * 0.5, at.z, spec.w, spec.h);
            this.sound.mob(spec.key, "death", at);
          }
        }
        break;
      }
    }
  }

  private kicked = "";

  private onBin(op: number, view: DataView, buf: ArrayBuffer): void {
    if (op === OP.BLOCKS) {
      const list = decodeBlocks(view);
      const flat: number[] = [];
      for (const c of list) flat.push(c.x, c.y, c.z, c.id);
      if (!this.worldReady) this.pendingBlocks.push(...flat);
      else this.applyBlockList(flat, true);
    } else if (op === OP.PLAYERS) {
      const { tick, list } = decodePlayers(view);
      const now = performance.now();
      const st = tick * TICK_MS;
      const off = now - st;
      if (this.snapOffset === null || off < this.snapOffset) this.snapOffset = off;
      else this.snapOffset += (off - this.snapOffset) * 0.01;
      for (const s of list) {
        this.others.get(s.id)?.push(s, st + this.snapOffset);
        if (this.spec && s.id === this.folId) this.fcam.push(s, tick, now);
      }
    } else if (op === OP_ANIMALS) {
      const { tick, list } = decodeAnimals(view);
      const now = performance.now();
      const st = tick * TICK_MS;
      const off = now - st;
      if (this.animalOffset === null || off < this.animalOffset) this.animalOffset = off;
      else this.animalOffset += (off - this.animalOffset) * 0.01;
      for (const s of list) this.onAnimal(s, st + this.animalOffset);
    } else if (op === OP_ANIMALS_GONE) {
      for (const id of decodeGone(view)) this.removeAnimal(id);
    } else if (op === OP_MOBS) {
      const { tick, list } = decodeAnimals(view);
      const now = performance.now();
      const st = tick * TICK_MS;
      const off = now - st;
      if (this.mobOffset === null || off < this.mobOffset) this.mobOffset = off;
      else this.mobOffset += (off - this.mobOffset) * 0.01;
      for (const s of list) this.onMob(s, st + this.mobOffset);
    } else if (op === OP_MOBS_GONE) {
      for (const id of decodeGone(view)) this.removeMob(id);
    } else if (op === OP_VILLAGERS) {
      const { tick, list } = decodeAnimals(view);
      const now = performance.now();
      const st = tick * TICK_MS;
      const off = now - st;
      if (this.villagerOffset === null || off < this.villagerOffset) this.villagerOffset = off;
      else this.villagerOffset += (off - this.villagerOffset) * 0.01;
      for (const s of list) this.onVillager(s, st + this.villagerOffset);
    } else if (op === OP_VILLAGERS_GONE) {
      for (const id of decodeGone(view)) this.removeVillager(id);
    } else if (op === OP_VOICE) {
      this.voice.onFrames(decodeVoice(view));
    } else if (op === OP_BOATS) {
      const { tick, list } = decodeBoats(view);
      const now = performance.now();
      const st = tick * TICK_MS;
      const off = now - st;
      if (this.boatOffset === null || off < this.boatOffset) this.boatOffset = off;
      else this.boatOffset += (off - this.boatOffset) * 0.01;
      for (const s of list) this.onBoat(s, st + this.boatOffset);
    } else if (op === OP_BOATS_GONE) {
      for (const id of decodeGone(view)) this.removeBoat(id);
    } else if (op === OP_ITEMS) {
      const { tick, list } = decodeItems(view);
      const now = performance.now();
      const st = tick * TICK_MS;
      const off = now - st;
      if (this.dropOffset === null || off < this.dropOffset) this.dropOffset = off;
      else this.dropOffset += (off - this.dropOffset) * 0.01;
      if (this.chunks) this.onItems(list, st + this.dropOffset);
    } else if (op === OP_ITEMS_GONE) {
      for (const id of decodeIds(view)) {
        const d = this.drops.get(id);
        if (d && !d.flying) this.removeDrop(id);
      }
    } else if (op === OP_ITEM_PICKUP) {
      this.onPickups(decodePickups(view));
    } else if (op === OP.WORLD) {
      const z = new Uint8Array(buf, 5);
      void inflateRaw(z).then((raw) => {
        if (this.worldWaiter) {
          this.worldWaiter(raw);
          this.worldWaiter = null;
        }
      });
    }
  }

  private applyBlockList(flat: number[], effects: boolean): void {
    const changed: number[] = [];
    const now = performance.now();
    for (let o = 0; o + 3 < flat.length; o += 4) {
      const x = flat[o];
      const y = flat[o + 1];
      const z = flat[o + 2];
      const id = flat[o + 3];
      const i = idx(x, y, z);
      const old = this.blocks[i];
      if (old === id) continue;
      this.blocks[i] = id;
      changed.push(x, y, z, id);
      const mine = this.predicted.get(i);
      if (effects && !(mine && now - mine < 3000)) {
        const at = { x: x + 0.5, y: y + 0.5, z: z + 0.5 };
        if (isDoor(old) && isDoor(id)) {
          if (!door(id).upper) this.sound.door(door(id).open, at);
        } else if (isOpenable(old) && isOpenable(id)) {
          this.sound.gate(isOpen(id), isTrapdoor(id), at); // v8: fence gates and trapdoors
        } else if ((isDoor(id) && door(id).upper) || (isBed(id) && bed(id).head)) {
          // The second half of a door or bed: the first half already made the sound.
        } else if (IS_WATER[id] && IS_WATER[old]) {
          // water rising or draining: no sound
        } else if (IS_WATER[id] && !BLOCKS[old].solid) {
          // water washing over air, plants or a torch: quiet
        } else if (id === B.AIR || IS_WATER[id]) {
          if (!IS_WATER[old]) {
            this.sound.breakBlock(BLOCKS[old].sound, at);
            const d2 = (x - this.phys.x) ** 2 + (z - this.phys.z) ** 2;
            if (d2 < 64 * 64) this.particles.breakBlock(x, y, z, old, this.lightHere);
          }
        } else this.sound.place(BLOCKS[id].sound, at);
      }
    }
    if (changed.length) this.chunks?.setBlocks(changed);
  }

  private onAnimal(s: AnimalSnap, t: number): void {
    if (!this.chunks) {
      this.pendingAnimals.push({ s, t });
      return;
    }
    let a = this.animals.get(s.id);
    if (!a) {
      a = new AnimalView(s);
      this.animals.set(s.id, a);
      this.animalGroup.add(a.root);
    }
    // A hit shows as the HURT flag going up: everyone nearby hears it (we already played our own hit).
    const before = this.animalFlags.get(s.id) ?? 0;
    if (s.flags & AF.HURT && !(before & AF.HURT)) {
      const mine = this.myHits.get(s.id);
      if (!mine || performance.now() - mine > 800) this.sound.animal(SPECS[s.kind].key, "hurt", { x: s.x, y: s.y + 0.5, z: s.z });
    }
    this.animalFlags.set(s.id, s.flags);
    a.push(s, t);
  }

  private removeAnimal(id: number): void {
    const a = this.animals.get(id);
    if (!a) return;
    this.animalGroup.remove(a.root);
    a.dispose();
    this.animals.delete(id);
    this.animalFlags.delete(id);
    this.animalLight.delete(id);
  }

  /** Left click on an animal: tell the server, swing, flash it red and play its hurt sound right away. */
  private hitAnimal(a: AnimalView): void {
    this.lastSwingTick = this.tickCount;
    this.sendMove(); // v6: the server judges the hit (reach, a critical on the way down) from where we are now
    this.net?.send({ t: "hit", id: a.id });
    this.hand.startSwing();
    this.self?.startSwing();
    this.net?.send({ t: "swing" });
    a.localHurt = performance.now() + 450;
    this.myHits.set(a.id, performance.now());
    this.sound.animal(a.spec.key, "hurt", { x: a.x, y: a.y + 0.5, z: a.z });
  }

  // v9: villagers
  private onVillager(s: AnimalSnap, t: number): void {
    if (!this.chunks) {
      this.pendingVillagers.push({ s, t });
      return;
    }
    let v = this.villagers.get(s.id);
    if (!v) {
      v = new VillagerView(s, this.villagerDefs.get(s.id)?.name ?? "Villager");
      this.villagers.set(s.id, v);
      this.villagerGroup.add(v.root);
    }
    // poked: the HURT flag going up (no damage), a startled sound for everyone near
    const before = this.villagerFlags.get(s.id) ?? 0;
    if (s.flags & VF.HURT && !(before & VF.HURT)) this.sound.villager("hurt", { x: s.x, y: s.y + 1.5, z: s.z });
    this.villagerFlags.set(s.id, s.flags);
    v.push(s, t);
  }

  private removeVillager(id: number): void {
    const v = this.villagers.get(id);
    if (!v) return;
    this.villagerGroup.remove(v.root);
    v.dispose();
    this.villagers.delete(id);
    this.villagerFlags.delete(id);
    this.villagerLight.delete(id);
    if (this.targetVillager === v) this.targetVillager = null;
  }

  /** Right click on a villager: ask for its trade window (the server checks the reach). */
  private talkTo(v: VillagerView): void {
    this.sendMove();
    this.net?.send({ t: "talk", id: v.id });
    this.hand.startSwing();
  }

  /** Left click on a villager: a poke (villagers take no damage). */
  private pokeVillager(v: VillagerView): void {
    this.lastSwingTick = this.tickCount;
    this.sendMove();
    this.net?.send({ t: "hit", id: v.id, villager: true });
    this.hand.startSwing();
    this.self?.startSwing();
    this.net?.send({ t: "swing" });
    v.localHurt = performance.now() + 300;
  }

  private onMob(s: AnimalSnap, t: number): void {
    if (!this.chunks) {
      this.pendingMobs.push({ s, t });
      return;
    }
    let m = this.mobs.get(s.id);
    if (!m) {
      if (!MOB_SPECS[s.kind]) return;
      m = new MobView(s);
      this.mobs.set(s.id, m);
      this.mobGroup.add(m.root);
    }
    // a hit shows as the HURT flag going up: everyone nearby hears it (we already played our own hit)
    const before = this.mobFlags.get(s.id) ?? 0;
    if (s.flags & MF.HURT && !(before & MF.HURT)) {
      const mine = this.myMobHits.get(s.id);
      if (!mine || performance.now() - mine > 800) this.sound.mob(MOB_SPECS[s.kind].key, "hurt", { x: s.x, y: s.y + 1, z: s.z });
    }
    this.mobFlags.set(s.id, s.flags);
    m.push(s, t);
  }

  private removeMob(id: number): void {
    const m = this.mobs.get(id);
    if (!m) return;
    this.mobGroup.remove(m.root);
    m.dispose();
    this.mobs.delete(id);
    this.mobFlags.delete(id);
    this.mobLight.delete(id);
    if (this.targetMob === m) this.targetMob = null;
  }

  private removeArrow(id: number): void {
    const a = this.arrows.get(id);
    if (!a) return;
    this.arrowGroup.remove(a.root);
    a.dispose();
    this.arrows.delete(id);
  }

  /** Left click on a night mob: tell the server (it judges the charge and the crit), swing, flash it red. */
  private hitMob(m: MobView): void {
    this.sendMove(); // the server judges the hit (reach, a critical on the way down) from where we are now
    this.net?.send({ t: "hit", id: m.id, mob: true });
    this.hand.startSwing();
    this.self?.startSwing();
    this.net?.send({ t: "swing" });
    this.lastSwingTick = this.tickCount;
    m.localHurt = performance.now() + 450;
    this.myMobHits.set(m.id, performance.now());
    this.sound.mob(m.spec.key, "hurt", { x: m.x, y: m.y + 1, z: m.z });
  }

  // ================================================================== v8: boats

  private onBoat(s: BoatSnap, t: number): void {
    if (!this.chunks) {
      this.pendingBoats.push({ s, t });
      return;
    }
    let b = this.boats.get(s.id);
    if (!b) {
      b = new BoatView(s);
      this.boats.set(s.id, b);
      this.boatGroup.add(b.root);
    }
    // a hit shows as the HURT flag going up: a knock on wood for everyone near
    if (s.flags & BF.HURT && !(b.flags & BF.HURT) && performance.now() > b.localHurt) this.sound.hit("wood");
    b.push(s, t); // (the boat we row is drawn from our prediction; its snapshots are kept for when we get out)
  }

  private removeBoat(id: number): void {
    const b = this.boats.get(id);
    if (!b) return;
    this.boatGroup.remove(b.root);
    b.dispose();
    this.boats.delete(id);
    this.boatLight.delete(id);
    if (this.targetBoat === b) this.targetBoat = null;
  }

  private ridersOf(boat: number): number {
    let n = 0;
    for (const r of this.rides.values()) if (r.b === boat) n++;
    return n;
  }

  /** Someone sat down in a boat, moved seats, or got out (b 0). Seat 0 rows. */
  private onRide(pid: number, bid: number, seat: number): void {
    if (bid === 0) this.rides.delete(pid);
    else this.rides.set(pid, { b: bid, s: seat });
    if (pid !== this.myId) return;
    if (bid === 0) {
      const bv = this.ride ? this.boats.get(this.ride.id) : undefined;
      if (bv) bv.local = null;
      this.ride = null;
      this.myBoat = null;
      this.lastRideYaw = null;
      return;
    }
    const was = this.ride;
    this.ride = { id: bid, seat };
    const bv = this.boats.get(bid);
    if (seat === 0) {
      if (!this.myBoat || was?.id !== bid) {
        this.myBoat = newBoat(bv ? bv.x : this.phys.x, bv ? bv.y : this.phys.y + 0.4, bv ? bv.z : this.phys.z, bv ? bv.yaw : this.yaw);
        this.lastBoatSent.at = 0;
      }
    } else {
      this.myBoat = null;
      if (bv) bv.local = null;
    }
    if (!was) {
      this.cancelDig();
      this.stopEating();
      this.cancelDrawing();
      if (!this.rideHinted) {
        this.rideHinted = true;
        this.ui.notice(this.touchMode ? "Row with the stick. Tap Sneak to get out." : "Row with W, A, S and D. Sneak (Shift) to get out.");
      }
    }
  }

  /** What the driver presses (W/S row, A/D turn; the touch stick the same way). */
  private boatInput(): BoatInput {
    const k = this.keys;
    const on = this.state === "play" && !this.dead;
    let fwd = 0;
    let turn = 0;
    if (on) {
      if (k.has("KeyW")) fwd += 1;
      if (k.has("KeyS")) fwd -= 1;
      if (k.has("KeyA")) turn -= 1;
      if (k.has("KeyD")) turn += 1;
      if (this.touchMode) {
        fwd += this.touch.fwd > 0.3 ? 1 : this.touch.fwd < -0.3 ? -1 : 0;
        turn += this.touch.strafe > 0.3 ? -1 : this.touch.strafe < -0.3 ? 1 : 0;
      }
    }
    return { forward: fwd > 0, back: fwd < 0, left: turn < 0, right: turn > 0 };
  }

  /** One tick in a boat: row ours (predicted, sent to the server), or sit in someone else's; we sit at our seat. */
  private rideTick(): void {
    const r = this.ride!;
    const bv = this.boats.get(r.id);
    const p = this.phys;
    const b = this.myBoat;
    const n = Math.max(1, this.ridersOf(r.id));
    if (b) {
      const before = b.yaw;
      const input = this.boatInput();
      tickBoat(b, input, this.get);
      const pad = paddles(input);
      this.boatRows = (pad.left ? BF.ROW_L : 0) | (pad.right ? BF.ROW_R : 0);
      this.yaw += wrapDeg(b.yaw - before); // the view turns with the boat
      bv?.setLocal(b.x, b.y, b.z, b.yaw, this.boatRows | BF.DRIVEN);
      if (this.boatRows && this.tickCount - (this.paddleAt.get(r.id) ?? -100) >= 11) {
        this.paddleAt.set(r.id, this.tickCount);
        this.sound.paddle({ x: b.x, y: b.y + 0.4, z: b.z });
      }
      this.sendBoat();
      const s = seatPos(b, r.seat, n);
      p.x = s.x;
      p.y = s.y;
      p.z = s.z;
    } else if (bv) {
      const s = seatPos(bv, r.seat, n);
      p.x = s.x;
      p.y = s.y;
      p.z = s.z;
    }
    p.vx = p.vy = p.vz = 0;
    p.onGround = true;
    p.inWater = false;
    p.sprinting = p.crouched = p.sneaking = false;
    p.fallDist = 0;
    // like the classic boat, you can look up to 105 degrees either side of the bow
    const by = b ? b.yaw : bv?.yaw;
    if (by !== undefined) this.yaw = by + Math.max(-105, Math.min(105, wrapDeg(this.yaw - by)));
  }

  /** Our boat to the server: every tick while it moves (and once a second at rest). */
  private sendBoat(): void {
    const b = this.myBoat;
    if (!b || !this.ride || !this.net) return;
    const l = this.lastBoatSent;
    const now = performance.now();
    const moved = Math.abs(l.x - b.x) > 0.002 || Math.abs(l.y - b.y) > 0.002 || Math.abs(l.z - b.z) > 0.002 || Math.abs(wrapDeg(l.yaw - b.yaw)) > 0.2 || l.r !== this.boatRows;
    if (!moved && now - l.at < 1000) return;
    this.net.send({ t: "boat", id: this.ride.id, x: +b.x.toFixed(3), y: +b.y.toFixed(3), z: +b.z.toFixed(3), yaw: +b.yaw.toFixed(2), r: this.boatRows });
    this.lastBoatSent = { x: b.x, y: b.y, z: b.z, yaw: b.yaw, r: this.boatRows, at: now };
  }

  /** Left click on a boat: hits add up until it breaks into a boat item. */
  private hitBoat(b: BoatView): void {
    this.sendMove();
    this.net?.send({ t: "hit", id: b.id, boat: true });
    this.hand.startSwing();
    this.self?.startSwing();
    this.net?.send({ t: "swing" });
    this.lastSwingTick = this.tickCount;
    b.localHurt = performance.now() + 400;
    this.sound.hit("wood");
  }

  private mountBoat(b: BoatView): void {
    this.sendMove();
    this.net?.send({ t: "mount", id: b.id });
    this.hand.startSwing();
  }

  /** Where a boat from the hand would go: the water surface the look ray reaches, or the top of a block. */
  private boatSpot(): { x: number; y: number; z: number } | null {
    const cp = Math.cos(this.pitch * DEG);
    const dx = -Math.sin(this.yaw * DEG) * cp;
    const dy = -Math.sin(this.pitch * DEG);
    const dz = Math.cos(this.yaw * DEG) * cp;
    const p = this.phys;
    const ex = p.x;
    const ey = p.y + this.eye;
    const ez = p.z;
    let lastY = Math.floor(ey);
    for (let t = 0.3; t <= REACH; t += 0.05) {
      const x = ex + dx * t;
      const y = ey + dy * t;
      const z = ez + dz * t;
      const bx = Math.floor(x);
      const by = Math.floor(y);
      const bz = Math.floor(z);
      if (!inWorld(bx, by, bz)) return null;
      const id = this.get(bx, by, bz);
      if (IS_WATER[id]) {
        const s = waterSurface(this.get, bx, by, bz);
        if (y <= s) return { x, y: s, z };
      } else if (SOLID[id]) {
        return lastY > by ? { x, y: by + 1, z } : null;
      }
      lastY = by;
    }
    return null;
  }

  private placeBoat(): void {
    const at = this.boatSpot();
    if (!at) return;
    this.net?.send({ t: "boat_place", x: +at.x.toFixed(3), y: +at.y.toFixed(3), z: +at.z.toFixed(3) });
    this.hand.startSwing();
    this.self?.startSwing();
  }

  private addOther(p: PlayerInfo): void {
    if (p.id === this.myId || this.others.has(p.id)) return;
    const rp = new RemotePlayer(p, (id) => heldBlockMesh(id, this.heldMat));
    this.others.set(p.id, rp);
    this.othersGroup.add(rp.root);
  }

  private onClosed(code: number, reason: string): void {
    if (this.state === "closed") return;
    this.state = "closed";
    window.removeEventListener("beforeunload", this.beforeUnload);
    document.exitPointerLock?.();
    this.ui.showHud(false);
    const kicked = this.kicked;
    const restarting = code === 1012 || /restart/i.test(kicked);
    if (!kicked || restarting || this.spec) {
      // A server restart or a network blip: come back on our own (a spectator always does).
      let left = restarting ? 8 : 5;
      const line = () => `${restarting ? "The server is restarting." : "The connection was lost."} Reconnecting in ${left}s.`;
      this.ui.showMessage(restarting ? "Server restarting" : "Connection Lost", line(), [
        { label: "Rejoin now", onClick: () => location.reload() },
        { label: "Back to Title Screen", onClick: () => this.backToTitle() },
      ]);
      const t = window.setInterval(() => {
        left--;
        if (left <= 0) {
          window.clearInterval(t);
          location.reload();
        } else this.ui.setMessageDetail(line());
      }, 1000);
      return;
    }
    this.ui.showMessage("Disconnected", kicked || reason || "Disconnected.", [
      { label: "Rejoin", onClick: () => location.reload() },
      { label: "Back to Title Screen", onClick: () => this.backToTitle() },
    ]);
  }

  private updateServerLine(): void {
    if (this.spec) return this.ui.setServer(`Watching ${this.spec}`);
    const n = this.shard.players;
    this.ui.setServer(`Server ${this.shard.n} · ${n} player${n === 1 ? "" : "s"}`);
  }

  // ================================================================== clankersmp: watching an AI

  /** Watch the AI with this player id (0: it isn't in the world, and the camera stays put). The camera jumps to it:
   *  nothing eases across the jump. */
  private watch(id: number): void {
    this.folId = id;
    this.folDig = null;
    const o = this.others.get(id);
    if (!o) return;
    this.fcam.jump(o.x, o.y, o.z, o.yaw, o.pitch, o.flags);
    this.hand.setSkin(o.skin);
    const p = this.phys;
    p.x = this.prev.x = o.x;
    p.y = this.prev.y = o.y;
    p.z = this.prev.z = o.z;
    this.eye = this.prevEye = o.flags & FLAG.SNEAK ? SNEAK_EYE_HEIGHT : EYE_HEIGHT;
    this.chunks.updatePos(o.x, o.y, o.z);
  }

  /** Watch another AI (window.postMessage from the page around us): the server streams the world around it now. */
  private follow(name: string): void {
    if (name === this.spec) return;
    this.spec = name;
    this.fol = null;
    this.folDeath = "";
    this.stats = { hp: 20, food: 20, sat: 5, air: 300 };
    this.net?.send({ t: "follow", name });
    this.watch([...this.others.values()].find((o) => o.name === name)?.id ?? 0);
    this.updateServerLine();
    try {
      const u = new URL(location.href);
      u.searchParams.set("follow", name);
      history.replaceState(history.state, "", u); // a reconnect (it reloads the page) comes back to this one
    } catch {
      /* the address keeps the first one */
    }
  }

  /** A spectator has no controls. A click turns the sound on (the browser keeps it off until one), and the page around
   *  us can switch AI: window.postMessage({ type: "follow", name: "sonnet" }). */
  private bindWatching(): void {
    window.addEventListener("pointerdown", () => {
      this.unlockAudio();
      if (!this.embed) void this.music.start();
    });
    window.addEventListener("message", (e) => {
      const d = e.data as { type?: unknown; name?: unknown; mode?: unknown } | null;
      if (d && typeof d === "object" && d.type === "view") {
        this.view = d.mode === "third" ? 1 : 0; // through its eyes, or from behind it
        return;
      }
      if (!d || typeof d !== "object" || d.type !== "follow" || typeof d.name !== "string") return;
      const name = d.name.toLowerCase();
      if (/^[a-z0-9_]{1,16}$/.test(name)) this.follow(name);
    });
  }

  /** The AI's HUD, sent again whenever it changes: hearts, food, armour, the hotbar and its hand, dead or not. */
  private onFol(m: Extract<S2C, { t: "fol" }>): void {
    if (m.name !== this.spec) return; // still about the one we watched before
    this.fol = m;
    if (this.state === "loading") return; // start() applies it once the world is up
    if (m.id && m.id !== this.folId) this.watch(m.id);
    const held = this.heldId();
    // an AI that isn't in the world comes without its HUD: nothing of the one watched before stays on screen
    this.stats = m.stats ?? { ...this.stats, hp: m.dead ? 0 : this.stats.hp };
    for (let k = 0; k < 9; k++) this.inv.inv[k] = fromWire(m.hot?.[k]);
    for (let k = 0; k < 4; k++) this.inv.armor[k] = fromWire(m.armor?.[k]);
    this.slot = m.sel ?? this.slot;
    if (this.heldId() !== held) this.ui.selectSlot(this.slot, this.heldId()); // its name over the hotbar for a moment
    this.refreshHotbar();
    this.armorChanged();
    if (m.msg) this.folDeath = m.msg;
    this.watchDead(m.dead);
    this.ui.setClickToPlay(!m.online && !m.dead, `${m.name} is offline`);
  }

  /** The AI died (or, off hardcore, came back): the game-over screen. The camera stays where it fell. */
  private watchDead(dead: boolean): void {
    if (dead === this.dead) return;
    this.dead = dead;
    this.state = dead ? "dead" : "play";
    this.folDig = null;
    this.ui.root.classList.toggle("watchdead", dead);
    if (dead) this.ui.showGameOver(this.folDeath || `${this.spec} died.`);
    else this.ui.closeScreen();
  }

  /** The AI starts, stops or finishes digging a block: the crack and the hits (watchTick), its arm swinging. The block
   *  itself goes in a BLOCKS message, with its sound. */
  private onFdig(m: Extract<S2C, { t: "fdig" }>): void {
    if (!this.spec || m.id !== this.folId) return;
    this.folDig = null;
    if (m.a !== "start" || !inWorld(m.x, m.y, m.z)) return;
    const id = this.get(m.x, m.y, m.z);
    if (id === B.AIR || IS_WATER[id]) return;
    // the hit particles fly off the face toward its eyes
    const dx = this.phys.x - m.x - 0.5;
    const dy = this.phys.y + this.eye - m.y - 0.5;
    const dz = this.phys.z - m.z - 0.5;
    const ax = Math.abs(dx);
    const ay = Math.abs(dy);
    const az = Math.abs(dz);
    const face = ax >= ay && ax >= az ? (dx > 0 ? 0 : 1) : ay >= az ? (dy > 0 ? 2 : 3) : dz > 0 ? 4 : 5;
    this.folDig = { x: m.x, y: m.y, z: m.z, id, face, progress: 0, prev: 0, ticks: 0 };
    this.sound.hit(BLOCKS[id].sound);
    this.hand.startSwing();
  }

  /** A spectator's tick: our body is where the AI's eyes are (the light, the chunks, the sounds, the view bob and the
   *  sprint FOV follow it), and its dig and its meal go on in the hand. */
  private watchTick(): void {
    const p = this.phys;
    const c = this.fcam;
    const step = Math.hypot(c.x - p.x, c.z - p.z) < 2; // more is a jump (another AI, a respawn): no step, no bob
    p.vx = step ? c.x - p.x : 0;
    p.vy = step ? c.y - p.y : 0;
    p.vz = step ? c.z - p.z : 0;
    p.x = c.x;
    p.y = c.y;
    p.z = c.z;
    p.walkDist += Math.sqrt(p.vx * p.vx + p.vz * p.vz) * 0.6;
    p.onGround = (c.flags & FLAG.GROUND) !== 0;
    p.inWater = (c.flags & FLAG.WATER) !== 0;
    p.sprinting = (c.flags & FLAG.SPRINT) !== 0;
    p.crouched = p.sneaking = (c.flags & FLAG.SNEAK) !== 0;
    const d = this.folDig;
    if (d) {
      d.prev = d.progress;
      if (this.get(d.x, d.y, d.z) !== d.id) this.folDig = null;
      else {
        // the server times the dig; this is the same sum, for the crack
        const bt = breakTicks(d.id, this.heldId(), p.inWater && eyeInWater(this.get, p.x, p.y + this.eye, p.z), p.onGround);
        d.ticks++;
        d.progress = Math.min(1, d.progress + 1 / Math.max(1, bt));
        if (d.ticks % 4 === 0) this.sound.hit(BLOCKS[d.id].sound);
        this.particles.hitFace(d.x, d.y, d.z, d.face, d.id, this.lightHere);
        this.hand.startSwing();
      }
    }
    if (c.flags & FLAG.EAT && this.heldId() !== I.BOW) {
      if (this.folEat < 0) {
        this.folEat = 0;
        this.hand.setEating(true, EAT_TICKS);
      }
      this.folEat++;
      const def = itemDef(this.heldId());
      if (def && this.folEat % 4 === 0 && this.folEat > 6) {
        if (def.drink) {
          if (this.folEat % 8 === 0) this.sound.drink();
        } else {
          this.sound.eat();
          this.particles.food(p.x, p.y + this.eye - 0.3, p.z, this.yaw, this.pitch, def.tex, this.lightHere);
        }
      }
    } else if (this.folEat >= 0) {
      this.folEat = -1;
      this.hand.finishEating();
    }
  }

  // ================================================================== light probe

  private lightReq = 0;

  private requestLight(): void {
    const cells: number[] = [];
    const ids: number[] = [];
    const cell = (x: number, y: number, z: number) => {
      const bx = Math.floor(x);
      const by = Math.floor(y);
      const bz = Math.floor(z);
      if (bx < 0 || bz < 0 || bx >= WORLD_SIZE || bz >= WORLD_SIZE || by < 0 || by >= WORLD_HEIGHT) return -1;
      return idx(bx, by, bz);
    };
    cells.push(cell(this.phys.x, this.phys.y + this.eye, this.phys.z));
    ids.push(-1);
    for (const o of this.others.values()) {
      cells.push(cell(o.x, o.y + 1.2, o.z));
      ids.push(o.id);
    }
    for (const a of this.animals.values()) {
      if (Math.abs(a.x - this.phys.x) > 64 || Math.abs(a.z - this.phys.z) > 64) continue;
      cells.push(cell(a.x, a.y + a.spec.h * 0.6, a.z));
      ids.push(-1000 - a.id);
    }
    for (const d of this.drops.values()) {
      if (Math.abs(d.x - this.phys.x) > 40 || Math.abs(d.z - this.phys.z) > 40) continue;
      cells.push(cell(d.x, d.y + 0.2, d.z));
      ids.push(-100000 - d.id);
    }
    for (const m of this.mobs.values()) {
      if (Math.abs(m.x - this.phys.x) > 64 || Math.abs(m.z - this.phys.z) > 64) continue;
      cells.push(cell(m.x, m.y + m.spec.h * 0.6, m.z));
      ids.push(-200000 - m.id);
    }
    for (const b of this.boats.values()) {
      if (Math.abs(b.x - this.phys.x) > 64 || Math.abs(b.z - this.phys.z) > 64) continue;
      cells.push(cell(b.x, b.y + 0.7, b.z));
      ids.push(-300000 - b.id);
    }
    for (const v of this.villagers.values()) {
      if (Math.abs(v.x - this.phys.x) > 64 || Math.abs(v.z - this.phys.z) > 64) continue;
      cells.push(cell(v.x, v.y + 1.2, v.z));
      ids.push(-400000 - v.id);
    }
    this.lightReq++;
    this.chunks.requestLight(this.lightReq, cells);
    this.lightIds.set(this.lightReq, ids);
  }

  private lightIds = new Map<number, number[]>();

  private onLight(reqId: number, values: number[]): void {
    const ids = this.lightIds.get(reqId);
    this.lightIds.delete(reqId);
    if (!ids) return;
    values.forEach((v, k) => {
      const l: [number, number] = [(v >> 4) / 15, (v & 15) / 15];
      if (ids[k] === -1) this.lightHere = l;
      else if (ids[k] <= -400000) this.villagerLight.set(-400000 - ids[k], l);
      else if (ids[k] <= -300000) this.boatLight.set(-300000 - ids[k], l);
      else if (ids[k] <= -200000) this.mobLight.set(-200000 - ids[k], l);
      else if (ids[k] <= -100000) this.dropLight.set(-100000 - ids[k], l);
      else if (ids[k] <= -1000) this.animalLight.set(-1000 - ids[k], l);
      else this.otherLight.set(ids[k], l);
    });
  }

  // ================================================================== input

  private bindInput(): void {
    const c = this.canvas;
    c.addEventListener("click", () => {
      this.unlockAudio();
      if (this.state === "play" && !this.hasLock && !this.touchMode) this.lock();
    });
    document.addEventListener("pointerlockchange", () => {
      const locked = document.pointerLockElement === c;
      this.hasLock = locked;
      if (locked) {
        this.ui.showTitle(false);
        void this.music.start(); // the first click in: music may start a little later
        if (this.state === "paused") this.ui.closeScreen();
        this.state = "play";
        this.ui.setClickToPlay(false);
      } else if (this.state === "play") {
        this.unlockedAt = performance.now();
        this.state = "paused";
        this.keys.clear();
        this.mouse = 0;
        this.ui.showPause(this.settings, this.serverLine());
      }
    });
    document.addEventListener("mousemove", (e) => {
      if (!this.hasLock || this.state !== "play") return;
      this.look(e.movementX, e.movementY);
    });
    document.addEventListener("mousedown", (e) => {
      if (!this.hasLock || this.state !== "play") return;
      this.unlockAudio();
      this.mouse |= 1 << e.button;
      if (e.button === 0) this.destroyDelay = 0;
      if (e.button === 0 && !this.target && !this.targetAnimal && !this.targetMob && !this.targetBoat && !this.targetVillager) this.swingAtNothing();
      if (e.button === 2) {
        this.rightClick();
        this.placeDelay = 4;
      }
      if (e.button === 1) {
        e.preventDefault();
        this.pickBlock();
      }
    });
    document.addEventListener("mouseup", (e) => {
      this.mouse &= ~(1 << e.button);
      if (e.button === 2) {
        this.stopEating();
        this.releaseBow();
      }
    });
    document.addEventListener("contextmenu", (e) => e.preventDefault());
    document.addEventListener(
      "wheel",
      (e) => {
        if (this.state !== "play" || !this.hasLock) return;
        const d = Math.sign(e.deltaY);
        if (d) this.selectSlot((this.slot + d + 9) % 9);
      },
      { passive: true },
    );
    document.addEventListener("keydown", (e) => this.onKey(e, true));
    document.addEventListener("keyup", (e) => this.onKey(e, false));
    window.addEventListener("blur", () => {
      this.keys.clear();
      this.mouse = 0;
    });
  }

  /** A swing at the air: the arm swings, and the attack cooldown starts over (here and on the server). */
  private swingAtNothing(): void {
    if (this.state !== "play" || this.dead) return;
    this.hand.startSwing();
    this.self?.startSwing();
    this.net?.send({ t: "swing" });
    this.lastSwingTick = this.tickCount;
  }

  private lock(): void {
    const c = this.canvas as HTMLCanvasElement & { requestPointerLock(o?: unknown): Promise<void> | void };
    try {
      const p = c.requestPointerLock({ unadjustedMovement: true });
      if (p && typeof (p as Promise<void>).catch === "function") {
        (p as Promise<void>).catch(() => {
          try {
            const q = c.requestPointerLock();
            if (q && typeof (q as Promise<void>).catch === "function") (q as Promise<void>).catch(() => this.ui.setClickToPlay(true, "Click to play"));
          } catch {
            this.ui.setClickToPlay(true, "Click to play");
          }
        });
      }
    } catch {
      this.ui.setClickToPlay(true, "Click to play");
    }
  }

  private look(dx: number, dy: number): void {
    // Java: f = sens * 0.6 + 0.2; degrees per pixel = f^3 * 8 * 0.15
    const s = this.settings.sensitivity * 0.5 * 0.6 + 0.2;
    const k = s * s * s * 8 * 0.15;
    this.yaw = (this.yaw + dx * k) % 360;
    this.pitch = Math.max(-90, Math.min(90, this.pitch + dy * k));
  }

  private onKey(e: KeyboardEvent, down: boolean): void {
    if (this.state === "loading" || this.state === "closed" || this.state === "dead") return;
    if (this.ui.chatOpen) return;
    const code = e.code;
    if (this.state === "inventory") {
      if (!down) return;
      if (code === "KeyE" || code === "Escape") {
        e.preventDefault();
        return this.closeInventory();
      }
      if (this.invUI.key(code, e.ctrlKey || e.metaKey)) e.preventDefault();
      return;
    }
    if (["Tab", "F1", "F3", "F5", "Space", "Slash", "Quote"].includes(code)) e.preventDefault();
    if (this.state === "picker") {
      if (down && (code === "KeyE" || code === "Escape")) this.closePicker();
      if (down && /^Digit[1-9]$/.test(code)) {
        const hover = this.ui.pickerHover();
        if (hover > 0) {
          const s = Number(code.slice(5)) - 1;
          this.setSlotBlock(s, hover);
          this.ui.showPicker(this.hotbarStacks().map((x) => x?.id ?? 0), this.slot);
        }
      }
      return;
    }
    if (this.state === "paused") {
      // The Esc that released the pointer lock can arrive here too; ignore it for a moment.
      if (down && code === "Escape" && performance.now() - this.unlockedAt > 400) this.resume();
      return;
    }
    if (down) {
      this.unlockAudio();
      if (code === "KeyW" && !e.repeat) {
        const now = performance.now();
        if (now - this.lastWTap < 300) this.sprintToggle = true;
        this.lastWTap = now;
      }
      if (!e.repeat) {
        if ((code === "ShiftLeft" || code === "ShiftRight") && this.ride) this.net?.send({ t: "dismount" }); // v8
        if (code === "KeyT") return this.openChat("", e);
        if (code === "Slash") return this.openChat("/", e);
        if (code === "KeyE") return this.openInventory();
        if (code === "KeyQ") return this.dropHeld(e.ctrlKey || e.metaKey);
        if (code === "F3") {
          this.debug = !this.debug;
          if (!this.debug) this.ui.setDebug(null);
        }
        if (code === "Tab") this.tabHeld = true;
        if (code === "F1") {
          this.hudHidden = !this.hudHidden;
          this.ui.root.classList.toggle("nohud", this.hudHidden);
        }
        if (code === "F5") this.view = (this.view + 1) % 3;
        if (/^Digit[1-9]$/.test(code)) this.selectSlot(Number(code.slice(5)) - 1);
      }
      this.keys.add(code);
    } else {
      this.keys.delete(code);
      if (code === "KeyW") this.sprintToggle = false;
      if (code === "Tab") this.tabHeld = false;
    }
  }

  private openChat(prefix: string, e?: KeyboardEvent): void {
    e?.preventDefault();
    this.state = "chat";
    this.keys.clear();
    this.mouse = 0;
    document.exitPointerLock?.();
    this.ui.openChat(prefix);
  }

  private afterOverlayClosed(): void {
    this.state = "play";
    if (!this.touchMode) {
      this.lock();
      setTimeout(() => {
        if (!this.hasLock && this.state === "play") this.ui.setClickToPlay(true, "Click to play");
      }, 300);
    }
  }

  private openPicker(): void {
    this.state = "picker";
    this.keys.clear();
    this.mouse = 0;
    document.exitPointerLock?.();
    this.ui.showPicker(this.hotbarStacks().map((x) => x?.id ?? 0), this.slot);
  }

  private closePicker(): void {
    this.ui.closeScreen();
    this.afterOverlayClosed();
  }

  private resume(): void {
    this.ui.closeScreen();
    this.state = "play";
    if (this.touchMode) return;
    this.lock();
    setTimeout(() => {
      if (!this.hasLock && this.state === "play") this.ui.setClickToPlay(true, "Click to play");
    }, 300);
  }

  private backToTitle(): void {
    window.removeEventListener("beforeunload", this.beforeUnload);
    this.net?.close();
    location.href = "/";
  }

  private beforeUnload = (e: BeforeUnloadEvent) => {
    // Ctrl+W while sprinting would otherwise close the tab.
    if (this.state === "play" || this.state === "paused") {
      e.preventDefault();
      e.returnValue = "";
    }
  };

  private selectSlot(s: number): void {
    if (s !== this.slot) this.cancelDrawing(); // v7: putting the bow away lets the string go slack
    if (s !== this.slot) this.net?.send({ t: "sel", s });
    // v6: a different item in hand starts the attack cooldown over (the server does the same)
    if ((this.inv.inv[this.slot]?.id ?? 0) !== (this.inv.inv[s]?.id ?? 0)) this.lastSwingTick = this.tickCount;
    this.slot = s;
    this.stopEating();
    this.ui.selectSlot(s, this.heldId());
    this.refreshHotbar();
  }

  /** Creative only: any block into a hotbar slot (the server checks the mode). */
  private setSlotBlock(slot: number, id: number): void {
    if (this.gm !== "creative") return;
    this.inv.inv[slot] = id ? { id, n: itemDef(id)?.stack ?? 64, d: 0 } : null;
    this.net?.send({ t: "cset", s: slot, id });
    this.refreshHotbar();
  }

  /** Q: throw one of the held item (Ctrl+Q: the stack). */
  private dropHeld(all: boolean): void {
    const st = this.inv.inv[this.slot];
    if (!st || this.state !== "play") return;
    const n = all ? st.n : 1;
    this.inv.inv[this.slot] = st.n - n > 0 ? { ...st, n: st.n - n } : null;
    this.net?.send({ t: "drop", all });
    this.hand.startSwing();
    this.refreshHotbar();
  }

  /** Mute or unmute one player's voice (kept by name in the settings; the server is told to stop sending it). */
  private setVoiceMute(name: string, on: boolean): void {
    if (on) this.voice.muted.add(name);
    else this.voice.muted.delete(name);
    this.settings.voiceMuted = [...this.voice.muted];
    saveSettings(this.settings);
    this.voiceMutesDirty = true;
  }

  private unlockAudio(): void {
    this.sound.unlock();
    this.voice?.unlock();
  }

  private applySettings(s: Settings): void {
    this.settings = s;
    saveSettings(s);
    this.voice.openMic = s.voiceOpenMic;
    this.voice.setHear(s.voiceHear);
    this.voice.setVolume(s.voiceVolume);
    this.sound.setVolume(s.volume);
    this.music.setVolume(s.music ?? 0.5);
    this.renderDist = s.renderDistance;
    this.chunks.setRadius(s.renderDistance + 1);
    this.particles.setScale(window.innerHeight * this.renderer.getPixelRatio(), s.fov);
  }

  private serverLine(): string {
    return `Server ${this.shard.n} · ${this.shard.players}/${this.shard.cap} players · ${Math.round(this.rtt)} ms`;
  }

  /** Middle click: select the hotbar slot holding that block (creative: put it there). */
  private pickBlock(): void {
    const t = this.target;
    if (!t) return;
    const item = ITEM_OF[t.id];
    const at = this.hotbarStacks().findIndex((s) => s?.id === item);
    if (at >= 0) this.selectSlot(at);
    else if (this.gm === "creative" && BLOCKS[item]?.placeable) this.setSlotBlock(this.slot, item);
  }

  // ================================================================== touch (basic)

  private setupTouch(): void {
    const root = document.createElement("div");
    root.className = "touch";
    document.getElementById("ui")!.appendChild(root);
    const stick = document.createElement("div");
    stick.className = "stick";
    const nub = document.createElement("div");
    nub.className = "nub";
    stick.appendChild(nub);
    root.appendChild(stick);
    let stickId = -1;
    let cx = 0;
    let cy = 0;
    stick.addEventListener("pointerdown", (e) => {
      stickId = e.pointerId;
      const r = stick.getBoundingClientRect();
      cx = r.left + r.width / 2;
      cy = r.top + r.height / 2;
      stick.setPointerCapture(e.pointerId);
    });
    stick.addEventListener("pointermove", (e) => {
      if (e.pointerId !== stickId) return;
      const r = stick.getBoundingClientRect().width / 2;
      let dx = (e.clientX - cx) / r;
      let dy = (e.clientY - cy) / r;
      const l = Math.hypot(dx, dy);
      if (l > 1) {
        dx /= l;
        dy /= l;
      }
      nub.style.transform = `translate(${dx * r * 0.6}px, ${dy * r * 0.6}px)`;
      this.touch.fwd = -dy;
      this.touch.strafe = -dx;
    });
    const endStick = () => {
      stickId = -1;
      nub.style.transform = "";
      this.touch.fwd = this.touch.strafe = 0;
    };
    stick.addEventListener("pointerup", endStick);
    stick.addEventListener("pointercancel", endStick);
    // Look by dragging anywhere else.
    let lookId = -1;
    let lx = 0;
    let ly = 0;
    this.canvas.addEventListener("pointerdown", (e) => {
      this.unlockAudio();
      void this.music.start();
      lookId = e.pointerId;
      lx = e.clientX;
      ly = e.clientY;
    });
    this.canvas.addEventListener("pointermove", (e) => {
      if (e.pointerId !== lookId) return;
      this.look((e.clientX - lx) * 1.4, (e.clientY - ly) * 1.4);
      lx = e.clientX;
      ly = e.clientY;
    });
    this.canvas.addEventListener("pointerup", () => (lookId = -1));
    const btn = (label: string, pos: Partial<Record<"left" | "right" | "top" | "bottom", string>>, onDown: () => void, onUp: () => void = () => {}, cls = "tbtn") => {
      const b = document.createElement("div");
      b.className = cls;
      b.textContent = label;
      Object.assign(b.style, pos);
      b.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.unlockAudio();
        onDown();
      });
      b.addEventListener("pointerup", onUp);
      b.addEventListener("pointercancel", onUp);
      root.appendChild(b);
      return b;
    };
    const above = (n: string) => `calc(var(--s) * 30 + ${n})`;
    btn("Jump", { right: "4vmin", bottom: above("0vmin") }, () => (this.touch.jump = true), () => (this.touch.jump = false));
    const sneak = btn("Sneak", { right: "21vmin", bottom: above("0vmin") }, () => {
      if (this.ride) {
        this.net?.send({ t: "dismount" }); // v8: out of the boat
        return;
      }
      this.touch.sneak = !this.touch.sneak;
      sneak.style.background = this.touch.sneak ? "rgba(255,255,160,0.35)" : "";
    });
    btn("Place", { right: "4vmin", bottom: above("17vmin") }, () => {
      this.mouse |= 4;
      if (this.heldId() === I.BOW) this.startDrawing();
      else this.tryPlace();
      this.placeDelay = 4;
    }, () => {
      this.mouse &= ~4;
      this.releaseBow();
    });
    btn("Dig", { right: "21vmin", bottom: above("17vmin") }, () => (this.mouse |= 1), () => (this.mouse &= ~1));
    // v11: hold to talk (shown while voice is on with push-to-talk)
    this.talkBtn = btn("Talk", { right: "38vmin", bottom: above("0vmin") }, () => (this.touchTalk = true), () => (this.touchTalk = false), "tbtn talk");
    this.talkBtn.style.display = "none";
    btn("Menu", { left: "3vmin", top: "3vmin" }, () => {
      this.state = "paused";
      this.ui.showPause(this.settings, this.serverLine());
    }, () => {}, "tbtn small");
    btn("Chat", { left: "18vmin", top: "3vmin" }, () => this.openChat(""), () => {}, "tbtn small");
    btn("Items", { left: "33vmin", top: "3vmin" }, () => this.openInventory(), () => {}, "tbtn small");
    document.getElementById("ui")!.classList.add("touch-mode");
    // Tap a hotbar slot to select it.
    document.querySelectorAll(".hotbar .slot").forEach((el, i) =>
      el.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        this.selectSlot(i);
      }),
    );
  }

  // ================================================================== tick (20 Hz)

  private moveInput(): MoveInput {
    const k = this.keys;
    const active = this.state === "play" && !this.sleeping && !this.dead;
    let forward = 0;
    let strafe = 0;
    if (active) {
      if (k.has("KeyW")) forward += 1;
      if (k.has("KeyS")) forward -= 1;
      if (k.has("KeyA")) strafe += 1;
      if (k.has("KeyD")) strafe -= 1;
      if (this.touchMode) {
        forward += this.touch.fwd;
        strafe += this.touch.strafe;
      }
    }
    return {
      forward,
      strafe,
      jump: active && (k.has("Space") || this.touch.jump),
      sneak: active && (k.has("ShiftLeft") || k.has("ShiftRight") || this.touch.sneak),
      sprint: active && (k.has("ControlLeft") || k.has("ControlRight") || this.sprintToggle || (this.touchMode && this.touch.fwd > 0.95)),
      yaw: this.yaw,
    };
  }

  private get = (x: number, y: number, z: number): number => this.blocks[idx(x, y, z)];

  private tick(): void {
    this.tickCount++;
    const p = this.phys;
    this.prev = { x: p.x, y: p.y, z: p.z };
    this.prevEye = this.eye;
    this.prevBob = this.bob;
    this.prevWalk = p.walkDist;
    this.prevFovMod = this.fovMod;

    // v8: in a boat we row (or sit) instead of walking; clankersmp: a spectator has no body of its own
    let res = { step: false, stepBlock: 0, landed: false, fell: 0 };
    if (this.spec) this.watchTick();
    else if (this.ride) this.rideTick();
    else res = tickPlayer(p, this.moveInput(), this.get);
    if (res.step) this.sound.step(BLOCKS[res.stepBlock].sound as SoundGroup);
    if (res.landed && res.fell > 1.5) this.sound.step(BLOCKS[blockBelow(this.get, p)].sound as SoundGroup);
    // Dust like Java: a puff when landing from a height, and a trail while sprinting.
    const under = blockBelow(this.get, p);
    if (under !== B.AIR && !IS_WATER[under]) {
      if (res.landed && res.fell > 3) this.particles.landing(p.x, p.y, p.z, under, Math.min(60, 10 + Math.floor(res.fell * 6)), this.lightHere);
      if (p.sprinting && p.onGround && !p.inWater) this.particles.sprint(p.x, p.y, p.z, p.vx, p.vz, under, this.lightHere);
    }
    if (this.self) {
      this.self.x = p.x;
      this.self.y = p.y;
      this.self.z = p.z;
      this.self.tick();
    }

    // Java's camera: the eye eases halfway to the pose's eye height each tick (1.62 standing, 1.27 crouched).
    const targetEye = p.crouched ? SNEAK_EYE_HEIGHT : EYE_HEIGHT;
    this.eye += (targetEye - this.eye) * 0.5;
    const hs = Math.min(0.1, Math.sqrt(p.vx * p.vx + p.vz * p.vz));
    this.bob += ((p.onGround ? hs : 0) - this.bob) * 0.4;
    // v7: drawing a bow zooms in a little (up to 15% at full draw, like the classic game)
    const pull = this.drawing ? Math.min(1, (this.tickCount - this.drawing.start) / 20) : 0;
    this.fovMod += ((p.sprinting ? 1.15 : 1) * (1 - pull * pull * 0.15) - this.fovMod) * 0.5;

    if (!this.spec) this.interactTick();
    this.eatTick();
    if (this.hurtTime > 0) this.hurtTime--;
    // the spawn border
    const inside = this.inSafeZone(p.x, p.z);
    if (this.insideSafe !== null && inside !== this.insideSafe && !this.dead && !this.spec) this.ui.zoneToast(inside);
    this.insideSafe = inside;
    if (this.tickCount % 10 === 0) this.ui.setStats(this.stats, this.gm === "survival", this.armorPoints());
    this.particles.tick(this.get);
    this.hand.look(this.yaw, this.pitch);
    this.hand.tick();
    // v7: the bow: its pull for the hand; let go of it if it is gone from the hand or the button is up
    if (this.drawing) {
      if (this.heldId() !== I.BOW || this.state !== "play" || this.dead) this.cancelDrawing();
      else if (!(this.mouse & 4)) this.releaseBow();
      else this.hand.setDraw(Math.min(1, (this.tickCount - this.drawing.start) / 20));
    }
    for (const o of this.others.values()) {
      o.tick();
      if (!this.rides.has(o.id)) this.remoteSteps(o); // v8: no footsteps from someone in a boat
    }
    const tnow = performance.now();
    for (const an of this.animals.values()) {
      an.tick();
      // Now and then an animal nearby says something (each one about every 15 s, never two at once).
      const ddx = an.x - p.x;
      const ddz = an.z - p.z;
      if (ddx * ddx + ddz * ddz < 22 * 22 && Math.random() < (an.kind === 3 ? 1 / 220 : 1 / 320) && tnow - this.lastAnimalSound > 700) {
        this.lastAnimalSound = tnow;
        this.sound.animal(an.spec.key, "say", { x: an.x, y: an.y + an.spec.h * 0.7, z: an.z });
      }
    }

    // Night mobs: limbs, and now and then a sound from one near (never two at once).
    for (const m of this.mobs.values()) {
      m.tick();
      const ddx = m.x - p.x;
      const ddz = m.z - p.z;
      const d2 = ddx * ddx + ddz * ddz;
      if (d2 < 20 * 20 && !(m.flags & MF.DEAD) && Math.random() < 1 / 240 && tnow - this.lastMobSound > 900) {
        this.lastMobSound = tnow;
        this.sound.mob(m.spec.key, "say", { x: m.x, y: m.y + m.spec.h * 0.8, z: m.z });
      }
    }
    // v9 villagers: limbs, and now and then a whistle from one near
    for (const v of this.villagers.values()) {
      v.tick();
      const d2 = (v.x - p.x) ** 2 + (v.z - p.z) ** 2;
      if (d2 < 16 * 16 && Math.random() < 1 / 400 && tnow - this.lastVillagerSound > 1500) {
        this.lastVillagerSound = tnow;
        this.sound.villager("say", { x: v.x, y: v.y + 1.5, z: v.z });
      }
    }
    for (const a of this.arrows.values()) a.tick(this.get);
    // v8 boats: oars, and the oar strokes of the boats others row near us
    for (const b of this.boats.values()) {
      b.tick();
      if (this.ride && b.id === this.ride.id && this.myBoat) continue;
      if (b.flags & (BF.ROW_L | BF.ROW_R) && (b.x - p.x) ** 2 + (b.z - p.z) ** 2 < 24 * 24 && this.tickCount - (this.paddleAt.get(b.id) ?? -100) >= 11) {
        this.paddleAt.set(b.id, this.tickCount);
        this.sound.paddle({ x: b.x, y: b.y + 0.4, z: b.z });
      }
    }

    // Movement to the server at 10 Hz (and at least once a second).
    if (!this.spec && this.tickCount % 2 === 0) this.sendMove();
    if (this.tickCount % 5 === 0) this.requestLight();
    if (this.tickCount % 10 === 0) this.chunks.updatePos(p.x, p.y, p.z);
    for (const [i, t] of this.predicted) if (performance.now() - t > 5000) this.predicted.delete(i);
  }

  private remoteSteps(o: RemotePlayer): void {
    const s = this.otherSteps.get(o.id) ?? { x: o.x, z: o.z, d: 0 };
    const dx = o.x - s.x;
    const dz = o.z - s.z;
    s.x = o.x;
    s.z = o.z;
    if (!(o.flags & FLAG.SNEAK) && o.flags & FLAG.GROUND) {
      s.d += Math.sqrt(dx * dx + dz * dz) * 0.6;
      if (s.d > 1) {
        s.d = 0;
        const bx = Math.floor(o.x);
        const by = Math.floor(o.y - 0.2);
        const bz = Math.floor(o.z);
        if (inWorld(bx, by, bz)) {
          const id = this.get(bx, by, bz);
          if (id !== B.AIR && !IS_WATER[id]) this.sound.step(BLOCKS[id].sound as SoundGroup, { x: o.x, y: o.y, z: o.z });
        }
      }
    }
    this.otherSteps.set(o.id, s);
  }

  private sendMove(): void {
    if (!this.net) return;
    const p = this.phys;
    let flags = 0;
    if (p.crouched) flags |= FLAG.SNEAK; // the pose: others see the crouch (and its 1.5 box)
    if (p.sprinting) flags |= FLAG.SPRINT;
    if (p.onGround) flags |= FLAG.GROUND;
    if (p.inWater) flags |= FLAG.WATER;
    if (this.eating) flags |= FLAG.EAT;
    const held = this.slot; // v5: the selected hotbar slot (the server knows what's in it)
    const l = this.lastMove;
    const now = performance.now();
    const moved =
      Math.abs(l.x - p.x) > 0.001 || Math.abs(l.y - p.y) > 0.001 || Math.abs(l.z - p.z) > 0.001 ||
      Math.abs(l.yaw - this.yaw) > 0.5 || Math.abs(l.pitch - this.pitch) > 0.5 || l.flags !== flags || l.held !== held;
    if (!moved && now - l.at < 1000) return;
    this.net.sendBin(encodeMove({ x: p.x, y: p.y, z: p.z, yaw: this.yaw, pitch: this.pitch, flags, held }));
    this.lastMove = { x: p.x, y: p.y, z: p.z, yaw: this.yaw, pitch: this.pitch, flags, held, at: now };
  }

  // ================================================================== blocks

  /** The safe zone: no building for survival players (creative admins may). */
  private spawnProtected(x: number, z: number): boolean {
    return this.gm !== "creative" && this.inSafeZone(x + 0.5, z + 0.5);
  }

  /** Ticks to break a block with what we hold (creative: instant). */
  private breakTicksFor(id: number): number {
    if (this.gm === "creative") return BLOCKS[id] && id !== B.BEDROCK && !IS_WATER[id] ? 0 : -1;
    const eye = eyeInWater(this.get, this.phys.x, this.phys.y + this.eye, this.phys.z);
    return breakTicks(id, this.heldId(), eye && this.phys.inWater, this.phys.onGround);
  }

  private setLocal(x: number, y: number, z: number, id: number): void {
    const i = idx(x, y, z);
    if (this.blocks[i] === id) return;
    this.blocks[i] = id;
    this.predicted.set(i, performance.now());
    this.chunks.setBlocks([x, y, z, id]);
  }

  private interactTick(): void {
    const left = (this.mouse & 1) !== 0 && this.state === "play";
    const right = (this.mouse & 4) !== 0 && this.state === "play";
    const t = this.target;
    if (this.dig) this.dig.prev = this.dig.progress;
    if (!left) this.hitHeld = false;
    if (left && this.targetVillager) {
      // v9: a poke (in hitting reach), never digging the block behind it
      if (!this.hitHeld && this.targetVillagerDist <= ENTITY_REACH) this.pokeVillager(this.targetVillager);
      this.hitHeld = true;
      this.cancelDig();
      this.destroyDelay = 5;
    } else if (left && this.targetBoat) {
      // v8: one hit per click, like animals
      if (!this.hitHeld) this.hitBoat(this.targetBoat);
      this.hitHeld = true;
      this.cancelDig();
      this.destroyDelay = 5;
    } else if (left && this.targetMob) {
      if (!this.hitHeld) this.hitMob(this.targetMob);
      this.hitHeld = true;
      this.cancelDig();
      this.destroyDelay = 5;
    } else if (left && this.targetAnimal) {
      // One hit per click, like the classic games (holding the button does not keep hitting).
      if (!this.hitHeld) this.hitAnimal(this.targetAnimal);
      this.hitHeld = true;
      this.cancelDig();
      this.destroyDelay = 5;
    } else if (left && t) {
      if (this.spawnProtected(t.x, t.z)) {
        if (this.tickCount % 20 === 0 || !this.dig) this.ui.notice("Spawn is a safe zone: no building here. Head out past the gate!");
        this.cancelDig();
        this.hand.startSwing();
        return;
      }
      const bt = this.breakTicksFor(t.id);
      if (this.destroyDelay > 0) {
        this.destroyDelay--;
      } else if (this.dig && this.dig.x === t.x && this.dig.y === t.y && this.dig.z === t.z) {
        const d = this.dig;
        d.ticks++;
        d.progress += 1 / Math.max(1, bt);
        if (d.ticks % 4 === 0) this.sound.hit(BLOCKS[d.id].sound);
        this.particles.hitFace(d.x, d.y, d.z, t.face, d.id, this.lightHere);
        if (d.progress >= 1) {
          this.breakTarget(t);
          this.dig = null;
          this.destroyDelay = 5;
        }
      } else {
        this.cancelDig();
        if (bt === 0) {
          this.breakTarget(t);
          this.destroyDelay = 2;
        } else if (bt > 0) {
          this.dig = { x: t.x, y: t.y, z: t.z, id: t.id, face: t.face, progress: 0, prev: 0, ticks: 0 };
          this.net?.send({ t: "dig", a: "start", x: t.x, y: t.y, z: t.z });
          this.sound.hit(BLOCKS[t.id].sound);
        }
      }
      this.hand.startSwing();
      this.self?.startSwing();
      if (this.tickCount % 6 === 0) {
        this.net?.send({ t: "swing" });
        this.lastSwingTick = this.tickCount;
      }
    } else {
      this.cancelDig();
      if (!left) this.destroyDelay = 0;
    }
    if (right && !this.eating) {
      if (--this.placeDelay <= 0) {
        this.rightClick(true);
        this.placeDelay = 4;
      }
    }
  }

  private cancelDig(): void {
    if (this.dig) {
      this.net?.send({ t: "dig", a: "abort", x: this.dig.x, y: this.dig.y, z: this.dig.z });
      this.dig = null;
    }
  }

  private breakTarget(t: Hit): void {
    const { x, y, z, id } = t;
    // Same rules as the server: the other half of a door or bed goes too, unsupported neighbours pop off.
    for (const [cx, cy, cz, cid] of breakChanges(x, y, z, this.safeGet)) this.setLocal(cx, cy, cz, cid);
    this.net?.send({ t: "dig", a: "finish", x, y, z });
    this.sound.breakBlock(BLOCKS[id].sound);
    this.particles.breakBlock(x, y, z, id, this.lightHere);
  }

  /** Bounds-checked block lookup (outside the world is air). */
  private safeGet = (x: number, y: number, z: number): number => (inWorld(x, y, z) ? this.blocks[idx(x, y, z)] : B.AIR);

  /** Right click: use a block (doors, crafting tables, furnaces, chests, beds), else place the held block, else eat
   *  the held food. Sneak to place against a usable block instead (like Java). `repeat`: held down. */
  private rightClick(repeat = false): void {
    if (this.state !== "play" || this.dead) return;
    const held = this.heldId();
    // v9: right click on a villager: trade
    if (this.targetVillager) {
      if (!repeat) this.talkTo(this.targetVillager);
      return;
    }
    // v7: the bow is drawn while the button is held down, and loosed when it comes up
    if (held === I.BOW) {
      if (!repeat) this.startDrawing();
      return;
    }
    // v8: right click on a boat: sit in it; a boat in hand goes onto the water
    if (this.targetBoat && !this.ride) {
      if (!repeat) this.mountBoat(this.targetBoat);
      return;
    }
    if (held === I.BOAT) {
      if (!repeat && !this.ride) this.placeBoat();
      return;
    }
    // v7: an empty bucket milks a cow in reach, or scoops up the water source you look at
    if (held === I.BUCKET) {
      if (repeat) return;
      if (this.targetAnimal && this.targetAnimal.kind === 1) return this.milkCow(this.targetAnimal);
      if (this.scoopWater()) return;
    }
    const t = this.target;
    if (t && !this.phys.sneaking && this.isUsable(t)) {
      if (repeat) return;
      if (isOpenable(t.id)) return this.useOpenable(t.x, t.y, t.z);
      if (isHoe(held) && (t.id === B.GRASS || t.id === B.DIRT)) this.predictTill(t.x, t.y, t.z);
      if (itemDef(held)?.tool?.kind === "shovel" && (t.id === B.GRASS || t.id === B.DIRT)) this.predictPath(t.x, t.y, t.z);
      this.net?.send({ t: "use", x: t.x, y: t.y, z: t.z });
      this.hand.startSwing();
      return;
    }
    const def = itemDef(held);
    if (def?.drink || (def?.food && (!t || held >= 256))) {
      if (!repeat) this.startEating();
      return;
    }
    this.tryPlace();
  }

  /** What a right click on this block does instead of placing: open it, sleep, or (v7) till it, ripen it, eat it. */
  private isUsable(t: Hit): boolean {
    const id = t.id;
    const held = this.heldId();
    if (isSapling(id) && held === I.BONE_MEAL) return true; // v6: bone meal makes it grow
    // v7
    if (isWheat(id) && held === I.BONE_MEAL) return wheatAge(id) < 7;
    if ((id === B.GRASS || id === B.DIRT) && isHoe(held)) return t.ny >= 0 && this.safeGet(t.x, t.y + 1, t.z) === B.AIR && !this.spawnProtected(t.x, t.z);
    if (isCake(id)) return this.gm === "creative" || this.stats.food < MAX_FOOD;
    // v8: gates and trapdoors, the barrel and the chime; a shovel makes a path, bone meal grows flowers on grass,
    // a flower goes into an empty pot and an empty hand takes it back
    const above = this.safeGet(t.x, t.y + 1, t.z) === B.AIR;
    if ((id === B.GRASS || id === B.DIRT) && itemDef(held)?.tool?.kind === "shovel") return t.ny >= 0 && above && !this.spawnProtected(t.x, t.z);
    if (id === B.GRASS && held === I.BONE_MEAL) return above && !this.spawnProtected(t.x, t.z);
    if (id === B.FLOWER_POT) return potFor(held) > 0 && !this.spawnProtected(t.x, t.z);
    if (isPot(id)) return held === 0 && !this.spawnProtected(t.x, t.z);
    return isOpenable(id) || id === B.CRAFTING_TABLE || isFurnace(id) || isChest(id) || isBed(id) || id === B.BARREL || id === B.VILLAGE_CHIME;
  }

  // ---- v7: farming, buckets, the bow

  /** The hoe turns the block to farmland at once here (the server confirms, or puts it back). */
  private predictTill(x: number, y: number, z: number): void {
    this.setLocal(x, y, z, hydratedAt(this.safeGet, x, y, z) ? B.FARMLAND + 1 : B.FARMLAND);
    this.sound.till({ x: x + 0.5, y: y + 1, z: z + 0.5 });
  }

  /** v8: the shovel turns the block into a path at once here (the server confirms, or puts it back). */
  private predictPath(x: number, y: number, z: number): void {
    this.setLocal(x, y, z, B.DIRT_PATH);
    this.sound.till({ x: x + 0.5, y: y + 1, z: z + 0.5 });
  }

  /** An empty bucket at a water source in reach: scoop it up. False if there is none to scoop. */
  private scoopWater(): boolean {
    const cp = Math.cos(this.pitch * DEG);
    const dx = -Math.sin(this.yaw * DEG) * cp;
    const dy = -Math.sin(this.pitch * DEG);
    const dz = Math.cos(this.yaw * DEG) * cp;
    const p = this.phys;
    const hit = raycast(this.get, p.x, p.y + this.eye, p.z, dx, dy, dz, REACH, true);
    if (!hit || hit.id !== B.WATER) return false;
    if (this.spawnProtected(hit.x, hit.z)) {
      this.ui.notice("Spawn is protected. Fill your bucket a little further out!");
      return true;
    }
    this.net?.send({ t: "use", x: hit.x, y: hit.y, z: hit.z });
    this.hand.startSwing();
    this.sound.bucket(true, { x: hit.x + 0.5, y: hit.y + 0.5, z: hit.z + 0.5 });
    return true;
  }

  private milkCow(a: AnimalView): void {
    this.net?.send({ t: "milk", id: a.id });
    this.hand.startSwing();
    this.sound.bucket(true, { x: a.x, y: a.y + 1, z: a.z });
  }

  /** Right button down with a bow (and arrows, or in creative): start the draw. */
  private startDrawing(): void {
    if (this.drawing || this.state !== "play" || this.dead) return;
    if (this.gm !== "creative" && !this.inv.inv.some((st) => st?.id === I.ARROW)) return;
    if (this.inSafeZone(this.phys.x, this.phys.z)) {
      this.ui.notice("Spawn is a safe zone. Shoot a little further out!");
      return;
    }
    this.drawing = { start: this.tickCount };
    this.net?.send({ t: "bow", a: "start" });
    this.hand.setDraw(0);
  }

  /** Right button up: loose the arrow (the server times the draw and shoots it). */
  private releaseBow(): void {
    if (!this.drawing) return;
    this.drawing = null;
    this.hand.setDraw(-1);
    this.sendMove(); // from where we are and the way we look right now
    this.net?.send({ t: "bow", a: "release" });
  }

  private cancelDrawing(): void {
    if (!this.drawing) return;
    this.drawing = null;
    this.hand.setDraw(-1);
    this.net?.send({ t: "bow", a: "abort" });
  }


  private tryPlace(): void {
    const t = this.target;
    if (!t || this.state !== "play") return;
    // v7: some items place a block (seeds plant wheat, a water bucket pours water)
    const held = this.heldId();
    const item = held >= 256 ? (itemDef(held)?.block ?? 0) : held;
    if (!item || !BLOCKS[item]?.clientPlace) return;
    if (held < 256 && !BLOCKS[item]?.placeable) return;
    if (item === B.WATER && this.gm !== "creative" && held !== I.WATER_BUCKET) return;
    let x = t.x + t.nx;
    let y = t.y + t.ny;
    let z = t.z + t.nz;
    let id: number | null;
    const sb = slabBase(t.id);
    if (sb >= 0 && sb === item && ((t.id === sb && t.ny === 1) || (t.id !== sb && t.ny === -1))) {
      // Clicked the open side of a matching half slab: complete it where it is.
      x = t.x;
      y = t.y;
      z = t.z;
      id = t.id === sb ? sb + 1 : sb;
    } else {
      if (BLOCKS[t.id].replaceable) {
        x = t.x;
        y = t.y;
        z = t.z;
      }
      if (!inWorld(x, y, z)) return;
      const cur = this.get(x, y, z);
      const cb = slabBase(cur);
      // The cell already holds the matching half slab: fill in the other half.
      id = cb >= 0 && cb === item ? (cur === cb ? cb + 1 : cb) : placementState(item, this.yaw, t);
    }
    if (id === null) return;
    const changes = placeChanges(id, x, y, z, this.safeGet);
    if (!changes) return;
    for (const [cx, , cz] of changes) {
      if (this.spawnProtected(cx, cz)) {
        this.ui.notice("Spawn is protected. Build a little further out!");
        return;
      }
    }
    const p = this.phys;
    for (const [cx, cy, cz, cid] of changes) {
      if (!SOLID[cid]) continue;
      if (shapeIntersectsPlayer(cid, cx, cy, cz, p.x, p.y, p.z, this.safeGet, 0, playerHeight(p))) return;
      for (const o of this.others.values()) if (shapeIntersectsPlayer(cid, cx, cy, cz, o.x, o.y, o.z, this.safeGet, 0.05, o.flags & FLAG.SNEAK ? CROUCH_HEIGHT : PLAYER_HEIGHT)) return;
      for (const an of this.animals.values()) if (cellHitsAnimal(cx, cy, cz, an.x, an.y, an.z, an.spec.w, an.spec.h)) return;
      for (const m of this.mobs.values()) if (cellHitsAnimal(cx, cy, cz, m.x, m.y, m.z, m.spec.w, m.spec.h)) return;
      for (const bt of this.boats.values()) if (cellHitsAnimal(cx, cy, cz, bt.x, bt.y, bt.z, BOAT_W, BOAT_H, 0)) return; // v8: not into a boat
    }
    for (const [cx, cy, cz, cid] of changes) this.setLocal(cx, cy, cz, cid);
    this.net?.send({ t: "place", x, y, z, id });
    if (this.gm === "survival") {
      const st = this.inv.inv[this.slot];
      const rem = st ? itemDef(st.id)?.remainder : undefined;
      if (st) this.inv.inv[this.slot] = rem && st.n === 1 ? { id: rem, n: 1, d: 0 } : st.n > 1 ? { ...st, n: st.n - 1 } : null;
      this.refreshHotbar();
    }
    if (item === B.WATER && held === I.WATER_BUCKET) this.sound.bucket(false, { x: x + 0.5, y: y + 0.5, z: z + 0.5 });
    else this.sound.place(BLOCKS[changes[0][3]].sound);
    this.hand.startSwing();
    this.self?.startSwing();
    this.net?.send({ t: "swing" });
  }

  /** Doors, and (v8) fence gates and trapdoors: open or close at once here (the server does the same). */
  private useOpenable(x: number, y: number, z: number): void {
    this.sendMove(); // a gate swings away from where we look: the server judges it from our yaw
    const changes = toggleOpenable(x, y, z, this.yaw, this.safeGet);
    if (!changes) return;
    for (const [cx, cy, cz, cid] of changes) this.setLocal(cx, cy, cz, cid);
    this.net?.send({ t: "use", x, y, z });
    const id = changes[0][3];
    const at = { x: x + 0.5, y: y + 0.5, z: z + 0.5 };
    if (isDoor(id)) this.sound.door(door(id).open, at);
    else this.sound.gate(isOpen(id), isTrapdoor(id), at);
    this.hand.startSwing();
    this.self?.startSwing();
    this.net?.send({ t: "swing" });
  }

  // ================================================================== frame

  private frame = (now: number): void => {
    requestAnimationFrame(this.frame);
    const dt = Math.min(250, now - this.lastFrame);
    this.lastFrame = now;
    this.acc += dt;
    while (this.acc >= TICK_MS) {
      this.tick();
      this.acc -= TICK_MS;
    }
    const a = this.acc / TICK_MS;
    this.render(a, now, dt);
  };

  private render(a: number, now: number, dt: number): void {
    const p = this.phys;
    let x = this.prev.x + (p.x - this.prev.x) * a;
    let y = this.prev.y + (p.y - this.prev.y) * a;
    let z = this.prev.z + (p.z - this.prev.z) * a;
    if (this.spec) {
      // clankersmp: the camera is the AI's eyes, played back at the frame rate (game/follow.ts)
      this.fcam.update(now, dt);
      x = this.fcam.x;
      y = this.fcam.y;
      z = this.fcam.z;
      this.yaw = this.fcam.yaw;
      this.pitch = this.fcam.pitch;
    }
    // v8: boats first (riders sit in them); in someone else's boat we sit where it is drawn and turn with it
    const rt0 = now - 150;
    for (const b of this.boats.values()) {
      const vis = (b.x - x) ** 2 + (b.z - z) ** 2 < 96 * 96;
      b.root.visible = vis;
      if (vis || (this.ride && b.id === this.ride.id)) b.update(rt0, a, this.boatLight.get(b.id) ?? [1, 0]);
    }
    const rideView = this.ride ? this.boats.get(this.ride.id) : undefined;
    if (this.ride && rideView && !this.myBoat) {
      const s = seatPos(rideView, this.ride.seat, Math.max(1, this.ridersOf(this.ride.id)));
      x = s.x;
      y = s.y;
      z = s.z;
      if (this.lastRideYaw !== null) this.yaw += wrapDeg(rideView.yaw - this.lastRideYaw);
      this.lastRideYaw = rideView.yaw;
    } else this.lastRideYaw = null;
    const eye = this.prevEye + (this.eye - this.prevEye) * a;
    const cam = this.camera;
    cam.position.set(x, y + eye, z);
    cam.rotation.set(-this.pitch * DEG, Math.PI - this.yaw * DEG, 0, "YXZ");

    // Pick target from the un-bobbed eye.
    const cp = Math.cos(this.pitch * DEG);
    const dx = -Math.sin(this.yaw * DEG) * cp;
    const dy = -Math.sin(this.pitch * DEG);
    const dz = Math.cos(this.yaw * DEG) * cp;
    this.target = this.state === "play" || this.state === "paused" ? raycast(this.get, x, y + eye, z, dx, dy, dz, REACH) : null;
    // An animal or a mob in front of the targeted block (or with no block behind it) is the target instead: within
    // the classic 3 blocks; one farther away still blocks the view (no digging the block behind it), like Java.
    this.targetAnimal = null;
    this.targetMob = null;
    if (this.state === "play") {
      let best = this.target ? this.target.dist : REACH;
      for (const an of this.animals.values()) {
        if (Math.abs(an.x - x) > 6 || Math.abs(an.z - z) > 6) continue;
        const d = rayHitsBox(x, y + eye, z, dx, dy, dz, REACH, an.x, an.y, an.z, an.spec.w, an.spec.h);
        if (d >= 0 && d < best) {
          best = d;
          this.targetAnimal = an;
        }
      }
      for (const m of this.mobs.values()) {
        if (Math.abs(m.x - x) > 6 || Math.abs(m.z - z) > 6 || m.flags & MF.DEAD) continue;
        const d = rayHitsBox(x, y + eye, z, dx, dy, dz, REACH, m.x, m.y, m.z, m.spec.w, m.spec.h);
        if (d >= 0 && d < best) {
          best = d;
          this.targetMob = m;
          this.targetAnimal = null;
        }
      }
      // v8: boats (not the one we sit in)
      this.targetBoat = null;
      for (const b of this.boats.values()) {
        if (Math.abs(b.x - x) > 6 || Math.abs(b.z - z) > 6 || (this.ride && b.id === this.ride.id)) continue;
        const d = rayHitsBox(x, y + eye, z, dx, dy, dz, REACH, b.x, b.y, b.z, BOAT_W, BOAT_H);
        if (d >= 0 && d < best) {
          best = d;
          this.targetBoat = b;
          this.targetMob = null;
          this.targetAnimal = null;
        }
      }
      // v9: villagers (trade in block reach, poke in hitting reach)
      this.targetVillager = null;
      for (const v of this.villagers.values()) {
        if (Math.abs(v.x - x) > 6 || Math.abs(v.z - z) > 6) continue;
        const d = rayHitsBox(x, y + eye, z, dx, dy, dz, REACH, v.x, v.y, v.z, VILLAGER_W, VILLAGER_H);
        if (d >= 0 && d < best) {
          best = d;
          this.targetVillager = v;
          this.targetBoat = null;
          this.targetMob = null;
          this.targetAnimal = null;
        }
      }
      this.targetVillagerDist = best;
      if (this.targetVillager) {
        this.target = null;
        if (best > TALK_REACH) this.targetVillager = null;
      } else if (this.targetAnimal || this.targetMob || this.targetBoat) {
        this.target = null;
        if (best > ENTITY_REACH) {
          this.targetAnimal = null;
          this.targetMob = null;
          this.targetBoat = null;
        }
      }
    } else {
      this.targetBoat = null;
      this.targetVillager = null;
    }
    // the attack indicator: the swing recharging, or charged and aimed at something in reach
    if (this.state === "play" && this.gm === "survival" && !this.dead) {
      const strength = attackStrength(this.tickCount + a - this.lastSwingTick, this.heldId());
      this.ui.setAttack(strength, strength >= 0.999 && !!(this.targetMob || this.targetAnimal));
    } else this.ui.setAttack(1, false);
    if (this.target) {
      const t = this.target;
      const b = selectionBox(t.id, this.get, t.x, t.y, t.z);
      this.selection.show({ x0: t.x + b.x0, y0: t.y + b.y0, z0: t.z + b.z0, x1: t.x + b.x1, y1: t.y + b.y1, z1: t.z + b.z1 });
    } else this.selection.show(null);
    const d = this.spec ? this.folDig : this.dig;
    if (d) {
      const prog = d.prev + (d.progress - d.prev) * a;
      const box = RENDER[d.id] === 6 ? selectionBox(d.id, this.get, d.x, d.y, d.z) : undefined;
      this.selection.setCrack(d.x, d.y, d.z, Math.floor(prog * 10), box);
    } else this.selection.setCrack(0, 0, 0, -1);

    // Third person (F5): pull the camera back (or around to the front), stopping short of blocks.
    if (this.view > 0) {
      const sign = this.view === 1 ? -1 : 1;
      const hit = raycast(this.get, x, y + eye, z, dx * sign, dy * sign, dz * sign, 4);
      const want = hit ? Math.max(0.3, hit.dist - 0.3) : 4;
      // clankersmp: in fast when a wall comes between, back out slowly; too tight (a tunnel, a small room) and the
      // spectator looks out of the AI's eyes instead of at the back of its head
      this.camBack += (want - this.camBack) * (want < this.camBack ? 0.6 : 0.08);
      const d = Math.min(want, this.camBack);
      this.camClose = this.spec !== null && d < 1.3;
      if (!this.camClose) {
        cam.position.set(x + dx * sign * d, y + eye + dy * sign * d, z + dz * sign * d);
        if (this.view === 2) cam.rotation.set(this.pitch * DEG, -this.yaw * DEG, 0, "YXZ");
      }
    } else this.camClose = false;
    if (this.self) {
      this.self.root.visible = this.view > 0 && !this.spec; // a spectator has no body of its own
      if (this.view > 0 && !this.spec) {
        this.self.x = x;
        this.self.y = y;
        this.self.z = z;
        this.self.yaw = this.yaw;
        this.self.pitch = this.pitch;
        this.self.flags = (p.crouched ? FLAG.SNEAK : 0) | (this.eating || this.drawing ? FLAG.EAT : 0); // v7: the bow drawn too
        this.self.setHeld(this.heldId());
        const myBoatView = this.ride ? this.boats.get(this.ride.id) : undefined;
        this.self.update(now, a, cam.position, this.lightHere, myBoatView ? { x, y, z, yaw: myBoatView.yaw } : null, this.boatRows !== 0 && !!this.myBoat);
      }
    }

    // View bobbing (Java's bobView).
    const bob = { x: 0, y: 0, rz: 0, rx: 0 };
    if (this.settings.bobbing && this.view === 0) {
      const f = p.walkDist - this.prevWalk;
      const f1 = -(p.walkDist + f * a);
      const f2 = this.prevBob + (this.bob - this.prevBob) * a;
      bob.x = Math.sin(f1 * Math.PI) * f2 * 0.5;
      bob.y = -Math.abs(Math.cos(f1 * Math.PI) * f2);
      bob.rz = Math.sin(f1 * Math.PI) * f2 * 3;
      bob.rx = Math.abs(Math.cos(f1 * Math.PI - 0.2) * f2) * 5;
      cam.translateX(bob.x);
      cam.translateY(bob.y);
      cam.rotateZ(bob.rz * DEG);
      cam.rotateX(bob.rx * DEG);
    }
    // Hurt: the camera rolls a little, away from where the hit came from (Java's hurt-camera effect).
    if (this.hurtTime > 0 && this.view === 0) {
      const f = Math.max(0, (this.hurtTime - a) / 10);
      const roll = Math.sin(f * f * f * f * Math.PI) * 14 * (Math.sin((this.hurtYaw * Math.PI) / 180) >= 0 ? 1 : -1);
      cam.rotateZ(-roll * DEG);
    }
    const underwater = eyeInWater(this.get, x, y + eye, z);
    const fov = this.settings.fov * (this.prevFovMod + (this.fovMod - this.prevFovMod) * a) * (underwater ? 6 / 7 : 1);
    if (Math.abs(cam.fov - fov) > 0.01) {
      cam.fov = fov;
      cam.updateProjectionMatrix();
    }

    // Time of day.
    const time = this.timeBase.time + (now - this.timeBase.at) / TICK_MS;
    U.uTime.value = time;
    U.uWaterFrame.value = Math.floor(time / 2) % 16;
    this.sky.update(time, cam.position, this.renderDist, underwater, this.settings.brightness);
    this.scenery.update(cam.position);
    const sm = this.scenery.signMaterial();
    if (sm) sm.uniforms.uLight.value.set(1, 0.6); // open sky, plus the two torches on the posts
    this.chunks.updateVisibility(x, z, this.renderDist);
    this.ui.setUnderwater(underwater);

    // Others.
    const rt = now - 150;
    for (const o of this.others.values()) {
      // v8: riders sit in their boat as it is drawn here
      const r = this.rides.get(o.id);
      const bv = r ? this.boats.get(r.b) : undefined;
      let seat: { x: number; y: number; z: number; yaw: number } | null = null;
      if (r && bv) seat = { ...seatPos(bv, r.s, Math.max(1, this.ridersOf(r.b))), yaw: bv.yaw };
      o.update(rt, a, cam.position, this.otherLight.get(o.id) ?? [1, 0], seat, !!r && r.s === 0 && ((bv?.flags ?? 0) & (BF.ROW_L | BF.ROW_R)) !== 0);
      if (o.id === this.folId) o.root.visible = this.view > 0 && !this.camClose; // clankersmp: through its eyes we don't see it; from behind we do
      o.ownTag = o.id === this.folId; // its own name tag sits right in front of the camera behind its head: never drawn
    }
    // Animals draw up to 64 blocks away (an entity distance, like the classic games), or the render distance if less.
    const far = Math.min(64, (this.renderDist + 0.5) * 16);
    for (const an of this.animals.values()) {
      const vis = (an.x - x) * (an.x - x) + (an.z - z) * (an.z - z) < far * far;
      an.root.visible = vis;
      if (vis) an.update(rt, a, this.animalLight.get(an.id) ?? [1, 0]);
    }

    // Night mobs, like the animals (64 blocks at most); arrows in flight or stuck.
    for (const m of this.mobs.values()) {
      const vis = (m.x - x) * (m.x - x) + (m.z - z) * (m.z - z) < far * far;
      m.root.visible = vis;
      if (vis) m.update(rt, a, this.mobLight.get(m.id) ?? [1, 0], this.camYaw());
    }
    // v9 villagers, like the animals
    for (const v of this.villagers.values()) {
      const vis = (v.x - x) * (v.x - x) + (v.z - z) * (v.z - z) < far * far;
      v.root.visible = vis;
      if (vis) v.update(rt, a, this.villagerLight.get(v.id) ?? [1, 0], cam.position);
    }
    for (const ar of [...this.arrows.values()]) {
      if (!ar.update(a, this.lightHere)) this.removeArrow(ar.id);
    }

    // Dropped items within 48 blocks.
    const nowMs = performance.now();
    for (const d of [...this.drops.values()]) {
      const vis = d.flying !== null || (d.x - x) * (d.x - x) + (d.z - z) * (d.z - z) < 48 * 48;
      d.root.visible = vis;
      if (!vis) continue;
      if (!d.update(rt, nowMs)) {
        this.removeDrop(d.id);
        continue;
      }
      const l = this.dropLight.get(d.id) ?? this.lightHere;
      d.setLight(l[0], l[1]);
    }

    this.particles.update(a);
    this.hand.update(a, bob, this.lightHere);
    this.sound.listener = { x, y: y + eye, z, yaw: this.yaw };
    this.voiceFrame(x, y + eye, z, dx, dy, dz);

    const r = this.renderer;
    r.info.reset();
    r.clear();
    r.render(this.scene, cam);
    if ((this.view === 0 || this.camClose) && !this.hudHidden && !(this.spec && this.dead)) {
      r.clearDepth();
      r.render(this.hand.scene, this.hand.camera);
    }

    this.adapt(dt, now);
    this.ui.tickChat();
    if (this.tabHeld) {
      const names = [this.myName, ...[...this.others.values()].map((o) => o.name)];
      // v11: speaking icons (and who you muted) in the list
      const talking = new Set([...this.others.values()].filter((o) => this.voice.talking.has(o.id)).map((o) => o.name));
      if (this.voice.transmitting) talking.add(this.myName);
      this.ui.showTab(true, `Server ${this.shard.n}`, names, this.myName, this.shard.cap, talking, this.voice.muted);
    } else this.ui.showTab(false);
    if (this.debug && this.frames % 10 === 0) this.ui.setDebug(this.debugLines(x, y, z));
  }

  /** v11: voice each frame: push-to-talk, the listener and the voices placed, the icons over heads, the HUD's mic. */
  private voiceFrame(x: number, y: number, z: number, fx: number, fy: number, fz: number): void {
    const v = this.voice;
    v.ptt = this.state === "play" && (this.keys.has("KeyV") || this.touchTalk);
    v.update({ x, y, z }, { x: fx, y: fy, z: fz });
    for (const o of this.others.values()) o.setTalking(v.talking.has(o.id) && !v.muted.has(o.name), v.speakingNow(o.id));
    if (this.voiceMutesDirty && this.net) {
      this.voiceMutesDirty = false;
      v.syncMutes([...this.others.values()].map((o) => ({ id: o.id, name: o.name })));
    }
    const key = `${v.mic}|${v.transmitting}|${v.adminMuted}|${v.openMic}|${Math.round(v.level * 8)}|${this.touchMode}`;
    if (key !== this.voiceKey) {
      this.voiceKey = key;
      this.ui.setVoice(v.mic === "on" ? { talking: v.transmitting, openMic: v.openMic, adminMuted: v.adminMuted, level: v.level, touch: this.touchMode } : null);
      if (this.talkBtn) this.talkBtn.style.display = v.mic === "on" && !v.openMic ? "" : "none";
    }
  }

  private adapt(dt: number, now: number): void {
    this.frames++;
    if (now - this.lastFpsAt >= 1000) {
      this.fps = Math.round((this.frames * 1000) / (now - this.lastFpsAt));
      this.lastFpsAt = now;
      this.frames = 0;
    }
    this.frameTimes.push(dt);
    if (this.frameTimes.length > 60) this.frameTimes.shift();
    const avg = this.frameTimes.reduce((s, v) => s + v, 0) / this.frameTimes.length;
    // Adaptive render distance: shrink when under ~45 fps, grow back toward the setting above ~70 fps.
    if (avg > 22) {
      if (!this.slowSince) this.slowSince = now;
      if (now - this.slowSince > 2000 && this.renderDist > 4) {
        this.renderDist--;
        this.slowSince = now;
      }
    } else this.slowSince = 0;
    if (avg < 14 && this.renderDist < this.settings.renderDistance) {
      if (!this.fastSince) this.fastSince = now;
      if (now - this.fastSince > 4000) {
        this.renderDist++;
        this.fastSince = now;
      }
    } else this.fastSince = 0;
    if (this.renderDist > this.settings.renderDistance) this.renderDist = this.settings.renderDistance;
  }

  private debugLines(x: number, y: number, z: number): string[] {
    const yaw = ((this.yaw % 360) + 360) % 360;
    const facing = yaw < 45 || yaw >= 315 ? "south (Towards positive Z)" : yaw < 135 ? "west (Towards negative X)" : yaw < 225 ? "north (Towards negative Z)" : "east (Towards positive X)";
    const t = this.target;
    const time = this.timeBase.time + (performance.now() - this.timeBase.at) / TICK_MS;
    const tod = ((time % 24000) + 24000) % 24000;
    const hours = Math.floor((tod / 1000 + 6) % 24);
    const mins = Math.floor(((tod % 1000) / 1000) * 60);
    const info = this.renderer.info;
    return [
      `clankersmp (${this.fps} fps, ${this.chunks.pending} sections queued)`,
      `XYZ: ${x.toFixed(3)} / ${y.toFixed(5)} / ${z.toFixed(3)}`,
      `Block: ${Math.floor(x)} ${Math.floor(y)} ${Math.floor(z)}  Chunk: ${Math.floor(x / 16)} ${Math.floor(y / 16)} ${Math.floor(z / 16)}`,
      `Facing: ${facing} (${wrapDeg(this.yaw).toFixed(1)} / ${this.pitch.toFixed(1)})`,
      `Light: sky ${Math.round(this.lightHere[0] * 15)}, block ${Math.round(this.lightHere[1] * 15)}`,
      t ? `Targeted block: ${BLOCKS[t.id].name} at ${t.x}, ${t.y}, ${t.z}` : "Targeted block: none",
      `Server ${this.shard.n} · ${this.shard.players}/${this.shard.cap} players · ping ${Math.round(this.rtt)} ms`,
      `Time: ${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")} (angle ${celestialAngle(time).toFixed(3)})`,
      `Render distance: ${this.renderDist}/${this.settings.renderDistance} chunks · draws ${info.render.calls} · tris ${(info.render.triangles / 1000).toFixed(0)}k`,
      `Ground: ${this.phys.onGround ? "yes" : "no"}  Sprint: ${this.phys.sprinting ? "yes" : "no"}  Water: ${this.phys.inWater ? "yes" : "no"}`,
      `Animals in range: ${this.animals.size}${this.targetAnimal ? ` · targeting a ${this.targetAnimal.spec.name.toLowerCase()}` : ""} · items on the ground: ${this.drops.size}`,
      `Night mobs in range: ${this.mobs.size}${this.targetMob ? ` · targeting a ${this.targetMob.spec.name}` : ""} · arrows: ${this.arrows.size} · armour: ${this.armorPoints()} · villagers: ${this.villagers.size}`,
      `Boats in range: ${this.boats.size}${this.ride ? ` · in boat ${this.ride.id}, seat ${this.ride.seat + 1}${this.myBoat ? " (rowing)" : ""}` : ""}`,
      `Mode: ${this.gm} · health ${this.stats.hp}/20 · food ${this.stats.food}/20 · saturation ${this.stats.sat} · air ${this.stats.air}`,
    ];
  }
}

function nextFrame(): Promise<void> {
  return new Promise((r) => requestAnimationFrame(() => r()));
}

/** Reload to pick up a new version of the game, at most once a minute (a cached old page must not loop). */
function reloadOnceForUpdate(): boolean {
  const KEY = "steve_craft_update_reload";
  try {
    const last = Number(sessionStorage.getItem(KEY) ?? 0);
    if (Date.now() - last < 60_000) return false;
    sessionStorage.setItem(KEY, String(Date.now()));
  } catch {
    return false;
  }
  location.reload();
  return true;
}
