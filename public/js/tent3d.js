/*
 * 3D tents: one mesh builder (tent spec -> shaded polygons in metres), drawn two ways:
 *   - TentPreview: a dependency-free canvas renderer with orbit controls (builder dialog)
 *   - tentLayer(): a Mapbox GL custom WebGL layer that stands every tent up on the map
 */
import { FT, resolveTent, roofFaces, legs, wallBays, outward, lightness, SIDES } from './tentspec.js';

const rgb = (hex) => { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };

const FRAME = '#b4bcc4', BLOCK = '#aaa69c', PLATE = '#bcc5cb';
const WALL = { solid: ['#f2f2ee', 1], window: ['#f2f2ee', 1], clear: ['#d8ecfa', 0.28] };
const PANE = ['#86a9c0', 0.62];

/** Axis-aligned box as 6 faces. */
function box(out, x0, y0, z0, x1, y1, z1, color, alpha = 1) {
  const c = [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2];
  const q = (pts) => out.push({ pts, color, alpha, inside: c });
  q([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]]);
  q([[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]]);
  q([[x1, y1, z0], [x0, y1, z0], [x0, y1, z1], [x1, y1, z1]]);
  q([[x0, y1, z0], [x0, y0, z0], [x0, y0, z1], [x0, y1, z1]]);
  q([[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]]);
}

/**
 * Polygons for one tent in its local frame (x across, y front->back, z up), each
 * { pts, color, alpha, shade } with `shade` the sun lighting for that face.
 */
export function tentMesh(w, l, t, { color = '#f6f6f3', ballast = true } = {}) {
  const spec = resolveTent(w, l, t);
  const mid = [w / 2, l / 2, spec.eave / 2];
  const out = [];
  for (const f of roofFaces(w, l, spec)) out.push({ pts: f.pts, color, alpha: 1, inside: mid });

  // sidewalls, with window panes in every bay for "window" walls
  const { long, short } = wallBays(w, l, spec);
  const e = spec.eave;
  const wallPts = {
    front: (a, b, z0, z1, o = 0) => [[a, -o, z0], [b, -o, z0], [b, -o, z1], [a, -o, z1]],
    back: (a, b, z0, z1, o = 0) => [[a, l + o, z0], [b, l + o, z0], [b, l + o, z1], [a, l + o, z1]],
    left: (a, b, z0, z1, o = 0) => [[-o, a, z0], [-o, b, z0], [-o, b, z1], [-o, a, z1]],
    right: (a, b, z0, z1, o = 0) => [[w + o, a, z0], [w + o, b, z0], [w + o, b, z1], [w + o, a, z1]],
  };
  for (const s of SIDES) {
    const kind = spec.walls[s];
    if (kind === 'none') continue;
    const run = s === 'front' || s === 'back' ? w : l;
    const [wc, wa] = WALL[kind];
    out.push({ pts: wallPts[s](0, run, 0, e), color: wc, alpha: wa, inside: mid });
    if (kind === 'window') {
      const cuts = s === 'front' || s === 'back' ? short : long;
      for (let i = 0; i < cuts.length - 1; i++) {
        const a = cuts[i], b = cuts[i + 1], m = Math.min(0.5, (b - a) * 0.14);
        out.push({ pts: wallPts[s](a + m, b - m, e * 0.36, e * 0.78, 0.02), color: PANE[0], alpha: PANE[1], inside: mid });
      }
    }
  }

  // legs (4" square uprights), eave beams, and ballast plates with two blocks each
  const lg = 0.1;
  for (const p of legs(w, l, spec)) {
    const x = Math.min(w - lg, Math.max(0, p.x - lg / 2)), y = Math.min(l - lg, Math.max(0, p.y - lg / 2));
    box(out, x, y, 0, x + lg, y + lg, e, FRAME);
    if (!ballast) continue;
    const tx = -p.ny, ty = p.nx; // along the wall
    const plateLen = Math.min(5.6 * FT, p.step - 0.4 * FT), blockL = (plateLen - 0.6 * FT) / 2;
    const at = (o, a) => [p.x + p.nx * o + tx * a, p.y + p.ny * o + ty * a];
    const rect = (o0, o1, a0, a1, z0, z1, c) => {
      const [ax, ay] = at(o0, a0), [bx, by] = at(o1, a1);
      box(out, Math.min(ax, bx), Math.min(ay, by), z0, Math.max(ax, bx), Math.max(ay, by), z1, c);
    };
    rect(-0.6 * FT, 3.6 * FT, -plateLen / 2, plateLen / 2, 0, 0.04, PLATE);
    for (const k of [-1, 1]) {
      const a0 = k * 0.05 * FT, a1 = k * (0.05 * FT + blockL);
      rect(0.85 * FT, 3.35 * FT, Math.min(a0, a1), Math.max(a0, a1), 0.04, 0.04 + 2.5 * FT, BLOCK);
    }
  }
  const beam = 0.07;
  box(out, 0, 0, e - beam, w, beam, e, FRAME); box(out, 0, l - beam, e - beam, w, l, e, FRAME);
  box(out, 0, 0, e - beam, beam, l, e, FRAME); box(out, w - beam, 0, e - beam, w, l, e, FRAME);

  for (const f of out) { f.shade = lightness(outward(f.pts, f.inside)); delete f.inside; }
  return { faces: out, spec };
}

