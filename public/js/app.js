/*
 * LiteMap UI: Mapbox GL JS + shared geodesy core. No build step, no dependencies.
 */
import * as geo from './geo.js';
import { REFERENCE_OBJECTS, REFERENCE_CATEGORIES, REFERENCE_BY_ID, addReferenceObjects } from './references.js';
import { openObjectDialog, objectThumb } from './object-upload.js';
import { skinUrl, skinThumb, hasSkin, ballastPad } from './skins.js';
import { isTent, cleanTent, resolveTent } from './tentspec.js';
import { tentLayer } from './tent3d.js';
import { has3d } from './vehicle3d.js';
import { openTentBuilder } from './tent-builder.js';
import { IMAGERY_SOURCES, IMAGERY_BY_ID, tileUrls, tileSizeOf, defaultGibsDate, customSource, coversBox } from './imagery.js';

/* ================================================================ setup */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ls = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* storage unavailable */ } },
};

const params = new URLSearchParams(location.search);
const EMBED = params.has('embed');
const READONLY = ['1', 'true'].includes(params.get('readonly'));
const PARENT_ORIGIN = params.get('origin') || '*';
document.body.classList.toggle('embed', EMBED);
document.body.classList.toggle('readonly', READONLY);

const DEFAULT_COLORS = { distance: '#ffd60a', area: '#30d158', marker: '#ff453a', reference: '#64d2ff', text: '#ffffff', drawing: '#ff9f0a' };
const PALETTE = ['#ffd60a', '#30d158', '#64d2ff', '#0a84ff', '#ff9f0a', '#ff453a', '#bf5af2', '#ff375f', '#ffffff', '#1c1c1e'];
const KIND_LABEL = { distance: 'Distance', area: 'Area', marker: 'Pin', reference: 'Object', text: 'Text', drawing: 'Drawing' };
const clamp = (v, lo, hi, d) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : d);
const textName = (t) => (String(t || '').split('\n')[0].trim().slice(0, 60) || 'Text');
const MAP_TYPES = { hybrid: 'satellite-streets-v12', satellite: 'satellite-v9', streets: 'streets-v12', light: 'light-v11' };
const LEGACY_TYPES = { standard: 'streets', mutedStandard: 'light' };

const state = {
  features: [],
  selectedId: null,
  tool: 'select',
  units: params.get('units') || ls.get('litemap:units', 'imperial'),
  mapType: ls.get('litemap:mapType', 'hybrid'),
  showLabels: ls.get('litemap:labels', true),
  showSkins: ls.get('litemap:skins', true),
  showBallast: ls.get('litemap:ballast', true),
  showBuildings: ls.get('litemap:buildings', true),
  show3d: ls.get('litemap:3d', false),
  site: blankSite(),
  dirty: false,
  draft: null,           // { kind, coords: [[lon,lat]...] }
  template: null,        // catalog template for the reference tool
  apiKey: ls.get('litemap:apiKey'),
  pen: { color: '#ff9f0a', width: 4, ...ls.get('litemap:pen', {}) },
  objects: [],           // uploaded object library (cut-out images with a real size)
  objectsLoaded: false,
  models: [],            // saved 3D models from the 3D Modeler (/modeler)
};
function blankSite() { return { id: null, name: 'Untitled site', address: '', addressAuto: true, description: '', tags: [], metadata: {} }; }

let map = null;
const views = new Map();
const undoStack = [];
const fmtL = (m) => geo.fmtLength(m, state.units);
const fmtA = (m2) => geo.fmtArea(m2, state.units);
const byId = (id) => state.features.find((f) => f.id === id) || null;
const newId = () => Math.random().toString(36).slice(2, 10);
let mapConfig = null;
let scaleControl = null;

/* ================================================================ API */
async function api(method, path, body) {
  const headers = { Accept: 'application/json' };
  const raw = body instanceof Blob;
  if (body !== undefined) headers['Content-Type'] = raw ? body.type : 'application/json';
  if (state.apiKey) headers['X-API-Key'] = state.apiKey;
  const res = await fetch(`/api/v1${path}`, { method, headers, body: body === undefined ? undefined : raw ? body : JSON.stringify(body) });
  if (res.status === 401) {
    const key = prompt('This LiteMap server requires an API key:');
    if (key) { state.apiKey = key.trim(); ls.set('litemap:apiKey', state.apiKey); return api(method, path, body); }
    throw new Error('API key required');
  }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error?.message || `${res.status} ${res.statusText}`);
  return data;
}

/* ================================================================ UI helpers */
let toastTimer;
function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast show${err ? ' err' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = 'toast'; }, err ? 4500 : 2200);
}
function hint(html) {
  const h = $('#hint');
  h.hidden = !html;
  h.innerHTML = html || '';
}
function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
async function copy(text, what) {
  try { await navigator.clipboard.writeText(text); toast(`${what} copied`); } catch { prompt(`Copy ${what.toLowerCase()}:`, text); }
}
const safeName = () => (state.site.name || 'site').replace(/[^\w.-]+/g, '_').slice(0, 80);

/* ================================================================ features */
function verts(f) {
  const g = f.geometry;
  if (g.type === 'Polygon') return geo.openRing(g.coordinates[0]);
  if (g.type === 'LineString') return g.coordinates;
  return [g.coordinates];
}
function setVerts(f, v) {
  if (f.geometry.type === 'Polygon') f.geometry.coordinates = [geo.closeRing(v)];
  else if (f.geometry.type === 'LineString') f.geometry.coordinates = v;
  else f.geometry.coordinates = v[0];
}
function refresh(f) {
  const r = f.properties.reference;
  if (r) {
    if (r.shape === 'circle') r.length = r.width;
    f.geometry = { type: 'Polygon', coordinates: [geo.footprintRing({ ...r, clearance: 0 })] };
  }
  f.properties.metrics = geo.measureGeometry(f.geometry);
  return f;
}

/** Client-side normalization for imports, postMessage, and catalog placement. */
/** Kinds whose side lengths / size can be pinned on the map with "Show measurements". */
const MEASURABLE = new Set(['distance', 'area', 'reference', 'drawing']);

/**
 * Labels are HTML, so they keep their pixel size while the map shrinks under them.
 * Publish the zoom to CSS: --lm-ppm (screen pixels per metre, to fade labels whose object is too
 * small to hold them) and --lm-k (shrinks all map text a little as you zoom out).
 */
function labelScale() {
  const z = map.getZoom(), lat = map.getCenter().lat;
  const ppm = 2 ** z / (78271.517 * Math.cos((lat * Math.PI) / 180));
  const el = map.getContainer();
  el.style.setProperty('--lm-ppm', ppm.toFixed(4));
  el.style.setProperty('--lm-k', Math.min(1, Math.max(0.6, 0.6 + (z - 17) * 0.2)).toFixed(3));
}

/** Always-on measurement labels for a feature (side lengths, diameter, or path length). */
function measurementLabels(f, pts) {
  const p = f.properties, k = p.kind;
  if (k === 'distance' || k === 'area') return segmentLabels(pts, k === 'area');
  if (k === 'drawing') return [{ coord: geo.pointAlong(pts, 0.5), cls: 'lm-label lm-seg', text: fmtL(p.metrics.lengthM), span: p.metrics.lengthM }];
  if (k === 'reference') {
    const r = p.reference;
    if (r.shape === 'circle') return [{ coord: geo.offset(r.center, r.width / 2, r.rotation + 180), cls: 'lm-label lm-seg', text: `⌀ ${fmtL(r.width)}`, span: r.width }];
    return segmentLabels(pts, true);
  }
  return [];
}

function normalize(input, i = state.features.length) {
  const f = input.type === 'Feature' ? structuredClone(input) : { type: 'Feature', geometry: structuredClone(input), properties: {} };
  const p = (f.properties ||= {});
  const kind = p.kind || (p.reference ? 'reference' : f.geometry?.type === 'Point' && p.text != null ? 'text' : { LineString: 'distance', Polygon: 'area', Point: 'marker' }[f.geometry?.type]);
  if (!kind) throw new Error(`Unsupported geometry: ${f.geometry?.type}`);
  p.kind = kind;
  f.id = String(f.id ?? p.id ?? newId());
  delete p.id;
  p.color = /^#[0-9a-f]{6}$/i.test(p.color || '') ? p.color : DEFAULT_COLORS[kind];
  p.notes ||= '';
  if (p.showLabel === false && kind !== 'text') p.showLabel = false; else delete p.showLabel;
  if (p.showMeasurements === true && MEASURABLE.has(kind)) p.showMeasurements = true; else delete p.showMeasurements;
  if (kind === 'reference') {
    const r = (p.reference ||= {});
    const tpl = REFERENCE_BY_ID[r.templateId];
    r.templateId = tpl?.id ?? null;
    r.shape ||= tpl?.shape || 'rect';
    r.width = Number(r.width ?? tpl?.width ?? 10);
    r.length = Number(r.length ?? tpl?.length ?? r.width);
    r.rotation = geo.normDeg(Number(r.rotation || 0));
    r.clearance = Number(r.clearance || 0);
    r.center ||= f.geometry?.type === 'Point' ? f.geometry.coordinates : geo.centroid(f.geometry.coordinates[0]);
    if (r.objectId) {
      r.shape = 'rect';
      r.opacity = clamp(r.opacity, 0.05, 1, 1);
      r.lockAspect = r.lockAspect !== false;
    }
    const tent = isTent(r.templateId) && !r.objectId ? cleanTent(r.tent) : null;
    if (tent) r.tent = tent; else delete r.tent;
    p.name ||= tpl?.name || 'Object';
  } else if (kind === 'text') {
    p.text = String(p.text ?? 'Text').slice(0, 1000);
    p.style = { size: clamp(p.style?.size, 8, 72, 16), box: p.style?.box !== false };
    p.name = textName(p.text);
  } else {
    if (f.geometry.type === 'Polygon') f.geometry.coordinates = [geo.closeRing(f.geometry.coordinates[0])];
    if (kind === 'drawing') p.style = { width: clamp(p.style?.width, 0.5, 40, 4) };
    p.name ||= `${KIND_LABEL[kind]} ${i + 1}`;
  }
  return refresh(f);
}

const snapshotFeatures = () => JSON.stringify(state.features);
function pushUndo(snap = snapshotFeatures()) {
  undoStack.push(snap);
  if (undoStack.length > 100) undoStack.shift();
}
function undo() {
  if (state.draft?.coords.length) { state.draft.coords.pop(); renderDraft(); return; }
  const snap = undoStack.pop();
  if (!snap) return toast('Nothing to undo');
  state.features = JSON.parse(snap);
  if (!byId(state.selectedId)) state.selectedId = null;
  changed({ all: true });
}

function addFeature(f, { select: sel = true } = {}) {
  pushUndo();
  state.features.push(f);
  changed({ ids: [f.id] });
  if (sel) select(f.id);
}
function deleteFeature(id) {
  if (!byId(id)) return;
  pushUndo();
  state.features = state.features.filter((f) => f.id !== id);
  if (state.selectedId === id) state.selectedId = null;
  changed({ all: true });
}

/** Single place to re-sync the map, panel, dirty flag, and embed listeners after edits. */
function changed({ ids, all, dirty = true } = {}) {
  if (all) syncAllViews();
  else (ids || []).forEach((id) => { const f = byId(id); if (f) renderFeature(f); });
  renderList();
  renderInspector();
  if (dirty) markDirty();
}
function markDirty() {
  state.dirty = true;
  $('#dirty').hidden = false;
  saveDraftSoon();
  emitChangeSoon();
}
let draftTimer;
function saveDraftSoon() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => { if (!EMBED) ls.set('litemap:draft', { site: state.site, features: state.features }); }, 400);
}

/* ================================================================ map views */
/* Styles are plain objects: { stroke, width, strokeOpacity, fill, fillOpacity, dash } */
function styleFor(f, selected) {
  const c = f.properties.color, k = f.properties.kind;
  if (k === 'distance') return { stroke: c, width: selected ? 4 : 3 };
  if (k === 'area') return { stroke: c, fill: c, fillOpacity: selected ? 0.3 : 0.18, width: selected ? 3 : 2 };
  const r = f.properties.reference;
  if (r?.objectId || (r && skinned(r))) return { stroke: c, strokeOpacity: selected ? 1 : 0.55, width: selected ? 2 : 1, fill: c, fillOpacity: 0 };
  return { stroke: c, fill: c, fillOpacity: selected ? 0.5 : 0.38, width: selected ? 2.5 : 1.5 };
}
const dashed = (c, w = 1.5) => ({ stroke: c, width: w, dash: true, fill: c, fillOpacity: 0.06 });

/*
 * All shapes live in one GeoJSON source (fast even for thousands of packed
 * footprints). Views register shapes by key; changes are flushed once per frame.
 */
const shapes = new Map(); // `${viewId}\u0000${key}` -> { type, pts, style }
let shapesRaf = 0;
const SRC = 'lm-shapes';

function scheduleShapes() {
  if (shapesRaf) return;
  shapesRaf = requestAnimationFrame(() => { shapesRaf = 0; flushShapes(); });
}
/* Tents stand up in 3D (tent3d.js custom layer) when the 3D switch is on. */
const tents3d = tentLayer();
/**
 * Real-height buildings from the style's own vector data, under our overlays, while 3D is on.
 * Plain Satellite has no building data (no `composite` source), so it is skipped there.
 */
function syncBuildings() {
  const id = 'lm-buildings';
  try {
    if (!(state.show3d && state.showBuildings)) { if (map.getLayer(id)) map.removeLayer(id); return; }
    if (map.getLayer(id) || !map.getSource('composite')) return;
    const imagery = state.mapType === 'hybrid' || state.mapType === 'satellite'; // keep the photo readable under them
    map.addLayer({
      id, type: 'fill-extrusion', source: 'composite', 'source-layer': 'building', minzoom: 14,
      filter: ['==', ['get', 'extrude'], 'true'],
      paint: {
        'fill-extrusion-color': state.mapType === 'light' ? '#e4e3df' : '#d8d5cc',
        'fill-extrusion-height': ['get', 'height'], 'fill-extrusion-base': ['get', 'min_height'],
        'fill-extrusion-opacity': imagery ? 0.72 : 0.92, 'fill-extrusion-vertical-gradient': true,
      },
    }, 'lm-fill');
  } catch { map.once('idle', syncBuildings); }
}
function sync3d() {
  // our layers exist once the style is ready (ensureLayers re-runs this then). Not isStyleLoaded():
  // that stays false while imagery tiles download, which skipped the 3D layer on slow connections.
  if (!map?.getLayer('lm-fill')) return;
  syncBuildings();
  const has = Boolean(map.getLayer(tents3d.id));
  try {
    if (!state.show3d) { if (has) map.removeLayer(tents3d.id); return; }
    if (!has) map.addLayer(tents3d);
  } catch { map.once('idle', sync3d); return; } // style mid-update: try again when the map settles
  tents3d.setTents(state.features
    .filter((f) => f.properties.kind === 'reference' && (isTent(f.properties.reference.templateId) || has3d(f.properties.reference.templateId)) && !f.properties.reference.objectId)
    .map((f) => {
      const r = f.properties.reference;
      if (has3d(r.templateId)) return { center: r.center, rotation: r.rotation, width: r.width, length: r.length, model: r.templateId, paint: skinTint(r, f.properties.color) };
      return { center: r.center, rotation: r.rotation, width: r.width, length: r.length, tent: r.tent, color: skinTint(r, f.properties.color) || '#f6f6f3', ballast: state.showBallast };
    }));
}
function set3d(on) {
  state.show3d = on;
  ls.set('litemap:3d', on);
  $('#show-3d').checked = on;
  if (map) {
    // right-drag / ctrl-drag tilts only in 3D (private Mapbox flag; the switch still tilts if it changes)
    try { map.dragRotate._pitchWithRotate = on; map.dragRotate.disable(); map.dragRotate.enable(); } catch { /* ignore */ }
    if (on) map.touchPitch.enable(); else map.touchPitch.disable();
    map.easeTo({ pitch: on ? Math.max(map.getPitch(), 55) : 0, duration: 700 });
  }
  syncAllViews();
  sync3d();
}

function flushShapes() {
  sync3d();
  const src = map?.getSource(SRC);
  if (!src) return;
  const features = [];
  for (const { type, pts, style: st } of shapes.values()) {
    const props = {
      stroke: st.stroke || '#ffffff', sw: st.width ?? 2, so: st.strokeOpacity ?? 1,
      fill: st.fill || st.stroke || '#ffffff', fo: st.fillOpacity ?? 0, dash: st.dash ? 1 : 0,
    };
    const geometry = type === 'polygon'
      ? { type: 'Polygon', coordinates: [geo.closeRing(pts)] }
      : { type: 'LineString', coordinates: pts };
    features.push({ type: 'Feature', properties: props, geometry });
  }
  src.setData({ type: 'FeatureCollection', features });
}
function ensureLayers() {
  if (!map || map.getSource(SRC)) return;
  map.addSource(SRC, { type: 'geojson', data: { type: 'FeatureCollection', features: [] }, tolerance: 0 });
  map.addLayer({
    id: 'lm-fill', type: 'fill', source: SRC, filter: ['==', ['geometry-type'], 'Polygon'],
    paint: { 'fill-color': ['get', 'fill'], 'fill-opacity': ['get', 'fo'] },
  });
  const line = { 'line-color': ['get', 'stroke'], 'line-width': ['get', 'sw'], 'line-opacity': ['get', 'so'] };
  map.addLayer({ id: 'lm-line', type: 'line', source: SRC, filter: ['==', ['get', 'dash'], 0], layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: line });
  map.addLayer({ id: 'lm-line-dash', type: 'line', source: SRC, filter: ['==', ['get', 'dash'], 1], layout: { 'line-join': 'round' }, paint: { ...line, 'line-dasharray': [2, 1.6] } });
  flushShapes();
  for (const [id, spec] of objImages) if (!map.getSource(id)) addObjLayer(id, spec);
  applyImagery();
}

