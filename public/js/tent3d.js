/*
 * 3D tents: one mesh builder (tent spec -> shaded polygons in metres), drawn by
 * one small WebGL renderer in two places:
 *   - TentPreview: orbitable preview in the tent builder and the 3D Modeler
 *     (falls back to a 2D painter's-algorithm canvas when WebGL is unavailable)
 *   - tentLayer(): a Mapbox GL custom layer that stands every tent up on the map
 *
 * Stability rules the mesh follows (they are what keep it from flickering at any
 * angle or zoom): no two surfaces share a plane where they overlap (walls hang
 * just outside the frame, legs stop under the eave beam, blocks sit on the plate
 * without a hidden bottom face), see-through faces are drawn back to front from
 * the real camera every frame, and window panes ("decals") get a depth offset.
 */
import { FT, resolveTent, roofFaces, legs, wallBays, outward, lightness, SIDES } from './tentspec.js';
import { vehicleMesh } from './vehicle3d.js';

const rgb = (hex) => { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };

const FRAME = '#b4bcc4', STEEL = '#c9ced3', CABLE = '#eceeef', BLOCK = '#aaa69c', PLATE = '#bcc5cb';
const WALL = { solid: ['#f2f2ee', 1], window: ['#f2f2ee', 1], clear: ['#d8ecfa', 0.28] };
const PANE = ['#86a9c0', 0.62];
const WALL_OUT = 0.05;  // sidewalls hang this far outside the frame line
const PANE_OUT = 0.1;   // window panes sit this far outside the frame line (in front of the wall)
const GAP = 0.03;       // frame members stay this far under the roof fabric

/*
 * Aluminium sections (metres), from the Grandchamp structure technical sheet:
 * thickness along the tent (t) x depth in the frame plane (d).
 */
const SECTIONS = {
  pipe: { t: 0.064, d: 0.064 },         // frame tents: 2.5" OD steel/alu pipe
  medium: { t: 0.061, d: 0.201 },       // MEGA / Medium beam 2.394" x 7.919", 18'-67' spans
  xl: { t: 0.114, d: 0.305 },           // XL beam 4.5" x 12", 80'-120' spans
  purlin: { t: 0.047, d: 0.111 },       // Small beam 1.85" x 4.387" used as purlins / eave rails
};
const sectionFor = (w) => (w <= 20 * FT + 0.05 ? SECTIONS.pipe : w < 68 * FT ? SECTIONS.medium : SECTIONS.xl);

/** Axis-aligned box. `bottom`/`top` false drop a face that touches another part (it would fight it for depth). */
function box(out, x0, y0, z0, x1, y1, z1, color, { alpha = 1, bottom = false, top = true } = {}) {
  const c = [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2];
  const q = (pts) => out.push({ pts, color, alpha, inside: c });
  if (top) q([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]]);
  if (bottom) q([[x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]]);
  q([[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]]);
  q([[x1, y1, z0], [x0, y1, z0], [x0, y1, z1], [x1, y1, z1]]);
  q([[x0, y1, z0], [x0, y0, z0], [x0, y0, z1], [x0, y1, z1]]);
  q([[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]]);
}

/**
 * A member whose top edge runs from p0 to p1 (rafter, purlin, cable): `t` wide
 * across it horizontally and hanging `d` straight down, so it sits under a
 * roof line without ever sharing its plane.
 */
function member(out, p0, p1, t, d, color) {
  const ax = [p1[0] - p0[0], p1[1] - p0[1]];
  const n = Math.hypot(...ax);
  const b = n < 1e-9 ? [t / 2, 0] : [(-ax[1] / n) * (t / 2), (ax[0] / n) * (t / 2)];
  const T = (p, s) => [p[0] + b[0] * s, p[1] + b[1] * s, p[2]];
  const D = (p) => [p[0], p[1], p[2] - d];
  const a0 = T(p0, -1), a1 = T(p0, 1), c0 = T(p1, -1), c1 = T(p1, 1);
  const inside = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2, (p0[2] + p1[2]) / 2 - d / 2];
  const q = (pts) => out.push({ pts, color, alpha: 1, inside });
  q([a0, a1, c1, c0]); q([D(a0), D(c0), D(c1), D(a1)]);
  q([a0, c0, D(c0), D(a0)]); q([a1, D(a1), D(c1), c1]);
  q([a0, D(a0), D(a1), a1]); q([c0, c1, D(c1), D(c0)]);
}

