/*
 * Tent geometry shared by the top-down skin (skins.js), the 3D builder and map
 * layer (tent3d.js) and the API validator (server/features.js). Pure: no DOM.
 *
 * Local frame, in metres: x runs across the width (0 = left), y runs along the
 * length from the front (0) to the back (l), z is up. "Front" is the top edge
 * of the skin image, which faces the object's rotation bearing.
 */
export const FT = 0.3048;
export const ROOFS = ['auto', 'pyramid', 'hip', 'gable'];
export const WALLS = ['none', 'solid', 'window', 'clear'];
export const SIDES = ['front', 'back', 'left', 'right'];
export const LIMITS = { bay: [1, 12], eave: [1.5, 8], peak: [2, 25] };

export const isTent = (templateId) => typeof templateId === 'string' && templateId.startsWith('tent-');

const small = (w) => w <= 20 * FT + 0.05;
const autoRoof = (w, l) => (small(w) ? (Math.abs(w - l) < 0.05 ? 'pyramid' : 'hip') : 'gable');
/** Half the span the roof climbs over, so the default pitch matches the roof style. */
const climb = (roof, w, l) => (roof === 'gable' ? w / 2 : Math.min(w, l) / 2);

/**
 * Full tent spec with defaults filled in from the size: frame tents (≤20 ft wide)
 * get pyramid or hip roofs with 10 ft bays and steeper pitch; clearspans get a
 * gable roof, 5 m bays and taller legs as they widen.
 */
export function resolveTent(w, l, t = {}) {
  const roof = ROOFS.includes(t.roof) && t.roof !== 'auto' ? t.roof : autoRoof(w, l);
  // Defaults from the Grandchamp / Aztec structure drawings: 10 ft standard legs, 4/12 roof pitch
  // (rise = span / 6, plus the beam depth at the ridge), 15 ft bays from 30 ft wide. Frame tents
  // (20 ft and under) keep 8 ft legs, 10 ft bays and their steeper pitch.
  const bay = t.bay > 0 ? t.bay : w >= 30 * FT - 0.05 ? 15 * FT : 10 * FT;
  const eave = t.eave > 0 ? t.eave : small(w) ? 8 * FT : 10 * FT;
  const auto = small(w) ? eave + climb(roof, w, l) * 0.6 : eave + climb(roof, w, l) / 3 + 0.15;
  const peak = Math.max(t.peak > 0 ? t.peak : auto, eave + 0.3);
  const walls = {};
  for (const s of SIDES) walls[s] = WALLS.includes(t.walls?.[s]) ? t.walls[s] : 'none';
  return { roof, bay, eave, peak, walls, auto: { roof: autoRoof(w, l), peak: auto } };
}

/** Keep only the fields a user set (what gets stored on the feature). */
export function cleanTent(t) {
  if (!t || typeof t !== 'object') return null;
  const out = {};
  if (ROOFS.includes(t.roof) && t.roof !== 'auto') out.roof = t.roof;
  for (const k of ['bay', 'eave', 'peak']) {
    const v = Number(t[k]);
    if (t[k] != null && Number.isFinite(v) && v > 0) out[k] = Math.min(LIMITS[k][1], Math.max(LIMITS[k][0], v));
  }
  const walls = {};
  for (const s of SIDES) if (WALLS.includes(t.walls?.[s]) && t.walls[s] !== 'none') walls[s] = t.walls[s];
  if (Object.keys(walls).length) out.walls = walls;
  return Object.keys(out).length ? out : null;
}

/** Leg count along a run: one bay per `bay` metres, at least one. */
const bays = (run, bay) => Math.max(1, Math.round(run / bay));

/**
 * Every leg on the wall line, with the direction its ballast points (outward
 * normal) and the spacing to its neighbours. Corner legs belong to the long walls.
 */
export function legs(w, l, spec) {
  const out = [];
  const nl = bays(l, spec.bay), nw = bays(w, spec.bay);
  const sl = l / nl, sw = w / nw;
  for (let i = 0; i <= nl; i++) {
    out.push({ x: 0, y: sl * i, nx: -1, ny: 0, step: sl, side: 'left' });
    out.push({ x: w, y: sl * i, nx: 1, ny: 0, step: sl, side: 'right' });
  }
  for (let i = 1; i < nw; i++) {
    out.push({ x: sw * i, y: 0, nx: 0, ny: -1, step: sw, side: 'front' });
    out.push({ x: sw * i, y: l, nx: 0, ny: 1, step: sw, side: 'back' });
  }
  return out;
}

/** Bay divisions along each wall (metres from that wall's start), for wall panels and windows. */
export function wallBays(w, l, spec) {
  const split = (run) => { const n = bays(run, spec.bay); return Array.from({ length: n + 1 }, (_, i) => (run * i) / n); };
  return { long: split(l), short: split(w) };
}

/**
 * Roof faces as 3D polygons. Pyramid and hip roofs slope on all four sides
 * (the hip ridge runs along the longer axis); gable roofs have two planes with
 * a ridge down the length and triangular gable ends.
 */
