// Shapes of the non-cube building blocks (doors, stairs, slabs, fences, ladders, glass panes, beds; v7 farmland and
// cake):
// collision boxes, render boxes with textures, placement states and support rules. Shared by physics,
// the server's checks, the mesher, ray casting and the held-item models, so all of them always agree.
//
// Facing: 0 north (-Z), 1 east (+X), 2 south (+Z), 3 west (-X). Boxes are authored for facing north and rotated
// clockwise. A ladder's facing points away from its wall, so the north-facing ladder hugs the south side.
// Box coordinates are in 1/16 of a block, [x0, y0, z0, x1, y1, z1].

import { B, BLOCKS, IS_WATER, OPAQUE, SHAPE, SOLID, TEX, SLAB_DOUBLE, cakeBites, isCake, isFarmland, isGate, isLantern, isPot, isSmallPlant, isTrapdoor, isWall, isWheat } from "./blocks.ts";
import { WORLD_HEIGHT, WORLD_SIZE, idx } from "./constants.ts";

export type Box16 = [number, number, number, number, number, number];
export type Nb = (dx: number, dy: number, dz: number) => number;

export const FACING_DIR: [number, number, number][] = [
  [0, 0, -1],
  [1, 0, 0],
  [0, 0, 1],
  [-1, 0, 0],
];

const STAIRS: number[] = [B.OAK_STAIRS, B.COBBLE_STAIRS, B.STONE_BRICK_STAIRS, B.BRICK_STAIRS, B.BIRCH_STAIRS];
const SLABS: number[] = [B.OAK_SLAB, B.COBBLE_SLAB, B.STONE_BRICK_SLAB, B.BRICK_SLAB, B.STONE_SLAB, B.BIRCH_SLAB];

export const isDoor = (id: number) => id >= B.OAK_DOOR && id < B.OAK_DOOR + 16;
export const isBed = (id: number) => id >= B.RED_BED && id < B.RED_BED + 8;
export const isLadder = (id: number) => id >= B.LADDER && id < B.LADDER + 4;
export const isFence = (id: number) => id === B.OAK_FENCE || id === B.BIRCH_FENCE;
export const isPane = (id: number) => id === B.GLASS_PANE;
export const isChestBlock = (id: number) => id >= B.CHEST && id < B.CHEST + 4;
/** Face index (+X, -X, +Y, -Y, +Z, -Z) a facing points through. */
export const FACE_OF_FACING = [5, 0, 4, 1];
const CHEST_BOX: Box16 = [1, 0, 1, 15, 14, 15];
/** v7: farmland is a pixel lower than a full block; a cake is a half-height box, eaten from the west side. */
const FARMLAND_BOX: Box16 = [0, 0, 0, 16, 15, 16];
const cakeBox = (id: number): Box16 => [1 + cakeBites(id) * 2, 0, 1, 15, 8, 15];
export function stairBase(id: number): number {
  for (const s of STAIRS) if (id >= s && id < s + 8) return s;
  return -1;
}
export function slabBase(id: number): number {
  for (const s of SLABS) if (id >= s && id < s + 2) return s;
  return -1;
}

export const door = (id: number) => {
  const s = id - B.OAK_DOOR;
  return { facing: s & 3, open: (s & 4) !== 0, upper: (s & 8) !== 0 };
};
export const doorId = (facing: number, open: boolean, upper: boolean) => B.OAK_DOOR + (facing & 3) + (open ? 4 : 0) + (upper ? 8 : 0);
/** v8 fence gates: facing (the way the player looked when placing it; it swings open that way) and open. */
export const gate = (id: number) => {
  const s = id - B.OAK_GATE;
  return { facing: s & 3, open: (s & 4) !== 0 };
};
export const gateId = (facing: number, open: boolean) => B.OAK_GATE + (facing & 3) + (open ? 4 : 0);
/** v8 trapdoors: facing (open, it stands against the side opposite its facing, like a ladder), open, top half. */
export const trapdoor = (id: number) => {
  const s = id - B.TRAPDOOR;
  return { facing: s & 3, open: (s & 4) !== 0, top: (s & 8) !== 0 };
};
export const trapdoorId = (facing: number, open: boolean, top: boolean) => B.TRAPDOOR + (facing & 3) + (open ? 4 : 0) + (top ? 8 : 0);
export const bed = (id: number) => {
  const s = id - B.RED_BED;
  return { facing: s & 3, head: (s & 4) !== 0 };
};

