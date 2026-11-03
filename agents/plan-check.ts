// clankersmp: every town design checked without a server. Each kind at each tier is planned on flat ground facing
// every way, then its cells are walked in build order the way buildCells places them: every block must have one
// already standing next to it (the server only puts a block against another), a torch needs a solid block under it, a
// hanging lantern one over it, a door the floor. It also says how high the top block is (the scaffolding reaches
// about 14 over the floor), what each tier takes, and (PLANS=1) draws the floor plan of the room and the front.
//   node agents/plan-check.ts            KINDS=chapel,cathedral PLANS=1 node agents/plan-check.ts
import { BLUEPRINTS, KINDS, cellTarget, materialsFor, planFor, sizeFacing, type Plain } from "./civ.ts";
import { B, BLOCKS, OPAQUE, SOLID } from "../shared/blocks.ts";
import { itemDef } from "../shared/items.ts";
import { isDoor, isLadder } from "../shared/shapes.ts";

const kinds = (process.env.KINDS || Object.keys(BLUEPRINTS).join(",")).split(",") as Plain[];
const plans = process.env.PLANS === "1";
const name = (id: number) => itemDef(id)?.key ?? BLOCKS[id]?.key ?? String(id);
let bad = 0;
const Y = 60;

for (const kind of kinds) {
  const bp = BLUEPRINTS[kind];
  if (!bp) {
    console.log(`${kind}: no such blueprint`);
    bad++;
    continue;
  }
  for (let tier = 1; tier <= KINDS[kind].tiers; tier++) {
    for (let face = 0; face < 4; face++) {
      const [w, d] = sizeFacing(kind, face);
      const s = { kind, x0: 100, z0: 100, x1: 100 + w - 1, z1: 100 + d - 1, y: Y, face };
      const cells = planFor(s, tier, () => Y - 1);
      const solid = new Set<string>();
      const at = new Map<string, number>();
      const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
      const isSolid = (x: number, y: number, z: number) => y <= Y - 1 || solid.has(key(x, y, z));
      const problems: string[] = [];
      let top = -99;
      const seen = new Set<string>();
      for (const [x, y, z, k] of cells) {
        if (seen.has(key(x, y, z))) problems.push(`two cells at ${x - s.x0},${y - Y},${z - s.z0}`);
        seen.add(key(x, y, z));
        const t = cellTarget(k.split("|")[0]);
        if (!t) continue;
        if (!t.optional) top = Math.max(top, y - Y);
        const id = t.id;
        const near = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].some(([a, b, c]) => isSolid(x + a, y + b, z + c));
        const below = at.get(key(x, y - 1, z)) ?? (y - 1 <= Y - 1 ? B.STONE : 0);
        const above = at.get(key(x, y + 1, z)) ?? 0;
        let why = "";
        if (!near && !isDoor(id)) why = "nothing next to it to place it against";
        else if (id === B.TORCH && !OPAQUE[below]) why = `a torch on ${name(below)}`;
        else if (id === B.LANTERN && !SOLID[below] && !SOLID[above]) why = "a lantern with nothing under or over it";
        else if (id === B.LANTERN + 1 && !SOLID[above] && !SOLID[below]) why = "a hanging lantern with nothing over it";
        else if (id === B.FLOWER_POT && !SOLID[below]) why = "a flower pot on nothing";
        else if (isDoor(id) && !OPAQUE[below]) why = `a door on ${name(below)}`;
        else if (isLadder(id) && !near) why = "a ladder on nothing";
        if (why && !t.optional) problems.push(`${name(id)} at ${x - s.x0},${y - Y},${z - s.z0}: ${why}`);
        at.set(key(x, y, z), id);
        if (SOLID[id]) solid.add(key(x, y, z));
      }
      if (face === 0) {
        const bill = [...materialsFor(kind, tier, tier > 1 ? tier - 1 : 0)].map(([id, n]) => `${name(id)} ${n}`).join(", ");
        console.log(`${kind} tier ${tier}: ${KINDS[kind].blocks[tier]} blocks, top ${top} over the floor${top > 14 ? " (OUT OF REACH?)" : ""}; ${tier > 1 ? "the upgrade takes" : "takes"}: ${bill}`);
      }
      if (problems.length) {
        bad++;
        console.log(`  FAIL ${kind} tier ${tier} facing ${face}: ${problems.length} problems: ${problems.slice(0, 6).join("; ")}`);
      }
      if (plans && face === 0 && tier === KINDS[kind].tiers) {
        // the room at floor height (dy 0) and one up, seen from above with the front at the bottom
        for (const dy of [-1, 0, 1]) {
          console.log(`  dy ${dy} (front at the bottom):`);
          for (let z = s.z1; z >= s.z0; z--) {
            let row = "   ";
            for (let x = s.x0; x <= s.x1; x++) {
              const id = at.get(key(x, Y + dy, z));
              row += id === undefined ? "." : glyph(id);
            }
            console.log(row);
          }
        }
        console.log("  the front (seen from the street):");
        for (let y = Y + top + 1; y >= Y - 1; y--) {
          let row = `   ${String(y - Y).padStart(3)} `;
          for (let x = s.x0; x <= s.x1; x++) {
            let id: number | undefined;
            for (let z = s.z0; z <= s.z1 && id === undefined; z++) id = at.get(key(x, y, z));
            row += id === undefined ? " " : glyph(id);
          }
          console.log(row);
        }
      }
    }
  }
}
function glyph(id: number): string {
  const k = BLOCKS[id]?.key ?? "?";
  if (id === B.COBBLESTONE) return "c";
  if (id === B.STONE_BRICKS) return "S";
  if (id === B.OAK_PLANKS) return "p";
  if (id === B.OAK_LOG) return "L";
  if (k.includes("stairs")) return "/";
  if (k.includes("slab")) return "_";
  if (k.includes("fence") || k.includes("wall")) return "|";
  if (k.includes("pane") || k === "glass") return "g";
  if (k.includes("door")) return "D";
  if (k.includes("bed")) return "B";
  if (k.includes("chest")) return "C";
  if (k.includes("furnace")) return "F";
  if (k.includes("crafting")) return "T";
  if (k.includes("barrel")) return "O";
  if (k.includes("bookshelf")) return "#";
  if (k.includes("lantern") || k.includes("torch")) return "*";
  if (k.includes("hay")) return "h";
  if (k.includes("wool")) return "w";
  if (k.includes("water")) return "~";
  if (k.includes("ladder")) return "H";
  if (k.includes("pot")) return "o";
  return "?";
}
console.log(bad ? `\n${bad} designs with problems` : "\nevery design builds in order");
process.exit(bad ? 1 : 0);
