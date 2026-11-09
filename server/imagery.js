/*
 * Imagery freshness lookups and the SkyFi archive client.
 */
import { IMAGERY_SOURCES, coversPoint } from '../public/js/imagery.js';
import { ringArea, openRing } from '../public/js/geo.js';

const TIMEOUT = 15000;
const upstream = (who, status) => Object.assign(new Error(`${who} request failed (${status})`), { status: 502, code: 'upstream_error' });

async function getJson(url, init = {}) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT) });
  if (!res.ok) throw Object.assign(upstream(new URL(url).hostname, res.status), { upstreamStatus: res.status, body: await res.text().catch(() => '') });
  return res.json();
}

/** Normalize the many date shapes ArcGIS metadata uses into YYYY-MM-DD. */
export function parseDate(v) {
  if (v == null || v === '' || v === 'Null') return null;
  if (typeof v === 'number') return v > 1e11 ? new Date(v).toISOString().slice(0, 10) : parseDate(String(v));
  const s = String(v).trim();
  let m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}

/** Capture date/resolution of Esri World Imagery (or a Wayback metadata layer) at a point. */
export async function esriMetadataAt(serviceUrl, [lon, lat]) {
  const d = 0.0015;
  const u = new URL(`${serviceUrl}/identify`);
  Object.entries({
    geometry: `${lon},${lat}`, geometryType: 'esriGeometryPoint', sr: '4326', layers: 'all', tolerance: '1',
    mapExtent: `${lon - d},${lat - d},${lon + d},${lat + d}`, imageDisplay: '1000,1000,96', returnGeometry: 'false', f: 'json',
  }).forEach(([k, v]) => u.searchParams.set(k, v));
  const body = await getJson(u);
  const rows = (body.results || []).map((r) => {
    const a = r.attributes || {};
    const date = parseDate(a['DATE (YYYYMMDD)'] ?? a.SRC_DATE2 ?? a.SRC_DATE);
    const res = Number(a['RESOLUTION (M)'] ?? a.SRC_RES);
    const maxZoom = Number(a.MaxMapLevel);
    return { date, resolutionM: Number.isFinite(res) ? res : null, source: a.SOURCE ?? a.SRC_DESC ?? null, product: a.SOURCE_INFO ?? a.NICE_DESC ?? null, maxZoom: Number.isFinite(maxZoom) ? maxZoom : null };
  }).filter((r) => r.date);
  if (!rows.length) return null;
  rows.sort((a, b) => (a.resolutionM ?? 99) - (b.resolutionM ?? 99));
  return rows[0];
}

/** Newest NAIP acquisition at a point. */
export async function naipAt(serviceUrl, [lon, lat]) {
  const u = new URL(`${serviceUrl}/identify`);
  u.searchParams.set('geometry', JSON.stringify({ x: lon, y: lat, spatialReference: { wkid: 4326 } }));
  u.searchParams.set('geometryType', 'esriGeometryPoint');
  u.searchParams.set('returnCatalogItems', 'true');
  u.searchParams.set('returnGeometry', 'false');
  u.searchParams.set('f', 'json');
  const body = await getJson(u);
  const items = (body.catalogItems?.features || []).map((f) => f.attributes).filter((a) => a.acquisition_date);
  if (!items.length) return null;
  items.sort((a, b) => b.acquisition_date - a.acquisition_date);
  const a = items[0];
  return { date: parseDate(a.acquisition_date), resolutionM: a.resolution_value ?? null, source: a.agency ?? 'USDA', product: 'NAIP' };
}

/**
 * Every catalog source with a known or discoverable capture date at a point,
 * newest first. Lookups run in parallel; a failing source reports an error
 * instead of failing the whole request.
 */
