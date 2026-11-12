/*
 * Top-down "model skins" for the built-in catalog, drawn procedurally on a
 * canvas (no image assets, no licensing). Every skin is drawn in real metres,
 * so details are to scale: tent bays, court lines, parking stripes, chairs.
 *
 * Canvas x = the object's width (across), y = its length; the top edge is the
 * object's front (the rotation bearing), matching the uploaded-object images.
 */
import { FT, resolveTent, roofFaces, wallBays, legs, outward, lightness, SIDES } from './tentspec.js';

const MAX_PX = 1024;
const MAX_PPM = 128;

/* ---------------------------------------------------------------- helpers */
function rgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function shade(hex, f) {
  const c = rgb(hex).map((v) => (f >= 1 ? v + (255 - v) * (f - 1) : v * f));
  return `rgb(${c.map((v) => Math.round(Math.max(0, Math.min(255, v)))).join(',')})`;
}
function rr(g, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}
function poly(g, pts, fill, stroke, lw) {
  g.beginPath();
  pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
  g.closePath();
  if (fill) { g.fillStyle = fill; g.fill(); }
  if (stroke) { g.strokeStyle = stroke; g.lineWidth = lw; g.stroke(); }
}
function line(g, x1, y1, x2, y2) { g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke(); }
function circle(g, x, y, r) { g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); }
function hGrad(g, x0, x1, stops) {
  const gr = g.createLinearGradient(x0, 0, x1, 0);
  stops.forEach(([o, c]) => gr.addColorStop(o, c));
  return gr;
}
function vGrad(g, y0, y1, stops) {
  const gr = g.createLinearGradient(0, y0, 0, y1);
  stops.forEach(([o, c]) => gr.addColorStop(o, c));
  return gr;
}
/** Seeded value noise over the opaque pixels (grass, asphalt, wood grain). */
function noise(g, amt, seed = 7) {
  const { width, height } = g.canvas;
  const img = g.getImageData(0, 0, width, height);
  const d = img.data;
  let s = seed >>> 0;
  for (let i = 0; i < d.length; i += 4) {
    if (!d[i + 3]) continue;
    s = (s * 1664525 + 1013904223) >>> 0;
    const n = ((s >>> 24) / 255 - 0.5) * amt;
    d[i] += n; d[i + 1] += n; d[i + 2] += n;
  }
  g.putImageData(img, 0, 0);
}

/* ---------------------------------------------------------------- tents
 * Roof style, bay spacing and sidewalls come from the tent spec (tentspec.js),
 * the same one the 3D builder and map layer use, so plan and 3D always agree.
 */
const WALL_COLOR = { solid: '#e9e9e4', window: '#9fb8c8', clear: '#cfe4f2' };

function tent(g, w, l, { color, tent: t, floor }) {
  const spec = resolveTent(w, l, t);
  const roof = color || '#f6f6f3';
  const lw = Math.max(0.03, w / 300);
  if (floor) {
    // 3D view: the roof is drawn by the 3D layer, the plan only shows the floor and walls
    g.fillStyle = 'rgba(40,44,50,.28)'; g.fillRect(0, 0, w, l);
  } else if (spec.roof !== 'gable') {
    const faces = roofFaces(w, l, spec);
    for (const f of faces) poly(g, f.pts.map(([x, y]) => [x, y]), shade(roof, lightness(outward(f.pts, [w / 2, l / 2, 0])) * 1.1));
    g.strokeStyle = shade(roof, 0.7); g.lineWidth = lw * 1.4;
    // hips (corner to ridge) and the ridge itself
    const ridge = [...new Set(faces.flatMap((f) => f.pts.filter((q) => q[2] > spec.eave).map((q) => `${q[0]},${q[1]}`)))].map((k) => k.split(',').map(Number));
    const near = (x, y) => ridge.reduce((b, q) => (Math.hypot(q[0] - x, q[1] - y) < Math.hypot(b[0] - x, b[1] - y) ? q : b), ridge[0]);
    for (const [x, y] of [[0, 0], [w, 0], [w, l], [0, l]]) line(g, x, y, ...near(x, y));
    if (ridge.length > 1) line(g, ...ridge[0], ...ridge[1]);
    // frame bays across the roof
    g.lineWidth = lw * 0.8; g.strokeStyle = shade(roof, 0.78);
    const { long } = wallBays(w, l, spec);
    for (const y of long.slice(1, -1)) line(g, 0, y, w, y);
  } else {
    // gable clearspan / frame tent: ridge down the length, beams at each bay
    g.fillStyle = hGrad(g, 0, w / 2, [[0, shade(roof, 0.8)], [1, shade(roof, 1)]]);
    g.fillRect(0, 0, w / 2, l);
    g.fillStyle = hGrad(g, w / 2, w, [[0, shade(roof, 0.88)], [1, shade(roof, 0.68)]]);
    g.fillRect(w / 2, 0, w / 2, l);
    const { long } = wallBays(w, l, spec);
    g.strokeStyle = shade(roof, 0.62); g.lineWidth = lw * 1.8;
    for (const y of long.slice(1, -1)) line(g, 0, y, w, y);
    // vinyl panel welds between beams
    g.strokeStyle = shade(roof, 0.88); g.lineWidth = lw * 0.6;
    for (let i = 0; i < long.length - 1; i++) { const y = (long[i] + long[i + 1]) / 2; line(g, 0, y, w, y); }
    g.strokeStyle = shade(roof, 0.55); g.lineWidth = lw * 3;
    line(g, w / 2, 0, w / 2, l);
    // gable ends
    g.fillStyle = shade(roof, 0.82);
    g.fillRect(0, 0, w, lw * 3); g.fillRect(0, l - lw * 3, w, lw * 3);
  }
  // perimeter
  g.strokeStyle = shade(roof, 0.45); g.lineWidth = lw * 2.5;
  g.strokeRect(lw, lw, w - 2 * lw, l - 2 * lw);
  // sidewalls: a band along each walled side
  const band = Math.max(0.3, w / 60);
  const rect = { front: [0, 0, w, band], back: [0, l - band, w, band], left: [0, 0, band, l], right: [w - band, 0, band, l] };
  for (const s of SIDES) {
    const kind = spec.walls[s];
    if (kind === 'none') continue;
    g.fillStyle = WALL_COLOR[kind];
    g.fillRect(...rect[s]);
    g.strokeStyle = 'rgba(0,0,0,.35)'; g.lineWidth = lw * 0.6;
    g.strokeRect(...rect[s]);
  }
  // legs and base plates
  const leg = Math.max(0.12, lw * 4);
  g.fillStyle = '#4b5058';
  for (const p of legs(w, l, spec)) {
    g.fillRect(Math.min(w - leg, Math.max(0, p.x - leg / 2)), Math.min(l - leg, Math.max(0, p.y - leg / 2)), leg, leg);
  }
}

