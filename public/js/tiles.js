/*
 * Web Mercator tile grids, shared by the browser (the "AI Imagine" selection
 * box) and the server (the exact area it fetches and the AI result is pinned to).
 */
const EQUATOR_M = 40075016.686;
export const MIN_ZOOM = 14;
export const MAX_ZOOM = 20;
export const MAX_TILES = 4;

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lonOf = (x, N) => (x / N) * 360 - 180;
const latOf = (y, N) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / N))) * 180) / Math.PI;

/**
 * The n x n block of whole map tiles (at zoom z) closest to the view centre.
 * Returns { z, tiles, bbox: [west, south, east, north], center: [lon, lat],
 * width, length } with the ground size in metres (a tile block is square).
 */
export function tileArea(lon, lat, zoom, tiles) {
  const n = clamp(Math.round(tiles), 1, MAX_TILES);
  const z = clamp(Math.round(zoom), MIN_ZOOM, MAX_ZOOM);
  const N = 2 ** z;
  const la = clamp(lat, -85.05, 85.05);
  const fx = ((lon + 180) / 360) * N;
  const fy = ((1 - Math.asinh(Math.tan((la * Math.PI) / 180)) / Math.PI) / 2) * N;
  const x0 = clamp(Math.round(fx - n / 2), 0, N - n);
  const y0 = clamp(Math.round(fy - n / 2), 0, N - n);
  const north = latOf(y0, N), south = latOf(y0 + n, N);
  const center = [lonOf(x0 + n / 2, N), latOf(y0 + n / 2, N)];
  const size = (n * EQUATOR_M * Math.cos((center[1] * Math.PI) / 180)) / N;
  return { z, tiles: n, bbox: [lonOf(x0, N), south, lonOf(x0 + n, N), north], center, width: size, length: size };
}
