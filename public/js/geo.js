/*
 * LiteMap geodesy core. Shared verbatim by the browser UI and the Node API so
 * both always produce identical numbers. Zero dependencies.
 *
 * Coordinates use GeoJSON order: [longitude, latitude] in WGS84 degrees.
 * All lengths are meters, all areas are square meters, angles are degrees
 * clockwise from true north.
 */

const A = 6378137;                 // WGS84 semi-major axis
const F = 1 / 298.257223563;       // WGS84 flattening
const B = A * (1 - F);
const E2 = F * (2 - F);
const R_AUTHALIC = 6371007.181;    // equal-area sphere radius
const R_MEAN = 6371008.8;
const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

export const FT = 0.3048;
export const SQFT = FT * FT;
export const ACRE = 4046.8564224;
export const MILE = 1609.344;
export const HECTARE = 10000;

export const normDeg = (d) => ((d % 360) + 360) % 360;
const wrap180 = (d) => ((((d + 180) % 360) + 360) % 360) - 180;
const round = (v, dp) => { const k = 10 ** dp; return Math.round(v * k) / k; };
export const roundCoord = ([lon, lat]) => [round(lon, 8), round(lat, 8)];

/* ---------------------------------------------------------------- distance */

export function haversine([lon1, lat1], [lon2, lat2]) {
  const p1 = lat1 * D2R, p2 = lat2 * D2R;
  const dp = p2 - p1, dl = (lon2 - lon1) * D2R;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R_MEAN * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Ellipsoidal (Vincenty inverse) distance, sub-millimeter accurate. */
export function distance(a, b) {
  const [lon1, lat1] = a, [lon2, lat2] = b;
  if (lon1 === lon2 && lat1 === lat2) return 0;
  const L = wrap180(lon2 - lon1) * D2R;
  const U1 = Math.atan((1 - F) * Math.tan(lat1 * D2R));
  const U2 = Math.atan((1 - F) * Math.tan(lat2 * D2R));
  const sinU1 = Math.sin(U1), cosU1 = Math.cos(U1);
  const sinU2 = Math.sin(U2), cosU2 = Math.cos(U2);
  let lambda = L, lambdaP, iter = 0;
  let sinSigma, cosSigma, sigma, cos2Alpha, cos2SigmaM;
  do {
    const sinL = Math.sin(lambda), cosL = Math.cos(lambda);
    sinSigma = Math.sqrt((cosU2 * sinL) ** 2 + (cosU1 * sinU2 - sinU1 * cosU2 * cosL) ** 2);
    if (sinSigma === 0) return 0;
    cosSigma = sinU1 * sinU2 + cosU1 * cosU2 * cosL;
    sigma = Math.atan2(sinSigma, cosSigma);
    const sinAlpha = (cosU1 * cosU2 * sinL) / sinSigma;
    cos2Alpha = 1 - sinAlpha * sinAlpha;
    cos2SigmaM = cos2Alpha !== 0 ? cosSigma - (2 * sinU1 * sinU2) / cos2Alpha : 0;
    const C = (F / 16) * cos2Alpha * (4 + F * (4 - 3 * cos2Alpha));
    lambdaP = lambda;
    lambda = L + (1 - C) * F * sinAlpha *
      (sigma + C * sinSigma * (cos2SigmaM + C * cosSigma * (-1 + 2 * cos2SigmaM ** 2)));
  } while (Math.abs(lambda - lambdaP) > 1e-12 && ++iter < 200);
  if (iter >= 200) return haversine(a, b); // near-antipodal: fall back
  const u2 = (cos2Alpha * (A * A - B * B)) / (B * B);
  const Ac = 1 + (u2 / 16384) * (4096 + u2 * (-768 + u2 * (320 - 175 * u2)));
  const Bc = (u2 / 1024) * (256 + u2 * (-128 + u2 * (74 - 47 * u2)));
  const dSigma = Bc * sinSigma * (cos2SigmaM + (Bc / 4) * (cosSigma * (-1 + 2 * cos2SigmaM ** 2) -
    (Bc / 6) * cos2SigmaM * (-3 + 4 * sinSigma ** 2) * (-3 + 4 * cos2SigmaM ** 2)));
  return B * Ac * (sigma - dSigma);
}

/** Bearing from a to b, degrees from north. Ellipsoidal local plane at site scale, great-circle beyond. */
export function bearing(a, b) {
  if (haversine(a, b) < 20000) {
    const f = localFrame([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
    const [x1, y1] = f.toXY(a), [x2, y2] = f.toXY(b);
    return normDeg(Math.atan2(x2 - x1, y2 - y1) * R2D);
  }
  const [lon1, lat1] = a, [lon2, lat2] = b;
  const p1 = lat1 * D2R, p2 = lat2 * D2R, dl = (lon2 - lon1) * D2R;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return normDeg(Math.atan2(y, x) * R2D);
}

/* ------------------------------------------------------ local tangent plane */

/**
 * Local east/north plane in meters around an origin, using the ellipsoid's
 * radii of curvature at that latitude. Error is far below imagery accuracy
 * for anything site-sized (a few km).
 */
export function localFrame([lon0, lat0]) {
  const phi = lat0 * D2R, s = Math.sin(phi);
  const w = Math.sqrt(1 - E2 * s * s);
  const N = A / w;
  const M = (A * (1 - E2)) / (w * w * w);
  const kx = N * Math.cos(phi) * D2R; // meters per degree of longitude
  const ky = M * D2R;                 // meters per degree of latitude
  return {
    origin: [lon0, lat0],
    toXY: ([lon, lat]) => [wrap180(lon - lon0) * kx, (lat - lat0) * ky],
    toLL: ([x, y]) => [lon0 + x / kx, lat0 + y / ky],
  };
}

/** Point `meters` away from `origin` along `bearingDeg` (local plane). */
export function offset(origin, meters, bearingDeg) {
  const f = localFrame(origin), t = bearingDeg * D2R;
  return f.toLL([Math.sin(t) * meters, Math.cos(t) * meters]);
}

/* ------------------------------------------------------------------ shapes */

export function openRing(ring) {
  if (ring.length > 1) {
    const a = ring[0], b = ring[ring.length - 1];
    if (a[0] === b[0] && a[1] === b[1]) return ring.slice(0, -1);
  }
  return ring.slice();
}
export function closeRing(ring) {
  const r = openRing(ring);
  return r.length ? [...r, r[0]] : r;
}

export function bbox(coords) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of coords) {
    if (x < minX) minX = x; if (y < minY) minY = y;
    if (x > maxX) maxX = x; if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
}
export const bboxCenter = (coords) => {
  const [a, b, c, d] = bbox(coords);
  return [(a + c) / 2, (b + d) / 2];
};

export function pathLength(coords) {
  let t = 0;
  for (let i = 1; i < coords.length; i++) t += distance(coords[i - 1], coords[i]);
  return t;
}

/** Point a fraction of the way along a path, by length. */
export function pointAlong(coords, fraction = 0.5) {
  if (coords.length === 1) return coords[0];
  const total = pathLength(coords);
  let target = total * fraction;
  for (let i = 1; i < coords.length; i++) {
    const d = distance(coords[i - 1], coords[i]);
    if (target <= d || i === coords.length - 1) {
      const t = d ? Math.min(1, target / d) : 0;
      const [x1, y1] = coords[i - 1], [x2, y2] = coords[i];
      return [x1 + (x2 - x1) * t, y1 + (y2 - y1) * t];
    }
    target -= d;
  }
  return coords[coords.length - 1];
}

const ringAreaPlanar = (pts) => {
  let s = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % n];
    s += x1 * y2 - x2 * y1;
  }
  return s / 2; // signed, CCW positive
};

