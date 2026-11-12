/*
 * 3D meshes for catalog vehicles, in the same polygon format as tentMesh()
 * (tent3d.js), so the one WebGL layer draws both. Local frame in metres:
 * x across, y front -> back (0 = front), z up. Parts follow the manufacturer
 * drawing dimensions and scale with the placed width/length.
 */
import { outward, lightness } from './tentspec.js';

/** Hex colour scaled per channel by f (clamped), so f > 1 lightens without overflowing into the next channel. */
const tone = (c, f) => {
  const n = parseInt(c.slice(1), 16);
  return `#${[n >> 16, (n >> 8) & 255, n & 255].map((v) => Math.round(Math.max(0, Math.min(255, v * f))).toString(16).padStart(2, '0')).join('')}`;
};

/** Axis-aligned box; the bottom face is dropped (never visible, would only fight the ground). */
function box(out, x0, y0, z0, x1, y1, z1, color) {
  const inside = [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2];
  const q = (pts) => out.push({ pts, color, alpha: 1, inside });
  q([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]]);
  q([[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]]);
  q([[x1, y1, z0], [x0, y1, z0], [x0, y1, z1], [x1, y1, z1]]);
  q([[x0, y1, z0], [x0, y0, z0], [x0, y0, z1], [x0, y1, z1]]);
  q([[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]]);
}

/** A wheel: a 14-sided prism whose axis runs along x, from x0 to x1. */
function wheel(out, x0, x1, yc, zc, r, color, n = 14) {
  const ring = (x) => Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2;
    return [x, yc + Math.sin(a) * r, zc + Math.cos(a) * r];
  });
  const inside = [(x0 + x1) / 2, yc, zc];
  const a = ring(x0), b = ring(x1);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    out.push({ pts: [a[i], b[i], b[j], a[j]], color, alpha: 1, inside });
  }
  out.push({ pts: [...a].reverse(), color, alpha: 1, inside }, { pts: b, color, alpha: 1, inside });
}

/** Avant 630 articulated loader: lowered telescopic boom, quick-attach plate, canopy. */
function avant630(w, l, { color }) {
  const out = [];
  const paint = color || '#3fa21f';
  const sx = w / 1.29, sy = l / 2.548; // the drawing is 1.29 x 2.548 m
  const X = (v) => v * sx, Y = (v) => v * sy;
  const cx = X(0.645);
  const dark = '#2b2d31', grey = '#4a5058', hose = '#1d1e21';
  const tw = Math.min(0.32, w * 0.25), r = 0.32, zc = r; // tyre width, radius; 10.3 in ground clearance at the frame

  // four tyres with rims: front axle 16.9 in behind the plate, 47.2 in wheelbase
  for (const yc of [Y(0.429), Y(1.628)]) {
    for (const [x0, x1, rim] of [[0, tw, [0, 0.02]], [w - tw, w, [-0.02, 0]]]) {
      wheel(out, x0, x1, yc, zc, r, '#1b1c1e');
      wheel(out, x0 + rim[0] - 0.005, x1 + rim[1] + 0.005, yc, zc, r * 0.52, '#aeb4ba', 10);
    }
  }

  // rear frame + engine hood + counterweight bumper
  const bx0 = X(0.31), bx1 = w - X(0.31);
  box(out, bx0, Y(1.0), 0.28, bx1, Y(2.548) - 0.1, 0.78, tone(paint, 0.95));
  box(out, bx0 + 0.04, Y(1.6), 0.78, bx1 - 0.04, Y(2.548) - 0.14, 1.0, paint); // hood
  box(out, bx0, Y(2.548) - 0.1, 0.3, bx1, Y(2.548), 0.62, dark);
  // front frame
  box(out, bx0, Y(0.14), 0.28, bx1, Y(1.0), 0.72, tone(paint, 0.95));
  // articulation joint
  box(out, cx - 0.09, Y(0.97), 0.3, cx + 0.09, Y(1.05), 0.74, dark);

  // seat, backrest and steering wheel under the canopy
  box(out, cx - X(0.19), Y(1.28), 0.78, cx + X(0.19), Y(1.56), 0.88, grey);
  box(out, cx - X(0.19), Y(1.52), 0.88, cx + X(0.19), Y(1.58), 1.3, grey);
  box(out, cx - X(0.07), Y(1.05), 0.78, cx + X(0.07), Y(1.14), 1.2, dark);

  // telescopic boom, lowered along the front frame, narrowing toward the plate
  box(out, cx - 0.1, Y(0.62), 0.74, cx + 0.1, Y(1.0), 0.97, tone(paint, 1.15));
  box(out, cx - 0.075, Y(0.34), 0.77, cx + 0.075, Y(0.62), 0.94, tone(paint, 1.3));
  box(out, cx - 0.06, Y(0.1), 0.79, cx + 0.06, Y(0.34), 0.91, dark);
  for (const s of [-1, 1]) box(out, cx + s * 0.115 - 0.012, Y(0.2), 0.84, cx + s * 0.115 + 0.012, Y(0.95), 0.87, hose);
  // quick-attach plate with its two hooks
  box(out, cx - 0.27, 0, 0.42, cx + 0.27, 0.06, 0.92, dark);
  for (const s of [-1, 1]) box(out, cx + s * 0.17 - 0.03, 0.01, 0.8, cx + s * 0.17 + 0.03, 0.09, 0.94, '#d9a21b');

  // canopy (ROPS): four posts and a roof, 81.5 in overall height
  const cw = w * 0.6, cy0 = Y(0.95), cy1 = Y(1.73), top = 2.07;
  for (const x of [cx - cw / 2, cx + cw / 2 - 0.05]) for (const y of [cy0, cy1 - 0.05]) box(out, x, y, 0.8, x + 0.05, y + 0.05, top - 0.04, hose);
  box(out, cx - cw / 2 - 0.03, cy0 - 0.03, top - 0.04, cx + cw / 2 + 0.03, cy1 + 0.03, top, grey);
  // work lights on the roof's front edge
  for (const s of [-1, 1]) box(out, cx + s * (cw / 2 - 0.06) - 0.03, cy0 - 0.06, top - 0.09, cx + s * (cw / 2 - 0.06) + 0.03, cy0 - 0.03, top - 0.03, '#f4f1c8');

  return out;
}

