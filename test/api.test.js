import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../server/config.js';
import { createApp } from '../server/app.js';
import { staticImageUrl } from '../server/mapbox.js';
import { localFrame, rectCornersXY } from '../public/js/geo.js';

const TOKEN = 'pk.test-token';
let server, base, dir;
const KEY = 'test-key';

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'litemap-'));
  const cfg = loadConfig({ DATA_DIR: dir, MAPBOX_TOKEN: TOKEN, LITEMAP_API_KEY: KEY });
  ({ server } = await createApp(cfg));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  server.close();
  await fs.rm(dir, { recursive: true, force: true });
});

const call = async (method, p, body, key = KEY) => {
  const res = await fetch(base + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(key ? { 'X-API-Key': key } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text && res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text, res };
};

const square = (origin, w, h) => {
  const f = localFrame(origin);
  const r = rectCornersXY(0, 0, w, h, 0).map(f.toLL);
  return { type: 'Polygon', coordinates: [[...r, r[0]]] };
};
const C = [-94.58, 39.1];

test('health and openapi are public', async () => {
  const h = await call('GET', '/api/v1/health', undefined, null);
  assert.equal(h.status, 200);
  assert.equal(h.body.mapbox, true);
  assert.equal(h.body.authRequired, true);
  const o = await call('GET', '/openapi.json', undefined, null);
  assert.equal(o.body.openapi, '3.1.0');
  assert.ok(o.body.paths['/api/v1/fit'].post);
});

test('map config is public and carries the token', async () => {
  const r = await call('GET', '/api/v1/map/config', undefined, null);
  assert.equal(r.status, 200);
  assert.equal(r.body.provider, 'mapbox');
  assert.equal(r.body.accessToken, TOKEN);
  assert.equal(r.body.styles.hybrid, 'satellite-streets-v12');
});

test('map config 503 without a token', async () => {
  const d2 = await fs.mkdtemp(path.join(os.tmpdir(), 'litemap-'));
  const { server: s2 } = await createApp(loadConfig({ DATA_DIR: d2 }));
  await new Promise((r) => s2.listen(0, '127.0.0.1', r));
  const r = await fetch(`http://127.0.0.1:${s2.address().port}/api/v1/map/config`);
  assert.equal(r.status, 503);
  assert.equal((await r.json()).error.code, 'mapbox_not_configured');
  s2.close();
  await fs.rm(d2, { recursive: true, force: true });
});

test('api key enforced', async () => {
  assert.equal((await call('GET', '/api/v1/sites', undefined, null)).status, 401);
  assert.equal((await call('GET', '/api/v1/sites', undefined, 'wrong')).status, 401);
  const r = await fetch(`${base}/api/v1/sites`, { headers: { Authorization: `Bearer ${KEY}` } });
  assert.equal(r.status, 200);
});

test('measure endpoint', async () => {
  const r = await call('POST', '/api/v1/measure', square(C, 100, 40));
  assert.equal(r.status, 200);
  assert.ok(Math.abs(r.body.items[0].metrics.areaM2 - 4000) < 0.5);
  const bad = await call('POST', '/api/v1/measure', { type: 'LineString', coordinates: [[0, 0]] });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, 'invalid_request');
});