/* ======================================================= canvas preview */
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a) => { const n = Math.hypot(...a) || 1; return a.map((v) => v / n); };

/**
 * Orbitable perspective preview on a 2D canvas (painter's algorithm; tent
 * meshes are small). Drag to orbit, wheel or pinch to zoom.
 */
export class TentPreview {
  constructor(canvas) {
    this.c = canvas; this.g = canvas.getContext('2d');
    this.yaw = -35; this.pitch = 24; this.zoom = 1;
    this.mesh = null; this.w = 10; this.l = 10; this.units = 'imperial';
    let drag = null;
    const pts = new Map();
    canvas.addEventListener('pointerdown', (e) => { canvas.setPointerCapture(e.pointerId); pts.set(e.pointerId, [e.clientX, e.clientY]); drag = { x: e.clientX, y: e.clientY, yaw: this.yaw, pitch: this.pitch }; });
    canvas.addEventListener('pointermove', (e) => {
      if (!pts.has(e.pointerId)) return;
      const prev = pts.get(e.pointerId); pts.set(e.pointerId, [e.clientX, e.clientY]);
      if (pts.size === 2) {
        const [a, b] = [...pts.values()], o = [...pts.entries()].find(([k]) => k !== e.pointerId)[1];
        const d0 = Math.hypot(prev[0] - o[0], prev[1] - o[1]), d1 = Math.hypot(a[0] - b[0], a[1] - b[1]);
        if (d0 > 0) { this.zoom = Math.min(4, Math.max(0.4, this.zoom * (d1 / d0))); this.draw(); }
        return;
      }
      if (!drag) return;
      this.yaw = drag.yaw - (e.clientX - drag.x) * 0.4;
      this.pitch = Math.min(85, Math.max(4, drag.pitch + (e.clientY - drag.y) * 0.3));
      this.draw();
    });
    const up = (e) => { pts.delete(e.pointerId); drag = null; };
    canvas.addEventListener('pointerup', up); canvas.addEventListener('pointercancel', up);
    canvas.addEventListener('wheel', (e) => { e.preventDefault(); this.zoom = Math.min(4, Math.max(0.4, this.zoom * Math.exp(-e.deltaY * 0.0012))); this.draw(); }, { passive: false });
    this.ro = new ResizeObserver(() => this.draw());
    this.ro.observe(canvas);
  }

  set(w, l, tent, opts) { this.w = w; this.l = l; this.mesh = tentMesh(w, l, tent, opts); this.draw(); }
  view(yaw, pitch) { this.yaw = yaw; this.pitch = pitch; this.zoom = 1; this.draw(); }
  destroy() { this.ro.disconnect(); }

