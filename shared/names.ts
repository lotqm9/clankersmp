// Random player names in the $STEVE title screen's style: adjective + noun + "_" + 4 digits (e.g. DiamondMiner_7168).
// The same word lists as the $STEVE Craft builder (sites/steve-game), so the title screen and the game agree.

export const ADJECTIVES = [
  "Diamond", "Iron", "Gold", "Ender", "Creeper", "Nether", "Blocky",
  "Pixel", "Craft", "Redstone", "Happy", "Lucky", "Fast", "Epic",
];
export const NOUNS = [
  "Steve", "Alex", "Miner", "Builder", "Slayer", "King", "Queen",
  "Pickaxe", "Sword", "Golem", "Pig", "Cow", "Wolf", "Gamer",
];

/** localStorage key for the player's name: the $STEVE title screen (stevepumpfun.com) writes and reads the same key,
 *  so the name on the title screen is the name in the game. */
export const NAME_STORAGE_KEY = "steve_name";

export const NAME_RE = /^[A-Za-z0-9_]{3,20}$/;

export function randomName(rand: () => number = Math.random): string {
  const a = ADJECTIVES[Math.floor(rand() * ADJECTIVES.length)];
  const n = NOUNS[Math.floor(rand() * NOUNS.length)];
  const d = 1000 + Math.floor(rand() * 9000);
  return `${a}${n}_${d}`;
}

/** Names that would impersonate staff are refused. */
const RESERVED = ["admin", "mod", "staff", "owner", "server", "console", "official", "dev", "steveonpf"];

export function isReservedName(name: string): boolean {
  const n = name.toLowerCase();
  return RESERVED.some((w) => n.includes(w));
}