/** A vertical cylinder from z0 to z1 (the bottom is dropped). */
function cyl(out, xc, yc, z0, z1, r, color, n = 16) {
  const ring = (z) => Array.from({ length: n }, (_, i) => [xc + Math.cos((i / n) * Math.PI * 2) * r, yc + Math.sin((i / n) * Math.PI * 2) * r, z]);
  const a = ring(z0), b = ring(z1), inside = [xc, yc, (z0 + z1) / 2];
  for (let i = 0; i < n; i++) out.push({ pts: [a[i], a[(i + 1) % n], b[(i + 1) % n], b[i]], color, alpha: 1, inside });
  out.push({ pts: b, color, alpha: 1, inside });
}

const GLASS = '#1c2530', DARK = '#2b2d31', TYRE = '#17181a', STEEL = '#8a8f96';
/** Wheel pair (left + right) at axle position y. */
const axle = (o, w, y, r, tw, zc = r) => { for (const x of [0, w - tw]) wheel(o, x, x + tw, y, zc, r, TYRE, 12); };

function car(w, l, { color }) {
  const o = [], p = color || '#9aa3ad';
  for (const y of [l * 0.2, l * 0.8]) axle(o, w, y, 0.32, 0.22);
  box(o, w * 0.05, 0, 0.28, w * 0.95, l, 0.78, p);
  box(o, w * 0.1, l * 0.32, 0.78, w * 0.9, l * 0.72, 1.38, GLASS);
  box(o, w * 0.12, l * 0.36, 1.38, w * 0.88, l * 0.68, 1.44, p);
  return o;
}

function pickup(w, l, { color }) {
  const o = [], p = color || '#6f7e8c', by = l * 0.56;
  for (const y of [l * 0.2, l * 0.78]) axle(o, w, y, 0.37, 0.26);
  box(o, w * 0.04, 0, 0.35, w * 0.96, l, 0.9, p);
  box(o, w * 0.08, l * 0.22, 0.9, w * 0.92, l * 0.52, 1.7, GLASS);
  box(o, w * 0.1, l * 0.25, 1.7, w * 0.9, l * 0.49, 1.76, p);
  box(o, w * 0.04, by, 0.9, w * 0.04 + 0.08, l, 1.22, p); box(o, w * 0.96 - 0.08, by, 0.9, w * 0.96, l, 1.22, p);
  box(o, w * 0.04, l - 0.08, 0.9, w * 0.96, l, 1.22, p); box(o, w * 0.04, by, 0.9, w * 0.96, by + 0.08, 1.22, p);
  return o;
}

function boxTruck(w, l, { color }) {
  const o = [], cab = color || '#e9e9e4';
  axle(o, w, 1.5, 0.5, 0.3); axle(o, w, l - 1.4, 0.5, 0.3); axle(o, w, l - 2.6, 0.5, 0.3);
  box(o, w * 0.12, 0.2, 0.5, w * 0.88, l - 0.1, 0.95, DARK);
  box(o, w * 0.02, 0, 0.9, w * 0.98, 2.3, 2.45, cab);
  box(o, w * 0.08, -0.015, 1.5, w * 0.92, 0.03, 2.3, GLASS);
  box(o, w * 0.02, 2.4, 0.95, w * 0.98, l, 3.7, '#f2f2f2');
  return o;
}

