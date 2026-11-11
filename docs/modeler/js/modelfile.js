/*
 * Portable 3D models: the `litemap-model` document and its glTF binary (.glb)
 * export. Pure (no DOM), so the 3D Modeler page and the API export the same file.
 *
 * A model document holds the parametric recipe (size, roof, legs, walls, fabric,
 * ballast); the map renders it from that recipe, so a placed model stays editable
 * and stays 3D. The .glb carries the same recipe in `asset.extras.litemap`, so a
 * file exported for another tool can be imported back here without loss.
 */
import { cleanTent, FT } from './tentspec.js';
import { tentMesh } from './tent3d.js';

export const MODEL_FORMAT = 'litemap-model';
export const MODEL_VERSION = 1;
export const MODEL_LIMITS = { width: [1, 200], length: [1, 400] };
export const DEFAULT_FABRIC = '#f6f6f3';

const HEX = /^#[0-9a-fA-F]{6}$/;

/** Build a clean model document from loose fields (metres). Throws Error with a readable message. */
export function makeModelDoc({ name, width, length, tent = null, color = DEFAULT_FABRIC, ballast = true } = {}) {
  const dim = (v, field) => {
    const n = Number(v);
    const [min, max] = MODEL_LIMITS[field];
    if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${field} must be a number of metres from ${min} to ${max}`);
    return n;
  };
  const label = String(name ?? '').trim();
  if (label.length > 200) throw new Error('name must be at most 200 characters');
  if (!HEX.test(color)) throw new Error('color must be a #rrggbb hex colour');
  return {
    format: MODEL_FORMAT, version: MODEL_VERSION, kind: 'tent',
    name: label || 'Untitled tent',
    width: dim(width, 'width'), length: dim(length, 'length'),
    color: color.toLowerCase(), ballast: ballast !== false,
    tent: cleanTent(tent),
  };
}

/** Parse and validate a `litemap-model` document (object or JSON text). */
export function parseModelDoc(input) {
  let d = input;
  if (typeof input === 'string') {
    try { d = JSON.parse(input); } catch { throw new Error('not valid JSON'); }
  }
  if (!d || typeof d !== 'object' || Array.isArray(d)) throw new Error('a model must be a JSON object');
  if (d.format !== MODEL_FORMAT) throw new Error(`not a LiteMap model (format must be "${MODEL_FORMAT}")`);
  if (!(d.version >= 1 && d.version <= MODEL_VERSION)) throw new Error(`unsupported model version ${d.version}`);
  if (d.kind !== 'tent') throw new Error(`unsupported model kind "${d.kind}" (only "tent" so far)`);
  return makeModelDoc(d);
}

/* ------------------------------------------------------------------ glb */
const srgb = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const rgb = (hex) => { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => srgb(v / 255)); };

/**
 * glTF 2.0 binary for a model: metres, +Y up, ground at y = 0, footprint centred
 * on the origin, the front of the tent facing +Z. Opaque and see-through (clear
 * wall, window pane) faces are separate primitives so viewers blend correctly.
 */
export function buildGlb(input) {
  const doc = makeModelDoc(input);
  const { width: w, length: l } = doc;
  const { faces } = tentMesh(w, l, doc.tent, { color: doc.color, ballast: doc.ballast });
  // local (x across, y front->back, z up) -> glTF (x, y up, z toward the viewer): a pure rotation
  const toGl = ([x, y, z]) => [x - w / 2, z, l / 2 - y];
  const groups = { opaque: { pos: [], col: [] }, blend: { pos: [], col: [] } };
  for (const f of faces) {
    const g = f.alpha < 1 ? groups.blend : groups.opaque;
    const c = rgb(f.color), p = f.pts.map(toGl);
    for (let i = 1; i < p.length - 1; i++) for (const q of [p[0], p[i], p[i + 1]]) { g.pos.push(...q); g.col.push(...c, f.alpha); }
  }

  const bufferViews = [], accessors = [], primitives = [], chunks = [];
  let offset = 0;
  const push = (arr, target) => {
    const data = new Float32Array(arr);
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: data.byteLength, target });
    chunks.push(data);
    offset += data.byteLength;
    return bufferViews.length - 1;
  };
  [['opaque', 0], ['blend', 1]].forEach(([k, material]) => {
    const g = groups[k];
    if (!g.pos.length) return;
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < g.pos.length; i += 3) for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a], g.pos[i + a]); max[a] = Math.max(max[a], g.pos[i + a]); }
    const count = g.pos.length / 3;
    accessors.push({ bufferView: push(g.pos, 34962), componentType: 5126, count, type: 'VEC3', min, max });
    const pos = accessors.length - 1;
    accessors.push({ bufferView: push(g.col, 34962), componentType: 5126, count, type: 'VEC4' });
    primitives.push({ attributes: { POSITION: pos, COLOR_0: pos + 1 }, material, mode: 4 });
  });

  const pbr = { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 0.85 };
  const json = {
    asset: { version: '2.0', generator: 'LiteMap 3D Modeler', extras: { litemap: doc } },
    scene: 0, scenes: [{ name: doc.name, nodes: [0] }],
    nodes: [{ name: doc.name, mesh: 0 }],
    meshes: [{ name: doc.name, primitives }],
    materials: [{ name: 'Solid', pbrMetallicRoughness: pbr, doubleSided: true }, { name: 'See-through', pbrMetallicRoughness: pbr, alphaMode: 'BLEND', doubleSided: true }],
    accessors, bufferViews, buffers: [{ byteLength: offset }],
  };

  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonLen = Math.ceil(jsonBytes.length / 4) * 4;
  const total = 12 + 8 + jsonLen + 8 + offset;
  const out = new Uint8Array(total), dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, total, true);
  dv.setUint32(12, jsonLen, true); dv.setUint32(16, 0x4e4f534a, true);
  out.set(jsonBytes, 20); out.fill(0x20, 20 + jsonBytes.length, 20 + jsonLen);
  let p = 20 + jsonLen;
  dv.setUint32(p, offset, true); dv.setUint32(p + 4, 0x004e4942, true); p += 8;
  for (const c of chunks) { out.set(new Uint8Array(c.buffer), p); p += c.byteLength; }
  return out;
}

/** Recover the model document from a .glb written by `buildGlb`. */
export function readGlb(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (u8.length < 20 || dv.getUint32(0, true) !== 0x46546c67) throw new Error('not a .glb file');
  const len = dv.getUint32(12, true);
  if (dv.getUint32(16, true) !== 0x4e4f534a || 20 + len > u8.length) throw new Error('damaged .glb file');
  let json;
  try { json = JSON.parse(new TextDecoder().decode(u8.subarray(20, 20 + len))); } catch { throw new Error('damaged .glb file'); }
  const doc = json.asset?.extras?.litemap;
  if (!doc) throw new Error('this .glb was not made by LiteMap, so it has no editable model inside');
  return parseModelDoc(doc);
}

/** Safe file stem for downloads. */
export const fileStem = (name) => String(name || 'tent').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'tent';

export { FT };