export async function imageryDatesAt(point) {
  const tasks = IMAGERY_SOURCES.filter((s) => coversPoint(s, point) && (s.captured || s.metadata)).map(async (s) => {
    const base = { sourceId: s.id, name: s.name, resolution: s.resolution, provider: s.provider };
    try {
      if (s.captured) return { ...base, captured: s.captured, capturedLabel: s.capturedLabel || s.captured };
      const m = s.metadata.type === 'esri' ? await esriMetadataAt(s.metadata.url, point) : await naipAt(s.url, point);
      if (!m) return { ...base, captured: null, note: 'No coverage at this point' };
      return {
        ...base, captured: m.date, capturedLabel: m.date,
        resolution: m.resolutionM ? `${Math.round(m.resolutionM * 100)} cm` : s.resolution,
        ...(m.maxZoom ? { maxZoom: m.maxZoom } : {}),
        provider: [m.source, m.product].filter(Boolean).join(' · ') || s.provider,
      };
    } catch (e) {
      return { ...base, captured: null, error: e.message };
    }
  });
  const results = await Promise.all(tasks);
  results.push({ sourceId: 'mapbox', name: 'Mapbox Satellite (base map)', captured: null, note: 'Mapbox does not publish capture dates' });
  results.sort((a, b) => (b.captured || '').localeCompare(a.captured || ''));
  return { point, newest: results.find((r) => r.captured)?.sourceId ?? null, results };
}

/* ------------------------------------------------------------- WKT helpers */

const ringToWkt = (ring) => `(${ring.map(([x, y]) => `${+x.toFixed(7)} ${+y.toFixed(7)}`).join(', ')})`;

export function polygonToWkt(polygon) {
  const rings = polygon.coordinates.map((r) => {
    const o = openRing(r);
    return [...o, o[0]];
  });
  return `POLYGON (${rings.map(ringToWkt).join(', ')})`;
}