function tractorCab(o, w, cab) {
  box(o, w * 0.04, 0, 0.95, w * 0.96, 1.8, 1.7, cab); // hood
  box(o, w * 0.02, 1.8, 0.95, w * 0.98, 3.1, 3.0, cab); // cab + sleeper
  box(o, w * 0.08, 1.77, 1.75, w * 0.92, 1.81, 2.8, GLASS);
  box(o, w * 0.08, 0.15, 1.7, w * 0.16, 0.45, 2.9, STEEL); box(o, w * 0.84, 0.15, 1.7, w * 0.92, 0.45, 2.9, STEEL); // stacks
}
function semi(w, l, { color }) {
  const o = [];
  for (const y of [1.0, 3.6, 4.8, l - 3.2, l - 1.9]) axle(o, w, y, 0.5, 0.3);
  box(o, w * 0.15, 0.3, 0.6, w * 0.85, l - 0.5, 1.1, DARK);
  tractorCab(o, w, color || '#c4452c');
  box(o, w * 0.01, 4.2, 1.25, w * 0.99, l, 4.0, '#f2f2f2');
  return o;
}

function trailer(w, l, { color }) {
  const o = [];
  axle(o, w, l - 3.2, 0.5, 0.3); axle(o, w, l - 1.9, 0.5, 0.3);
  box(o, w * 0.1, 0.1, 0.9, w * 0.9, l, 1.25, DARK);
  for (const x of [w * 0.2, w * 0.8 - 0.1]) box(o, x, 2.0, 0, x + 0.1, 2.1, 0.9, DARK); // landing gear
  box(o, w * 0.01, 0, 1.25, w * 0.99, l, 4.0, color || '#f2f2f2');
  return o;
}

function container(paint) {
  return (w, l, { color }) => {
    const o = [], c = color || paint, rib = tone(c, 0.82);
    box(o, 0, 0, 0, w, l, 2.59, c);
    for (let y = 0.2; y < l - 0.25; y += 0.25) { box(o, -0.02, y, 0.12, 0, y + 0.1, 2.47, rib); box(o, w, y, 0.12, w + 0.02, y + 0.1, 2.47, rib); }
    for (const x of [0.25, 0.5, 0.75].map((f) => w * f)) box(o, x - 0.02, l, 0.12, x + 0.02, l + 0.03, 2.47, DARK); // door bars
    return o;
  };
}

function forklift(w, l, { color }) {
  const o = [], p = color || '#e8b416';
  axle(o, w, 0.95, 0.35, 0.22); axle(o, w, l - 0.8, 0.28, 0.2);
  box(o, w * 0.1, 1.2, 0.3, w * 0.9, l, 1.0, p);
  box(o, w * 0.08, l - 0.72, 0.3, w * 0.92, l + 0.02, 1.1, DARK); // counterweight
  for (const x of [w * 0.22, w * 0.78 - 0.06]) box(o, x, 0.95, 0.1, x + 0.06, 1.05, 2.1, DARK); // mast
  box(o, w * 0.22, 0.95, 1.3, w * 0.78, 1.05, 1.36, DARK);
  for (const x of [w * 0.2, w * 0.8 - 0.1]) box(o, x, 0, 0.04, x + 0.1, 0.95, 0.09, STEEL); // forks
  box(o, w * 0.35, 1.8, 1.0, w * 0.65, 2.1, 1.1, DARK);
  for (const x of [w * 0.12, w * 0.88 - 0.04]) for (const y of [1.35, 2.6]) box(o, x, y, 1.0, x + 0.04, y + 0.04, 2.05, DARK);
  box(o, w * 0.1, 1.33, 2.05, w * 0.9, 2.64, 2.09, DARK);
  return o;
}

function boomLift(w, l, { color }) {
  const o = [], p = color || '#e07b1a';
  axle(o, w, 1.4, 0.55, 0.5); axle(o, w, l - 1.4, 0.55, 0.5);
  box(o, w * 0.1, 0.4, 0.4, w * 0.9, l - 0.3, 1.0, DARK);
  box(o, w * 0.15, l * 0.55, 1.0, w * 0.85, l * 0.95, 1.75, p);
  box(o, w * 0.4, 1.9, 1.45, w * 0.6, l * 0.72, 1.9, tone(p, 1.1));
  box(o, w * 0.15, 0.1, 1.45, w * 0.85, 1.7, 1.55, STEEL); // basket floor
  box(o, w * 0.15, 0.1, 1.55, w * 0.85, 0.16, 2.5, STEEL); box(o, w * 0.15, 1.64, 1.55, w * 0.85, 1.7, 2.5, STEEL);
  box(o, w * 0.15, 0.16, 1.55, w * 0.15 + 0.06, 1.64, 2.5, STEEL); box(o, w * 0.85 - 0.06, 0.16, 1.55, w * 0.85, 1.64, 2.5, STEEL);
  return o;
}