export function roofFaces(w, l, spec) {
  const { roof, eave: e, peak: h } = spec;
  const c = (x, y, z = e) => [x, y, z];
  if (roof === 'gable') {
    return [
      { side: 'left', pts: [c(0, 0), c(0, l), c(w / 2, l, h), c(w / 2, 0, h)] },
      { side: 'right', pts: [c(w, 0), c(w / 2, 0, h), c(w / 2, l, h), c(w, l)] },
      { side: 'front', gable: true, pts: [c(0, 0), c(w / 2, 0, h), c(w, 0)] },
      { side: 'back', gable: true, pts: [c(w, l), c(w / 2, l, h), c(0, l)] },
    ];
  }
  let r1, r2;
  if (roof === 'pyramid') r1 = r2 = c(w / 2, l / 2, h);
  else if (l >= w) { r1 = c(w / 2, w / 2, h); r2 = c(w / 2, l - w / 2, h); }
  else { r1 = c(l / 2, l / 2, h); r2 = c(w - l / 2, l / 2, h); }
  const along = l >= w;
  const uniq = (pts) => pts.filter((p, i) => i === 0 || p.some((v, k) => v !== pts[i - 1][k]));
  return [
    { side: 'front', pts: uniq(along ? [c(0, 0), r1, c(w, 0)] : [c(0, 0), r1, r2, c(w, 0)]) },
    { side: 'back', pts: uniq(along ? [c(w, l), r2, c(0, l)] : [c(w, l), r2, r1, c(0, l)]) },
    { side: 'left', pts: uniq(along ? [c(0, l), r2, r1, c(0, 0)] : [c(0, l), r1, c(0, 0)]) },
    { side: 'right', pts: uniq(along ? [c(w, 0), r1, r2, c(w, l)] : [c(w, 0), r2, c(w, l)]) },
  ].map((f) => ({ ...f, pts: f.pts.length > 2 && f.pts[0].every((v, k) => v === f.pts.at(-1)[k]) ? f.pts.slice(0, -1) : f.pts }));
}

/** Sun direction for flat shading (x right, y toward the back, z up): high and from the front-left. */
const SUN = (() => { const v = [-0.45, -0.55, 0.7]; const n = Math.hypot(...v); return v.map((x) => x / n); })();

/** Unit normal of a planar polygon (Newell's method), pointing up/out for the winding used above. */
export function normal(pts) {
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1, z1] = pts[i], [x2, y2, z2] = pts[(i + 1) % pts.length];
    nx += (y1 - y2) * (z1 + z2); ny += (z1 - z2) * (x1 + x2); nz += (x1 - x2) * (y1 + y2);
  }
  const n = Math.hypot(nx, ny, nz) || 1;
  return [nx / n, ny / n, nz / n];
}

/** Normal of `pts`, flipped if needed so it points away from `inside` (a point within the solid). */
export function outward(pts, inside) {
  const n = normal(pts);
  const c = pts.reduce((a, p) => [a[0] + p[0] / pts.length, a[1] + p[1] / pts.length, a[2] + p[2] / pts.length], [0, 0, 0]);
  const d = (c[0] - inside[0]) * n[0] + (c[1] - inside[1]) * n[1] + (c[2] - inside[2]) * n[2];
  return d < 0 ? n.map((v) => -v) : n;
}

/** Brightness 0..1 for an outward surface normal under the fixed sun. */
export function lightness(n) {
  const d = n[0] * SUN[0] + n[1] * SUN[1] + n[2] * SUN[2];
  return 0.56 + 0.44 * Math.max(0, d);
}

/** Fabric and frame quantities for a quote sheet. */
export function quantities(w, l, spec) {
  const area = (pts) => {
    // planar polygon area = |sum of cross products| / 2
    let x = 0, y = 0, z = 0;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      x += a[1] * b[2] - a[2] * b[1]; y += a[2] * b[0] - a[0] * b[2]; z += a[0] * b[1] - a[1] * b[0];
    }
    return Math.hypot(x, y, z) / 2;
  };
  const roof = roofFaces(w, l, spec).reduce((s, f) => s + area(f.pts), 0);
  const runs = { front: w, back: w, left: l, right: l };
  let wallLen = 0;
  for (const s of SIDES) if (spec.walls[s] !== 'none') wallLen += runs[s];
  const legList = legs(w, l, spec);
  // interior volume: box to the eaves plus the roof wedge/pyramid above it
  const top = spec.peak - spec.eave;
  const roofVol = spec.roof === 'gable' ? (w * l * top) / 2
    : spec.roof === 'pyramid' ? (w * l * top) / 3
      : (() => { const a = Math.min(w, l), b = Math.max(w, l); return (a * top * (b - a)) / 2 + (a * a * top) / 3; })();
  return {
    footprint: w * l, roof, wallLength: wallLen, wallArea: wallLen * spec.eave,
    legs: legList.length, blocks: legList.length * 2, volume: w * l * spec.eave + roofVol,
  };
}