/** Parse POLYGON / MULTIPOLYGON WKT into GeoJSON. */
export function wktToGeoJSON(wkt) {
  if (!wkt) return null;
  const s = wkt.trim();
  const type = s.match(/^(MULTIPOLYGON|POLYGON)\s*(Z|M|ZM)?\s*\(/i)?.[1]?.toUpperCase();
  if (!type) return null;
  const nums = (txt) => txt.trim().split(/\s*,\s*/).map((p) => p.trim().split(/\s+/).slice(0, 2).map(Number));
  const body = s.slice(s.indexOf('('));
  if (type === 'POLYGON') {
    const rings = [...body.matchAll(/\(([^()]+)\)/g)].map((m) => nums(m[1]));
    return { type: 'Polygon', coordinates: rings };
  }
  const polys = [];
  for (const pm of body.slice(1, -1).matchAll(/\(\s*(\([^()]+\)(?:\s*,\s*\([^()]+\))*)\s*\)/g)) {
    polys.push([...pm[1].matchAll(/\(([^()]+)\)/g)].map((m) => nums(m[1])));
  }
  return { type: 'MultiPolygon', coordinates: polys };
}

/* ------------------------------------------------------------- SkyFi */

const skyfiDate = (d) => {
  const iso = new Date(d).toISOString();
  return `${iso.slice(0, 19)}+00:00`;
};

/**
 * Search the SkyFi archive catalog for imagery intersecting `aoi` (GeoJSON Polygon).
 * Returns normalized scenes, newest first, with an estimated price for the AOI.
 */
export async function skyfiSearch(cfg, aoi, opts = {}) {
  if (!cfg.apiKey) throw Object.assign(new Error('SkyFi is not configured. Add SKYFI_API_KEY to .env and restart.'), { status: 503, code: 'skyfi_not_configured' });
  const now = Date.now();
  const body = {
    aoi: polygonToWkt(aoi),
    fromDate: skyfiDate(opts.fromDate || now - 730 * 86400000),
    toDate: skyfiDate(opts.toDate || now),
    pageSize: Math.min(100, Math.max(1, opts.limit || 50)),
  };
  if (opts.maxCloudCoveragePercent != null) body.maxCloudCoveragePercent = Number(opts.maxCloudCoveragePercent);
  if (opts.maxOffNadirAngle != null) body.maxOffNadirAngle = Number(opts.maxOffNadirAngle);
  if (opts.resolutions?.length) body.resolutions = opts.resolutions;
  if (opts.providers?.length) body.providers = opts.providers;
  body.productTypes = opts.productTypes?.length ? opts.productTypes : ['DAY'];
  if (opts.openData != null) body.openData = Boolean(opts.openData);

  let res;
  try {
    res = await getJson(`${cfg.baseUrl}/archives`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Skyfi-Api-Key': cfg.apiKey },
      body: JSON.stringify(body),
    });
  } catch (e) {
    if (e.upstreamStatus === 401 || e.upstreamStatus === 403) throw Object.assign(new Error('SkyFi rejected the API key'), { status: 502, code: 'skyfi_unauthorized' });
    if (e.upstreamStatus === 422) throw Object.assign(new Error(`SkyFi rejected the search: ${e.body.slice(0, 300)}`), { status: 400, code: 'skyfi_invalid' });
    throw e;
  }
  const aoiKm2 = ringArea(aoi.coordinates[0]) / 1e6;
  const items = (res.archives || []).map((a) => {
    const billableKm2 = a.fullSceneOnly ? a.totalAreaSquareKm : Math.max(a.minSqKm || 0, aoiKm2);
    return {
      archiveId: a.archiveId,
      provider: a.provider,
      constellation: a.constellation,
      productType: a.productType,
      captured: a.captureTimestamp,
      resolution: a.resolution,
      resolutionCm: a.platformResolution ?? null,
      gsd: a.gsd ?? null,
      cloudCoveragePercent: a.cloudCoveragePercent ?? null,
      offNadirAngle: a.offNadirAngle ?? null,
      footprint: wktToGeoJSON(a.footprint),
      openData: Boolean(a.openData),
      fullSceneOnly: Boolean(a.fullSceneOnly),
      minSqKm: a.minSqKm,
      pricePerSqKmUsd: a.priceForOneSquareKm,
      priceFullSceneUsd: a.priceFullScene,
      estimatedPriceUsd: a.openData ? 0 : Math.round((a.fullSceneOnly ? a.priceFullScene : a.priceForOneSquareKm * billableKm2) * 100) / 100,
      billableSqKm: Math.round(billableKm2 * 100) / 100,
      deliveryTimeHours: a.deliveryTimeHours ?? null,
      thumbnailUrls: a.thumbnailUrls || {},
      tilesUrl: a.tilesUrl || null,
    };
  });
  items.sort((a, b) => b.captured.localeCompare(a.captured));
  return { aoiSqKm: Math.round(aoiKm2 * 1000) / 1000, count: items.length, nextPage: res.nextPage || null, items };
}

/* ------------------------------------------------------------- NASA GIBS */

/**
 * GIBS daily layers only have imagery on dates when a satellite passed over
 * (and products lag ~5 days). Probe one low-zoom tile per day at the point and
 * return the dates that actually contain imagery, newest first.
 */
export async function gibsDatesAt(src, [lon, lat], days = 45) {
  const z = Math.min(src.maxzoom ?? 9, 10);
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const r = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n);
  const today = Date.now();
  const dates = Array.from({ length: days }, (_, i) => new Date(today - i * 86400000).toISOString().slice(0, 10));
  const jpeg = /\.jpe?g$/i.test(src.url);
  const results = [];
  let next = 0;
  const worker = async () => {
    while (next < dates.length) {
      const date = dates[next++];
      const url = src.url.replace('{date}', date).replace('{z}', z).replace('{x}', x).replace('{y}', y);
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT) });
        if (!res.ok) continue;
        const bytes = (await res.arrayBuffer()).byteLength;
        // PNG (HLS): empty/no-pass tiles are <2 KB, full scenes ~100–190 KB.
        // JPEG (VIIRS, daily global): any real tile is a few KB.
        if (jpeg ? bytes > 2000 : bytes > 20000) results.push({ date, coverage: jpeg || bytes > 90000 ? 'full' : 'partial', bytes });
      } catch { /* skip */ }
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  results.sort((a, b) => b.date.localeCompare(a.date));
  return results;
}
