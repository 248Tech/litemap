import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { IMAGERY_BY_ID, tileUrls, tileSizeOf, customSource, coversPoint, defaultGibsDate } from '../public/js/imagery.js';
import { parseDate, wktToGeoJSON, polygonToWkt, skyfiSearch } from '../server/imagery.js';
import { loadConfig } from '../server/config.js';
import { createApp } from '../server/app.js';

const PARK = [-83.2141, 42.5466]; // Shain Park, Birmingham, MI (public park)

test('tile url templates', () => {
  assert.equal(tileUrls(IMAGERY_BY_ID.esri)[0], 'https://services.arcgisonline.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}');
  assert.match(tileUrls(IMAGERY_BY_ID['gibs-hls-s30'], { date: '2025-06-10' })[0], /\/default\/2025-06-10\/GoogleMapsCompatible_Level12\/\{z\}\/\{y\}\/\{x\}\.png$/);
  assert.match(tileUrls(IMAGERY_BY_ID['mi-oakland-2025'])[0], /ImageServer\/exportImage\?bbox=\{bbox-epsg-3857\}&bboxSR=3857&imageSR=3857&size=512,512/);
  assert.equal(tileSizeOf(IMAGERY_BY_ID['mi-oakland-2025']), 512);
  const rel = { itemURL: 'https://wayback.maptiles.arcgis.com/.../MapServer/tile/63116/{level}/{row}/{col}' };
  assert.equal(tileUrls(IMAGERY_BY_ID.wayback, { release: rel })[0], 'https://wayback.maptiles.arcgis.com/.../MapServer/tile/63116/{z}/{y}/{x}');
  assert.match(defaultGibsDate(new Date('2026-01-05T12:00:00Z')), /^2026-01-02$/);
});

test('coverage bounds', () => {
  assert.ok(coversPoint(IMAGERY_BY_ID['mi-oakland-2025'], PARK));
  assert.ok(!coversPoint(IMAGERY_BY_ID['mi-oakland-2025'], [-94.58, 39.1]));
  assert.ok(coversPoint(IMAGERY_BY_ID.esri, [151.2, -33.9]));
});

test('custom sources are classified by URL', () => {
  assert.equal(customSource({ id: 'a', url: 'https://x/tiles/{z}/{x}/{y}.png' }).type, 'xyz');
  assert.equal(customSource({ id: 'b', url: 'https://gis.example.gov/arcgis/rest/services/Ortho2025/ImageServer/' }).type, 'arcgis-image');
  assert.equal(customSource({ id: 'c', url: 'https://gis.example.gov/arcgis/rest/services/Ortho/MapServer' }).type, 'arcgis-tile');
  assert.throws(() => customSource({ id: 'd', url: 'https://example.com/page.html' }));
});

test('date parsing', () => {
  assert.equal(parseDate('20250614'), '2025-06-14');
  assert.equal(parseDate('6/14/2025'), '2025-06-14');
  assert.equal(parseDate(1661558400000), '2022-08-27');
  assert.equal(parseDate('Null'), null);
});

test('WKT round trip', () => {
  const p = { type: 'Polygon', coordinates: [[[1, 2], [3, 4], [5, 2]]] };
  const wkt = polygonToWkt(p);
  assert.equal(wkt, 'POLYGON ((1 2, 3 4, 5 2, 1 2))');
  assert.deepEqual(wktToGeoJSON(wkt), { type: 'Polygon', coordinates: [[[1, 2], [3, 4], [5, 2], [1, 2]]] });
  const mp = wktToGeoJSON('MULTIPOLYGON (((0 0, 1 0, 1 1, 0 0)), ((5 5, 6 5, 6 6, 5 5)))');
  assert.equal(mp.coordinates.length, 2);
});

