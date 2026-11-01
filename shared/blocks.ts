// Block registry. IDs are part of the network protocol and the save format: append only.

export type RenderKind = "none" | "cube" | "cutout" | "water" | "cross" | "torch" | "model" | "crop";
export type SoundGroup = "none" | "grass" | "gravel" | "stone" | "wood" | "sand" | "glass" | "cloth";

/** Texture layers in the block texture array. Order is the layer index. */
export const TEX = {
  grass_top: 0,
  grass_side: 1,
  dirt: 2,
  stone: 3,
  cobblestone: 4,
  oak_log: 5,
  oak_log_top: 6,
  oak_planks: 7,
  oak_leaves: 8,
  birch_log: 9,
  birch_log_top: 10,
  birch_leaves: 11,
  sand: 12,
  glass: 13,
  bricks: 14,
  stone_bricks: 15,
  wool_white: 16,
  wool_red: 17,
  wool_orange: 18,
  wool_yellow: 19,
  wool_lime: 20,
  wool_blue: 21,
  wool_purple: 22,
  wool_black: 23,
  torch: 24,
  lamp: 25,
  tall_grass: 26,
  dandelion: 27,
  poppy: 28,
  bedrock: 29,
  gravel: 30,
  birch_planks: 31,
  wool_cyan: 32,
  wool_pink: 33,
  water0: 34, // 16 animation frames: 34..49
  crack0: 50, // 10 crack stages: 50..59
  door_lower: 60,
  door_upper: 61,
  ladder: 62,
  bed_head_top: 63,
  bed_foot_top: 64,
  bed_side: 65,
  smooth_teal: 66,
  smooth_blue: 67,
  smooth_tan: 68,
  coal_ore: 69,
  iron_ore: 70,
  gold_ore: 71,
  diamond_ore: 72,
  ruby_ore: 73,
  // Survival blocks (protocol v5)
  crafting_table_top: 74,
  crafting_table_side: 75,
  crafting_table_front: 76,
  furnace_front: 77,
  furnace_front_lit: 78,
  furnace_side: 79,
  furnace_top: 80,
  chest_top: 81,
  chest_side: 82,
  chest_front: 83,
  oak_sapling: 84,
  birch_sapling: 85,
  iron_block: 86,
  gold_block: 87,
  diamond_block: 88,
  ruby_block: 89,
  coal_block: 90,
  // Item sprites (flat, drawn like torches): see shared/items.ts. Tools: 112 + material * 4 + kind.
  stick: 91,
  coal: 92,
  charcoal: 93,
  raw_iron: 94,
  raw_gold: 95,
  iron_ingot: 96,
  gold_ingot: 97,
  diamond: 98,
  ruby: 99,
  apple: 100,
  porkchop: 101,
  cooked_porkchop: 102,
  beef: 103,
  steak: 104,
  mutton: 105,
  cooked_mutton: 106,
  chicken: 107,
  cooked_chicken: 108,
  leather: 109,
  feather: 110,
  bowl: 111,
  tool0: 112, // 112..131: (wood, stone, iron, gold, diamond) x (pickaxe, axe, shovel, sword)
  // v6
  spoiled_flesh: 132,
  bone: 133,
  string: 134,
  bone_meal: 135,
  armor0: 136, // 136..147: (leather, iron, diamond) x (helmet, chestplate, leggings, boots)
  // v6 particles (never on a block or item): fire, critical-hit sparks, bone meal, a puff of smoke
  fx_flame: 148,
  fx_crit: 149,
  fx_green: 150,
  fx_smoke: 151,
  // v7 farming and depth: blocks
  farmland_dry: 152,
  farmland_moist: 153,
  wheat0: 154, // 154..161: growth stages 0..7
  sugar_cane: 162,
  cake_top: 163,
  cake_side: 164,
  cake_inner: 165,
  cake_bottom: 166,
  // v7 items
  wheat_seeds: 167,
  wheat: 168,
  bread: 169,
  sugar: 170,
  paper: 171,
  egg: 172,
  flint: 173,
  bow: 174, // 174 at rest, 175..177 drawn back (three steps)
  arrow: 178,
  bucket: 179,
  water_bucket: 180,
  milk_bucket: 181,
  hoe0: 182, // 182..186: wood, stone, iron, gold, diamond
  // v8 (update 10): building blocks for villages and bases, the islands' plants and wood
  mossy_cobblestone: 187,
  mossy_stone_bricks: 188,
  clay: 189,
  terracotta0: 190, // 190..195: plain, cream, rust, ochre, slate, charcoal
  wool_brown: 196,
  wool_green: 197,
  wool_grey: 198,
  wool_light_blue: 199,
  path_top: 200,
  path_side: 201,
  lantern: 202,
  lantern_top: 203,
  barrel_top: 204,
  barrel_side: 205,
  bookshelf: 206,
  hay_side: 207,
  hay_top: 208,
  flower_pot: 209,
  chime: 210,
  trapdoor: 211,
  bluebell: 212,
  palm_log: 213,
  palm_log_top: 214,
  palm_leaves: 215,
  // v8 items
  boat: 216,
  clay_ball: 217,
  brick: 218,
  coconut: 219,
  // v9 items
  smoked_fish: 220,
} as const;
export const WATER_FRAMES = 16;
export const CRACK_STAGES = 10;
/** Texture layers in use. The mesher sends the layer as a u8 and WebGL2 only promises 256 array layers: keep <= 256. */
export const TEX_LAYERS = 221;

export interface BlockDef {
  id: number;
  key: string;
  name: string;
  solid: boolean; // has a collision box
  opaque: boolean; // full opaque cube: hides neighbour faces, stops light
  aoOccluder: boolean; // darkens neighbouring vertices (smooth lighting)
  render: RenderKind;
  /** Texture layer per face: +X, -X, +Y, -Y, +Z, -Z */
  tex: [number, number, number, number, number, number];
  /** Ticks to break (20 per second). 0 = instant, -1 = unbreakable. */
  breakTicks: number;
  light: number; // light emitted, 0..15
  lightOpacity: number; // extra light loss when light passes through, 0..15
  sound: SoundGroup;
  placeable: boolean; // offered in the block picker
  replaceable: boolean; // placing a block into this cell replaces it
  needsSupport: boolean; // pops off when the block below goes away
  cullSame: boolean; // hide faces between two blocks of this type
  color: number; // average colour, for the map and fallbacks
  /** The picker item this state belongs to (stairs facing east -> the stairs item). */
  item: number;
  /** A client may ask to place exactly this state (doors and beds: only the lower/foot half). */
  clientPlace: boolean;
  /** Collision: "none", a full "cube", or a "model" made of boxes (see shapes.ts). */
  shape: "none" | "cube" | "model";
  climbable: boolean;
}

