import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { loadConfig } from '../server/config.js';
import { createApp } from '../server/app.js';
import { sniffImage } from '../server/objects.js';

/** Minimal valid RGBA PNG of w × h. */
function png(w, h) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h, 0x80);
  for (let y = 0; y < h; y++) raw[y * (w * 4 + 1)] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

let server, base, dir;
before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'litemap-obj-'));
  ({ server } = await createApp(loadConfig({ DATA_DIR: dir, MAPBOX_TOKEN: 'pk.x', LITEMAP_API_KEY: 'k' })));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.close(); await fs.rm(dir, { recursive: true, force: true }); });

const H = { 'X-API-Key': 'k' };

test('sniffImage reads dimensions and rejects non-images', () => {
  assert.deepEqual(sniffImage(png(40, 100)), { ext: 'png', width: 40, height: 100 });
  assert.throws(() => sniffImage(Buffer.from('GIF89a........................')), /PNG, WebP or JPEG/);
});

test('upload, list, place, patch and delete an object', async () => {
  const up = await fetch(`${base}/api/v1/objects?name=Frame%20tent&width=12.192`, { method: 'POST', headers: { ...H, 'Content-Type': 'image/png' }, body: png(40, 80) });
  assert.equal(up.status, 201);
  const o = await up.json();
  assert.equal(o.name, 'Frame tent');
  assert.ok(Math.abs(o.length - 24.384) < 1e-9, 'length follows the image aspect');
  assert.equal(o.pixelWidth, 40);
  assert.ok(o.imageUrl.endsWith(`/api/v1/objects/${o.id}/image`));

  // image is public and immutable
  const img = await fetch(o.imageUrl);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.match(img.headers.get('cache-control'), /immutable/);
  assert.equal(Buffer.from(await img.arrayBuffer()).length, o.bytes);

  // metadata requires the key
  assert.equal((await fetch(`${base}/api/v1/objects`)).status, 401);
  const list = await (await fetch(`${base}/api/v1/objects`, { headers: H })).json();
  assert.equal(list.items.length, 1);

  // place it on a site, stretched
  const site = await (await fetch(`${base}/api/v1/sites`, {
    method: 'POST', headers: { ...H, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'S', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [-83.3, 42.55] }, properties: { reference: { objectId: o.id, width: 12, length: 30, rotation: 45, opacity: 0.8, lockAspect: false } } }] }),
  })).json();
  const r = site.features.features[0].properties.reference;
  assert.equal(r.objectId, o.id);
  assert.equal(r.opacity, 0.8);
  assert.equal(r.lockAspect, false);
  assert.ok(Math.abs(site.features.features[0].properties.metrics.areaM2 - 360) < 0.5);

  const badRef = await fetch(`${base}/api/v1/sites/${site.id}/features`, {
    method: 'POST', headers: { ...H, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'Feature', geometry: { type: 'Point', coordinates: [-83.3, 42.55] }, properties: { reference: { objectId: '../../etc', width: 3 } } }),
  });
  assert.equal(badRef.status, 400);

  const patched = await (await fetch(`${base}/api/v1/objects/${o.id}`, { method: 'PATCH', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Tent 40x80', length: 25 }) })).json();
  assert.equal(patched.name, 'Tent 40x80');
  assert.equal(patched.length, 25);

  assert.equal((await fetch(`${base}/api/v1/objects/${o.id}`, { method: 'DELETE', headers: H })).status, 204);
  assert.equal((await fetch(o.imageUrl)).status, 404);
  assert.deepEqual(await fs.readdir(path.join(dir, 'objects')), []);
});

test('upload validation', async () => {
  const post = (q, body, ct = 'image/png') => fetch(`${base}/api/v1/objects?${q}`, { method: 'POST', headers: { ...H, 'Content-Type': ct }, body });
  assert.equal((await post('width=3', Buffer.from('hello'), 'text/plain')).status, 415);
  assert.equal((await post('width=3', Buffer.from('not really a png at all......'))).status, 400);
  assert.equal((await post('', png(4, 4))).status, 400);
  assert.equal((await post('width=-1', png(4, 4))).status, 400);
  assert.equal((await post('width=3', Buffer.alloc(9 * 1024 * 1024))).status, 413);
  assert.equal((await fetch(`${base}/api/v1/objects/nope/image`)).status, 404);
});