/* ---- fake SkyFi server, validating requests against their OpenAPI contract */
let fake, fakeUrl, lastReq;
const archive = (o) => ({
  archiveId: 'a1', identifier: 'x', provider: 'VANTOR', constellation: 'WorldView-3', productType: 'DAY', platformResolution: 31,
  resolution: 'VERY HIGH', captureTimestamp: '2026-08-02T16:20:11+00:00', cloudCoveragePercent: 3.5, offNadirAngle: 12.2,
  footprint: 'POLYGON ((-83.31 42.55, -83.28 42.55, -83.28 42.57, -83.31 42.57, -83.31 42.55))', minSqKm: 5, maxSqKm: 100,
  priceForOneSquareKm: 18, priceForOneSquareKmCents: 1800, priceFullScene: 900, totalAreaSquareKm: 50, gsd: 31,
  thumbnailUrls: { '300x300': 'https://example.com/t.png' }, tilesUrl: null, ...o,
});
before(async () => {
  fake = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    lastReq = { method: req.method, url: req.url, key: req.headers['x-skyfi-api-key'], body: body ? JSON.parse(body) : null };
    if (req.headers['x-skyfi-api-key'] !== 'sk-test') { res.writeHead(401).end('{"detail":"bad key"}'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ request: {}, archives: [archive({ archiveId: 'old', captureTimestamp: '2025-03-01T10:00:00+00:00' }), archive(), archive({ archiveId: 'free', openData: true, provider: 'SENTINEL2' })], nextPage: null }));
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  fakeUrl = `http://127.0.0.1:${fake.address().port}`;
});
after(() => fake.close());

test('skyfi search request and normalization', async () => {
  const aoi = { type: 'Polygon', coordinates: [[[-83.297, 42.5575], [-83.295, 42.5575], [-83.295, 42.559], [-83.297, 42.559], [-83.297, 42.5575]]] };
  const r = await skyfiSearch({ apiKey: 'sk-test', baseUrl: fakeUrl }, aoi, { fromDate: '2025-01-01', maxCloudCoveragePercent: 20, resolutions: ['VERY HIGH'] });
  assert.equal(lastReq.method, 'POST');
  assert.equal(lastReq.url, '/archives');
  assert.equal(lastReq.key, 'sk-test');
  assert.match(lastReq.body.aoi, /^POLYGON \(\(-83\.297 42\.5575, /);
  assert.equal(lastReq.body.fromDate, '2025-01-01T00:00:00+00:00');
  assert.match(lastReq.body.toDate, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+00:00$/);
  assert.deepEqual(lastReq.body.resolutions, ['VERY HIGH']);
  assert.deepEqual(lastReq.body.productTypes, ['DAY']);
  assert.equal(r.items[0].archiveId, 'a1', 'newest first');
  assert.equal(r.items.at(-1).archiveId, 'old');
  // AOI is ~0.027 km², so the 5 km² minimum order applies: 5 × $18
  assert.equal(r.items[0].billableSqKm, 5);
  assert.equal(r.items[0].estimatedPriceUsd, 90);
  assert.equal(r.items.find((i) => i.archiveId === 'free').estimatedPriceUsd, 0);
  assert.equal(r.items[0].footprint.type, 'Polygon');
  await assert.rejects(skyfiSearch({ apiKey: 'nope', baseUrl: fakeUrl }, aoi), /rejected the API key/);
  await assert.rejects(skyfiSearch({ apiKey: null }, aoi), (e) => e.code === 'skyfi_not_configured');
});

test('imagery API routes', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'litemap-'));
  const { server } = await createApp(loadConfig({ DATA_DIR: dir, MAPBOX_TOKEN: 'pk.x', SKYFI_API_KEY: 'sk-test', SKYFI_API_URL: fakeUrl, LITEMAP_AUTO_ADDRESS: '0' }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const src = await (await fetch(`${base}/imagery/sources`)).json();
  assert.equal(src.skyfi, true);
  assert.ok(src.items.some((s) => s.id === 'gibs-hls-s30'));
  const sky = await fetch(`${base}/imagery/skyfi/archives`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bbox: [-83.3, 42.55, -83.29, 42.56] }) });
  assert.equal(sky.status, 200);
  assert.equal((await sky.json()).items.length, 3);
  const bad = await fetch(`${base}/imagery/skyfi/archives`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bbox: [1, 2, 0, 1] }) });
  assert.equal(bad.status, 400);
  assert.equal((await fetch(`${base}/imagery/dates?lon=500&lat=0`)).status, 400);
  assert.equal((await fetch(`${base}/imagery/available-dates?source=esri&lon=-83&lat=42`)).status, 400, 'only daily layers');
  assert.equal((await fetch(`${base}/imagery/available-dates?source=gibs-hls-s30&lon=x&lat=42`)).status, 400);
  server.close();
  await fs.rm(dir, { recursive: true, force: true });
});