/*
 * Uploaded objects are drawn as Mapbox image sources pinned to the object's
 * four corners (so rotation and stretch are exact), below the outlines.
 */
const objImages = new Map(); // layerId -> { url, coordinates, opacity }
const objImageUrl = (id) => `${location.origin}/api/v1/objects/${encodeURIComponent(id)}/image`;
const firstObjLayer = () => map?.getStyle()?.layers.find((l) => l.id.startsWith('lm-obj-'))?.id;
function addObjLayer(id, spec) {
  map.addSource(id, { type: 'image', url: spec.url, coordinates: spec.coordinates });
  map.addLayer({ id, type: 'raster', source: id, paint: { 'raster-opacity': spec.opacity, 'raster-fade-duration': 0 } }, map.getLayer('lm-fill') ? 'lm-fill' : undefined);
}
function putObjImage(id, spec) {
  const prev = objImages.get(id);
  objImages.set(id, spec);
  if (!map || !map.getLayer('lm-fill')) return; // ensureLayers adds it once the style is ready
  const src = map.getSource(id);
  if (src && prev?.url === spec.url) {
    if (JSON.stringify(prev.coordinates) !== JSON.stringify(spec.coordinates)) src.setCoordinates(spec.coordinates);
    if (prev.opacity !== spec.opacity) map.setPaintProperty(id, 'raster-opacity', spec.opacity);
    return;
  }
  if (map.getLayer(id)) map.removeLayer(id);
  if (src) map.removeSource(id);
  addObjLayer(id, spec);
}
function removeObjImage(id) {
  if (!objImages.delete(id) || !map?.getStyle()) return;
  if (map.getLayer(id)) map.removeLayer(id);
  if (map.getSource(id)) map.removeSource(id);
}
/** Mapbox image corners (TL, TR, BR, BL) from a footprint ring [BL, BR, TR, TL]: the image top is the object's front. */
const imageCorners = (pts) => [pts[3], pts[2], pts[1], pts[0]].map((p) => [p[0], p[1]]);

/* Catalog objects get a procedurally drawn top-down skin (skins.js) on the same image layers. */
const skinned = (r) => state.showSkins && !r.objectId && hasSkin(r.templateId);
/** Tint only when the user picked a colour other than the catalog default. */
const skinTint = (r, color) => (color && color !== REFERENCE_BY_ID[r.templateId]?.color && color !== DEFAULT_COLORS.reference ? color : null);
/** Tents carry ballast plates outside the wall line, so their skin image is padded on every side. */
const skinPad = (r) => (state.showBallast ? ballastPad(r.templateId) : 0);
const skinCorners = (r, center = r.center, rotation = r.rotation) => imageCorners(geo.openRing(geo.footprintRing({
  center, shape: 'rect', width: r.width + 2 * skinPad(r), length: (r.shape === 'circle' ? r.width : r.length) + 2 * skinPad(r), rotation,
})));
function skinSpec(r, color, center = r.center, rotation = r.rotation, opacity = 1) {
  // in 3D the tent roof / vehicle body is drawn by the 3D layer; the sprite keeps only the floor / shadow
  const opts = isTent(r.templateId) ? { tent: r.tent, floor: state.show3d } : has3d(r.templateId) ? { floor: state.show3d } : {};
  const url = skinUrl(r.templateId, r.width, r.shape === 'circle' ? r.width : r.length, skinTint(r, color), skinPad(r), opts);
  return url ? { url, coordinates: skinCorners(r, center, rotation), opacity } : null;
}

class View {
  constructor(id) { this.id = id; this.keys = new Set(); this.anns = {}; }

  overlay(key, type, pts, style) {
    const k = `${this.id}\u0000${key}`;
    if (!type || !pts || pts.length < 2) {
      if (shapes.delete(k)) scheduleShapes();
      this.keys.delete(k);
      return;
    }
    shapes.set(k, { type, pts: pts.map((p) => [p[0], p[1]]), style });
    this.keys.add(k);
    scheduleShapes();
  }

  /** specs: [{ coord, cls, text?, html?, c?, data? }], reuses markers by index. */
  annotations(key, specs) {
    const list = (this.anns[key] ||= []);
    while (list.length > specs.length) list.pop().marker.remove();
    specs.forEach((s, i) => {
      let item = list[i];
      if (!item) {
        const outer = document.createElement('div');
        outer.className = 'lm-anchor';
        const inner = document.createElement('div');
        outer.append(inner);
        const marker = new mapboxgl.Marker({ element: outer, anchor: 'top-left' }).setLngLat(s.coord).addTo(map);
        item = { marker, inner, coord: s.coord };
        list.push(item);
      } else if (item.coord[0] !== s.coord[0] || item.coord[1] !== s.coord[1]) {
        item.marker.setLngLat(s.coord);
        item.coord = s.coord;
      }
      const el = item.inner;
      if (el.className !== s.cls) el.className = s.cls;
      const content = s.html ?? esc(s.text ?? '');
      if (item.content !== content) { el.innerHTML = content; item.content = content; }
      el.style.setProperty('--c', s.c || '');
      el.style.setProperty('--fs', s.fs ? `${s.fs}px` : '');
      el.style.setProperty('--m', s.span > 0 ? String(s.span) : ''); // metres the label sits on; CSS fades it when that is too few pixels
      const data = s.data || {};
      for (const k of Object.keys(el.dataset)) if (!(k in data)) delete el.dataset[k];
      for (const [k, v] of Object.entries(data)) if (el.dataset[k] !== String(v)) el.dataset[k] = v;
    });
  }

  destroy() {
    let any = false;
    for (const k of this.keys) any = shapes.delete(k) || any;
    if (any) scheduleShapes();
    Object.values(this.anns).flat().forEach((a) => a.marker.remove());
    removeObjImage(`lm-obj-${this.id}`);
    for (const k of [...objImages.keys()]) if (k.startsWith(`lm-obj-${this.id}:`)) removeObjImage(k);
    this.keys.clear(); this.anns = {};
  }
}

function segmentLabels(pts, closed) {
  const out = [];
  const n = closed ? pts.length : pts.length - 1;
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const d = geo.distance(a, b);
    out.push({ coord: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], cls: 'lm-label lm-seg', text: fmtL(d), span: d });
  }
  return out;
}

function renderFeature(f) {
  if (!map) return;
  let v = views.get(f.id);
  if (!v) { v = new View(f.id); views.set(f.id, v); }
  const p = f.properties, k = p.kind, c = p.color;
  const sel = f.id === state.selectedId;
  const edit = sel && !READONLY;
  const pts = verts(f);
  const fid = f.id;
  const labels = [], handles = [];
  const showLbl = p.showLabel !== false && (state.showLabels || sel); // per-object switch beats the global toggle

  if (k === 'distance') {
    v.overlay('main', 'polyline', pts, styleFor(f, sel));
    if (showLbl) labels.push({ coord: geo.pointAlong(pts, 0.5), cls: 'lm-label', c, text: fmtL(p.metrics.lengthM), span: sel ? null : p.metrics.lengthM, data: { fid } });
  } else if (k === 'area') {
    v.overlay('main', 'polygon', pts, styleFor(f, sel));
    if (showLbl) labels.push({ coord: geo.centroid(pts), cls: 'lm-label', c, text: fmtA(p.metrics.areaM2), span: sel ? null : Math.sqrt(p.metrics.areaM2), data: { fid } });
  } else if (k === 'reference') {
    const r = p.reference;
    v.overlay('main', 'polygon', pts, styleFor(f, sel));
    v.overlay('clear', 'polygon', r.clearance > 0 ? geo.openRing(geo.footprintRing(r)) : null, dashed(c));
    const imgId = `lm-obj-${f.id}`;
    if (r.objectId) putObjImage(imgId, { url: objImageUrl(r.objectId), coordinates: imageCorners(pts), opacity: r.opacity ?? 1 });
    else if (skinned(r)) {
      // while a corner is dragged, stretch the current skin; it is redrawn at the new size on release
      const prev = objImages.get(imgId);
      const spec = drag?.fid === f.id && drag.type === 'resize' && prev
        ? { ...prev, coordinates: skinCorners(r) }
        : skinSpec(r, c);
      if (spec) putObjImage(imgId, spec); else removeObjImage(imgId);
    } else removeObjImage(imgId);
    if (showLbl && !edit) {
      labels.push({ coord: r.center, cls: 'lm-label', c, text: `${shortName(p.name)} · ${geo.fmtDims(r.width, r.length, state.units, r.shape)}`, span: sel ? null : Math.max(r.width, r.length || 0), data: { fid } });
    }
  } else if (k === 'drawing') {
    v.overlay('main', 'polyline', pts, { stroke: c, width: p.style.width + (sel ? 1.5 : 0) });
  } else if (k === 'text') {
    labels.push({
      coord: pts[0], cls: `lm-text${sel ? ' sel' : ''}${p.style.box ? '' : ' nobox'}`, c, fs: p.style.size,
      text: p.text, data: edit ? { fid, handle: 'move' } : { fid },
    });
  } else if (k === 'marker') {
    labels.push({
      coord: pts[0], cls: `lm-pin${sel ? ' sel' : ''}`, c,
      html: `<span>${showLbl ? esc(p.name) : ''}</span><i></i>`,
      data: edit ? { fid, handle: 'move' } : { fid },
    });
  }

  const segs = p.showMeasurements ? measurementLabels(f, pts)
    : sel && (k === 'distance' || k === 'area') ? segmentLabels(pts, k === 'area') : [];

  if (edit && (k === 'distance' || k === 'area')) {
    const closed = k === 'area';
    pts.forEach((pt, i) => handles.push({ coord: pt, cls: 'lm-h', c, data: { fid, handle: 'vertex', index: i } }));
    const n = closed ? pts.length : pts.length - 1;
    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      handles.push({ coord: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], cls: 'lm-h lm-h-mid', c, data: { fid, handle: 'mid', index: i } });
    }
  } else if (edit && k === 'drawing') {
    handles.push({ coord: geo.pointAlong(pts, 0.5), cls: 'lm-h lm-h-move', c, data: { fid, handle: 'translate' } });
  } else if (edit && k === 'reference') {
    const r = p.reference;
    handles.push({ coord: r.center, cls: 'lm-h lm-h-move', c, data: { fid, handle: 'move' } });
    const reach = r.length / 2 + r.clearance + Math.max(1.5, r.length * 0.12);
    handles.push({ coord: geo.offset(r.center, reach, r.rotation), cls: 'lm-h lm-h-rotate', c, data: { fid, handle: 'rotate' } });
    if (r.shape === 'circle') {
      handles.push({ coord: geo.offset(r.center, r.width / 2, r.rotation + 90), cls: 'lm-h lm-h-resize', c, data: { fid, handle: 'resize', index: 0 } });
    } else {
      pts.forEach((pt, i) => handles.push({ coord: pt, cls: 'lm-h lm-h-resize', c, data: { fid, handle: 'resize', index: i } }));
    }
  }

  v.annotations('labels', labels);
  v.annotations('segs', segs);
  v.annotations('handles', handles);
}
const shortName = (n) => (n.length > 28 ? `${n.slice(0, 27)}…` : n);

function syncAllViews() {
  if (!map) return;
  const ids = new Set(state.features.map((f) => f.id));
  for (const [id, v] of views) if (!ids.has(id) && !id.startsWith('__')) { v.destroy(); views.delete(id); }
  state.features.forEach(renderFeature);
}

function scratchView(key) {
  let v = views.get(key);
  if (!v) { v = new View(key); views.set(key, v); }
  return v;
}
function clearScratch(key) {
  const v = views.get(key);
  if (v) { v.destroy(); views.delete(key); }
}

/* ================================================================ drawing */
let cursorLL = null;

function renderDraft() {
  const d = state.draft;
  if (!d) { clearScratch('__draft'); return; }
  const v = scratchView('__draft');
  const pts = d.coords;
  const c = DEFAULT_COLORS[d.kind];
  const area = d.kind === 'area';
  if (area && pts.length >= 3) v.overlay('fill', 'polygon', pts, { stroke: c, strokeOpacity: 0, width: 0, fill: c, fillOpacity: 0.15 });
  else v.overlay('fill', null, null);
  v.overlay('line', 'polyline', pts, { stroke: c, width: 3 });
  const last = pts[pts.length - 1];
  if (last && cursorLL) {
    v.overlay('rubber', 'polyline', area && pts.length >= 2 ? [last, cursorLL, pts[0]] : [last, cursorLL], { stroke: c, width: 2, dash: true });
  } else v.overlay('rubber', null, null);

  const handles = pts.map((pt, i) => ({
    coord: pt, cls: `lm-h${area && i === 0 && pts.length >= 3 ? ' lm-h-first' : ''}`, c, data: { fid: '__draft', handle: 'vertex', index: i },
  }));
  v.annotations('handles', handles);
  v.annotations('segs', segmentLabels(pts, false));

  let live = [];
  if (last && cursorLL) {
    const seg = geo.distance(last, cursorLL);
    let text = fmtL(seg);
    if (area && pts.length >= 2) text += ` · ${fmtA(geo.ringArea([...pts, cursorLL]))}`;
    else if (pts.length >= 2) text += ` · total ${fmtL(geo.pathLength(pts) + seg)}`;
    live = [{ coord: cursorLL, cls: 'lm-label lm-live', text }];
  }
  v.annotations('live', live);
  updateHint();
}

function startOrExtendDraft(ll, ev) {
  if (!state.draft) state.draft = { kind: state.tool, coords: [] };
  const d = state.draft, pts = d.coords;
  const min = d.kind === 'area' ? 3 : 2;
  if (pts.length && ev) {
    if (d.kind === 'area' && pts.length >= 3 && pixelDist(pts[0], ev) < 12) return finishDraft();
    if (pixelDist(pts[pts.length - 1], ev) < 10) { if (pts.length >= min) finishDraft(); return; }
  }
  pts.push(ev ? snap(ll, ev) : ll);
  renderDraft();
}

function finishDraft() {
  const d = state.draft;
  if (!d) return;
  const min = d.kind === 'area' ? 3 : 2;
  state.draft = null;
  renderDraft();
  if (d.coords.length < min) { updateHint(); return; }
  const geometry = d.kind === 'area'
    ? { type: 'Polygon', coordinates: [geo.closeRing(d.coords)] }
    : { type: 'LineString', coordinates: d.coords };
  const f = normalize({ type: 'Feature', geometry, properties: { kind: d.kind, name: nextName(d.kind) } });
  setTool('select');
  addFeature(f);
}
function cancelDraft() {
  state.draft = null;
  renderDraft();
  updateHint();
}
function nextName(kind) {
  const n = state.features.filter((f) => f.properties.kind === kind).length + 1;
  return `${KIND_LABEL[kind]} ${n}`;
}

/** Snap to an existing vertex within 10 px (hold Alt to disable). */
function snap(ll, ev) {
  if (ev.altKey) return ll;
  let best = null, bestD = 10;
  for (const f of state.features) {
    if (f.properties.kind === 'marker') continue;
    for (const p of verts(f)) {
      const d = pixelDist(p, ev);
      if (d < bestD) { bestD = d; best = p; }
    }
  }
  if (state.draft) for (const p of state.draft.coords.slice(1, -1)) { const d = pixelDist(p, ev); if (d < bestD) { bestD = d; best = p; } }
  return best ? [...best] : ll;
}

function placeReference(ll) {
  const tpl = state.template;
  if (!tpl) return toast('Pick an object from the list first');
  const rotation = map ? geo.normDeg(Math.round(map.getBearing())) : 0;
  const f = normalize({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: ll },
    properties: {
      kind: 'reference', name: tpl.name, color: tpl.color,
      reference: tpl.objectId
        ? { templateId: null, objectId: tpl.objectId, shape: 'rect', width: tpl.width, length: tpl.length, rotation, opacity: 1, lockAspect: true }
        : { templateId: tpl.id, shape: tpl.shape, width: tpl.width, length: tpl.length, rotation, ...(tpl.tent ? { tent: tpl.tent } : {}) },
    },
  });
  clearScratch('__ghost');
  setTool('select');
  addFeature(f);
}

function renderGhost() {
  if (state.tool !== 'reference' || !state.template || !cursorLL) { clearScratch('__ghost'); return; }
  const t = state.template;
  const ring = geo.footprintRing({ center: cursorLL, shape: t.shape, width: t.width, length: t.length, rotation: geo.normDeg(Math.round(map.getBearing())) });
  scratchView('__ghost').overlay('g', 'polygon', geo.openRing(ring), dashed(t.color, 2));
  if (t.objectId) putObjImage('lm-obj-__ghost', { url: objImageUrl(t.objectId), coordinates: imageCorners(geo.openRing(ring)), opacity: 0.65 });
  else if (state.showSkins) {
    const spec = skinSpec({ templateId: t.id, shape: t.shape, width: t.width, length: t.length, tent: t.tent }, t.built ? t.color : null, cursorLL, geo.normDeg(Math.round(map.getBearing())), 0.7);
    if (spec) putObjImage('lm-obj-__ghost', spec);
  }
}

/* ================================================================ pointer input */
let press = null, drag = null, moveRaf = 0, lastMove = null, stroke = null;
const activePointers = new Set();

const mapRect = () => map.getContainer().getBoundingClientRect();
const toLL = (ev) => {
  const r = mapRect();
  const p = map.unproject([ev.clientX - r.left, ev.clientY - r.top]);
  return [p.lng, p.lat];
};
function pixelDist(ll, ev) {
  const r = mapRect();
  const p = map.project(ll);
  return Math.hypot(p.x + r.left - ev.clientX, p.y + r.top - ev.clientY);
}
function metersPerPixel(ev) {
  const r = mapRect();
  const a = map.unproject([ev.clientX - r.left, ev.clientY - r.top]);
  const b = map.unproject([ev.clientX - r.left + 40, ev.clientY - r.top]);
  return geo.distance([a.lng, a.lat], [b.lng, b.lat]) / 40;
}
/** True for the map's own controls (zoom, compass, attribution, etc). */
function isMapChrome(target) {
  return Boolean(target.closest?.('.mapboxgl-control-container, .mapboxgl-ctrl, .mapboxgl-popup, button, a, [role="button"]'));
}