/* ------------------------------------------------------------- ballast
 * Each tent leg sits on one steel ballast plate carrying two concrete blocks
 * side by side along the wall line. Plates lie outside the wall (the leg
 * baseplate is bolted to the plate's inner end), so the skin is drawn on a
 * canvas padded by BALLAST_PAD on every side. Sizes are real: 2.5 ft blocks on
 * a plate 0.6 ft inside and 3.6 ft outside the wall line, galvanized with
 * angle-iron curbs, end stops and D-ring tie-downs.
 */
const BALLAST_PAD = 3.8 * FT;

/** Padding (m) added around a skin when ballast is shown, 0 for objects without legs. */
export const ballastPad = (templateId) => (templateId?.startsWith('tent-') ? BALLAST_PAD : 0);

function ballastUnit(g, step) {
  const inner = 0.6 * FT, outer = 3.6 * FT, margin = 0.25 * FT, gap = 0.1 * FT;
  const plateLen = Math.min(5.6 * FT, step - 0.4 * FT);
  const blockL = (plateLen - 2 * margin - gap) / 2;
  const blockW = 2.5 * FT, blockX = 0.85 * FT;
  const hl = plateLen / 2, curb = 0.05 * FT * 1.6;
  // local frame: +x runs outward from the wall line, y runs along it
  g.fillStyle = 'rgba(0,0,0,.28)';
  g.fillRect(-inner + 0.05, -hl + 0.06, inner + outer, plateLen);
  g.fillStyle = '#bcc5cb';
  g.fillRect(-inner, -hl, inner + outer, plateLen);
  // cross channels showing through the deck
  g.fillStyle = 'rgba(70,80,88,.22)';
  for (let i = 0; i < 3; i++) g.fillRect(-inner, -hl + 0.12 + i * (plateLen - 0.36) / 2, inner + outer, 0.07);
  // angle-iron curbs on the long edges, end stops across the ends
  g.fillStyle = '#e4e9ec';
  g.fillRect(-inner, -hl, curb, plateLen); g.fillRect(outer - curb, -hl, curb, plateLen);
  g.fillRect(-inner, -hl, inner + outer, curb * 0.7); g.fillRect(-inner, hl - curb * 0.7, inner + outer, curb * 0.7);
  g.strokeStyle = '#6d777e'; g.lineWidth = 0.012;
  g.strokeRect(-inner, -hl, inner + outer, plateLen);
  // two concrete blocks side by side
  for (const k of [-1, 1]) {
    const by = k * (blockL / 2 + gap / 2) - blockL / 2;
    g.fillStyle = vGrad(g, by, by + blockL, [[0, '#bab6ac'], [1, '#9d998f']]);
    g.fillRect(blockX, by, blockW, blockL);
    g.strokeStyle = '#6f6c66'; g.lineWidth = 0.014;
    g.strokeRect(blockX, by, blockW, blockL);
    g.strokeStyle = 'rgba(255,255,255,.35)'; g.lineWidth = 0.01;
    line(g, blockX + 0.02, by + 0.02, blockX + blockW - 0.02, by + 0.02);
    g.fillStyle = '#34363a';
    circle(g, blockX + blockW / 2, by + blockL / 2, 0.22 * FT); g.fill();
  }
  // welded D-rings at both ends of the plate
  g.strokeStyle = '#d3d9dd'; g.lineWidth = 0.028; g.lineCap = 'round';
  for (const e of [-1, 1]) for (const rx of [0.6, 2.6]) {
    g.beginPath(); g.arc(rx * FT, e * hl, 0.14 * FT, e > 0 ? 0 : Math.PI, e > 0 ? Math.PI : Math.PI * 2);
    g.stroke();
  }
  g.lineCap = 'butt';
}

/** Ballast at every leg of a tent footprint (0..w by 0..l), at the legs the tent spec puts down. */
function tentBallast(g, w, l, t) {
  for (const p of legs(w, l, resolveTent(w, l, t))) {
    g.save(); g.translate(p.x, p.y); g.rotate(Math.atan2(p.ny, p.nx)); ballastUnit(g, p.step); g.restore();
  }
}

function stage(g, w, l, { color }) {
  const deck = color || '#2f3034';
  g.fillStyle = deck; g.fillRect(0, 0, w, l);
  noise(g, 10, 3);
  g.strokeStyle = shade(deck, 0.6); g.lineWidth = 0.025;
  for (let x = 4 * FT; x < w - 0.01; x += 4 * FT) line(g, x, 0, x, l);
  for (let y = 8 * FT; y < l - 0.01; y += 8 * FT) line(g, 0, y, w, y);
  g.fillStyle = shade(deck, 1.5); g.fillRect(0, 0, w, 0.08); // lit front edge
  g.strokeStyle = shade(deck, 0.45); g.lineWidth = 0.08; g.strokeRect(0.04, 0.04, w - 0.08, l - 0.08);
  // steps at the back corner
  g.fillStyle = shade(deck, 1.25);
  for (let i = 0; i < 3; i++) g.fillRect(w - 1.3, l - 0.3 * (i + 1), 1.2, 0.02);
}

function danceFloor(g, w, l, { color }) {
  const a = color || '#c8955a', b = shade(a, 0.62);
  const c = 3 * FT;
  for (let y = 0, j = 0; y < l; y += c, j++) {
    for (let x = 0, i = 0; x < w; x += c, i++) {
      g.fillStyle = (i + j) % 2 ? b : a; g.fillRect(x, y, c, c);
    }
  }
  noise(g, 14, 5);
  g.strokeStyle = '#c7c9cc'; g.lineWidth = 0.1; g.strokeRect(0.05, 0.05, w - 0.1, l - 0.1);
}

