// Static scenery: the endless ocean around the island, the world border, the "$STEVE Craft" plaque at the landmark,
// and the hub's boards: welcome and how to play, the rules, the live charity total, the latest update, the gate beams
// ("Spawn" inside, "Wilderness" outside) and the starter pavilion's sign; the welcome arch, the tips and directions
// boards, the halls' names, the Beacon's plaque, the gates' signposts (where each road goes) and the harbour's sign.
// Text is drawn on canvases in $STEVE Craft's look: the classic pixel font (KenneyMini) in dark ink on oak signs, and
// white or yellow on dark stone plates.

import * as THREE from "three";
import { TEX } from "../../../shared/blocks.ts";
import { SEA_LEVEL, WORLD_SIZE } from "../../../shared/constants.ts";
import type { GenInfo } from "../../../shared/worldgen.ts";
import type { Panel } from "../../../shared/hub.ts";
import type { CharityInfo } from "../../../shared/protocol.ts";
import { borderMaterial, U } from "./shaders.ts";

const FAR = 2400;

/** Four big quads around the world square, using the chunk/water vertex format. */
function ring(y: number, layer: number, shade: number, flip = false): THREE.BufferGeometry {
  const rects = [
    [-FAR, -FAR, 0, WORLD_SIZE + FAR],
    [WORLD_SIZE, -FAR, WORLD_SIZE + FAR, WORLD_SIZE + FAR],
    [0, -FAR, WORLD_SIZE, 0],
    [0, WORLD_SIZE, WORLD_SIZE, WORLD_SIZE + FAR],
  ];
  const pos: number[] = [];
  const uv: number[] = [];
  const data: number[] = [];
  const idx: number[] = [];
  for (const [x0, z0, x1, z1] of rects) {
    const b = pos.length / 3;
    const pts = [
      [x0, y, z1],
      [x1, y, z1],
      [x1, y, z0],
      [x0, y, z0],
    ];
    for (const p of pts) {
      pos.push(p[0], p[1], p[2]);
      uv.push(p[0] * 16, p[2] * 16, 0, 0);
      data.push(layer, 240, 0, shade * 255);
    }
    if (flip) idx.push(b, b + 2, b + 1, b, b + 3, b + 2);
    else idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uvp", new THREE.Float32BufferAttribute(uv, 4));
  g.setAttribute("data", new THREE.Float32BufferAttribute(data, 4));
  g.setIndex(idx);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(WORLD_SIZE / 2, y, WORLD_SIZE / 2), FAR * 2);
  return g;
}

/** Wraps text into lines of at most maxW pixels; returns the y after the last line. */
function wrap(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, maxW: number, lh: number): number {
  const words = text.split(" ");
  let line = "";
  for (const w of words) {
    const t = line ? `${line} ${w}` : w;
    if (ctx.measureText(t).width > maxW && line) {
      ctx.fillText(line, x, y);
      y += lh;
      line = w;
    } else line = t;
  }
  if (line) {
    ctx.fillText(line, x, y);
    y += lh;
  }
  return y;
}

function fmt(v: number): string {
  if (v < 1) return v.toFixed(3);
  if (v < 100) return v.toFixed(2);
  if (v < 10_000) return v.toFixed(1);
  return Math.round(v).toLocaleString("en-US");
}

/** An oak sign: warm planks with faint grain lines and a darker frame (our own drawing). */
function oakPlate(ctx: CanvasRenderingContext2D, W: number, H: number): void {
  ctx.fillStyle = "#a8834f";
  ctx.fillRect(0, 0, W, H);
  const rows = H > W * 0.3 ? 4 : 1;
  ctx.fillStyle = "rgba(90, 62, 30, 0.35)";
  for (let k = 1; k < rows; k++) ctx.fillRect(0, Math.round((H * k) / rows) - 1, W, Math.max(2, Math.round(H * 0.012)));
  ctx.fillStyle = "rgba(255, 236, 190, 0.12)";
  for (let k = 0; k < rows; k++) ctx.fillRect(0, Math.round((H * k) / rows) + 2, W, Math.max(2, Math.round(H * 0.01)));
  const f = Math.max(3, Math.round(Math.min(W, H) * 0.04));
  ctx.fillStyle = "#6b4c26";
  ctx.fillRect(0, 0, W, f);
  ctx.fillRect(0, H - f, W, f);
  ctx.fillRect(0, 0, f, H);
  ctx.fillRect(W - f, 0, f, H);
}

