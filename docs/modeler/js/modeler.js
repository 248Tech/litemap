/*
 * 3D Modeler page. Edit a tent in 3D, then send it down the export pipeline:
 *   save to the LiteMap library -> place on the map (a 3D-capable tent reference)
 *   or download a .glb / the editable model file for other tools.
 * The model is a recipe (modelfile.js); the map and the .glb are both built from it.
 */
import { REFERENCE_OBJECTS } from './references.js';
import { FT, ROOFS, SIDES, resolveTent, cleanTent, quantities } from './tentspec.js';
import { TentPreview } from './tent3d.js';
import { makeModelDoc, parseModelDoc, buildGlb, readGlb, fileStem, DEFAULT_FABRIC } from './modelfile.js';

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const ls = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

const ROOF_LABEL = { auto: 'Auto', pyramid: 'Pyramid', hip: 'Hip', gable: 'Gable' };
const WALL_LABEL = { none: 'Open', solid: 'Solid', window: 'Windows', clear: 'Clear' };
const SIDE_LABEL = { front: 'Front', back: 'Back', left: 'Left', right: 'Right' };
const FABRIC = [['#f6f6f3', 'White'], ['#efe6cf', 'Ivory'], ['#d6c3a0', 'Tan'], ['#3b6ea5', 'Blue'], ['#b23a3a', 'Red'], ['#3f7a4a', 'Green'], ['#2c2c2e', 'Black']];
const STOCK = REFERENCE_OBJECTS.filter((r) => r.id.startsWith('tent-') && r.id !== 'tent-custom');

/** Static demo (GitHub Pages build, `<html data-demo>`): no server, so no saving or placing; files still work. */
const DEMO = document.documentElement.hasAttribute('data-demo');
const REPO = 'https://github.com/248Tech/litemap';

let units = new URLSearchParams(location.search).get('units') || ls.get('litemap:units', 'imperial');
let apiKey = ls.get('litemap:apiKey');
let library = [];
let saved = null; // the library entry this model was last saved as (or loaded from)
let dirty = false;

const s = { name: '', w: 40 * FT, l: 60 * FT, t: { roof: 'auto', walls: {} }, color: DEFAULT_FABRIC, ballast: true };

/* ------------------------------------------------------------------ helpers */
let toastTimer;
function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg; t.classList.toggle('err', err); t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), err ? 5000 : 2600);
}

