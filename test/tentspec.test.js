import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FT, resolveTent, cleanTent, roofFaces, legs, quantities } from '../public/js/tentspec.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

test('defaults follow the tent size', () => {
  assert.equal(resolveTent(20 * FT, 20 * FT).roof, 'pyramid');
  assert.equal(resolveTent(20 * FT, 40 * FT).roof, 'hip');
  const cs = resolveTent(60 * FT, 120 * FT);
  assert.equal(cs.roof, 'gable');
  near(cs.bay, 5);
  assert.ok(cs.peak > cs.eave);
  // a peak at or below the legs is lifted just above them
  assert.ok(resolveTent(40 * FT, 40 * FT, { eave: 4, peak: 3 }).peak > 4);
});

test('cleanTent keeps only what the user set, clamped', () => {
  assert.equal(cleanTent({ roof: 'auto', walls: { front: 'none' } }), null);
  assert.deepEqual(cleanTent({ roof: 'gable', bay: 100, walls: { left: 'clear', top: 'solid' } }), { roof: 'gable', bay: 12, walls: { left: 'clear' } });
});

test('roof faces cover the footprint and meet at the ridge', () => {
  for (const [w, l, roof] of [[6, 6, 'pyramid'], [6, 12, 'hip'], [12, 6, 'hip'], [12, 18, 'gable']]) {
    const spec = resolveTent(w, l, { roof });
    const faces = roofFaces(w, l, spec);
    assert.equal(faces.length, 4);
    const top = Math.max(...faces.flatMap((f) => f.pts.map((p) => p[2])));
    near(top, spec.peak);
    // projected area of the sloped faces equals the footprint
    const plan = faces.filter((f) => !f.gable).reduce((s, f) => {
      let a = 0;
      f.pts.forEach((p, i) => { const q = f.pts[(i + 1) % f.pts.length]; a += p[0] * q[1] - q[0] * p[1]; });
      return s + Math.abs(a) / 2;
    }, 0);
    near(plan, w * l, 1e-6);
  }
});

test('legs and quote quantities', () => {
  const spec = resolveTent(20 * FT, 20 * FT);
  assert.equal(legs(20 * FT, 20 * FT, spec).length, 8); // corners plus a middle leg on each side
  const q = quantities(40 * FT, 60 * FT, resolveTent(40 * FT, 60 * FT, { walls: { left: 'solid', right: 'window' } }));
  near(q.wallLength, 120 * FT);
  assert.equal(q.blocks, q.legs * 2);
  assert.ok(q.roof > q.footprint);
});
