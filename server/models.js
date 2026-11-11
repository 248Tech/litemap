/*
 * 3D model library: parametric tent models made in the 3D Modeler, kept as
 * `litemap-model` documents in <dataDir>/models.json. A model is placed on a
 * site as an ordinary tent reference (size, `reference.tent`, colour), so it
 * keeps its 3D look on the map, and it exports as a .glb for other tools.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { newId } from './store.js';
import { HttpError, validateTent } from './features.js';
import { makeModelDoc, parseModelDoc } from '../public/js/modelfile.js';

export const MODEL_ID_RE = /^[\w-]{6,32}$/;
const bad = (msg) => { throw new HttpError(400, 'invalid_request', msg); };

/** Accepts a `litemap-model` document or the bare fields; strict about the tent settings. */
export function readModelBody(body) {
  if (body == null || typeof body !== 'object' || Array.isArray(body)) bad('body must be a JSON object');
  try {
    if (body.tent != null) validateTent(body.tent);
    return body.format ? parseModelDoc(body) : makeModelDoc(body);
  } catch (e) {
    if (e instanceof HttpError) return bad(e.message.replace(/reference.tent/g, 'tent'));
    return bad(e.message);
  }
}

export class ModelLibrary {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'models.json');
    this.items = new Map();
    this.chain = Promise.resolve();
  }

  async load() {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    try {
      for (const m of JSON.parse(await fs.readFile(this.file, 'utf8')).models || []) this.items.set(m.id, m);
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
    return this;
  }

  persist() {
    const snap = JSON.stringify({ version: 1, models: [...this.items.values()] });
    this.chain = this.chain.then(async () => {
      const tmp = `${this.file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, snap);
      await fs.rename(tmp, this.file);
    });
    return this.chain;
  }

  list() { return [...this.items.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); }
  get(id) {
    const m = MODEL_ID_RE.test(id) ? this.items.get(id) : null;
    if (!m) throw new HttpError(404, 'not_found', `Model ${id} not found`);
    return m;
  }

  async create(body) {
    const doc = readModelBody(body);
    const now = new Date().toISOString();
    const m = { id: newId(9), ...doc, createdAt: now, updatedAt: now };
    this.items.set(m.id, m);
    await this.persist();
    return m;
  }

  async update(id, body) {
    const m = this.get(id);
    if (body == null || typeof body !== 'object' || Array.isArray(body)) bad('body must be a JSON object');
    const { id: _i, createdAt: _c, updatedAt: _u, ...mine } = m;
    const merged = readModelBody({ ...mine, ...body });
    Object.assign(m, merged, { updatedAt: new Date().toISOString() });
    if (!merged.tent) m.tent = null;
    await this.persist();
    return m;
  }

  async remove(id) {
    this.get(id);
    this.items.delete(id);
    await this.persist();
  }
}