test('site + feature lifecycle', async () => {
  const created = await call('POST', '/api/v1/sites', {
    name: 'Fairgrounds', tags: ['quote-1042'], metadata: { crmId: 'abc' },
    features: [
      { type: 'Feature', geometry: square(C, 60, 30), properties: { name: 'Lawn' } },
      { type: 'Feature', geometry: { type: 'LineString', coordinates: [C, [C[0] + 0.001, C[1]]] } },
      { type: 'Feature', geometry: { type: 'Point', coordinates: C }, properties: { reference: { templateId: 'tent-40x80', rotation: 90 } } },
    ],
  });
  assert.equal(created.status, 201);
  const s = created.body;
  assert.equal(s.summary.counts.area, 1);
  assert.equal(s.summary.counts.distance, 1);
  assert.equal(s.summary.counts.reference, 1);
  assert.ok(s.url.includes(`site=${s.id}`));
  const ref = s.features.features[2];
  assert.equal(ref.properties.kind, 'reference');
  assert.equal(ref.geometry.type, 'Polygon');
  assert.ok(Math.abs(ref.properties.metrics.areaM2 - 40 * 80 * 0.09290304) < 0.1);

  const add = await call('POST', `/api/v1/sites/${s.id}/features`, { type: 'Feature', geometry: { type: 'Point', coordinates: C }, properties: { name: 'Gate', color: '#00ff00' } });
  assert.equal(add.status, 201);
  assert.equal(add.body.properties.kind, 'marker');

  const txt = await call('POST', `/api/v1/sites/${s.id}/features`, { type: 'Feature', geometry: { type: 'Point', coordinates: C }, properties: { text: 'Gate code 1234\nUse north entrance', style: { size: 20, box: false } } });
  assert.equal(txt.status, 201);
  assert.equal(txt.body.properties.kind, 'text');
  assert.equal(txt.body.properties.name, 'Gate code 1234');
  assert.deepEqual(txt.body.properties.style, { size: 20, box: false });
  assert.equal((await call('POST', `/api/v1/sites/${s.id}/features`, { type: 'Feature', geometry: { type: 'Point', coordinates: C }, properties: { kind: 'text', text: '' } })).status, 400);
  const pen = await call('POST', `/api/v1/sites/${s.id}/features`, { type: 'Feature', geometry: { type: 'LineString', coordinates: [C, [C[0] + 0.0005, C[1]], [C[0] + 0.0005, C[1] + 0.0003]] }, properties: { kind: 'drawing', color: '#ff9f0a', style: { width: 6 } } });
  assert.equal(pen.status, 201);
  assert.equal(pen.body.properties.style.width, 6);
  assert.ok(pen.body.properties.metrics.lengthM > 40);
  await call('DELETE', `/api/v1/sites/${s.id}/features/${txt.body.id}`);
  await call('DELETE', `/api/v1/sites/${s.id}/features/${pen.body.id}`);

  const patched = await call('PATCH', `/api/v1/sites/${s.id}`, { name: 'Fairgrounds North' });
  assert.equal(patched.body.name, 'Fairgrounds North');
  assert.equal(patched.body.features.features.length, 4);
  assert.deepEqual(patched.body.metadata, { crmId: 'abc' });

  const list = await call('GET', '/api/v1/sites?q=north');
  assert.equal(list.body.total, 1);
  assert.equal(list.body.items[0].features, undefined);

  const fit = await call('POST', '/api/v1/fit', { siteId: s.id, featureId: s.features.features[0].id, templateId: 'tent-40x80', clearance: 1.5 });
  assert.equal(fit.body.fits, true);

  const del = await call('DELETE', `/api/v1/sites/${s.id}/features/${add.body.id}`);
  assert.equal(del.status, 204);
  assert.equal((await call('GET', `/api/v1/sites/${s.id}`)).body.features.features.length, 3);

  const gj = await call('GET', `/api/v1/sites/${s.id}/geojson`);
  assert.equal(gj.res.headers.get('content-type'), 'application/geo+json');

  const snap = await call('GET', `/api/v1/sites/${s.id}/snapshot?size=640x480`);
  assert.ok(snap.body.url.startsWith('https://api.mapbox.com/styles/v1/mapbox/satellite-v9/static/geojson('), snap.body.url.slice(0, 120));
  assert.ok(snap.body.url.includes('/auto/640x480@2x?'));

  assert.equal((await call('DELETE', `/api/v1/sites/${s.id}`)).status, 204);
  assert.equal((await call('GET', `/api/v1/sites/${s.id}`)).status, 404);
});

test('fit with findLargest, and pack', async () => {
  const fit = await call('POST', '/api/v1/fit', { polygon: square(C, 20, 40), width: 10, length: 10, findLargest: true });
  assert.equal(fit.body.fits, true);
  assert.ok(Math.abs(fit.body.largest.scale - 2) < 0.02);
  const pack = await call('POST', '/api/v1/pack', { polygon: square(C, 20.01, 40.01), width: 5, length: 10, includeFootprints: true });
  assert.equal(pack.body.count, 16);
  assert.equal(pack.body.footprints.length, 16);
});

test('static image url encodes a simplestyle overlay', () => {
  const features = [{ type: 'Feature', geometry: square(C, 30, 20), properties: { kind: 'area', color: '#30d158' } }];
  const url = staticImageUrl({ serverToken: TOKEN }, { features, size: '600x400', mapType: 'hybrid' });
  const overlay = JSON.parse(decodeURIComponent(url.match(/geojson\((.*)\)\/auto/)[1]));
  assert.equal(overlay.features[0].properties.fill, '#30d158');
  assert.ok(url.includes('satellite-streets-v12'));
  assert.ok(url.endsWith(`access_token=${TOKEN}`));
  const empty = staticImageUrl({ serverToken: TOKEN }, { features: [], center: C, zoom: 18 });
  assert.match(empty, /static\/-94\.580000,39\.100000,18\//);
});

test('static UI is served', async () => {
  const r = await fetch(`${base}/`);
  assert.equal(r.status, 200);
  assert.match(await r.text(), /LiteMap/);
  assert.equal((await fetch(`${base}/../server/config.js`)).status, 404);
});