/** Java's yaw (0 = +Z south, 90 = -X west) to our facing index. */
export function facingFromYaw(yaw: number): number {
  const q = Math.round((((yaw % 360) + 360) % 360) / 90) % 4;
  return (q + 2) % 4;
}

/** Facing that points along a face normal (only side faces). */
export function facingFromNormal(nx: number, nz: number): number {
  if (nz < 0) return 0;
  if (nx > 0) return 1;
  if (nz > 0) return 2;
  return 3;
}

/** Rotate a box authored for facing north (0) to another facing, around the block centre. */
function rot(b: Box16, facing: number): Box16 {
  let [x0, y0, z0, x1, y1, z1] = b;
  for (let i = 0; i < facing; i++) {
    // 90 degrees clockwise seen from above: north -> east. (x, z) -> (16 - z, x)
    const nx0 = 16 - z1;
    const nx1 = 16 - z0;
    const nz0 = x0;
    const nz1 = x1;
    x0 = nx0;
    x1 = nx1;
    z0 = nz0;
    z1 = nz1;
  }
  return [x0, y0, z0, x1, y1, z1];
}

/** A gate joins the fences and walls at its two ends: along x when it faces north or south, along z otherwise.
 *  `dir` is the direction from the fence to the gate (a facing index). */
const gateJoins = (id: number, dir: number) => isGate(id) && gate(id).facing % 2 !== dir % 2;
const connectsFence = (id: number, dir: number) => isFence(id) || OPAQUE[id] === 1 || gateJoins(id, dir);
const connectsWall = (id: number, dir: number) => isWall(id) || OPAQUE[id] === 1 || gateJoins(id, dir);
const connectsPane = (id: number) => isPane(id) || id === B.GLASS || OPAQUE[id] === 1;

/** Collision boxes in 1/16 units (fences are 1.5 blocks tall, like Java). */
export function collisionBoxes16(id: number, nb: Nb): Box16[] {
  if (isDoor(id)) return [doorBox(id)];
  if (isChestBlock(id)) return [CHEST_BOX];
  const sb = stairBase(id);
  if (sb >= 0) return stairBoxes(id - sb);
  const lb = slabBase(id);
  if (lb >= 0) return [id - lb ? [0, 8, 0, 16, 16, 16] : [0, 0, 0, 16, 8, 16]];
  if (isFence(id)) return fenceBoxes(nb, 24, 6, 10);
  if (isPane(id)) return paneBoxes(nb);
  if (isLadder(id)) return [rot([0, 0, 13, 16, 16, 16], id - B.LADDER)];
  if (isBed(id)) return [[0, 0, 0, 16, 9, 16]];
  if (isFarmland(id) || id === B.DIRT_PATH) return [FARMLAND_BOX];
  if (isCake(id)) return [cakeBox(id)];
  // v8
  if (isWall(id)) return wallCollision(nb);
  if (isGate(id)) return gate(id).open ? [] : [rot([0, 0, 6, 16, 24, 10], gate(id).facing)];
  if (isTrapdoor(id)) return [trapdoorBox(id)];
  if (isLantern(id)) return [LANTERN_BOX];
  if (isPot(id)) return [POT_BOX];
  return [[0, 0, 0, 16, 16, 16]];
}

// ---- v8 shapes
const LANTERN_BOX: Box16 = [5, 0, 5, 11, 10, 11];
const POT_BOX: Box16 = [5, 0, 5, 11, 6, 11];

function trapdoorBox(id: number): Box16 {
  const t = trapdoor(id);
  if (t.open) return rot([0, 0, 13, 16, 16, 16], t.facing);
  return t.top ? [0, 13, 0, 16, 16, 16] : [0, 0, 0, 16, 3, 16];
}

/** Which sides a wall joins: [north, east, south, west]. */
function wallLinks(nb: Nb): [boolean, boolean, boolean, boolean] {
  return [connectsWall(nb(0, 0, -1), 0), connectsWall(nb(1, 0, 0), 1), connectsWall(nb(0, 0, 1), 2), connectsWall(nb(-1, 0, 0), 3)];
}

/** Walls block like fences: 1.5 blocks tall, the post and the arms that join. */
function wallCollision(nb: Nb): Box16[] {
  const [n, e, s, w] = wallLinks(nb);
  const out: Box16[] = [[4, 0, 4, 12, 24, 12]];
  if (n) out.push([5, 0, 0, 11, 24, 4]);
  if (e) out.push([12, 0, 5, 16, 24, 11]);
  if (s) out.push([5, 0, 12, 11, 24, 16]);
  if (w) out.push([0, 0, 5, 4, 24, 11]);
  return out;
}

