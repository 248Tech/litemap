/*
 * In-browser stand-in for the LiteMap REST API, used only by the static website
 * demo (scripts/build-pages.mjs). It answers the same /api/v1 calls the app and
 * the 3D Modeler make, using the server's own validation (server/features.js,
 * copied into the build), and keeps sites and models in this browser's
 * localStorage. Uploads, imagery lookups and snapshots need a real server and
 * answer 501 with a short explanation.
 *
 * Loaded as the first module on the demo pages, before app.js / modeler.js.
 */
import { HttpError, normalizeSiteFields, presentSite, validateTent } from './server-features.js';
import { REFERENCE_OBJECTS } from './references.js';
import { makeModelDoc, parseModelDoc } from './modelfile.js';

const CFG = globalThis.LITEMAP_DEMO || {};
const KEY = { sites: 'litemap-demo:sites', models: 'litemap-demo:models', seeded: 'litemap-demo:seeded' };
const load = (k) => { try { return JSON.parse(localStorage.getItem(k)) || []; } catch { return []; } };
const store = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { throw new HttpError(507, 'storage_full', 'This browser has no room left to save the demo site.'); } };
const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(9)), (b) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'[b & 63]).join('');
const now = () => new Date().toISOString();
const needsServer = (what) => { throw new HttpError(501, 'needs_server', `${what} needs your own LiteMap server. This online demo keeps everything in your browser.`); };

/* -------------------------------------------------------------- addresses */
/** Middle of the site's features, else the view centre (as the server does). */
function siteLocation(site) {
  const pts = [];
  const walk = (c) => (typeof c[0] === 'number' ? pts.push(c) : c.forEach(walk));
  for (const f of site.features || []) if (f.geometry?.coordinates) walk(f.geometry.coordinates);
  if (pts.length) {
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
  }
  return site.view?.center || null;
}
async function ensureAddress(site) {
  if (!site.addressAuto && site.address) return;
  const at = siteLocation(site);
  if (!at || !CFG.mapboxToken) return;
  const prev = site.addressPoint;
  if (site.address && prev && Math.hypot((at[0] - prev[0]) * 82000, (at[1] - prev[1]) * 111320) < 150) return;
  try {
    const u = new URL('https://api.mapbox.com/search/geocode/v6/reverse');
    u.searchParams.set('longitude', at[0]); u.searchParams.set('latitude', at[1]);
    u.searchParams.set('types', 'address,street,place'); u.searchParams.set('limit', '1'); u.searchParams.set('access_token', CFG.mapboxToken);
    const r = await (await fetch(u)).json();
    const p = r.features?.[0]?.properties;
    if (p) { site.address = p.full_address || p.place_formatted || p.name || ''; site.addressAuto = true; site.addressPoint = at; }
  } catch { /* the site still saves */ }
}

/* -------------------------------------------------------------- sites */
const sites = () => load(KEY.sites);
const getSite = (id) => sites().find((s) => s.id === id) || (() => { throw new HttpError(404, 'not_found', 'Site not found in this browser.'); })();
async function putSite(site) {
  await ensureAddress(site);
  store(KEY.sites, [site, ...sites().filter((s) => s.id !== site.id)]);
  return presentSite(site);
}

/* -------------------------------------------------------------- models */
const models = () => load(KEY.models);
function readModel(body) {
  if (!body || typeof body !== 'object') throw new HttpError(400, 'invalid_request', 'body must be a JSON object');
  try {
    if (body.tent != null) validateTent(body.tent);
    return body.format ? parseModelDoc(body) : makeModelDoc(body);
  } catch (e) { throw new HttpError(400, 'invalid_request', e.message.replace(/reference.tent/g, 'tent')); }
}
const presentModel = (m) => ({ ...m, links: {} });

