/*
 * Tile enhancement worker (module worker).
 *
 * Builds each output tile from the source imagery's native-resolution pixels,
 * including a margin borrowed from neighbouring tiles so filters and the neural
 * net see across tile edges (no seams), then upscales:
 *
 *   sharpen  Lanczos-3 resampling + unsharp mask. Deterministic; uses only the real pixels.
 *   ai       Real-ESRGAN (realesr-general-x4v3, BSD-3) via ONNX Runtime Web (WebGPU, WASM fallback)
 *            for tiles beyond the source's native zoom. Generates plausible detail, so
 *            results are for viewing, not for measuring fine features.
 *   plain    Native pixels only (used at low zooms where there is nothing to gain).
 *
 * Output tiles are 512×512 for a 256-CSS-px tile, i.e. 2× density for HiDPI screens.
 */

const ORT_VERSION = '1.20.1';
const ORT_BASE = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;
const MODEL_URLS = [
  '/models/realesr-general-x4v3.onnx',
  'https://huggingface.co/jonathanst29/tinier-upscale-models/resolve/main/realesr-general-x4v3.onnx',
];
const OUT = 512;
const MARGIN = 8; // source pixels of context on each side

/* ------------------------------------------------------------ source tiles */
const tileCache = new Map(); // url -> Promise<ImageData|null>
const CACHE_MAX = 160;

function fetchTile(template, z, x, y) {
  const n = 2 ** z;
  if (y < 0 || y >= n) return Promise.resolve(null);
  const xx = ((x % n) + n) % n;
  const url = template.replace('{z}', z).replace('{x}', xx).replace('{y}', y);
  let p = tileCache.get(url);
  if (p) { tileCache.delete(url); tileCache.set(url, p); return p; }
  p = (async () => {
    const res = await fetch(url);
    if (!res.ok) return null;
    const bmp = await createImageBitmap(await res.blob());
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const g = c.getContext('2d');
    g.drawImage(bmp, 0, 0);
    bmp.close();
    return g.getImageData(0, 0, c.width, c.height);
  })().catch(() => null);
  tileCache.set(url, p);
  while (tileCache.size > CACHE_MAX) tileCache.delete(tileCache.keys().next().value);
  return p;
}

/** Assemble a w×h RGBA window at zoom `zs` starting at global pixel (px, py); edges clamp. */
async function region(template, zs, px, py, w, h, ts = 256) {
  const tx0 = Math.floor(px / ts), ty0 = Math.floor(py / ts);
  const tx1 = Math.floor((px + w - 1) / ts), ty1 = Math.floor((py + h - 1) / ts);
  const tiles = new Map();
  const jobs = [];
  for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
    jobs.push(fetchTile(template, zs, tx, ty).then((d) => tiles.set(`${tx},${ty}`, d)));
  }
  await Promise.all(jobs);
  const center = tiles.get(`${Math.floor((px + w / 2) / ts)},${Math.floor((py + h / 2) / ts)}`);
  if (!center) return null;
  const out = new Uint8ClampedArray(w * h * 4);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      let gx = px + i, gy = py + j;
      let t = tiles.get(`${Math.floor(gx / ts)},${Math.floor(gy / ts)}`);
      if (!t) { // missing neighbour: clamp into the centre tile
        const cx = Math.floor((px + w / 2) / ts), cy = Math.floor((py + h / 2) / ts);
        gx = Math.min(Math.max(gx, cx * ts), cx * ts + ts - 1);
        gy = Math.min(Math.max(gy, cy * ts), cy * ts + ts - 1);
        t = center;
      }
      const lx = gx - Math.floor(gx / ts) * ts, ly = gy - Math.floor(gy / ts) * ts;
      const si = (ly * t.width + lx) * 4, di = (j * w + i) * 4;
      out[di] = t.data[si]; out[di + 1] = t.data[si + 1]; out[di + 2] = t.data[si + 2]; out[di + 3] = 255;
    }
  }
  return { data: out, w, h };
}