/* ---------------------------------------------------------------- vehicles */
function tires(g, w, l, ys, tw = 0.24, tl = 0.68) {
  g.fillStyle = '#17181a';
  for (const y of ys) { rr(g, 0, y - tl / 2, tw, tl, 0.06); g.fill(); rr(g, w - tw, y - tl / 2, tw, tl, 0.06); g.fill(); }
}
function glass(g, pts) { poly(g, pts, '#1c2530'); g.save(); g.clip(); g.fillStyle = 'rgba(160,190,220,.18)'; g.fill(); g.restore(); }

function car(g, w, l, { color }) {
  const paint = color || '#9aa3ad';
  const ins = w * 0.05;
  tires(g, w, l, [l * 0.18, l * 0.8], w * 0.1, l * 0.14);
  const bw = w - 2 * ins;
  rr(g, ins, 0, bw, l, w * 0.26);
  g.fillStyle = hGrad(g, ins, w - ins, [[0, shade(paint, 0.7)], [0.5, shade(paint, 1.12)], [1, shade(paint, 0.7)]]);
  g.fill();
  const x0 = ins + bw * 0.1, x1 = w - ins - bw * 0.1;
  glass(g, [[x0, l * 0.36], [x1, l * 0.36], [x1 - bw * 0.04, l * 0.27], [x0 + bw * 0.04, l * 0.27]]);
  rr(g, x0, l * 0.36, x1 - x0, l * 0.36, bw * 0.08); g.fillStyle = shade(paint, 0.95); g.fill();
  glass(g, [[x0, l * 0.72], [x1, l * 0.72], [x1 - bw * 0.05, l * 0.8], [x0 + bw * 0.05, l * 0.8]]);
  // side windows
  g.fillStyle = '#1c2530';
  g.fillRect(x0 - bw * 0.035, l * 0.37, bw * 0.03, l * 0.34); g.fillRect(x1 + bw * 0.005, l * 0.37, bw * 0.03, l * 0.34);
  // hood crease, lights, mirrors
  g.strokeStyle = shade(paint, 0.75); g.lineWidth = 0.02;
  line(g, w * 0.35, l * 0.04, w * 0.38, l * 0.25); line(g, w * 0.65, l * 0.04, w * 0.62, l * 0.25);
  g.fillStyle = '#fff6d0'; rr(g, ins + bw * 0.06, 0.03, bw * 0.2, 0.09, 0.04); g.fill(); rr(g, w - ins - bw * 0.26, 0.03, bw * 0.2, 0.09, 0.04); g.fill();
  g.fillStyle = '#b3141c'; rr(g, ins + bw * 0.06, l - 0.1, bw * 0.22, 0.07, 0.03); g.fill(); rr(g, w - ins - bw * 0.28, l - 0.1, bw * 0.22, 0.07, 0.03); g.fill();
  g.fillStyle = shade(paint, 0.8);
  rr(g, 0, l * 0.3, ins + 0.04, 0.12, 0.04); g.fill(); rr(g, w - ins - 0.04, l * 0.3, ins + 0.04, 0.12, 0.04); g.fill();
}

function pickup(g, w, l, { color }) {
  const paint = color || '#7d2f2f';
  const ins = w * 0.05, bw = w - 2 * ins;
  tires(g, w, l, [l * 0.16, l * 0.8], w * 0.1, l * 0.13);
  rr(g, ins, 0, bw, l, w * 0.14);
  g.fillStyle = hGrad(g, ins, w - ins, [[0, shade(paint, 0.7)], [0.5, shade(paint, 1.12)], [1, shade(paint, 0.7)]]); g.fill();
  const x0 = ins + bw * 0.08, x1 = w - ins - bw * 0.08;
  glass(g, [[x0, l * 0.33], [x1, l * 0.33], [x1 - bw * 0.03, l * 0.25], [x0 + bw * 0.03, l * 0.25]]);
  rr(g, x0, l * 0.33, x1 - x0, l * 0.2, bw * 0.05); g.fillStyle = shade(paint, 0.95); g.fill();
  g.fillStyle = '#1c2530'; g.fillRect(x0, l * 0.53, x1 - x0, l * 0.025);
  // bed
  const by = l * 0.58;
  g.fillStyle = '#25262a'; g.fillRect(x0 - bw * 0.03, by, x1 - x0 + bw * 0.06, l * 0.4);
  g.strokeStyle = '#3a3c41'; g.lineWidth = 0.05;
  for (let x = x0 + 0.15; x < x1; x += 0.22) line(g, x, by + 0.05, x, l * 0.96);
  g.fillStyle = shade(paint, 0.8); g.fillRect(x0 - bw * 0.03, l * 0.97, x1 - x0 + bw * 0.06, l * 0.02);
  g.fillStyle = '#fff6d0'; g.fillRect(ins + bw * 0.05, 0.03, bw * 0.2, 0.08); g.fillRect(w - ins - bw * 0.25, 0.03, bw * 0.2, 0.08);
  g.fillStyle = shade(paint, 0.8);
  rr(g, 0, l * 0.27, ins + 0.04, 0.14, 0.04); g.fill(); rr(g, w - ins - 0.04, l * 0.27, ins + 0.04, 0.14, 0.04); g.fill();
}

