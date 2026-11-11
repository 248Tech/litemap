/* Validation + normalization of sites and features. Metrics are always recomputed server-side. */
import { measureGeometry, footprintRing, centroid, closeRing, normDeg, openRing } from '../public/js/geo.js';
import { REFERENCE_BY_ID } from '../public/js/references.js';
import { ROOFS, WALLS, SIDES, LIMITS, isTent, cleanTent } from '../public/js/tentspec.js';
import { newId } from './store.js';

export class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
const bad = (msg, details) => { throw new HttpError(400, 'invalid_request', msg, details); };

/** Tent builder settings: roof style, leg/peak heights and bay spacing (metres), sidewalls per side. */
export function validateTent(t) {
  if (!isObj(t)) bad('reference.tent must be an object');
  if (t.roof != null && !ROOFS.includes(t.roof)) bad(`reference.tent.roof must be one of ${ROOFS.join(', ')}`);
  for (const k of ['bay', 'eave', 'peak']) {
    if (t[k] == null) continue;
    const [min, max] = LIMITS[k];
    if (typeof t[k] !== 'number' || !Number.isFinite(t[k]) || t[k] < min || t[k] > max) bad(`reference.tent.${k} must be a number of metres from ${min} to ${max}`);
  }
  if (t.eave != null && t.peak != null && t.peak <= t.eave) bad('reference.tent.peak must be higher than reference.tent.eave');
  if (t.walls != null) {
    if (!isObj(t.walls)) bad('reference.tent.walls must be an object');
    for (const [side, kind] of Object.entries(t.walls)) {
      if (!SIDES.includes(side)) bad(`reference.tent.walls: unknown side ${side} (use ${SIDES.join(', ')})`);
      if (!WALLS.includes(kind)) bad(`reference.tent.walls.${side} must be one of ${WALLS.join(', ')}`);
    }
  }
  return cleanTent(t);
}

export const KINDS = ['distance', 'area', 'marker', 'reference', 'text', 'drawing'];
export const DEFAULT_COLORS = { distance: '#ffd60a', area: '#30d158', marker: '#ff453a', reference: '#64d2ff', text: '#ffffff', drawing: '#ff9f0a' };
const KIND_FOR_GEOM = { LineString: 'distance', Polygon: 'area', Point: 'marker' };
const GEOM_FOR_KIND = { distance: 'LineString', area: 'Polygon', marker: 'Point', text: 'Point', drawing: 'LineString' };
const MAX_VERTICES = 20000;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v, max, field) => {
  if (v == null) return '';
  if (typeof v !== 'string') bad(`${field} must be a string`);
  if (v.length > max) bad(`${field} must be at most ${max} characters`);
  return v.trim();
};
const finite = (v, field, { min = -Infinity, max = Infinity } = {}) => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) bad(`${field} must be a number`);
  if (n < min || n > max) bad(`${field} must be between ${min} and ${max}`);
  return n;
};
const jsonBlob = (v, field, maxBytes = 16384) => {
  if (v == null) return undefined;
  if (!isObj(v)) bad(`${field} must be an object`);
  if (JSON.stringify(v).length > maxBytes) bad(`${field} must serialize to at most ${maxBytes} bytes`);
  return v;
};

export function lonLat(v, field = 'coordinate') {
  if (!Array.isArray(v) || v.length < 2) bad(`${field} must be [longitude, latitude]`);
  const lon = finite(v[0], `${field}[0] (longitude)`, { min: -180, max: 180 });
  const lat = finite(v[1], `${field}[1] (latitude)`, { min: -90, max: 90 });
  return [lon, lat];
}

export function validateGeometry(g, expected) {
  if (!isObj(g)) bad('geometry must be a GeoJSON geometry object');
  if (expected && g.type !== expected) bad(`geometry must be a ${expected}`);
  const c = g.coordinates;
  switch (g.type) {
    case 'Point':
      return { type: 'Point', coordinates: lonLat(c, 'geometry.coordinates') };
    case 'LineString': {
      if (!Array.isArray(c) || c.length < 2) bad('LineString needs at least 2 positions');
      if (c.length > MAX_VERTICES) bad('too many vertices');
      return { type: 'LineString', coordinates: c.map((p, i) => lonLat(p, `geometry.coordinates[${i}]`)) };
    }
    case 'Polygon': {
      if (!Array.isArray(c) || !c.length) bad('Polygon needs at least one ring');
      const rings = c.map((ring, r) => {
        if (!Array.isArray(ring)) bad(`ring ${r} must be an array`);
        const pts = openRing(ring.map((p, i) => lonLat(p, `geometry.coordinates[${r}][${i}]`)));
        if (pts.length < 3) bad(`ring ${r} needs at least 3 distinct positions`);
        if (pts.length > MAX_VERTICES) bad('too many vertices');
        return closeRing(pts);
      });
      return { type: 'Polygon', coordinates: rings };
    }
    default:
      return bad(`unsupported geometry type: ${g.type}`);
  }
}