const E = Math.sqrt(E2);
const qAuth = (s) => (1 - E2) * (s / (1 - E2 * s * s) - (1 / (2 * E)) * Math.log((1 - E * s) / (1 + E * s)));
const Q_POLE = qAuth(1);
const sinAuthalic = (latDeg) => qAuth(Math.sin(latDeg * D2R)) / Q_POLE;

/** Unsigned area of one ring in m². Planar for site-sized rings, spherical beyond. */
export function ringArea(ring) {
  const pts = openRing(ring);
  if (pts.length < 3) return 0;
  const [x0, y0, x1, y1] = bbox(pts);
  const span = haversine([x0, y0], [x1, y1]);
  if (span < 50000) {
    const f = localFrame(bboxCenter(pts));
    return Math.abs(ringAreaPlanar(pts.map(f.toXY)));
  }
  // Large rings: spherical excess on the authalic sphere, using authalic latitudes
  // so areas match the ellipsoid.
  let total = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const [l1, p1] = pts[i], [l2, p2] = pts[(i + 1) % n];
    total += wrap180(l2 - l1) * D2R * (2 + sinAuthalic(p1) + sinAuthalic(p2));
  }
  return Math.abs((total * R_AUTHALIC * R_AUTHALIC) / 2);
}

export function polygonArea(rings) {
  if (!rings.length) return 0;
  let a = ringArea(rings[0]);
  for (let i = 1; i < rings.length; i++) a -= ringArea(rings[i]);
  return Math.max(0, a);
}

