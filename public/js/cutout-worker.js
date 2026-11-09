/*
 * Object cut-out worker: isolates the main object in an uploaded image and
 * crops to it. Methods:
 *   alpha – the image already has transparency (PNG/WebP cut-outs)
 *   color – plain/uniform background (renders, drawings, catalog shots): flood fill from the border
 *   ai    – photos: U²-Net (u2netp, 4.5 MB) saliency via onnxruntime-web (CPU/WASM; WebGPU is
 *           avoided on purpose, it can hang or reset the GPU on some drivers), averaged with a
 *           mirrored pass, then snapped to the real edges with a guided filter
 *   none  – keep everything, just crop to the selection
 *   auto  – picks one of the above from the image
 *
 * Messages in:  {type:'load', id, bitmap}
 *               {type:'cut', seq, method, roi?, point?, sensitivity, keepMain, smooth, rotate}
 *               (roi = {x,y,w,h} and point = {x,y} are fractions of the image, 0..1)
 * Messages out: {type:'loaded', id, ...} | {type:'result', seq, ...} | {type:'status', seq, text}
 *               | {type:'error', seq|id, message}
 */
const ORT_VERSION = '1.20.1';
const ORT_BASE = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;
const MODEL_URL = '/models/u2netp.onnx';
const MAX_SRC = 1600;   // working resolution (long side)
const MAX_OUT = 1400;   // uploaded cut-out (long side)
const NET = 320;

let src = null;          // ImageData of the uploaded image
let info = null;         // analysis of src
let aiCache = new Map(); // ROI key -> refined saliency (sensitivity/click changes reuse it)
let sessionPromise = null, ort = null, threads = 1;
let curSeq = null;

const post = (m, t) => self.postMessage(m, t || []);
const status = (text) => post({ type: 'status', seq: curSeq, text });

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === 'load') {
      const { bitmap } = m;
      const s = Math.min(1, MAX_SRC / Math.max(bitmap.width, bitmap.height));
      const w = Math.max(1, Math.round(bitmap.width * s)), h = Math.max(1, Math.round(bitmap.height * s));
      const c = new OffscreenCanvas(w, h);
      const g = c.getContext('2d', { willReadFrequently: true });
      g.imageSmoothingQuality = 'high';
      g.drawImage(bitmap, 0, 0, w, h);
      bitmap.close?.();
      src = g.getImageData(0, 0, w, h);
      aiCache = new Map();
      info = analyze(src);
      post({ type: 'loaded', id: m.id, width: w, height: h, ...info });
    } else if (m.type === 'cut') {
      curSeq = m.seq;
      const r = await cut(m);
      post({ type: 'result', seq: m.seq, ...r }, [r.bitmap]);
    }
  } catch (err) {
    post({ type: 'error', seq: m.seq, id: m.id, message: err?.message || String(err) });
  }
};

/* ------------------------------------------------------------ analysis */
function borderPixels(img, R = { x: 0, y: 0, w: img.width, h: img.height }) {
  const d = img.data, W = img.width, out = [];
  const step = Math.max(1, Math.floor((R.w + R.h) / 800));
  const push = (x, y) => { const i = ((R.y + y) * W + R.x + x) * 4; out.push([d[i], d[i + 1], d[i + 2], d[i + 3]]); };
  for (let x = 0; x < R.w; x += step) { push(x, 0); push(x, R.h - 1); }
  for (let y = 0; y < R.h; y += step) { push(0, y); push(R.w - 1, y); }
  return out;
}

const dist2 = (r, g, b, c) => (r - c[0]) ** 2 * 0.3 + (g - c[1]) ** 2 * 0.59 + (b - c[2]) ** 2 * 0.11;

/**
 * k-means (k ≤ 3) over border colours. Background clusters must cover ≥ 30 % of
 * the border, so an object that a selection box cuts through isn't keyed out.
 */
