import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { tileArea } from '../public/js/tiles.js';
import { parseImagine } from '../server/imagine.js';
import { loadConfig } from '../server/config.js';
import { createApp } from '../server/app.js';

test('a tile block is square, whole tiles, and sized by latitude', () => {
  const a = tileArea(-86.78, 36.16, 18, 2);
  assert.equal(a.z, 18);
  assert.equal(a.tiles, 2);
  assert.ok(Math.abs(a.width - a.length) < 1e-9);
  // 2 tiles at z18 are about 2 x 153 m at the equator, scaled by cos(36 deg)
  assert.ok(a.width > 235 && a.width < 255, `width ${a.width}`);
  const [w, s, e, n] = a.bbox;
  assert.ok(w < -86.78 && e > -86.78 && s < 36.16 && n > 36.16, 'the block covers the view centre');
  // a block edge sits exactly on a tile line: x = (lon + 180) / 360 * 2^z is a whole number
  assert.ok(Math.abs(((w + 180) / 360) * 2 ** 18 - Math.round(((w + 180) / 360) * 2 ** 18)) < 1e-6);
});

test('more tiles cover proportionally more ground; zoom and tiles are clamped', () => {
  const one = tileArea(10, 50, 17, 1), four = tileArea(10, 50, 17, 4);
  assert.ok(Math.abs(four.width / one.width - 4) < 0.01);
  assert.equal(tileArea(10, 50, 3, 9).z, 14);
  assert.equal(tileArea(10, 50, 3, 9).tiles, 4);
  assert.equal(tileArea(10, 50, 30, 0).z, 20);
});

test('the block stays on the map near the edges', () => {
  const a = tileArea(179.999, 84, 14, 4);
  assert.ok(a.bbox[2] <= 180 + 1e-9 && a.bbox[3] <= 85.06);
});

test('imagine requests are validated', () => {
  const ok = parseImagine({ lon: -86.78, lat: 36.16, zoom: 18.4, tiles: 3, prompt: '  a pond with a dock ' });
  assert.equal(ok.prompt, 'a pond with a dock');
  assert.equal(ok.quality, 'medium');
  assert.equal(ok.area.tiles, 3);
  for (const body of [
    null, [], { lon: 200, lat: 0, prompt: 'abc' }, { lon: 0, lat: 90, prompt: 'abc' },
    { lon: 0, lat: 0, tiles: 5, prompt: 'abc' }, { lon: 0, lat: 0, tiles: 1.5, prompt: 'abc' },
    { lon: 0, lat: 0, prompt: 'ab' }, { lon: 0, lat: 0, prompt: 'x'.repeat(1001) },
    { lon: 0, lat: 0, prompt: 'abc', quality: 'ultra' },
  ]) assert.throws(() => parseImagine(body), (e) => e.status === 400);
});

let server, base, dir;
before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'litemap-imagine-'));
  ({ server } = await createApp(loadConfig({ DATA_DIR: dir, MAPBOX_TOKEN: 'pk.test', LITEMAP_AUTO_ADDRESS: '0' })));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.close(); await fs.rm(dir, { recursive: true, force: true }); });

test('without an OpenAI key the feature is off and says so', async () => {
  const cfg = await (await fetch(`${base}/api/v1/map/config`)).json();
  assert.equal(cfg.imagine, false);
  const res = await fetch(`${base}/api/v1/imagine`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lon: 0, lat: 0, prompt: 'a lake' }) });
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error.code, 'ai_not_configured');
});