/** A dark stone plate with a light top-left and a dark bottom-right bevel, like the classic GUI's buttons. */
function stonePlate(ctx: CanvasRenderingContext2D, W: number, H: number): void {
  ctx.fillStyle = "#2b2b2b";
  ctx.fillRect(0, 0, W, H);
  const f = Math.max(3, Math.round(Math.min(W, H) * 0.06));
  ctx.fillStyle = "#555555";
  ctx.fillRect(0, 0, W, f);
  ctx.fillRect(0, 0, f, H);
  ctx.fillStyle = "#151515";
  ctx.fillRect(0, H - f, W, f);
  ctx.fillRect(W - f, 0, f, H);
}

/** Canvas text on a plane, lit like a block face in open air (the hub is lamp-lit at night). */
function panelMaterial(tex: THREE.Texture): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { ...U, map: { value: tex }, uLight: { value: new THREE.Vector2(1, 0.75) } },
    vertexShader: /* glsl */ `
      out vec2 vUv;
      out float vDist;
      void main() { vUv = uv; vec4 mv = modelViewMatrix * vec4(position, 1.0); vDist = length(mv.xyz); gl_Position = projectionMatrix * mv; }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D map;
      uniform vec2 uLight;
      uniform float uSky;
      uniform vec3 uSkyTint;
      uniform float uGamma;
      uniform vec3 uFogColor;
      uniform float uFogNear;
      uniform float uFogFar;
      in vec2 vUv;
      in float vDist;
      void main() {
        vec4 t = texture(map, vUv);
        float s = uLight.x / (4.0 - 3.0 * uLight.x) * uSky;
        float b = uLight.y / (4.0 - 3.0 * uLight.y);
        vec3 l = clamp(vec3(s) * uSkyTint + vec3(b, b * 0.85, b * 0.7), 0.0, 1.0);
        l = mix(l, 1.0 - pow(1.0 - l, vec3(4.0)), uGamma);
        vec3 col = mix(t.rgb * max(l, vec3(0.08)), uFogColor, smoothstep(uFogNear, uFogFar, vDist));
        gl_FragColor = vec4(col, 1.0);
      }
    `,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
}

export class Scenery {
  readonly group = new THREE.Group();
  private borderMat: THREE.ShaderMaterial;
  private sign: THREE.Mesh[] = [];
  private panels: { p: Panel; canvas: HTMLCanvasElement; tex: THREE.CanvasTexture; mat: THREE.ShaderMaterial }[] = [];
  private charity: CharityInfo | null = null;
  private latest: { n: number; title: string; line: string; date: string } | null = null;

