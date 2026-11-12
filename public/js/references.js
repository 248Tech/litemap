/*
 * Reference object catalog, shared by the UI and the API.
 * Dimensions are stored in meters. `width` is across, `length` is along the
 * object's rotation axis. Circles use `width` as the diameter.
 */
const ft = (v) => Math.round(v * 0.3048 * 1000) / 1000;

const TF = 'Frame & canopy tents';
const TC = 'Clearspan structures';
const TM = 'Clearspan structures (metric)';
const T = 'Stages & floors';
const V = 'Vehicles & equipment';
const S = 'Site furniture';
const P = 'Sports & venues';
const C = 'Custom';

/* Tent ids are stable (`tent-<w>x<l>` in feet, `tent-<w>x<l>m` in metres): saved sites refer to them. */
const tent = (w, l, category = w >= 50 ? TC : TF) => ({
  id: `tent-${w}x${l}`, category, name: `${category === TC ? 'Clearspan' : 'Tent'} ${w}×${l} ft`, shape: 'rect', width: ft(w), length: ft(l), color: '#ffffff',
});
const tentM = (w, l) => ({
  id: `tent-${w}x${l}m`, category: TM, name: `Clearspan ${w}×${l} m`, shape: 'rect', width: w, length: l, color: '#ffffff',
});
const sizes = (w, ls) => ls.map((l) => [w, l]);

const FRAME_TENTS = [
  ...sizes(10, [10, 15, 20, 30]), ...sizes(15, [15, 20, 30]), ...sizes(20, [20, 30, 40, 50, 60, 80]),
  ...sizes(30, [30, 40, 45, 50, 60, 75, 90, 105, 120]), ...sizes(40, [40, 60, 80, 100, 120, 140, 160]),
];
const CLEARSPANS = [
  ...sizes(50, [50, 75, 100, 125, 150]), ...sizes(60, [60, 90, 120, 150, 180, 210]),
  ...sizes(80, [80, 100, 120, 160, 200, 240]), ...sizes(100, [100, 150, 200, 250, 300]),
  ...sizes(120, [120, 150, 200, 250, 300]),
];
const METRIC = [
  ...sizes(10, [10, 15, 20, 25, 30, 40]), ...sizes(15, [15, 20, 25, 30, 40, 50]), ...sizes(20, [20, 25, 30, 40, 50, 60]),
  ...sizes(25, [25, 30, 40, 50, 60]), ...sizes(30, [30, 40, 50, 60, 80]), ...sizes(40, [40, 50, 60, 80, 100]),
];