function bindPointer() {
  const el = $('#map');
  const stopIfHandle = (e) => { if (e.target.closest?.('[data-handle]') && !READONLY) e.stopPropagation(); };
  el.addEventListener('mousedown', stopIfHandle, true);
  el.addEventListener('touchstart', stopIfHandle, { capture: true, passive: true });

  el.addEventListener('pointerdown', (e) => {
    activePointers.add(e.pointerId);
    if (activePointers.size > 1) { press = null; return; }
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const h = e.target.closest?.('[data-handle]');
    if (h && !READONLY) {
      e.stopPropagation();
      e.preventDefault();
      startDrag(h, e);
      return;
    }
    if (isMapChrome(e.target)) return;
    if (state.tool === 'drawing' && !READONLY) {
      e.stopPropagation();
      e.preventDefault();
      stroke = { id: e.pointerId, pts: [toLL(e)], x: e.clientX, y: e.clientY };
      return;
    }
    press = { x: e.clientX, y: e.clientY, t: performance.now(), target: e.target };
  }, true);

  window.addEventListener('pointermove', (e) => {
    if (drag) { e.stopPropagation(); e.preventDefault(); lastMove = e; schedule(); return; }
    if (stroke && e.pointerId === stroke.id) {
      e.stopPropagation();
      e.preventDefault();
      if (Math.hypot(e.clientX - stroke.x, e.clientY - stroke.y) >= 2) {
        stroke.x = e.clientX; stroke.y = e.clientY;
        stroke.pts.push(toLL(e));
        scratchView('__stroke').overlay('s', 'polyline', stroke.pts, { stroke: state.pen.color, width: state.pen.width });
      }
      return;
    }
    if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 6) press = null;
    if (e.target.closest?.('#map')) { lastMove = e; schedule(); }
  }, true);

  const up = (e) => {
    activePointers.delete(e.pointerId);
    if (drag) { e.stopPropagation(); endDrag(e); return; }
    if (stroke && e.pointerId === stroke.id) { e.stopPropagation(); finishStroke(); return; }
    const p = press;
    press = null;
    if (e.type === 'pointerup' && p && performance.now() - p.t < 800 && Math.hypot(e.clientX - p.x, e.clientY - p.y) <= 6) onMapClick(e, p.target);
  };
  window.addEventListener('touchmove', (e) => { if (drag || stroke) { e.stopPropagation(); e.preventDefault(); } }, { capture: true, passive: false });
  window.addEventListener('pointerup', up, true);
  window.addEventListener('pointercancel', up, true);
  el.addEventListener('pointerleave', () => {
    if (drag) return;
    cursorLL = null;
    $('#coords').textContent = '';
    if (state.draft) renderDraft();
    clearScratch('__ghost');
  });
}

function schedule() {
  if (moveRaf) return;
  moveRaf = requestAnimationFrame(() => {
    moveRaf = 0;
    const e = lastMove;
    if (!e || !map) return;
    if (drag) return applyDrag(e);
    cursorLL = toLL(e);
    $('#coords').textContent = `${cursorLL[1].toFixed(6)}, ${cursorLL[0].toFixed(6)}`;
    if (state.draft) renderDraft();
    if (state.tool === 'reference') renderGhost();
  });
}

/** Ramer–Douglas–Peucker simplification in local meters. */
function simplify(pts, tolM) {
  if (pts.length < 3) return pts;
  const f = geo.localFrame(pts[0]);
  const xy = pts.map(f.toXY);
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let max = 0, idx = -1;
    for (let i = a + 1; i < b; i++) {
      const d = geo.pointSegmentDistance(xy[i], xy[a], xy[b]);
      if (d > max) { max = d; idx = i; }
    }
    if (max > tolM) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  return pts.filter((_, i) => keep[i]).map((p) => [+p[0].toFixed(8), +p[1].toFixed(8)]);
}

function finishStroke() {
  const st = stroke;
  stroke = null;
  clearScratch('__stroke');
  if (!st || st.pts.length < 2) return;
  const r = mapRect();
  const tol = metersPerPixel({ clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }) * 0.8;
  const pts = simplify(st.pts, tol);
  if (pts.length < 2) return;
  addFeature(normalize({
    type: 'Feature', geometry: { type: 'LineString', coordinates: pts },
    properties: { kind: 'drawing', name: nextName('drawing'), color: state.pen.color, style: { width: state.pen.width } },
  }), { select: false });
}

function placeText(ll) {
  setTool('select');
  addFeature(normalize({ type: 'Feature', geometry: { type: 'Point', coordinates: ll }, properties: { kind: 'text', text: 'Text', color: '#ffffff', style: { size: 16, box: true } } }));
  setTimeout(() => { const t = $('#i-text'); if (t) { t.focus(); t.select(); } }, 0);
}

function onMapClick(e, target) {
  if (!map) return;
  const ll = toLL(e);
  const fidEl = target.closest?.('[data-fid]');
  switch (state.tool) {
    case 'distance':
    case 'area':
      startOrExtendDraft(ll, e);
      break;
    case 'marker':
      setTool('select');
      addFeature(normalize({ type: 'Feature', geometry: { type: 'Point', coordinates: ll }, properties: { kind: 'marker', name: nextName('marker') } }));
      break;
    case 'reference':
      placeReference(ll);
      break;
    case 'text':
      placeText(ll);
      break;
    case 'drawing':
      break;
    default:
      select(fidEl && fidEl.dataset.fid !== '__draft' ? fidEl.dataset.fid : hitTest(ll, e));
  }
}

/** Topmost feature under the pointer: pins, objects and lines win over areas; smaller areas win. */
function hitTest(ll, ev) {
  const tol = metersPerPixel(ev) * 9;
  const frame = geo.localFrame(ll);
  const P = [0, 0];
  let areaHit = null, areaSize = Infinity;
  for (let i = state.features.length - 1; i >= 0; i--) {
    const f = state.features[i], k = f.properties.kind;
    const pts = verts(f).map(frame.toXY);
    if (k === 'marker' && Math.hypot(...pts[0]) < tol * 2) return f.id;
    if (k === 'distance' || k === 'drawing') {
      const t2 = k === 'drawing' ? tol + (f.properties.style.width / 2) * (tol / 9) : tol;
      for (let j = 1; j < pts.length; j++) if (geo.pointSegmentDistance(P, pts[j - 1], pts[j]) < t2) return f.id;
    }
    if (k === 'text' && Math.hypot(...pts[0]) < tol * 2) return f.id;
    if (k === 'reference' && geo.pointInRing(P, pts)) return f.id;
    if (k === 'area') {
      const onEdge = pts.some((p, j) => geo.pointSegmentDistance(P, p, pts[(j + 1) % pts.length]) < tol);
      if (onEdge) return f.id;
      if (geo.pointInRing(P, pts) && f.properties.metrics.areaM2 < areaSize) { areaHit = f.id; areaSize = f.properties.metrics.areaM2; }
    }
  }
  return areaHit;
}

/* ---- handle dragging */
function startDrag(h, e) {
  const fid = h.dataset.fid;
  drag = {
    fid, type: h.dataset.handle, index: Number(h.dataset.index), moved: false,
    x: e.clientX, y: e.clientY, snap: snapshotFeatures(), shift: e.shiftKey, ev: e,
  };
  if (fid !== '__draft') {
    const f = byId(fid);
    if (f?.properties.reference) drag.ref0 = { ...f.properties.reference };
    if (drag.type === 'translate' && f) { drag.orig = verts(f).map((q) => [...q]); drag.startLL = toLL(e); }
  }
  map.dragPan.disable();
  map.dragRotate.disable();
}

function applyDrag(e) {
  const d = drag;
  if (!d.moved) {
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < 3) return;
    d.moved = true;
    if (d.fid !== '__draft') pushUndo(d.snap);
  }
  const ll = d.type === 'vertex' ? snapExcept(toLL(e), e, d) : toLL(e);

  if (d.fid === '__draft') {
    state.draft.coords[d.index] = ll;
    renderDraft();
    return;
  }
  const f = byId(d.fid);
  if (!f) return;
  const p = f.properties;

  if (d.type === 'mid') {
    const v = verts(f);
    v.splice(d.index + 1, 0, ll);
    setVerts(f, v);
    d.type = 'vertex';
    d.index += 1;
  } else if (d.type === 'vertex') {
    const v = verts(f);
    v[d.index] = ll;
    setVerts(f, v);
  } else if (d.type === 'translate') {
    const dx = ll[0] - d.startLL[0], dy = ll[1] - d.startLL[1];
    setVerts(f, d.orig.map(([x, y]) => [x + dx, y + dy]));
  } else if (d.type === 'move') {
    if (p.reference) p.reference.center = ll;
    else f.geometry.coordinates = ll;
  } else if (d.type === 'rotate') {
    let rot = geo.bearing(p.reference.center, ll);
    if (e.shiftKey) rot = Math.round(rot / 15) * 15;
    p.reference.rotation = geo.normDeg(Math.round(rot * 10) / 10);
  } else if (d.type === 'resize') {
    const r = p.reference, r0 = d.ref0;
    const [x, y] = geo.localFrame(r.center).toXY(ll);
    if (r.shape === 'circle') {
      r.width = r.length = Math.max(0.1, 2 * Math.hypot(x, y) - 2 * r.clearance);
    } else {
      const t = (r.rotation * Math.PI) / 180;
      const u = Math.abs(x * Math.cos(t) - y * Math.sin(t)) * 2 - 2 * r.clearance;
      const w = Math.abs(x * Math.sin(t) + y * Math.cos(t)) * 2 - 2 * r.clearance;
      if (r.objectId && r.lockAspect ? !e.shiftKey : e.shiftKey) {
        const s = Math.max(u / r0.width, w / r0.length);
        r.width = Math.max(0.1, r0.width * s);
        r.length = Math.max(0.1, r0.length * s);
      } else {
        r.width = Math.max(0.1, u);
        r.length = Math.max(0.1, w);
      }
    }
  }
  refresh(f);
  renderFeature(f);
  renderInspectorLive(f);
}
function snapExcept(ll, ev, d) {
  if (ev.altKey) return ll;
  let best = null, bestD = 10;
  for (const f of state.features) {
    if (f.properties.kind === 'marker') continue;
    verts(f).forEach((p, i) => {
      if (f.id === d.fid && i === d.index) return;
      const dist = pixelDist(p, ev);
      if (dist < bestD) { bestD = dist; best = p; }
    });
  }
  return best ? [...best] : ll;
}

function endDrag(e) {
  const d = drag;
  drag = null;
  map.dragPan.enable();
  map.dragRotate.enable();
  if (d.fid === '__draft') {
    // a tap on a draft vertex is a click: closes the area / finishes the line
    if (!d.moved && state.draft) startOrExtendDraft(toLL(e), e);
    return;
  }
  if (!d.moved) {
    if (d.fid !== state.selectedId) select(d.fid);
    else if (d.type === 'vertex' && (e.altKey || e.ctrlKey || e.metaKey)) removeVertex(d.fid, d.index);
    return;
  }
  changed({ ids: [d.fid] });
}
function removeVertex(fid, index) {
  const f = byId(fid);
  const v = verts(f);
  const min = f.properties.kind === 'area' ? 3 : 2;
  if (v.length <= min) return toast(`A ${KIND_LABEL[f.properties.kind].toLowerCase()} needs at least ${min} points`);
  pushUndo();
  v.splice(index, 1);
  setVerts(f, v);
  refresh(f);
  changed({ ids: [fid] });
}

