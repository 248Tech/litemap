import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { Store, newId } from './store.js';
import { ObjectLibrary, MAX_IMAGE_BYTES } from './objects.js';
import { buildOpenApi, API_VERSION } from './openapi.js';
import * as mapbox from './mapbox.js';
import { imageryDatesAt, skyfiSearch, gibsDatesAt } from './imagery.js';
import { IMAGERY_SOURCES, IMAGERY_BY_ID } from '../public/js/imagery.js';
import {
  HttpError, normalizeFeature, normalizeFeatureList, normalizeSiteFields, presentSite, validateGeometry, lonLat,
} from './features.js';
import { measureGeometry, fitFootprint, largestFit, packFootprints, footprintRing } from '../public/js/geo.js';
import { REFERENCE_OBJECTS, REFERENCE_BY_ID } from '../public/js/references.js';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
};
const MAX_BODY = 5 * 1024 * 1024;

const sendJson = (res, status, body, headers = {}) => {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data), ...headers });
  res.end(data);
};

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw new HttpError(413, 'payload_too_large', 'Request body exceeds 5 MB');
    chunks.push(c);
  }
  if (!size) throw new HttpError(400, 'invalid_request', 'Request body is required');
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {
    throw new HttpError(400, 'invalid_json', 'Request body is not valid JSON');
  }
}

async function readRaw(req, max) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > max) throw new HttpError(413, 'payload_too_large', `Image exceeds ${Math.round(max / 1048576)} MB`);
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();

