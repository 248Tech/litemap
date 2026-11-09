/*
 * Uploaded-object library: cut-out images (PNG/WebP/JPEG) plus their default
 * real-world size. Images live in <dataDir>/objects/<id>.<ext>, metadata in
 * <dataDir>/objects.json. Placed on a site as reference features with
 * `reference.objectId`.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { newId } from './store.js';
import { HttpError } from './features.js';

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const TYPES = { png: 'image/png', webp: 'image/webp', jpg: 'image/jpeg' };
export const OBJECT_ID_RE = /^[\w-]{6,32}$/;

const bad = (msg) => { throw new HttpError(400, 'invalid_request', msg); };

/** Sniff the format from magic bytes; returns { ext, width, height } or throws. */
export function sniffImage(buf) {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47 && buf.toString('ascii', 12, 16) === 'IHDR') {
    return { ext: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length > 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = buf.toString('ascii', 12, 16);
    if (chunk === 'VP8X') return { ext: 'webp', width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
    if (chunk === 'VP8L') { const b = buf.readUInt32LE(21); return { ext: 'webp', width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 }; }
    if (chunk === 'VP8 ') return { ext: 'webp', width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    return { ext: 'webp', width: null, height: null };
  }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    for (let i = 2; i + 9 < buf.length;) {
      if (buf[i] !== 0xff) { i++; continue; }
      const m = buf[i + 1];
      if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return { ext: 'jpg', width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
      i += 2 + buf.readUInt16BE(i + 2);
    }
    return { ext: 'jpg', width: null, height: null };
  }
  return bad('image must be a PNG, WebP or JPEG');
}

const dim = (v, field, required) => {
  if (v == null || v === '') { if (required) bad(`${field} is required`); return undefined; }
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0.01 || n > 10000) bad(`${field} must be a number of meters between 0.01 and 10000`);
  return n;
};
const name = (v) => {
  const s = String(v ?? '').trim();
  if (s.length > 200) bad('name must be at most 200 characters');
  return s;
};

export class ObjectLibrary {
  constructor(dataDir) {
    this.dir = path.join(dataDir, 'objects');
    this.file = path.join(dataDir, 'objects.json');
    this.items = new Map();
    this.chain = Promise.resolve();
  }

  async load() {
    await fs.mkdir(this.dir, { recursive: true });
    try {
      for (const o of JSON.parse(await fs.readFile(this.file, 'utf8')).objects || []) this.items.set(o.id, o);
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
    return this;
  }

  persist() {
    const snap = JSON.stringify({ version: 1, objects: [...this.items.values()] });
    this.chain = this.chain.then(async () => {
      const tmp = `${this.file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, snap);
      await fs.rename(tmp, this.file);
    });
    return this.chain;
  }

  list() { return [...this.items.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  get(id) {
    const o = OBJECT_ID_RE.test(id) ? this.items.get(id) : null;
    if (!o) throw new HttpError(404, 'not_found', `Object ${id} not found`);
    return o;
  }

  /** `meta`: { name, width, length } (meters). Length defaults from the image aspect ratio. */
  async create(buf, meta) {
    if (!buf.length) bad('request body must be the image bytes');
    const img = sniffImage(buf);
    const width = dim(meta.width, 'width', true);
    const aspect = img.width && img.height ? img.height / img.width : null;
    const length = dim(meta.length, 'length', false) ?? (aspect ? width * aspect : bad('length is required for this image'));
    const now = new Date().toISOString();
    const o = {
      id: newId(9), name: name(meta.name) || 'Uploaded object', width, length,
      format: img.ext, contentType: TYPES[img.ext], pixelWidth: img.width, pixelHeight: img.height, bytes: buf.length,
      createdAt: now, updatedAt: now,
    };
    await fs.writeFile(path.join(this.dir, `${o.id}.${o.format}`), buf);
    this.items.set(o.id, o);
    await this.persist();
    return o;
  }

  async update(id, body) {
    const o = this.get(id);
    if (body == null || typeof body !== 'object' || Array.isArray(body)) bad('body must be a JSON object');
    if ('name' in body) o.name = name(body.name) || o.name;
    if ('width' in body) o.width = dim(body.width, 'width', true);
    if ('length' in body) o.length = dim(body.length, 'length', true);
    o.updatedAt = new Date().toISOString();
    await this.persist();
    return o;
  }

  async remove(id) {
    const o = this.get(id);
    this.items.delete(id);
    await fs.rm(path.join(this.dir, `${o.id}.${o.format}`), { force: true });
    await this.persist();
  }

  async read(id) {
    const o = this.get(id);
    return { object: o, data: await fs.readFile(path.join(this.dir, `${o.id}.${o.format}`)) };
  }
}
