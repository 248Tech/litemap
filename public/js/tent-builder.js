/*
 * Tent builder dialog: size, roof style, leg and peak heights, bay spacing,
 * sidewalls and fabric colour, with a live 3D preview and quote quantities.
 * Resolves with { width, length, tent, color } (metres; `tent` holds only the
 * values the user set, the rest stay automatic) or null when cancelled.
 */
import * as geo from './geo.js';
import { REFERENCE_OBJECTS } from './references.js';
import { FT, ROOFS, SIDES, resolveTent, cleanTent, quantities } from './tentspec.js';
import { TentPreview } from './tent3d.js';

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const ROOF_LABEL = { auto: 'Auto', pyramid: 'Pyramid', hip: 'Hip', gable: 'Gable' };
const WALL_LABEL = { none: 'Open', solid: 'Solid', window: 'Windows', clear: 'Clear' };
const SIDE_LABEL = { front: 'Front', back: 'Back', left: 'Left', right: 'Right' };
const FABRIC = [['#f6f6f3', 'White'], ['#efe6cf', 'Ivory'], ['#d6c3a0', 'Tan'], ['#3b6ea5', 'Blue'], ['#b23a3a', 'Red'], ['#3f7a4a', 'Green'], ['#2c2c2e', 'Black']];

export function openTentBuilder({ units = 'imperial', mode = 'place', init = {}, ballast = true }) {
  const dlg = $('#tent-dialog');
  const STOCK = REFERENCE_OBJECTS.filter((r) => r.id.startsWith('tent-') && r.id !== 'tent-custom'); // includes the local catalog
  const metric = units === 'metric';
  const u = metric ? 'm' : 'ft';
  const toU = (m) => +(m / (metric ? 1 : FT)).toFixed(metric ? 2 : 1);
  const fromU = (v) => v * (metric ? 1 : FT);
  const fmtL = (m) => `${toU(m).toLocaleString()} ${u}`;
  const fmtA = (m2) => (metric ? `${Math.round(m2).toLocaleString()} m²` : `${Math.round(m2 / FT / FT).toLocaleString()} ft²`);
  const fmtV = (m3) => (metric ? `${Math.round(m3).toLocaleString()} m³` : `${Math.round(m3 / FT ** 3).toLocaleString()} ft³`);

  const s = {
    w: init.width || 40 * FT, l: init.length || 60 * FT,
    t: { roof: 'auto', bay: null, eave: null, peak: null, walls: {}, ...(init.tent || {}) },
    color: init.color || '#f6f6f3',
  };
  s.t.walls = { ...(init.tent?.walls || {}) };

  dlg.innerHTML = `
    <div class="dialog-inner tb-dialog">
      <div class="dialog-head"><h2>Tent builder</h2><span class="muted small">Drag to orbit · scroll to zoom</span><span class="spacer"></span><button type="button" class="btn icon" data-x aria-label="Close">✕</button></div>
      <div class="tb-body">
        <div class="tb-view">
          <canvas id="tb-canvas" aria-label="3D tent preview"></canvas>
          <div class="tb-views">
            <button type="button" class="btn sm" data-view="-35,24">3/4</button>
            <button type="button" class="btn sm" data-view="0,8">Front</button>
            <button type="button" class="btn sm" data-view="90,8">Side</button>
            <button type="button" class="btn sm" data-view="0,85">Top</button>
          </div>
          <div class="tb-qty" id="tb-qty"></div>
        </div>
        <div class="tb-form">
          <div class="field"><label>Stock size</label><select id="tb-stock"><option value="">Custom</option>${[...new Set(STOCK.map((r) => r.category))].map((cat) => `<optgroup label="${esc(cat)}">${STOCK.filter((r) => r.category === cat).map((r) => `<option value="${r.id}">${esc(r.name)}</option>`).join('')}</optgroup>`).join('')}</select></div>
          <div class="field"><label>Width</label><div class="row"><input type="number" class="input" id="tb-w" min="1" step="${metric ? 0.5 : 1}"><span class="unit">${u}</span></div></div>
          <div class="field"><label>Length</label><div class="row"><input type="number" class="input" id="tb-l" min="1" step="${metric ? 0.5 : 1}"><span class="unit">${u}</span></div></div>
          <div class="field"><label>Roof</label><div class="seg" id="tb-roof">${ROOFS.map((r) => `<button type="button" data-roof="${r}">${ROOF_LABEL[r]}</button>`).join('')}</div></div>
          <div class="field"><label title="Height of the legs / eaves. Leave empty for the usual height for this size.">Leg height</label><div class="row"><input type="number" class="input" id="tb-eave" min="1" step="0.5"><span class="unit">${u}</span></div></div>
          <div class="field"><label title="Ridge or peak height. Leave empty for a standard pitch.">Peak height</label><div class="row"><input type="number" class="input" id="tb-peak" min="1" step="0.5"><span class="unit">${u}</span></div></div>
          <div class="field"><label title="Spacing between legs along the walls. Leave empty for 10 ft frames or 5 m clearspan bays.">Bay spacing</label><div class="row"><input type="number" class="input" id="tb-bay" min="1" step="0.5"><span class="unit">${u}</span></div></div>
          <div class="subcard tb-walls">
            <h2>Sidewalls <span class="row-btns tb-all">${['none', 'solid', 'window', 'clear'].map((k) => `<button type="button" class="btn sm" data-all="${k}">All ${WALL_LABEL[k].toLowerCase()}</button>`).join('')}</span></h2>
            ${SIDES.map((side) => `<div class="field"><label>${SIDE_LABEL[side]}</label><div class="seg" data-side="${side}">${['none', 'solid', 'window', 'clear'].map((k) => `<button type="button" data-wall="${k}">${WALL_LABEL[k]}</button>`).join('')}</div></div>`).join('')}
            <p class="muted small">Front is the end that faces the object's rotation (the top of the plan view).</p>
          </div>
          <div class="field"><label>Fabric</label><div class="swatches" id="tb-fabric">${FABRIC.map(([c, n]) => `<button type="button" class="swatch" data-fabric="${c}" style="background:${c}" title="${n}" aria-label="${n}"></button>`).join('')}<input type="color" id="tb-color" title="Other colour"></div></div>
        </div>
      </div>
      <div class="dialog-foot"><span class="muted small" id="tb-sum"></span><span class="spacer"></span>
        <button type="button" class="btn" data-x>Cancel</button>
        <button type="button" class="btn primary" id="tb-ok">${mode === 'edit' ? 'Apply to tent' : 'Place on map'}</button>
      </div>
    </div>`;

  const preview = new TentPreview($('#tb-canvas', dlg));
  preview.units = units;
  const numIn = (id, v) => { const el = $(id, dlg); if (document.activeElement !== el) el.value = v == null ? '' : toU(v); };

  function render() {
    const spec = resolveTent(s.w, s.l, s.t);
    numIn('#tb-w', s.w); numIn('#tb-l', s.l);
    numIn('#tb-eave', s.t.eave); numIn('#tb-peak', s.t.peak); numIn('#tb-bay', s.t.bay);
    $('#tb-eave', dlg).placeholder = `auto · ${toU(spec.eave)}`;
    $('#tb-peak', dlg).placeholder = `auto · ${toU(spec.auto.peak)}`;
    $('#tb-bay', dlg).placeholder = `auto · ${toU(spec.bay)}`;
    for (const b of dlg.querySelectorAll('[data-roof]')) b.classList.toggle('on', b.dataset.roof === (s.t.roof || 'auto'));
    $('[data-roof="auto"]', dlg).textContent = `Auto (${ROOF_LABEL[spec.auto.roof]})`;
    for (const g of dlg.querySelectorAll('[data-side]')) for (const b of g.querySelectorAll('[data-wall]')) b.classList.toggle('on', b.dataset.wall === spec.walls[g.dataset.side]);
    for (const b of dlg.querySelectorAll('[data-fabric]')) b.classList.toggle('on', b.dataset.fabric === s.color);
    $('#tb-color', dlg).value = s.color;
    const stock = STOCK.find((r) => Math.abs(r.width - s.w) < 0.02 && Math.abs(r.length - s.l) < 0.02);
    $('#tb-stock', dlg).value = stock?.id || '';
    const q = quantities(s.w, s.l, spec);
    $('#tb-qty', dlg).innerHTML = `
      <div><b>${fmtA(q.footprint)}</b><span>Footprint</span></div>
      <div><b>${fmtL(spec.peak)}</b><span>Peak · ${fmtL(spec.eave)} legs</span></div>
      <div><b>${fmtA(q.roof)}</b><span>Roof fabric</span></div>
      <div><b>${q.wallLength ? fmtL(q.wallLength) : '—'}</b><span>Sidewall${q.wallLength ? ` · ${fmtA(q.wallArea)}` : ''}</span></div>
      <div><b>${q.legs}</b><span>Legs · ${q.blocks} ballast blocks</span></div>
      <div><b>${fmtV(q.volume)}</b><span>Interior volume</span></div>`;
    $('#tb-sum', dlg).textContent = `${toU(s.w)} × ${toU(s.l)} ${u} ${ROOF_LABEL[spec.roof].toLowerCase()} tent`;
    preview.set(s.w, s.l, s.t, { color: s.color, ballast });
  }

  dlg.oninput = (e) => {
    const t = e.target;
    const v = parseFloat(t.value);
    const pos = Number.isFinite(v) && v > 0 ? fromU(v) : null;
    if (t.id === 'tb-w' && pos) s.w = Math.min(200, pos);
    else if (t.id === 'tb-l' && pos) s.l = Math.min(400, pos);
    else if (t.id === 'tb-eave') s.t.eave = pos;
    else if (t.id === 'tb-peak') s.t.peak = pos;
    else if (t.id === 'tb-bay') s.t.bay = pos;
    else if (t.id === 'tb-color') s.color = t.value;
    else if (t.id === 'tb-stock') { const r = STOCK.find((x) => x.id === t.value); if (r) { s.w = r.width; s.l = r.length; } }
    else return;
    render();
  };
  dlg.onchange = (e) => { if (e.target.matches('input[type=number]')) render(); };

  return new Promise((resolve) => {
    const done = (v) => {
      preview.destroy();
      dlg.removeEventListener('close', onClose);
      if (dlg.open) dlg.close();
      resolve(v);
    };
    const onClose = () => done(null);
    dlg.addEventListener('close', onClose);
    dlg.onclick = (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.hasAttribute('data-x')) return done(null);
      if (b.dataset.view) { const [y, p] = b.dataset.view.split(',').map(Number); preview.view(y, p); return; }
      if (b.dataset.roof) s.t.roof = b.dataset.roof;
      else if (b.dataset.wall) s.t.walls[b.closest('[data-side]').dataset.side] = b.dataset.wall;
      else if (b.dataset.all) for (const side of SIDES) s.t.walls[side] = b.dataset.all;
      else if (b.dataset.fabric) s.color = b.dataset.fabric;
      else if (b.id === 'tb-ok') return done({ width: s.w, length: s.l, tent: cleanTent(s.t), color: s.color });
      else return;
      render();
    };
    dlg.showModal();
    render();
  });
}