function cab(g, x, y, cw, cl, paint) {
  rr(g, x, y, cw, cl, cw * 0.12);
  g.fillStyle = hGrad(g, x, x + cw, [[0, shade(paint, 0.72)], [0.5, shade(paint, 1.1)], [1, shade(paint, 0.72)]]); g.fill();
  glass(g, [[x + cw * 0.08, y + cl * 0.42], [x + cw * 0.92, y + cl * 0.42], [x + cw * 0.88, y + cl * 0.3], [x + cw * 0.12, y + cl * 0.3]]);
  g.fillStyle = shade(paint, 0.93); rr(g, x + cw * 0.08, y + cl * 0.45, cw * 0.84, cl * 0.5, cw * 0.06); g.fill();
  g.fillStyle = '#fff6d0'; g.fillRect(x + cw * 0.05, y + 0.03, cw * 0.15, 0.08); g.fillRect(x + cw * 0.8, y + 0.03, cw * 0.15, 0.08);
  g.fillStyle = '#222'; g.fillRect(x - 0.12, y + cl * 0.35, 0.14, 0.3); g.fillRect(x + cw - 0.02, y + cl * 0.35, 0.14, 0.3);
}
function vanBox(g, x, y, bw, bl, color, ribEvery = 0.6) {
  g.fillStyle = hGrad(g, x, x + bw, [[0, shade(color, 0.82)], [0.5, shade(color, 1.0)], [1, shade(color, 0.82)]]);
  g.fillRect(x, y, bw, bl);
  g.strokeStyle = shade(color, 0.86); g.lineWidth = 0.03;
  for (let yy = y + ribEvery; yy < y + bl - 0.05; yy += ribEvery) line(g, x, yy, x + bw, yy);
  g.strokeStyle = shade(color, 0.6); g.lineWidth = 0.06; g.strokeRect(x + 0.03, y + 0.03, bw - 0.06, bl - 0.06);
}

function boxTruck(g, w, l, { color }) {
  const paint = color || '#e9eaec';
  const cl = 2.3, cw = w * 0.88;
  tires(g, w, l, [1.2, l - 2.3, l - 1.2], 0.25, 0.9);
  cab(g, (w - cw) / 2, 0, cw, cl + 0.3, paint);
  vanBox(g, 0.02, cl + 0.15, w - 0.04, l - cl - 0.15, '#f3f3f1', 0.61);
}

function semi(g, w, l, { color }) {
  const paint = color || '#1f4e8c';
  const tl = l - 53 * FT;
  tires(g, w, l, [1.3, tl - 0.6, tl + 0.6, l - 2.6, l - 1.5], 0.3, 1.0);
  const cw = w * 0.86;
  cab(g, (w - cw) / 2, 0, cw, Math.min(3.4, tl * 0.5), paint);
  g.fillStyle = shade(paint, 0.85); rr(g, (w - cw) / 2, 3.3, cw, Math.max(0.3, tl * 0.25), 0.1); g.fill(); // sleeper
  g.fillStyle = '#2b2d31'; g.fillRect(w * 0.18, 3.3 + tl * 0.25, w * 0.64, tl - 3.3 - tl * 0.25 + 1); // frame + fifth wheel
  g.fillStyle = '#5c5f66'; circle(g, w / 2, tl - 0.3, 0.45); g.fill();
  g.fillStyle = '#9aa0a8'; g.fillRect(w * 0.1, 3.0, 0.1, 0.7); g.fillRect(w * 0.9 - 0.1, 3.0, 0.1, 0.7); // stacks
  trailerBody(g, w, l, tl - 1.0, l);
}
function trailerBody(g, w, l, y0, y1) {
  vanBox(g, 0.02, y0, w - 0.04, y1 - y0, '#f0f0ee', 0.61);
  g.fillStyle = '#c9cbce'; g.fillRect(0.02, y0, w - 0.04, 0.12);
  g.fillStyle = '#b3141c'; g.fillRect(0.1, y1 - 0.08, 0.25, 0.06); g.fillRect(w - 0.35, y1 - 0.08, 0.25, 0.06);
}
function trailer(g, w, l) {
  tires(g, w, l, [l - 2.6, l - 1.5], 0.3, 1.0);
  trailerBody(g, w, l, 0, l);
}

function container(g, w, l, { color }, def) {
  const c = color || def;
  g.fillStyle = c; g.fillRect(0, 0, w, l);
  const step = 0.28;
  for (let y = 0.3, i = 0; y < l - 0.3; y += step, i++) {
    g.fillStyle = i % 2 ? shade(c, 0.86) : shade(c, 1.08); g.fillRect(0.12, y, w - 0.24, step);
  }
  noise(g, 10, 9);
  g.strokeStyle = shade(c, 0.6); g.lineWidth = 0.1; g.strokeRect(0.05, 0.05, w - 0.1, l - 0.1);
  g.fillStyle = '#6b6e73';
  for (const [x, y] of [[0, 0], [w - 0.3, 0], [0, l - 0.3], [w - 0.3, l - 0.3]]) g.fillRect(x, y, 0.3, 0.3);
  g.fillStyle = '#2b2d31';
  for (const [x, y] of [[0.08, 0.1], [w - 0.2, 0.1], [0.08, l - 0.2], [w - 0.2, l - 0.2]]) g.fillRect(x, y, 0.12, 0.1);
}

function forklift(g, w, l, { color }) {
  const paint = color || '#e8b416';
  const fork = l * 0.32;
  g.fillStyle = '#8a8f96';
  g.fillRect(w * 0.2, 0, w * 0.12, fork); g.fillRect(w * 0.68, 0, w * 0.12, fork);
  g.fillStyle = '#2b2d31'; g.fillRect(w * 0.08, fork - 0.05, w * 0.84, 0.2); // carriage + mast
  g.fillStyle = '#3d4046'; g.fillRect(w * 0.15, fork + 0.15, 0.08, 0.2); g.fillRect(w * 0.77, fork + 0.15, 0.08, 0.2);
  tires(g, w, l, [fork + 0.45, l - 0.45], w * 0.16, 0.5);
  rr(g, w * 0.1, fork + 0.15, w * 0.8, l - fork - 0.15, 0.18);
  g.fillStyle = hGrad(g, w * 0.1, w * 0.9, [[0, shade(paint, 0.75)], [0.5, shade(paint, 1.1)], [1, shade(paint, 0.75)]]); g.fill();
  // overhead guard
  const gy = fork + 0.35, gl = (l - fork) * 0.5;
  g.strokeStyle = '#1d1e21'; g.lineWidth = 0.05;
  g.strokeRect(w * 0.16, gy, w * 0.68, gl);
  for (let x = w * 0.16 + 0.12; x < w * 0.84; x += 0.12) line(g, x, gy, x, gy + gl);
  g.fillStyle = '#2b2d31'; rr(g, w * 0.12, l - 0.55, w * 0.76, 0.5, 0.2); g.fill(); // counterweight
}