/** What a wall looks like: a post (left out on a straight run, like the classic walls) and arms 14 px high (full
 *  height when something solid or another wall sits on top). */
function wallRender(nb: Nb): Box16[] {
  const [n, e, s, w] = wallLinks(nb);
  const above = nb(0, 1, 0);
  const h = isWall(above) || OPAQUE[above] === 1 ? 16 : 14;
  const straight = (n && s && !e && !w) || (e && w && !n && !s);
  if (straight) return n ? [[5, 0, 0, 11, h, 16]] : [[0, 0, 5, 16, h, 11]];
  const out: Box16[] = [[4, 0, 4, 12, 16, 12]];
  if (n) out.push([5, 0, 0, 11, h, 4]);
  if (e) out.push([12, 0, 5, 16, h, 11]);
  if (s) out.push([5, 0, 12, 11, h, 16]);
  if (w) out.push([0, 0, 5, 4, h, 11]);
  return out;
}

/** A fence gate, authored facing north (it runs along x and swings open to the north): two posts, two rails and a
 *  centre stile; open, each half folds back against its post. */
function gateRender(id: number): Box16[] {
  const g = gate(id);
  const boxes: Box16[] = [[0, 0, 7, 2, 16, 9], [14, 0, 7, 16, 16, 9]];
  if (!g.open) {
    boxes.push([2, 6, 7, 14, 9, 9], [2, 12, 7, 14, 15, 9], [7, 9, 7, 9, 12, 9]);
  } else {
    for (const [x0, x1] of [[0, 2], [14, 16]]) boxes.push([x0, 6, 1, x1, 9, 7], [x0, 12, 1, x1, 15, 7], [x0, 9, 1, x1, 12, 3]);
  }
  return boxes.map((b) => rot(b, g.facing));
}

/** The village chime, our own design: a cobblestone base, four oak posts under a plank roof, three brass tubes of
 *  different lengths hung from a beam. */
function chimeRender(): ModelBox[] {
  const oakLog = all(TEX.oak_log);
  const planks = all(TEX.oak_planks);
  const brass = all(TEX.chime);
  return [
    { b: [0, 0, 0, 16, 2, 16], tex: all(TEX.cobblestone) },
    { b: [1, 2, 1, 3, 14, 3], tex: oakLog },
    { b: [13, 2, 1, 15, 14, 3], tex: oakLog },
    { b: [1, 2, 13, 3, 14, 15], tex: oakLog },
    { b: [13, 2, 13, 15, 14, 15], tex: oakLog },
    { b: [0, 14, 0, 16, 16, 16], tex: planks },
    { b: [3, 13, 7, 13, 14, 9], tex: planks },
    { b: [4, 6, 7, 6, 13, 9], tex: brass },
    { b: [7, 4, 7, 9, 13, 9], tex: brass },
    { b: [10, 7, 7, 12, 13, 9], tex: brass },
  ];
}

function lanternRender(id: number): Box16[] {
  const boxes: Box16[] = [[5, 0, 5, 11, 1, 11], [5, 1, 5, 11, 8, 11], [6, 8, 6, 10, 10, 10]];
  if (id === B.LANTERN + 1) boxes.push([7, 10, 7, 9, 16, 9]); // hanging: the chain up to the block above
  else boxes.push([7, 10, 7, 9, 11, 9]); // standing: a little handle
  return boxes;
}

function doorBox(id: number): Box16 {
  const d = door(id);
  // Like Java: closed, the 3 px panel sits on the side nearest the player who placed it; open, it has swung
  // away from them onto the left-hand (hinge) side.
  return d.open ? rot([0, 0, 0, 3, 16, 16], d.facing) : rot([0, 0, 13, 16, 16, 16], d.facing);
}

function stairBoxes(s: number): Box16[] {
  const facing = s & 3;
  const top = (s & 4) !== 0;
  if (!top) return [[0, 0, 0, 16, 8, 16], rot([0, 8, 0, 16, 16, 8], facing)];
  return [[0, 8, 0, 16, 16, 16], rot([0, 0, 0, 16, 8, 8], facing)];
}

function fenceBoxes(nb: Nb, h: number, a: number, b: number): Box16[] {
  const out: Box16[] = [[a, 0, a, b, h, b]];
  if (connectsFence(nb(0, 0, -1), 0)) out.push([a, 0, 0, b, h, a]);
  if (connectsFence(nb(1, 0, 0), 1)) out.push([b, 0, a, 16, h, b]);
  if (connectsFence(nb(0, 0, 1), 2)) out.push([a, 0, b, b, h, 16]);
  if (connectsFence(nb(-1, 0, 0), 3)) out.push([0, 0, a, a, h, b]);
  return out;
}