/* ================================================================ tools & selection */
function setTool(tool) {
  if (READONLY && tool !== 'select') tool = 'select';
  if (state.draft && tool !== state.tool) finishDraft();
  state.tool = tool;
  $$('.tool[data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === tool));
  $('#map').classList.toggle('drawing', tool !== 'select');
  $('#catalog').hidden = tool !== 'reference';
  $('#pen').hidden = tool !== 'drawing';
  $('#map').classList.toggle('pen', tool === 'drawing');
  if (map) { if (tool === 'drawing') { map.dragPan.disable(); map.dragRotate.disable(); } else if (!drag) { map.dragPan.enable(); map.dragRotate.enable(); } }
  if (tool === 'drawing') { renderPen(); openPanel(); }
  if (tool !== 'reference') clearScratch('__ghost');
  if (tool !== 'select' && state.selectedId) select(null);
  if (tool === 'reference') { renderCatalog(); openPanel(); if (!state.objectsLoaded && !EMBED) loadObjects(); }
  updateHint();
}

function updateHint() {
  const d = state.draft;
  const t = state.tool;
  if (t === 'distance') hint(d?.coords.length ? 'Click to add points · click the last point or <kbd>Enter</kbd> to finish · <kbd>Backspace</kbd> undo point · <kbd>Esc</kbd> cancel' : 'Click the map to start measuring a distance');
  else if (t === 'area') hint(d?.coords.length >= 3 ? 'Click the first point or press <kbd>Enter</kbd> to close the area · <kbd>Esc</kbd> cancel' : 'Click the map to outline an area');
  else if (t === 'marker') hint('Click to drop a pin');
  else if (t === 'text') hint('Click where the text box should go');
  else if (t === 'drawing') hint('Drag to draw · pick colour and width in the panel · <kbd>Esc</kbd> to stop drawing (the map pans again)');
  else if (t === 'reference') hint(state.template ? `Click to place <b>${esc(state.template.name)}</b>` : 'Pick an object in the panel, then click the map');
  else if (state.selectedId && !READONLY && byId(state.selectedId)?.properties.reference?.objectId) hint(byId(state.selectedId).properties.reference.lockAspect ? 'Drag a corner to scale · <kbd>Shift</kbd>-drag stretches · ↻ rotates · ✥ moves' : 'Drag a corner to stretch · <kbd>Shift</kbd>-drag keeps proportions · ↻ rotates · ✥ moves');
  else if (state.selectedId && !READONLY) hint('Drag handles to edit · <kbd>Shift</kbd> constrains · <kbd>Alt</kbd>-click a vertex to delete it · <kbd>Del</kbd> removes');
  else hint('');
}

function select(id) {
  const prev = state.selectedId;
  state.selectedId = id && byId(id) ? id : null;
  clearScratch('__pack');
  if (prev && prev !== state.selectedId && byId(prev)) renderFeature(byId(prev));
  if (state.selectedId) { renderFeature(byId(state.selectedId)); openPanel(); }
  renderInspector();
  renderList();
  updateHint();
  post('litemap:select', { featureId: state.selectedId });
}

/* ================================================================ panel: list */
function renderList() {
  const ul = $('#feature-list');
  const fs = state.features;
  if (!fs.length) {
    ul.innerHTML = `<li class="empty" style="display:block">${READONLY ? 'No measurements on this site.' : 'Pick a tool on the left to measure a distance, outline an area, or drop a to-scale object.'}</li>`;
    $('#totals').innerHTML = '';
    return;
  }
  ul.innerHTML = fs.map((f) => {
    const p = f.properties;
    return `<li data-id="${esc(f.id)}" class="${f.id === state.selectedId ? 'sel' : ''}" title="Double-click to zoom">
      <span class="dot" style="background:${p.color}"></span>
      <span class="name">${esc(p.name)}</span>
      <span class="val">${esc(metricText(f))}</span></li>`;
  }).join('');
  const t = totals();
  const stats = [];
  if (t.areaCount) {
    const [main, sub] = fmtA(t.areaM2).split(' · ');
    stats.push(stat(main, `${sub ? `${sub} · ` : ''}${t.areaCount} area${t.areaCount > 1 ? 's' : ''}`));
  }
  if (t.lengthCount) stats.push(stat(fmtL(t.lengthM), `${t.lengthCount} distance${t.lengthCount > 1 ? 's' : ''}`));
  if (t.refCount) stats.push(stat(String(t.refCount), `Object${t.refCount > 1 ? 's' : ''} · ${fmtA(t.refAreaM2).split(' · ')[0]}`));
  if (t.areaCount && t.refCount) {
    const pct = (t.refAreaM2 / t.areaM2) * 100;
    stats.push(stat(`${pct < 10 ? pct.toFixed(1) : Math.round(pct)}%`, 'Objects / area coverage'));
  }
  $('#totals').innerHTML = stats.join('');
}
const stat = (b, s) => `<div class="stat"><b>${esc(b)}</b><span>${esc(s)}</span></div>`;
function metricText(f) {
  const p = f.properties, m = p.metrics;
  if (p.kind === 'distance') return fmtL(m.lengthM);
  if (p.kind === 'area') return fmtA(m.areaM2).split(' · ')[0];
  if (p.kind === 'reference') return geo.fmtDims(p.reference.width, p.reference.length, state.units, p.reference.shape);
  if (p.kind === 'drawing') return fmtL(m.lengthM);
  if (p.kind === 'text') return 'text';
  const [lon, lat] = f.geometry.coordinates;
  return `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
}
function totals() {
  const t = { areaM2: 0, areaCount: 0, lengthM: 0, lengthCount: 0, refCount: 0, refAreaM2: 0 };
  for (const f of state.features) {
    const p = f.properties;
    if (p.kind === 'area') { t.areaM2 += p.metrics.areaM2; t.areaCount++; }
    if (p.kind === 'distance') { t.lengthM += p.metrics.lengthM; t.lengthCount++; }
    if (p.kind === 'reference') { t.refCount++; t.refAreaM2 += p.metrics.areaM2; }
  }
  return t;
}

/* ================================================================ tent builder */
function tentSummary(r) {
  const spec = resolveTent(r.width, r.length, r.tent);
  const walls = Object.entries(spec.walls).filter(([, k]) => k !== 'none');
  const wallTxt = !walls.length ? 'no sidewalls'
    : walls.length === 4 && new Set(walls.map(([, k]) => k)).size === 1 ? `${walls[0][1]} walls all round`
      : walls.map(([side, k]) => `${side} ${k}`).join(', ');
  return `${spec.roof[0].toUpperCase()}${spec.roof.slice(1)} roof · ${fmtL(spec.peak)} peak · ${fmtL(spec.eave)} legs · ${wallTxt}`;
}
function tentCard(r) {
  return `<div class="field"><label>Tent</label><div class="tent-card"><span class="muted small">${esc(tentSummary(r))}</span>
    ${READONLY ? '' : '<button type="button" class="btn sm" data-act="tent-builder">Open tent builder…</button>'}</div></div>`;
}
// built-in sizes only: a company catalog entry carries its own roof and walls, so a built tent never silently becomes one
const stockTentFor = (w, l) => REFERENCE_OBJECTS.filter((o) => isTent(o.id) && o.id !== 'tent-custom' && !o.tent).find((o) => Math.abs(o.width - w) < 0.02 && Math.abs(o.length - l) < 0.02) || null;
const tentName = (w, l) => (state.units === 'metric'
  ? `Tent ${+w.toFixed(1)}×${+l.toFixed(1)} m`
  : `Tent ${Math.round(w / 0.3048)}×${Math.round(l / 0.3048)} ft`);

/** Catalog "Build a tent…": design one, then place it like any catalog object. */
async function buildTent() {
  const prev = state.template && isTent(state.template.id) ? state.template : null;
  const res = await openTentBuilder({
    units: state.units, mode: 'place', ballast: state.showBallast,
    init: prev ? { width: prev.width, length: prev.length, tent: prev.tent, color: prev.built ? prev.color : undefined } : {},
  });
  if (!res) return;
  const stock = stockTentFor(res.width, res.length);
  state.template = {
    id: stock?.id || 'tent-custom', category: REFERENCE_BY_ID['tent-custom'].category, name: tentName(res.width, res.length),
    shape: 'rect', width: res.width, length: res.length, color: res.color, tent: res.tent || undefined, built: true,
  };
  if (state.tool !== 'reference') setTool('reference');
  renderCatalog();
  updateHint();
  toast('Click the map to place your tent');
}

/** Inspector "Open tent builder…" on a placed tent. */
async function editTent(f) {
  const r = f.properties.reference;
  const res = await openTentBuilder({
    units: state.units, mode: 'edit', ballast: state.showBallast,
    init: { width: r.width, length: r.length, tent: r.tent, color: skinTint(r, f.properties.color) || '#f6f6f3' },
  });
  if (!res || !byId(f.id)) return;
  pushUndo();
  const p = f.properties;
  const wasDefaultName = !p.name || p.name === REFERENCE_BY_ID[r.templateId]?.name || p.name === tentName(r.width, r.length);
  const stock = stockTentFor(res.width, res.length);
  const sameSize = Math.abs(res.width - r.width) < 0.02 && Math.abs(res.length - r.length) < 0.02;
  r.templateId = stock?.id || (sameSize ? r.templateId : 'tent-custom');
  r.width = res.width; r.length = res.length;
  if (res.tent) r.tent = res.tent; else delete r.tent;
  p.color = res.color === '#f6f6f3' ? REFERENCE_BY_ID[r.templateId].color : res.color;
  if (wasDefaultName) p.name = stock?.name || tentName(res.width, res.length);
  refresh(f);
  changed({ ids: [f.id] });
}

/* ================================================================ panel: catalog */
const objTemplate = (o) => ({ id: `obj:${o.id}`, objectId: o.id, category: 'My objects', name: o.name, shape: 'rect', width: o.width, length: o.length, color: '#64d2ff' });
const objectById = (id) => state.objects.find((o) => o.id === id) || null;
/** Library template for a reference: a catalog entry or an uploaded object. */
const tplOf = (r) => (r.objectId ? objectById(r.objectId) : REFERENCE_BY_ID[r.templateId]) || null;

async function loadObjects({ quiet = false } = {}) {
  try {
    const headers = state.apiKey ? { 'X-API-Key': state.apiKey } : {};
    const res = quiet ? await fetch('/api/v1/objects', { headers }) : null;
    const data = quiet ? (res.ok ? await res.json() : null) : await api('GET', '/objects');
    if (!data) return;
    state.objects = data.items;
    state.objectsLoaded = true;
    if (state.tool === 'reference') renderCatalog();
    if (byId(state.selectedId)?.properties.reference?.objectId) renderInspector();
  } catch (e) { if (!quiet) toast(e.message, true); }
}

/* Saved 3D models (3D Modeler) are placed as ordinary tent references, so they keep their 3D look and stay editable. */
const modelById = (id) => state.models.find((m) => m.id === id) || null;
const modelTemplate = (m) => {
  const stock = stockTentFor(m.width, m.length);
  return {
    id: stock?.id || 'tent-custom', category: 'My models', name: m.name, shape: 'rect', width: m.width, length: m.length,
    color: m.color, tent: m.tent || undefined, built: true, modelId: m.id,
  };
};

async function loadModels() {
  try {
    const headers = state.apiKey ? { 'X-API-Key': state.apiKey } : {};
    const res = await fetch('/api/v1/models', { headers });
    if (!res.ok) return;
    state.models = (await res.json()).items;
    if (state.tool === 'reference') renderCatalog();
  } catch { /* models are optional */ }
}

/** `/?model=<id>` (the Modeler's "Place on map") arms that model for placement. */
function openModelFromUrl() {
  const id = params.get('model');
  if (!id || READONLY || EMBED) return;
  const m = modelById(id);
  const u = new URL(location.href); u.searchParams.delete('model');
  history.replaceState(null, '', u);
  if (!m) return toast('That saved model no longer exists', true);
  state.template = modelTemplate(m);
  setTool('reference');
  toast(`Click the map to place “${m.name}”`);
}

async function uploadObject(file) {
  if (READONLY) return;
  const obj = await openObjectDialog({
    units: state.units, file,
    toast,
    upload: (blob, m) => api('POST', `/objects?${new URLSearchParams({ name: m.name, width: String(m.width), length: String(m.length) })}`, blob),
  });
  if (!obj) return;
  state.objects = [obj, ...state.objects.filter((o) => o.id !== obj.id)];
  state.template = objTemplate(obj);
  setTool('reference');
  toast(`Saved “${obj.name}” to My objects. Click the map to place it.`);
}

async function deleteObject(id) {
  const o = objectById(id);
  if (!o) return;
  const used = state.features.filter((f) => f.properties.reference?.objectId === id).length;
  if (!confirm(`Remove “${o.name}” from your objects?${used ? `\n\n${used} placed cop${used === 1 ? 'y' : 'ies'} on this site will lose the picture (the outline stays).` : ''}`)) return;
  try {
    await api('DELETE', `/objects/${encodeURIComponent(id)}`);
    state.objects = state.objects.filter((x) => x.id !== id);
    if (state.template?.objectId === id) state.template = null;
    renderCatalog();
    updateHint();
  } catch (e) { toast(e.message, true); }
}

function renderCatalog() {
  const q = $('#catalog-filter').value.trim().toLowerCase();
  const mine = state.objects.filter((o) => !q || `${o.name} my objects uploaded`.toLowerCase().includes(q));
  const upload = READONLY ? '' : `<div class="catalog-upload">
      <button type="button" class="btn sm primary" data-upload>Upload object…</button>
      <span class="muted small">Photo or drawing → auto cut-out → set its size</span></div>`;
  const myHtml = mine.length ? `<h3>My objects</h3>${mine.map((o) => `
      <div class="catalog-item obj${state.template?.objectId === o.id ? ' on' : ''}" data-obj="${esc(o.id)}" role="button" tabindex="0">
        ${objectThumb(o)}<span>${esc(o.name)}</span><small>${esc(geo.fmtDims(o.width, o.length, state.units, 'rect'))}</small>
        ${READONLY ? '' : `<button type="button" class="obj-del" data-obj-del="${esc(o.id)}" title="Remove from My objects" aria-label="Remove">✕</button>`}
      </div>`).join('')}` : '';
  const models = state.models.filter((m) => !q || `${m.name} my models 3d`.toLowerCase().includes(q));
  const modelsHtml = models.length ? `<h3>My models<a class="btn sm" href="/modeler" target="_blank" rel="noopener" title="Open the 3D Modeler">3D Modeler</a></h3>${models.map((m) => {
    const u = skinUrl('tent-custom', m.width, m.length, m.color === '#f6f6f3' ? null : m.color, 0, { tent: m.tent || undefined });
    return `<div class="catalog-item obj${state.template?.modelId === m.id ? ' on' : ''}" data-model="${esc(m.id)}" role="button" tabindex="0">
        ${u ? `<img class="skin-thumb" src="${u}" alt="" loading="lazy">` : '<i class="skin-thumb none"></i>'}<span>${esc(m.name)}</span><small>${esc(geo.fmtDims(m.width, m.length, state.units, 'rect'))}</small>
      </div>`;
  }).join('')}` : '';
  const html = REFERENCE_CATEGORIES.map((cat) => {
    const items = REFERENCE_OBJECTS.filter((r) => r.category === cat && (!q || `${r.name} ${cat}`.toLowerCase().includes(q)));
    if (!items.length) return '';
    const build = cat === REFERENCE_BY_ID['tent-custom'].category && !READONLY
      ? '<button type="button" class="btn sm primary build-tent" data-build-tent title="Roof style, heights, bays, sidewalls and fabric, with a 3D preview">Build a tent…</button>'
        + (state.models.length || READONLY ? '' : '<a class="btn sm" href="/modeler" target="_blank" rel="noopener" title="Model a tent in 3D and save it as a map object">3D Modeler</a>') : '';
    return `<h3>${esc(cat)}${build}</h3>${items.map((r) => `
      <button type="button" class="catalog-item${state.template?.id === r.id && !state.template.built ? ' on' : ''}" data-tpl="${r.id}">
        ${(() => { const u = skinThumb(r); return u ? `<img class="skin-thumb" src="${u}" alt="" loading="lazy">` : '<i class="skin-thumb none"></i>'; })()}<span>${esc(r.name)}</span><small>${esc(geo.fmtDims(r.width, r.length, state.units, r.shape))}</small>
      </button>`).join('')}`;
  }).join('');
  $('#catalog-list').innerHTML = upload + ((modelsHtml + myHtml + html) || '<div class="empty">No matches</div>');
}

/* ================================================================ panel: pen */
function renderPen() {
  const box = $('#pen');
  const { color, width } = state.pen;
  box.innerHTML = `
    <h2>Pen</h2>
    <div class="swatches">${PALETTE.map((c) => `<button type="button" class="swatch${c === color ? ' on' : ''}" data-pen-color="${c}" style="background:${c}" aria-label="Colour ${c}"></button>`).join('')}</div>
    <div class="field"><label>Width</label><div class="row"><input type="range" id="pen-w" min="1" max="24" step="0.5" value="${width}"><span class="unit">${width}px</span></div></div>
    <svg class="pen-preview" viewBox="0 0 200 30" aria-hidden="true"><path d="M8 20 C 50 2, 80 30, 120 14 S 180 8, 192 18" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"/></svg>
    <p class="muted small">Drag on the map to draw. Strokes are saved with the site; select one to recolour, resize, move (✥) or delete it.</p>`;
}
function bindPen() {
  const box = $('#pen');
  box.addEventListener('click', (e) => {
    const c = e.target.closest('[data-pen-color]')?.dataset.penColor;
    if (!c) return;
    state.pen.color = c;
    ls.set('litemap:pen', state.pen);
    renderPen();
  });
  box.addEventListener('input', (e) => {
    if (e.target.id !== 'pen-w') return;
    state.pen.width = Number(e.target.value);
    ls.set('litemap:pen', state.pen);
    e.target.nextElementSibling.textContent = `${state.pen.width}px`;
    box.querySelector('.pen-preview path').setAttribute('stroke-width', state.pen.width);
  });
}

/* ================================================================ panel: inspector */
let inspectorUndoArmed = false;

function renderInspector() {
  const box = $('#inspector');
  const f = byId(state.selectedId);
  if (!f) { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  const p = f.properties, k = p.kind, ro = READONLY ? 'disabled' : '';
  const u = geo.unitLabel(state.units);
  const val = (m) => +geo.toUnit(m, state.units).toFixed(2);

  let body = `
    <div class="insp-head">
      ${k === 'text' ? '<span class="insp-title">Text box</span>' : `<input class="input" id="i-name" value="${esc(p.name)}" maxlength="200" ${ro} aria-label="Name">`}
      <span class="kind">${KIND_LABEL[k]}</span>
    </div>
    ${READONLY ? '' : `<div class="swatches">${PALETTE.map((c) => `<button type="button" class="swatch${c === p.color ? ' on' : ''}" data-color="${c}" style="background:${c}" aria-label="Color ${c}"></button>`).join('')}</div>`}
    <div class="metrics" id="i-metrics">${metricsHtml(f)}</div>`;

  if (k === 'distance' || k === 'area') {
    const segs = p.metrics.segmentsM || [];
    body += `<details><summary class="muted small">${segs.length} segment${segs.length === 1 ? '' : 's'}</summary><ol class="segs" id="i-segs">${segs.map((s) => `<li>${esc(fmtL(s))}</li>`).join('')}</ol></details>`;
  }

  if (k === 'reference') {
    const r = p.reference;
    const tpl = tplOf(r);
    const img = Boolean(r.objectId);
    const scale = tpl ? Math.round((r.width / tpl.width) * 100) : 100;
    const areas = state.features.filter((x) => x.properties.kind === 'area');
    // stretch is measured against the picture's own proportions
    const picAspect = tpl?.pixelWidth && tpl?.pixelHeight ? tpl.pixelHeight / tpl.pixelWidth : null;
    const stretch = img && picAspect ? (r.length / r.width) / picAspect : 1;
    body += img ? `
      <div class="field"><label>Object</label><div class="obj-insp">${objectThumb({ id: r.objectId })}
        <span class="muted small">Uploaded${tpl ? ` · saved as ${esc(geo.fmtDims(tpl.width, tpl.length, state.units, 'rect'))}` : ''}${Math.abs(stretch - 1) > 0.015 ? ` · stretched ${Math.round(Math.abs((stretch > 1 ? stretch : 1 / stretch) - 1) * 100)}% ${stretch > 1 ? 'taller' : 'wider'} than the picture` : ''}</span></div></div>` : `
      <div class="field"><label>Object</label>
        <select id="i-tpl" ${ro}>${REFERENCE_CATEGORIES.map((cat) => `<optgroup label="${esc(cat)}">${REFERENCE_OBJECTS.filter((o) => o.category === cat).map((o) => `<option value="${o.id}" ${o.id === r.templateId ? 'selected' : ''}>${esc(o.name)}</option>`).join('')}</optgroup>`).join('')}</select></div>`;
    body += `
      <div class="field"><label>${r.shape === 'circle' ? 'Diameter' : 'Width'}</label><div class="row"><input type="number" class="input" id="i-w" step="0.5" min="0.1" value="${val(r.width)}" ${ro}><span class="unit">${u}</span></div></div>
      ${r.shape === 'circle' ? '' : `<div class="field"><label>Length</label><div class="row"><input type="number" class="input" id="i-l" step="0.5" min="0.1" value="${val(r.length)}" ${ro}><span class="unit">${u}</span></div></div>`}
      ${img ? `<div class="field"><label></label><label class="toggle small"><input type="checkbox" id="i-lock" ${r.lockAspect ? 'checked' : ''} ${ro}> Keep proportions</label></div>
        <div class="field"><label>Opacity</label><div class="row"><input type="range" id="i-op" min="10" max="100" step="5" value="${Math.round((r.opacity ?? 1) * 100)}" ${ro}><span class="unit" id="i-op-v">${Math.round((r.opacity ?? 1) * 100)}%</span></div></div>` : ''}
      ${tpl ? `<div class="field"><label>Scale</label><div class="row"><input type="range" id="i-scale" min="10" max="400" step="1" value="${scale}" ${ro}><span class="unit" id="i-scale-v">${scale}%</span></div></div>` : ''}
      ${r.shape === 'circle' ? '' : `<div class="field"><label>Rotation</label><div class="row"><input type="range" id="i-rot-r" min="0" max="359.9" step="0.1" value="${r.rotation}" ${ro}><input type="number" class="input" id="i-rot" style="width:72px" step="1" value="${+r.rotation.toFixed(1)}" ${ro}><span class="unit">°</span></div></div>`}
      <div class="field"><label title="Kept clear on every side (stakes, guy lines, egress)">Clearance</label><div class="row"><input type="number" class="input" id="i-clear" step="0.5" min="0" value="${val(r.clearance)}" ${ro}><span class="unit">${u}</span></div></div>
      ${isTent(r.templateId) && !img ? tentCard(r) : ''}
      ${READONLY ? '' : `<div class="row-btns">
        ${r.shape === 'circle' ? '' : `<button type="button" class="btn sm" data-act="rot90">Rotate 90°</button>${img ? '' : '<button type="button" class="btn sm" data-act="swap">Swap W/L</button>'}`}
        <button type="button" class="btn sm" data-act="reset-size" ${tpl ? '' : 'disabled'}>${img ? 'Original size' : 'Reset size'}</button>
      </div>
      <div class="subcard">
        <h2>Site fit</h2>
        ${areas.length ? `
          <div class="field"><label>Area</label><select id="i-area">${areas.map((a) => `<option value="${esc(a.id)}">${esc(a.properties.name)} (${esc(fmtA(a.properties.metrics.areaM2).split(' · ')[0])})</option>`).join('')}</select></div>
          <div class="row-btns">
            <button type="button" class="btn sm" data-act="fit" title="Find a placement inside the area with the most margin">Will it fit?</button>
            <button type="button" class="btn sm" data-act="largest" title="Largest uniform scale that still fits">Largest fit</button>
            <button type="button" class="btn sm" data-act="pack" title="How many copies tile into the area">How many fit?</button>
          </div>
          <div id="i-fit-result"></div>` : '<p class="muted small">Outline an area to check whether this object fits, find the largest size that fits, or count how many fit.</p>'}
      </div>`}`;
  }

  if (k === 'text') {
    body += `
      <div class="field" style="align-items:start"><label>Text</label><textarea id="i-text" rows="3" maxlength="1000" ${ro}>${esc(p.text)}</textarea></div>
      <div class="field"><label>Size</label><div class="row"><input type="range" id="i-fs" min="10" max="48" step="1" value="${p.style.size}" ${ro}><span class="unit" id="i-fs-v">${p.style.size}px</span></div></div>
      <div class="field"><label>Background</label><label class="toggle small"><input type="checkbox" id="i-box" ${p.style.box ? 'checked' : ''} ${ro}> dark box behind text</label></div>`;
  }
  if (k === 'drawing') {
    body += `<div class="field"><label>Width</label><div class="row"><input type="range" id="i-pw" min="1" max="24" step="0.5" value="${p.style.width}" ${ro}><span class="unit" id="i-pw-v">${p.style.width}px</span></div></div>`;
  }
  if (k === 'marker') {
    const [lon, lat] = f.geometry.coordinates;
    body += `<div class="field"><label>Lat, lon</label><input class="input" id="i-ll" value="${lat.toFixed(7)}, ${lon.toFixed(7)}" ${ro}></div>`;
  }

  if (MEASURABLE.has(k)) {
    body += `<div class="field"><label>Measure</label><button type="button" class="btn sm toggle-btn${p.showMeasurements ? ' on' : ''}" data-act="measurements" aria-pressed="${p.showMeasurements ? 'true' : 'false'}" ${ro}
      title="Keep ${k === 'drawing' ? 'the length' : k === 'reference' && p.reference.shape === 'circle' ? 'the diameter' : 'every side length'} on the map, even when not selected">${p.showMeasurements ? '✓ Showing measurements' : 'Show measurements'}</button></div>`;
  }
  if (k !== 'text' && k !== 'drawing') {
    body += `<div class="field"><label>Label</label><label class="toggle small" title="Hide just this label; the Labels switch hides them all"><input type="checkbox" id="i-showlbl" ${p.showLabel !== false ? 'checked' : ''} ${ro}> Show on map</label></div>`;
  }
  body += `
    <div class="field" style="align-items:start"><label>Notes</label><textarea id="i-notes" rows="2" maxlength="5000" ${ro}>${esc(p.notes)}</textarea></div>
    <div class="row-btns">
      <button type="button" class="btn sm" data-act="zoom">Zoom to</button>
      ${READONLY ? '' : `<button type="button" class="btn sm" data-act="dup">Duplicate</button>
      <button type="button" class="btn sm danger" data-act="delete">Delete</button>`}
    </div>`;
  box.innerHTML = body;
}

function metricsHtml(f) {
  const p = f.properties, m = p.metrics;
  if (p.kind === 'distance') return `<div class="stat wide"><b>${esc(fmtL(m.lengthM))}</b><span>Total length · ${m.vertices} points</span></div>`;
  if (p.kind === 'area') {
    const [a, b] = fmtA(m.areaM2).split(' · ');
    return `<div class="stat wide"><b>${esc(a)}</b><span>${esc(b || 'Area')}</span></div><div class="stat"><b>${esc(fmtL(m.perimeterM))}</b><span>Perimeter</span></div><div class="stat"><b>${m.vertices}</b><span>Vertices</span></div>`;
  }
  if (p.kind === 'reference') {
    const r = p.reference;
    const outer = r.clearance > 0 ? geo.ringArea(geo.footprintRing(r)) : null;
    return `<div class="stat"><b>${esc(fmtA(m.areaM2).split(' · ')[0])}</b><span>Footprint</span></div>
      <div class="stat"><b>${outer ? esc(fmtA(outer).split(' · ')[0]) : '—'}</b><span>With clearance</span></div>`;
  }
  if (p.kind === 'drawing') return `<div class="stat wide"><b>${esc(fmtL(m.lengthM))}</b><span>Stroke length · ${m.vertices} points</span></div>`;
  return '';
}
/** Cheap in-place refresh while dragging (doesn't rebuild inputs). */
function renderInspectorLive(f) {
  const m = $('#i-metrics');
  if (!m || f.id !== state.selectedId) return;
  m.innerHTML = metricsHtml(f);
  const r = f.properties.reference;
  if (r) {
    const set = (id, v) => { const el = $(id); if (el && document.activeElement !== el) el.value = v; };
    set('#i-w', +geo.toUnit(r.width, state.units).toFixed(2));
    set('#i-l', +geo.toUnit(r.length, state.units).toFixed(2));
    set('#i-rot', +r.rotation.toFixed(1));
    set('#i-rot-r', r.rotation);
    const tpl = tplOf(r);
    if (tpl && $('#i-scale')) { const s = Math.round((r.width / tpl.width) * 100); set('#i-scale', s); $('#i-scale-v').textContent = `${s}%`; }
  }
  const segs = $('#i-segs');
  if (segs) segs.innerHTML = (f.properties.metrics.segmentsM || []).map((s) => `<li>${esc(fmtL(s))}</li>`).join('');
}

function bindInspector() {
  const box = $('#inspector');
  box.addEventListener('focusin', () => { inspectorUndoArmed = true; });
  const edit = (fn, { rerender = false } = {}) => {
    const f = byId(state.selectedId);
    if (!f || READONLY) return;
    if (inspectorUndoArmed) { pushUndo(); inspectorUndoArmed = false; }
    fn(f, f.properties, f.properties.reference);
    refresh(f);
    renderFeature(f);
    if (rerender) renderInspector(); else renderInspectorLive(f);
    renderList();
    markDirty();
  };
  const num = (el) => { const v = parseFloat(el.value); return Number.isFinite(v) ? v : null; };

  box.addEventListener('input', (e) => {
    const t = e.target;
    switch (t.id) {
      case 'i-name': return edit((f, p) => { p.name = t.value; });
      case 'i-notes': return edit((f, p) => { p.notes = t.value; });
      case 'i-text': return edit((f, p) => { p.text = t.value.slice(0, 1000); p.name = textName(p.text); });
      case 'i-fs': $('#i-fs-v').textContent = `${t.value}px`; return edit((f, p) => { p.style.size = Number(t.value); });
      case 'i-pw': $('#i-pw-v').textContent = `${t.value}px`; return edit((f, p) => { p.style.width = Number(t.value); });
      case 'i-w': { const v = num(t); if (v > 0) edit((f, p, r) => { const n = geo.fromUnit(v, state.units); if (r.objectId && r.lockAspect) r.length *= n / r.width; r.width = n; }); return; }
      case 'i-l': { const v = num(t); if (v > 0) edit((f, p, r) => { const n = geo.fromUnit(v, state.units); if (r.objectId && r.lockAspect) r.width *= n / r.length; r.length = n; }); return; }
      case 'i-op': $('#i-op-v').textContent = `${t.value}%`; return edit((f, p, r) => { r.opacity = Number(t.value) / 100; });
      case 'i-clear': { const v = num(t); if (v >= 0) edit((f, p, r) => { r.clearance = geo.fromUnit(v, state.units); }); return; }
      case 'i-rot': case 'i-rot-r': { const v = num(t); if (v != null) edit((f, p, r) => { r.rotation = geo.normDeg(v); }); return; }
      case 'i-scale': return edit((f, p, r) => {
        const tpl = tplOf(r);
        const s = Number(t.value) / 100;
        r.width = tpl.width * s; r.length = tpl.length * s;
        $('#i-scale-v').textContent = `${t.value}%`;
      });
      default:
    }
  });
  box.addEventListener('change', (e) => {
    const t = e.target;
    if (t.id === 'i-tpl') {
      const tpl = REFERENCE_BY_ID[t.value];
      edit((f, p, r) => {
        const wasDefaultName = !p.name || REFERENCE_BY_ID[r.templateId]?.name === p.name;
        Object.assign(r, { templateId: tpl.id, shape: tpl.shape, width: tpl.width, length: tpl.length });
        if (!isTent(tpl.id)) delete r.tent;
        if (wasDefaultName) p.name = tpl.name;
      }, { rerender: true });
    } else if (t.id === 'i-lock') {
      edit((f, p, r) => { r.lockAspect = t.checked; });
      updateHint();
    } else if (t.id === 'i-showlbl') {
      edit((f, p) => { if (t.checked) delete p.showLabel; else p.showLabel = false; });
    } else if (t.id === 'i-box') {
      edit((f, p) => { p.style.box = t.checked; });
    } else if (t.id === 'i-ll') {
      const m = t.value.match(/(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)/);
      if (m && Math.abs(+m[1]) <= 90 && Math.abs(+m[2]) <= 180) edit((f) => { f.geometry.coordinates = [+m[2], +m[1]]; });
      else toast('Enter "lat, lon"', true);
    } else if (t.id === 'i-w' || t.id === 'i-l' || t.id === 'i-clear') renderInspector();
    inspectorUndoArmed = true;
  });
  box.addEventListener('click', (e) => {
    const sw = e.target.closest('[data-color]');
    if (sw) { inspectorUndoArmed = true; return edit((f, p) => { p.color = sw.dataset.color; }, { rerender: true }); }
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    const f = byId(state.selectedId);
    if (!f) return;
    inspectorUndoArmed = true;
    switch (act) {
      case 'zoom': zoomTo([f]); break;
      case 'tent-builder': editTent(f); break;
      case 'measurements': {
        if (READONLY) break;
        pushUndo();
        if (f.properties.showMeasurements) delete f.properties.showMeasurements; else f.properties.showMeasurements = true;
        renderFeature(f); renderInspector(); markDirty();
        break;
      }
      case 'delete': deleteFeature(f.id); break;
      case 'dup': {
        const c = structuredClone(f);
        c.id = newId();
        c.properties.name = `${f.properties.name} copy`;
        const nudge = (ll) => geo.offset(ll, 3, 135);
        if (c.properties.reference) c.properties.reference.center = nudge(c.properties.reference.center);
        else setVerts(c, verts(c).map(nudge));
        addFeature(refresh(c));
        break;
      }
      case 'rot90': edit((x, p, r) => { r.rotation = geo.normDeg(r.rotation + 90); }, { rerender: true }); break;
      case 'swap': edit((x, p, r) => { [r.width, r.length] = [r.length, r.width]; }, { rerender: true }); break;
      case 'reset-size': edit((x, p, r) => { const t = tplOf(r); if (t) { r.width = t.width; r.length = t.length; } }, { rerender: true }); break;
      case 'fit': case 'largest': case 'pack': runFit(act, f); break;
      default:
    }
  });
}

function runFit(mode, f) {
  const area = byId($('#i-area')?.value);
  const out = $('#i-fit-result');
  if (!area) return;
  const r = f.properties.reference;
  const opts = { shape: r.shape, width: r.width, length: r.length, clearance: r.clearance };
  const show = (ok, html) => { out.innerHTML = `<div class="result ${ok ? 'ok' : 'bad'}">${html}</div>`; };
  out.innerHTML = '<div class="result">Working…</div>';
  // let the "working" paint before the (synchronous) search
  setTimeout(() => {
    try {
      if (mode === 'fit') {
        const res = geo.fitFootprint(area.geometry, opts);
        if (!res.fits) return show(false, `<b>Doesn't fit</b> in ${esc(area.properties.name)} at this size${r.clearance ? ' and clearance' : ''}. Try <i>Largest fit</i>.`);
        pushUndo();
        Object.assign(r, { center: res.center, rotation: r.shape === 'circle' ? r.rotation : res.rotation });
        refresh(f); renderFeature(f); renderInspectorLive(f); markDirty();
        show(true, `<b>Fits ✓</b> Moved to the roomiest spot: <b>${esc(fmtL(res.slackM))}</b> to spare at the tightest point.`);
      } else if (mode === 'largest') {
        const res = geo.largestFit(area.geometry, opts);
        if (!res.fits) return show(false, '<b>No placement found.</b> The area may be too narrow for this clearance.');
        const dims = geo.fmtDims(res.width, res.length, state.units, r.shape);
        show(true, `Largest that fits: <b>${esc(dims)}</b> (${Math.round(res.scale * 100)}% of current)${r.clearance ? `, keeping ${esc(fmtL(r.clearance))} clearance` : ''}.
          <div class="row-btns"><button type="button" class="btn sm" id="i-apply-largest">Apply</button></div>`);
        $('#i-apply-largest').onclick = () => {
          pushUndo();
          Object.assign(r, { width: res.width, length: res.length, center: res.center, rotation: r.shape === 'circle' ? r.rotation : res.rotation });
          refresh(f); changed({ ids: [f.id] });
        };
      } else {
        const res = geo.packFootprints(area.geometry, opts);
        const v = scratchView('__pack');
        v.destroy();
        const shown = res.centers.slice(0, 5000);
        const skins = skinned(r) && shown.length <= 120;
        shown.forEach((center, i) => {
          v.overlay(`p${i}`, 'polygon', geo.openRing(geo.footprintRing({ center, shape: r.shape, width: r.width, length: r.length, rotation: res.rotation })),
            { stroke: f.properties.color, width: 1, fill: f.properties.color, fillOpacity: skins ? 0 : 0.25 });
          if (skins) putObjImage(`lm-obj-__pack:p${i}`, skinSpec(r, f.properties.color, center, res.rotation, 0.9));
        });
        show(res.count > 0, `<b>${res.count.toLocaleString()}</b> × ${esc(f.properties.name)} fit in ${esc(area.properties.name)}${r.clearance ? ` with ${esc(fmtL(2 * r.clearance))} between them` : ''} (grid at ${res.rotation}°).
          ${res.count > shown.length ? `<br><span class="muted small">Showing the first ${shown.length}.</span>` : ''}
          ${res.count ? '<div class="row-btns"><button type="button" class="btn sm" id="i-clear-pack">Hide layout</button></div>' : ''}`);
        const hide = $('#i-clear-pack');
        if (hide) hide.onclick = () => { clearScratch('__pack'); out.innerHTML = ''; };
      }
    } catch (err) {
      show(false, esc(err.message));
    }
  }, 16);
}

