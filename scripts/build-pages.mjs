#!/usr/bin/env node
/*
 * Builds the GitHub Pages site into _site/ (git-ignored; deployed by
 * .github/workflows/pages.yml):
 *
 *   _site/            the landing page (docs/)
 *   _site/app/        live demo of the map tool and the 3D Modeler: the real app,
 *                     with js/demo-api.js answering /api/v1 in the browser
 *                     (sites and models are kept in the visitor's localStorage)
 *   _site/modeler/    redirect to app/modeler.html (the old demo address)
 *
 * The Mapbox public token comes from the MAPBOX_TOKEN environment variable (a
 * repository secret in CI). Locally, `node scripts/build-pages.mjs --env` reads
 * it from .env. It is written only into _site/, never into the repository.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, '_site');
const APP = path.join(OUT, 'app');
const SITE = 'https://248tech.github.io/litemap';
const REPO = 'https://github.com/248Tech/litemap';

let token = process.env.MAPBOX_TOKEN || '';
if (!token && process.argv.includes('--env')) {
  const env = await fs.readFile(path.join(ROOT, '.env'), 'utf8').catch(() => '');
  token = env.match(/^MAPBOX_TOKEN=(.*)$/m)?.[1].trim().replace(/^["']|["']$/g, '') || '';
}
if (!token) console.warn('No MAPBOX_TOKEN: the demo map will show its setup screen.');
if (token && !token.startsWith('pk.')) throw new Error('MAPBOX_TOKEN must be a public (pk.) token: it is sent to every visitor.');

await fs.rm(OUT, { recursive: true, force: true });
await fs.cp(path.join(ROOT, 'docs'), OUT, { recursive: true, filter: (src) => !src.includes(`${path.sep}modeler`) });
await fs.cp(path.join(ROOT, 'public'), APP, { recursive: true, filter: (src) => !/docs\.html$/.test(src) });

/** Edit a copied file: every `from` must be found, so a refactor can't silently break the demo. */
async function edit(rel, pairs) {
  const file = path.join(APP, rel);
  let s = await fs.readFile(file, 'utf8');
  for (const [from, to] of pairs) {
    if (typeof from === 'string' ? !s.includes(from) : !from.test(s)) throw new Error(`${rel}: expected to find ${from}`);
    s = typeof from === 'string' ? s.split(from).join(to) : s.replace(from, to);
  }
  await fs.writeFile(file, s);
}

// the server's validation, for the in-browser API
let features = await fs.readFile(path.join(ROOT, 'server', 'features.js'), 'utf8');
features = features.replaceAll("'../public/js/", "'./")
  .replace("import { newId } from './store.js';", "const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(9)), (b) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'[b & 63]).join('');");
if (/from '\.\.\/|from 'node:|store\.js/.test(features)) throw new Error('server/features.js gained a server-only import; update build-pages.mjs');
await fs.writeFile(path.join(APP, 'js', 'server-features.js'), features);

// demo config and entry points: the in-browser API must be installed before the app starts
const styles = { hybrid: 'satellite-streets-v12', satellite: 'satellite-v9', streets: 'streets-v12', light: 'light-v11', city: 'standard' };
await fs.writeFile(path.join(APP, 'js', 'demo-config.js'), `globalThis.LITEMAP_DEMO = ${JSON.stringify({ mapboxToken: token, styles })};\n`);
for (const [entry, main] of [['demo-main.js', 'app.js'], ['demo-modeler.js', 'modeler.js']]) {
  await fs.writeFile(path.join(APP, 'js', entry), `import './demo-config.js';\nawait import('./demo-api.js');\nawait import('./${main}');\n`);
}

const banner = `<div class="demo-banner" role="note">Live demo · sites and models save in this browser only · <a href="${REPO}#quick-start" target="_blank" rel="noopener">Install LiteMap</a> for uploads, imagery dates, snapshots and the REST API <button type="button" aria-label="Dismiss" onclick="this.parentNode.remove()">✕</button></div><script>if (self !== top) document.querySelector('.demo-banner').remove(); // the landing page explains the demo</script>
  <style>.demo-banner{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:60;background:#0a84ffee;color:#fff;font:13px/1.4 system-ui,sans-serif;padding:7px 10px 7px 14px;border-radius:999px;box-shadow:0 4px 18px #0007;max-width:calc(100% - 32px);width:max-content;text-align:center}.demo-banner a{color:#fff;font-weight:600}.demo-banner button{background:none;border:0;color:#fff;cursor:pointer;font-size:13px;padding:0 0 0 8px}@media (max-width:700px){.demo-banner{bottom:72px;font-size:12px}}</style>`;
const meta = (title, desc, url) => `<title>${title}</title>
  <meta name="description" content="${desc}">
  <link rel="canonical" href="${url}">
  <meta property="og:type" content="website"><meta property="og:title" content="${title}"><meta property="og:description" content="${desc}">
  <meta property="og:url" content="${url}"><meta property="og:image" content="${SITE}/assets/social-card.jpg"><meta name="twitter:card" content="summary_large_image">`;

await edit('index.html', [
  [/<title>[^<]*<\/title>/, meta('LiteMap live demo: measure sites on satellite imagery', 'Try LiteMap in your browser: measure distances and areas on satellite imagery, place tents and equipment to scale, check what fits, and see tents in 3D.', `${SITE}/app/`)],
  [/<meta name="description"[^>]*>\s*/, ''],
  ['href="/css/', 'href="css/'],
  ['<script type="module" src="/js/app.js"></script>', '<script type="module" src="js/demo-main.js"></script>'],
  ['href="/modeler"', 'href="modeler.html"'],
  ['href="/docs"', `href="${REPO}#rest-api"`],
  [/<body([^>]*)>/, `<body$1>\n  ${banner}`],
]);
await edit('modeler.html', [
  [/<title>[^<]*<\/title>/, meta('3D Tent Modeler · LiteMap live demo', 'Free online 3D tent modeler: size, roof style, leg and peak heights, bays, sidewalls and fabric, with fabric, sidewall, leg and ballast quantities, .glb export, and Place on map.', `${SITE}/app/modeler.html`)],
  [/<meta name="description"[^>]*>\s*/, ''],
  [/href="\/css\//g, 'href="css/'],
  ['<script type="module" src="/js/modeler.js"></script>', '<script type="module" src="js/demo-modeler.js"></script>'],
  [/href="\/"/g, 'href="./"'],
  [/<body([^>]*)>/, `<body$1>\n  ${banner}`],
]);
await edit('js/app.js', [
  [/href="\/modeler"/g, 'href="modeler.html"'],
  [/location\.origin\}\/\?/g, 'location.origin}${location.pathname}?'],
]);
await edit('js/modeler.js', [['`/?model=', '`./?model=']]);

// the old demo address keeps working
await fs.mkdir(path.join(OUT, 'modeler'), { recursive: true });
await fs.writeFile(path.join(OUT, 'modeler', 'index.html'), `<!doctype html><meta charset="utf-8"><title>3D Tent Modeler · LiteMap</title>
<link rel="canonical" href="${SITE}/app/modeler.html"><meta http-equiv="refresh" content="0; url=../app/modeler.html">
<a href="../app/modeler.html">Open the 3D Tent Modeler</a>\n`);
console.log(`Built ${path.relative(ROOT, OUT)}${token ? '' : ' (no map token)'}`);