/**
 * Polygons for one tent in its local frame (x across, y front->back, z up), each
 * { pts, color, alpha, shade, decal? } with `shade` the sun lighting for that face
 * and `decal` set on faces drawn on top of another (window panes).
 *
 * Structures follow the Grandchamp / Aztec drawings: a portal frame (two legs and
 * two rafters) on every bay line, purlins every 8 ft up the slope, gable-end posts,
 * 12" base plates and X-bracing cables in the end bays. Frame tents (20 ft wide and
 * under) get 2.5" pipe legs and rafters.
 */
export function tentMesh(w, l, t, { color = '#f6f6f3', ballast = true } = {}) {
  const spec = resolveTent(w, l, t);
  const e = spec.eave, h = spec.peak, gable = spec.roof === 'gable';
  const mid = [w / 2, l / 2, e / 2];
  const out = [];
  for (const f of roofFaces(w, l, spec)) out.push({ pts: f.pts, color, alpha: 1, inside: mid });

  /* roof surface height over a plan point, and the ridge point a rafter climbs to */
  const half = gable ? w / 2 : Math.min(w, l) / 2;
  const roofZ = (x, y) => e + (h - e) * Math.max(0, Math.min(1, (gable ? Math.min(x, w - x) : Math.min(x, w - x, y, l - y)) / half));
  const ridgeAt = (x, y) => {
    if (gable || spec.roof === 'hip') {
      if (gable || l >= w) { const a = gable ? 0 : w / 2; return [w / 2, Math.min(l - a, Math.max(a, y))]; }
      return [Math.min(w - l / 2, Math.max(l / 2, x)), l / 2];
    }
    return [w / 2, l / 2];
  };

  /* sidewalls just outside the frame line */
  const { long, short } = wallBays(w, l, spec);
  const wallPts = {
    front: (a, b, z0, z1, o) => [[a, -o, z0], [b, -o, z0], [b, -o, z1], [a, -o, z1]],
    back: (a, b, z0, z1, o) => [[a, l + o, z0], [b, l + o, z0], [b, l + o, z1], [a, l + o, z1]],
    left: (a, b, z0, z1, o) => [[-o, a, z0], [-o, b, z0], [-o, b, z1], [-o, a, z1]],
    right: (a, b, z0, z1, o) => [[w + o, a, z0], [w + o, b, z0], [w + o, b, z1], [w + o, a, z1]],
  };
  for (const s of SIDES) {
    const kind = spec.walls[s];
    if (kind === 'none') continue;
    const run = s === 'front' || s === 'back' ? w : l;
    const [wc, wa] = WALL[kind];
    const a = -WALL_OUT, b = run + WALL_OUT; // corner to corner on the outside line: neighbours meet, never overlap
    if (kind === 'clear') {
      // clear panels with a white header band under the eave and a kick band at the ground
      const kick = Math.min(0.25, e * 0.08), head = Math.min(0.35, e * 0.1);
      out.push({ pts: wallPts[s](a, b, 0, kick, WALL_OUT), color: WALL.solid[0], alpha: 1, inside: mid });
      out.push({ pts: wallPts[s](a, b, kick, e - head, WALL_OUT), color: wc, alpha: wa, inside: mid });
      out.push({ pts: wallPts[s](a, b, e - head, e, WALL_OUT), color: WALL.solid[0], alpha: 1, inside: mid });
      continue;
    }
    out.push({ pts: wallPts[s](a, b, 0, e, WALL_OUT), color: wc, alpha: wa, inside: mid });
    if (kind === 'window') {
      // French window panel in every bay: two windows of 3 x 6 panes; the wall shows through as mullions
      const cuts = s === 'front' || s === 'back' ? short : long;
      for (let i = 0; i < cuts.length - 1; i++) {
        const bw = cuts[i + 1] - cuts[i];
        const ww = Math.min(bw * 0.36, 2), wh = Math.min(e * 0.52, 2.6), z0 = Math.max(0.6, e * 0.3);
        const g = Math.min(0.045, ww * 0.03), pw = (ww - 4 * g) / 3, ph = (wh - 7 * g) / 6;
        for (const cx of [cuts[i] + bw * 0.28, cuts[i] + bw * 0.72]) {
          for (let c = 0; c < 3; c++) for (let r = 0; r < 6; r++) {
            const x0 = cx - ww / 2 + g + c * (pw + g), zz = z0 + g + r * (ph + g);
            out.push({ pts: wallPts[s](x0, x0 + pw, zz, zz + ph, PANE_OUT), color: PANE[0], alpha: PANE[1], inside: mid, decal: true });
          }
        }
      }
    }
  }

  /* frame: legs, eave rails, rafters, purlins, gable posts, base plates, bracing */
  const sec = sectionFor(w), P = SECTIONS.purlin, pipe = sec === SECTIONS.pipe;
  const rail = pipe ? sec : P;
  const base = ballast ? 0.04 : 0;          // legs stand on the ballast plate
  const plate = pipe ? 0 : 0.012;           // 12" x 12" steel base plate under structure legs
  // eave rails along all four sides at the top of the legs
  box(out, 0, 0, e - rail.d, w, rail.t, e, FRAME, { bottom: true });
  box(out, 0, l - rail.t, e - rail.d, w, l, e, FRAME, { bottom: true });
  box(out, 0, rail.t, e - rail.d, rail.t, l - rail.t, e, FRAME, { bottom: true });
  box(out, w - rail.t, rail.t, e - rail.d, w, l - rail.t, e, FRAME, { bottom: true });

  const legList = legs(w, l, spec);
  for (const p of legList) {
    const endWall = p.side === 'front' || p.side === 'back';
    // deep side of the section lies in the frame plane: across the tent on side walls, along it on gable ends
    const sx = endWall ? sec.t : sec.d, sy = endWall ? sec.d : sec.t;
    const x = Math.min(w - sx, Math.max(0, p.x - sx / 2)), y = Math.min(l - sy, Math.max(0, p.y - sy / 2));
    const gablePost = gable && endWall && !pipe;
    const top = gablePost ? Math.min(roofZ(x, 0), roofZ(x + sx, 0)) - GAP : e - rail.d;
    const py = gablePost ? (p.side === 'front' ? 0.08 : l - 0.08 - sy) : y; // posts stand just inside the gable fabric
    box(out, x, py, base + plate, x + sx, py + sy, top, FRAME, { top: gablePost });
    if (plate) {
      const ps = 0.305, cx = x + sx / 2, cy = py + sy / 2;
      box(out, cx - ps / 2, cy - ps / 2, base, cx + ps / 2, cy + ps / 2, base + plate, STEEL);
    }
    if (ballast) {
      // ballast plate with two concrete blocks (blocks rest on the plate: no hidden bottom faces)
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
    // rafter from the top of this leg up the roof to the ridge (gable-end posts carry the end rafters instead)
    if (gablePost) continue;
    const rt = sec.t * 0.9; // a hair narrower than the leg so their sides never coincide
    const lx = Math.min(w - rt, Math.max(rt, p.x)), ly = Math.min(l - rt, Math.max(rt, p.y));
    const [rx, ry] = ridgeAt(lx, ly);
    if (Math.hypot(rx - lx, ry - ly) < 0.2) continue;
    member(out, [lx, ly, roofZ(lx, ly) - GAP], [rx, ry, h - GAP], rt, sec.d, FRAME);
  }
  // gable end rafters sit on the posts
  if (gable && !pipe) for (const y of [rail.t / 2 + 0.08, l - rail.t / 2 - 0.08]) {
    member(out, [0.01, y, roofZ(0.01, y) - GAP], [w / 2, y, h - GAP], sec.t * 0.9, sec.d, FRAME);
    member(out, [w - 0.01, y, roofZ(w - 0.01, y) - GAP], [w / 2, y, h - GAP], sec.t * 0.9, sec.d, FRAME);
  }

  if (gable && !pipe) {
    // purlins: ridge, then every 8 ft up each slope, running the full length under the fabric
    const slope = Math.hypot(w / 2, h - e), n = Math.max(1, Math.round(slope / (8 * FT)));
    const y0 = 0.15, y1 = l - 0.15, drop = GAP + sec.d + 0.005; // below the rafters, clear of the gable fabric
    member(out, [w / 2, y0, h - drop], [w / 2, y1, h - drop], P.t, P.d, FRAME);
    for (let i = 1; i < n; i++) for (const side of [-1, 1]) {
      const x = w / 2 + side * (w / 2) * (i / n);
      member(out, [x, y0, roofZ(x, 0) - drop], [x, y1, roofZ(x, 0) - drop], P.t, P.d, FRAME);
    }
    // X-bracing cables in the first and last bay: both long walls and both roof slopes
    const cable = 0.016, ends = [[long[0], long[1]], [long[long.length - 2], long[long.length - 1]]];
    for (const [ya, yb] of long.length > 2 ? ends : [ends[0]]) {
      for (const x of [sec.d + 0.02, w - sec.d - 0.02]) {
        member(out, [x, ya + 0.1, e - rail.d - 0.05], [x, yb - 0.1, base + 0.35], cable, cable, CABLE);
        member(out, [x, yb - 0.1, e - rail.d - 0.05], [x, ya + 0.1, base + 0.35], cable, cable, CABLE);
      }
      for (const xs of [0.3, w - 0.3]) {
        const zr = (x) => roofZ(x, 0) - drop - P.d - 0.01;
        member(out, [xs, ya + 0.1, zr(xs)], [w / 2, yb - 0.1, zr(w / 2 - 0.01)], cable, cable, CABLE);
        member(out, [xs, yb - 0.1, zr(xs)], [w / 2, ya + 0.1, zr(w / 2 - 0.01)], cable, cable, CABLE);
      }
    }
  }

  for (const f of out) { f.shade = lightness(outward(f.pts, f.inside)); delete f.inside; }
  return { faces: out, spec };
}

/* ======================================================= shared WebGL renderer */
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

/** Premultiplied, shaded RGBA for a face. */
function faceColor(f) {
  const [r, g, b] = rgb(f.color).map((v) => Math.min(255, v * f.shade) / 255);
  return [r * f.alpha, g * f.alpha, b * f.alpha, f.alpha];
}

/**
 * Geometry for one draw: opaque triangles in one buffer, see-through faces kept
 * per face so they can be re-sorted back to front from the camera each frame.
 */
class MeshGL {
  constructor() { this.prog = null; this.loc = null; this.vao = null; this.buf = {}; this.opaque = new Float32Array(0); this.clear = []; this.lines = new Float32Array(0); this.dirty = true; }

  /** faces: [{ pts (world metres), color, alpha, shade, decal? }]; lines: flat [x,y,z,r,g,b,a, ...] pairs. */
  set(faces, lines = []) {
    const op = [];
    this.clear = [];
    for (const f of faces) {
      const col = faceColor(f);
      const tri = [];
      for (let i = 1; i < f.pts.length - 1; i++) for (const q of [f.pts[0], f.pts[i], f.pts[i + 1]]) tri.push(q[0], q[1], q[2], ...col);
      if (f.alpha < 1) {
        const c = f.pts.reduce((a, p) => [a[0] + p[0] / f.pts.length, a[1] + p[1] / f.pts.length, a[2] + p[2] / f.pts.length], [0, 0, 0]);
        this.clear.push({ tri, c, decal: Boolean(f.decal) });
      } else op.push(...tri);
    }
    this.opaque = new Float32Array(op);
    this.lines = new Float32Array(lines);
    this.dirty = true;
  }

  init(gl) {
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; };
    this.prog = gl.createProgram();
    gl.attachShader(this.prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(this.prog, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(this.prog);
    this.loc = { pos: gl.getAttribLocation(this.prog, 'a_pos'), col: gl.getAttribLocation(this.prog, 'a_col'), m: gl.getUniformLocation(this.prog, 'u_m') };
    this.buf = { opaque: gl.createBuffer(), clear: gl.createBuffer(), lines: gl.createBuffer() };
    this.vao = null;
    this.dirty = true;
  }

  /**
   * Draw with `matrix` (world -> clip) and the camera position `eye` in world
   * metres. Leaves depth testing on; restores the VAO binding it changes.
   */
  draw(gl, matrix, eye) {
    if (!this.prog) this.init(gl);
    gl.useProgram(this.prog);
    gl.uniformMatrix4fv(this.loc.m, false, new Float32Array(matrix));
    // WebGL2: our own vertex array object, so the host's (Mapbox's) bound VAO is untouched
    const vaoOk = typeof gl.createVertexArray === 'function';
    if (vaoOk && !this.vao) this.vao = gl.createVertexArray();
    if (vaoOk) gl.bindVertexArray(this.vao);
    gl.enableVertexAttribArray(this.loc.pos); gl.enableVertexAttribArray(this.loc.col);
    const bind = (b) => {
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.vertexAttribPointer(this.loc.pos, 3, gl.FLOAT, false, 28, 0);
      gl.vertexAttribPointer(this.loc.col, 4, gl.FLOAT, false, 28, 12);
    };
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    if (this.dirty) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buf.opaque); gl.bufferData(gl.ARRAY_BUFFER, this.opaque, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buf.lines); gl.bufferData(gl.ARRAY_BUFFER, this.lines, gl.STATIC_DRAW);
      this.dirty = false;
    }
    // 1. opaque, writing depth
    gl.depthMask(true);
    if (this.opaque.length) { bind(this.buf.opaque); gl.drawArrays(gl.TRIANGLES, 0, this.opaque.length / 7); }
    // 2. ground lines, nudged toward the camera so they never fight the ground
    if (this.lines.length) {
      gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(-1, -1);
      bind(this.buf.lines); gl.drawArrays(gl.LINES, 0, this.lines.length / 7);
      gl.disable(gl.POLYGON_OFFSET_FILL);
    }
    // 3. see-through faces, farthest first, without writing depth; panes get a depth offset
    if (this.clear.length) {
      const d = (c) => (c[0] - eye[0]) ** 2 + (c[1] - eye[1]) ** 2 + (c[2] - eye[2]) ** 2;
      const order = this.clear.map((f) => [d(f.c), f]).sort((a, b) => b[0] - a[0]);
      const plain = [], decal = [];
      for (const [, f] of order) (f.decal ? decal : plain).push(...f.tri);
      gl.depthMask(false);
      bind(this.buf.clear);
      // panes are drawn after the plain see-through faces, each group in back-to-front order
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([...plain, ...decal]), gl.DYNAMIC_DRAW);
      if (plain.length) gl.drawArrays(gl.TRIANGLES, 0, plain.length / 7);
      if (decal.length) {
        gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(-2, -4);
        gl.drawArrays(gl.TRIANGLES, plain.length / 7, decal.length / 7);
        gl.disable(gl.POLYGON_OFFSET_FILL);
      }
      gl.depthMask(true);
    }
    if (vaoOk) gl.bindVertexArray(null);
  }
}