/* ================================================================ map control */
function currentView() {
  if (!map) return null;
  const c = map.getCenter();
  return {
    center: [+c.lng.toFixed(7), +c.lat.toFixed(7)],
    zoom: +map.getZoom().toFixed(2),
    bearing: +geo.normDeg(map.getBearing()).toFixed(1),
    mapType: state.mapType,
  };
}
function applyView(v) {
  if (!map || !v?.center) return;
  map.jumpTo({ center: v.center, zoom: v.zoom ?? 18, bearing: v.bearing ?? 0 });
}
/** Center on a point showing roughly `meters` across the shorter side of the map. */
function goTo(ll, meters = 300, animate = true) {
  const r = mapRect();
  const mpp = meters / Math.max(100, Math.min(r.width, r.height));
  const zoom = Math.max(0, Math.min(21, Math.log2((78271.517 * Math.cos((ll[1] * Math.PI) / 180)) / mpp)));
  if (animate) map.flyTo({ center: ll, zoom, essential: true }); else map.jumpTo({ center: ll, zoom });
}
function zoomTo(features) {
  if (!map) return;
  const coords = features.flatMap((f) => (f.properties.reference ? geo.openRing(geo.footprintRing(f.properties.reference)) : verts(f)));
  if (!coords.length) return;
  const [x0, y0, x1, y1] = geo.bbox(coords);
  map.fitBounds([[x0, y0], [x1, y1]], { padding: 70, maxZoom: 20, bearing: map.getBearing() });
}
function setMapType(t) {
  t = LEGACY_TYPES[t] || t;
  state.mapType = MAP_TYPES[t] ? t : 'hybrid';
  ls.set('litemap:mapType', state.mapType);
  $('#map-type').value = state.mapType;
  if (map && map._lmStyle !== state.mapType) {
    map._lmStyle = state.mapType;
    map.setStyle(`mapbox://styles/mapbox/${MAP_TYPES[state.mapType]}`);
  }
}
function setUnits(u) {
  state.units = u === 'metric' ? 'metric' : 'imperial';
  ls.set('litemap:units', state.units);
  $$('#units button').forEach((b) => b.classList.toggle('on', b.dataset.units === state.units));
  scaleControl?.setUnit(state.units);
  syncAllViews();
  renderList();
  renderInspector();
  if (state.tool === 'reference') renderCatalog();
}