const all6 = (t: number): [number, number, number, number, number, number] => [t, t, t, t, t, t];
const column = (side: number, top: number, bottom: number): [number, number, number, number, number, number] => [
  side,
  side,
  top,
  bottom,
  side,
  side,
];

type Partial6 = Partial<BlockDef> & { key: string; name: string; tex: BlockDef["tex"] };

function def(id: number, d: Partial6): BlockDef {
  return {
    id,
    key: d.key,
    name: d.name,
    solid: d.solid ?? true,
    opaque: d.opaque ?? true,
    aoOccluder: d.aoOccluder ?? d.solid ?? true,
    render: d.render ?? "cube",
    tex: d.tex,
    breakTicks: d.breakTicks ?? 20,
    light: d.light ?? 0,
    lightOpacity: d.lightOpacity ?? (d.opaque === false ? 0 : 15),
    sound: d.sound ?? "stone",
    placeable: d.placeable ?? true,
    replaceable: d.replaceable ?? false,
    needsSupport: d.needsSupport ?? false,
    cullSame: d.cullSame ?? false,
    color: d.color ?? 0x888888,
    item: d.item ?? id,
    clientPlace: d.clientPlace ?? d.placeable ?? true,
    shape: d.shape ?? (d.solid === false ? "none" : "cube"),
    climbable: d.climbable ?? false,
  };
}

export const B = {
  AIR: 0,
  GRASS: 1,
  DIRT: 2,
  STONE: 3,
  COBBLESTONE: 4,
  OAK_LOG: 5,
  OAK_PLANKS: 6,
  OAK_LEAVES: 7,
  BIRCH_LOG: 8,
  BIRCH_LEAVES: 9,
  SAND: 10,
  WATER: 11,
  GLASS: 12,
  BRICKS: 13,
  STONE_BRICKS: 14,
  WOOL_WHITE: 15,
  WOOL_RED: 16,
  WOOL_ORANGE: 17,
  WOOL_YELLOW: 18,
  WOOL_LIME: 19,
  WOOL_BLUE: 20,
  WOOL_PURPLE: 21,
  WOOL_BLACK: 22,
  TORCH: 23,
  LAMP: 24,
  TALL_GRASS: 25,
  DANDELION: 26,
  POPPY: 27,
  BEDROCK: 28,
  GRAVEL: 29,
  BIRCH_PLANKS: 30,
  WOOL_CYAN: 31,
  WOOL_PINK: 32,
  // Building blocks with states (protocol v4). Each is a run of ids; see shapes.ts for the encoding.
  OAK_DOOR: 33, // 33..48: facing (0..3) + 4*open + 8*upper
  OAK_STAIRS: 49, // 49..56: facing + 4*upsideDown
  COBBLE_STAIRS: 57,
  STONE_BRICK_STAIRS: 65,
  BRICK_STAIRS: 73,
  OAK_SLAB: 81, // 81 bottom, 82 top
  COBBLE_SLAB: 83,
  STONE_BRICK_SLAB: 85,
  BRICK_SLAB: 87,
  STONE_SLAB: 89,
  OAK_FENCE: 91,
  LADDER: 92, // 92..95: facing (away from the wall)
  GLASS_PANE: 96,
  RED_BED: 97, // 97..104: facing + 4*head
  // Smooth blocks in flat colour (the spawn landmark is built from these: a teal shirt, blue trousers, tan skin).
  SMOOTH_TEAL: 105,
  SMOOTH_BLUE: 106,
  SMOOTH_TAN: 107,
  // Ores (protocol v3), found underground; placeable too, as decoration.
  COAL_ORE: 108,
  IRON_ORE: 109,
  GOLD_ORE: 110,
  DIAMOND_ORE: 111,
  RUBY_ORE: 112, // a faint red glow (light 3), like a redstone-style ore
  // Flowing water (protocol v4). WATER (11) is a source; these are what it spreads into.
  WATER_FLOW: 113, // 113..119: flowing water, level 1 (next to a source) .. 7 (the thin edge)
  WATER_FALL: 120, // falling water: there is water right above it
  // Survival (protocol v5)
  CRAFTING_TABLE: 121,
  FURNACE: 122, // 122..129: facing (the front: 0 north, 1 east, 2 south, 3 west) + 4*lit
  CHEST: 130, // 130..133: facing (the front)
  OAK_SAPLING: 134,
  BIRCH_SAPLING: 135,
  IRON_BLOCK: 136,
  GOLD_BLOCK: 137,
  DIAMOND_BLOCK: 138,
  RUBY_BLOCK: 139,
  COAL_BLOCK: 140,
  // Farming and depth (protocol v7)
  FARMLAND: 141, // 141 dry, 142 moist (water within 4 blocks)
  WHEAT: 143, // 143..150: growth stages 0..7 (7 is ripe)
  SUGAR_CANE: 151,
  CAKE: 152, // 152..158: slices eaten 0..6
  // World update (protocol v8): building blocks for villages and nicer bases, and the islands' plants and wood.
  COBBLE_WALL: 159,
  STONE_BRICK_WALL: 160,
  MOSSY_COBBLE: 161,
  MOSSY_STONE_BRICKS: 162,
  CLAY: 163,
  TERRACOTTA: 164, // 164..169: plain, cream, rust, ochre, slate, charcoal
  WOOL_BROWN: 170,
  WOOL_GREEN: 171,
  WOOL_GREY: 172,
  WOOL_LIGHT_BLUE: 173,
  DIRT_PATH: 174,
  LANTERN: 175, // 175 standing, 176 hanging
  BARREL: 177,
  BOOKSHELF: 178,
  HAY_BALE: 179,
  FLOWER_POT: 180, // 180 empty, 181 poppy, 182 dandelion, 183 bluebell
  VILLAGE_CHIME: 184,
  OAK_GATE: 185, // 185..192: facing (0..3) + 4*open
  TRAPDOOR: 193, // 193..208: facing (0..3) + 4*open + 8*top half
  BIRCH_STAIRS: 209, // 209..216
  BIRCH_SLAB: 217, // 217 bottom, 218 top
  BIRCH_FENCE: 219,
  BLUEBELL: 220,
  PALM_LOG: 221,
  PALM_LEAVES: 222,
} as const;
/** First block id not in use yet. Ids are a u8 on the wire and in the world arrays, and the mesher uses 255 for
 *  "outside the world": 254 is the last id a block can have (32 left after v8). */