function backgroundColors(px) {
  const opaque = px.filter((p) => p[3] > 200);
  if (!opaque.length) return [];
  let cs = [opaque[0], opaque[Math.floor(opaque.length / 3)], opaque[Math.floor((2 * opaque.length) / 3)]].map((p) => p.slice(0, 3));
  const assign = new Int32Array(opaque.length);
  for (let it = 0; it < 8; it++) {
    const sums = cs.map(() => [0, 0, 0, 0]);
    opaque.forEach((p, i) => {
      let best = 0, bd = Infinity;
      cs.forEach((c, j) => { const dd = dist2(p[0], p[1], p[2], c); if (dd < bd) { bd = dd; best = j; } });
      assign[i] = best;
      const s = sums[best]; s[0] += p[0]; s[1] += p[1]; s[2] += p[2]; s[3]++;
    });
    cs = sums.map((s, j) => (s[3] ? [s[0] / s[3], s[1] / s[3], s[2] / s[3]] : cs[j]));
  }
  const counts = cs.map((_, j) => assign.reduce((n, a) => n + (a === j), 0));
  const spread = cs.map((c, j) => {
    let s = 0;
    opaque.forEach((p, i) => { if (assign[i] === j) s += dist2(p[0], p[1], p[2], c); });
    return Math.sqrt(s / Math.max(1, counts[j]));
  });
  return cs.map((c, j) => ({ c, share: counts[j] / opaque.length, spread: spread[j] }))
    .filter((k) => k.share >= 0.3)
    .sort((a, b) => b.share - a.share);
}
const uniformBorder = (img, R) => { const bg = backgroundColors(borderPixels(img, R)); return Boolean(bg[0] && bg[0].share > 0.7 && bg[0].spread < 18); };

function analyze(img) {
  const d = img.data;
  let transparent = 0;
  for (let i = 3; i < d.length; i += 16) if (d[i] < 250) transparent++;
  const hasAlpha = transparent / (d.length / 16) > 0.02;
  const uniform = uniformBorder(img);
  return { hasAlpha, uniformBackground: uniform, suggested: hasAlpha ? 'alpha' : uniform ? 'color' : 'ai' };
}

