/* Tiny JSON-file store with atomic, serialized writes. Good for thousands of sites. */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export const newId = (bytes = 9) => crypto.randomBytes(bytes).toString('base64url');

export class Store {
  constructor(file) {
    this.file = file;
    this.sites = new Map();
    this.chain = Promise.resolve();
  }

  async load() {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    try {
      const raw = JSON.parse(await fs.readFile(this.file, 'utf8'));
      for (const s of raw.sites || []) this.sites.set(s.id, s);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    return this;
  }

  persist() {
    const snapshot = JSON.stringify({ version: 1, sites: [...this.sites.values()] });
    this.chain = this.chain.then(async () => {
      const tmp = `${this.file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, snapshot);
      await fs.rename(tmp, this.file);
    });
    return this.chain;
  }

  list() { return [...this.sites.values()]; }
  get(id) { return this.sites.get(id) || null; }

  async put(site) {
    this.sites.set(site.id, site);
    await this.persist();
    return site;
  }

  async delete(id) {
    const had = this.sites.delete(id);
    if (had) await this.persist();
    return had;
  }
}