export const NEXT_FREE_BLOCK = 223;

/** Texture per face (+X, -X, +Y, -Y, +Z, -Z) for a block whose front faces `facing` (0 north -Z, 1 east +X,
 *  2 south +Z, 3 west -X). */
export function facedTex(front: number, side: number, top: number, bottom: number, facing: number): [number, number, number, number, number, number] {
  const t: [number, number, number, number, number, number] = [side, side, top, bottom, side, side];
  t[[5, 0, 4, 1][facing & 3]] = front;
  return t;
}

// Break times follow Java Edition's formula (ticks = ceil(1 / (speed / hardness / 30))) for a player
// holding the matching wooden tool: dirt 0.4 s, stone 1.15 s, cobble 1.5 s, logs 1.5 s, wool by hand 1.2 s.
export const BLOCKS: BlockDef[] = [
  def(B.AIR, {
    key: "air", name: "Air", solid: false, opaque: false, aoOccluder: false, render: "none", tex: all6(0),
    breakTicks: -1, sound: "none", placeable: false, replaceable: true, lightOpacity: 0, color: 0,
  }),
  def(B.GRASS, { key: "grass", name: "Grass Block", tex: column(TEX.grass_side, TEX.grass_top, TEX.dirt), breakTicks: 9, sound: "grass", color: 0x5f9f35 }),
  def(B.DIRT, { key: "dirt", name: "Dirt", tex: all6(TEX.dirt), breakTicks: 8, sound: "gravel", color: 0x86603f }),
  def(B.STONE, { key: "stone", name: "Stone", tex: all6(TEX.stone), breakTicks: 23, sound: "stone", color: 0x7d7d7d }),
  def(B.COBBLESTONE, { key: "cobblestone", name: "Cobblestone", tex: all6(TEX.cobblestone), breakTicks: 30, sound: "stone", color: 0x777777 }),
  def(B.OAK_LOG, { key: "oak_log", name: "Oak Log", tex: column(TEX.oak_log, TEX.oak_log_top, TEX.oak_log_top), breakTicks: 30, sound: "wood", color: 0x6b5232 }),
  def(B.OAK_PLANKS, { key: "oak_planks", name: "Oak Planks", tex: all6(TEX.oak_planks), breakTicks: 30, sound: "wood", color: 0xa88a54 }),
  def(B.OAK_LEAVES, {
    key: "oak_leaves", name: "Oak Leaves", opaque: false, aoOccluder: true, render: "cutout", tex: all6(TEX.oak_leaves),
    breakTicks: 6, lightOpacity: 1, sound: "grass", color: 0x3f8a22,
  }),
  def(B.BIRCH_LOG, { key: "birch_log", name: "Birch Log", tex: column(TEX.birch_log, TEX.birch_log_top, TEX.birch_log_top), breakTicks: 30, sound: "wood", color: 0xd8d4c8 }),
  def(B.BIRCH_LEAVES, {
    key: "birch_leaves", name: "Birch Leaves", opaque: false, aoOccluder: true, render: "cutout", tex: all6(TEX.birch_leaves),
    breakTicks: 6, lightOpacity: 1, sound: "grass", color: 0x6a9a3e,
  }),
  def(B.SAND, { key: "sand", name: "Sand", tex: all6(TEX.sand), breakTicks: 8, sound: "sand", color: 0xdbd3a0 }),
  def(B.WATER, {
    key: "water", name: "Water", solid: false, opaque: false, aoOccluder: false, render: "water", tex: all6(TEX.water0),
    breakTicks: -1, lightOpacity: 2, sound: "none", placeable: true, replaceable: true, cullSame: true, color: 0x3f6fd8,
  }),
  def(B.GLASS, {
    key: "glass", name: "Glass", opaque: false, aoOccluder: false, render: "cutout", tex: all6(TEX.glass),
    breakTicks: 9, lightOpacity: 0, sound: "glass", cullSame: true, color: 0xc8e8f0,
  }),
  def(B.BRICKS, { key: "bricks", name: "Bricks", tex: all6(TEX.bricks), breakTicks: 30, sound: "stone", color: 0x965040 }),
  def(B.STONE_BRICKS, { key: "stone_bricks", name: "Stone Bricks", tex: all6(TEX.stone_bricks), breakTicks: 23, sound: "stone", color: 0x7a7a7a }),
  def(B.WOOL_WHITE, { key: "white_wool", name: "White Wool", tex: all6(TEX.wool_white), breakTicks: 24, sound: "cloth", color: 0xe9ecec }),
  def(B.WOOL_RED, { key: "red_wool", name: "Red Wool", tex: all6(TEX.wool_red), breakTicks: 24, sound: "cloth", color: 0xa12722 }),
  def(B.WOOL_ORANGE, { key: "orange_wool", name: "Orange Wool", tex: all6(TEX.wool_orange), breakTicks: 24, sound: "cloth", color: 0xf07613 }),
  def(B.WOOL_YELLOW, { key: "yellow_wool", name: "Yellow Wool", tex: all6(TEX.wool_yellow), breakTicks: 24, sound: "cloth", color: 0xf8c527 }),
  def(B.WOOL_LIME, { key: "lime_wool", name: "Lime Wool", tex: all6(TEX.wool_lime), breakTicks: 24, sound: "cloth", color: 0x70b919 }),
  def(B.WOOL_BLUE, { key: "blue_wool", name: "Blue Wool", tex: all6(TEX.wool_blue), breakTicks: 24, sound: "cloth", color: 0x35399d }),
  def(B.WOOL_PURPLE, { key: "purple_wool", name: "Purple Wool", tex: all6(TEX.wool_purple), breakTicks: 24, sound: "cloth", color: 0x792aac }),
  def(B.WOOL_BLACK, { key: "black_wool", name: "Black Wool", tex: all6(TEX.wool_black), breakTicks: 24, sound: "cloth", color: 0x15161b }),
  def(B.TORCH, {
    key: "torch", name: "Torch", solid: false, opaque: false, aoOccluder: false, render: "torch", tex: all6(TEX.torch),
    breakTicks: 0, light: 14, lightOpacity: 0, sound: "wood", needsSupport: true, color: 0xffd060,
  }),
  def(B.LAMP, { key: "lamp", name: "Lamp", tex: all6(TEX.lamp), breakTicks: 9, light: 15, sound: "glass", color: 0xf0c060 }),
  def(B.TALL_GRASS, {
    key: "tall_grass", name: "Grass", solid: false, opaque: false, aoOccluder: false, render: "cross", tex: all6(TEX.tall_grass),
    breakTicks: 0, lightOpacity: 0, sound: "grass", replaceable: true, needsSupport: true, color: 0x5a9a34,
  }),
  def(B.DANDELION, {
    key: "dandelion", name: "Dandelion", solid: false, opaque: false, aoOccluder: false, render: "cross", tex: all6(TEX.dandelion),
    breakTicks: 0, lightOpacity: 0, sound: "grass", needsSupport: true, color: 0xf0d020,
  }),
  def(B.POPPY, {
    key: "poppy", name: "Poppy", solid: false, opaque: false, aoOccluder: false, render: "cross", tex: all6(TEX.poppy),
    breakTicks: 0, lightOpacity: 0, sound: "grass", needsSupport: true, color: 0xd02020,
  }),
  def(B.BEDROCK, { key: "bedrock", name: "Bedrock", tex: all6(TEX.bedrock), breakTicks: -1, sound: "stone", placeable: false, color: 0x333333 }),
  def(B.GRAVEL, { key: "gravel", name: "Gravel", tex: all6(TEX.gravel), breakTicks: 9, sound: "gravel", color: 0x857f7c }),
  def(B.BIRCH_PLANKS, { key: "birch_planks", name: "Birch Planks", tex: all6(TEX.birch_planks), breakTicks: 30, sound: "wood", color: 0xc8b77a }),
  def(B.WOOL_CYAN, { key: "cyan_wool", name: "Cyan Wool", tex: all6(TEX.wool_cyan), breakTicks: 24, sound: "cloth", color: 0x158991 }),
  def(B.WOOL_PINK, { key: "pink_wool", name: "Pink Wool", tex: all6(TEX.wool_pink), breakTicks: 24, sound: "cloth", color: 0xed8dac }),
];