/* ------------------------------------------------------------ resampling */
const sinc = (x) => (x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x));
const lanczos3 = (x) => (Math.abs(x) < 3 ? sinc(x) * sinc(x / 3) : 0);

function weights(srcLen, dstLen) {
  const scale = dstLen / srcLen;
  const support = scale < 1 ? 3 / scale : 3;
  const out = [];
  for (let i = 0; i < dstLen; i++) {
    const c = (i + 0.5) / scale - 0.5;
    const lo = Math.floor(c - support) + 1, hi = Math.floor(c + support);
    const idx = [], w = [];
    let sum = 0;
    for (let k = lo; k <= hi; k++) {
      const v = lanczos3(scale < 1 ? (k - c) * scale : k - c);
      if (v === 0) continue;
      idx.push(Math.min(srcLen - 1, Math.max(0, k))); w.push(v); sum += v;
    }
    out.push({ idx, w: w.map((v) => v / sum) });
  }
  return out;
}

/** Separable Lanczos-3 resize of an RGB(A) float buffer [w*h*4] to dw×dh. */
function resize(src, w, h, dw, dh) {
  const wx = weights(w, dw), wy = weights(h, dh);
  const tmp = new Float32Array(dw * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < dw; x++) {
    const { idx, w: ws } = wx[x];
    let r = 0, g = 0, b = 0;
    for (let k = 0; k < idx.length; k++) { const s = (y * w + idx[k]) * 4; r += src[s] * ws[k]; g += src[s + 1] * ws[k]; b += src[s + 2] * ws[k]; }
    const d = (y * dw + x) * 4; tmp[d] = r; tmp[d + 1] = g; tmp[d + 2] = b;
  }
  const out = new Float32Array(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    const { idx, w: ws } = wy[y];
    for (let x = 0; x < dw; x++) {
      let r = 0, g = 0, b = 0;
      for (let k = 0; k < idx.length; k++) { const s = (idx[k] * dw + x) * 4; r += tmp[s] * ws[k]; g += tmp[s + 1] * ws[k]; b += tmp[s + 2] * ws[k]; }
      const d = (y * dw + x) * 4; out[d] = r; out[d + 1] = g; out[d + 2] = b; out[d + 3] = 255;
    }
  }
  return out;
}

function gaussianKernel(sigma) {
  const r = Math.max(1, Math.ceil(sigma * 2.5));
  const k = [];
  let s = 0;
  for (let i = -r; i <= r; i++) { const v = Math.exp(-(i * i) / (2 * sigma * sigma)); k.push(v); s += v; }
  return { r, k: k.map((v) => v / s) };
}

/** Unsharp mask in place: img + amount·(img − blur(img)), with a small noise threshold. */
function unsharp(img, w, h, sigma, amount, threshold = 2) {
  const { r, k } = gaussianKernel(sigma);
  const tmp = new Float32Array(img.length), blur = new Float32Array(img.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < 3; c++) {
    let v = 0;
    for (let i = -r; i <= r; i++) v += img[(y * w + Math.min(w - 1, Math.max(0, x + i))) * 4 + c] * k[i + r];
    tmp[(y * w + x) * 4 + c] = v;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < 3; c++) {
    let v = 0;
    for (let i = -r; i <= r; i++) v += tmp[(Math.min(h - 1, Math.max(0, y + i)) * w + x) * 4 + c] * k[i + r];
    blur[(y * w + x) * 4 + c] = v;
  }
  for (let i = 0; i < img.length; i += 4) for (let c = 0; c < 3; c++) {
    const d = img[i + c] - blur[i + c];
    if (Math.abs(d) > threshold) img[i + c] += amount * d;
  }
}

/**
 * Edge-preserving bilateral filter on a float RGBA buffer. Suppresses JPEG
 * blocking and noise in the source before it gets magnified, but keeps real
 * edges (roof lines, pool copings, curbs) because they differ strongly in colour.
 */