/** Area-weighted centroid of a ring (falls back to vertex mean). */
export function centroid(ring) {
  const pts = openRing(ring);
  if (pts.length < 3) {
    const n = pts.length || 1;
    return [pts.reduce((s, p) => s + p[0], 0) / n, pts.reduce((s, p) => s + p[1], 0) / n];
  }
  const f = localFrame(bboxCenter(pts));
  const xy = pts.map(f.toXY);
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, n = xy.length; i < n; i++) {
    const [x1, y1] = xy[i], [x2, y2] = xy[(i + 1) % n];
    const c = x1 * y2 - x2 * y1;
    a += c; cx += (x1 + x2) * c; cy += (y1 + y2) * c;
  }
  if (Math.abs(a) < 1e-9) return bboxCenter(pts);
  return f.toLL([cx / (3 * a), cy / (3 * a)]);
}

/** Corners (CCW) of a w×l rectangle centered at (cx,cy) whose length axis points along bearing `rot`. */
export function rectCornersXY(cx, cy, w, l, rot) {
  const t = rot * D2R, c = Math.cos(t), s = Math.sin(t), hw = w / 2, hl = l / 2;
  return [[-hw, -hl], [hw, -hl], [hw, hl], [-hw, hl]].map(([a, b]) => [cx + a * c + b * s, cy - a * s + b * c]);
}

/**
 * Footprint ring (closed, CCW) for a reference object.
 * rect: `width` across, `length` along `rotation`. circle: `width` is the diameter.
 * `clearance` grows the shape outward on every side.
 */
export function footprintRing({ center, shape = 'rect', width, length, rotation = 0, clearance = 0 }) {
  const f = localFrame(center);
  const w = width + 2 * clearance;
  const l = (shape === 'circle' ? width : length ?? width) + 2 * clearance;
  let pts;
  if (shape === 'circle') {
    const r = w / 2, n = 72;
    pts = Array.from({ length: n }, (_, i) => {
      const a = (2 * Math.PI * i) / n;
      return [r * Math.cos(a), r * Math.sin(a)];
    });
  } else {
    pts = rectCornersXY(0, 0, w, l, rotation);
  }
  const ring = pts.map((p) => roundCoord(f.toLL(p)));
  ring.push(ring[0]);
  return ring;
}

/* --------------------------------------------------------------- measuring */

export function segmentLengths(coords) {
  const out = [];
  for (let i = 1; i < coords.length; i++) out.push(distance(coords[i - 1], coords[i]));
  return out;
}

/** Metrics for a GeoJSON geometry. */
export function measureGeometry(geom) {
  if (!geom || !geom.type) return {};
  switch (geom.type) {
    case 'Point':
      return { vertices: 1 };
    case 'LineString': {
      const segs = segmentLengths(geom.coordinates);
      return {
        lengthM: round(segs.reduce((s, d) => s + d, 0), 3),
        segmentsM: segs.map((d) => round(d, 3)),
        vertices: geom.coordinates.length,
      };
    }
    case 'Polygon': {
      const outer = closeRing(geom.coordinates[0] || []);
      const segs = segmentLengths(outer);
      return {
        areaM2: round(polygonArea(geom.coordinates), 2),
        perimeterM: round(segs.reduce((s, d) => s + d, 0), 3),
        segmentsM: segs.map((d) => round(d, 3)),
        vertices: Math.max(0, outer.length - 1),
      };
    }
    case 'MultiLineString': {
      const lengthM = geom.coordinates.reduce((s, c) => s + pathLength(c), 0);
      return { lengthM: round(lengthM, 3), vertices: geom.coordinates.reduce((s, c) => s + c.length, 0) };
    }
    case 'MultiPolygon': {
      let areaM2 = 0, perimeterM = 0, vertices = 0;
      for (const p of geom.coordinates) {
        areaM2 += polygonArea(p);
        const outer = closeRing(p[0] || []);
        perimeterM += pathLength(outer);
        vertices += Math.max(0, outer.length - 1);
      }
      return { areaM2: round(areaM2, 2), perimeterM: round(perimeterM, 3), vertices };
    }
    default:
      return {};
  }
}