// ---- building blocks (appended; ids are the save format) ----

const stairDefs: [number, string, string, number, number, SoundGroup, number, number][] = [
  [B.OAK_STAIRS, "oak_stairs", "Oak Stairs", TEX.oak_planks, 30, "wood", 0xa88a54, B.OAK_PLANKS],
  [B.COBBLE_STAIRS, "cobblestone_stairs", "Cobblestone Stairs", TEX.cobblestone, 30, "stone", 0x777777, B.COBBLESTONE],
  [B.STONE_BRICK_STAIRS, "stone_brick_stairs", "Stone Brick Stairs", TEX.stone_bricks, 23, "stone", 0x7a7a7a, B.STONE_BRICKS],
  [B.BRICK_STAIRS, "brick_stairs", "Brick Stairs", TEX.bricks, 30, "stone", 0x965040, B.BRICKS],
];
const slabDefs: [number, string, string, number, number, SoundGroup, number, number][] = [
  [B.OAK_SLAB, "oak_slab", "Oak Slab", TEX.oak_planks, 30, "wood", 0xa88a54, B.OAK_PLANKS],
  [B.COBBLE_SLAB, "cobblestone_slab", "Cobblestone Slab", TEX.cobblestone, 30, "stone", 0x777777, B.COBBLESTONE],
  [B.STONE_BRICK_SLAB, "stone_brick_slab", "Stone Brick Slab", TEX.stone_bricks, 23, "stone", 0x7a7a7a, B.STONE_BRICKS],
  [B.BRICK_SLAB, "brick_slab", "Brick Slab", TEX.bricks, 30, "stone", 0x965040, B.BRICKS],
  [B.STONE_SLAB, "stone_slab", "Stone Slab", TEX.stone, 23, "stone", 0x7d7d7d, B.STONE],
];
/** Full block made by stacking two slabs of a material. */
export const SLAB_DOUBLE = new Map<number, number>();