export const REFERENCE_OBJECTS = [
  { id: 'tent-custom', category: TF, name: 'Custom tent', shape: 'rect', width: ft(30), length: ft(45), color: '#ffffff' },
  ...FRAME_TENTS.map(([w, l]) => tent(w, l)),
  ...CLEARSPANS.map(([w, l]) => tent(w, l)),
  ...METRIC.map(([w, l]) => tentM(w, l)),
  { id: 'stage-16x24', category: T, name: 'Stage 16×24 ft', shape: 'rect', width: ft(16), length: ft(24), color: '#bf5af2' },
  { id: 'dance-floor-20x20', category: T, name: 'Dance floor 20×20 ft', shape: 'rect', width: ft(20), length: ft(20), color: '#bf5af2' },

  { id: 'car', category: V, name: 'Car (sedan)', shape: 'rect', width: 1.85, length: 4.8, color: '#64d2ff' },
  { id: 'pickup', category: V, name: 'Pickup truck', shape: 'rect', width: 2.03, length: 5.9, color: '#64d2ff' },
  { id: 'box-truck-26', category: V, name: '26 ft box truck', shape: 'rect', width: ft(8.5), length: ft(34), color: '#64d2ff' },
  { id: 'semi-53', category: V, name: 'Tractor + 53 ft trailer', shape: 'rect', width: ft(8.5), length: ft(72), color: '#64d2ff' },
  { id: 'trailer-53', category: V, name: '53 ft trailer only', shape: 'rect', width: ft(8.5), length: ft(53), color: '#64d2ff' },
  { id: 'container-20', category: V, name: 'Shipping container 20 ft', shape: 'rect', width: ft(8), length: ft(20), color: '#ff9f0a' },
  { id: 'container-40', category: V, name: 'Shipping container 40 ft', shape: 'rect', width: ft(8), length: ft(40), color: '#ff9f0a' },
  { id: 'forklift', category: V, name: 'Forklift (5k lb)', shape: 'rect', width: 1.2, length: 3.4, color: '#ff9f0a' },
  // Avant 630 articulated loader (manufacturer drawing): 100.3 in long, 50.8 in wide on the wide tyres (40.6 in standard)
  { id: 'avant-630', category: V, name: 'Avant 630 loader', shape: 'rect', width: 1.29, length: 2.548, color: '#ff9f0a' },
  { id: 'boom-lift', category: V, name: 'Boom lift (60 ft)', shape: 'rect', width: ft(8), length: ft(30), color: '#ff9f0a' },
  { id: 'dumpster-30yd', category: V, name: 'Roll-off dumpster 30 yd', shape: 'rect', width: ft(8), length: ft(22), color: '#ff9f0a' },
  { id: 'generator-towable', category: V, name: 'Towable generator', shape: 'rect', width: ft(6.5), length: ft(14), color: '#ff9f0a' },

  { id: 'parking-stall', category: S, name: 'Parking stall 9×18 ft', shape: 'rect', width: ft(9), length: ft(18), color: '#30d158' },
  { id: 'portable-toilet', category: S, name: 'Portable toilet', shape: 'rect', width: ft(4), length: ft(4), color: '#30d158' },
  { id: 'banquet-table-8', category: S, name: '8 ft banquet table', shape: 'rect', width: ft(2.5), length: ft(8), color: '#30d158' },
  { id: 'round-table-60', category: S, name: '60" round w/ chairs', shape: 'circle', width: ft(10), length: ft(10), color: '#30d158' },
  { id: 'person', category: S, name: 'Person', shape: 'circle', width: 0.6, length: 0.6, color: '#ffd60a' },

  { id: 'basketball-court', category: P, name: 'Basketball court', shape: 'rect', width: ft(50), length: ft(94), color: '#ff375f' },
  { id: 'tennis-court', category: P, name: 'Tennis court', shape: 'rect', width: ft(36), length: ft(78), color: '#ff375f' },
  { id: 'pickleball-court', category: P, name: 'Pickleball court', shape: 'rect', width: ft(20), length: ft(44), color: '#ff375f' },
  { id: 'football-field', category: P, name: 'Football field (w/ end zones)', shape: 'rect', width: ft(160), length: ft(360), color: '#ff375f' },
  { id: 'soccer-pitch', category: P, name: 'Soccer pitch (FIFA)', shape: 'rect', width: 68, length: 105, color: '#ff375f' },

  { id: 'custom-rect', category: C, name: 'Custom rectangle', shape: 'rect', width: ft(20), length: ft(40), color: '#ffd60a' },
  { id: 'custom-circle', category: C, name: 'Custom circle', shape: 'circle', width: ft(30), length: ft(30), color: '#ffd60a' },
];

export const REFERENCE_CATEGORIES = [...new Set(REFERENCE_OBJECTS.map((r) => r.category))];
export const REFERENCE_BY_ID = Object.fromEntries(REFERENCE_OBJECTS.map((r) => [r.id, r]));

/**
 * Add a local catalog (data/catalog.json, loaded by the server and fetched by the
 * UI) in front of the built-in one. Items keep their own categories, listed
 * first in the order they appear; ids already in the catalog are skipped.
 */
export function addReferenceObjects(items) {
  const fresh = items.filter((r) => r && r.id && !REFERENCE_BY_ID[r.id]);
  if (!fresh.length) return 0;
  REFERENCE_OBJECTS.unshift(...fresh);
  for (const r of fresh) REFERENCE_BY_ID[r.id] = r;
  const cats = [...new Set(fresh.map((r) => r.category))].filter((c) => !REFERENCE_CATEGORIES.includes(c));
  REFERENCE_CATEGORIES.unshift(...cats);
  return fresh.length;
}