function paneBoxes(nb: Nb): Box16[] {
  const out: Box16[] = [[7, 0, 7, 9, 16, 9]];
  if (connectsPane(nb(0, 0, -1))) out.push([7, 0, 0, 9, 16, 7]);
  if (connectsPane(nb(1, 0, 0))) out.push([9, 0, 7, 16, 16, 9]);
  if (connectsPane(nb(0, 0, 1))) out.push([7, 0, 9, 9, 16, 16]);
  if (connectsPane(nb(-1, 0, 0))) out.push([0, 0, 7, 7, 16, 9]);
  return out;
}

/** Collision boxes in block units (flat x0,y0,z0,x1,y1,z1 ...), offset to the cell. */
export function pushCollision(id: number, x: number, y: number, z: number, nb: Nb, out: number[]): void {
  if (SHAPE[id] === 1) {
    out.push(x, y, z, x + 1, y + 1, z + 1);
    return;
  }
  if (SHAPE[id] !== 2) return;
  for (const b of collisionBoxes16(id, nb)) out.push(x + b[0] / 16, y + b[1] / 16, z + b[2] / 16, x + b[3] / 16, y + b[4] / 16, z + b[5] / 16);
}

/** Outline / pick shape: the union box of what is drawn (fences stop at the block top). */
export function selectionBox16(id: number, nb: Nb): Box16 {
  const boxes = isLadder(id) ? [rot([0, 0, 13, 16, 16, 16], id - B.LADDER)] : pickBoxes16(id, nb);
  if (!boxes.length) return [0, 0, 0, 16, 16, 16];
  const u: Box16 = [16, 16, 16, 0, 0, 0];
  for (const b of boxes) {
    for (let k = 0; k < 3; k++) u[k] = Math.min(u[k], b[k]);
    for (let k = 3; k < 6; k++) u[k] = Math.max(u[k], b[k]);
  }
  return u;
}

/** Boxes to pick with the cross-hair (each box separately, so stairs pick like stairs). */
export function pickBoxes16(id: number, nb: Nb): Box16[] {
  if (isFence(id)) return fenceBoxes(nb, 16, 6, 10);
  // v8: walls and gates pick by what is drawn (an open gate too); a potted plant includes its flower
  if (isWall(id)) return wallRender(nb);
  if (isGate(id)) return gateRender(id);
  if (isPot(id)) return id === B.FLOWER_POT ? [POT_BOX] : [[5, 0, 5, 11, 13, 11]];
  return collisionBoxes16(id, nb);
}

// ------------------------------------------------------------------ rendering

/** Texture coordinates (texels) of a point on a box face, projected like Java's block models. */
export function faceUV(f: number, x: number, y: number, z: number): [number, number] {
  switch (f) {
    case 0:
      return [16 - z, 16 - y];
    case 1:
      return [z, 16 - y];
    case 2:
      return [x, z];
    case 3:
      return [x, 16 - z];
    case 4:
      return [x, 16 - y];
    default:
      return [16 - x, 16 - y];
  }
}

/** Turn a top-face texture so its "up" (v = 0) points along the block's facing. */
export function rotateTop(u: number, v: number, turns: number): [number, number] {
  switch (turns & 3) {
    case 1:
      return [v, 16 - u];
    case 2:
      return [16 - u, 16 - v];
    case 3:
      return [16 - v, u];
    default:
      return [u, v];
  }
}

export interface ModelBox {
  b: Box16;
  tex: [number, number, number, number, number, number]; // +X, -X, +Y, -Y, +Z, -Z
  /** Quarter turns of the top face texture (beds). */
  topRot?: number;
}

const all = (t: number): ModelBox["tex"] => [t, t, t, t, t, t];