  draw() {
    const { c, g } = this;
    const dpr = window.devicePixelRatio || 1;
    const cw = c.clientWidth, ch = c.clientHeight;
    if (!cw || !ch || !this.mesh) return;
    if (c.width !== Math.round(cw * dpr)) { c.width = Math.round(cw * dpr); c.height = Math.round(ch * dpr); }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const sky = g.createLinearGradient(0, 0, 0, ch);
    sky.addColorStop(0, '#2b3542'); sky.addColorStop(1, '#151a21');
    g.fillStyle = sky; g.fillRect(0, 0, cw, ch);

    const { w, l } = this, { spec } = this.mesh;
    const target = [w / 2, l / 2, spec.peak * 0.35];
    const R = Math.max(w, l, spec.peak * 1.6) * 1.55 / this.zoom;
    const yr = (this.yaw * Math.PI) / 180, pr = (this.pitch * Math.PI) / 180;
    // camera orbits the tent; yaw 0 looks at the front (from -y)
    const eye = [target[0] + R * Math.cos(pr) * Math.sin(yr), target[1] - R * Math.cos(pr) * Math.cos(yr), target[2] + R * Math.sin(pr)];
    const fwd = unit(sub(target, eye)), right = unit(cross(fwd, [0, 0, 1])), upv = cross(right, fwd);
    const f = Math.min(cw, ch) * 1.25;
    const proj = (p) => {
      const d = sub(p, eye), z = dot(d, fwd);
      if (z < 0.1) return null;
      return [cw / 2 + (dot(d, right) / z) * f, ch / 2 - (dot(d, upv) / z) * f, z];
    };

    // ground grid: 10 ft (or 5 m) squares around the tent
    const step = this.units === 'metric' ? 5 : 10 * FT;
    const pad = Math.max(w, l) * 0.6 + 4;
    const x0 = Math.floor(-pad / step) * step, x1 = w + pad, y0 = Math.floor(-pad / step) * step, y1 = l + pad;
    const ground = [[x0, y0, 0], [x1, y0, 0], [x1, y1, 0], [x0, y1, 0]].map(proj);
    if (ground.every(Boolean)) { g.fillStyle = '#2e3a2c'; g.beginPath(); ground.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath(); g.fill(); }
    g.strokeStyle = 'rgba(255,255,255,.08)'; g.lineWidth = 1;
    const seg = (a, b) => { const p = proj(a), q = proj(b); if (p && q) { g.beginPath(); g.moveTo(p[0], p[1]); g.lineTo(q[0], q[1]); g.stroke(); } };
    for (let x = x0; x <= x1 + 1e-6; x += step) seg([x, y0, 0], [x, y1, 0]);
    for (let y = y0; y <= y1 + 1e-6; y += step) seg([x0, y, 0], [x1, y, 0]);
    // soft shadow
    const sh = [[0.4, 0.6, 0], [w + 1.2, 0.6, 0], [w + 1.2, l + 1.4, 0], [0.4, l + 1.4, 0]].map(proj);
    if (sh.every(Boolean)) { g.fillStyle = 'rgba(0,0,0,.28)'; g.beginPath(); sh.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath(); g.fill(); }

    // a 5'10" person at the front-left corner for scale
    const faces = [...this.mesh.faces];
    const px = -1.4, py = -1.2;
    box(faces, px - 0.22, py - 0.13, 0, px + 0.22, py + 0.13, 1.45, '#3d6fa8');
    box(faces, px - 0.12, py - 0.12, 1.5, px + 0.12, py + 0.12, 1.78, '#e0b48e');
    for (const fc of faces) if (fc.shade == null) fc.shade = lightness(outward(fc.pts, [px, py, 0.9]));

    const drawn = [];
    for (const fc of faces) {
      const pp = fc.pts.map(proj);
      if (pp.some((p) => !p)) continue;
      const depth = pp.reduce((s, p) => s + p[2], 0) / pp.length;
      drawn.push({ fc, pp, depth });
    }
    drawn.sort((a, b) => b.depth - a.depth);
    for (const { fc, pp } of drawn) {
      const [r, gg, b] = rgb(fc.color).map((v) => Math.round(Math.min(255, v * fc.shade)));
      g.fillStyle = `rgba(${r},${gg},${b},${fc.alpha})`;
      g.beginPath(); pp.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath();
      g.fill();
      if (fc.alpha === 1) { g.strokeStyle = g.fillStyle; g.lineWidth = 0.6; g.stroke(); } // hide AA seams
    }
  }
}

/* ======================================================= Mapbox custom layer */
const VS = `
attribute vec3 a_pos; attribute vec4 a_col;
uniform mat4 u_m; varying vec4 v_col;
void main() { v_col = a_col; gl_Position = u_m * vec4(a_pos, 1.0); }`;
const FS = `
precision mediump float; varying vec4 v_col;
void main() { gl_FragColor = v_col; }`;

/** Column-major 4x4 multiply (a * b). */
function mul(a, b) {
  const o = new Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  }
  return o;
}

/**
 * A custom layer that draws `tents` ({ center:[lon,lat], rotation, width, length,
 * tent, color, ballast }) standing on the map. Geometry is built in metres around
 * one origin (east, north, up), so float32 stays precise at site scale.
 */
