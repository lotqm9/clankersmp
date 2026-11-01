// Villagers (protocol v9, update 11): the people of the villages (shared/villages.ts). Our own design: round-headed
// folk in work clothes, each job shown by its outfit and hat. The server runs them (server/src/villagers.ts): they
// wander their village by day, go home at night, and trade with rubies (shared/trades.ts). Sent like animals
// (encodeAnimals with its own op): id, job, position, yaw and these flags.

export const JOBS = [
  { key: "farmer", name: "Farmer" }, // a straw sun hat, green overalls
  { key: "smith", name: "Smith" }, // a flat cap, a leather apron over a charcoal shirt
  { key: "librarian", name: "Librarian" }, // a tall plum cap, round spectacles, an indigo robe
  { key: "fisher", name: "Fisher" }, // a yellow rain hat, a blue coat
  { key: "mason", name: "Mason" }, // a red kerchief, a dusty grey apron
] as const;
export const JOB = { FARMER: 0, SMITH: 1, LIBRARIAN: 2, FISHER: 3, MASON: 4 } as const;

/** First names (never a real person's full name: just a friendly first name and the job). */
export const VILLAGER_NAMES = [
  "Tilly", "Bram", "Odette", "Wren", "Fenn", "Juniper", "Hollis", "Marigold", "Pip", "Rowan", "Sable", "Tamsin",
  "Corin", "Elsie", "Jory", "Lark", "Maeve", "Nell", "Ottie", "Quill", "Ivo", "Dot", "Barnaby", "Clover",
];

export const VF = {
  MOVING: 1,
  TALK: 2, // someone has its trade window open: it stands still and faces them
  HOME: 4, // indoors for the night
  GROUND: 8,
  HURT: 16, // poked: a little flinch (villagers take no damage)
} as const;

export const OP_VILLAGERS = 29; // like OP_ANIMALS: [op u8][tick u32][n u16] then n * 11 bytes (kind = job)
export const OP_VILLAGERS_GONE = 30; // like OP_ANIMALS_GONE

export const VILLAGER_W = 0.6;
export const VILLAGER_H = 1.85;
export const VILLAGER_RANGE = 96; // sent to players this close
export const VILLAGER_RANGE_OUT = 104;
/** How far a player may be to talk to (trade with) a villager, eye to box, with some slack for lag. */
export const TALK_REACH = 4.5;
export const TALK_REACH_SERVER = 6;

/** The full name shown over a villager and on its trade window. */
export const villagerTitle = (name: string, job: number) => `${name} the ${JOBS[job]?.name ?? "Villager"}`;