/*
 * Avant 630 articulated loader. Positions follow the manufacturer drawing
 * (100.3 in long): front axle 16.9 in behind the attachment plate, 47.2 in
 * wheelbase, 36.2 in rear overhang. Front of the machine (boom, plate) is up.
 */
function avant630(g, w, l, { color, floor }) {
  if (floor) { // 3D view: the loader is drawn by the 3D layer, the plan keeps only a soft shadow
    g.fillStyle = 'rgba(0,0,0,.28)'; rr(g, w * 0.04, l * 0.03, w * 0.92, l * 0.95, 0.2); g.fill();
    return;
  }
  const paint = color || '#3fa21f';
  const cx = w / 2, k = l / 2.548; // scale if the user resizes the object
  const fy = 0.429 * k, ry = 1.628 * k;
  tires(g, w, l, [fy, ry], Math.min(0.32, w * 0.25), 0.64 * k);
  g.fillStyle = '#3b3d42'; // tyre lugs
  for (const y of [fy, ry]) for (let d = -0.26 * k; d <= 0.26 * k; d += 0.065 * k) {
    g.fillRect(0.02, y + d, Math.min(0.32, w * 0.25) - 0.04, 0.02); g.fillRect(w - Math.min(0.32, w * 0.25) + 0.02, y + d, Math.min(0.32, w * 0.25) - 0.04, 0.02);
  }
  const bx = w * 0.24, bw = w * 0.52;
  // rear frame + engine hood
  rr(g, bx - 0.02, 1.0 * k, bw + 0.04, l - 1.0 * k, 0.16);
  g.fillStyle = hGrad(g, bx, bx + bw, [[0, shade(paint, 0.72)], [0.5, shade(paint, 1.12)], [1, shade(paint, 0.72)]]); g.fill();
  g.strokeStyle = shade(paint, 0.55); g.lineWidth = 0.015; g.stroke();
  g.strokeStyle = shade(paint, 0.6); g.lineWidth = 0.012; // hood vents
  for (let y = 1.95 * k; y < 2.3 * k; y += 0.07 * k) line(g, cx - bw * 0.3, y, cx + bw * 0.3, y);
  g.fillStyle = '#2b2d31'; rr(g, bx, l - 0.12 * k, bw, 0.12 * k, 0.05); g.fill(); // rear bumper / counterweight
  // front frame
  rr(g, bx, 0.14 * k, bw, 0.92 * k, 0.1);
  g.fillStyle = hGrad(g, bx, bx + bw, [[0, shade(paint, 0.74)], [0.5, shade(paint, 1.1)], [1, shade(paint, 0.74)]]); g.fill();
  g.strokeStyle = shade(paint, 0.55); g.lineWidth = 0.015; g.stroke();
  // articulation joint
  g.fillStyle = '#2b2d31'; circle(g, cx, 1.02 * k, 0.07); g.fill();
  // telescopic boom: sections narrow toward the attachment plate
  g.fillStyle = hGrad(g, cx - 0.1, cx + 0.1, [[0, '#4f7f2b'], [0.5, '#7ac044'], [1, '#4f7f2b']]);
  g.fillRect(cx - 0.1, 0.62 * k, 0.2, 0.38 * k); // outer section
  g.fillStyle = hGrad(g, cx - 0.075, cx + 0.075, [[0, '#5a9230'], [0.5, '#86cc4f'], [1, '#5a9230']]);
  g.fillRect(cx - 0.075, 0.34 * k, 0.15, 0.3 * k); // inner section
  g.fillStyle = '#3a3c41'; g.fillRect(cx - 0.06, 0.12 * k, 0.12, 0.24 * k); // tip
  g.strokeStyle = '#1d1e21'; g.lineWidth = 0.012;
  for (const y of [0.34 * k, 0.62 * k]) line(g, cx - 0.1, y, cx + 0.1, y);
  g.lineWidth = 0.02; // hydraulic hoses along the boom
  line(g, cx - 0.09, 0.2 * k, cx - 0.09, 0.95 * k); line(g, cx + 0.09, 0.2 * k, cx + 0.09, 0.95 * k);
  // attachment plate (quick-attach)
  g.fillStyle = '#3a3c41'; rr(g, cx - 0.27, 0.0, 0.54, 0.13 * k, 0.03); g.fill();
  g.fillStyle = '#d9a21b'; g.fillRect(cx - 0.2, 0.03, 0.06, 0.07 * k); g.fillRect(cx + 0.14, 0.03, 0.06, 0.07 * k);
  // operator canopy over the seat
  const cw = w * 0.6, cl = 0.78 * k, cy = 0.95 * k;
  rr(g, cx - cw / 2, cy, cw, cl, 0.1);
  g.fillStyle = hGrad(g, cx - cw / 2, cx + cw / 2, [[0, '#2f3338'], [0.5, '#4a5058'], [1, '#2f3338']]); g.fill();
  g.strokeStyle = '#1d1e21'; g.lineWidth = 0.02; g.stroke();
  g.fillStyle = '#1d1e21'; for (const x of [cx - cw / 2 + 0.02, cx + cw / 2 - 0.06]) for (const y of [cy + 0.02, cy + cl - 0.06]) g.fillRect(x, y, 0.04, 0.04); // posts
  // work lights on the canopy's front edge
  g.fillStyle = '#f4f1c8';
  circle(g, cx - cw / 2 + 0.1, cy + 0.03, 0.035); g.fill(); circle(g, cx + cw / 2 - 0.1, cy + 0.03, 0.035); g.fill();
}