/** Boxes to draw for a model block. Neighbours decide fence and pane arms. */
export function renderBoxes(id: number, nb: Nb): ModelBox[] {
  const def = BLOCKS[id];
  const base = def.tex[0];
  if (isDoor(id)) {
    const d = door(id);
    const face = d.upper ? TEX.door_upper : TEX.door_lower;
    const b = doorBox(id);
    // The panel's two big faces show the door; its edges are planks.
    const thinX = b[3] - b[0] < 16;
    const tex: ModelBox["tex"] = thinX ? [face, face, TEX.oak_planks, TEX.oak_planks, TEX.oak_planks, TEX.oak_planks] : [TEX.oak_planks, TEX.oak_planks, TEX.oak_planks, TEX.oak_planks, face, face];
    return [{ b, tex }];
  }
  const sb = stairBase(id);
  if (sb >= 0) return stairBoxes(id - sb).map((b) => ({ b, tex: all(base) }));
  const lb = slabBase(id);
  if (lb >= 0) return collisionBoxes16(id, nb).map((b) => ({ b, tex: all(base) }));
  if (isFence(id)) {
    const out: ModelBox[] = [{ b: [6, 0, 6, 10, 16, 10], tex: all(base) }];
    const rails = (b: Box16) => {
      out.push({ b: [b[0], 12, b[2], b[3], 15, b[5]], tex: all(base) });
      out.push({ b: [b[0], 6, b[2], b[3], 9, b[5]], tex: all(base) });
    };
    if (connectsFence(nb(0, 0, -1), 0)) rails([7, 0, 0, 9, 0, 6]);
    if (connectsFence(nb(1, 0, 0), 1)) rails([10, 0, 7, 16, 0, 9]);
    if (connectsFence(nb(0, 0, 1), 2)) rails([7, 0, 10, 9, 0, 16]);
    if (connectsFence(nb(-1, 0, 0), 3)) rails([0, 0, 7, 6, 0, 9]);
    return out;
  }
  // v8
  if (isWall(id)) return wallRender(nb).map((b) => ({ b, tex: all(base) }));
  if (isGate(id)) return gateRender(id).map((b) => ({ b, tex: all(base) }));
  if (isTrapdoor(id)) return [{ b: trapdoorBox(id), tex: all(TEX.trapdoor) }];
  if (isLantern(id)) return lanternRender(id).map((b) => ({ b, tex: def.tex }));
  if (isPot(id)) return [{ b: POT_BOX, tex: all(TEX.flower_pot) }];
  if (id === B.VILLAGE_CHIME) return chimeRender();
  if (id === B.DIRT_PATH) return [{ b: FARMLAND_BOX, tex: def.tex }];
  if (isPane(id)) return paneBoxes(nb).map((b) => ({ b, tex: all(TEX.glass) }));
  if (isLadder(id)) {
    const facing = id - B.LADDER;
    return [{ b: rot([0, 0, 15, 16, 16, 16], facing), tex: all(TEX.ladder) }];
  }
  if (isChestBlock(id)) {
    const tex: ModelBox["tex"] = [TEX.chest_side, TEX.chest_side, TEX.chest_top, TEX.chest_top, TEX.chest_side, TEX.chest_side];
    tex[FACE_OF_FACING[id - B.CHEST]] = TEX.chest_front;
    return [{ b: CHEST_BOX, tex }];
  }
  if (isBed(id)) {
    const s = bed(id);
    const top = s.head ? TEX.bed_head_top : TEX.bed_foot_top;
    return [{ b: [0, 0, 0, 16, 9, 16], tex: [TEX.bed_side, TEX.bed_side, top, TEX.oak_planks, TEX.bed_side, TEX.bed_side], topRot: s.facing }];
  }
  if (isFarmland(id)) return [{ b: FARMLAND_BOX, tex: def.tex }];
  if (isCake(id)) {
    // the cut side shows the inside once a slice is gone
    const tex: ModelBox["tex"] = [TEX.cake_side, cakeBites(id) ? TEX.cake_inner : TEX.cake_side, TEX.cake_top, TEX.cake_bottom, TEX.cake_side, TEX.cake_side];
    return [{ b: cakeBox(id), tex }];
  }
  return [{ b: [0, 0, 0, 16, 16, 16], tex: def.tex }];
}

/** Items that are drawn flat in the hand and the hotbar, like Java (doors, ladders, panes). */
export function flatItem(id: number): boolean {
  return isDoor(id) || isLadder(id) || isPane(id);
}

const NONE: Nb = () => B.AIR;

