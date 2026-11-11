/*
 * Local object catalog: data/catalog.json (git-ignored, so a company's own tent
 * list never ships with the open-source app). Same shape as the built-in
 * catalog, in metres:
 *
 *   { "items": [ { "id": "tent-ast-40x60-aztec", "category": "AST · Clearspan structures",
 *                  "name": "Aztec hip clearspan 40×60 ft", "shape": "rect", "width": 12.192, "length": 18.288,
 *                  "color": "#ffffff", "tent": { "roof": "hip", "eave": 2.44 }, "notes": "…" } ] }
 *
 * Tent ids must start with "tent-" to get tent skins, the 3D view and the builder.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { addReferenceObjects } from '../public/js/references.js';
import { cleanTent, isTent } from '../public/js/tentspec.js';

const ID = /^[a-z0-9][a-z0-9._-]{1,79}$/;

export async function loadLocalCatalog(dataDir) {
  let raw;
  try { raw = await fs.readFile(path.join(dataDir, 'catalog.json'), 'utf8'); } catch { return 0; }
  let items;
  try { items = JSON.parse(raw).items; } catch (e) { console.warn(`catalog.json ignored: ${e.message}`); return 0; }
  if (!Array.isArray(items)) return 0;
  const ok = [];
  for (const it of items) {
    const w = Number(it?.width), l = Number(it?.length ?? it?.width);
    if (!it || !ID.test(String(it.id)) || !(w > 0 && w < 10000) || !(l > 0 && l < 10000) || !it.name) {
      console.warn(`catalog.json: skipped ${JSON.stringify(it?.id ?? it)}`);
      continue;
    }
    const item = {
      id: String(it.id), category: String(it.category || 'My catalog').slice(0, 60), name: String(it.name).slice(0, 80),
      shape: it.shape === 'circle' ? 'circle' : 'rect', width: w, length: it.shape === 'circle' ? w : l,
      color: /^#[0-9a-f]{6}$/i.test(it.color || '') ? it.color : '#ffffff',
    };
    if (isTent(item.id)) { const t = cleanTent(it.tent); if (t) item.tent = t; }
    if (it.notes) item.notes = String(it.notes).slice(0, 500);
    ok.push(item);
  }
  const n = addReferenceObjects(ok);
  if (n) console.log(`Loaded ${n} catalog objects from ${path.join(dataDir, 'catalog.json')}`);
  return n;
}