/* ================================================================ search */
async function doSearch(q) {
  const box = $('#search-results');
  const m = q.match(/^\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (m && Math.abs(+m[1]) <= 90 && Math.abs(+m[2]) <= 180) { box.hidden = true; return goTo([+m[2], +m[1]], 250); }
  if (!map || !mapConfig) return;
  const u = new URL('https://api.mapbox.com/search/geocode/v6/forward');
  const c = map.getCenter();
  u.searchParams.set('q', q);
  u.searchParams.set('limit', '6');
  u.searchParams.set('proximity', `${c.lng.toFixed(5)},${c.lat.toFixed(5)}`);
  u.searchParams.set('access_token', mapConfig.accessToken);
  let places;
  try {
    const res = await fetch(u);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    places = (await res.json()).features || [];
  } catch (e) {
    return toast(`Search failed: ${e.message}`, true);
  }
  if (!places.length) { box.innerHTML = '<li class="muted">No results</li>'; box.hidden = false; return; }
  box.innerHTML = places.map((p, i) => `<li data-i="${i}"><b>${esc(p.properties.name)}</b><span class="muted">${esc(p.properties.full_address || p.properties.place_formatted || '')}</span></li>`).join('');
  box.hidden = false;
  box.onclick = (e) => {
    const li = e.target.closest('li[data-i]');
    if (!li) return;
    const p = places[+li.dataset.i];
    box.hidden = true;
    const precise = ['address', 'street', 'poi'].includes(p.properties.feature_type);
    if (!precise && p.properties.bbox) {
      const [w, s2, e2, n] = p.properties.bbox;
      map.fitBounds([[w, s2], [e2, n]], { padding: 40 });
    } else goTo(p.geometry.coordinates, 120);
  };
  if (places.length === 1) box.querySelector('li').click();
}

/* ================================================================ imagery overlays */
/*
 * One raster overlay at a time sits between the base map and the measurements.
 * Sources come from the shared catalog (public/js/imagery.js) plus custom URLs.
 */
const IMG_LAYER = 'lm-img';
const imagery = {
  active: null,         // source id or null
  opacity: 1,
  hidden: false,
  date: defaultGibsDate(),
  releaseId: null,      // Wayback release id
  custom: [],
  enhance: 'off',       // 'off' | 'sharpen' | 'ai'
  lastEnhance: 'sharpen',
  nativeMax: {},        // sourceId -> deepest zoom with real imagery at the current location
  open: false,
  ...ls.get('litemap:imagery', {}),
};
const ENHANCE_LABEL = { sharpen: 'Sharpened', ai: 'AI-enhanced' };
const canEnhance = (src) => src && (src.type === 'xyz' || src.type === 'wayback');
imagery.open = false;
imagery.hidden = false;
if (imagery.enhance === 'ai') imagery.enhance = 'sharpen';
let waybackReleases = null;
let centerDate = null;      // { text } for the active overlay at the map center
let newestResults = null;   // last "find newest" result
let skyfiResults = null;
let skyfiSelected = null;

const saveImagery = () => {
  const { active, opacity, date, releaseId, custom, enhance, lastEnhance, nativeMax } = imagery;
  ls.set('litemap:imagery', { active, opacity, date, releaseId, custom, enhance, lastEnhance, nativeMax });
};
const allSources = () => [...IMAGERY_SOURCES, ...imagery.custom];
const sourceById = (id) => allSources().find((s) => s.id === id) || null;

async function loadWayback() {
  if (waybackReleases) return waybackReleases;
  const cfg = await (await fetch(IMAGERY_BY_ID.wayback.configUrl)).json();
  waybackReleases = Object.entries(cfg).map(([id, r]) => ({
    id, itemURL: r.itemURL, date: (r.itemTitle.match(/(\d{4}-\d{2}-\d{2})/) || [])[1] || '',
  })).sort((a, b) => b.date.localeCompare(a.date));
  return waybackReleases;
}

const IMG_AI = 'lm-img-ai';
const IMG_LAYERS = [IMG_LAYER, IMG_AI];
let imgErrors = { count: 0, status: null };
const gibsDates = {}; // sourceId -> 'loading' | [{ date, coverage }]

function addImgLayer(id, before) {
  map.addLayer({
    id, type: 'raster', source: id,
    layout: { visibility: imagery.hidden ? 'none' : 'visible' },
    paint: { 'raster-opacity': imagery.opacity, 'raster-fade-duration': id === IMG_AI ? 250 : 0 },
  }, before);
}

function applyImagery() {
  if (!map || !map.getStyle()) return;
  for (const id of [IMG_AI, IMG_LAYER]) {
    if (map.getLayer(id)) map.removeLayer(id);
    if (map.getSource(id)) map.removeSource(id);
  }
  imgErrors = { count: 0, status: null };
  const src = sourceById(imagery.active);
  renderImageryBadge();
  if (!src) return;
  if (src.dated && !gibsDates[src.id]) { loadAvailableDates(src); return; } // re-applies with a date that has imagery
  let tiles;
  if (src.type === 'wayback') {
    const rel = waybackReleases?.find((r) => r.id === imagery.releaseId) || waybackReleases?.[0];
    if (!rel) { loadWayback().then(applyImagery).catch(() => toast('Could not load Esri Wayback releases', true)); return; }
    imagery.releaseId = rel.id;
    tiles = tileUrls(src, { release: rel });
  } else tiles = tileUrls(src, { date: imagery.date });
  const nativeMax = imagery.nativeMax[src.id] ?? src.maxzoom ?? 22;
  const common = {};
  if (src.bounds) common.bounds = src.bounds;
  if (src.attribution) common.attribution = src.attribution;
  const enhance = canEnhance(src) ? imagery.enhance : 'off';
  // Custom sources rebuild tiles in a worker from native pixels (see enhance-worker.js).
  const custom = (mode, minzoom = 0) => ({
    type: 'custom', tileSize: 256, minzoom, maxzoom: 22, ...common,
    loadTile: ({ z, x, y }, { signal }) => enhancer.tile({ template: tiles[0], z, x, y, nativeMax, mode: z < nativeMax - 1 ? 'plain' : mode }, signal),
  });
  const before = firstObjLayer() || (map.getLayer('lm-fill') ? 'lm-fill' : undefined);
  map.addSource(IMG_LAYER, enhance === 'off'
    ? { type: 'raster', tiles, tileSize: tileSizeOf(src), maxzoom: Math.min(nativeMax, src.maxzoom ?? 22), ...common }
    : custom('sharpen'));
  addImgLayer(IMG_LAYER, before);
  // AI tiles fade in on top as they finish, so the map is never blank while the model works.
  if (enhance === 'ai') { map.addSource(IMG_AI, custom('ai', nativeMax + 1)); addImgLayer(IMG_AI, before); }
  refreshCenterDate();
}

/** Daily NASA layers only have imagery on pass dates (and lag ~5 days): ask the server which dates exist here. */
async function loadAvailableDates(src) {
  gibsDates[src.id] = 'loading';
  renderImagery();
  const c = map.getCenter();
  try {
    const r = await api('GET', `/imagery/available-dates?source=${src.id}&lon=${c.lng.toFixed(5)}&lat=${c.lat.toFixed(5)}&days=60`);
    gibsDates[src.id] = r.dates;
    if (r.dates.length && !r.dates.some((d) => d.date === imagery.date)) { imagery.date = r.dates[0].date; saveImagery(); }
    if (!r.dates.length) toast(`${src.name}: no imagery over this spot in the last 60 days`, true);
  } catch (e) {
    gibsDates[src.id] = [];
    toast(`Could not list dates for ${src.name}: ${e.message}`, true);
  }
  if (imagery.active === src.id) applyImagery();
  renderImagery();
}

function setImagery(id) {
  imagery.active = id && sourceById(id) ? id : null;
  imagery.hidden = false;
  saveImagery();
  centerDate = null;
  applyImagery();
  renderImagery();
}
function toggleImageryHidden() {
  if (!imagery.active || !map?.getLayer(IMG_LAYER)) return;
  imagery.hidden = !imagery.hidden;
  for (const id of IMG_LAYERS) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', imagery.hidden ? 'none' : 'visible');
  renderImageryBadge();
  toast(imagery.hidden ? 'Overlay hidden: showing Mapbox' : `Showing ${sourceById(imagery.active).name}`);
}

/** Look up the capture date of the active overlay at the map center. */
const refreshCenterDate = debounce(async () => {
  const src = sourceById(imagery.active);
  if (!src || !map) return;
  if (src.captured) centerDate = { text: src.capturedLabel || src.captured };
  else if (src.type === 'wayback') centerDate = { text: `release ${waybackReleases?.find((r) => r.id === imagery.releaseId)?.date || ''}` };
  else if (src.dated) centerDate = { text: imagery.date };
  else if (src.metadata) {
    const c = map.getCenter();
    try {
      const r = await api('GET', `/imagery/dates?lon=${c.lng.toFixed(6)}&lat=${c.lat.toFixed(6)}`);
      const row = r.results.find((x) => x.sourceId === src.id);
      centerDate = { text: row?.captured ? `${row.captured} · ${row.resolution}` : 'no coverage here' };
      // Esri's deepest real zoom varies by place (z19 typical, z20–21 where it has 15 / 7.5 cm imagery).
      if (row?.maxZoom && imagery.active === src.id && imagery.nativeMax[src.id] !== row.maxZoom) {
        imagery.nativeMax[src.id] = row.maxZoom;
        saveImagery();
        applyImagery();
        return;
      }
    } catch { centerDate = null; }
  } else centerDate = null;
  renderImageryBadge();
  const el = $('#img-center-date');
  if (el) el.textContent = centerDate?.text || '—';
}, 500);

function setEnhance(mode) {
  imagery.enhance = ['sharpen', 'ai'].includes(mode) ? mode : 'off';
  if (imagery.enhance !== 'off') imagery.lastEnhance = imagery.enhance;
  saveImagery();
  applyImagery();
  renderImagery();
}
function toggleEnhance() {
  const src = sourceById(imagery.active);
  if (!canEnhance(src)) return toast('Enhancement works on Esri World Imagery, Wayback, and tile (XYZ) layers');
  setEnhance(imagery.enhance === 'off' ? imagery.lastEnhance || 'sharpen' : 'off');
  toast(imagery.enhance === 'off' ? 'Enhance off: original pixels' : `Enhance: ${ENHANCE_LABEL[imagery.enhance]}`);
}

/* Client for enhance-worker.js. Tiles are requested by Mapbox through the custom source. */
const enhancer = {
  worker: null, seq: 0, pending: new Map(), status: '', backend: null, queued: 0, failures: 0,
  ensure() {
    if (!this.worker) {
      this.worker = new Worker('/js/enhance-worker.js', { type: 'module' });
      this.worker.onmessage = (e) => this.onMessage(e.data);
      this.worker.onerror = (e) => { this.status = `Enhancer failed: ${e.message || 'worker error'}`; this.paint(); };
    }
    return this.worker;
  },
  tile(job, signal) {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      this.pending.set(id, { resolve, reject });
      this.ensure().postMessage({ type: 'tile', id, ...job });
      signal?.addEventListener('abort', () => {
        if (!this.pending.delete(id)) return;
        this.worker.postMessage({ type: 'cancel', id });
        reject(Object.assign(new Error('aborted'), { code: 20 }));
      }, { once: true });
    });
  },
  onMessage(m) {
    if (m.type === 'tile') {
      const p = this.pending.get(m.id);
      if (!p) { m.bitmap?.close(); return; }
      this.pending.delete(m.id);
      if (m.error) {
        p.reject(new Error(m.error));
        if (++this.failures >= 4 && imagery.enhance === 'ai') {
          this.failures = 0;
          toast(`AI enhancement failed (${m.error}). Switched to Sharpen.`, true);
          setEnhance('sharpen');
        }
      } else { this.failures = 0; p.resolve(m.empty ? null : m.bitmap); }
    } else if (m.type === 'status') {
      this.status = m.text;
      if (m.backend) this.backend = m.backend;
      if (m.error) toast(m.text, true);
      this.paint();
    } else if (m.type === 'queue') {
      this.queued = m.pending;
      this.paint();
    }
  },
  statusText() {
    if (imagery.enhance === 'off') return '';
    const q = this.queued ? ` · ${this.queued} tile${this.queued === 1 ? '' : 's'} queued` : '';
    return `${this.status || (imagery.enhance === 'ai' ? 'AI runs on tiles zoomed past the native imagery.' : 'Ready')}${q}`;
  },
  paint() {
    const el = $('#img-enhance-status');
    if (el) el.textContent = this.statusText();
  },
};

function renderImageryBadge() {
  const b = $('#imagery-badge');
  const src = sourceById(imagery.active);
  if (!src) { b.hidden = true; return; }
  b.hidden = false;
  b.classList.toggle('off', imagery.hidden);
  const enh = (imagery.enhance !== 'off' && canEnhance(src) ? ` <em class="enh ${imagery.enhance}">${ENHANCE_LABEL[imagery.enhance]}</em>` : '')
    + (src.maxzoom && map && map.getZoom() > src.maxzoom + 3 && !(imagery.enhance !== 'off' && canEnhance(src) && src.maxzoom >= 17)
      ? ` <em class="enh err">${esc(src.resolution || 'coarse')} pixels: zoom out to see this layer</em>` : '')
    + (imgErrors.count ? ` <em class="enh err">⚠ ${imgErrors.count} tile${imgErrors.count === 1 ? '' : 's'} failed${imgErrors.status ? ` (${esc(String(imgErrors.status))})` : ''}</em>` : '');
  b.innerHTML = imagery.hidden
    ? `Mapbox base <span>· overlay hidden (I)</span>`
    : `${esc(src.name)}${centerDate?.text ? ` <span>· ${esc(centerDate.text)}</span>` : ''}${enh}`;
}

function renderImagery() {
  const box = $('#imagery');
  box.hidden = !imagery.open;
  $('#btn-imagery').classList.toggle('on', imagery.open);
  if (!imagery.open) return;
  const bbox = map ? (() => { const b = map.getBounds(); return [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]; })() : null;
  const here = (s) => !bbox || coversBox(s, bbox);
  const groups = [...new Set(allSources().map((s) => s.group))];
  const src = sourceById(imagery.active);
  const row = (s) => `
    <label class="img-row${here(s) ? '' : ' far'}" title="${esc(s.notes || '')}">
      <input type="radio" name="img" value="${esc(s.id)}" ${imagery.active === s.id ? 'checked' : ''}>
      <span class="img-name">${esc(s.name)}${s.custom ? ` <button type="button" class="link" data-del-custom="${esc(s.id)}">remove</button>` : ''}</span>
      <span class="img-meta">${esc(s.resolution || '')}${s.captured ? ` · ${esc(s.capturedLabel || s.captured)}` : ''}${here(s) ? '' : ' · not here'}</span>
    </label>`;

  let html = `
    <div class="list-head"><h2>Imagery</h2><button type="button" class="btn icon sm" data-img="close" aria-label="Close">✕</button></div>
    <p class="muted small">Overlay a different (often newer) image source on top of Mapbox. Measurements stay on top.</p>
    <button type="button" class="btn sm primary wide" data-img="newest">Find the newest imagery here</button>
    <div id="img-newest">${renderNewest()}</div>
    <label class="img-row"><input type="radio" name="img" value="" ${!imagery.active ? 'checked' : ''}><span class="img-name">Mapbox only</span><span class="img-meta">date not published</span></label>
    ${groups.map((g) => {
      const list = allSources().filter((s) => s.group === g && (here(s) || imagery.active === s.id || s.custom));
      return list.length ? `<h3 class="img-group">${esc(g)}</h3>${list.map(row).join('')}` : '';
    }).join('')}`;

  if (src) {
    html += `<div class="subcard">
      <div class="field"><label>Opacity</label><div class="row"><input type="range" id="img-opacity" min="0" max="1" step="0.05" value="${imagery.opacity}"><span class="unit">${Math.round(imagery.opacity * 100)}%</span></div></div>
      ${src.dated ? `<div class="field"><label>Date</label>${Array.isArray(gibsDates[src.id])
        ? `<div class="row"><select id="img-date">${gibsDates[src.id].map((d) => `<option value="${d.date}" ${d.date === imagery.date ? 'selected' : ''}>${d.date}${d.coverage === 'partial' ? ' (partial pass)' : ''}</option>`).join('') || '<option value="">No passes here in 60 days</option>'}</select>
           <button type="button" class="btn sm" data-img="dates" title="Re-check dates for the current map center">↻</button></div>`
        : '<span class="small muted">Finding dates with imagery here…</span>'}</div>` : ''}
      ${src.type === 'wayback' ? `<div class="field"><label>Release</label><select id="img-release">${(waybackReleases || []).map((r) => `<option value="${r.id}" ${r.id === imagery.releaseId ? 'selected' : ''}>${r.date}</option>`).join('') || '<option>Loading…</option>'}</select></div>` : ''}
      <div class="field"><label>At center</label><span class="small" id="img-center-date">${esc(centerDate?.text || '…')}</span></div>
      ${canEnhance(src) ? `
      <div class="field"><label>Enhance</label><select id="img-enhance">
        <option value="off" ${imagery.enhance === 'off' ? 'selected' : ''}>Off</option>
        <option value="sharpen" ${imagery.enhance === 'sharpen' ? 'selected' : ''}>Sharpen (real pixels only)</option>
        <option value="ai" ${imagery.enhance === 'ai' ? 'selected' : ''}>AI super-resolution (beta)</option>
      </select></div>
      <p class="muted small" id="img-enhance-status">${esc(enhancer.statusText())}</p>
      ${imagery.enhance === 'ai' ? '<p class="warn small"><b>AI fills in plausible detail that may not exist.</b> Use it to read the scene; check fine measurements with Enhance off or Sharpen (press <kbd>E</kbd> to compare). First use downloads ~5 MB of model and ~22 MB of runtime.</p>' : ''}
      ${imagery.enhance === 'sharpen' ? '<p class="muted small">Lanczos resampling and an unsharp mask on the native pixels, with 2× tiles for sharp HiDPI display. Nothing is invented.</p>' : ''}` : ''}
      ${src.notes ? `<p class="muted small">${esc(src.notes)}</p>` : ''}
      <p class="muted small">Press <kbd>I</kbd> to flip between this layer and Mapbox.</p>
      <div class="row-btns"><button type="button" class="btn sm" data-img="reset" title="Clear saved overlay, enhance and zoom settings">Reset imagery settings</button></div>
    </div>`;
  }

  html += `<details class="subcard"><summary class="small">Add a custom layer (county GIS, WMS/XYZ)</summary>
      <div class="field"><label>Name</label><input class="input" id="cust-name" placeholder="Wayne County 2025"></div>
      <div class="field"><label>URL</label><input class="input" id="cust-url" placeholder="https://…/ImageServer or …/{z}/{x}/{y}.png"></div>
      <div class="field"><label>Captured</label><input type="date" class="input" id="cust-date"></div>
      <div class="row-btns"><button type="button" class="btn sm" data-img="add-custom">Add layer</button></div>
    </details>`;

  html += `<div class="subcard"><h2>SkyFi commercial archive</h2>${mapConfig?.skyfi ? `
      <p class="muted small">Searches SkyFi's archive (Vantor, Planet, Satellogic, …) over the current view. Results show capture date and price; ordering happens in SkyFi.</p>
      <div class="field"><label>Since</label><input type="date" class="input" id="sky-from" value="${new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10)}"></div>
      <div class="field"><label>Max cloud</label><div class="row"><input type="number" class="input" id="sky-cloud" value="20" min="0" max="100"><span class="unit">%</span></div></div>
      <div class="field"><label>Resolution</label><select id="sky-res">
        <option value="VERY HIGH,SUPER HIGH,ULTRA HIGH,CM 30,CM 50">Very high (≤ 50 cm)</option>
        <option value="HIGH,VERY HIGH,SUPER HIGH,ULTRA HIGH,CM 30,CM 50">High and better</option>
        <option value="">Any</option></select></div>
      <div class="row-btns"><button type="button" class="btn sm" data-img="skyfi">Search SkyFi here</button></div>
      <div id="sky-results">${renderSkyfi()}</div>`
    : '<p class="muted small">Add <code>SKYFI_API_KEY</code> to <code>.env</code> and restart to search SkyFi for recent 30–50 cm commercial captures (with price) before ordering.</p>'}</div>`;

  box.innerHTML = html;
  if (src?.type === 'wayback' && !waybackReleases) loadWayback().then(() => renderImagery()).catch(() => {});
}