{
  const model = { opaque: false, aoOccluder: false, render: "model" as RenderKind, lightOpacity: 0, shape: "model" as const };
  for (let s = 0; s < 16; s++) {
    BLOCKS.push(def(B.OAK_DOOR + s, {
      ...model, key: "oak_door", name: "Oak Door", tex: all6(TEX.oak_planks), breakTicks: 30, sound: "wood", color: 0x9a7b48,
      item: B.OAK_DOOR, placeable: s === 0, clientPlace: s < 4, needsSupport: s < 8,
    }));
  }
  for (const [base, key, name, tex, ticks, sound, color] of stairDefs) {
    for (let s = 0; s < 8; s++) {
      BLOCKS.push(def(base + s, { ...model, key, name, tex: all6(tex), breakTicks: ticks, sound, color, item: base, placeable: s === 0, clientPlace: true }));
    }
  }
  for (const [base, key, name, tex, ticks, sound, color, full] of slabDefs) {
    SLAB_DOUBLE.set(base, full);
    for (let s = 0; s < 2; s++) {
      BLOCKS.push(def(base + s, { ...model, key, name, tex: all6(tex), breakTicks: ticks, sound, color, item: base, placeable: s === 0, clientPlace: true }));
    }
  }
  BLOCKS.push(def(B.OAK_FENCE, { ...model, key: "oak_fence", name: "Oak Fence", tex: all6(TEX.oak_planks), breakTicks: 30, sound: "wood", color: 0xa88a54 }));
  for (let s = 0; s < 4; s++) {
    BLOCKS.push(def(B.LADDER + s, {
      ...model, key: "ladder", name: "Ladder", tex: all6(TEX.ladder), breakTicks: 6, sound: "wood", color: 0x8a6a3a,
      item: B.LADDER, placeable: s === 0, clientPlace: true, climbable: true, needsSupport: true,
    }));
  }
  BLOCKS.push(def(B.GLASS_PANE, { ...model, key: "glass_pane", name: "Glass Pane", tex: all6(TEX.glass), breakTicks: 9, sound: "glass", color: 0xc8e8f0 }));
  for (let s = 0; s < 8; s++) {
    BLOCKS.push(def(B.RED_BED + s, {
      ...model, key: "red_bed", name: "Red Bed", tex: [TEX.bed_side, TEX.bed_side, TEX.bed_foot_top, TEX.oak_planks, TEX.bed_side, TEX.bed_side],
      breakTicks: 6, sound: "cloth", color: 0xa12722, item: B.RED_BED, placeable: s === 0, clientPlace: s < 4,
    }));
  }
  BLOCKS.push(def(B.SMOOTH_TEAL, { key: "smooth_teal", name: "Smooth Teal", tex: all6(TEX.smooth_teal), breakTicks: 24, sound: "stone", color: 0x22a3a3 }));
  BLOCKS.push(def(B.SMOOTH_BLUE, { key: "smooth_blue", name: "Smooth Blue", tex: all6(TEX.smooth_blue), breakTicks: 24, sound: "stone", color: 0x3d4aa6 }));
  BLOCKS.push(def(B.SMOOTH_TAN, { key: "smooth_tan", name: "Smooth Tan", tex: all6(TEX.smooth_tan), breakTicks: 24, sound: "stone", color: 0xc9946a }));
  // Ores take a little longer than stone (no tools yet).
  BLOCKS.push(def(B.COAL_ORE, { key: "coal_ore", name: "Coal Ore", tex: all6(TEX.coal_ore), breakTicks: 34, sound: "stone", color: 0x5d5d5d }));
  BLOCKS.push(def(B.IRON_ORE, { key: "iron_ore", name: "Iron Ore", tex: all6(TEX.iron_ore), breakTicks: 38, sound: "stone", color: 0x8a7a6c }));
  BLOCKS.push(def(B.GOLD_ORE, { key: "gold_ore", name: "Gold Ore", tex: all6(TEX.gold_ore), breakTicks: 38, sound: "stone", color: 0x8f8661 }));
  BLOCKS.push(def(B.DIAMOND_ORE, { key: "diamond_ore", name: "Diamond Ore", tex: all6(TEX.diamond_ore), breakTicks: 44, sound: "stone", color: 0x6f9ea0 }));
  BLOCKS.push(def(B.RUBY_ORE, { key: "ruby_ore", name: "Ruby Ore", tex: all6(TEX.ruby_ore), breakTicks: 38, light: 3, sound: "stone", color: 0x8a5a5a }));
  // Flowing and falling water: not placeable (place a Water source and let it run), replaced by anything placed.
  for (let k = 1; k <= 7; k++) {
    BLOCKS.push(def(B.WATER_FLOW + k - 1, {
      key: "flowing_water", name: "Water", solid: false, opaque: false, aoOccluder: false, render: "water", tex: all6(TEX.water0),
      breakTicks: -1, lightOpacity: 2, sound: "none", placeable: false, clientPlace: false, replaceable: true, cullSame: true, color: 0x3f6fd8, item: B.WATER,
    }));
  }
  BLOCKS.push(def(B.WATER_FALL, {
    key: "falling_water", name: "Water", solid: false, opaque: false, aoOccluder: false, render: "water", tex: all6(TEX.water0),
    breakTicks: -1, lightOpacity: 2, sound: "none", placeable: false, clientPlace: false, replaceable: true, cullSame: true, color: 0x3f6fd8, item: B.WATER,
  }));
  // ---- survival (protocol v5)
  BLOCKS.push(def(B.CRAFTING_TABLE, {
    key: "crafting_table", name: "Crafting Table", tex: [TEX.crafting_table_front, TEX.crafting_table_side, TEX.crafting_table_top, TEX.oak_planks, TEX.crafting_table_front, TEX.crafting_table_side],
    breakTicks: 38, sound: "wood", color: 0x8a6a3a,
  }));
  for (let s = 0; s < 8; s++) {
    const lit = s >= 4;
    BLOCKS.push(def(B.FURNACE + s, {
      key: lit ? "lit_furnace" : "furnace", name: "Furnace", tex: facedTex(lit ? TEX.furnace_front_lit : TEX.furnace_front, TEX.furnace_side, TEX.furnace_top, TEX.furnace_top, s & 3),
      breakTicks: 53, sound: "stone", color: 0x6e6e6e, light: lit ? 13 : 0, item: B.FURNACE, placeable: s === 0, clientPlace: s < 4,
    }));
  }
  for (let s = 0; s < 4; s++) {
    BLOCKS.push(def(B.CHEST + s, {
      key: "chest", name: "Chest", opaque: false, aoOccluder: false, render: "model", lightOpacity: 0, shape: "model",
      tex: all6(TEX.chest_side), breakTicks: 38, sound: "wood", color: 0x9a6a2a, item: B.CHEST, placeable: s === 0, clientPlace: true,
    }));
  }
  BLOCKS.push(def(B.OAK_SAPLING, {
    key: "oak_sapling", name: "Oak Sapling", solid: false, opaque: false, aoOccluder: false, render: "cross", tex: all6(TEX.oak_sapling),
    breakTicks: 0, lightOpacity: 0, sound: "grass", needsSupport: true, color: 0x4b8a2a,
  }));
  BLOCKS.push(def(B.BIRCH_SAPLING, {
    key: "birch_sapling", name: "Birch Sapling", solid: false, opaque: false, aoOccluder: false, render: "cross", tex: all6(TEX.birch_sapling),
    breakTicks: 0, lightOpacity: 0, sound: "grass", needsSupport: true, color: 0x6a9a3e,
  }));
  BLOCKS.push(def(B.IRON_BLOCK, { key: "iron_block", name: "Block of Iron", tex: all6(TEX.iron_block), breakTicks: 113, sound: "stone", color: 0xd8d8d8 }));
  BLOCKS.push(def(B.GOLD_BLOCK, { key: "gold_block", name: "Block of Gold", tex: all6(TEX.gold_block), breakTicks: 113, sound: "stone", color: 0xf2cd3a }));
  BLOCKS.push(def(B.DIAMOND_BLOCK, { key: "diamond_block", name: "Block of Diamond", tex: all6(TEX.diamond_block), breakTicks: 113, sound: "stone", color: 0x62e0e0 }));
  BLOCKS.push(def(B.RUBY_BLOCK, { key: "ruby_block", name: "Block of Ruby", tex: all6(TEX.ruby_block), breakTicks: 113, light: 4, sound: "stone", color: 0xd8342c }));
  BLOCKS.push(def(B.COAL_BLOCK, { key: "coal_block", name: "Block of Coal", tex: all6(TEX.coal_block), breakTicks: 113, sound: "stone", color: 0x1e1e22 }));
  // ---- farming and depth (protocol v7)
  // Farmland: tilled dirt, 15/16 of a block tall (you sink a pixel into it), dry or watered. It drops dirt.
  for (let s = 0; s < 2; s++) {
    BLOCKS.push(def(B.FARMLAND + s, {
      key: "farmland", name: "Farmland", opaque: false, aoOccluder: true, render: "model", shape: "model", lightOpacity: 0,
      tex: column(TEX.dirt, s ? TEX.farmland_moist : TEX.farmland_dry, TEX.dirt), breakTicks: 9, sound: "gravel",
      color: s ? 0x4f3420 : 0x7a5638, item: B.DIRT, placeable: false, clientPlace: false,
    }));
  }
  // Wheat: planted from seeds on farmland, ripe at stage 7. The seeds are its item.
  for (let s = 0; s < 8; s++) {
    BLOCKS.push(def(B.WHEAT + s, {
      key: "wheat", name: "Wheat Crops", solid: false, opaque: false, aoOccluder: false, render: "crop", tex: all6(TEX.wheat0 + s),
      breakTicks: 0, lightOpacity: 0, sound: "grass", needsSupport: true, color: s < 7 ? 0x4f9a2a : 0xc8a83a,
      item: 281, placeable: false, clientPlace: s === 0,
    }));
  }
  // Sugar cane: grows by water, up to 3 tall.
  BLOCKS.push(def(B.SUGAR_CANE, {
    key: "sugar_cane", name: "Sugar Cane", solid: false, opaque: false, aoOccluder: false, render: "cross", tex: all6(TEX.sugar_cane),
    breakTicks: 0, lightOpacity: 0, sound: "grass", needsSupport: true, color: 0x8fbf5a,
  }));
  // Cake: a block you eat a slice at a time (7 slices). Breaking it gives nothing back, like the classic game.
  for (let s = 0; s < 7; s++) {
    BLOCKS.push(def(B.CAKE + s, {
      key: "cake", name: "Cake", opaque: false, aoOccluder: false, render: "model", shape: "model", lightOpacity: 0,
      tex: [TEX.cake_side, TEX.cake_side, TEX.cake_top, TEX.cake_bottom, TEX.cake_side, TEX.cake_side], breakTicks: 10, sound: "cloth",
      color: 0xeae2d6, item: B.CAKE, placeable: s === 0, clientPlace: s === 0, needsSupport: true,
    }));
  }
  // ---- world update (protocol v8): building blocks, the islands' plants and wood
  const cube = (id: number, key: string, name: string, tex: BlockDef["tex"], breakTicks: number, sound: SoundGroup, color: number, more: Partial<BlockDef> = {}) =>
    BLOCKS.push(def(id, { key, name, tex, breakTicks, sound, color, ...more }));
  // Walls connect to walls, gates and solid blocks (see shapes.ts); 1.5 blocks tall for collision, like fences.
  BLOCKS.push(def(B.COBBLE_WALL, { ...model, key: "cobblestone_wall", name: "Cobblestone Wall", tex: all6(TEX.cobblestone), breakTicks: 30, sound: "stone", color: 0x777777 }));
  BLOCKS.push(def(B.STONE_BRICK_WALL, { ...model, key: "stone_brick_wall", name: "Stone Brick Wall", tex: all6(TEX.stone_bricks), breakTicks: 23, sound: "stone", color: 0x7a7a7a }));
  cube(B.MOSSY_COBBLE, "mossy_cobblestone", "Mossy Cobblestone", all6(TEX.mossy_cobblestone), 30, "stone", 0x6a7a5c);
  cube(B.MOSSY_STONE_BRICKS, "mossy_stone_bricks", "Mossy Stone Bricks", all6(TEX.mossy_stone_bricks), 23, "stone", 0x6f7a66);
  cube(B.CLAY, "clay", "Clay", all6(TEX.clay), 9, "gravel", 0x9fa6b4);
  const TERRA: [string, string, number][] = [
    ["terracotta", "Terracotta", 0xa4613f],
    ["cream_terracotta", "Cream Terracotta", 0xd8c3a0],
    ["rust_terracotta", "Rust Terracotta", 0x8e3a2a],
    ["ochre_terracotta", "Ochre Terracotta", 0xb8862e],
    ["slate_terracotta", "Slate Terracotta", 0x4f6070],
    ["charcoal_terracotta", "Charcoal Terracotta", 0x3a2f2c],
  ];
  TERRA.forEach(([key, name, color], k) => cube(B.TERRACOTTA + k, key, name, all6(TEX.terracotta0 + k), 25, "stone", color));
  cube(B.WOOL_BROWN, "brown_wool", "Brown Wool", all6(TEX.wool_brown), 24, "cloth", 0x744a2b);
  cube(B.WOOL_GREEN, "green_wool", "Green Wool", all6(TEX.wool_green), 24, "cloth", 0x4b6b23);
  cube(B.WOOL_GREY, "grey_wool", "Grey Wool", all6(TEX.wool_grey), 24, "cloth", 0x6e7177);
  cube(B.WOOL_LIGHT_BLUE, "light_blue_wool", "Light Blue Wool", all6(TEX.wool_light_blue), 24, "cloth", 0x5ab0d8);
  // Dirt path: a pixel lower than a full block, like farmland. Made with a shovel on grass; drops dirt.
  BLOCKS.push(def(B.DIRT_PATH, {
    key: "dirt_path", name: "Dirt Path", opaque: false, aoOccluder: true, render: "model", shape: "model", lightOpacity: 0,
    tex: column(TEX.path_side, TEX.path_top, TEX.dirt), breakTicks: 9, sound: "gravel", color: 0x9a7b4c,
  }));
  for (let s = 0; s < 2; s++) {
    BLOCKS.push(def(B.LANTERN + s, {
      ...model, key: "lantern", name: "Lantern", tex: [TEX.lantern, TEX.lantern, TEX.lantern_top, TEX.lantern_top, TEX.lantern, TEX.lantern],
      breakTicks: 30, light: 15, sound: "glass", color: 0xf2b24a, item: B.LANTERN, placeable: s === 0, clientPlace: true, needsSupport: true,
    }));
  }
  cube(B.BARREL, "barrel", "Barrel", column(TEX.barrel_side, TEX.barrel_top, TEX.barrel_top), 38, "wood", 0x7d5a32);
  cube(B.BOOKSHELF, "bookshelf", "Bookshelf", column(TEX.bookshelf, TEX.oak_planks, TEX.oak_planks), 23, "wood", 0x8a6a42);
  cube(B.HAY_BALE, "hay_bale", "Hay Bale", column(TEX.hay_side, TEX.hay_top, TEX.hay_top), 6, "grass", 0xc8a43a);
  const POTS: [string, string][] = [["flower_pot", "Flower Pot"], ["potted_poppy", "Potted Poppy"], ["potted_dandelion", "Potted Dandelion"], ["potted_bluebell", "Potted Bluebell"]];
  POTS.forEach(([key, name], s) => {
    BLOCKS.push(def(B.FLOWER_POT + s, {
      ...model, key, name, tex: all6(TEX.flower_pot), breakTicks: 0, sound: "stone", color: 0xa4613f, needsSupport: true,
      item: B.FLOWER_POT, placeable: s === 0, clientPlace: s === 0,
    }));
  });
  // The village chime: our own village-centre block (a little wooden pavilion with three brass tubes). Rings on use.
  BLOCKS.push(def(B.VILLAGE_CHIME, { ...model, key: "village_chime", name: "Village Chime", tex: all6(TEX.chime), breakTicks: 38, sound: "wood", color: 0xc9a040 }));
  for (let s = 0; s < 8; s++) {
    BLOCKS.push(def(B.OAK_GATE + s, {
      ...model, key: "fence_gate", name: "Fence Gate", tex: all6(TEX.oak_planks), breakTicks: 30, sound: "wood", color: 0xa88a54,
      item: B.OAK_GATE, placeable: s === 0, clientPlace: s < 4,
    }));
  }
  for (let s = 0; s < 16; s++) {
    BLOCKS.push(def(B.TRAPDOOR + s, {
      ...model, key: "trapdoor", name: "Trapdoor", tex: all6(TEX.trapdoor), breakTicks: 30, sound: "wood", color: 0x9a7b48,
      item: B.TRAPDOOR, placeable: s === 0, clientPlace: (s & 4) === 0,
    }));
  }
  for (let s = 0; s < 8; s++) {
    BLOCKS.push(def(B.BIRCH_STAIRS + s, { ...model, key: "birch_stairs", name: "Birch Stairs", tex: all6(TEX.birch_planks), breakTicks: 30, sound: "wood", color: 0xc8b77a, item: B.BIRCH_STAIRS, placeable: s === 0, clientPlace: true }));
  }
  SLAB_DOUBLE.set(B.BIRCH_SLAB, B.BIRCH_PLANKS);
  for (let s = 0; s < 2; s++) {
    BLOCKS.push(def(B.BIRCH_SLAB + s, { ...model, key: "birch_slab", name: "Birch Slab", tex: all6(TEX.birch_planks), breakTicks: 30, sound: "wood", color: 0xc8b77a, item: B.BIRCH_SLAB, placeable: s === 0, clientPlace: true }));
  }
  BLOCKS.push(def(B.BIRCH_FENCE, { ...model, key: "birch_fence", name: "Birch Fence", tex: all6(TEX.birch_planks), breakTicks: 30, sound: "wood", color: 0xc8b77a }));
  BLOCKS.push(def(B.BLUEBELL, {
    key: "bluebell", name: "Bluebell", solid: false, opaque: false, aoOccluder: false, render: "cross", tex: all6(TEX.bluebell),
    breakTicks: 0, lightOpacity: 0, sound: "grass", needsSupport: true, color: 0x4a6fd8,
  }));
  cube(B.PALM_LOG, "palm_log", "Palm Log", column(TEX.palm_log, TEX.palm_log_top, TEX.palm_log_top), 30, "wood", 0x8a7456);
  BLOCKS.push(def(B.PALM_LEAVES, {
    key: "palm_leaves", name: "Palm Fronds", opaque: false, aoOccluder: true, render: "cutout", tex: all6(TEX.palm_leaves),
    breakTicks: 6, lightOpacity: 1, sound: "grass", color: 0x5aa83a,
  }));
  if (BLOCKS.length !== NEXT_FREE_BLOCK) throw new Error(`NEXT_FREE_BLOCK is ${NEXT_FREE_BLOCK}, blocks end at ${BLOCKS.length}`);
  for (let i = 0; i < BLOCKS.length; i++) if (BLOCKS[i].id !== i) throw new Error(`block id gap at ${i}`);
}