function bilateral(src, w, h, radius = 2, sigmaS = 1.2, sigmaR = 16) {
  const out = new Float32Array(src.length);
  const ws = [];
  for (let j = -radius; j <= radius; j++) for (let i = -radius; i <= radius; i++) ws.push({ i, j, w: Math.exp(-(i * i + j * j) / (2 * sigmaS * sigmaS)) });
  const inv2r = 1 / (2 * sigmaR * sigmaR);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const c = (y * w + x) * 4;
    const r0 = src[c], g0 = src[c + 1], b0 = src[c + 2];
    let r = 0, g = 0, b = 0, sum = 0;
    for (const { i, j, w: wsp } of ws) {
      const xx = Math.min(w - 1, Math.max(0, x + i)), yy = Math.min(h - 1, Math.max(0, y + j));
      const k = (yy * w + xx) * 4;
      const dr = src[k] - r0, dg = src[k + 1] - g0, db = src[k + 2] - b0;
      const wt = wsp * Math.exp(-(dr * dr + dg * dg + db * db) * inv2r / 3);
      r += src[k] * wt; g += src[k + 1] * wt; b += src[k + 2] * wt; sum += wt;
    }
    out[c] = r / sum; out[c + 1] = g / sum; out[c + 2] = b / sum; out[c + 3] = 255;
  }
  return out;
}

function toFloat(u8) { const f = new Float32Array(u8.length); for (let i = 0; i < u8.length; i++) f[i] = u8[i]; return f; }

function cropToImageData(f, w, x0, y0, size) {
  const out = new ImageData(size, size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const s = ((y + y0) * w + (x + x0)) * 4, d = (y * size + x) * 4;
    out.data[d] = f[s]; out.data[d + 1] = f[s + 1]; out.data[d + 2] = f[s + 2]; out.data[d + 3] = 255;
  }
  return out;
}

/* ------------------------------------------------------------ AI model */
let ortPromise = null, sessionPromise = null, backend = null;

async function getSession() {
  if (sessionPromise) return sessionPromise;
  sessionPromise = (async () => {
    post({ type: 'status', text: 'Loading AI runtime…' });
    const ort = await import(`${ORT_BASE}ort.webgpu.min.mjs`);
    ort.env.wasm.wasmPaths = ORT_BASE;
    ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;
    ortPromise = ort;
    let model = null;
    for (const u of MODEL_URLS) {
      try {
        post({ type: 'status', text: 'Downloading AI model (5 MB, once)…' });
        const r = await fetch(u);
        if (r.ok) { model = new Uint8Array(await r.arrayBuffer()); break; }
      } catch { /* try next */ }
    }
    if (!model) throw new Error('Could not download the AI model');
    const providers = 'gpu' in navigator ? ['webgpu', 'wasm'] : ['wasm'];
    for (const p of providers) {
      try {
        const s = await ort.InferenceSession.create(model, { executionProviders: [p], graphOptimizationLevel: 'all' });
        backend = p;
        post({ type: 'status', text: `AI ready (${p === 'webgpu' ? 'GPU' : 'CPU, slower'})`, backend: p });
        return s;
      } catch { /* fall through */ }
    }
    throw new Error('No ONNX backend available');
  })();
  sessionPromise.catch((e) => { sessionPromise = null; post({ type: 'status', text: `AI unavailable: ${e.message}`, error: true }); });
  return sessionPromise;
}