function renderNewest() {
  if (!newestResults) return '';
  if (newestResults.loading) return '<div class="result">Checking every source at the map center…</div>';
  if (newestResults.error) return `<div class="result bad">${esc(newestResults.error)}</div>`;
  return `<table class="img-table">${newestResults.results.map((r) => `
    <tr class="${r.sourceId === newestResults.newest ? 'newest' : ''}">
      <td>${r.captured ? esc(r.capturedLabel || r.captured) : `<span class="muted">${esc(r.note || r.error || 'unknown')}</span>`}</td>
      <td>${esc(r.name)}<br><span class="muted small">${esc(r.resolution || '')}</span></td>
      <td>${r.sourceId === 'mapbox' ? '' : `<button type="button" class="btn sm" data-show="${esc(r.sourceId)}">Show</button>`}</td>
    </tr>`).join('')}</table>`;
}

async function findNewest() {
  if (!map) return;
  const c = map.getCenter();
  newestResults = { loading: true };
  renderImagery();
  try {
    newestResults = await api('GET', `/imagery/dates?lon=${c.lng.toFixed(6)}&lat=${c.lat.toFixed(6)}`);
  } catch (e) {
    newestResults = { error: e.message };
  }
  renderImagery();
}

/* ---- SkyFi */
function renderSkyfi() {
  if (!skyfiResults) return '';
  if (skyfiResults.loading) return '<div class="result">Searching SkyFi…</div>';
  if (skyfiResults.error) return `<div class="result bad">${esc(skyfiResults.error)}</div>`;
  if (!skyfiResults.items.length) return '<div class="result">No archive scenes match. Try an earlier date, more cloud, or any resolution.</div>';
  return `<p class="muted small">${skyfiResults.items.length} scene${skyfiResults.items.length === 1 ? '' : 's'} · AOI ${skyfiResults.aoiSqKm} km² · newest first</p>
    <ul class="sky-list">${skyfiResults.items.map((a, i) => `
      <li class="${skyfiSelected === i ? 'sel' : ''}" data-sky="${i}">
        <b>${esc(a.captured.slice(0, 10))}</b> · ${esc(a.provider)}${a.constellation ? ` ${esc(a.constellation)}` : ''}
        <span class="muted small"><br>${esc(a.resolution)}${a.resolutionCm ? ` (${a.resolutionCm} cm)` : ''} · ☁ ${a.cloudCoveragePercent ?? '?'}% · off-nadir ${a.offNadirAngle != null ? `${Math.round(a.offNadirAngle)}°` : '?'}
        · ${a.openData ? 'free' : `≈ $${a.estimatedPriceUsd.toLocaleString()} for ${a.billableSqKm} km²`}</span>
      </li>`).join('')}</ul>
    <p class="muted small">Click a scene to preview its footprint. Order on <a href="https://app.skyfi.com" target="_blank" rel="noopener">app.skyfi.com ↗</a>.</p>`;
}

async function searchSkyfi() {
  const b = map.getBounds();
  const res = $('#sky-res').value;
  const body = {
    bbox: [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()],
    fromDate: $('#sky-from').value,
    maxCloudCoveragePercent: Number($('#sky-cloud').value),
    resolutions: res ? res.split(',') : undefined,
  };
  const sel = byId(state.selectedId);
  if (sel && (sel.properties.kind === 'area' || sel.properties.kind === 'reference')) { delete body.bbox; body.polygon = sel.geometry; }
  skyfiResults = { loading: true };
  skyfiSelected = null;
  clearSkyfiPreview();
  renderImagery();
  try { skyfiResults = await api('POST', '/imagery/skyfi/archives', body); } catch (e) { skyfiResults = { error: e.message }; }
  renderImagery();
}

function clearSkyfiPreview() {
  clearScratch('__skyfi');
  if (map?.getLayer('lm-sky')) map.removeLayer('lm-sky');
  if (map?.getSource('lm-sky')) map.removeSource('lm-sky');
}
function previewSkyfi(i) {
  const a = skyfiResults?.items?.[i];
  if (!a) return;
  skyfiSelected = i;
  clearSkyfiPreview();
  const rings = a.footprint?.type === 'MultiPolygon' ? a.footprint.coordinates.map((p) => p[0]) : a.footprint ? [a.footprint.coordinates[0]] : [];
  const v = scratchView('__skyfi');
  rings.forEach((r, k) => v.overlay(`f${k}`, 'polygon', geo.openRing(r), { stroke: '#bf5af2', width: 2, dash: true, fill: '#bf5af2', fillOpacity: 0.05 }));
  // Preview raster: the scene's tile service if SkyFi provides one, else its thumbnail stretched over the footprint bounds.
  const before = map.getLayer('lm-fill') ? 'lm-fill' : undefined;
  if (a.tilesUrl && /\{z\}/.test(a.tilesUrl)) {
    map.addSource('lm-sky', { type: 'raster', tiles: [a.tilesUrl], tileSize: 256, attribution: `© ${a.provider} via SkyFi` });
  } else {
    const thumb = Object.entries(a.thumbnailUrls || {}).sort((x, y) => parseInt(y[0], 10) - parseInt(x[0], 10))[0]?.[1];
    if (thumb && rings.length) {
      const [w, s, e, n] = geo.bbox(rings.flat());
      map.addSource('lm-sky', { type: 'image', url: thumb, coordinates: [[w, n], [e, n], [e, s], [w, s]] });
    }
  }
  if (map.getSource('lm-sky')) map.addLayer({ id: 'lm-sky', type: 'raster', source: 'lm-sky', paint: { 'raster-opacity': 0.9 } }, before);
  if (rings.length) { const [w, s, e, n] = geo.bbox(rings.flat()); map.fitBounds([[w, s], [e, n]], { padding: 60, maxZoom: 17 }); }
  renderImagery();
}

function bindImagery() {
  const box = $('#imagery');
  $('#btn-imagery').onclick = () => { imagery.open = !imagery.open; renderImagery(); if (imagery.open) openPanel(); };
  $('#imagery-badge').onclick = () => { imagery.open = true; renderImagery(); openPanel(); };
  box.addEventListener('change', (e) => {
    const t = e.target;
    if (t.name === 'img') return setImagery(t.value || null);
    if (t.id === 'img-date') { imagery.date = t.value; saveImagery(); applyImagery(); }
    if (t.id === 'img-release') { imagery.releaseId = t.value; saveImagery(); applyImagery(); }
    if (t.id === 'img-enhance') setEnhance(t.value);
  });
  box.addEventListener('input', (e) => {
    if (e.target.id !== 'img-opacity') return;
    imagery.opacity = Number(e.target.value);
    e.target.nextElementSibling.textContent = `${Math.round(imagery.opacity * 100)}%`;
    for (const id of IMG_LAYERS) if (map?.getLayer(id)) map.setPaintProperty(id, 'raster-opacity', imagery.opacity);
    saveImagery();
  });
  box.addEventListener('click', (e) => {
    const t = e.target.closest('[data-img],[data-show],[data-sky],[data-del-custom]');
    if (!t) return;
    if (t.dataset.show) return setImagery(t.dataset.show);
    if (t.dataset.sky != null) return previewSkyfi(Number(t.dataset.sky));
    if (t.dataset.delCustom) {
      e.preventDefault();
      imagery.custom = imagery.custom.filter((c) => c.id !== t.dataset.delCustom);
      if (imagery.active === t.dataset.delCustom) imagery.active = null;
      saveImagery(); applyImagery(); renderImagery();
      return;
    }
    switch (t.dataset.img) {
      case 'close': imagery.open = false; renderImagery(); break;
      case 'dates': { const src = sourceById(imagery.active); if (src?.dated) loadAvailableDates(src); break; }
      case 'reset':
        Object.assign(imagery, { active: null, opacity: 1, hidden: false, enhance: 'off', lastEnhance: 'sharpen', nativeMax: {}, releaseId: null });
        ls.del('litemap:imagery');
        saveImagery(); applyImagery(); renderImagery();
        toast('Imagery settings reset');
        break;
      case 'newest': findNewest(); break;
      case 'skyfi': searchSkyfi(); break;
      case 'add-custom':
        try {
          const s = customSource({ id: `custom-${newId()}`, name: $('#cust-name').value.trim(), url: $('#cust-url').value, captured: $('#cust-date').value });
          imagery.custom.push(s);
          setImagery(s.id);
        } catch (err) { toast(err.message, true); }
        break;
      default:
    }
  });
}

/* ================================================================ sites */
function siteBody() {
  return {
    name: state.site.name, description: state.site.description, tags: state.site.tags, metadata: state.site.metadata,
    address: state.site.addressAuto ? '' : state.site.address, // '' = look it up from the map
    units: state.units, view: currentView(), features: { type: 'FeatureCollection', features: state.features },
  };
}
async function save() {
  if (READONLY) return;
  if (document.activeElement?.classList.contains('site-addr-input')) document.activeElement.blur(); // commit an address being typed
  const btn = $('#btn-save');
  btn.disabled = true;
  try {
    const site = state.site.id ? await api('PUT', `/sites/${state.site.id}`, siteBody()) : await api('POST', '/sites', siteBody());
    loadSite(site, { keepView: true });
    toast('Saved');
    post('litemap:saved', { siteId: site.id, site });
  } catch (e) {
    toast(`Save failed: ${e.message}`, true);
  } finally {
    btn.disabled = false;
  }
}
function loadSite(site, { keepView = false } = {}) {
  const sameSite = keepView && site.id && (state.site.id === site.id || state.site.id == null);
  const keepSel = sameSite ? state.selectedId : null;
  state.site = {
    id: site.id, name: site.name, address: site.address || '', addressAuto: site.addressAuto !== false,
    description: site.description || '', tags: site.tags || [], metadata: site.metadata || {},
  };
  state.features = (site.features?.features || []).map((f, i) => normalize(f, i));
  if (!sameSite) undoStack.length = 0;
  state.selectedId = keepSel && byId(keepSel) ? keepSel : null;
  state.dirty = false;
  $('#dirty').hidden = true;
  $('#site-name').value = state.site.name;
  renderAddress();
  document.title = `${state.site.name} · LiteMap`;
  if (!EMBED && site.id) {
    const u = new URL(location.href);
    u.searchParams.set('site', site.id);
    history.replaceState(null, '', u);
    ls.del('litemap:draft');
  }
  if (site.view?.mapType) setMapType(site.view.mapType);
  changed({ all: true, dirty: false });
  if (!keepView && map) {
    if (state.features.length) zoomTo(state.features);
    else if (site.view) applyView(site.view);
  }
  emitChangeSoon();
}
/* ---- site address: looked up from the map on save, or typed in */
function renderAddress() {
  const btn = $('#site-addr');
  if (!btn) return;
  const { address, addressAuto } = state.site;
  btn.classList.toggle('empty', !address);
  btn.querySelector('span').textContent = address || (READONLY ? '' : state.site.id ? 'Add address' : 'Address is found when you save');
  btn.hidden = READONLY && !address;
  btn.title = address
    ? `${address}
${addressAuto ? 'Found from the site location' : 'Typed in'}${READONLY ? '' : ' · click to edit'}`
    : 'Click to type an address, or save to look it up from the map';
}
function editAddress() {
  if (READONLY) return;
  const btn = $('#site-addr');
  const input = document.createElement('input');
  input.className = 'input site-addr-input';
  input.maxLength = 300;
  input.value = state.site.address;
  input.placeholder = 'Address (empty = find from map)';
  input.setAttribute('aria-label', 'Site address');
  btn.hidden = true;
  btn.after(input);
  input.focus(); input.select();
  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    const v = input.value.trim();
    input.remove();
    btn.hidden = false;
    if (commit && v !== state.site.address) {
      // a cleared field goes back to an automatic address, filled in on the next save
      Object.assign(state.site, { address: v, addressAuto: !v });
      markDirty();
      if (!v) toast('The address will be looked up from the map when you save');
    }
    renderAddress();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
}

async function openSite(id) {
  try { loadSite(await api('GET', `/sites/${encodeURIComponent(id)}`)); } catch (e) { toast(`Could not open site: ${e.message}`, true); }
}
function newSite() {
  if (state.dirty && state.features.length && !confirm('Discard unsaved changes?')) return;
  const u = new URL(location.href);
  u.searchParams.delete('site');
  history.replaceState(null, '', u);
  loadSite({ ...blankSite(), features: { features: [] } }, { keepView: true });
  ls.del('litemap:draft');
}
async function showSites() {
  const dlg = $('#sites-dialog');
  const render = async () => {
    const q = $('#sites-filter').value.trim();
    try {
      const { items } = await api('GET', `/sites?limit=200${q ? `&q=${encodeURIComponent(q)}` : ''}`);
      $('#sites-list').innerHTML = items.length ? items.map((s) => `
        <li><button type="button" class="open" data-open="${esc(s.id)}">
          <span class="site-row"><b>${esc(s.name)}</b><span class="saved" title="Last saved ${esc(new Date(s.updatedAt).toLocaleString())}">Saved ${esc(savedDate(s.updatedAt))}</span></span>
          ${s.address ? `<span class="muted small site-row-addr" title="${esc(s.address)}">📍 ${esc(s.address)}</span>` : ''}
          <span class="muted small">${s.summary.featureCount} item${s.summary.featureCount === 1 ? '' : 's'}${s.summary.totalAreaM2 ? ` · ${esc(fmtA(s.summary.totalAreaM2).split(' · ')[0])}` : ''} · ${esc(timeAgo(s.updatedAt))}${s.id === state.site.id ? ' · open now' : ''}</span></button>
          <button type="button" class="btn sm danger" data-del="${esc(s.id)}">Delete</button></li>`).join('')
        : '<li class="empty" style="display:block">No saved sites yet.</li>';
    } catch (e) { $('#sites-list').innerHTML = `<li class="empty" style="display:block">${esc(e.message)}</li>`; }
  };
  $('#sites-list').onclick = async (e) => {
    const open = e.target.closest('[data-open]')?.dataset.open;
    const del = e.target.closest('[data-del]')?.dataset.del;
    if (open) {
      if (state.dirty && state.features.length && !confirm('Discard unsaved changes?')) return;
      dlg.close();
      openSite(open);
    }
    if (del && confirm('Delete this site permanently?')) {
      await api('DELETE', `/sites/${del}`).catch((err) => toast(err.message, true));
      if (del === state.site.id) state.site.id = null;
      render();
    }
  };
  $('#sites-filter').oninput = debounce(render, 250);
  dlg.showModal();
  render();
}
/** "Nov 9, 2026, 2:14 PM" in the viewer's locale. */
const savedDate = (iso) => new Date(iso).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
function timeAgo(iso) {
  const sec = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (sec < 60) return 'just now';
  const units = [[60, 'min'], [24, 'h'], [7, 'd'], [4.35, 'wk'], [12, 'mo'], [Infinity, 'yr']];
  let v = sec / 60;
  for (const [n, u] of units) { if (v < n) return `${Math.floor(v)} ${u} ago`; v /= n; }
  return '';
}
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