export const BLOCK_COUNT = BLOCKS.length;

// Flat lookup tables for hot loops (meshing, physics, lighting).
export const SOLID = new Uint8Array(256);
export const OPAQUE = new Uint8Array(256);
export const AO_OCC = new Uint8Array(256);
export const EMIT = new Uint8Array(256);
export const LIGHT_OPACITY = new Uint8Array(256);
export const RENDER = new Uint8Array(256); // index into RENDER_KINDS
export const RENDER_KINDS: RenderKind[] = ["none", "cube", "cutout", "water", "cross", "torch", "model", "crop"];
/** 0 no collision, 1 full cube, 2 model (boxes from shapes.ts). */
export const SHAPE = new Uint8Array(256);
export const CLIMB = new Uint8Array(256);
export const ITEM_OF = new Uint16Array(256); // v7: crops map to item ids above 255 (seeds)
export const BREAK_TICKS = new Int16Array(256).fill(-1);
/** 1 for every water state: the source, flowing levels 1-7 and falling water. */
export const IS_WATER = new Uint8Array(256);

for (const b of BLOCKS) {
  SOLID[b.id] = b.solid ? 1 : 0;
  OPAQUE[b.id] = b.opaque ? 1 : 0;
  AO_OCC[b.id] = b.aoOccluder ? 1 : 0;
  EMIT[b.id] = b.light;
  LIGHT_OPACITY[b.id] = b.opaque ? 15 : b.lightOpacity;
  RENDER[b.id] = RENDER_KINDS.indexOf(b.render);
  BREAK_TICKS[b.id] = b.breakTicks;
  SHAPE[b.id] = b.shape === "none" ? 0 : b.shape === "cube" ? 1 : 2;
  CLIMB[b.id] = b.climbable ? 1 : 0;
  ITEM_OF[b.id] = b.item;
  IS_WATER[b.id] = b.render === "water" ? 1 : 0;
}
// Unknown ids behave like stone so a corrupt edit can never open a hole in collision.
for (let i = BLOCKS.length; i < 256; i++) {
  SOLID[i] = 1;
  OPAQUE[i] = 1;
  AO_OCC[i] = 1;
  LIGHT_OPACITY[i] = 15;
  RENDER[i] = 1;
  SHAPE[i] = 1;
  ITEM_OF[i] = B.STONE;
}

