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

const MODELS = { 'avant-630': avant630 };

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