/* ------------------------------------------------------------ cut */
async function cut({ method = 'auto', roi, point, sensitivity = 50, keepMain = true, smooth = true, rotate = 0 }) {
  if (!src) throw new Error('No image loaded');
  let R = toRoi(roi, src.width, src.height);
  let used = method === 'auto' ? (info.hasAlpha ? 'alpha' : uniformBorder(src, R) ? 'color' : 'ai') : method;
  const px = point ? [point.x * src.width, point.y * src.height] : null;
  if (used === 'ai' && px && !roi) {
    // Clicked something the whole-image pass didn't consider salient (e.g. a house next to a pool):
    // look again, zoomed in on a window around the click.
    const full = await aiMask(R);
    const at = full[Math.min(src.height - 1, Math.round(px[1])) * src.width + Math.min(src.width - 1, Math.round(px[0]))];
    if (at < 0.45) {
      const side = Math.round(Math.max(src.width, src.height) * 0.42);
      const x = Math.max(0, Math.min(src.width - side, Math.round(px[0] - side / 2)));
      const y = Math.max(0, Math.min(src.height - side, Math.round(px[1] - side / 2)));
      R = { x, y, w: Math.min(side, src.width), h: Math.min(side, src.height) };
    }
  }
  const img = crop(src, R);
  const { width: w, height: h } = img;
  const focus = px && px[0] >= R.x && px[0] < R.x + R.w && px[1] >= R.y && px[1] < R.y + R.h ? [px[0] - R.x, px[1] - R.y] : null;

  let mask;
  if (used === 'alpha') {
    mask = new Float32Array(w * h);
    for (let i = 0; i < mask.length; i++) mask[i] = img.data[i * 4 + 3] / 255;
  } else if (used === 'color') {
    status('Removing the background…');
    mask = colorKey(img, sensitivity);
    if (!mask) used = 'ai';
  }
  if (used === 'ai') {
    // sensitivity 0..100 -> cutoff 0.8..0.2 (higher keeps more)
    const c = 0.8 - (sensitivity / 100) * 0.6;
    const sal = await aiMask(R, img);
    mask = new Float32Array(sal.length);
    for (let i = 0; i < sal.length; i++) mask[i] = smoothstep(c - 0.1, c + 0.1, sal[i]);
  }
  if (used === 'none') mask = new Float32Array(w * h).fill(1);

  if (used !== 'none') {
    status('Cleaning up…');
    cleanup(mask, w, h, keepMain, focus);
    if (smooth && used !== 'ai') blurMask(mask, w, h);
  }
  if (used !== 'alpha') for (let i = 0; i < mask.length; i++) mask[i] *= img.data[i * 4 + 3] / 255;

  const bb = bbox(mask, w, h, 0.06);
  if (!bb) throw new Error('Nothing was left after isolating. Raise the sensitivity, click the object, draw a box around it, or try another method.');
  let coverage = 0;
  for (let i = 0; i < mask.length; i++) coverage += mask[i];
  coverage /= mask.length;

  const out = new ImageData(bb.w, bb.h);
  for (let y = 0; y < bb.h; y++) {
    for (let x = 0; x < bb.w; x++) {
      const si = (y + bb.y) * w + x + bb.x, di = y * bb.w + x;
      out.data[di * 4] = img.data[si * 4];
      out.data[di * 4 + 1] = img.data[si * 4 + 1];
      out.data[di * 4 + 2] = img.data[si * 4 + 2];
      out.data[di * 4 + 3] = Math.round(mask[si] * 255);
    }
  }
  const canvas = new OffscreenCanvas(bb.w, bb.h);
  canvas.getContext('2d').putImageData(out, 0, 0);
  const s = Math.min(1, MAX_OUT / Math.max(bb.w, bb.h));
  const rot = ((rotate % 360) + 360) % 360;
  const ow = Math.round(bb.w * s), oh = Math.round(bb.h * s);
  const [fw, fh] = rot % 180 ? [oh, ow] : [ow, oh];
  const final = new OffscreenCanvas(Math.max(1, fw), Math.max(1, fh));
  const g = final.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.translate(fw / 2, fh / 2);
  g.rotate((rot * Math.PI) / 180);
  g.drawImage(canvas, -ow / 2, -oh / 2, ow, oh);

  status('Encoding…');
  let blob = await final.convertToBlob({ type: 'image/webp', quality: 0.92 });
  if (blob.type !== 'image/webp') blob = await final.convertToBlob({ type: 'image/png' });
  const bitmap = final.transferToImageBitmap();
  const W = src.width, H = src.height;
  return {
    bitmap, blob, width: fw, height: fh, method: used, coverage,
    crop: { x: (R.x + bb.x) / W, y: (R.y + bb.y) / H, w: bb.w / W, h: bb.h / H },
  };
}

/** Edge-refined saliency for a region of the source, cached per region. */
async function aiMask(R, img = crop(src, R)) {
  const key = `${R.x},${R.y},${R.w},${R.h}`;
  if (!aiCache.has(key)) {
    const coarse = await segment(img);
    status('Snapping to edges…');
    aiCache.set(key, guidedRefine(img, coarse));
    if (aiCache.size > 4) aiCache.delete(aiCache.keys().next().value);
  }
  return aiCache.get(key);
}