export function tentLayer(id = 'lm-tents3d') {
  let vao = null, gl, prog, loc, buf = { opaque: null, clear: null }, counts = { opaque: 0, clear: 0 }, origin = null, map = null;
  let pending = [], upload = null;

  function build(tents) {
    pending = tents;
    if (!gl) return;
    origin = tents.length ? tents[0].center : null;
    const verts = { opaque: [], clear: [] };
    if (origin) {
      const lat0 = (origin[1] * Math.PI) / 180;
      const mPerDegLat = 111320, mPerDegLon = 111320 * Math.cos(lat0);
      for (const t of tents) {
        const ox = (t.center[0] - origin[0]) * mPerDegLon, oy = (t.center[1] - origin[1]) * mPerDegLat;
        const th = (t.rotation * Math.PI) / 180, cs = Math.cos(th), sn = Math.sin(th);
        const w = t.width, l = t.length;
        // local (x across, y front->back) -> east/north: front faces the rotation bearing
        const toWorld = ([x, y, z]) => {
          const e = x - w / 2, n = l / 2 - y;
          return [ox + e * cs + n * sn, oy - e * sn + n * cs, z];
        };
        for (const f of tentMesh(w, l, t.tent, { color: t.color, ballast: t.ballast }).faces) {
          const [r, g, b] = rgb(f.color).map((v) => Math.min(255, v * f.shade) / 255);
          const a = f.alpha, col = [r * a, g * a, b * a, a]; // premultiplied
          const p = f.pts.map(toWorld);
          const dst = a < 1 ? verts.clear : verts.opaque;
          for (let i = 1; i < p.length - 1; i++) for (const q of [p[0], p[i], p[i + 1]]) dst.push(...q, ...col);
        }
      }
    }
    // uploaded in render(), where Mapbox expects GL state to change
    upload = { opaque: new Float32Array(verts.opaque), clear: new Float32Array(verts.clear) };
    counts = { opaque: verts.opaque.length / 7, clear: verts.clear.length / 7 };
    map?.triggerRepaint();
  }

  return {
    id, type: 'custom', renderingMode: '3d',
    setTents(tents) { build(tents); },
    onAdd(m, context) {
      map = m; gl = context;
      const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; };
      prog = gl.createProgram();
      gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
      gl.linkProgram(prog);
      loc = { pos: gl.getAttribLocation(prog, 'a_pos'), col: gl.getAttribLocation(prog, 'a_col'), m: gl.getUniformLocation(prog, 'u_m') };
      buf = { opaque: null, clear: null };
      build(pending);
    },
    onRemove() { gl = null; map = null; vao = null; },
    render(context, matrix) {
      if (!origin || (!upload && !(counts.opaque + counts.clear))) return;
      const mc = globalThis.mapboxgl.MercatorCoordinate.fromLngLat(origin, 0);
      const s = mc.meterInMercatorCoordinateUnits();
      // metres (east, north, up) -> mercator (x east, y south, z up)
      const model = [s, 0, 0, 0, 0, -s, 0, 0, 0, 0, s, 0, mc.x, mc.y, 0, 1];
      context.useProgram(prog);
      context.uniformMatrix4fv(loc.m, false, new Float32Array(mul(matrix, model)));
      context.enable(context.DEPTH_TEST); context.depthFunc(context.LEQUAL);
      context.disable(context.CULL_FACE);
      context.enable(context.BLEND); context.blendFunc(context.ONE, context.ONE_MINUS_SRC_ALPHA);
      // WebGL2: draw from our own vertex array object so Mapbox's bound VAO is left untouched
      const vaoOk = typeof context.createVertexArray === 'function';
      if (vaoOk && !vao) vao = context.createVertexArray();
      if (vaoOk) context.bindVertexArray(vao);
      for (const k of ['opaque', 'clear']) {
        if (upload) {
          if (!buf[k]) buf[k] = context.createBuffer();
          context.bindBuffer(context.ARRAY_BUFFER, buf[k]);
          context.bufferData(context.ARRAY_BUFFER, upload[k], context.DYNAMIC_DRAW);
        }
        if (!counts[k]) continue;
        context.depthMask(k === 'opaque');
        context.bindBuffer(context.ARRAY_BUFFER, buf[k]);
        context.enableVertexAttribArray(loc.pos); context.enableVertexAttribArray(loc.col);
        context.vertexAttribPointer(loc.pos, 3, context.FLOAT, false, 28, 0);
        context.vertexAttribPointer(loc.col, 4, context.FLOAT, false, 28, 12);
        context.drawArrays(context.TRIANGLES, 0, counts[k]);
      }
      upload = null;
      context.depthMask(true);
      if (vaoOk) context.bindVertexArray(null);
    },
  };
}