/* ======================================================= preview */
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a) => { const n = Math.hypot(...a) || 1; return a.map((v) => v / n); };

function perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
  return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0];
}
function lookAt(eye, target, up) {
  const z = unit(sub(eye, target)), x = unit(cross(up, z)), y = cross(z, x);
  return [x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, eye), -dot(y, eye), -dot(z, eye), 1];
}

/** Scene extras shared by both preview renderers: ground, grid, shadow, a person for scale. */
function previewScene(w, l, units) {
  const step = units === 'metric' ? 5 : 10 * FT;
  const pad = Math.max(w, l) * 0.6 + 4;
  const x0 = Math.floor(-pad / step) * step, x1 = w + pad, y0 = Math.floor(-pad / step) * step, y1 = l + pad;
  const faces = [];
  faces.push({ pts: [[x0, y0, 0], [x1, y0, 0], [x1, y1, 0], [x0, y1, 0]], color: '#2e3a2c', alpha: 1, shade: 1, ground: true });
  faces.push({ pts: [[0.4, 0.6, 0.004], [w + 1.2, 0.6, 0.004], [w + 1.2, l + 1.4, 0.004], [0.4, l + 1.4, 0.004]], color: '#000000', alpha: 0.28, shade: 1, decal: true, ground: true });
  // a 5'10" person at the front-left corner
  const px = -1.4, py = -1.2, person = [];
  box(person, px - 0.22, py - 0.13, 0, px + 0.22, py + 0.13, 1.45, '#3d6fa8');
  box(person, px - 0.12, py - 0.12, 1.5, px + 0.12, py + 0.12, 1.78, '#e0b48e');
  for (const f of person) { f.shade = lightness(outward(f.pts, f.inside)); delete f.inside; faces.push(f); }
  const lines = [];
  const lc = [0.08, 0.08, 0.08, 0.08]; // white at 8%, premultiplied
  for (let x = x0; x <= x1 + 1e-6; x += step) lines.push(x, y0, 0.01, ...lc, x, y1, 0.01, ...lc);
  for (let y = y0; y <= y1 + 1e-6; y += step) lines.push(x0, y, 0.01, ...lc, x1, y, 0.01, ...lc);
  return { faces, lines, bounds: [x0, y0, x1, y1] };
}