function boomLift(g, w, l, { color }) {
  const paint = color || '#e07b1a';
  const cy = l * 0.6;
  tires(g, w, l, [l * 0.43, l * 0.86], 0.45, 1.0);
  g.fillStyle = '#3a3c41'; rr(g, 0.35, l * 0.32, w - 0.7, l * 0.66, 0.2); g.fill(); // chassis
  g.fillStyle = shade(paint, 0.9); rr(g, 0.3, cy - 1.1, w - 0.6, 2.6, 0.25); g.fill(); // turret / counterweight
  g.fillStyle = shade(paint, 0.7); circle(g, w / 2, cy, 0.8); g.fill();
  g.fillStyle = hGrad(g, w / 2 - 0.35, w / 2 + 0.35, [[0, shade(paint, 0.8)], [0.5, shade(paint, 1.15)], [1, shade(paint, 0.8)]]);
  g.fillRect(w / 2 - 0.35, 1.2, 0.7, cy - 1.2); // boom
  g.strokeStyle = shade(paint, 0.6); g.lineWidth = 0.04;
  for (let y = 2; y < cy - 0.5; y += 1.8) line(g, w / 2 - 0.35, y, w / 2 + 0.35, y);
  // basket
  g.fillStyle = '#d9dade'; g.fillRect(w * 0.15, 0.05, w * 0.7, 1.0);
  g.strokeStyle = '#55585e'; g.lineWidth = 0.06; g.strokeRect(w * 0.15, 0.05, w * 0.7, 1.0);
  g.lineWidth = 0.025; line(g, w * 0.15, 0.55, w * 0.85, 0.55);
}

function dumpster(g, w, l, { color }) {
  const c = color || '#2f5d3c';
  g.fillStyle = shade(c, 0.85); g.fillRect(0, 0, w, l);
  g.fillStyle = '#3e3a34'; g.fillRect(0.18, 0.5, w - 0.36, l - 0.68);
  noise(g, 22, 11);
  g.fillStyle = vGrad(g, 0, 0.5, [[0, shade(c, 1.1)], [1, shade(c, 0.7)]]); g.fillRect(0.18, 0.05, w - 0.36, 0.45); // sloped front
  g.strokeStyle = shade(c, 1.15); g.lineWidth = 0.12; g.strokeRect(0.09, 0.09, w - 0.18, l - 0.18);
  g.fillStyle = shade(c, 0.6);
  for (let y = 0.9; y < l - 0.3; y += 0.9) { g.fillRect(0, y, 0.1, 0.12); g.fillRect(w - 0.1, y, 0.1, 0.12); }
  g.fillStyle = '#d0d2d5'; g.fillRect(w / 2 - 0.4, l - 0.12, 0.8, 0.08);
}

function generator(g, w, l, { color }) {
  const c = color || '#d9d4c7';
  const ty = l * 0.2;
  g.strokeStyle = '#3a3c41'; g.lineWidth = 0.1;
  poly(g, [[w / 2, 0.05], [w * 0.3, ty], [w * 0.7, ty]], null, '#3a3c41', 0.1);
  g.fillStyle = '#7d8189'; circle(g, w / 2, 0.12, 0.1); g.fill();
  tires(g, w, l, [ty + (l - ty) * 0.55], 0.25, 0.75);
  rr(g, 0.25, ty, w - 0.5, l - ty - 0.05, 0.12);
  g.fillStyle = hGrad(g, 0.25, w - 0.25, [[0, shade(c, 0.8)], [0.5, shade(c, 1.05)], [1, shade(c, 0.8)]]); g.fill();
  g.strokeStyle = shade(c, 0.55); g.lineWidth = 0.03;
  for (let y = ty + 0.5; y < ty + 1.4; y += 0.1) line(g, w * 0.25, y, w * 0.75, y); // radiator grille
  g.fillStyle = '#2b2d31'; circle(g, w * 0.7, l - 0.8, 0.12); g.fill(); // exhaust
  g.strokeStyle = shade(c, 0.6); g.lineWidth = 0.025; line(g, 0.25, ty + (l - ty) * 0.5, w - 0.25, ty + (l - ty) * 0.5);
}

