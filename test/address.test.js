import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../server/config.js';
import { createApp, siteLocation } from '../server/app.js';

// A fake reverse geocoder: no network, and it records every lookup.
const lookups = [];
const reverseGeocode = async ([lon, lat]) => {
  lookups.push([lon, lat]);
  if (lat > 80) throw new Error('upstream down');
  return `${lon.toFixed(3)},${lat.toFixed(3)} Main St`;
};

let server, base, dir;
before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'litemap-addr-'));
  // a site saved before addresses existed, to be backfilled at startup
  await fs.writeFile(path.join(dir, 'sites.json'), JSON.stringify({
    version: 1,
    sites: [{ id: 'old', name: 'Old', description: '', tags: [], metadata: {}, units: 'imperial', view: { center: [-83, 42.5] }, features: [], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }],
  }));
  const app = await createApp(loadConfig({ DATA_DIR: dir }), { reverseGeocode });
  ({ server } = app);
  await app.addressBackfill;
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.close(); await fs.rm(dir, { recursive: true, force: true }); });

const call = async (method, p, body) => {
  const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
};
const pin = (lon, lat) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] }, properties: {} });

test('siteLocation uses the middle of the features, else the view', () => {
  assert.deepEqual(siteLocation({ features: [pin(0, 0), pin(2, 2)] }), [1, 1]);
  assert.deepEqual(siteLocation({ features: [], view: { center: [5, 6] } }), [5, 6]);
  assert.equal(siteLocation({ features: [] }), null);
});

test('sites saved before addresses existed are backfilled at startup', async () => {
  const s = (await call('GET', '/api/v1/sites/old')).body;
  assert.equal(s.address, '-83.000,42.500 Main St');
  assert.equal(s.addressAuto, true);
  assert.equal('addressPoint' in s, false, 'internal lookup point is not exposed');
});

test('automatic address: found on create, kept while the site stays put, refreshed when it moves', async () => {
  const c = await call('POST', '/api/v1/sites', { name: 'A', features: [pin(-83.2, 42.54)] });
  assert.equal(c.status, 201);
  assert.equal(c.body.address, '-83.200,42.540 Main St');
  assert.equal(c.body.addressAuto, true);

  const n = lookups.length;
  // small nudge (~10 m) and a save that sends address: '' (the UI does this for automatic addresses)
  const same = await call('PUT', `/api/v1/sites/${c.body.id}`, { name: 'A', address: '', features: [pin(-83.2001, 42.54)] });
  assert.equal(same.body.address, '-83.200,42.540 Main St');
  assert.equal(lookups.length, n, 'no new lookup for a tiny move');

  // moved ~1 km: looked up again
  const moved = await call('PATCH', `/api/v1/sites/${c.body.id}`, { features: [pin(-83.21, 42.548)] });
  assert.equal(moved.body.address, '-83.210,42.548 Main St');

  const found = await call('GET', '/api/v1/sites?q=42.548%20main');
  assert.ok(found.body.items.some((s) => s.id === c.body.id), 'sites search matches the address');
});

test('a typed address is kept even when the site moves, and clearing it goes back to automatic', async () => {
  const c = await call('POST', '/api/v1/sites', { name: 'B', view: { center: [-83, 42] }, address: '1 Tent Way, Springfield, IL' });
  assert.equal(c.body.address, '1 Tent Way, Springfield, IL');
  assert.equal(c.body.addressAuto, false);

  const moved = await call('PUT', `/api/v1/sites/${c.body.id}`, { name: 'B', features: [pin(-80, 40)] });
  assert.equal(moved.body.address, '1 Tent Way, Springfield, IL', 'PUT without address keeps it');

  const cleared = await call('PATCH', `/api/v1/sites/${c.body.id}`, { address: '' });
  assert.equal(cleared.body.addressAuto, true);
  assert.equal(cleared.body.address, '-80.000,40.000 Main St');

  assert.equal((await call('PATCH', `/api/v1/sites/${c.body.id}`, { address: 42 })).status, 400);
  assert.equal((await call('PATCH', `/api/v1/sites/${c.body.id}`, { address: 'x'.repeat(301) })).status, 400);
});

test('a failed lookup never fails the save', async () => {
  const c = await call('POST', '/api/v1/sites', { name: 'North', features: [pin(0, 85)] });
  assert.equal(c.status, 201);
  assert.equal(c.body.address, '');
  assert.equal(c.body.addressAuto, true);
});
