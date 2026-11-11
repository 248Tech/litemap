#!/usr/bin/env node
/*
 * Builds the static 3D modeler demo for GitHub Pages: docs/modeler/.
 * The modeler is browser-only apart from saving/placing, which the page hides
 * in demo mode (<html data-demo>). Re-run after changing the modeler:
 *   node scripts/build-pages.mjs
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = path.join(ROOT, 'public');
const OUT = path.join(ROOT, 'docs', 'modeler');
const SITE = 'https://248tech.github.io/litemap';
const JS = ['modeler.js', 'references.js', 'tentspec.js', 'tent3d.js', 'modelfile.js'];
const CSS = ['app.css', 'modeler.css'];

await fs.rm(OUT, { recursive: true, force: true });
await fs.mkdir(path.join(OUT, 'js'), { recursive: true });
await fs.mkdir(path.join(OUT, 'css'), { recursive: true });

// every relative import in the copied modules must be copied too
for (const f of JS) {
  const src = await fs.readFile(path.join(SRC, 'js', f), 'utf8');
  for (const [, dep] of src.matchAll(/from\s+'\.\/([\w-]+\.js)'/g)) {
    if (!JS.includes(dep)) throw new Error(`${f} imports ${dep}, which the Pages build does not copy`);
  }
  await fs.writeFile(path.join(OUT, 'js', f), src);
}
for (const f of CSS) await fs.copyFile(path.join(SRC, 'css', f), path.join(OUT, 'css', f));

const title = '3D Tent Modeler · LiteMap';
const desc = 'Free online 3D tent modeler: set the size, roof style (pyramid, hip or gable), leg and peak heights, bay spacing, sidewalls and fabric, see roof fabric, sidewall, leg and ballast quantities, and export a .glb.';
let html = await fs.readFile(path.join(SRC, 'modeler.html'), 'utf8');
const swap = (a, b) => { if (!html.includes(a)) throw new Error(`modeler.html no longer contains ${a}`); html = html.split(a).join(b); };
swap('<html lang="en">', '<html lang="en" data-demo>');
swap('href="/css/', 'href="css/');
swap('src="/js/', 'src="js/');
swap('<a class="brand" href="/" title="Back to the map">', '<a class="brand" href="../" title="LiteMap home">');
swap('<a class="btn" href="/">← Map</a>', `<a class="btn" href="../#install">Get LiteMap</a>`);
html = html.replace(/<title>[^<]*<\/title>/, `<title>${title}</title>`)
  .replace(/<meta name="description"[^>]*>/, `<meta name="description" content="${desc}">
  <link rel="canonical" href="${SITE}/modeler/">
  <meta property="og:type" content="website">
  <meta property="og:title" content="${title}">
  <meta property="og:description" content="${desc}">
  <meta property="og:url" content="${SITE}/modeler/">
  <meta property="og:image" content="${SITE}/assets/social-card.jpg">
  <meta name="twitter:card" content="summary_large_image">`);
await fs.writeFile(path.join(OUT, 'index.html'), html);
console.log(`Built ${path.relative(ROOT, OUT)} (${JS.length} modules, ${CSS.length} stylesheets)`);