function toRoi(roi, W, H) {
  if (!roi) return { x: 0, y: 0, w: W, h: H };
  const x = Math.max(0, Math.min(W - 1, Math.round(roi.x * W))), y = Math.max(0, Math.min(H - 1, Math.round(roi.y * H)));
  const w = Math.max(1, Math.min(W - x, Math.round(roi.w * W))), h = Math.max(1, Math.min(H - y, Math.round(roi.h * H)));
  return w < 8 || h < 8 ? { x: 0, y: 0, w: W, h: H } : { x, y, w, h };
}
function crop(img, { x, y, w, h }) {
  if (x === 0 && y === 0 && w === img.width && h === img.height) return img;
  const out = new ImageData(w, h);
  for (let r = 0; r < h; r++) out.data.set(img.data.subarray(((y + r) * img.width + x) * 4, ((y + r) * img.width + x + w) * 4), r * w * 4);
  return out;
}

/** Background = everything connected to the border whose colour is close to a border colour cluster. */
function colorKey(img, sensitivity) {
  const { width: w, height: h, data: d } = img;
  const bg = backgroundColors(borderPixels(img));
  if (!bg.length) return null;
  const tol = 6 + (sensitivity / 100) * 70;     // perceptual RGB distance
  const t2 = tol * tol, soft2 = (tol * 1.5) ** 2;
  const n = w * h;
  const dd = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (d[i * 4 + 3] < 16) { dd[i] = 0; continue; }
    let best = Infinity;
    for (const k of bg) { const v = dist2(d[i * 4], d[i * 4 + 1], d[i * 4 + 2], k.c); if (v < best) best = v; }
    dd[i] = best;
  }
  const seen = new Uint8Array(n);
  const stack = new Int32Array(n);
  let sp = 0;
  const seed = (i) => { if (!seen[i] && dd[i] < t2) { seen[i] = 1; stack[sp++] = i; } };
  for (let x = 0; x < w; x++) { seed(x); seed((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { seed(y * w); seed(y * w + w - 1); }
  while (sp) {
    const i = stack[--sp], x = i % w;
    if (x > 0) seed(i - 1);
    if (x < w - 1) seed(i + 1);
    if (i >= w) seed(i - w);
    if (i + w < n) seed(i + w);
  }
  const mask = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (!seen[i]) { mask[i] = 1; continue; }
    mask[i] = dd[i] > t2 * 0.6 ? Math.min(1, (dd[i] - t2 * 0.6) / (soft2 - t2 * 0.6)) * 0.5 : 0;
  }
  return mask;
}

/**
 * Keep the main object: connected blobs are scored by size and closeness to the
 * focus (a clicked point, else the selection centre). Large blobs touching the
 * main one's box are kept too, so an object split by a shadow or a pole stays whole.
 * Specks always go; small enclosed holes are filled.
 */
function cleanup(mask, w, h, keepMain, focus) {
  const n = w * h;
  const lab = new Int32Array(n).fill(-1);
  const comps = [];
  const stack = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    if (lab[i] !== -1 || mask[i] < 0.5) continue;
    const id = comps.length;
    const c = { size: 0, sx: 0, sy: 0, x0: w, y0: h, x1: 0, y1: 0, hit: false };
    let sp = 0;
    lab[i] = id; stack[sp++] = i;
    while (sp) {
      const j = stack[--sp];
      const x = j % w, y = (j / w) | 0;
      c.size++; c.sx += x; c.sy += y;
      if (x < c.x0) c.x0 = x;
      if (x > c.x1) c.x1 = x;
      if (y < c.y0) c.y0 = y;
      if (y > c.y1) c.y1 = y;
      if (x > 0 && lab[j - 1] === -1 && mask[j - 1] >= 0.5) { lab[j - 1] = id; stack[sp++] = j - 1; }
      if (x < w - 1 && lab[j + 1] === -1 && mask[j + 1] >= 0.5) { lab[j + 1] = id; stack[sp++] = j + 1; }
      if (y > 0 && lab[j - w] === -1 && mask[j - w] >= 0.5) { lab[j - w] = id; stack[sp++] = j - w; }
      if (y < h - 1 && lab[j + w] === -1 && mask[j + w] >= 0.5) { lab[j + w] = id; stack[sp++] = j + w; }
    }
    comps.push(c);
  }
  if (!comps.length) return;
  if (focus) {
    const fi = Math.min(h - 1, Math.max(0, Math.round(focus[1]))) * w + Math.min(w - 1, Math.max(0, Math.round(focus[0])));
    if (lab[fi] >= 0) comps[lab[fi]].hit = true;
  }
  const [fx, fy] = focus || [w / 2, h / 2];
  const diag = Math.hypot(w, h);
  let main = 0, best = -1;
  comps.forEach((c, id) => {
    const d = Math.hypot(c.sx / c.size - fx, c.sy / c.size - fy) / diag;
    const score = c.hit ? Infinity : c.size / (1 + (d * (focus ? 8 : 3)) ** 2);
    if (score > best) { best = score; main = id; }
  });
  const m = comps[main];
  const pad = diag * 0.03;
  const keep = comps.map((c, id) => {
    if (id === main) return true;
    if (c.size < Math.max(24, n * 0.002)) return false;
    if (!keepMain) return true;
    const touches = c.x1 >= m.x0 - pad && c.x0 <= m.x1 + pad && c.y1 >= m.y0 - pad && c.y0 <= m.y1 + pad;
    return touches && c.size >= m.size * 0.08;
  });
  for (let i = 0; i < n; i++) if (lab[i] >= 0 && !keep[lab[i]]) mask[i] = 0;
  // soft pixels (< 0.5) only survive within 3 px of a kept blob
  const near = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (lab[i] >= 0 && keep[lab[i]]) near[i] = 1;
  for (let pass = 0; pass < 3; pass++) {
    const prev = near.slice();
    for (let i = 0; i < n; i++) {
      if (prev[i]) continue;
      const x = i % w;
      if ((x > 0 && prev[i - 1]) || (x < w - 1 && prev[i + 1]) || (i >= w && prev[i - w]) || (i + w < n && prev[i + w])) near[i] = 1;
    }
  }
  for (let i = 0; i < n; i++) if (!near[i]) mask[i] = 0;
  // fill enclosed holes (background not connected to the border), if small
  const outside = new Uint8Array(n);
  let sp = 0;
  const seed = (i) => { if (!outside[i] && mask[i] < 0.5) { outside[i] = 1; stack[sp++] = i; } };
  for (let x = 0; x < w; x++) { seed(x); seed((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { seed(y * w); seed(y * w + w - 1); }
  while (sp) {
    const j = stack[--sp], x = j % w;
    if (x > 0) seed(j - 1);
    if (x < w - 1) seed(j + 1);
    if (j >= w) seed(j - w);
    if (j + w < n) seed(j + w);
  }
  let holes = 0;
  for (let i = 0; i < n; i++) if (!outside[i] && mask[i] < 0.5) holes++;
  if (holes && holes < n * 0.03) for (let i = 0; i < n; i++) if (!outside[i] && mask[i] < 0.5) mask[i] = 1;
}

function blurMask(mask, w, h) {
  const tmp = new Float32Array(mask.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    tmp[i] = (mask[i] * 2 + (x > 0 ? mask[i - 1] : mask[i]) + (x < w - 1 ? mask[i + 1] : mask[i])) / 4;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    mask[i] = (tmp[i] * 2 + (y > 0 ? tmp[i - w] : tmp[i]) + (y < h - 1 ? tmp[i + w] : tmp[i])) / 4;
  }
}

function bbox(mask, w, h, t) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (mask[y * w + x] > t) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}
const smoothstep = (a, b, v) => { const t = Math.min(1, Math.max(0, (v - a) / (b - a))); return t * t * (3 - 2 * t); };

/* ------------------------------------------------------------ edge refinement */
/** O(n) box mean of radius r (clamped at the borders) via a summed-area table. */
function boxMean(a, w, h, r) {
  const S = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) { row += a[y * w + x]; S[(y + 1) * (w + 1) + x + 1] = S[y * (w + 1) + x + 1] + row; }
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
      out[y * w + x] = (S[y1 * (w + 1) + x1] - S[y0 * (w + 1) + x1] - S[y1 * (w + 1) + x0] + S[y0 * (w + 1) + x0]) / ((x1 - x0) * (y1 - y0));
    }
  }
  return out;
}