async function api(method, path, body) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (apiKey) headers['X-API-Key'] = apiKey;
  const res = await fetch(`/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (res.status === 401) {
    const key = prompt('This LiteMap server requires an API key:');
    if (key) { apiKey = key.trim(); ls.set('litemap:apiKey', apiKey); return api(method, path, body); }
    throw new Error('API key required');
  }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error?.message || `${res.status} ${res.statusText}`);
  return data;
}

function download(name, data, type) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

const metric = () => units === 'metric';
const unit = () => (metric() ? 'm' : 'ft');
const toU = (m) => +(m / (metric() ? 1 : FT)).toFixed(metric() ? 2 : 1);
const fromU = (v) => v * (metric() ? 1 : FT);
const fmtL = (m) => `${toU(m).toLocaleString()} ${unit()}`;
const fmtA = (m2) => (metric() ? `${Math.round(m2).toLocaleString()} m²` : `${Math.round(m2 / FT / FT).toLocaleString()} ft²`);
const fmtV = (m3) => (metric() ? `${Math.round(m3).toLocaleString()} m³` : `${Math.round(m3 / FT ** 3).toLocaleString()} ft³`);
const dims = (w, l) => `${toU(w)} × ${toU(l)} ${unit()}`;
const autoName = () => `Tent ${dims(s.w, s.l)}`;

const doc = () => makeModelDoc({ name: s.name || autoName(), width: s.w, length: s.l, tent: s.t, color: s.color, ballast: s.ballast });

/** Put a model document into the editor. */
function load(m, entry = null) {
  s.name = m.name; s.w = m.width; s.l = m.length; s.color = m.color; s.ballast = m.ballast !== false;
  s.t = { roof: 'auto', ...(m.tent || {}), walls: { ...(m.tent?.walls || {}) } };
  saved = entry; dirty = false;
  $('#md-name').value = s.name;
  render();
}

/* ------------------------------------------------------------------ static markup */
$('#md-roof').innerHTML = ROOFS.map((r) => `<button type="button" data-roof="${r}">${ROOF_LABEL[r]}</button>`).join('');
$('#md-all').innerHTML = ['none', 'solid', 'window', 'clear'].map((k) => `<button type="button" class="btn sm" data-all="${k}">All ${WALL_LABEL[k].toLowerCase()}</button>`).join('');
$('#md-walls').innerHTML = SIDES.map((side) => `<div class="field"><label>${SIDE_LABEL[side]}</label><div class="seg" data-side="${side}">${['none', 'solid', 'window', 'clear'].map((k) => `<button type="button" data-wall="${k}">${WALL_LABEL[k]}</button>`).join('')}</div></div>`).join('');
$('#md-fabric').innerHTML = `${FABRIC.map(([c, n]) => `<button type="button" class="swatch" data-fabric="${c}" style="background:${c}" title="${n}" aria-label="${n}"></button>`).join('')}<input type="color" id="md-color" title="Other colour" aria-label="Other colour">`;
$('#md-stock').innerHTML = `<option value="">Custom</option>${[...new Set(STOCK.map((r) => r.category))].map((cat) => `<optgroup label="${esc(cat)}">${STOCK.filter((r) => r.category === cat).map((r) => `<option value="${r.id}">${esc(r.name)}</option>`).join('')}</optgroup>`).join('')}`;

const preview = new TentPreview($('#md-canvas'));

/* ------------------------------------------------------------------ render */
const numIn = (id, v) => { const el = $(id); if (document.activeElement !== el) el.value = v == null ? '' : toU(v); };

function render() {
  const spec = resolveTent(s.w, s.l, s.t);
  preview.units = units;
  for (const b of document.querySelectorAll('#units button')) b.classList.toggle('on', b.dataset.units === units);
  for (const el of document.querySelectorAll('[data-unit]')) el.textContent = unit();
  for (const id of ['#md-w', '#md-l']) $(id).step = metric() ? 0.5 : 1;
  numIn('#md-w', s.w); numIn('#md-l', s.l);
  numIn('#md-eave', s.t.eave); numIn('#md-peak', s.t.peak); numIn('#md-bay', s.t.bay);
  $('#md-eave').placeholder = `auto · ${toU(spec.eave)}`;
  $('#md-peak').placeholder = `auto · ${toU(spec.auto.peak)}`;
  $('#md-bay').placeholder = `auto · ${toU(spec.bay)}`;
  $('#md-name').placeholder = autoName();
  for (const b of document.querySelectorAll('[data-roof]')) b.classList.toggle('on', b.dataset.roof === (s.t.roof || 'auto'));
  $('[data-roof="auto"]').textContent = `Auto (${ROOF_LABEL[spec.auto.roof]})`;
  for (const g of document.querySelectorAll('[data-side]')) for (const b of g.querySelectorAll('[data-wall]')) b.classList.toggle('on', b.dataset.wall === spec.walls[g.dataset.side]);
  for (const b of document.querySelectorAll('[data-fabric]')) b.classList.toggle('on', b.dataset.fabric === s.color);
  $('#md-color').value = s.color;
  $('#md-ballast').checked = s.ballast;
  const stock = STOCK.find((r) => Math.abs(r.width - s.w) < 0.02 && Math.abs(r.length - s.l) < 0.02);
  $('#md-stock').value = stock?.id || '';

  const q = quantities(s.w, s.l, spec);
  $('#md-qty').innerHTML = `
    <div><b>${fmtA(q.footprint)}</b><span>Footprint</span></div>
    <div><b>${fmtL(spec.peak)}</b><span>Peak · ${fmtL(spec.eave)} legs</span></div>
    <div><b>${fmtA(q.roof)}</b><span>Roof fabric</span></div>
    <div><b>${q.wallLength ? fmtL(q.wallLength) : '—'}</b><span>Sidewall${q.wallLength ? ` · ${fmtA(q.wallArea)}` : ''}</span></div>
    <div><b>${q.legs}</b><span>Legs${s.ballast ? ` · ${q.blocks} blocks` : ''}</span></div>
    <div><b>${fmtV(q.volume)}</b><span>Interior volume</span></div>`;
  preview.set(s.w, s.l, s.t, { color: s.color, ballast: s.ballast });
  renderExport();
  renderLibrary();
}

function renderExport() {
  if (DEMO) return;
  $('#md-save').textContent = saved ? (dirty ? 'Update saved model' : 'Saved · update') : 'Save to LiteMap';
  $('#md-save-note').textContent = saved
    ? `Saved as “${saved.name}”${dirty ? ' with unsaved changes' : ''}.`
    : 'Keeps the model in your LiteMap library so it can be placed and edited again.';
  const place = $('#md-place');
  const ready = Boolean(saved) && !dirty;
  place.setAttribute('aria-disabled', String(!ready));
  place.href = ready ? `/?model=${encodeURIComponent(saved.id)}` : '/';
  place.title = ready ? '' : 'Save the model first';
}

function renderLibrary() {
  if (DEMO) return;
  const box = $('#md-library');
  if (!library.length) { box.innerHTML = '<p class="muted small">Nothing saved yet. Models you save appear here and in the map’s object list under <i>My models</i>.</p>'; return; }
  box.innerHTML = library.map((m) => `
    <div class="md-model${saved?.id === m.id ? ' on' : ''}" data-open="${esc(m.id)}" role="button" tabindex="0">
      <b>${esc(m.name)}</b>
      <button type="button" class="btn icon sm md-del" data-del="${esc(m.id)}" title="Delete this saved model" aria-label="Delete ${esc(m.name)}">✕</button>
      <small>${esc(dims(m.width, m.length))} · ${esc(m.tent?.roof || 'auto roof')}${m.ballast === false ? '' : ' · ballast'}</small>
    </div>`).join('');
}

const touch = () => { dirty = true; render(); };

/* ------------------------------------------------------------------ editing */
document.addEventListener('input', (e) => {
  const t = e.target, v = parseFloat(t.value), pos = Number.isFinite(v) && v > 0 ? fromU(v) : null;
  if (t.id === 'md-name') { s.name = t.value; dirty = true; renderExport(); return; }
  if (t.id === 'md-w' && pos) s.w = Math.min(200, pos);
  else if (t.id === 'md-l' && pos) s.l = Math.min(400, pos);
  else if (t.id === 'md-eave') s.t.eave = pos;
  else if (t.id === 'md-peak') s.t.peak = pos;
  else if (t.id === 'md-bay') s.t.bay = pos;
  else if (t.id === 'md-color') s.color = t.value;
  else if (t.id === 'md-ballast') s.ballast = t.checked;
  else if (t.id === 'md-stock') { const r = STOCK.find((x) => x.id === t.value); if (r) { s.w = r.width; s.l = r.length; } }
  else return;
  touch();
});
document.addEventListener('change', (e) => { if (e.target.matches('input[type=number]')) render(); });

document.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.units) { units = b.dataset.units; ls.set('litemap:units', units); return render(); }
  if (b.dataset.view) { const [y, p] = b.dataset.view.split(',').map(Number); preview.view(y, p); return; }
  if (b.dataset.roof) s.t.roof = b.dataset.roof;
  else if (b.dataset.wall) s.t.walls[b.closest('[data-side]').dataset.side] = b.dataset.wall;
  else if (b.dataset.all) for (const side of SIDES) s.t.walls[side] = b.dataset.all;
  else if (b.dataset.fabric) s.color = b.dataset.fabric;
  else return;
  touch();
});

/* ------------------------------------------------------------------ pipeline */
async function refreshLibrary() {
  try {
    library = (await api('GET', '/models')).items;
  } catch (e) {
    library = [];
    $('#md-library').innerHTML = `<p class="muted small">Could not load saved models: ${esc(e.message)}</p>`;
    return;
  }
  if (saved) saved = library.find((m) => m.id === saved.id) || null;
  render();
}

async function save() {
  let d;
  try { d = doc(); } catch (e) { return toast(e.message, true); }
  const body = { ...d, tent: cleanTent(s.t) };
  try {
    const m = saved ? await api('PATCH', `/models/${encodeURIComponent(saved.id)}`, body) : await api('POST', '/models', body);
    saved = m; dirty = false;
    library = [m, ...library.filter((x) => x.id !== m.id)];
    render();
    toast(`Saved “${m.name}”. Use Place on map to put it on a site.`);
  } catch (e) { toast(e.message, true); }
}

$('#md-save').onclick = save;
$('#md-glb').onclick = () => {
  try { const d = doc(); download(`${fileStem(d.name)}.glb`, buildGlb(d), 'model/gltf-binary'); toast('Downloaded the .glb'); }
  catch (e) { toast(e.message, true); }
};
$('#md-json').onclick = () => {
  try { const d = doc(); download(`${fileStem(d.name)}.litemap-model.json`, `${JSON.stringify(d, null, 2)}\n`, 'application/json'); toast('Downloaded the model file'); }
  catch (e) { toast(e.message, true); }
};
$('#md-import').onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const m = /\.glb$/i.test(file.name) ? readGlb(new Uint8Array(await file.arrayBuffer())) : parseModelDoc(await file.text());
    load(m);
    dirty = true; renderExport();
    toast(`Imported “${m.name}”. Save it to keep it in your library.`);
  } catch (err) { toast(`Could not import: ${err.message}`, true); }
};

$('#md-library').addEventListener('click', async (e) => {
  const del = e.target.closest('[data-del]');
  if (del) {
    e.stopPropagation();
    const m = library.find((x) => x.id === del.dataset.del);
    if (!m || !confirm(`Delete “${m.name}” from your saved models?\n\nCopies already placed on a site keep working.`)) return;
    try { await api('DELETE', `/models/${encodeURIComponent(m.id)}`); } catch (err) { return toast(err.message, true); }
    library = library.filter((x) => x.id !== m.id);
    if (saved?.id === m.id) saved = null;
    return render();
  }
  const open = e.target.closest('[data-open]');
  if (open) { const m = library.find((x) => x.id === open.dataset.open); if (m) load(m, m); }
});
$('#md-library').addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[data-open]')) { e.preventDefault(); e.target.click(); }
});

window.addEventListener('beforeunload', (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });

/* ------------------------------------------------------------------ start */
if (DEMO) {
  // keep the 3D editor and the file exports; saving and placing need a LiteMap server
  $('.md-steps').outerHTML = `<p class="muted small md-demo">This is the online demo. <a href="${REPO}#quick-start" target="_blank" rel="noopener">Run LiteMap</a> to save models and place them, to scale, on satellite imagery of your site. The .glb opens in Blender, Windows 3D Viewer and most 3D tools; the model file imports into LiteMap.</p>`;
  $('.md-export h2').textContent = 'Export';
  $('#md-library').closest('section').remove();
}

(async () => {
  render();
  if (DEMO) return;
  await refreshLibrary();
  const id = new URLSearchParams(location.search).get('model');
  const m = id && library.find((x) => x.id === id);
  if (m) load(m, m);
  else if (id) toast('That saved model no longer exists', true);
})();