/** Accepts a Feature (or a bare geometry) and returns a normalized LiteMap feature. */
export function normalizeFeature(input, index = 0) {
  if (!isObj(input)) bad('feature must be an object');
  const f = input.type === 'Feature' ? input : { type: 'Feature', geometry: input, properties: {} };
  const p = isObj(f.properties) ? f.properties : {};
  const kind = p.kind ?? (isObj(p.reference) ? 'reference' : f.geometry?.type === 'Point' && p.text != null ? 'text' : KIND_FOR_GEOM[f.geometry?.type]);
  if (!KINDS.includes(kind)) bad(`properties.kind must be one of ${KINDS.join(', ')}`);

  let id = f.id ?? p.id;
  if (id != null) {
    id = String(id);
    if (!/^[\w.-]{1,64}$/.test(id)) bad('feature id must be 1-64 chars of [A-Za-z0-9_.-]');
  } else id = newId(6);

  const color = p.color == null ? DEFAULT_COLORS[kind] : String(p.color);
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) bad('properties.color must be a #rrggbb hex color');

  const props = {
    kind,
    name: str(p.name, 200, 'properties.name'),
    color,
    notes: str(p.notes, 5000, 'properties.notes'),
  };
  if (p.showLabel != null && typeof p.showLabel !== 'boolean') bad('properties.showLabel must be a boolean');
  if (p.showLabel === false && kind !== 'text') props.showLabel = false;
  if (p.showMeasurements != null && typeof p.showMeasurements !== 'boolean') bad('properties.showMeasurements must be a boolean');
  if (p.showMeasurements === true && ['distance', 'area', 'reference', 'drawing'].includes(kind)) props.showMeasurements = true;
  const data = jsonBlob(p.data, 'properties.data');
  if (data) props.data = data;

  let geometry;
  if (kind === 'reference') {
    const r = isObj(p.reference) ? p.reference : {};
    const tpl = r.templateId ? REFERENCE_BY_ID[r.templateId] : null;
    if (r.templateId && !tpl) bad(`unknown reference templateId: ${r.templateId}`);
    const shape = r.shape ?? tpl?.shape ?? 'rect';
    if (!['rect', 'circle'].includes(shape)) bad('reference.shape must be rect or circle');
    const width = finite(r.width ?? tpl?.width, 'reference.width', { min: 0.01, max: 10000 });
    const length = shape === 'circle' ? width : finite(r.length ?? tpl?.length ?? width, 'reference.length', { min: 0.01, max: 10000 });
    const rotation = normDeg(finite(r.rotation ?? 0, 'reference.rotation'));
    const clearance = finite(r.clearance ?? 0, 'reference.clearance', { min: 0, max: 1000 });
    let center = r.center;
    if (center == null && f.geometry?.type === 'Point') center = f.geometry.coordinates;
    if (center == null && f.geometry?.type === 'Polygon') center = centroid(validateGeometry(f.geometry).coordinates[0]);
    if (center == null) bad('reference objects need reference.center or a Point geometry');
    center = lonLat(center, 'reference.center');
    props.reference = { templateId: tpl?.id ?? null, shape, width, length, rotation, clearance, center };
    if (r.objectId != null) {
      if (typeof r.objectId !== 'string' || !/^[\w-]{6,32}$/.test(r.objectId)) bad('reference.objectId must be an uploaded object id');
      if (shape !== 'rect') bad('uploaded objects must use shape rect');
      props.reference.objectId = r.objectId;
      props.reference.opacity = finite(r.opacity ?? 1, 'reference.opacity', { min: 0.05, max: 1 });
      props.reference.lockAspect = r.lockAspect !== false;
    }
    if (r.tent != null) {
      if (!isTent(tpl?.id)) bad('reference.tent is only allowed on tent templates (tent-*)');
      props.reference.tent = validateTent(r.tent);
      if (!props.reference.tent) delete props.reference.tent;
    } else if (tpl?.tent) props.reference.tent = cleanTent(tpl.tent) ?? undefined; // a catalog tent's own roof, heights and walls
    if (props.reference.tent === undefined) delete props.reference.tent;
    geometry = { type: 'Polygon', coordinates: [footprintRing({ center, shape, width, length, rotation })] };
    if (!props.name) props.name = tpl?.name ?? 'Reference object';
  } else {
    geometry = validateGeometry(f.geometry, GEOM_FOR_KIND[kind]);
    const st = isObj(p.style) ? p.style : {};
    if (kind === 'text') {
      props.text = str(p.text, 1000, 'properties.text');
      if (!props.text) bad('text features need properties.text');
      props.style = { size: finite(st.size ?? 16, 'properties.style.size', { min: 8, max: 72 }), box: st.box !== false };
      if (!props.name) props.name = props.text.split('\n')[0].slice(0, 60);
    }
    if (kind === 'drawing') props.style = { width: finite(st.width ?? 4, 'properties.style.width', { min: 0.5, max: 40 }) };
    if (!props.name) props.name = { distance: 'Distance', area: 'Area', marker: 'Marker', drawing: 'Drawing' }[kind] + ` ${index + 1}`;
  }
  props.metrics = measureGeometry(geometry);
  return { type: 'Feature', id, geometry, properties: props };
}

