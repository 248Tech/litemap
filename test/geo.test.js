import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as geo from '../public/js/geo.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} expected ${b} ±${tol}, got ${a}`);

/** Build an axis-aligned lot of w×h meters (east×north) at a given origin. */
function lot(origin, w, h, rot = 0) {
  const f = geo.localFrame(origin);
  const ring = geo.rectCornersXY(0, 0, w, h, rot).map(f.toLL);
  return { type: 'Polygon', coordinates: [[...ring, ring[0]]] };
}
const KC = [-94.5786, 39.0997];

test('vincenty distance matches known geodesics', () => {
  // 1 degree of latitude at the equator on WGS84 = 110574.389 m
  near(geo.distance([0, 0], [0, 1]), 110574.389, 0.01);
  // 1 degree of longitude at the equator = 111319.491 m
  near(geo.distance([0, 0], [1, 0]), 111319.491, 0.01);
  // Flinders Peak -> Buninyong (Vincenty's classic test) = 54972.271 m
  near(geo.distance([144.42486788888, -37.95103341666], [143.92649552777, -37.65282113888]), 54972.271, 0.01);
});

test('local frame round-trips and agrees with vincenty', () => {
  const f = geo.localFrame(KC);
  const p = f.toLL([300, -200]);
  const back = f.toXY(p);
  near(back[0], 300, 1e-6); near(back[1], -200, 1e-6);
  near(geo.distance(KC, p), Math.hypot(300, 200), 0.05, 'site-scale distance');
});

test('area of a 100 m x 50 m lot', () => {
  const g = lot(KC, 100, 50, 23);
  const m = geo.measureGeometry(g);
  near(m.areaM2, 5000, 0.5);
  near(m.perimeterM, 300, 0.05);
  assert.equal(m.vertices, 4);
});

test('one acre is one acre', () => {
  const side = Math.sqrt(geo.ACRE);
  near(geo.measureGeometry(lot([-80, 35], side, side)).areaM2 / geo.ACRE, 1, 1e-4);
});

test('large polygon uses spherical area', () => {
  // 1°×1° cell at equator ≈ 12,309 km²
  const g = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] };
  near(geo.measureGeometry(g).areaM2 / 1e6, 12308.8, 15);
});

test('footprint ring has the requested area and rotation', () => {
  const ring = geo.footprintRing({ center: KC, width: 12.192, length: 24.384, rotation: 30 });
  near(geo.ringArea(ring), 12.192 * 24.384, 0.05);
  near(geo.distance(ring[1], ring[2]), 24.384, 0.01, 'length edge');
  near(geo.bearing(ring[1], ring[2]), 30, 0.05, 'length axis bearing');
  const withClear = geo.footprintRing({ center: KC, width: 10, length: 20, clearance: 2 });
  near(geo.ringArea(withClear), 14 * 24, 0.05);
});

test('fit: 40x80 ft tent fits a 60x100 ft lot, not a 35x100 ft lot', () => {
  const FT = geo.FT;
  const tent = { width: 40 * FT, length: 80 * FT };
  const yes = geo.fitFootprint(lot(KC, 60 * FT, 100 * FT, 17), tent);
  assert.equal(yes.fits, true);
  near(yes.slackM, 10 * FT, 0.05, 'centered slack');
  near(((yes.rotation - 17) % 180 + 180) % 180, 0, 0.5, 'aligned with lot');
  assert.equal(geo.fitFootprint(lot(KC, 35 * FT, 100 * FT), tent).fits, false);
  // clearance of 5 ft per side on a 50x90 lot is exactly enough
  assert.equal(geo.fitFootprint(lot(KC, 50.5 * FT, 90.5 * FT), { ...tent, clearance: 5 * FT }).fits, true);
  assert.equal(geo.fitFootprint(lot(KC, 49 * FT, 90 * FT), { ...tent, clearance: 5 * FT }).fits, false);
});

test('fit: rotates to use a diagonal / L-shaped lot', () => {
  const f = geo.localFrame(KC);
  // L-shape: 40x10 bottom bar + 10x40 left bar
  const L = [[0, 0], [40, 0], [40, 10], [10, 10], [10, 40], [0, 40]].map(f.toLL);
  const poly = { type: 'Polygon', coordinates: [[...L, L[0]]] };
  assert.equal(geo.fitFootprint(poly, { width: 8, length: 35 }).fits, true);
  assert.equal(geo.fitFootprint(poly, { width: 12, length: 12 }).fits, false);
  const c = geo.fitFootprint(poly, { shape: 'circle', width: 9 });
  assert.equal(c.fits, true);
});

test('largestFit finds the max scale', () => {
  const r = geo.largestFit(lot(KC, 30, 60), { width: 10, length: 20 });
  near(r.scale, 3, 0.02);
});

test('pack: parking stalls in a 90x180 ft lot', () => {
  const FT = geo.FT;
  const r = geo.packFootprints(lot(KC, 90 * FT + 0.01, 180 * FT + 0.01, 40), { width: 9 * FT, length: 18 * FT });
  assert.equal(r.count, 100);
  assert.equal(r.centers.length, 100);
});

test('formatting', () => {
  assert.equal(geo.fmtLength(30.48), '100 ft');
  assert.equal(geo.fmtLength(10, 'metric'), '10 m');
  assert.equal(geo.fmtArea(geo.ACRE, 'imperial'), '43,560 ft² · 1 ac');
  assert.equal(geo.fmtArea(20000, 'metric'), '20,000 m² · 2 ha');
});