/**
 * Fast guided filter (He & Sun 2015) per colour channel: the low-res AI mask
 * takes on the image's own edges, so the outline follows the object instead of
 * 320-px blocks. Coefficients are solved on a ≤ 480-px copy and upsampled, which
 * keeps it well under a second for any size.
 */
function guidedRefine(img, p) {
  const { width: w, height: h, data: d } = img;
  const n = w * h;
  const f = Math.max(1, Math.ceil(Math.max(w, h) / 480));
  const lw = Math.ceil(w / f), lh = Math.ceil(h / f), ln = lw * lh;
  const r = Math.max(1, Math.round(Math.max(lw, lh) / 160));
  const eps = 0.004;
  // area-average downsample of the guide channels and the mask
  const down = (get) => {
    const out = new Float32Array(ln), cnt = new Float32Array(ln);
    for (let y = 0; y < h; y++) {
      const ly = (y / f) | 0;
      for (let x = 0; x < w; x++) { const li = ly * lw + ((x / f) | 0); out[li] += get(y * w + x); cnt[li]++; }
    }
    for (let i = 0; i < ln; i++) out[i] /= cnt[i] || 1;
    return out;
  };
  const lp = down((i) => p[i]);
  const meanP = boxMean(lp, lw, lh, r);
  const As = [], Bsum = new Float32Array(ln);
  for (let ch = 0; ch < 3; ch++) {
    const I = down((i) => d[i * 4 + ch] / 255);
    const Ip = new Float32Array(ln), II = new Float32Array(ln);
    for (let i = 0; i < ln; i++) { Ip[i] = I[i] * lp[i]; II[i] = I[i] * I[i]; }
    const mI = boxMean(I, lw, lh, r), mIp = boxMean(Ip, lw, lh, r), mII = boxMean(II, lw, lh, r);
    const A = new Float32Array(ln), B = new Float32Array(ln);
    for (let i = 0; i < ln; i++) {
      const a = (mIp[i] - mI[i] * meanP[i]) / (mII[i] - mI[i] * mI[i] + eps);
      A[i] = a; B[i] = meanP[i] - a * mI[i];
    }
    As.push(boxMean(A, lw, lh, r));
    const mB = boxMean(B, lw, lh, r);
    for (let i = 0; i < ln; i++) Bsum[i] += mB[i] / 3;
  }
  // q = Σ (A_c · I_c) / 3 + B, with A and B bilinearly upsampled (index tables built once)
  const xi0 = new Int32Array(w), xi1 = new Int32Array(w), xt = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    const fx = Math.min(lw - 1, Math.max(0, (x + 0.5) / f - 0.5));
    xi0[x] = fx | 0; xi1[x] = Math.min(lw - 1, xi0[x] + 1); xt[x] = fx - xi0[x];
  }
  const q = new Float32Array(n);
  const planes = [...As, Bsum];
  for (let y = 0; y < h; y++) {
    const fy = Math.min(lh - 1, Math.max(0, (y + 0.5) / f - 0.5));
    const r0 = (fy | 0) * lw, r1 = Math.min(lh - 1, (fy | 0) + 1) * lw, ty = fy - (fy | 0);
    for (let x = 0; x < w; x++) {
      const a0 = xi0[x], a1 = xi1[x], tx = xt[x];
      const i = y * w + x;
      let v = 0;
      for (let k = 0; k < 4; k++) {
        const P = planes[k];
        const s = (P[r0 + a0] * (1 - tx) + P[r0 + a1] * tx) * (1 - ty) + (P[r1 + a0] * (1 - tx) + P[r1 + a1] * tx) * ty;
        v += k < 3 ? (s * d[i * 4 + k]) / 765 : s;
      }
      q[i] = v;
    }
  }
  for (let i = 0; i < n; i++) q[i] = Math.min(1, Math.max(0, q[i]));
  return q;
}