export function blockDef(id: number): BlockDef {
  return BLOCKS[id] ?? BLOCKS[B.STONE];
}

export function isValidBlockId(id: number): boolean {
  return Number.isInteger(id) && id >= 0 && id < BLOCKS.length;
}

/** Blocks shown in the E picker, in display order. */
export const PICKER_ORDER: number[] = [
  B.GRASS, B.DIRT, B.STONE, B.COBBLESTONE, B.STONE_BRICKS, B.BRICKS, B.SAND, B.GRAVEL,
  B.OAK_LOG, B.OAK_PLANKS, B.OAK_LEAVES, B.BIRCH_LOG, B.BIRCH_PLANKS, B.BIRCH_LEAVES, B.GLASS, B.LAMP,
  B.TORCH, B.WOOL_WHITE, B.WOOL_RED, B.WOOL_ORANGE, B.WOOL_YELLOW, B.WOOL_LIME, B.WOOL_CYAN, B.WOOL_BLUE,
  B.WOOL_PURPLE, B.WOOL_PINK, B.WOOL_BLACK, B.SMOOTH_TEAL, B.SMOOTH_BLUE, B.SMOOTH_TAN, B.TALL_GRASS, B.DANDELION, B.POPPY,
  B.COAL_ORE, B.IRON_ORE, B.GOLD_ORE, B.RUBY_ORE, B.DIAMOND_ORE, B.WATER,
  B.OAK_DOOR, B.OAK_STAIRS, B.COBBLE_STAIRS, B.STONE_BRICK_STAIRS, B.BRICK_STAIRS, B.OAK_SLAB, B.COBBLE_SLAB,
  B.STONE_BRICK_SLAB, B.BRICK_SLAB, B.STONE_SLAB, B.OAK_FENCE, B.LADDER, B.GLASS_PANE, B.RED_BED,
  B.CRAFTING_TABLE, B.FURNACE, B.CHEST, B.OAK_SAPLING, B.BIRCH_SAPLING, B.IRON_BLOCK, B.GOLD_BLOCK, B.DIAMOND_BLOCK, B.RUBY_BLOCK, B.COAL_BLOCK,
  B.SUGAR_CANE, B.CAKE,
  // v8
  B.COBBLE_WALL, B.STONE_BRICK_WALL, B.MOSSY_COBBLE, B.MOSSY_STONE_BRICKS, B.CLAY, B.TERRACOTTA, B.TERRACOTTA + 1, B.TERRACOTTA + 2,
  B.TERRACOTTA + 3, B.TERRACOTTA + 4, B.TERRACOTTA + 5, B.WOOL_BROWN, B.WOOL_GREEN, B.WOOL_GREY, B.WOOL_LIGHT_BLUE, B.DIRT_PATH,
  B.LANTERN, B.BARREL, B.BOOKSHELF, B.HAY_BALE, B.FLOWER_POT, B.VILLAGE_CHIME, B.OAK_GATE, B.TRAPDOOR, B.BIRCH_STAIRS,
  B.BIRCH_SLAB, B.BIRCH_FENCE, B.BLUEBELL, B.PALM_LOG, B.PALM_LEAVES,
];