/* --------------------------------------------------- planar helper geometry */

export function pointInRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function pointSegDist([px, py], [ax, ay], [bx, by]) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
export const pointSegmentDistance = pointSegDist;

const orient = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
function segsIntersect(p1, p2, p3, p4) {
  const d1 = orient(p3, p4, p1), d2 = orient(p3, p4, p2);
  const d3 = orient(p1, p2, p3), d4 = orient(p1, p2, p4);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}
const segSegDist = (a, b, c, d) =>
  Math.min(pointSegDist(a, c, d), pointSegDist(b, c, d), pointSegDist(c, a, b), pointSegDist(d, a, b));

/** Planar polygon (outer + holes) prepared for repeated containment tests. */
function preparePolygon(rings) {
  const edges = [];
  for (const r of rings) for (let i = 0; i < r.length; i++) edges.push([r[i], r[(i + 1) % r.length]]);
  const inside = (p) => pointInRing(p, rings[0]) && !rings.slice(1).some((h) => pointInRing(p, h));
  const edgeDist = (p) => {
    let m = Infinity;
    for (const [a, b] of edges) { const d = pointSegDist(p, a, b); if (d < m) m = d; }
    return m;
  };
  return { rings, edges, inside, edgeDist };
}

/**
 * Is the convex polygon `corners` fully inside prepared polygon P?
 * Returns the minimum gap to P's boundary (>= 0) or -1 if it doesn't fit.
 */
function containedSlack(corners, P, wantSlack = true) {
  for (const c of corners) if (!P.inside(c)) return -1;
  const n = corners.length;
  let slack = Infinity;
  for (const [a, b] of P.edges) {
    for (let i = 0; i < n; i++) {
      const c = corners[i], d = corners[(i + 1) % n];
      if (segsIntersect(a, b, c, d)) return -1;
      if (wantSlack) { const s = segSegDist(a, b, c, d); if (s < slack) slack = s; }
    }
  }
  // a hole sitting entirely inside the footprint
  for (let h = 1; h < P.rings.length; h++) if (pointInRing(P.rings[h][0], corners)) return -1;
  return wantSlack ? slack : 0;
}

function polygonXY(polygon) {
  const rings = Array.isArray(polygon) ? [polygon] : polygon.coordinates;
  const frame = localFrame(bboxCenter(openRing(rings[0])));
  return { frame, rings: rings.map((r) => openRing(r).map(frame.toXY)) };
}

function edgeAngles(ring, max = 8) {
  const edges = ring.map((p, i) => {
    const q = ring[(i + 1) % ring.length];
    return { len: Math.hypot(q[0] - p[0], q[1] - p[1]), ang: normDeg(Math.atan2(q[0] - p[0], q[1] - p[1]) * R2D) % 180 };
  }).sort((a, b) => b.len - a.len).slice(0, max);
  const out = [];
  for (const { ang } of edges) for (const a of [ang, (ang + 90) % 180]) {
    if (!out.some((o) => Math.abs(o - a) < 0.5 || Math.abs(o - a) > 179.5)) out.push(a);
  }
  return out;
}

/* ------------------------------------------------------------- fit & pack */

/**
 * Find a placement of a footprint inside a polygon, maximizing the gap to the
 * boundary. Polygon: GeoJSON Polygon geometry, or a single ring.
 * Returns { fits, center, rotation, slackM, footprint, clearanceFootprint }.
 */