/* -------------------------------------------------------------- router */
const ROUTES = [
  ['GET', /^\/map\/config$/, () => {
    if (!CFG.mapboxToken) throw new HttpError(503, 'mapbox_not_configured', 'This demo build has no map token.');
    return { provider: 'mapbox', accessToken: CFG.mapboxToken, styles: CFG.styles || {}, skyfi: false };
  }],
  ['GET', /^\/reference-objects$/, () => ({ items: REFERENCE_OBJECTS })],
  ['GET', /^\/health$/, () => ({ ok: true, demo: true })],
  ['GET', /^\/sites$/, (q) => {
    const term = (q.get('q') || '').toLowerCase();
    let items = sites();
    if (term) items = items.filter((s) => `${s.name}\n${s.address || ''}\n${s.description}\n${(s.tags || []).join(' ')}`.toLowerCase().includes(term));
    items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return { total: items.length, items: items.slice(0, Number(q.get('limit')) || 50).map((s) => presentSite(s, { withFeatures: false })) };
  }],
  ['POST', /^\/sites$/, async (_q, body) => {
    const fields = normalizeSiteFields(body);
    const t = now();
    return [201, await putSite({ id: newId(), ...fields, createdAt: t, updatedAt: t })];
  }],
  ['GET', /^\/sites\/([\w-]+)$/, (_q, _b, [id]) => presentSite(getSite(id))],
  ['PUT', /^\/sites\/([\w-]+)$/, async (_q, body, [id]) => {
    const old = getSite(id);
    const { name, address, addressAuto, addressPoint } = old;
    return putSite({ ...normalizeSiteFields(body, { name, address, addressAuto, addressPoint }), id, createdAt: old.createdAt, updatedAt: now() });
  }],
  ['PATCH', /^\/sites\/([\w-]+)$/, async (_q, body, [id]) => putSite({ ...normalizeSiteFields(body, getSite(id)), updatedAt: now() })],
  ['DELETE', /^\/sites\/([\w-]+)$/, (_q, _b, [id]) => { getSite(id); store(KEY.sites, sites().filter((s) => s.id !== id)); return [204, null]; }],
  ['GET', /^\/sites\/[\w-]+\/snapshot$/, () => needsServer('Saving a snapshot image')],
  ['GET', /^\/objects$/, () => ({ items: [] })],
  ['POST', /^\/objects/, () => needsServer('Uploading your own objects')],
  ['GET', /^\/models$/, () => ({ items: models().map(presentModel) })],
  ['POST', /^\/models$/, (_q, body) => {
    const t = now(), m = { id: newId(), ...readModel(body), createdAt: t, updatedAt: t };
    store(KEY.models, [m, ...models()]);
    return [201, presentModel(m)];
  }],
  ['GET', /^\/models\/([\w-]+)$/, (_q, _b, [id]) => presentModel(models().find((m) => m.id === id) || (() => { throw new HttpError(404, 'not_found', 'Model not found in this browser.'); })())],
  ['PATCH', /^\/models\/([\w-]+)$/, (_q, body, [id]) => {
    const old = models().find((m) => m.id === id);
    if (!old) throw new HttpError(404, 'not_found', 'Model not found in this browser.');
    const m = { ...old, ...readModel({ ...old, ...body, format: undefined }), id, createdAt: old.createdAt, updatedAt: now() };
    store(KEY.models, [m, ...models().filter((x) => x.id !== id)]);
    return presentModel(m);
  }],
  ['DELETE', /^\/models\/([\w-]+)$/, (_q, _b, [id]) => { store(KEY.models, models().filter((m) => m.id !== id)); return [204, null]; }],
  ['GET', /^\/imagery\//, () => needsServer('Finding imagery capture dates')],
  ['POST', /^\/imagery\//, () => needsServer('Searching the SkyFi archive')],
  ['GET', /^\/geocode/, () => needsServer('Server-side geocoding')],
];

async function handle(method, url, bodyText) {
  const path = url.pathname.replace(/^.*\/api\/v1/, '');
  for (const [m, rx, fn] of ROUTES) {
    const hit = m === method && path.match(rx);
    if (!hit) continue;
    const body = bodyText ? JSON.parse(bodyText) : undefined;
    let out = await fn(url.searchParams, body, hit.slice(1));
    let status = 200;
    if (Array.isArray(out)) [status, out] = out;
    return new Response(status === 204 ? null : JSON.stringify(out), { status, headers: { 'Content-Type': 'application/json' } });
  }
  throw new HttpError(404, 'not_found', `${method} ${path} is not available in the online demo.`);
}

/* Answer /api/v1 requests in the page; everything else goes to the network. */
const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url, location.href);
  if (url.origin !== location.origin || !url.pathname.includes('/api/v1')) return realFetch(input, init);
  const method = (init.method || (typeof input === 'string' ? 'GET' : input.method) || 'GET').toUpperCase();
  try {
    return await handle(method, url, typeof init.body === 'string' ? init.body : null);
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 400;
    return new Response(JSON.stringify({ error: { code: e.code || 'invalid_request', message: e.message } }), { status, headers: { 'Content-Type': 'application/json' } });
  }
};

/* -------------------------------------------------------------- sample site */
// A first visit opens a sample layout (a public park) so there is something to explore.
const FT = 0.3048;
async function seed() {
  if (localStorage.getItem(KEY.seeded)) return null;
  localStorage.setItem(KEY.seeded, '1');
  const C = [-83.2163, 42.5452];
  const at = (dx, dy) => [C[0] + dx / 82000, C[1] + dy / 111320];
  const tent = (name, templateId, c, rotation, extra = {}, color) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: c }, properties: { name, ...(color ? { color } : {}), reference: { templateId, rotation, ...extra } } });
  const fields = normalizeSiteFields({
    name: 'Sample: event layout', description: 'A sample layout on a public park. Edit it, measure, or start your own site.',
    view: { center: C, zoom: 19.2 },
    features: [
      tent('Reception', 'tent-40x60', at(-8, -2), 20, { tent: { walls: { left: 'window', right: 'window', back: 'solid' } } }),
      tent('Bar', 'tent-20x40', at(18, 10), 20, { tent: { walls: { front: 'clear' } } }),
      tent('Check-in', 'tent-20x20', at(20, -14), 20, {}, '#3b6ea5'),
      { type: 'Feature', geometry: { type: 'LineString', coordinates: [at(-30, -16), at(-12, -24)] }, properties: { name: 'Walkway' } },
    ],
  });
  const t = now();
  const site = { id: 'sample', ...fields, createdAt: t, updatedAt: t };
  await putSite(site);
  return site.id;
}
const params = new URLSearchParams(location.search);
if (!params.has('site') && !params.has('model') && !params.has('embed') && location.pathname.match(/\/(index\.html)?$/)) {
  let hasDraft = false;
  try { hasDraft = Boolean(JSON.parse(localStorage.getItem('litemap:draft'))?.features?.length); } catch { /* none */ }
  const id = await seed().catch(() => null);
  if (id && !hasDraft) { params.set('site', id); history.replaceState(null, '', `${location.pathname}?${params}`); }
}
export { FT };
