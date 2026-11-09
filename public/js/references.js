/*
 * Reference object catalog, shared by the UI and the API.
 * Dimensions are stored in meters. `width` is across, `length` is along the
 * object's rotation axis. Circles use `width` as the diameter.
 */
const ft = (v) => Math.round(v * 0.3048 * 1000) / 1000;

const T = 'Tents & structures';
const V = 'Vehicles & equipment';
const S = 'Site furniture';
const P = 'Sports & venues';
const C = 'Custom';

const tent = (w, l, extra = {}) => ({
  id: `tent-${w}x${l}`, category: T, name: `Tent ${w}×${l} ft`, shape: 'rect', width: ft(w), length: ft(l), color: '#ffffff', ...extra,
});

export const REFERENCE_OBJECTS = [
  tent(10, 10), tent(10, 20), tent(20, 20), tent(20, 30), tent(20, 40), tent(30, 30), tent(30, 45),
  tent(30, 60), tent(40, 40), tent(40, 60), tent(40, 80), tent(40, 100), tent(40, 120), tent(50, 100),
  tent(60, 90), tent(60, 120), tent(60, 150), tent(80, 120), tent(80, 160), tent(100, 150), tent(100, 200),
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
