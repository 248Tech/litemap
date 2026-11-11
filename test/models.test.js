import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../server/config.js';
import { createApp } from '../server/app.js';
import { makeModelDoc, parseModelDoc, buildGlb, readGlb, fileStem, MODEL_FORMAT } from '../public/js/modelfile.js';

const FT = 0.3048;
const sample = { name: 'Gala 40×60', width: 40 * FT, length: 60 * FT, color: '#EFE6CF', tent: { roof: 'gable', eave: 3, walls: { front: 'clear', left: 'window', right: 'none' } } };

let server, base, dir;
before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'litemap-models-'));
  ({ server } = await createApp(loadConfig({ DATA_DIR: dir, MAPBOX_TOKEN: 'pk.x', LITEMAP_API_KEY: 'k', LITEMAP_AUTO_ADDRESS: '0' })));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.close(); await fs.rm(dir, { recursive: true, force: true }); });

const H = { 'X-API-Key': 'k', 'Content-Type': 'application/json' };
const call = (method, p, body) => fetch(`${base}/api/v1${p}`, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) });

test('makeModelDoc fills defaults, lowercases the colour and drops unset tent fields', () => {
  const d = makeModelDoc({ width: 6, length: 9 });
  assert.equal(d.format, MODEL_FORMAT);
  assert.equal(d.name, 'Untitled tent');
  assert.equal(d.ballast, true);
  assert.equal(d.tent, null);
  assert.equal(makeModelDoc(sample).color, '#efe6cf');
  assert.deepEqual(makeModelDoc(sample).tent.walls, { front: 'clear', left: 'window' });
});

test('makeModelDoc and parseModelDoc reject bad input with readable messages', () => {
  assert.throws(() => makeModelDoc({ width: 0, length: 5 }), /width must be/);
  assert.throws(() => makeModelDoc({ width: 5, length: 5000 }), /length must be/);
  assert.throws(() => makeModelDoc({ width: 5, length: 5, color: 'red' }), /#rrggbb/);
  assert.throws(() => parseModelDoc('{nope'), /not valid JSON/);
  assert.throws(() => parseModelDoc({ format: 'other' }), /not a LiteMap model/);
  assert.throws(() => parseModelDoc({ format: MODEL_FORMAT, version: 99, kind: 'tent' }), /version/);
  assert.throws(() => parseModelDoc({ format: MODEL_FORMAT, version: 1, kind: 'car' }), /kind/);
});

test('buildGlb writes a valid glTF binary that carries the editable recipe', () => {
  const glb = buildGlb(sample);
  const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  assert.equal(dv.getUint32(0, true), 0x46546c67, 'glTF magic');
  assert.equal(dv.getUint32(4, true), 2);
  assert.equal(dv.getUint32(8, true), glb.length, 'declared length matches');
  const jsonLen = dv.getUint32(12, true);
  assert.equal(jsonLen % 4, 0);
  const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLen)));
  assert.equal(json.asset.version, '2.0');
  const binLen = dv.getUint32(20 + jsonLen, true);
  assert.equal(json.buffers[0].byteLength, binLen);
  assert.equal(20 + jsonLen + 8 + binLen, glb.length);
  // opaque and see-through (clear wall, windows) faces are separate primitives
  assert.equal(json.meshes[0].primitives.length, 2);
  for (const a of json.accessors) assert.ok(a.count % 3 === 0 && a.count > 0);
  const pos = json.accessors[json.meshes[0].primitives[0].attributes.POSITION];
  // ground at y = 0, the tent stands up, footprint centred on the origin
  assert.ok(Math.abs(pos.min[1]) < 1e-6 && pos.max[1] > 3);
  // ballast plates reach about 1.1 m past the wall line on every side
  assert.ok(pos.min[0] < -sample.width / 2 && pos.min[0] > -sample.width / 2 - 1.3);
  assert.ok(pos.max[2] > sample.length / 2 && pos.max[2] < sample.length / 2 + 1.3);
  assert.deepEqual(readGlb(glb), makeModelDoc(sample), 'round-trips through the file');
});