/** Boxes for a block shown as an item (hand, hotbar, picker), in a fixed readable pose; null if flat. */
export function itemBoxes(item: number): ModelBox[] | null {
  if (flatItem(item)) return null;
  if (SHAPE[item] !== 2) return [{ b: [0, 0, 0, 16, 16, 16], tex: BLOCKS[item].tex }];
  const sb = stairBase(item);
  if (sb >= 0) return renderBoxes(sb + 3, NONE); // high side to the back left, profile on the left face
  if (isFence(item)) {
    const t = all(BLOCKS[item].tex[0]);
    return [
      { b: [6, 0, 0, 10, 16, 4], tex: t },
      { b: [7, 6, 4, 9, 9, 12], tex: t },
      { b: [7, 12, 4, 9, 15, 12], tex: t },
      { b: [6, 0, 12, 10, 16, 16], tex: t },
    ];
  }
  if (isBed(item)) return renderBoxes(B.RED_BED + 4, NONE); // the head half: pillow at the back
  // v8
  if (isWall(item)) {
    const t = all(BLOCKS[item].tex[0]);
    return [{ b: [4, 0, 4, 12, 16, 12], tex: t }, { b: [0, 0, 5, 4, 14, 11], tex: t }, { b: [12, 0, 5, 16, 14, 11], tex: t }];
  }
  if (isGate(item)) return renderBoxes(gateId(2, false), NONE);
  if (isTrapdoor(item)) return [{ b: [0, 6, 0, 16, 9, 16], tex: all(TEX.trapdoor) }];
  if (isCake(item)) return renderBoxes(B.CAKE, NONE);
  if (isChestBlock(item)) return renderBoxes(B.CHEST + 2, NONE); // front to the viewer (south)
  return renderBoxes(item, NONE);
}

// ------------------------------------------------------------------ placement

export interface PlaceHit {
  x: number;
  y: number;
  z: number;
  nx: number;
  ny: number;
  nz: number;
  /** Where on the face the cross-hair hit, 0..1 within the block height. */
  fy: number;
}

/** The exact state to place for a picker item, from the player's facing and the face that was clicked. */
export function placementState(item: number, yaw: number, hit: PlaceHit): number | null {
  const facing = facingFromYaw(yaw);
  if (item === B.OAK_DOOR) return doorId(facing, false, false);
  if (STAIRS.includes(item)) {
    const top = hit.ny < 0 || (hit.ny === 0 && hit.fy > 0.5);
    return item + facing + (top ? 4 : 0);
  }
  if (SLABS.includes(item)) {
    const top = hit.ny < 0 || (hit.ny === 0 && hit.fy > 0.5);
    return item + (top ? 1 : 0);
  }
  if (item === B.LADDER) {
    if (hit.ny !== 0) return null; // ladders go on walls
    return B.LADDER + facingFromNormal(hit.nx, hit.nz);
  }
  if (item === B.RED_BED) return B.RED_BED + facing;
  // v8: a gate faces the way you look (it opens away from you); a trapdoor hinges on the wall you click, or on the
  // far side when you put it on a floor or a ceiling; a lantern hangs when you place it under a block
  if (item === B.OAK_GATE) return gateId(facing, false);
  if (item === B.TRAPDOOR) {
    if (hit.ny === 0) return trapdoorId(facingFromNormal(hit.nx, hit.nz), false, hit.fy > 0.5);
    return trapdoorId((facing + 2) % 4, false, hit.ny < 0);
  }
  if (item === B.LANTERN) return hit.ny < 0 ? B.LANTERN + 1 : B.LANTERN;
  // Furnaces and chests face the player who places them.
  if (item === B.FURNACE) return B.FURNACE + ((facing + 2) % 4);
  if (item === B.CHEST) return B.CHEST + ((facing + 2) % 4);
  return item;
}

/** Placing a slab onto the matching half slab makes the full block. Returns that block or -1. */
export function mergeSlab(existing: number, placing: number): number {
  const a = slabBase(existing);
  const b = slabBase(placing);
  if (a < 0 || a !== b || existing === placing) return -1;
  return SLAB_DOUBLE.get(a) ?? -1;
}

/** Cells a placement fills: doors add the upper half, beds add the head. */
export function placementCells(id: number, x: number, y: number, z: number): [number, number, number, number][] {
  if (isDoor(id)) {
    const d = door(id);
    return [
      [x, y, z, id],
      [x, y + 1, z, doorId(d.facing, d.open, true)],
    ];
  }
  if (isBed(id)) {
    const s = bed(id);
    const [dx, , dz] = FACING_DIR[s.facing];
    return [
      [x, y, z, id],
      [x + dx, y, z + dz, B.RED_BED + s.facing + 4],
    ];
  }
  return [[x, y, z, id]];
}

/** The other cell of a two-block structure (door halves, bed parts), or null. */
export function partnerCell(id: number, x: number, y: number, z: number): [number, number, number] | null {
  if (isDoor(id)) return door(id).upper ? [x, y - 1, z] : [x, y + 1, z];
  if (isBed(id)) {
    const s = bed(id);
    const [dx, , dz] = FACING_DIR[s.facing];
    return s.head ? [x - dx, y, z - dz] : [x + dx, y, z + dz];
  }
  return null;
}