/* ------------------------------------------------------------ U²-Net */
async function getSession() {
  if (sessionPromise) return sessionPromise;
  sessionPromise = (async () => {
    status('Loading the AI runtime (one-time download, about 10 MB)…');
    ort = await import(`${ORT_BASE}ort.wasm.min.mjs`);
    ort.env.wasm.wasmPaths = ORT_BASE;
    threads = self.crossOriginIsolated ? Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 2) - 1)) : 1;
    ort.env.wasm.numThreads = threads;
    status('Loading the cut-out model…');
    const r = await fetch(MODEL_URL);
    if (!r.ok) throw new Error(`model download failed (${r.status})`);
    const model = new Uint8Array(await r.arrayBuffer());
    return ort.InferenceSession.create(model, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
  })();
  sessionPromise.catch(() => { sessionPromise = null; });
  return sessionPromise;
}

/** Saliency (0..1) at the image's own size: mean of a normal and a mirrored pass. */
async function segment(img) {
  const session = await getSession();
  status(`Finding the object (AI, ${threads} CPU thread${threads > 1 ? 's' : ''})…`);
  const { width: w, height: h } = img;
  const c = new OffscreenCanvas(w, h);
  c.getContext('2d').putImageData(img, 0, 0);
  const s = new OffscreenCanvas(NET, NET);
  const g = s.getContext('2d', { willReadFrequently: true });
  g.imageSmoothingQuality = 'high';
  g.drawImage(c, 0, 0, NET, NET);
  const px = g.getImageData(0, 0, NET, NET).data;
  const P = NET * NET;
  let max = 1;
  for (let i = 0; i < px.length; i++) if ((i & 3) !== 3 && px[i] > max) max = px[i];
  const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225];
  const run = async (flip) => {
    const input = new Float32Array(3 * P);
    for (let y = 0; y < NET; y++) for (let x = 0; x < NET; x++) {
      const si = (y * NET + (flip ? NET - 1 - x : x)) * 4, di = y * NET + x;
      for (let ch = 0; ch < 3; ch++) input[ch * P + di] = (px[si + ch] / max - mean[ch]) / std[ch];
    }
    const res = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, NET, NET]) });
    const out = Float32Array.from(res[session.outputNames[0]].data.subarray(0, P));
    for (const k of Object.keys(res)) res[k].dispose?.();
    return out;
  };
  const t0 = performance.now();
  const a = await run(false);
  // A mirrored second pass steadies the mask; skip it on slow machines.
  let b = null;
  if (performance.now() - t0 < 6000) {
    status('Finding the object (AI, mirrored pass)…');
    b = await run(true);
  }
  const sal = new Float32Array(P);
  let lo = Infinity, hi = -Infinity;
  for (let y = 0; y < NET; y++) for (let x = 0; x < NET; x++) {
    const v = b ? (a[y * NET + x] + b[y * NET + NET - 1 - x]) / 2 : a[y * NET + x];
    sal[y * NET + x] = v;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const span = hi - lo || 1;
  const mask = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const fy = Math.min(NET - 1, Math.max(0, ((y + 0.5) * NET) / h - 0.5)), y0 = Math.floor(fy), y1 = Math.min(NET - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.min(NET - 1, Math.max(0, ((x + 0.5) * NET) / w - 0.5)), x0 = Math.floor(fx), x1 = Math.min(NET - 1, x0 + 1), tx = fx - x0;
      const v = (sal[y0 * NET + x0] * (1 - tx) + sal[y0 * NET + x1] * tx) * (1 - ty) + (sal[y1 * NET + x0] * (1 - tx) + sal[y1 * NET + x1] * tx) * ty;
      mask[y * w + x] = (v - lo) / span;
    }
  }
  return mask;
}