export async function createApp(cfg) {
  const store = await new Store(path.join(cfg.dataDir, 'sites.json')).load();
  const objects = await new ObjectLibrary(cfg.dataDir).load();
  const keyHashes = cfg.apiKeys.map(sha);

  const baseUrl = (req) => {
    if (cfg.publicUrl) return cfg.publicUrl.replace(/\/$/, '');
    const proto = (req.headers['x-forwarded-proto'] || '').split(',')[0] || (req.socket.encrypted ? 'https' : 'http');
    return `${proto}://${req.headers['x-forwarded-host'] || req.headers.host}`;
  };
  const withLinks = (req, site) => ({
    ...site,
    url: `${baseUrl(req)}/?site=${site.id}`,
    embedUrl: `${baseUrl(req)}/?embed=1&site=${site.id}`,
  });

  const authorized = (req) => {
    if (!keyHashes.length) return true;
    const auth = req.headers.authorization || '';
    const key = req.headers['x-api-key'] || (auth.startsWith('Bearer ') ? auth.slice(7) : null);
    if (!key) return false;
    const h = sha(key);
    return keyHashes.some((k) => crypto.timingSafeEqual(k, h));
  };

  const getSite = (id) => {
    const s = store.get(id);
    if (!s) throw new HttpError(404, 'not_found', `Site ${id} not found`);
    return s;
  };
  const getFeature = (site, fid) => {
    const i = site.features.findIndex((f) => f.id === fid);
    if (i < 0) throw new HttpError(404, 'not_found', `Feature ${fid} not found in site ${site.id}`);
    return i;
  };
  const touch = (site) => { site.updatedAt = new Date().toISOString(); return site; };

  function resolveArea(body) {
    if (body.polygon) {
      const g = body.polygon.type === 'Feature' ? body.polygon.geometry : body.polygon;
      return validateGeometry(g, 'Polygon');
    }
    if (body.siteId && body.featureId) {
      const site = getSite(body.siteId);
      const f = site.features[getFeature(site, body.featureId)];
      if (f.geometry.type !== 'Polygon') throw new HttpError(400, 'invalid_request', 'featureId must reference an area (Polygon) feature');
      return f.geometry;
    }
    throw new HttpError(400, 'invalid_request', 'Provide `polygon`, or `siteId` and `featureId`');
  }

  function resolveDims(body) {
    const tpl = body.templateId ? REFERENCE_BY_ID[body.templateId] : null;
    if (body.templateId && !tpl) throw new HttpError(400, 'invalid_request', `unknown templateId: ${body.templateId}`);
    const shape = body.shape ?? tpl?.shape ?? 'rect';
    if (!['rect', 'circle'].includes(shape)) throw new HttpError(400, 'invalid_request', 'shape must be rect or circle');
    const width = Number(body.width ?? tpl?.width);
    const length = shape === 'circle' ? width : Number(body.length ?? tpl?.length ?? width);
    const clearance = Number(body.clearance ?? 0);
    if (!(width > 0) || !(length > 0) || !(clearance >= 0)) throw new HttpError(400, 'invalid_request', 'width/length must be > 0 and clearance >= 0 (or give a templateId)');
    return { shape, width, length, clearance };
  }

  /* ---------------------------------------------------------------- routes */
  const routes = [];
  const route = (method, pattern, handler, opts = {}) => {
    const keys = [];
    const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; })}/?$`);
    routes.push({ method, re, keys, handler, public: !!opts.public });
  };

  route('GET', '/api/v1/health', () => ({
    status: 'ok', version: API_VERSION,
    mapbox: Boolean(cfg.mapbox.token),
    skyfi: Boolean(cfg.skyfi.apiKey),
    authRequired: keyHashes.length > 0,
  }), { public: true });

  route('GET', '/api/v1/map/config', (_req, res) => {
    if (!cfg.mapbox.token) throw new HttpError(503, 'mapbox_not_configured', 'Mapbox is not configured. Set MAPBOX_TOKEN in .env and restart.');
    res.setHeader('Cache-Control', 'no-store');
    return { provider: 'mapbox', accessToken: cfg.mapbox.token, styles: mapbox.STYLES, skyfi: Boolean(cfg.skyfi.apiKey) };
  }, { public: true });

  route('GET', '/api/v1/reference-objects', () => ({ items: REFERENCE_OBJECTS }), { public: true });

  route('GET', '/api/v1/geocode', async (req, _res, { query }) => {
    const q = query.get('q');
    if (!q) throw new HttpError(400, 'invalid_request', 'q is required');
    return {
      results: await mapbox.geocode(cfg.mapbox, q, {
        language: query.get('language') || 'en', country: query.get('country'), proximity: query.get('proximity'),
        limit: Math.min(10, Math.max(1, Number(query.get('limit')) || 5)),
      }),
    };
  });

  route('GET', '/api/v1/imagery/sources', () => ({ items: IMAGERY_SOURCES, skyfi: Boolean(cfg.skyfi.apiKey) }), { public: true });

  route('GET', '/api/v1/imagery/dates', async (_req, _res, { query }) => {
    let point;
    if (query.get('siteId')) {
      const site = getSite(query.get('siteId'));
      const c = site.view?.center || site.features[0]?.properties.reference?.center || site.features[0]?.geometry.coordinates.flat(2).slice(0, 2);
      if (!c) throw new HttpError(400, 'invalid_request', 'Site has no view or features to locate it');
      point = lonLat(c);
    } else point = lonLat([query.get('lon'), query.get('lat')], 'lon/lat');
    return imageryDatesAt(point);
  });

  route('GET', '/api/v1/imagery/available-dates', async (_req, _res, { query }) => {
    const src = IMAGERY_BY_ID[query.get('source')];
    if (!src?.dated) throw new HttpError(400, 'invalid_request', 'source must be a daily (dated) layer, e.g. gibs-hls-s30');
    const point = lonLat([query.get('lon'), query.get('lat')], 'lon/lat');
    const days = Math.min(120, Math.max(7, Number(query.get('days')) || 45));
    return { source: src.id, point, dates: await gibsDatesAt(src, point, days) };
  });

  route('POST', '/api/v1/imagery/skyfi/archives', async (req) => {
    const body = await readJson(req);
    let aoi;
    if (Array.isArray(body.bbox)) {
      const [w, s, e, n] = body.bbox.map(Number);
      if (![w, s, e, n].every(Number.isFinite) || w >= e || s >= n) throw new HttpError(400, 'invalid_request', 'bbox must be [west, south, east, north]');
      aoi = { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] };
    } else aoi = resolveArea(body);
    return skyfiSearch(cfg.skyfi, aoi, body);
  });

  route('POST', '/api/v1/measure', async (req) => {
    const body = await readJson(req);
    let items;
    if (body.type === 'FeatureCollection') {
      if (!Array.isArray(body.features)) throw new HttpError(400, 'invalid_request', 'features must be an array');
      items = body.features.map((f, i) => {
        if (f?.properties?.reference || f?.properties?.kind === 'reference') {
          const n = normalizeFeature(f, i);
          return { id: n.id, geometry: n.geometry };
        }
        return { id: f?.id ?? null, geometry: validateGeometry(f?.geometry) };
      });
    } else if (body.type === 'Feature') {
      const n = body.properties?.reference ? normalizeFeature(body) : { id: body.id ?? null, geometry: validateGeometry(body.geometry) };
      items = [{ id: n.id, geometry: n.geometry }];
    } else items = [{ id: null, geometry: validateGeometry(body) }];
    const out = items.map(({ id, geometry }) => ({ id, geometryType: geometry.type, metrics: measureGeometry(geometry) }));
    const sum = (k) => Math.round(out.reduce((s, i) => s + (i.metrics[k] || 0), 0) * 1000) / 1000;
    return { items: out, totals: { lengthM: sum('lengthM'), areaM2: sum('areaM2'), perimeterM: sum('perimeterM') } };
  });

  route('POST', '/api/v1/footprint', async (req) => {
    const body = await readJson(req);
    return normalizeFeature({
      type: 'Feature',
      properties: {
        kind: 'reference', name: body.name,
        reference: { templateId: body.templateId, shape: body.shape, width: body.width, length: body.length, rotation: body.rotation, clearance: body.clearance, center: body.center },
      },
    });
  });

  route('POST', '/api/v1/fit', async (req) => {
    const body = await readJson(req);
    const area = resolveArea(body);
    const dims = resolveDims(body);
    const opts = { ...dims, allowRotation: body.allowRotation !== false, rotation: body.rotation != null ? Number(body.rotation) : undefined };
    const result = fitFootprint(area, opts);
    if (body.findLargest) result.largest = largestFit(area, opts);
    return result;
  });

  route('POST', '/api/v1/pack', async (req) => {
    const body = await readJson(req);
    const area = resolveArea(body);
    const dims = resolveDims(body);
    let r;
    try {
      r = packFootprints(area, { ...dims, rotation: body.rotation != null ? Number(body.rotation) : undefined });
    } catch (e) {
      if (e.code === 'too_many_cells') throw new HttpError(400, 'too_many_cells', e.message);
      throw e;
    }
    if (body.includeFootprints) {
      r.footprints = r.centers.slice(0, 5000).map((center) => ({
        type: 'Polygon', coordinates: [footprintRing({ center, shape: dims.shape, width: dims.width, length: dims.length, rotation: r.rotation })],
      }));
    }
    return r;
  });

  /* ---- uploaded objects (cut-out images with a real-world size) */
  const presentObject = (req, o) => ({ ...o, imageUrl: `${baseUrl(req)}/api/v1/objects/${o.id}/image` });

  route('GET', '/api/v1/objects', (req) => ({ items: objects.list().map((o) => presentObject(req, o)) }));

  route('POST', '/api/v1/objects', async (req, res, { query }) => {
    const ct = (req.headers['content-type'] || '').split(';')[0].trim();
    if (!/^image\/(png|webp|jpeg)$/.test(ct)) throw new HttpError(415, 'unsupported_media_type', 'Send the image bytes with Content-Type image/png, image/webp or image/jpeg');
    const buf = await readRaw(req, MAX_IMAGE_BYTES);
    const o = await objects.create(buf, { name: query.get('name'), width: query.get('width'), length: query.get('length') });
    res.statusCode = 201;
    return presentObject(req, o);
  });

  route('GET', '/api/v1/objects/:oid', (req, _res, { params }) => presentObject(req, objects.get(params.oid)));

  route('PATCH', '/api/v1/objects/:oid', async (req, _res, { params }) => presentObject(req, await objects.update(params.oid, await readJson(req))));

  route('DELETE', '/api/v1/objects/:oid', async (_req, res, { params }) => {
    await objects.remove(params.oid);
    res.writeHead(204).end();
  });

  // Public so map layers and <img> tags can load it; ids are unguessable and images are immutable.
  route('GET', '/api/v1/objects/:oid/image', async (req, res, { params }) => {
    const { object: o, data } = await objects.read(params.oid);
    res.writeHead(200, {
      'Content-Type': o.contentType, 'Content-Length': data.length,
      'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  }, { public: true });

  route('GET', '/api/v1/sites', (req, _res, { query }) => {
    const q = (query.get('q') || '').toLowerCase();
    const tag = query.get('tag');
    const limit = Math.min(500, Math.max(1, Number(query.get('limit')) || 50));
    const offset = Math.max(0, Number(query.get('offset')) || 0);
    let items = store.list();
    if (q) items = items.filter((s) => `${s.name}\n${s.description}\n${s.tags.join(' ')}`.toLowerCase().includes(q));
    if (tag) items = items.filter((s) => s.tags.includes(tag));
    items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return { total: items.length, items: items.slice(offset, offset + limit).map((s) => withLinks(req, presentSite(s, { withFeatures: false }))) };
  });

  route('POST', '/api/v1/sites', async (req, res) => {
    const body = await readJson(req);
    const fields = normalizeSiteFields(body);
    if (body.address != null && !fields.view) {
      if (typeof body.address !== 'string' || !body.address.trim()) throw new HttpError(400, 'invalid_request', 'address must be a non-empty string');
      const [hit] = await mapbox.geocode(cfg.mapbox, body.address, { limit: 1 });
      if (!hit) throw new HttpError(400, 'address_not_found', `Could not geocode: ${body.address}`);
      fields.view = { center: hit.coordinate, zoom: 18 };
      if (!body.description) fields.description = hit.formattedAddress;
    }
    const now = new Date().toISOString();
    const site = { id: newId(), ...fields, createdAt: now, updatedAt: now };
    await store.put(site);
    res.statusCode = 201;
    return withLinks(req, presentSite(site));
  });

  route('GET', '/api/v1/sites/:id', (req, _res, { params }) => withLinks(req, presentSite(getSite(params.id))));

  route('PUT', '/api/v1/sites/:id', async (req, _res, { params }) => {
    const existing = getSite(params.id);
    const body = await readJson(req);
    const fields = normalizeSiteFields(body, { name: existing.name });
    const site = touch({ ...fields, id: existing.id, createdAt: existing.createdAt });
    await store.put(site);
    return withLinks(req, presentSite(site));
  });

  route('PATCH', '/api/v1/sites/:id', async (req, _res, { params }) => {
    const existing = getSite(params.id);
    const body = await readJson(req);
    const site = touch(normalizeSiteFields(body, existing));
    await store.put(site);
    return withLinks(req, presentSite(site));
  });

  route('DELETE', '/api/v1/sites/:id', async (_req, res, { params }) => {
    getSite(params.id);
    await store.delete(params.id);
    res.writeHead(204).end();
  });

  route('GET', '/api/v1/sites/:id/features', (_req, _res, { params }) => ({ type: 'FeatureCollection', features: getSite(params.id).features }));

  route('POST', '/api/v1/sites/:id/features', async (req, res, { params }) => {
    const site = getSite(params.id);
    const body = await readJson(req);
    const f = normalizeFeature(body, site.features.length);
    if (site.features.some((x) => x.id === f.id)) f.id = newId(6);
    site.features.push(f);
    await store.put(touch(site));
    res.statusCode = 201;
    return f;
  });

  route('GET', '/api/v1/sites/:id/features/:fid', (_req, _res, { params }) => {
    const site = getSite(params.id);
    return site.features[getFeature(site, params.fid)];
  });

  route('PUT', '/api/v1/sites/:id/features/:fid', async (req, _res, { params }) => {
    const site = getSite(params.id);
    const i = getFeature(site, params.fid);
    const body = await readJson(req);
    const f = normalizeFeature({ ...body, id: params.fid }, i);
    site.features[i] = f;
    await store.put(touch(site));
    return f;
  });

  route('DELETE', '/api/v1/sites/:id/features/:fid', async (_req, res, { params }) => {
    const site = getSite(params.id);
    site.features.splice(getFeature(site, params.fid), 1);
    await store.put(touch(site));
    res.writeHead(204).end();
  });

  route('GET', '/api/v1/sites/:id/geojson', (_req, res, { params }) => {
    const site = getSite(params.id);
    const fc = {
      type: 'FeatureCollection',
      properties: { siteId: site.id, name: site.name, description: site.description, exportedAt: new Date().toISOString() },
      features: site.features,
    };
    const safe = site.name.replace(/[^\w.-]+/g, '_').slice(0, 80) || 'site';
    const data = JSON.stringify(fc, null, 2);
    res.writeHead(200, { 'Content-Type': 'application/geo+json', 'Content-Disposition': `attachment; filename="${safe}.geojson"` });
    res.end(data);
  });

  route('GET', '/api/v1/sites/:id/snapshot', (req, res, { params, query }) => {
    const site = getSite(params.id);
    if (!site.features.length && !site.view) throw new HttpError(400, 'invalid_request', 'Site has no features or view to snapshot');
    const size = /^\d{2,4}x\d{2,4}$/.test(query.get('size') || '') ? query.get('size') : '600x400';
    const mapType = mapbox.STYLES[query.get('mapType')] ? query.get('mapType') : 'satellite';
    const url = mapbox.staticImageUrl(cfg.mapbox, {
      features: site.features, center: site.view?.center, zoom: site.view?.zoom ?? 17, size, retina: query.get('retina') !== 'false', mapType,
    });
    if (query.get('format') === 'redirect') { res.writeHead(302, { Location: url }).end(); return; }
    return { url };
  });

  /* --------------------------------------------------------------- serving */
  const corsFor = (req) => {
    const origin = req.headers.origin;
    if (cfg.corsOrigins.includes('*')) return '*';
    return origin && cfg.corsOrigins.includes(origin) ? origin : null;
  };

  async function serveStatic(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method_not_allowed', 'Method not allowed');
    if (pathname === '/' ) pathname = '/index.html';
    if (pathname === '/docs' || pathname === '/docs/') pathname = '/docs.html';
    const file = path.normalize(path.join(cfg.publicDir, decodeURIComponent(pathname)));
    if (!file.startsWith(cfg.publicDir + path.sep)) throw new HttpError(404, 'not_found', 'Not found');
    let data;
    try { data = await fs.readFile(file); } catch { throw new HttpError(404, 'not_found', 'Not found'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      // Cross-origin isolation lets in-browser AI use several CPU threads (SharedArrayBuffer).
      // `credentialless` keeps cross-origin scripts, tiles and fonts working without CORP headers.
      'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'credentialless',
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;

    if (pathname.startsWith('/api/') || pathname === '/openapi.json') {
      const allow = corsFor(req);
      if (allow) {
        res.setHeader('Access-Control-Allow-Origin', allow);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
        res.setHeader('Access-Control-Max-Age', '600');
      }
      if (req.method === 'OPTIONS') return res.writeHead(204).end();
    }

    if (pathname === '/openapi.json') return sendJson(res, 200, buildOpenApi(baseUrl(req)));
    if (!pathname.startsWith('/api/')) return serveStatic(req, res, pathname);

    let matchedPath = false;
    for (const r of routes) {
      const m = r.re.exec(pathname);
      if (!m) continue;
      matchedPath = true;
      if (r.method !== req.method) continue;
      if (!r.public && !authorized(req)) throw new HttpError(401, 'unauthorized', 'Missing or invalid API key (X-API-Key header or Bearer token)');
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      const result = await r.handler(req, res, { params, query: url.searchParams });
      if (!res.writableEnded && result !== undefined) sendJson(res, res.statusCode || 200, result);
      return;
    }
    if (matchedPath) throw new HttpError(405, 'method_not_allowed', `${req.method} not allowed on ${pathname}`);
    throw new HttpError(404, 'not_found', `No route for ${pathname}`);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      const status = err instanceof HttpError ? err.status : err.status || 500;
      if (status >= 500 && !(err instanceof HttpError)) console.error(err);
      if (res.headersSent) return res.end();
      sendJson(res, status, { error: { code: err.code && typeof err.code === 'string' ? err.code : 'internal_error', message: status === 500 ? 'Internal server error' : err.message, ...(err.details ? { details: err.details } : {}) } });
    });
  });

  return { server, store, objects };
}