/* ================================================================ import/export */
function exportGeoJSON() {
  const fc = { type: 'FeatureCollection', properties: { name: state.site.name, address: state.site.address, siteId: state.site.id, exportedAt: new Date().toISOString() }, features: state.features };
  download(`${safeName()}.geojson`, JSON.stringify(fc, null, 2), 'application/geo+json');
}
function exportCSV() {
  const cols = ['name', 'kind', 'length_m', 'length_ft', 'area_m2', 'area_ft2', 'acres', 'perimeter_m', 'perimeter_ft', 'width_m', 'length_dim_m', 'rotation_deg', 'clearance_m', 'center_lat', 'center_lon', 'notes'];
  const q = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const r2 = (v, d = 2) => (v == null ? '' : +v.toFixed(d));
  const rows = state.features.map((f) => {
    const p = f.properties, m = p.metrics, r = p.reference;
    const c = r ? r.center : p.kind === 'marker' ? f.geometry.coordinates : p.kind === 'area' ? geo.centroid(verts(f)) : geo.pointAlong(verts(f), 0.5);
    return [p.name, p.kind, r2(m.lengthM), r2(m.lengthM && m.lengthM / geo.FT), r2(m.areaM2), r2(m.areaM2 && m.areaM2 / geo.SQFT, 0), r2(m.areaM2 && m.areaM2 / geo.ACRE, 4),
      r2(m.perimeterM), r2(m.perimeterM && m.perimeterM / geo.FT), r2(r?.width), r2(r?.length), r2(r?.rotation, 1), r2(r?.clearance), c[1].toFixed(7), c[0].toFixed(7), p.notes].map(q).join(',');
  });
  download(`${safeName()}.csv`, [cols.join(','), ...rows].join('\n'), 'text/csv');
}
function summaryText() {
  const lines = [`${state.site.name}`, ...(state.site.address ? [state.site.address] : []), `Measured ${new Date().toLocaleDateString()} with LiteMap`, ''];
  for (const f of state.features) {
    const p = f.properties, m = p.metrics;
    let v;
    if (p.kind === 'distance') v = fmtL(m.lengthM);
    else if (p.kind === 'area') v = `${fmtA(m.areaM2)} (perimeter ${fmtL(m.perimeterM)})`;
    else if (p.kind === 'reference') v = `${geo.fmtDims(p.reference.width, p.reference.length, state.units, p.reference.shape)}, ${fmtA(m.areaM2).split(' · ')[0]}${p.reference.clearance ? `, ${fmtL(p.reference.clearance)} clearance` : ''}`;
    else if (p.kind === 'text') v = `“${p.text.replace(/\s+/g, ' ').slice(0, 120)}”`;
    else if (p.kind === 'drawing') v = `freehand, ${fmtL(m.lengthM)}`;
    else v = metricText(f);
    lines.push(`• ${p.name}: ${v}${p.notes ? ` (${p.notes})` : ''}`);
  }
  const t = totals();
  lines.push('');
  if (t.areaCount) lines.push(`Total area: ${fmtA(t.areaM2)}`);
  if (t.lengthCount) lines.push(`Total distance: ${fmtL(t.lengthM)}`);
  if (state.site.id) lines.push(`View: ${location.origin}/?site=${state.site.id}`);
  return lines.join('\n');
}
async function importFile(file) {
  try {
    const data = JSON.parse(await file.text());
    const list = data.type === 'FeatureCollection' ? data.features : data.type === 'Feature' ? [data] : [{ type: 'Feature', geometry: data, properties: {} }];
    const added = [];
    for (const f of list) {
      try {
        if (f.geometry?.type === 'MultiPolygon') f.geometry.coordinates.forEach((c) => added.push(normalize({ type: 'Feature', geometry: { type: 'Polygon', coordinates: c }, properties: { ...f.properties } })));
        else if (f.geometry?.type === 'MultiLineString') f.geometry.coordinates.forEach((c) => added.push(normalize({ type: 'Feature', geometry: { type: 'LineString', coordinates: c }, properties: { ...f.properties } })));
        else added.push(normalize(f));
      } catch { /* skip unsupported geometry */ }
    }
    if (!added.length) return toast('No supported features (Point, LineString, Polygon) found', true);
    pushUndo();
    const ids = new Set(state.features.map((f) => f.id));
    added.forEach((f) => { if (ids.has(f.id)) f.id = newId(); state.features.push(f); });
    if (data.properties?.name && state.site.name === 'Untitled site') { state.site.name = data.properties.name; $('#site-name').value = state.site.name; }
    changed({ all: true });
    zoomTo(added);
    toast(`Imported ${added.length} feature${added.length > 1 ? 's' : ''}`);
  } catch (e) {
    toast(`Import failed: ${e.message}`, true);
  }
}

async function menuAction(act) {
  $('#menu-panel').hidden = true;
  switch (act) {
    case 'new': return newSite();
    case 'import': return $('#file-input').click();
    case 'export-geojson': return exportGeoJSON();
    case 'export-csv': return exportCSV();
    case 'copy-summary': return copy(summaryText(), 'Summary');
    case 'copy-link':
      if (!state.site.id) return toast('Save the site first');
      return copy(`${location.origin}/?site=${state.site.id}`, 'Link');
    case 'copy-embed':
      if (!state.site.id) return toast('Save the site first');
      return copy(`<iframe src="${location.origin}/?embed=1&site=${state.site.id}" width="100%" height="600" style="border:0;border-radius:12px" allow="geolocation" title="${esc(state.site.name)}"></iframe>`, 'Embed code');
    case 'snapshot':
      if (!state.site.id || state.dirty) { if (!confirm('Save the site first?')) return; await save(); }
      try {
        const { url } = await api('GET', `/sites/${state.site.id}/snapshot?size=640x480&scale=2&mapType=${state.mapType}`);
        window.open(url, '_blank', 'noopener');
      } catch (e) { toast(e.message, true); }
      return undefined;
    default: return undefined;
  }
}

/* ================================================================ embedding (postMessage) */
function post(type, payload = {}) {
  if (window.parent === window) return;
  window.parent.postMessage({ source: 'litemap', type, ...payload }, PARENT_ORIGIN);
}
let changeTimer;
function emitChangeSoon() {
  clearTimeout(changeTimer);
  changeTimer = setTimeout(() => post('litemap:change', { siteId: state.site.id, dirty: state.dirty, features: { type: 'FeatureCollection', features: state.features }, totals: totals() }), 250);
}
function bindMessages() {
  window.addEventListener('message', async (e) => {
    if (PARENT_ORIGIN !== '*' && e.origin !== PARENT_ORIGIN) return;
    const m = e.data;
    if (!m || typeof m.type !== 'string' || !m.type.startsWith('litemap:')) return;
    try {
      switch (m.type) {
        case 'litemap:loadSite': await openSite(m.siteId); break;
        case 'litemap:setFeatures': {
          const list = m.features?.type === 'FeatureCollection' ? m.features.features : m.features || [];
          pushUndo();
          state.features = list.map((f, i) => normalize(f, i));
          state.selectedId = null;
          changed({ all: true });
          if (m.zoom !== false) zoomTo(state.features);
          break;
        }
        case 'litemap:addFeature': {
          const f = normalize(m.feature);
          addFeature(f, { select: m.select !== false });
          if (m.zoom) zoomTo([f]);
          break;
        }
        case 'litemap:removeFeature': deleteFeature(m.featureId); break;
        case 'litemap:selectFeature': select(m.featureId); break;
        case 'litemap:setView':
          if (m.center) { if (m.zoom != null) applyView(m); else goTo(m.center, m.meters || 300); }
          if (m.mapType) setMapType(m.mapType);
          break;
        case 'litemap:fitAll': zoomTo(state.features); break;
        case 'litemap:setUnits': setUnits(m.units); break;
        case 'litemap:setTool': setTool(m.tool); break;
        case 'litemap:save': await save(); break;
        case 'litemap:getState':
          post('litemap:state', { requestId: m.requestId, siteId: state.site.id, site: state.site, dirty: state.dirty, view: currentView(), features: { type: 'FeatureCollection', features: state.features }, totals: totals() });
          break;
        default:
      }
    } catch (err) {
      post('litemap:error', { requestId: m.requestId, message: err.message });
    }
  });
}

/* ================================================================ chrome bindings */
function openPanel() { $('#panel').classList.add('open'); }

function bindChrome() {
  bindImagery();
  bindPen();
  $$('.tool[data-tool]').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
  $('#btn-undo').onclick = undo;
  $('#btn-fit').onclick = () => zoomTo(state.features);
  $('#btn-save').onclick = save;
  $('#btn-sites').onclick = showSites;
  $('#units').onclick = (e) => { const u = e.target.closest('[data-units]')?.dataset.units; if (u) setUnits(u); };
  $('#map-type').onchange = (e) => setMapType(e.target.value);
  $('#show-labels').checked = state.showLabels;
  $('#show-labels').onchange = (e) => { state.showLabels = e.target.checked; ls.set('litemap:labels', state.showLabels); syncAllViews(); };
  $('#show-skins').checked = state.showSkins;
  $('#show-skins').onchange = (e) => { state.showSkins = e.target.checked; ls.set('litemap:skins', state.showSkins); syncAllViews(); renderGhost(); };
  $('#show-3d').checked = state.show3d;
  $('#show-3d').onchange = (e) => set3d(e.target.checked);
  $('#show-buildings').checked = state.showBuildings;
  $('#show-buildings').onchange = (e) => { state.showBuildings = e.target.checked; ls.set('litemap:buildings', state.showBuildings); sync3d(); };
  $('#show-ballast').checked = state.showBallast;
  $('#show-ballast').onchange = (e) => { state.showBallast = e.target.checked; ls.set('litemap:ballast', state.showBallast); syncAllViews(); renderGhost(); };
  $('#site-addr').addEventListener('click', editAddress);
  renderAddress();
  $('#site-name').addEventListener('input', (e) => { state.site.name = e.target.value || 'Untitled site'; document.title = `${state.site.name} · LiteMap`; markDirty(); });
  if (READONLY) $('#site-name').readOnly = true;
  $('#panel-grip').onclick = () => $('#panel').classList.toggle('open');

  $('#btn-more').onclick = (e) => { e.stopPropagation(); $('#menu-panel').hidden = !$('#menu-panel').hidden; };
  $('#menu-panel').onclick = (e) => { const a = e.target.closest('[data-act]'); if (a) menuAction(a.dataset.act); };
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.menu')) $('#menu-panel').hidden = true;
    if (!e.target.closest('.search')) $('#search-results').hidden = true;
  });

  $('#search-form').onsubmit = (e) => { e.preventDefault(); const q = $('#search').value.trim(); if (q) doSearch(q); };
  $('#catalog-filter').oninput = renderCatalog;
  $('#catalog-list').onclick = (e) => {
    if (e.target.closest('[data-upload]')) return uploadObject();
    if (e.target.closest('[data-build-tent]')) return buildTent();
    const del = e.target.closest('[data-obj-del]');
    if (del) { e.stopPropagation(); return deleteObject(del.dataset.objDel); }
    const mo = e.target.closest('[data-model]');
    const ob = e.target.closest('[data-obj]');
    const b = e.target.closest('[data-tpl]');
    if (!mo && !ob && !b) return;
    state.template = mo ? modelTemplate(modelById(mo.dataset.model)) : ob ? objTemplate(objectById(ob.dataset.obj)) : REFERENCE_BY_ID[b.dataset.tpl];
    renderCatalog();
    updateHint();
  };
  $('#catalog-list').onkeydown = (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[data-obj],[data-model]')) { e.preventDefault(); e.target.click(); } };

  $('#feature-list').addEventListener('click', (e) => { const li = e.target.closest('li[data-id]'); if (li) select(li.dataset.id); });
  $('#feature-list').addEventListener('dblclick', (e) => { const li = e.target.closest('li[data-id]'); if (li) zoomTo([byId(li.dataset.id)]); });

  $('#file-input').onchange = (e) => { const f = e.target.files[0]; if (f) importFile(f); e.target.value = ''; };
  document.addEventListener('dragover', (e) => { if (!READONLY) e.preventDefault(); });
  document.addEventListener('drop', (e) => {
    if (READONLY) return;
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    if (f && /^image\//.test(f.type)) { if (!$('#object-dialog').open) uploadObject(f); } else if (f) importFile(f);
  });

  window.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); save(); return; }
    if (typing) { if (e.key === 'Escape') e.target.blur(); return; }
    if (document.querySelector('dialog[open]')) return;
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (!READONLY) undo(); return; }
    if (mod) return;
    switch (e.key) {
      case 'Escape':
        if (state.draft) cancelDraft();
        else if (state.tool !== 'select') setTool('select');
        else select(null);
        break;
      case 'Enter': if (state.draft) finishDraft(); break;
      case 'Backspace':
        if (state.draft) { e.preventDefault(); undo(); } else if (state.selectedId && !READONLY) deleteFeature(state.selectedId);
        break;
      case 'Delete': if (state.selectedId && !READONLY) deleteFeature(state.selectedId); break;
      case 'v': case 'V': setTool('select'); break;
      case 't': case 'T': setTool('text'); break;
      case 'b': case 'B': setTool('drawing'); break;
      case 'd': case 'D': setTool('distance'); break;
      case 'a': case 'A': setTool('area'); break;
      case 'p': case 'P': setTool('marker'); break;
      case 'r': case 'R': setTool('reference'); break;
      case 'u': case 'U': if (!READONLY) uploadObject(); break;
      case 'f': case 'F': zoomTo(state.features); break;
      case 'i': case 'I': toggleImageryHidden(); break;
      case 'e': case 'E': toggleEnhance(); break;
      default:
    }
  });
  window.addEventListener('beforeunload', (e) => { if (state.dirty && state.features.length && !EMBED) e.preventDefault(); });
}

/* ================================================================ map boot */
function showSetup(err) {
  const box = $('#setup');
  box.hidden = false;
  box.innerHTML = `<div class="box">
    <h1>Connect Mapbox</h1>
    <p class="err">${esc(err?.error?.message || err?.message || 'The map could not be loaded.')}</p>
    <p>LiteMap renders satellite imagery with <b>Mapbox GL JS</b>. It needs a Mapbox access token:</p>
    <ol>
      <li>Create or copy a <b>public token</b> (<code>pk.…</code>) at <a href="https://account.mapbox.com/access-tokens/" target="_blank" rel="noopener">account.mapbox.com/access-tokens</a>.</li>
      <li>If the token has URL restrictions, add this site's address (<code>${esc(location.origin)}</code>).</li>
      <li>Put it in <code>.env</code>:<pre>MAPBOX_TOKEN=pk.your_token</pre></li>
      <li>Restart with <code>npm start</code> and reload this page.</li>
    </ol>
    <p class="muted small">The REST API (<a href="/docs">/docs</a>) works without a map token, except geocoding and snapshots.</p>
  </div>`;
}

async function initMap() {
  if (map) return;
  if (!window.mapboxgl) return showSetup({ message: 'Could not load Mapbox GL JS from api.mapbox.com. Check your network or content blockers.' });
  try {
    const r = await fetch('/api/v1/map/config');
    mapConfig = await r.json();
    if (!r.ok) throw mapConfig;
  } catch (e) {
    return showSetup(e);
  }
  mapboxgl.accessToken = mapConfig.accessToken;
  const lastView = !EMBED && ls.get('litemap:view');
  map = new mapboxgl.Map({
    container: 'map',
    style: `mapbox://styles/mapbox/${MAP_TYPES[state.mapType]}`,
    center: lastView?.center || [-98.5795, 39.8283],
    zoom: lastView?.center ? lastView.zoom ?? 17 : 3.5,
    bearing: lastView?.bearing || 0,
    maxZoom: 22,
    projection: 'mercator',
    pitchWithRotate: false,
    touchPitch: false,
    doubleClickZoom: false,
    attributionControl: true,
  });
  map._lmStyle = state.mapType;
  map.addControl(new mapboxgl.NavigationControl({ visualizePitch: false }), 'top-right');
  if (!EMBED) map.addControl(new mapboxgl.GeolocateControl({ positionOptions: { enableHighAccuracy: true } }), 'top-right');
  scaleControl = new mapboxgl.ScaleControl({ maxWidth: 140, unit: state.units });
  map.addControl(scaleControl, 'bottom-left');
  map.on('style.load', ensureLayers);
  if (state.show3d) map.once('load', () => set3d(true));
  map.on('zoom', labelScale);
  labelScale();
  map.on('moveend', debounce(() => { if (!EMBED) ls.set('litemap:view', currentView()); }, 400));
  map.on('moveend', () => {
    if (imagery.active) { refreshCenterDate(); renderImageryBadge(); }
    if (imagery.open && !$('#imagery').contains(document.activeElement)) renderImagery();
  });
  map.on('error', (e) => {
    const status = e.error?.status;
    if (IMG_LAYERS.includes(e.sourceId)) {
      imgErrors.count++;
      imgErrors.status = status || e.error?.message?.slice(0, 40) || null;
      renderImageryBadge();
      if (imgErrors.count === 8) toast(`${sourceById(imagery.active)?.name || 'Overlay'}: tiles are failing to load${imgErrors.status ? ` (${imgErrors.status})` : ''}`, true);
      return;
    }
    const url = e.error?.url || '';
    const mapboxSource = !e.sourceId || /mapbox/.test(e.sourceId) || /api\.mapbox\.com/.test(url);
    if ((status === 401 || status === 403) && mapboxSource) showSetup({ message: `Mapbox rejected the access token (${status}). Check MAPBOX_TOKEN and its URL restrictions.` });
  });
  // GPU resets (e.g. heavy GPU use elsewhere) blank the map until it recovers; never leave AI running into another one.
  map.on('webglcontextlost', () => {
    toast('The graphics context was reset by the browser; the map will redraw.', true);
    if (imagery.enhance === 'ai') setEnhance('sharpen');
  });
  map.once('load', ensureLayers);
  // Input and site loading don't need tiles: shapes are buffered until the layer exists.
  bindPointer();
  boot();
}

/** The server's local catalog (data/catalog.json, e.g. a company's own tents) joins the built-in one before any site loads. */
async function loadCatalog() {
  try {
    const res = await fetch('/api/v1/reference-objects');
    if (!res.ok) return;
    if (addReferenceObjects((await res.json()).items || []) && state.tool === 'reference') renderCatalog();
  } catch { /* offline: built-in catalog only */ }
}

async function boot() {
  await loadCatalog();
  if (!EMBED) { loadObjects({ quiet: true }); loadModels().then(openModelFromUrl); }
  const siteId = params.get('site');
  if (siteId) {
    await openSite(siteId);
  } else {
    const draft = !EMBED && ls.get('litemap:draft');
    if (draft?.features?.length) {
      state.site = { ...blankSite(), ...draft.site };
      state.features = draft.features.map((f, i) => normalize(f, i));
      $('#site-name').value = state.site.name;
      renderAddress();
      changed({ all: true });
      zoomTo(state.features);
      toast('Restored your unsaved work');
    }
  }
  post('litemap:ready', { siteId: state.site.id, readonly: READONLY });
}

/* ---------------------------------------------------------------- start */
bindChrome();
bindInspector();
bindMessages();
setUnits(state.units);
setMapType(state.mapType);
setTool('select');
renderList();
initMap();
