/*
 * "Upload object" dialog: pick/drop/paste an image, isolate the object
 * (see cutout-worker.js), crop it, give it a real-world size, save it to the
 * object library. Resolves with the saved object, or null when cancelled.
 */
import * as geo from './geo.js';

const $ = (s, el = document) => el.querySelector(s);

let worker = null;
const getWorker = () => (worker ||= new Worker(new URL('./cutout-worker.js', import.meta.url), { type: 'module' }));

const METHODS = [
  ['auto', 'Auto'],
  ['ai', 'AI (photos)'],
  ['color', 'Plain background'],
  ['alpha', 'Already transparent'],
  ['none', 'Crop only'],
];

export function openObjectDialog({ units, upload, toast, file: initialFile = null }) {
  const dlg = $('#object-dialog');
  const u = geo.unitLabel(units);
  const toU = (m) => +geo.toUnit(m, units).toFixed(2);
  const fromU = (v) => geo.fromUnit(v, units);

  dlg.innerHTML = `
    <div class="dialog-inner obj-dialog">
      <div class="dialog-head"><h2>Upload object</h2><span class="spacer"></span><button type="button" class="btn icon" data-x aria-label="Close">✕</button></div>
      <label class="obj-drop" id="ob-drop">
        <input type="file" id="ob-file" accept="image/png,image/jpeg,image/webp,image/gif,image/bmp" hidden>
        <b>Drop an image here, paste it (Ctrl+V), or click to choose a file</b>
        <span class="muted small">Top-down views scale best: plan drawings, aerial/drone shots, product renders. The object is cut out and cropped automatically.</span>
      </label>
      <div class="obj-work" id="ob-work" hidden>
        <div class="obj-panes">
          <figure>
            <figcaption>Original <span class="muted">· click the object, or drag a box around it</span></figcaption>
            <div class="obj-src" id="ob-srcwrap"><canvas id="ob-src"></canvas><div class="obj-roi" id="ob-roi" hidden></div><div class="obj-crop" id="ob-crop" hidden></div><div class="obj-pt" id="ob-pt" hidden></div></div>
          </figure>
          <figure>
            <figcaption>Cut-out <span class="muted" id="ob-status"></span></figcaption>
            <div class="obj-out checker"><canvas id="ob-out"></canvas><div class="obj-busy" id="ob-busy" hidden></div></div>
          </figure>
        </div>
        <div class="obj-grid">
          <div class="field"><label>Isolate</label><select id="ob-method">${METHODS.map(([v, t]) => `<option value="${v}">${t}</option>`).join('')}</select></div>
          <div class="field"><label title="Higher keeps more of the image">Sensitivity</label><div class="row"><input type="range" id="ob-sens" min="0" max="100" step="1" value="50"><span class="unit" id="ob-sens-v">50</span></div></div>
          <div class="field"><label></label><div class="row wrap">
            <label class="toggle small" title="Drop other things in the picture; parts touching the main object are kept"><input type="checkbox" id="ob-largest" checked> Main object only</label>
            <label class="toggle small"><input type="checkbox" id="ob-smooth" checked> Smooth edges</label>
          </div></div>
          <div class="field"><label></label><div class="row-btns">
            <button type="button" class="btn sm" id="ob-rot" title="The image's top edge is the object's front (rotation 0° = north)">Rotate 90°</button>
            <button type="button" class="btn sm" id="ob-clear-roi" disabled>Clear selection</button>
            <button type="button" class="btn sm" id="ob-retry" hidden>Try again</button>
            <button type="button" class="btn sm" id="ob-other">Other image…</button>
          </div></div>
        </div>
        <div class="subcard obj-size">
          <h2>Real-world size</h2>
          <div class="field"><label>Name</label><input class="input" id="ob-name" maxlength="200" placeholder="e.g. 40×80 frame tent"></div>
          <div class="field"><label title="Left–right in the cut-out">Width ↔</label><div class="row"><input type="number" class="input" id="ob-w" min="0.01" step="0.5"><span class="unit">${u}</span></div></div>
          <div class="field"><label title="Top–bottom in the cut-out">Length ↕</label><div class="row"><input type="number" class="input" id="ob-l" min="0.01" step="0.5"><span class="unit">${u}</span></div></div>
          <div class="field"><label></label><label class="toggle small"><input type="checkbox" id="ob-lock" checked> Keep proportions <span class="muted" id="ob-aspect"></span></label></div>
          <p class="muted small" id="ob-size-note">Enter one known dimension and the other follows the picture. Untick to stretch it to an exact width × length.</p>
        </div>
      </div>
      <div class="dialog-foot">
        <span class="muted small" id="ob-foot"></span>
        <span class="spacer"></span>
        <button type="button" class="btn" data-x>Cancel</button>
        <button type="button" class="btn primary" id="ob-save" disabled>Save &amp; place</button>
      </div>
    </div>`;

  let w = getWorker();
  const st = { seq: 0, loadId: 0, loaded: null, result: null, roi: null, point: null, rotate: 0, busy: false, lastEdited: 'w', file: null, started: 0, stage: '' };
  const srcC = $('#ob-src', dlg), outC = $('#ob-out', dlg);
  const status = (t) => { $('#ob-status', dlg).textContent = t ? `· ${t}` : ''; };
  const STALL_MS = 90000;

  return new Promise((resolve) => {
    let done = false;
    let ticker = 0;
    const finish = (v) => {
      if (done) return;
      done = true;
      clearInterval(ticker);
      w.onmessage = w.onerror = null;
      document.removeEventListener('paste', onPaste);
      if (dlg.open) dlg.close();
      resolve(v);
    };
    dlg.onclose = () => finish(null);
    dlg.onclick = (e) => { if (e.target.closest('[data-x]')) finish(null); };

    /* ---- progress: show the stage and elapsed seconds, give up if the worker stalls */
    const setBusy = (on, stage = '') => {
      st.busy = on;
      st.stage = stage;
      $('#ob-busy', dlg).hidden = !on;
      $('#ob-retry', dlg).hidden = true;
      clearInterval(ticker);
      if (!on) return;
      st.started = performance.now();
      const tick = () => {
        const sec = (performance.now() - st.started) / 1000;
        status(`${st.stage || 'Working…'}${sec >= 2 ? ` ${Math.floor(sec)}s` : ''}`);
        if (sec * 1000 > STALL_MS) stalled();
      };
      tick();
      ticker = setInterval(tick, 500);
    };
    const fail = (msg) => {
      setBusy(false);
      status('');
      $('#ob-retry', dlg).hidden = !st.file;
      toast(msg, true);
      validate();
    };
    function stalled() {
      // A wedged worker can't be interrupted, only replaced.
      restartWorker();
      fail('The cut-out took too long and was stopped. Try again, draw a box around the object, or pick “Plain background” / “Crop only”.');
    }
    function restartWorker() {
      try { w.terminate(); } catch { /* gone */ }
      worker = null;
      w = getWorker();
      bindWorker();
      st.loaded = null;
    }

    /* ---- worker */
    function bindWorker() {
      w.onerror = (e) => { e.preventDefault?.(); restartWorker(); fail(`The cut-out worker crashed${e.message ? `: ${e.message}` : ''}. Try again or use a smaller image.`); };
      w.onmessageerror = () => fail('The cut-out worker sent an unreadable result.');
      w.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'status') { if (m.seq === st.seq && st.busy && m.text) { st.stage = m.text; status(m.text); } return; }
        if (m.type === 'loaded') {
          if (m.id !== st.loadId) return;
          st.loaded = m;
          $('#ob-foot', dlg).textContent = `${m.width}×${m.height}px · ${m.suggested === 'alpha' ? 'transparent image' : m.suggested === 'color' ? 'plain background detected' : 'photo: AI cut-out'}`;
          recut();
        } else if (m.type === 'result') {
          if (m.seq !== st.seq) { m.bitmap.close?.(); return; }
          const secs = (performance.now() - st.started) / 1000;
          setBusy(false);
          st.result?.bitmap.close?.();
          st.result = m;
          outC.width = m.width; outC.height = m.height;
          outC.getContext('2d').drawImage(m.bitmap, 0, 0);
          status(`${{ alpha: 'transparency', color: 'background removed', ai: 'AI cut-out', none: 'cropped' }[m.method]} · ${m.width}×${m.height}px${secs >= 1 ? ` · ${secs.toFixed(1)} s` : ''}`);
          showCrop(m.crop);
          syncSize();
        } else if (m.type === 'error') {
          if (m.id != null ? m.id !== st.loadId : m.seq !== st.seq) return;
          fail(m.message);
        }
      };
    }
    bindWorker();

    /* ---- input */
    const load = async (file) => {
      if (!file || !/^image\//.test(file.type)) return toast('That file is not an image (PNG, JPEG, WebP, GIF or BMP).', true);
      let bmp;
      try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch {
        return toast('Could not read that image. iPhone HEIC photos need converting to JPEG first.', true);
      }
      st.file = file; st.roi = null; st.point = null; st.rotate = 0; st.result = null; st.loaded = null;
      $('#ob-drop', dlg).hidden = true;
      $('#ob-work', dlg).hidden = false;
      $('#ob-clear-roi', dlg).disabled = true;
      $('#ob-roi', dlg).hidden = true;
      $('#ob-pt', dlg).hidden = true;
      $('#ob-crop', dlg).hidden = true;
      $('#ob-method', dlg).value = 'auto';
      if (!$('#ob-name', dlg).value) $('#ob-name', dlg).value = file.name ? file.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').slice(0, 80) : '';
      const s = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
      srcC.width = Math.round(bmp.width * s); srcC.height = Math.round(bmp.height * s);
      srcC.getContext('2d').drawImage(bmp, 0, 0, srcC.width, srcC.height);
      outC.width = outC.height = 1;
      st.loadId++;
      st.seq++;
      setBusy(true, 'Reading the image…');
      w.postMessage({ type: 'load', id: st.loadId, bitmap: bmp }, [bmp]);
      if (!$('#ob-w', dlg).value) $('#ob-w', dlg).value = units === 'metric' ? 6 : 20;
    };
    const fileIn = $('#ob-file', dlg);
    fileIn.onchange = () => { load(fileIn.files[0]); fileIn.value = ''; };
    $('#ob-other', dlg).onclick = () => fileIn.click();
    $('#ob-retry', dlg).onclick = () => { if (st.loaded) recut(); else if (st.file) load(st.file); };
    const drop = $('#ob-drop', dlg);
    const inner = $('.dialog-inner', dlg);
    inner.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
    inner.ondragleave = () => drop.classList.remove('over');
    inner.ondrop = (e) => { e.preventDefault(); e.stopPropagation(); drop.classList.remove('over'); load(e.dataTransfer.files[0]); };
    const onPaste = (e) => {
      const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
      if (item) { e.preventDefault(); load(item.getAsFile()); }
    };
    document.addEventListener('paste', onPaste);

    /* ---- cut-out controls */
    let t = 0;
    const recut = (delay = 0) => {
      clearTimeout(t);
      t = setTimeout(() => {
        if (!st.loaded) return;
        st.seq++;
        $('#ob-save', dlg).disabled = true;
        setBusy(true, 'Working…');
        w.postMessage({
          type: 'cut', seq: st.seq, method: $('#ob-method', dlg).value, roi: st.roi, point: st.point,
          sensitivity: Number($('#ob-sens', dlg).value), keepMain: $('#ob-largest', dlg).checked,
          smooth: $('#ob-smooth', dlg).checked, rotate: st.rotate,
        });
      }, delay);
    };
    $('#ob-method', dlg).onchange = () => recut();
    $('#ob-sens', dlg).oninput = (e) => { $('#ob-sens-v', dlg).textContent = e.target.value; recut(200); };
    $('#ob-largest', dlg).onchange = () => recut();
    $('#ob-smooth', dlg).onchange = () => recut();
    $('#ob-rot', dlg).onclick = () => {
      st.rotate = (st.rotate + 90) % 360;
      // swap the typed dimensions so the object keeps its real size
      const W = $('#ob-w', dlg), L = $('#ob-l', dlg);
      [W.value, L.value] = [L.value, W.value];
      st.lastEdited = st.lastEdited === 'w' ? 'l' : 'w';
      recut();
    };
    $('#ob-clear-roi', dlg).onclick = () => {
      st.roi = null; st.point = null;
      $('#ob-roi', dlg).hidden = true; $('#ob-pt', dlg).hidden = true;
      $('#ob-clear-roi', dlg).disabled = true;
      recut();
    };

    /* ---- selection on the original: click = "this object", drag = box. Stored as 0..1 fractions. */
    const wrap = $('#ob-srcwrap', dlg), roiEl = $('#ob-roi', dlg), ptEl = $('#ob-pt', dlg);
    let sel = null;
    const pos = (e) => {
      const r = srcC.getBoundingClientRect();
      return { x: Math.min(r.width, Math.max(0, e.clientX - r.left)), y: Math.min(r.height, Math.max(0, e.clientY - r.top)), r };
    };
    wrap.onpointerdown = (e) => {
      if (!st.file) return;
      e.preventDefault();
      try { wrap.setPointerCapture(e.pointerId); } catch { /* synthetic or already released */ }
      const p = pos(e);
      sel = { x0: p.x, y0: p.y, moved: false };
    };
    wrap.onpointermove = (e) => {
      if (!sel) return;
      const p = pos(e);
      if (!sel.moved && Math.hypot(p.x - sel.x0, p.y - sel.y0) < 6) return;
      sel.moved = true;
      roiEl.hidden = false;
      drawBox(roiEl, Math.min(sel.x0, p.x), Math.min(sel.y0, p.y), Math.abs(p.x - sel.x0), Math.abs(p.y - sel.y0));
    };
    wrap.onpointerup = (e) => {
      if (!sel) return;
      const p = pos(e);
      const { r } = p;
      const box = { x: Math.min(sel.x0, p.x) / r.width, y: Math.min(sel.y0, p.y) / r.height, w: Math.abs(p.x - sel.x0) / r.width, h: Math.abs(p.y - sel.y0) / r.height };
      const wasDrag = sel.moved && box.w * r.width >= 12 && box.h * r.height >= 12;
      sel = null;
      if (wasDrag) {
        st.roi = box;
        st.point = null; ptEl.hidden = true;
      } else {
        // a click picks the object under the pointer
        st.point = { x: p.x / r.width, y: p.y / r.height };
        roiEl.hidden = !st.roi;
        if (st.roi) placeRoi();
        placePoint();
        if ($('#ob-method', dlg).value === 'none') $('#ob-method', dlg).value = 'auto';
      }
      $('#ob-clear-roi', dlg).disabled = false;
      recut();
    };
    const offs = () => { const a = srcC.getBoundingClientRect(), b = wrap.getBoundingClientRect(); return { dx: a.left - b.left, dy: a.top - b.top, W: a.width, H: a.height }; };
    function drawBox(el, x, y, bw, bh) {
      const { dx, dy } = offs();
      Object.assign(el.style, { left: `${dx + x}px`, top: `${dy + y}px`, width: `${bw}px`, height: `${bh}px` });
    }
    const drawFrac = (el, f) => { const { W, H } = offs(); drawBox(el, f.x * W, f.y * H, f.w * W, f.h * H); };
    function placeRoi() { drawFrac(roiEl, st.roi); }
    function placePoint() {
      const { dx, dy, W, H } = offs();
      Object.assign(ptEl.style, { left: `${dx + st.point.x * W}px`, top: `${dy + st.point.y * H}px` });
      ptEl.hidden = false;
    }
    function showCrop(c) {
      const el = $('#ob-crop', dlg);
      if (!c) { el.hidden = true; return; }
      drawFrac(el, c);
      el.hidden = false;
      if (st.roi) placeRoi();
      if (st.point) placePoint();
    }

    /* ---- size */
    const W = $('#ob-w', dlg), L = $('#ob-l', dlg), lock = $('#ob-lock', dlg);
    const aspect = () => (st.result ? st.result.height / st.result.width : null);
    function syncSize() {
      const a = aspect();
      $('#ob-aspect', dlg).textContent = a ? `(1 : ${a.toFixed(a < 10 ? 2 : 1)})` : '';
      if (lock.checked && a) {
        const wv = parseFloat(W.value), lv = parseFloat(L.value);
        if (st.lastEdited === 'l' && lv > 0) W.value = +(lv / a).toFixed(2);
        else if (wv > 0) L.value = +(wv * a).toFixed(2);
      }
      validate();
    }
    function validate() {
      const ok = Boolean(st.result) && !st.busy && parseFloat(W.value) > 0 && parseFloat(L.value) > 0;
      $('#ob-save', dlg).disabled = !ok;
      const a = aspect(), wv = parseFloat(W.value), lv = parseFloat(L.value);
      const stretch = a && wv > 0 && lv > 0 ? (lv / wv) / a : 1;
      $('#ob-size-note', dlg).textContent = !lock.checked && Math.abs(stretch - 1) > 0.02
        ? `Stretched ${stretch > 1 ? 'taller' : 'wider'} by ${Math.round(Math.abs((stretch > 1 ? stretch : 1 / stretch) - 1) * 100)}% versus the picture.`
        : 'Enter one known dimension and the other follows the picture. Untick to stretch it to an exact width × length.';
    }
    W.oninput = () => { st.lastEdited = 'w'; syncSize(); };
    L.oninput = () => { st.lastEdited = 'l'; syncSize(); };
    lock.onchange = syncSize;

    $('#ob-save', dlg).onclick = async () => {
      const r = st.result;
      if (!r) return;
      const btn = $('#ob-save', dlg);
      btn.disabled = true;
      btn.textContent = 'Saving…';
      try {
        const obj = await upload(r.blob, { name: $('#ob-name', dlg).value.trim() || 'Uploaded object', width: fromU(parseFloat(W.value)), length: fromU(parseFloat(L.value)) });
        finish(obj);
      } catch (err) {
        toast(err.message, true);
        btn.disabled = false;
        btn.textContent = 'Save & place';
      }
    };

    dlg.showModal();
    if (initialFile) load(initialFile);
  });
}

/** Thumbnail <img> markup for an object in the library. */
export const objectThumb = (o, cls = 'obj-thumb') => `<img class="${cls}" src="/api/v1/objects/${encodeURIComponent(o.id)}/image" alt="" loading="lazy" draggable="false">`;