/* ---------------------------------------------------------------- site */
function parkingStall(g, w, l) {
  g.fillStyle = '#4a4c50'; g.fillRect(0, 0, w, l);
  noise(g, 26, 13);
  g.fillStyle = '#f2f2ee'; g.fillRect(0, 0, 0.1, l); g.fillRect(w - 0.1, 0, 0.1, l);
  g.fillStyle = '#c9c2b5'; rr(g, w * 0.2, 0.35, w * 0.6, 0.15, 0.05); g.fill(); // wheel stop
}
function toilet(g, w, l, { color }) {
  const c = color || '#2f6fb3';
  rr(g, 0.02, 0.02, w - 0.04, l - 0.04, 0.12); g.fillStyle = c; g.fill();
  g.fillStyle = 'rgba(255,255,255,.55)'; rr(g, w * 0.2, l * 0.2, w * 0.6, l * 0.6, 0.08); g.fill();
  g.strokeStyle = shade(c, 0.6); g.lineWidth = 0.03; rr(g, 0.02, 0.02, w - 0.04, l - 0.04, 0.12); g.stroke();
  g.fillStyle = '#1d1e21'; circle(g, w * 0.82, l * 0.82, 0.07); g.fill();
}
function banquet(g, w, l) {
  g.fillStyle = hGrad(g, 0, w, [[0, '#d9d9d5'], [0.12, '#fbfbf8'], [0.88, '#fbfbf8'], [1, '#d9d9d5']]);
  g.fillRect(0, 0, w, l);
  g.strokeStyle = 'rgba(0,0,0,.08)'; g.lineWidth = 0.015;
  for (let y = 0.6; y < l; y += 0.6) line(g, 0, y, w, y);
  g.strokeStyle = '#c2c2bd'; g.lineWidth = 0.02; g.strokeRect(0.01, 0.01, w - 0.02, l - 0.02);
}
function roundTable(g, w, l, { color }) {
  const cx = w / 2, cy = l / 2, rt = (60 * 0.0254) / 2;
  const chair = color || '#c4a25a';
  const n = 8, rc = rt + 0.32;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    g.save(); g.translate(cx + Math.cos(a) * rc, cy + Math.sin(a) * rc); g.rotate(a);
    g.fillStyle = shade(chair, 0.75); rr(g, -0.2, -0.2, 0.4, 0.4, 0.06); g.fill();
    g.fillStyle = chair; rr(g, -0.17, -0.17, 0.34, 0.34, 0.05); g.fill();
    g.fillStyle = shade(chair, 0.6); g.fillRect(0.14, -0.2, 0.06, 0.4); // backrest
    g.restore();
  }
  const gr = g.createRadialGradient(cx - rt * 0.3, cy - rt * 0.3, rt * 0.1, cx, cy, rt);
  gr.addColorStop(0, '#ffffff'); gr.addColorStop(1, '#dcdcd7');
  circle(g, cx, cy, rt); g.fillStyle = gr; g.fill();
  g.strokeStyle = '#bdbdb8'; g.lineWidth = 0.015; g.stroke();
  g.fillStyle = '#e9e3d6'; circle(g, cx, cy, rt * 0.18); g.fill(); // centrepiece
}
function person(g, w, l, { color }) {
  const shirt = color || '#3b6ea8';
  g.fillStyle = shirt; g.beginPath(); g.ellipse(w / 2, l / 2, w * 0.48, l * 0.22, 0, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#3a2a20'; circle(g, w / 2, l / 2, w * 0.16); g.fill();
}

/* ---------------------------------------------------------------- courts */
function lines(g, lw, c = '#ffffff') { g.strokeStyle = c; g.lineWidth = lw; g.fillStyle = c; }

function basketball(g, w, l) {
  g.fillStyle = '#d6a064'; g.fillRect(0, 0, w, l);
  g.strokeStyle = 'rgba(120,70,30,.18)'; g.lineWidth = 0.02;
  for (let x = 0.06; x < w; x += 0.06 * 4) line(g, x, 0, x, l);
  noise(g, 12, 17);
  const ft = FT, cx = w / 2;
  for (const end of [0, 1]) {
    g.save();
    if (end) { g.translate(w, l); g.rotate(Math.PI); }
    g.fillStyle = '#9c3b2f'; g.fillRect(cx - 8 * ft, 0, 16 * ft, 19 * ft);
    lines(g, 2 * 0.0254);
    g.strokeRect(cx - 8 * ft, 0, 16 * ft, 19 * ft);
    circle(g, cx, 19 * ft, 6 * ft); g.stroke();
    const by = 5.25 * ft, r3 = 23.75 * ft, cxo = 22 * ft;
    const ay = by + Math.sqrt(r3 * r3 - cxo * cxo);
    line(g, cx - cxo, 0, cx - cxo, ay); line(g, cx + cxo, 0, cx + cxo, ay);
    g.beginPath(); g.arc(cx, by, r3, Math.atan2(ay - by, cxo), Math.PI - Math.atan2(ay - by, cxo)); g.stroke();
    g.strokeStyle = '#e8e8e8'; g.lineWidth = 0.05; line(g, cx - 3 * ft, 4 * ft, cx + 3 * ft, 4 * ft); // backboard
    g.strokeStyle = '#f26b1d'; g.lineWidth = 0.03; circle(g, cx, by, 0.75 * ft); g.stroke();
    g.restore();
  }
  lines(g, 2 * 0.0254);
  g.strokeRect(0.03, 0.03, w - 0.06, l - 0.06);
  line(g, 0, l / 2, w, l / 2);
  circle(g, cx, l / 2, 6 * ft); g.stroke();
}

function tennis(g, w, l) {
  g.fillStyle = '#3d6f9e'; g.fillRect(0, 0, w, l);
  noise(g, 10, 19);
  const s = 4.5 * FT, lw = 2 * 0.0254;
  lines(g, lw);
  g.strokeRect(lw / 2, lw / 2, w - lw, l - lw);
  line(g, s, 0, s, l); line(g, w - s, 0, w - s, l);
  const sv = l / 2 - 21 * FT;
  line(g, s, sv, w - s, sv); line(g, s, l - sv, w - s, l - sv);
  line(g, w / 2, sv, w / 2, l - sv);
  line(g, w / 2, 0, w / 2, 0.3); line(g, w / 2, l - 0.3, w / 2, l);
  g.strokeStyle = '#1d1e21'; g.lineWidth = 0.08; line(g, 0, l / 2, w, l / 2);
  g.fillStyle = '#1d1e21'; g.fillRect(0, l / 2 - 0.08, 0.16, 0.16); g.fillRect(w - 0.16, l / 2 - 0.08, 0.16, 0.16);
}

function pickleball(g, w, l) {
  g.fillStyle = '#2f7a55'; g.fillRect(0, 0, w, l);
  const k = 7 * FT;
  g.fillStyle = '#3a6f9a'; g.fillRect(0, l / 2 - k, w, 2 * k);
  noise(g, 10, 23);
  lines(g, 2 * 0.0254);
  g.strokeRect(0.03, 0.03, w - 0.06, l - 0.06);
  line(g, 0, l / 2 - k, w, l / 2 - k); line(g, 0, l / 2 + k, w, l / 2 + k);
  line(g, w / 2, 0, w / 2, l / 2 - k); line(g, w / 2, l / 2 + k, w / 2, l);
  g.strokeStyle = '#1d1e21'; g.lineWidth = 0.06; line(g, 0, l / 2, w, l / 2);
}

function football(g, w, l) {
  const yd = 3 * FT, ez = 10 * yd;
  for (let y = 0, i = 0; y < l; y += 5 * yd, i++) { g.fillStyle = i % 2 ? '#3f7d3a' : '#46883f'; g.fillRect(0, y, w, 5 * yd); }
  g.fillStyle = '#2f6a3a'; g.fillRect(0, 0, w, ez); g.fillRect(0, l - ez, w, ez);
  noise(g, 14, 29);
  lines(g, 0.1);
  g.strokeRect(0.05, 0.05, w - 0.1, l - 0.1);
  for (let k = 0; k <= 20; k++) line(g, 0, ez + k * 5 * yd, w, ez + k * 5 * yd);
  const hash = (w - 18.5 * FT) / 2, hw = 0.6;
  g.lineWidth = 0.1;
  for (let k = 1; k < 100; k++) {
    if (k % 5 === 0) continue;
    const y = ez + k * yd;
    line(g, 0.1, y, 0.1 + hw, y); line(g, w - 0.1 - hw, y, w - 0.1, y);
    line(g, hash - hw / 2, y, hash + hw / 2, y); line(g, w - hash - hw / 2, y, w - hash + hw / 2, y);
  }
  g.font = `bold ${2 * yd}px sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
  for (let k = 1; k <= 9; k++) {
    const y = ez + k * 10 * yd, n = String(k <= 5 ? k * 10 : (10 - k) * 10);
    for (const [x, rot] of [[12 * yd, -Math.PI / 2], [w - 12 * yd, Math.PI / 2]]) {
      g.save(); g.translate(x, y); g.rotate(rot); g.fillText(n, 0, 0); g.restore();
    }
  }
  g.strokeStyle = '#ffd60a'; g.lineWidth = 0.15;
  line(g, w / 2 - 9.25 * FT, 0.3, w / 2 + 9.25 * FT, 0.3); line(g, w / 2 - 9.25 * FT, l - 0.3, w / 2 + 9.25 * FT, l - 0.3);
}

function soccer(g, w, l) {
  const sx = w / 68, sy = l / 105; // keep FIFA markings if the pitch is resized
  for (let y = 0, i = 0; y < l; y += l / 14, i++) { g.fillStyle = i % 2 ? '#3f7d3a' : '#4a8b41'; g.fillRect(0, y, w, l / 14 + 0.01); }
  noise(g, 14, 31);
  lines(g, 0.12);
  g.strokeRect(0.06, 0.06, w - 0.12, l - 0.12);
  line(g, 0, l / 2, w, l / 2);
  circle(g, w / 2, l / 2, 9.15 * sx); g.stroke();
  circle(g, w / 2, l / 2, 0.2); g.fill();
  for (const end of [0, 1]) {
    g.save();
    if (end) { g.translate(w, l); g.rotate(Math.PI); }
    g.strokeRect(w / 2 - 20.16 * sx, 0, 40.32 * sx, 16.5 * sy);
    g.strokeRect(w / 2 - 9.16 * sx, 0, 18.32 * sx, 5.5 * sy);
    circle(g, w / 2, 11 * sy, 0.2); g.fill();
    const dy = 16.5 * sy - 11 * sy, r = 9.15 * sx;
    if (r > dy) { const a = Math.acos(dy / r); g.beginPath(); g.arc(w / 2, 11 * sy, r, Math.PI / 2 - a, Math.PI / 2 + a); g.stroke(); }
    g.lineWidth = 0.25; line(g, w / 2 - 3.66 * sx, 0.12, w / 2 + 3.66 * sx, 0.12); g.lineWidth = 0.12;
    for (const x of [0, w]) { g.beginPath(); g.arc(x, 0, 1, 0, Math.PI * 2); g.stroke(); }
    g.restore();
  }
}

/* ---------------------------------------------------------------- registry */
const DRAW = {
  'stage-16x24': stage, 'dance-floor-20x20': danceFloor,
  car, pickup, 'box-truck-26': boxTruck, 'semi-53': semi, 'trailer-53': trailer,
  'container-20': (g, w, l, o) => container(g, w, l, o, '#a6452c'),
  'container-40': (g, w, l, o) => container(g, w, l, o, '#2e6a96'),
  forklift, 'avant-630': avant630, 'boom-lift': boomLift, 'dumpster-30yd': dumpster, 'generator-towable': generator,
  'parking-stall': parkingStall, 'portable-toilet': toilet, 'banquet-table-8': banquet,
  'round-table-60': roundTable, person,
  'basketball-court': basketball, 'tennis-court': tennis, 'pickleball-court': pickleball,
  'football-field': football, 'soccer-pitch': soccer,
};
const drawerFor = (id) => (id?.startsWith('tent-') ? tent : DRAW[id]) || null;

/** True when the template has a skin. */
export const hasSkin = (templateId) => Boolean(drawerFor(templateId));

function render(templateId, width, length, color, maxPx, maxPpm, pad = 0, opts = {}) {
  const draw = drawerFor(templateId);
  if (!draw || !(width > 0) || !(length > 0)) return null;
  const W = width + 2 * pad, L = length + 2 * pad; // padded canvas leaves room for ballast outside the footprint
  const ppm = Math.min(maxPx / Math.max(W, L), maxPpm);
  const c = document.createElement('canvas');
  c.width = Math.max(2, Math.round(W * ppm));
  c.height = Math.max(2, Math.round(L * ppm));
  const g = c.getContext('2d', { willReadFrequently: true });
  g.scale(c.width / W, c.height / L);
  g.translate(pad, pad);
  if (pad > 0 && draw === tent) tentBallast(g, width, length, opts.tent);
  draw(g, width, length, { color, tent: opts.tent, floor: opts.floor });
  return c;
}

const cache = new Map(); // key -> data URL (LRU)
const CACHE_MAX = 64;
/**
 * Data URL of the skin for a placed reference, or null when it has none.
 * `color` tints the body (car paint, tent roof, container) and is ignored when
 * it is the catalog's default marker colour.
 */
export function skinUrl(templateId, width, length, color, pad = 0, opts = {}) {
  if (!drawerFor(templateId)) return null;
  const key = `${templateId}|${width.toFixed(2)}|${length.toFixed(2)}|${color || ''}|${pad.toFixed(3)}|${opts.tent ? JSON.stringify(opts.tent) : ''}|${opts.floor ? 1 : 0}`;
  let url = cache.get(key);
  if (url) { cache.delete(key); cache.set(key, url); return url; }
  const c = render(templateId, width, length, color, MAX_PX, MAX_PPM, pad, opts);
  if (!c) return null;
  url = c.toDataURL('image/png');
  cache.set(key, url);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return url;
}

const thumbs = new Map();
/** Small catalog thumbnail; long objects are laid on their side so they stay legible. */
export function skinThumb(tpl, px = 72) {
  if (!drawerFor(tpl.id)) return null;
  if (thumbs.has(tpl.id)) return thumbs.get(tpl.id);
  const w = tpl.width, l = tpl.shape === 'circle' ? tpl.width : tpl.length;
  const c = render(tpl.id, w, l, null, px * 2, 400);
  let out = c;
  if (c && c.height > c.width * 1.3) {
    out = document.createElement('canvas');
    out.width = c.height; out.height = c.width;
    const g = out.getContext('2d');
    g.translate(out.width / 2, out.height / 2); g.rotate(-Math.PI / 2); g.drawImage(c, -c.width / 2, -c.height / 2);
  }
  const url = out ? out.toDataURL('image/png') : null;
  thumbs.set(tpl.id, url);
  return url;
}