/**
 * Orbitable perspective preview. Drag to orbit, wheel or pinch to zoom.
 * Uses WebGL (real depth buffer); without WebGL it falls back to a 2D canvas.
 */
export class TentPreview {
  constructor(canvas) {
    this.c = canvas;
    canvas.tentPreview = this; // handle for scripted camera control
    this.gl = canvas.getContext('webgl2', { antialias: true, premultipliedAlpha: true, alpha: true })
      || canvas.getContext('webgl', { antialias: true, premultipliedAlpha: true, alpha: true });
    if (this.gl) {
      this.glMesh = new MeshGL();
      canvas.style.background = 'linear-gradient(#2b3542, #151a21)';
      canvas.addEventListener('webglcontextlost', (e) => e.preventDefault());
      canvas.addEventListener('webglcontextrestored', () => { this.glMesh = new MeshGL(); this.built = null; this.draw(); });
    } else this.g = canvas.getContext('2d');
    this.yaw = -35; this.pitch = 24; this.zoom = 1;
    this.mesh = null; this.w = 10; this.l = 10; this.units = 'imperial'; this.built = null;
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

  set(w, l, tent, opts) { this.w = w; this.l = l; this.mesh = tentMesh(w, l, tent, opts); this.built = null; this.draw(); }
  view(yaw, pitch) { this.yaw = yaw; this.pitch = pitch; this.zoom = 1; this.draw(); }
  destroy() { this.ro.disconnect(); }

  /** Orbit camera around the tent; yaw 0 looks at the front (from -y). */
  camera() {
    const { w, l } = this, { spec } = this.mesh;
    const target = [w / 2, l / 2, spec.peak * 0.35];
    const R = Math.max(w, l, spec.peak * 1.6) * 1.55 / this.zoom;
    const yr = (this.yaw * Math.PI) / 180, pr = (this.pitch * Math.PI) / 180;
    const eye = [target[0] + R * Math.cos(pr) * Math.sin(yr), target[1] - R * Math.cos(pr) * Math.cos(yr), target[2] + R * Math.sin(pr)];
    return { target, eye, R };
  }

  draw() {
    const { c } = this;
    const dpr = window.devicePixelRatio || 1;
    const cw = c.clientWidth, ch = c.clientHeight;
    if (!cw || !ch || !this.mesh) return;
    if (c.width !== Math.round(cw * dpr) || c.height !== Math.round(ch * dpr)) { c.width = Math.round(cw * dpr); c.height = Math.round(ch * dpr); }
    if (this.gl) this.drawGL(cw, ch); else this.draw2D(cw, ch, dpr);
  }

  drawGL(cw, ch) {
    const gl = this.gl;
    if (!this.built) {
      const scene = previewScene(this.w, this.l, this.units);
      this.glMesh.set([...scene.faces, ...this.mesh.faces], scene.lines);
      this.built = true;
    }
    const { target, eye, R } = this.camera();
    const f = Math.min(cw, ch) * 1.25; // same framing as the 2D renderer
    const fovy = 2 * Math.atan(ch / 2 / f);
    const span = Math.max(this.w, this.l) * 2 + 20;
    const matrix = mul(perspective(fovy, cw / ch, Math.max(0.05, R / 200), R + span * 2), lookAt(eye, target, [0, 0, 1]));
    gl.viewport(0, 0, c_w(this.c), c_h(this.c));
    gl.clearColor(0, 0, 0, 0); gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    this.glMesh.draw(gl, matrix, eye);
  }

  /** Fallback without WebGL: painter's algorithm, sorted by each face's farthest point. */
  draw2D(cw, ch, dpr) {
    const g = this.g;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const sky = g.createLinearGradient(0, 0, 0, ch);
    sky.addColorStop(0, '#2b3542'); sky.addColorStop(1, '#151a21');
    g.fillStyle = sky; g.fillRect(0, 0, cw, ch);
    const { target, eye } = this.camera();
    const fwd = unit(sub(target, eye)), right = unit(cross(fwd, [0, 0, 1])), upv = cross(right, fwd);
    const f = Math.min(cw, ch) * 1.25;
    const proj = (p) => {
      const d = sub(p, eye), z = dot(d, fwd);
      if (z < 0.1) return null;
      return [cw / 2 + (dot(d, right) / z) * f, ch / 2 - (dot(d, upv) / z) * f, z];
    };
    const scene = previewScene(this.w, this.l, this.units);
    const fill = (pp, css) => { g.fillStyle = css; g.beginPath(); pp.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath(); g.fill(); };
    for (const fc of scene.faces.filter((x) => x.ground)) {
      const pp = fc.pts.map(proj);
      if (pp.every(Boolean)) fill(pp, fc.alpha < 1 ? `rgba(0,0,0,${fc.alpha})` : fc.color);
    }
    g.strokeStyle = 'rgba(255,255,255,.08)'; g.lineWidth = 1;
    for (let i = 0; i < scene.lines.length; i += 14) {
      const p = proj(scene.lines.slice(i, i + 3)), q = proj(scene.lines.slice(i + 7, i + 10));
      if (p && q) { g.beginPath(); g.moveTo(p[0], p[1]); g.lineTo(q[0], q[1]); g.stroke(); }
    }
    const drawn = [];
    for (const fc of [...scene.faces.filter((x) => !x.ground), ...this.mesh.faces]) {
      const pp = fc.pts.map(proj);
      if (pp.some((p) => !p)) continue;
      // farthest point first, panes after the wall they sit on
      drawn.push({ fc, pp, depth: Math.max(...pp.map((p) => p[2])) - (fc.decal ? 0.5 : 0) });
    }
    drawn.sort((a, b) => b.depth - a.depth);
    for (const { fc, pp } of drawn) {
      const [r, gg, b] = rgb(fc.color).map((v) => Math.round(Math.min(255, v * fc.shade)));
      fill(pp, `rgba(${r},${gg},${b},${fc.alpha})`);
      if (fc.alpha === 1) { g.strokeStyle = g.fillStyle; g.lineWidth = 0.6; g.stroke(); } // hide AA seams
    }
  }
}
const c_w = (c) => c.width, c_h = (c) => c.height;

/* ======================================================= Mapbox custom layer */
/**
 * A custom layer that draws `tents` ({ center:[lon,lat], rotation, width, length,
 * tent, color, ballast }) standing on the map. An item with `model` (a catalog id
 * with a mesh in vehicle3d.js, plus optional `paint`) is drawn as that vehicle. Geometry is built in metres around
 * one origin (east, north, up), so float32 stays precise at site scale.
 */
export function tentLayer(id = 'lm-tents3d') {
  const mesh = new MeshGL();
  let origin = null, map = null, gl = null, pending = [];

  function build(tents) {
    pending = tents;
    origin = tents.length ? tents[0].center : null;
    const faces = [];
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
        const own = t.model ? vehicleMesh(t.model, w, l, { color: t.paint }) : null;
        for (const f of own || tentMesh(w, l, t.tent, { color: t.color, ballast: t.ballast }).faces) faces.push({ ...f, pts: f.pts.map(toWorld) });
      }
    }
    mesh.set(faces);
    map?.triggerRepaint();
  }

  return {
    id, type: 'custom', renderingMode: '3d',
    setTents(tents) { build(tents); },
    onAdd(m, context) { map = m; gl = context; mesh.init(gl); build(pending); },
    onRemove() { map = null; gl = null; mesh.prog = null; mesh.vao = null; },
    render(context, matrix) {
      if (!origin || !map) return;
      const mc = globalThis.mapboxgl.MercatorCoordinate.fromLngLat(origin, 0);
      const s = mc.meterInMercatorCoordinateUnits();
      // metres (east, north, up) -> mercator (x east, y south, z up)
      const model = [s, 0, 0, 0, 0, -s, 0, 0, 0, 0, s, 0, mc.x, mc.y, 0, 1];
      // camera position in the same metres, to sort see-through faces back to front
      let eye = [0, 0, 1e6];
      try {
        const cam = map.getFreeCameraOptions().position;
        if (cam) eye = [(cam.x - mc.x) / s, -(cam.y - mc.y) / s, cam.z / s];
      } catch { /* older Mapbox: fixed order is still depth-correct for opaque faces */ }
      mesh.draw(context, mul(matrix, model), eye);
    },
  };
}