  constructor(solidMat: THREE.Material, waterMat: THREE.Material, info: GenInfo) {
    const waterY = SEA_LEVEL - 1 + 14 / 16;
    const sea = new THREE.Mesh(ring(waterY, TEX.water0, 1), waterMat);
    sea.renderOrder = 1;
    const seaUnder = new THREE.Mesh(ring(waterY, TEX.water0, 0.7, true), waterMat);
    seaUnder.renderOrder = 1;
    const bed = new THREE.Mesh(ring(29, TEX.sand, 0.85), solidMat);
    this.group.add(sea, seaUnder, bed);

    // World border: four tall planes.
    this.borderMat = borderMaterial();
    const H = 256;
    const mk = (w: number, x: number, z: number, ry: number) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, H), this.borderMat);
      m.position.set(x, H / 2, z);
      m.rotation.y = ry;
      m.renderOrder = 8;
      m.frustumCulled = false;
      this.group.add(m);
    };
    mk(WORLD_SIZE, WORLD_SIZE / 2, 0, 0);
    mk(WORLD_SIZE, WORLD_SIZE / 2, WORLD_SIZE, Math.PI);
    mk(WORLD_SIZE, 0, WORLD_SIZE / 2, Math.PI / 2);
    mk(WORLD_SIZE, WORLD_SIZE, WORLD_SIZE / 2, -Math.PI / 2);

    this.buildSign(info);
    for (const p of info.hub?.panels ?? []) this.buildPanel(p);
  }

  /** The charity board shows the live total (the same numbers as the meter). */
  setCharity(c: CharityInfo | null): void {
    this.charity = c;
    for (const x of this.panels) if (x.p.kind === "charity") this.paint(x);
  }

  setLatestUpdate(u: { n: number; title: string; line: string; date: string } | null): void {
    this.latest = u;
    for (const x of this.panels) if (x.p.kind === "updates") this.paint(x);
  }

  private buildPanel(p: Panel): void {
    const PPB = p.h < 1 ? 160 : 112; // canvas pixels per block
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(p.w * PPB);
    canvas.height = Math.round(p.h * PPB);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.NoColorSpace;
    tex.anisotropy = 8;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    const mat = panelMaterial(tex);
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(p.w, p.h), mat);
    mesh.position.set(p.x, p.y, p.z);
    mesh.rotation.y = Math.atan2(p.nx, p.nz);
    mesh.renderOrder = 2;
    this.group.add(mesh);
    const entry = { p, canvas, tex, mat };
    this.panels.push(entry);
    this.paint(entry);
    void document.fonts?.ready.then(() => this.paint(entry));
  }

  private paint(x: { p: Panel; canvas: HTMLCanvasElement; tex: THREE.CanvasTexture }): void {
    const { p, canvas: c } = x;
    const ctx = c.getContext("2d")!;
    const W = c.width;
    const H = c.height;
    const ink = "#2a1d0f";
    const blue = "#1f4fa3";
    if (p.h < 1) {
      // a strip sign: an oak sign with dark ink, or a dark stone plate (the arrival arch, the halls, the Beacon, the
      // wilderness) with white text (the arrival's in yellow)
      const dark = p.kind === "wild" || p.kind === "arrival" || p.kind === "hall" || p.kind === "news" || p.kind === "beacon";
      if (dark) stonePlate(ctx, W, H);
      else oakPlate(ctx, W, H);
      const text = p.text ?? (p.kind === "spawn" ? "Spawn · safe zone" : p.kind === "wild" ? "Wilderness" : "Starter area · free crafting tables and furnaces");
      // as big as fits: at most 52% of the strip's height, and the whole line inside 88% of its width
      let size = H * 0.52;
      ctx.font = `${Math.round(size)}px KenneyMini, monospace`;
      const fit = (W * 0.88) / ctx.measureText(text).width;
      if (fit < 1) {
        size *= fit;
        ctx.font = `${Math.round(size)}px KenneyMini, monospace`;
      }
      ctx.textBaseline = "middle";
      ctx.textAlign = "center";
      if (dark) {
        const sh = Math.max(2, Math.round(size / 9));
        ctx.fillStyle = "#3f3f3f";
        ctx.fillText(text, W / 2 + sh, H / 2 + sh);
        ctx.fillStyle = p.kind === "arrival" ? "#ffff55" : p.kind === "wild" ? "#ffaa00" : "#ffffff";
      } else ctx.fillStyle = ink;
      ctx.fillText(text, W / 2, H / 2);
      x.tex.needsUpdate = true;
      return;
    }
    // the boards: an oak sign, a blue kicker, a dark title, then lines, all in the pixel font
    oakPlate(ctx, W, H);
    const pad = W * 0.06;
    let y = H * 0.1;
    ctx.textAlign = "left";
    const kicker = (t: string) => {
      const sz = Math.round(H * 0.06);
      ctx.font = `${sz}px KenneyMini, monospace`;
      ctx.textBaseline = "top";
      ctx.fillStyle = blue;
      ctx.fillText(t.toUpperCase(), pad, y);
      y += sz * 1.7;
    };
    const title = (t: string, scale = 0.13) => {
      const sz = Math.round(H * scale);
      ctx.font = `${sz}px KenneyMini, monospace`;
      ctx.fillStyle = ink;
      ctx.textBaseline = "top";
      y = wrap(ctx, t, pad, y, W - pad * 2, sz * 1.1) + sz * 0.35;
    };
    const lines = (list: string[], scale = 0.056, gap = 0.45) => {
      const sz = Math.round(H * scale);
      ctx.font = `${sz}px KenneyMini, monospace`;
      ctx.fillStyle = ink;
      ctx.textBaseline = "top";
      for (const l of list) y = wrap(ctx, l, pad, y, W - pad * 2, sz * 1.32) + sz * gap;
    };
    if (p.kind === "welcome") {
      kicker("Welcome to $STEVE Craft");
      title("One shared world", 0.12);
      lines(
        [
          "Survive and build with everyone, right in your browser.",
          "Left click breaks · right click places or uses · E: inventory and crafting · T: chat",
          "Spawn is safe. Leave by a gate on the ring road to start your adventure.",
        ],
        0.054,
        0.4,
      );
    } else if (p.kind === "rules") {
      kicker("Server rules");
      title("Play fair, be kind", 0.12);
      lines(["1. Be kind in chat. No hate, no harassment.", "2. Don't grief or take from other people's builds.", "3. No cheats, hacks or exploits.", "4. Build big, help new players, have fun."], 0.058, 0.32);
    } else if (p.kind === "charity") {
      kicker("Charity coin");
      const c = this.charity;
      const live = c && c.state === "live" && typeof c.totalSol === "number";
      const amount = live ? `${fmt(c!.totalSol!)} SOL raised` : c && c.state === "prelaunch" ? "Starts at launch" : "Coming soon";
      title(amount, live ? 0.15 : 0.14);
      const who = c?.x ? `@${c.x}` : c?.name || "charity";
      lines([`Charity coin partnered with ${who}.`, live ? "The total updates about once a minute, straight from the chain." : "The meter goes live the day the coin launches.", "Updates on X: @SteveOnPF"]);
    } else if (p.kind === "updates") {
      const u = this.latest;
      kicker("Latest update");
      title(u ? u.title : "$STEVE Craft", 0.13);
      lines([u ? u.line : "New things ship here first.", "Updates on X: @SteveOnPF · stevepumpfun.com"], 0.058, 0.4);
    } else if (p.kind === "tips") {
      kicker("Tips");
      title("Getting started", 0.12);
      lines(
        [
          "Punch a tree for wood, then make a crafting table (E). The Workshop has free ones.",
          "Night brings mobs: build a shelter, or sleep in a bed.",
          "Villagers trade for rubies. Follow a signposted road.",
          "Take a boat from the Harbour to the islands.",
          "Voice chat: turn it on in Options, then hold V to talk.",
        ],
        0.048,
        0.32,
      );
    } else if (p.kind === "directions") {
      kicker("Where to go");
      title("Roads from spawn", 0.12);
      lines([...(p.lines ?? []), "Each road leaves by a signposted gate on the ring road."], 0.06, 0.36);
    }
    x.tex.needsUpdate = true;
  }

  private buildSign(info: GenInfo): void {
    const b = info.board;
    if (b.x0 < 0) return; // (no sign: the landmark's ground was kept for players' builds)
    const w = b.x1 + 1 - b.x0;
    const h = b.y1 + 1 - b.y0;
    const c = document.createElement("canvas");
    const PPB = 128; // canvas pixels per block
    c.width = w * PPB;
    c.height = h * PPB;
    const ctx = c.getContext("2d")!;
    // the landmark's plaque: "$STEVE Craft" in yellow on a dark stone plate, the charity line under it
    const paint = () => {
      stonePlate(ctx, c.width, c.height);
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const big = Math.round(PPB * 0.82);
      ctx.font = `${big}px KenneyMini, monospace`;
      const sh = Math.round(big / 9);
      ctx.fillStyle = "#3f3f3f";
      ctx.fillText("$STEVE Craft", c.width / 2 + sh, c.height * 0.36 + sh);
      ctx.fillStyle = "#ffff55";
      ctx.fillText("$STEVE Craft", c.width / 2, c.height * 0.36);
      const line = "Charity coin partnered with @GamersOutreach";
      let small = PPB * 0.34;
      ctx.font = `${Math.round(small)}px KenneyMini, monospace`;
      small = Math.round(small * Math.min(1, (c.width * 0.9) / ctx.measureText(line).width));
      ctx.font = `${small}px KenneyMini, monospace`;
      const sh2 = Math.max(2, Math.round(small / 9));
      ctx.fillStyle = "#3f3f3f";
      ctx.fillText(line, c.width / 2 + sh2, c.height * 0.76 + sh2);
      ctx.fillStyle = "#ffffff";
      ctx.fillText(line, c.width / 2, c.height * 0.76);
    };
    paint();
    void document.fonts?.ready.then(() => {
      paint();
      tex.needsUpdate = true;
    });
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.NoColorSpace;
    tex.anisotropy = 8;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    const mat = new THREE.ShaderMaterial({
      uniforms: { ...U, map: { value: tex }, uLight: { value: new THREE.Vector2(1, 0) } },
      vertexShader: /* glsl */ `
        out vec2 vUv;
        out float vDist;
        void main() { vUv = uv; vec4 mv = modelViewMatrix * vec4(position, 1.0); vDist = length(mv.xyz); gl_Position = projectionMatrix * mv; }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D map;
        uniform vec2 uLight;
        uniform float uSky;
        uniform vec3 uSkyTint;
        uniform float uGamma;
        uniform vec3 uFogColor;
        uniform float uFogNear;
        uniform float uFogFar;
        in vec2 vUv;
        in float vDist;
        void main() {
          vec4 t = texture(map, vUv);
          if (t.a < 0.3) discard;
          float s = uLight.x / (4.0 - 3.0 * uLight.x) * uSky;
          float b = uLight.y / (4.0 - 3.0 * uLight.y);
          vec3 l = clamp(vec3(s) * uSkyTint + vec3(b, b * 0.85, b * 0.7), 0.0, 1.0);
          l = mix(l, 1.0 - pow(1.0 - l, vec3(4.0)), uGamma);
          vec3 col = mix(t.rgb * max(l, vec3(0.08)), uFogColor, smoothstep(uFogNear, uFogFar, vDist));
          gl_FragColor = vec4(col, t.a);
        }
      `,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    // Front faces south (+Z) toward spawn; the back faces north.
    const front = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
    front.position.set(b.x0 + w / 2, b.y0 + h / 2, b.z + 1 + 0.002);
    const back = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
    back.position.set(b.x0 + w / 2, b.y0 + h / 2, b.z - 0.002);
    back.rotation.y = Math.PI;
    front.renderOrder = back.renderOrder = 2;
    this.group.add(front, back);
    this.sign = [front, back];
  }

  signMaterial(): THREE.ShaderMaterial | null {
    return (this.sign[0]?.material as THREE.ShaderMaterial) ?? null;
  }

  update(cam: THREE.Vector3): void {
    this.borderMat.uniforms.uCam.value.copy(cam);
  }
}