/** v7: sugar cane stands on sugar cane, or on grass, dirt or sand with water right beside that block. */
export function caneSupported(x: number, y: number, z: number, get: (x: number, y: number, z: number) => number): boolean {
  const below = get(x, y - 1, z);
  if (below === B.SUGAR_CANE) return true;
  if (below !== B.GRASS && below !== B.DIRT && below !== B.SAND) return false;
  return IS_WATER[get(x + 1, y - 1, z)] === 1 || IS_WATER[get(x - 1, y - 1, z)] === 1 || IS_WATER[get(x, y - 1, z + 1)] === 1 || IS_WATER[get(x, y - 1, z - 1)] === 1;
}

/** Does this block still have what it needs around it? (get reads world blocks.) */
export function supported(id: number, x: number, y: number, z: number, get: (x: number, y: number, z: number) => number): boolean {
  if (id === B.TORCH) return OPAQUE[get(x, y - 1, z)] === 1;
  // v7: crops grow on farmland; sugar cane by water; a cake on something solid
  if (isWheat(id)) return isFarmland(get(x, y - 1, z));
  if (id === B.SUGAR_CANE) return caneSupported(x, y, z, get);
  if (isCake(id)) return SOLID[get(x, y - 1, z)] === 1;
  // v8: a lantern stands on something or hangs under it; a flower pot stands on something
  if (id === B.LANTERN || isPot(id)) return SOLID[get(x, y - 1, z)] === 1;
  if (id === B.LANTERN + 1) return SOLID[get(x, y + 1, z)] === 1;
  if (isSmallPlant(id)) {
    const below = get(x, y - 1, z);
    return below === B.GRASS || below === B.DIRT;
  }
  if (isDoor(id)) {
    const d = door(id);
    if (d.upper) return isDoor(get(x, y - 1, z));
    return OPAQUE[get(x, y - 1, z)] === 1;
  }
  if (isLadder(id)) {
    const [dx, , dz] = FACING_DIR[id - B.LADDER];
    return OPAQUE[get(x - dx, y, z - dz)] === 1;
  }
  if (isBed(id)) {
    const p = partnerCell(id, x, y, z)!;
    return isBed(get(p[0], p[1], p[2]));
  }
  return true;
}

export type Change = [number, number, number, number];

const inW = (x: number, y: number, z: number) => x >= 0 && z >= 0 && x < WORLD_SIZE && z < WORLD_SIZE && y >= 0 && y < WORLD_HEIGHT;

/** Cells to set for placing state `id` at (x, y, z): a slab on the matching half slab completes the block,
 *  doors add their upper half and beds their head. Null when it does not fit or would not be supported.
 *  (Reach, spawn protection, rate limits and players in the way are checked by the caller.) */
export function placeChanges(id: number, x: number, y: number, z: number, get: (x: number, y: number, z: number) => number): Change[] | null {
  if (!inW(x, y, z)) return null;
  // v8: a lantern that can't stand there hangs instead (and the other way round)
  if (isLantern(id) && !supported(id, x, y, z, get)) id = id === B.LANTERN ? B.LANTERN + 1 : B.LANTERN;
  const full = mergeSlab(get(x, y, z), id);
  if (full >= 0) return [[x, y, z, full]];
  const cells = placementCells(id, x, y, z);
  for (const [cx, cy, cz] of cells) if (!inW(cx, cy, cz) || !BLOCKS[get(cx, cy, cz)].replaceable) return null;
  const pending = new Map<number, number>();
  for (const [cx, cy, cz, cid] of cells) pending.set(idx(cx, cy, cz), cid);
  const after = (gx: number, gy: number, gz: number) => (inW(gx, gy, gz) ? (pending.get(idx(gx, gy, gz)) ?? get(gx, gy, gz)) : B.AIR);
  for (const [cx, cy, cz, cid] of cells) if (!supported(cid, cx, cy, cz, after)) return null;
  return cells;
}

const SIDES_AND_UP: [number, number, number][] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
  [0, 0, -1],
];
const ALL_SIX: [number, number, number][] = [[0, 1, 0], ...SIDES_AND_UP.filter((d) => d[1] === 0), [0, -1, 0]];

/** Everything that changes when (x, y, z) is broken: the cell, the other half of a door or bed, and whatever lost
 *  its support (torches, plants, doors, ladders, beds), in a short cascade. */
