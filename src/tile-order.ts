// The order tiles are processed in matters because every contour tile is drawn
// from its DEM tile plus the eight around it, and a tile's neighbours are
// wanted again by the tiles beside it. Walking a row at a time means a DEM
// tile is not wanted again until a whole row later, by which point it has left
// the cache, so it is decoded about three times. In Z-order (Morton) the tiles
// consecutive in the walk sit next to each other, so the few DEM tiles a run of
// them shares stay in the cache and each is decoded about once, however large
// the area is.

/**
 * Interleaves the bits of x and y into one number, x in the even bits.
 *
 * Done with arithmetic rather than bit operations because JavaScript's work on
 * 32 bits, and a z16 tile needs 32 bits for the pair. Exact up to z26.
 */
export function mortonKey(x: number, y: number): number {
  let key = 0;
  let weight = 1;
  let rx = x;
  let ry = y;
  while (rx > 0 || ry > 0) {
    key += (rx % 2) * weight + (ry % 2) * weight * 2;
    rx = Math.floor(rx / 2);
    ry = Math.floor(ry / 2);
    weight *= 4;
  }
  return key;
}

/**
 * Sorts tiles by zoom, then in Z-order within each zoom.
 * @param tiles - `[x, y, z]` tiles.
 * @returns The same array, sorted in place.
 */
export function sortTilesForCache<T extends [number, number, number]>(
  tiles: T[],
): T[] {
  const keys = new Map<T, number>();
  for (const tile of tiles) keys.set(tile, mortonKey(tile[0], tile[1]));
  return tiles.sort(
    (a, b) => a[2] - b[2] || (keys.get(a) ?? 0) - (keys.get(b) ?? 0),
  );
}