export function normalizeFeatureList(input) {
  if (input == null) return [];
  const arr = Array.isArray(input) ? input : input.type === 'FeatureCollection' ? input.features : bad('features must be a FeatureCollection or an array of Features');
  if (!Array.isArray(arr)) bad('features must be an array');
  if (arr.length > 2000) bad('a site may hold at most 2000 features');
  const seen = new Set();
  return arr.map((f, i) => {
    let n;
    try { n = normalizeFeature(f, i); } catch (e) {
      if (e instanceof HttpError) e.message = `features[${i}]: ${e.message}`;
      throw e;
    }
    if (seen.has(n.id)) n.id = newId(6);
    seen.add(n.id);
    return n;
  });
}

const MAP_TYPES = ['hybrid', 'satellite', 'streets', 'light'];

export function normalizeSiteFields(input, base = {}) {
  if (!isObj(input)) bad('body must be a JSON object');
  const out = { ...base };
  if ('name' in input || !base.name) out.name = str(input.name, 200, 'name') || base.name || 'Untitled site';
  if ('description' in input) out.description = str(input.description, 5000, 'description');
  if ('tags' in input) {
    if (!Array.isArray(input.tags) || input.tags.length > 50) bad('tags must be an array of at most 50 strings');
    out.tags = input.tags.map((t, i) => str(t, 64, `tags[${i}]`)).filter(Boolean);
  }
  if ('metadata' in input) out.metadata = jsonBlob(input.metadata, 'metadata') ?? {};
  if ('units' in input) {
    if (!['imperial', 'metric'].includes(input.units)) bad('units must be imperial or metric');
    out.units = input.units;
  }
  if ('view' in input) {
    const v = input.view;
    if (v == null) out.view = null;
    else {
      if (!isObj(v)) bad('view must be an object');
      out.view = { center: lonLat(v.center, 'view.center') };
      if (v.zoom != null) out.view.zoom = finite(v.zoom, 'view.zoom', { min: 0, max: 24 });
      if (v.bearing != null) out.view.bearing = normDeg(finite(v.bearing, 'view.bearing'));
      if (v.mapType != null) {
        if (!MAP_TYPES.includes(v.mapType)) bad(`view.mapType must be one of ${MAP_TYPES.join(', ')}`);
        out.view.mapType = v.mapType;
      }
    }
  }
  if ('features' in input) out.features = normalizeFeatureList(input.features);
  if ('address' in input) {
    const a = input.address == null ? '' : str(input.address, 300, 'address');
    if (a) Object.assign(out, { address: a, addressAuto: false, addressPoint: null });
    // empty = "look it up from the map"; an address that is already automatic is kept
    else if (base.addressAuto === false || !base.address) Object.assign(out, { address: '', addressAuto: true, addressPoint: null });
  }
  out.address ??= '';
  out.addressAuto ??= true;
  out.addressPoint ??= null;
  out.description ??= '';
  out.tags ??= [];
  out.metadata ??= {};
  out.units ??= 'imperial';
  out.view ??= null;
  out.features ??= [];
  return out;
}

export function summarize(features) {
  const counts = { distance: 0, area: 0, marker: 0, reference: 0, text: 0, drawing: 0 };
  let totalAreaM2 = 0, totalLengthM = 0;
  for (const f of features) {
    counts[f.properties.kind]++;
    if (f.properties.kind === 'area') totalAreaM2 += f.properties.metrics.areaM2 || 0;
    if (f.properties.kind === 'distance') totalLengthM += f.properties.metrics.lengthM || 0;
  }
  return {
    featureCount: features.length,
    counts,
    totalAreaM2: Math.round(totalAreaM2 * 100) / 100,
    totalLengthM: Math.round(totalLengthM * 1000) / 1000,
  };
}

/** Public representation of a stored site. */
export function presentSite(site, { withFeatures = true } = {}) {
  const { features, addressPoint: _ap, ...rest } = site;
  const out = { ...rest, address: site.address || '', addressAuto: site.addressAuto !== false, summary: summarize(features) };
  if (withFeatures) out.features = { type: 'FeatureCollection', features };
  return out;
}