export function breakChanges(x: number, y: number, z: number, get: (x: number, y: number, z: number) => number): Change[] {
  const changes = new Map<number, Change>();
  const at = (gx: number, gy: number, gz: number): number => {
    if (!inW(gx, gy, gz)) return B.AIR;
    const c = changes.get(idx(gx, gy, gz));
    return c ? c[3] : get(gx, gy, gz);
  };
  const set = (gx: number, gy: number, gz: number, id: number) => changes.set(idx(gx, gy, gz), [gx, gy, gz, id]);
  // Water next to the hole flows in on its own: the server's water simulation does that (shared/water.ts).
  const clear = (gx: number, gy: number, gz: number) => set(gx, gy, gz, B.AIR);
  const twin = (a: number, b: number) => (isDoor(a) && isDoor(b)) || (isBed(a) && isBed(b));
  if (!inW(x, y, z)) return [];
  const id = at(x, y, z);
  const queue: [number, number, number, number][] = [[x, y, z, 0]];
  clear(x, y, z);
  const partner = partnerCell(id, x, y, z);
  if (partner && inW(partner[0], partner[1], partner[2]) && twin(id, at(partner[0], partner[1], partner[2]))) {
    clear(partner[0], partner[1], partner[2]);
    queue.push([partner[0], partner[1], partner[2], 0]);
  }
  while (queue.length) {
    const [cx, cy, cz, depth] = queue.shift()!;
    if (depth > 8) continue;
    for (const [dx, dy, dz] of ALL_SIX) {
      const nx = cx + dx;
      const ny = cy + dy;
      const nz = cz + dz;
      if (!inW(nx, ny, nz)) continue;
      const nid = at(nx, ny, nz);
      if (nid === B.AIR || IS_WATER[nid]) continue;
      if (!(BLOCKS[nid].needsSupport || isDoor(nid) || isLadder(nid) || isBed(nid))) continue;
      if (supported(nid, nx, ny, nz, at)) continue;
      set(nx, ny, nz, B.AIR);
      queue.push([nx, ny, nz, depth + 1]);
      const p = partnerCell(nid, nx, ny, nz);
      if (p && inW(p[0], p[1], p[2]) && twin(nid, at(p[0], p[1], p[2]))) {
        set(p[0], p[1], p[2], B.AIR);
        queue.push([p[0], p[1], p[2], depth + 1]);
      }
    }
  }
  return [...changes.values()];
}

/** v8: right-click on a door, a fence gate or a trapdoor: it opens or closes. A gate swings away from the player
 *  (yaw, Java's): opened from its far side, it turns around first. Null if it isn't one of those. */
export function toggleOpenable(x: number, y: number, z: number, yaw: number, get: (x: number, y: number, z: number) => number): Change[] | null {
  const id = get(x, y, z);
  if (isDoor(id)) return toggleDoor(x, y, z, get);
  if (isGate(id)) {
    const g = gate(id);
    if (g.open) return [[x, y, z, gateId(g.facing, false)]];
    const look = facingFromYaw(yaw);
    return [[x, y, z, gateId(g.facing === (look + 2) % 4 ? look : g.facing, true)]];
  }
  if (isTrapdoor(id)) {
    const t = trapdoor(id);
    return [[x, y, z, trapdoorId(t.facing, !t.open, t.top)]];
  }
  return null;
}

export const isOpenable = (id: number) => isDoor(id) || isGate(id) || isTrapdoor(id);
/** Is it open? (doors, gates, trapdoors) */
export const isOpen = (id: number) => (isDoor(id) ? door(id).open : isGate(id) ? gate(id).open : isTrapdoor(id) ? trapdoor(id).open : false);

/** v8: a full solid block on top turns a dirt path back to dirt (gates, fences and slabs don't). */
export const pathBreaksUnder = (above: number) => OPAQUE[above] === 1;

/** Toggle a door: returns the changes for both halves, or null if (x,y,z) is not a door. */
export function toggleDoor(x: number, y: number, z: number, get: (x: number, y: number, z: number) => number): [number, number, number, number][] | null {
  const id = get(x, y, z);
  if (!isDoor(id)) return null;
  const d = door(id);
  const ly = d.upper ? y - 1 : y;
  const lower = get(x, ly, z);
  const upper = get(x, ly + 1, z);
  if (!isDoor(lower) || !isDoor(upper)) return null;
  const open = !door(lower).open;
  return [
    [x, ly, z, doorId(door(lower).facing, open, false)],
    [x, ly + 1, z, doorId(door(lower).facing, open, true)],
  ];
}