export function fitFootprint(polygon, opts) {
  const { shape = 'rect', width, clearance = 0, angleStep = 3, samples = 48, allowRotation = true } = opts;
  const length = shape === 'circle' ? width : opts.length ?? width;
  const { frame, rings } = polygonXY(polygon);
  const P = preparePolygon(rings);
  const W = width + 2 * clearance, L = length + 2 * clearance;
  const minHalf = Math.min(W, L) / 2;
  const [x0, y0, x1, y1] = bbox(rings[0]);
  const step = Math.max(x1 - x0, y1 - y0) / samples || 1;

  const score = shape === 'circle'
    ? (x, y) => (P.inside([x, y]) ? P.edgeDist([x, y]) - W / 2 : -1)
    : (x, y, a) => containedSlack(rectCornersXY(x, y, W, L, a), P);

  let angles = [opts.rotation ?? 0];
  if (shape !== 'circle' && allowRotation) {
    angles = edgeAngles(rings[0]);
    for (let a = 0; a < 180; a += angleStep) angles.push(a);
  }

  let best = { s: -Infinity, x: 0, y: 0, a: angles[0] };
  const consider = (x, y, a) => {
    const s = score(x, y, a);
    if (s >= 0 && s > best.s) best = { s, x, y, a };
  };
  const centers = [];
  for (let x = x0 + step / 2; x < x1; x += step) {
    for (let y = y0 + step / 2; y < y1; y += step) {
      if (P.inside([x, y]) && P.edgeDist([x, y]) >= minHalf - 1e-9) centers.push([x, y]);
    }
  }
  const c = frame.toXY(centroid(polygon.coordinates ? polygon.coordinates[0] : polygon));
  centers.push(c);
  for (const [x, y] of centers) for (const a of angles) consider(x, y, a);

  if (best.s === -Infinity) return { fits: false };

  // pattern-search refinement
  let ds = step / 2, da = shape === 'circle' || !allowRotation ? 0 : angleStep / 2;
  for (let i = 0; i < 60 && ds > 0.005; i++) {
    const before = best.s;
    for (const [dx, dy, dA] of [[ds, 0, 0], [-ds, 0, 0], [0, ds, 0], [0, -ds, 0], [0, 0, da], [0, 0, -da]]) {
      if (!dx && !dy && !dA) continue;
      consider(best.x + dx, best.y + dy, best.a + dA);
    }
    if (best.s <= before) { ds /= 2; da /= 2; }
  }

  const center = roundCoord(frame.toLL([best.x, best.y]));
  const rotation = round(normDeg(best.a) % (shape === 'circle' ? 360 : 180), 2);
  const spec = { center, shape, width, length, rotation };
  return {
    fits: true,
    center,
    rotation,
    slackM: round(best.s, 3),
    footprint: { type: 'Polygon', coordinates: [footprintRing(spec)] },
    clearanceFootprint: clearance > 0 ? { type: 'Polygon', coordinates: [footprintRing({ ...spec, clearance })] } : null,
  };
}

/** Largest uniform scale (of width & length) at which the footprint still fits. */
export function largestFit(polygon, opts) {
  const quick = { ...opts, samples: 28, angleStep: 6 };
  let lo = 0, hi = 1, fit = null;
  const first = fitFootprint(polygon, quick);
  if (first.fits) {
    lo = 1; fit = first;
    while (hi < 1e4) { hi = lo * 2; const r = fitFootprint(polygon, scaled(quick, hi)); if (!r.fits) break; lo = hi; fit = r; }
  }
  for (let i = 0; i < 14; i++) {
    const mid = (lo + hi) / 2;
    const r = fitFootprint(polygon, scaled(quick, mid));
    if (r.fits) { lo = mid; fit = r; } else hi = mid;
  }
  if (!fit) return { fits: false, scale: 0 };
  const s = lo;
  return {
    fits: true,
    scale: round(s, 4),
    width: round(opts.width * s, 3),
    length: round((opts.shape === 'circle' ? opts.width : opts.length ?? opts.width) * s, 3),
    center: fit.center,
    rotation: fit.rotation,
  };
}
const scaled = (o, s) => ({
  ...o,
  width: o.width * s,
  length: (o.shape === 'circle' ? o.width : o.length ?? o.width) * s,
});

/**
 * Count how many copies of a footprint tile into a polygon on a grid (aligned
 * with the polygon's dominant edges). Clearance is kept around every copy, so
 * neighbours sit 2×clearance apart. Returns { count, rotation, centers }.
 */
