// v7 farming rules both sides share: when farmland counts as watered. (The server runs the growing:
// server/src/farm.ts; the client uses this to show freshly tilled farmland watered or dry at once.)

import { IS_WATER } from "./blocks.ts";

type Get = (x: number, y: number, z: number) => number;

/** Water within 4 blocks across, at the farmland's level or one above (the classic 9 x 9 x 2 area). */
export function hydratedAt(get: Get, x: number, y: number, z: number): boolean {
  for (let dy = 0; dy <= 1; dy++)
    for (let dz = -4; dz <= 4; dz++)
      for (let dx = -4; dx <= 4; dx++) if (IS_WATER[get(x + dx, y + dy, z + dz)]) return true;
  return false;
}