test('ballast shows up in the 3D file and can be switched off', () => {
  const count = (d) => JSON.parse(new TextDecoder().decode(buildGlb(d).subarray(20, 20 + new DataView(buildGlb(d).buffer).getUint32(12, true)))).accessors[0].count;
  assert.ok(count({ ...sample, ballast: true }) > count({ ...sample, ballast: false }));
  assert.equal(readGlb(buildGlb({ ...sample, ballast: false })).ballast, false);
});

test('readGlb rejects other files', () => {
  assert.throws(() => readGlb(new Uint8Array(40)), /not a .glb/);
  assert.equal(fileStem('Gala 40×60 / main'), 'gala-40-60-main');
});

test('save, list, update, export and delete a model through the API', async () => {
  const res = await call('POST', '/models', sample);
  assert.equal(res.status, 201);
  const m = await res.json();
  assert.match(m.id, /^[\w-]{6,32}$/);
  assert.equal(m.kind, 'tent');
  assert.equal(m.color, '#efe6cf');
  assert.match(m.glbUrl, /\/api\/v1\/models\/.+\/glb$/);

  const list = await (await call('GET', '/models')).json();
  assert.equal(list.items.length, 1);

  const patched = await (await call('PATCH', `/models/${m.id}`, { name: 'Gala', tent: { roof: 'hip' }, ballast: false })).json();
  assert.equal(patched.name, 'Gala');
  assert.equal(patched.width, sample.width, 'untouched fields stay');
  assert.deepEqual(patched.tent, { roof: 'hip' });
  assert.equal(patched.ballast, false);

  const glb = await call('GET', `/models/${m.id}/glb`);
  assert.equal(glb.status, 200);
  assert.equal(glb.headers.get('content-type'), 'model/gltf-binary');
  assert.match(glb.headers.get('content-disposition'), /gala\.glb/);
  const bytes = new Uint8Array(await glb.arrayBuffer());
  assert.equal(readGlb(bytes).name, 'Gala');

  assert.equal((await call('DELETE', `/models/${m.id}`)).status, 204);
  assert.equal((await call('GET', `/models/${m.id}`)).status, 404);
});

test('the API accepts a model document and validates the tent settings strictly', async () => {
  const doc = makeModelDoc(sample);
  assert.equal((await call('POST', '/models', doc)).status, 201, 'a litemap-model file can be posted as is');
  const bad = async (body, re) => {
    const r = await call('POST', '/models', body);
    assert.equal(r.status, 400);
    assert.match((await r.json()).error.message, re);
  };
  await bad({ ...sample, tent: { peak: 3, eave: 4 } }, /peak must be higher/);
  await bad({ ...sample, tent: { roof: 'dome' } }, /roof must be one of/);
  await bad({ ...sample, tent: { walls: { top: 'solid' } } }, /unknown side/);
  await bad({ ...sample, width: -3 }, /width must be/);
  await bad([], /JSON object/);
});

test('a model is placed on a site as a tent reference that keeps its 3D settings', async () => {
  const m = await (await call('POST', '/models', { ...sample, name: 'Placed' })).json();
  const site = await (await call('POST', '/sites', { name: 'Park' })).json();
  const f = await call('POST', `/sites/${site.id}/features`, {
    type: 'Feature', geometry: { type: 'Point', coordinates: [-83.05, 42.33] },
    properties: { kind: 'reference', name: m.name, color: m.color, reference: { templateId: 'tent-40x60', width: m.width, length: m.length, rotation: 0, tent: m.tent } },
  });
  assert.equal(f.status, 201);
  const feature = await f.json();
  assert.equal(feature.properties.reference.tent.roof, 'gable');
  assert.equal(feature.properties.reference.tent.walls.front, 'clear');
});

test('/modeler serves the page and models require the API key', async () => {
  const page = await fetch(`${base}/modeler`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /3D Modeler/);
  assert.equal((await fetch(`${base}/api/v1/models`)).status, 401);
});