function dumpster(w, l, { color }) {
  const o = [], p = color || '#2f5d3c';
  box(o, 0.1, 0, 0.25, w - 0.1, l, 0.3, '#3e3a34');
  box(o, 0, 0, 0.25, 0.1, l, 1.8, p); box(o, w - 0.1, 0, 0.25, w, l, 1.8, p);
  box(o, 0.1, l - 0.1, 0.25, w - 0.1, l, 1.8, p); box(o, 0.1, 0, 0.25, w - 0.1, 0.1, 1.1, p);
  for (const x of [0.15, w - 0.3]) box(o, x, 0, 0, x + 0.15, l, 0.25, DARK); // skids
  return o;
}

function generator(w, l, { color }) {
  const o = [];
  axle(o, w, l * 0.6, 0.35, 0.2);
  box(o, w * 0.1, 1.3, 0.5, w * 0.9, l - 0.1, 0.7, DARK);
  box(o, w * 0.08, 1.3, 0.7, w * 0.92, l - 0.15, 2.0, color || '#d9d4c7');
  box(o, w / 2 - 0.05, 0, 0.55, w / 2 + 0.05, 1.3, 0.65, DARK);
  box(o, w * 0.7, l - 0.9, 2.0, w * 0.8, l - 0.7, 2.35, DARK); // exhaust
  return o;
}

function toilet(w, l, { color }) {
  const o = [];
  box(o, 0.02, 0.02, 0, w - 0.02, l - 0.02, 2.3, color || '#2f6fb3');
  box(o, 0, 0, 2.3, w, l, 2.38, '#eeeeee');
  box(o, w * 0.2, -0.01, 0.1, w * 0.8, 0.02, 2.0, DARK);
  return o;
}

function banquet(w, l, { color }) {
  const o = [];
  box(o, 0, 0, 0.7, w, l, 0.74, color || '#f4f4f0');
  for (const x of [w * 0.12, w * 0.88]) for (const y of [l * 0.1, l * 0.9]) box(o, x - 0.02, y - 0.02, 0, x + 0.02, y + 0.02, 0.7, DARK);
  return o;
}

function roundTable(w, l, { color }) {
  const o = [], cx = w / 2, cy = l / 2, r = w * 0.25;
  cyl(o, cx, cy, 0, 0.75, r, color || '#f4f4f0', 24);
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    cyl(o, cx + Math.cos(a) * w * 0.4, cy + Math.sin(a) * w * 0.4, 0, 0.46, 0.21, '#4a4f57', 8);
  }
  return o;
}

function person(w, l) {
  const o = [];
  cyl(o, w / 2, l / 2, 0, 1.45, 0.2, '#3d6fa8', 12);
  cyl(o, w / 2, l / 2, 1.48, 1.78, 0.11, '#e0b48e', 10);
  return o;
}

function stage(w, l, { color }) {
  const o = [];
  box(o, 0, 0, 0, w, l, 1.15, '#3a3f47');
  box(o, -0.02, -0.02, 1.15, w + 0.02, l + 0.02, 1.22, color || '#7b5ea7');
  return o;
}

function danceFloor(w, l, { color }) {
  const o = [];
  box(o, 0, 0, 0, w, l, 0.12, color || '#c9a46a');
  return o;
}

const MODELS = {
  'avant-630': avant630, car, pickup, 'box-truck-26': boxTruck, 'semi-53': semi, 'trailer-53': trailer,
  'container-20': container('#a6452c'), 'container-40': container('#2e6a96'),
  forklift, 'boom-lift': boomLift, 'dumpster-30yd': dumpster, 'generator-towable': generator,
  'portable-toilet': toilet, 'banquet-table-8': banquet, 'round-table-60': roundTable, person,
  'stage-16x24': stage, 'dance-floor-20x20': danceFloor,
};

/** True when a catalog template has a 3D model. */
export const has3d = (templateId) => Boolean(MODELS[templateId]);

/** Shaded polygons for a catalog vehicle, or null when it has no 3D model. */
export function vehicleMesh(templateId, w, l, opts = {}) {
  const build = MODELS[templateId];
  if (!build) return null;
  const faces = build(w, l, opts);
  for (const f of faces) { f.shade = lightness(outward(f.pts, f.inside)); delete f.inside; }
  return faces;
}