export const DEFAULT_HOTBAR: number[] = [
  B.OAK_PLANKS, B.COBBLESTONE, B.OAK_LOG, B.GLASS, B.BRICKS, B.OAK_DOOR, B.OAK_STAIRS, B.OAK_FENCE, B.TORCH,
];

export const isFurnace = (id: number) => id >= B.FURNACE && id < B.FURNACE + 8;
export const isChest = (id: number) => id >= B.CHEST && id < B.CHEST + 4;
export const isSapling = (id: number) => id === B.OAK_SAPLING || id === B.BIRCH_SAPLING;
// v7
export const isFarmland = (id: number) => id === B.FARMLAND || id === B.FARMLAND + 1;
export const isWheat = (id: number) => id >= B.WHEAT && id < B.WHEAT + 8;
/** Growth stage of a wheat block, 0..7 (7 is ripe). */
export const wheatAge = (id: number) => id - B.WHEAT;
export const isCake = (id: number) => id >= B.CAKE && id < B.CAKE + 7;
/** Slices eaten from a cake block, 0..6. */
export const cakeBites = (id: number) => id - B.CAKE;

// v8
/** Small plants that sit on grass or dirt and get washed away, trampled over and replaced by trees: grass and the
 *  flowers (v8: bluebells too). */
export const isSmallPlant = (id: number) => id === B.TALL_GRASS || id === B.DANDELION || id === B.POPPY || id === B.BLUEBELL;
export const isFlower = (id: number) => id === B.DANDELION || id === B.POPPY || id === B.BLUEBELL;
export const isLantern = (id: number) => id === B.LANTERN || id === B.LANTERN + 1;
export const isPot = (id: number) => id >= B.FLOWER_POT && id < B.FLOWER_POT + 4;
export const isGate = (id: number) => id >= B.OAK_GATE && id < B.OAK_GATE + 8;
export const isTrapdoor = (id: number) => id >= B.TRAPDOOR && id < B.TRAPDOOR + 16;
export const isWall = (id: number) => id === B.COBBLE_WALL || id === B.STONE_BRICK_WALL;
/** Blocks with a 27-slot store: chests and (v8) barrels. */
export const isStorage = (id: number) => isChest(id) || id === B.BARREL;
/** The flower a potted-plant block holds (0 for an empty pot), and the pot state for a flower (-1 if it can't go in). */
export const POTTED: number[] = [0, B.POPPY, B.DANDELION, B.BLUEBELL];
export const pottedFlower = (id: number) => (isPot(id) ? POTTED[id - B.FLOWER_POT] : 0);
export const potFor = (flower: number) => {
  const k = POTTED.indexOf(flower);
  return k > 0 ? B.FLOWER_POT + k : -1;
};

/** Plants need grass or dirt below; torches need a solid block below. */
export function canSupport(id: number, below: number): boolean {
  if (id === B.TORCH) return OPAQUE[below] === 1;
  if (isSmallPlant(id) || id === B.OAK_SAPLING || id === B.BIRCH_SAPLING) return below === B.GRASS || below === B.DIRT;
  return true;
}