/** 4× super-resolution of an RGBA u8 window. Returns float RGBA (w*4)×(h*4). */
async function superResolve(u8, w, h) {
  const session = await getSession();
  const ort = ortPromise;
  const plane = w * h;
  const input = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    input[i] = u8[i * 4] / 255; input[plane + i] = u8[i * 4 + 1] / 255; input[2 * plane + i] = u8[i * 4 + 2] / 255;
  }
  const feeds = { [session.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, h, w]) };
  const res = await session.run(feeds);
  const t = res[session.outputNames[0]];
  const data = t.getData ? await t.getData() : t.data;
  const W = w * 4, H = h * 4, P = W * H;
  const out = new Float32Array(P * 4);
  for (let i = 0; i < P; i++) {
    out[i * 4] = data[i] * 255; out[i * 4 + 1] = data[P + i] * 255; out[i * 4 + 2] = data[2 * P + i] * 255; out[i * 4 + 3] = 255;
  }
  t.dispose?.();
  return out;
}

/* ------------------------------------------------------------ jobs */
const queue = [];
const cancelled = new Set();
let busy = false;
let currentId = null;
const post = (m, transfer) => self.postMessage(m, transfer || []);

async function processTile(job) {
  const { template, z, x, y, nativeMax, mode } = job;
  const zs = Math.min(z, nativeMax);
  const d = z - zs;
  const s = 256 / 2 ** d; // source pixels covered by this tile
  if (s < 2) return null;
  const px = x * s, py = y * s;

  if (mode === 'plain') {
    if (d === 0) return fetchTile(template, z, x, y); // native pixels, untouched
    const r = await region(template, zs, px, py, s, s);
    if (!r) return null;
    return cropToImageData(resize(toFloat(r.data), s, s, OUT, OUT), OUT, 0, 0, OUT);
  }

  const useAi = mode === 'ai' && d >= 1;
  const m = MARGIN;
  const r = await region(template, zs, px - m, py - m, s + 2 * m, s + 2 * m);
  if (!r) return null;
  const f = OUT / s; // total magnification

  if (useAi) {
    let sr = await superResolve(r.data, r.w, r.h); // 4× with margin
    let sw = r.w * 4, scale = 4;
    if (f !== 4) { // finish to the exact size with Lanczos
      const tw = Math.round(r.w * f);
      sr = resize(sr, sw, sw, tw, tw);
      sw = tw; scale = f;
    }
    unsharp(sr, sw, sw, 0.8, 0.25);
    const off = Math.round(m * scale);
    return cropToImageData(sr, sw, off, off, OUT);
  }

  // sharpen: de-block -> Lanczos -> unsharp. Sharpening strength eases off at
  // high magnification, where it would mostly emphasise compression noise.
  const tw = Math.round(r.w * f);
  const clean = bilateral(toFloat(r.data), r.w, r.h, 2, 1.1, d === 0 ? 12 : 18);
  const up = resize(clean, r.w, r.h, tw, tw);
  const sigma = Math.max(0.8, Math.min(3, 0.5 * f));
  unsharp(up, tw, tw, sigma, d === 0 ? 0.7 : d === 1 ? 0.8 : 0.6, 2);
  const off = Math.round(m * f);
  return cropToImageData(up, tw, off, off, OUT);
}

async function pump() {
  if (busy) return;
  busy = true;
  while (queue.length) {
    const job = queue.pop(); // newest first: what the user is looking at now
    currentId = job.id;
    try {
      const img = await processTile(job);
      if (cancelled.delete(job.id)) continue;
      if (!img) { post({ type: 'tile', id: job.id, empty: true }); continue; }
      const bmp = await createImageBitmap(img);
      post({ type: 'tile', id: job.id, bitmap: bmp }, [bmp]);
    } catch (e) {
      post({ type: 'tile', id: job.id, error: e.message });
    }
    post({ type: 'queue', pending: queue.length });
  }
  currentId = null;
  cancelled.clear();
  busy = false;
}

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'tile') { queue.push(m); post({ type: 'queue', pending: queue.length }); pump(); }
  else if (m.type === 'cancel') {
    const i = queue.findIndex((j) => j.id === m.id);
    if (i >= 0) queue.splice(i, 1);
    else if (m.id === currentId) cancelled.add(m.id);
  } else if (m.type === 'warmup') getSession().catch(() => {});
};