export function packFootprints(polygon, opts) {
  const { shape = 'rect', width, clearance = 0, maxCells = 40000 } = opts;
  const length = shape === 'circle' ? width : opts.length ?? width;
  const { frame, rings } = polygonXY(polygon);
  const W = width + 2 * clearance, L = length + 2 * clearance;
  const angles = opts.rotation != null ? [opts.rotation] : shape === 'circle' ? [0] : [...new Set([0, 90, ...edgeAngles(rings[0], 6)])];
  let best = { count: 0, rotation: angles[0], cells: [] };

  for (const a of angles) {
    const t = a * D2R;
    const wAx = [Math.cos(t), -Math.sin(t)], lAx = [Math.sin(t), Math.cos(t)];
    const toUV = ([x, y]) => [x * wAx[0] + y * wAx[1], x * lAx[0] + y * lAx[1]];
    const fromUV = ([u, v]) => [u * wAx[0] + v * lAx[0], u * wAx[1] + v * lAx[1]];
    const P = preparePolygon(rings.map((r) => r.map(toUV)));
    const [u0, v0, u1, v1] = bbox(P.rings[0]);
    const nu = Math.floor((u1 - u0) / W) + 1, nv = Math.floor((v1 - v0) / L) + 1;
    if (nu * nv > maxCells) {
      const err = new Error(`Too many cells to evaluate (${nu * nv}); the object is very small relative to the area.`);
      err.code = 'too_many_cells';
      throw err;
    }
    // Grid phases: centered in the leftover space first, then shifted by thirds.
    const su = u0 + ((u1 - u0) % W) / 2, sv = v0 + ((v1 - v0) % L) / 2;
    for (const fu of [0, 1 / 3, 2 / 3]) for (const fv of [0, 1 / 3, 2 / 3]) {
      const cells = [];
      for (let i = -1; i < nu; i++) for (let j = -1; j < nv; j++) {
        const ua = su + (i + fu) * W, va = sv + (j + fv) * L;
        if (ua < u0 - 1e-9 || va < v0 - 1e-9) continue;
        if (ua + W > u1 + 1e-9 || va + L > v1 + 1e-9) continue;
        const cu = ua + W / 2, cv = va + L / 2;
        const ok = shape === 'circle'
          ? P.inside([cu, cv]) && P.edgeDist([cu, cv]) >= W / 2 - 1e-9
          : containedSlack([[ua, va], [ua + W, va], [ua + W, va + L], [ua, va + L]], P, false) >= 0;
        if (ok) cells.push([cu, cv]);
      }
      if (cells.length > best.count) best = { count: cells.length, rotation: a, cells: cells.map(fromUV) };
    }
  }
  return {
    count: best.count,
    rotation: round(normDeg(best.rotation), 2),
    centers: best.cells.map((c) => roundCoord(frame.toLL(c))),
  };
}

/* -------------------------------------------------------------- formatting */

const num = (v, dp) => v.toLocaleString('en-US', { maximumFractionDigits: dp, minimumFractionDigits: 0 });

export function fmtLength(m, units = 'imperial') {
  if (m == null || Number.isNaN(m)) return '—';
  if (units === 'metric') return m < 1000 ? `${num(m, m < 100 ? 2 : 1)} m` : `${num(m / 1000, 3)} km`;
  const ft = m / FT;
  return ft < 5280 ? `${num(ft, ft < 100 ? 1 : 0)} ft` : `${num(m / MILE, 2)} mi`;
}

export function fmtArea(m2, units = 'imperial') {
  if (m2 == null || Number.isNaN(m2)) return '—';
  if (units === 'metric') return m2 < HECTARE ? `${num(m2, 1)} m²` : `${num(m2, 0)} m² · ${num(m2 / HECTARE, 2)} ha`;
  const sqft = m2 / SQFT, ac = m2 / ACRE;
  return ac >= 0.1 ? `${num(sqft, 0)} ft² · ${num(ac, 2)} ac` : `${num(sqft, 0)} ft²`;
}

export const toUnit = (m, units) => (units === 'metric' ? m : m / FT);
export const fromUnit = (v, units) => (units === 'metric' ? v : v * FT);
export const unitLabel = (units) => (units === 'metric' ? 'm' : 'ft');
export const fmtDims = (w, l, units, shape) => {
  const s = (m) => num(toUnit(m, units), 1);
  return shape === 'circle' ? `⌀${s(w)} ${unitLabel(units)}` : `${s(w)} × ${s(l)} ${unitLabel(units)}`;
};
