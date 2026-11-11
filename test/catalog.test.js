import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../server/config.js';
import { createApp } from '../server/app.js';

let server, base, dir;
before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'litemap-cat-'));
  await fs.writeFile(path.join(dir, 'catalog.json'), JSON.stringify({ items: [
    { id: 'tent-acme-40x60-hip', category: 'Our tents', name: '40×60 hip', width: 12.192, length: 18.288, tent: { roof: 'hip', eave: 2.44, walls: { back: 'solid' } } },
    { id: 'BAD ID', name: 'skipped', width: 1, length: 1 },
    { id: 'tent-acme-zero', name: 'skipped too', width: 0 },
  ] }));
  ({ server } = await createApp(loadConfig({ DATA_DIR: dir, LITEMAP_AUTO_ADDRESS: '0' })));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.close(); await fs.rm(dir, { recursive: true, force: true }); });

const call = async (method, p, body) => {
  const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};

test('data/catalog.json joins the catalog first; bad entries are skipped', async () => {
  const { body } = await call('GET', '/api/v1/reference-objects');
  assert.equal(body.items[0].id, 'tent-acme-40x60-hip');
  assert.equal(body.items[0].category, 'Our tents');
  assert.ok(!body.items.some((i) => /skipped/.test(i.name)));
});

test('a catalog tent brings its own roof, heights and walls unless the request sets them', async () => {
  const pt = { type: 'Point', coordinates: [-83, 42.5] };
  const site = await call('POST', '/api/v1/sites', { name: 'Cat', features: [
    { type: 'Feature', geometry: pt, properties: { reference: { templateId: 'tent-acme-40x60-hip' } } },
    { type: 'Feature', geometry: pt, properties: { reference: { templateId: 'tent-acme-40x60-hip', tent: { roof: 'gable' } } } },
  ] });
  assert.equal(site.status, 201);
  const [a, b] = site.body.features.features.map((f) => f.properties.reference);
  assert.deepEqual(a.tent, { roof: 'hip', eave: 2.44, walls: { back: 'solid' } });
  assert.equal(a.width, 12.192);
  assert.deepEqual(b.tent, { roof: 'gable' });
});
