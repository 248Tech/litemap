/*
 * "AI Imagine": re-render a block of map tiles from a text prompt.
 *
 *   1. the area is a block of whole Web Mercator tiles (public/js/tiles.js);
 *   2. its satellite picture is fetched from the Mapbox Static Images API;
 *   3. OpenAI's image-edit endpoint redraws it from the prompt;
 *   4. the caller stores the result as an uploaded object pinned to the area.
 *
 * Needs OPENAI_API_KEY. The picture of the area and the prompt are sent to
 * OpenAI, so this stays off unless a key is configured.
 */
import { HttpError } from './features.js';
import { tileArea, MAX_TILES } from '../public/js/tiles.js';

export const QUALITIES = ['low', 'medium', 'high'];
const PX = 1024; // gpt-image's square size
const bad = (msg) => { throw new HttpError(400, 'invalid_request', msg); };

/** Validate a request body into { area, prompt, quality }. */
export function parseImagine(body) {
  if (body == null || typeof body !== 'object' || Array.isArray(body)) bad('body must be a JSON object');
  const lon = Number(body.lon), lat = Number(body.lat), zoom = Number(body.zoom ?? 18), tiles = Number(body.tiles ?? 2);
  if (!(Math.abs(lon) <= 180) || !(Math.abs(lat) <= 85)) bad('lon and lat must be valid coordinates');
  if (!Number.isFinite(zoom)) bad('zoom must be a number');
  if (!Number.isInteger(tiles) || tiles < 1 || tiles > MAX_TILES) bad(`tiles must be a whole number from 1 to ${MAX_TILES} (tiles per side)`);
  const prompt = String(body.prompt ?? '').trim();
  if (prompt.length < 3) bad('prompt is required (at least 3 characters)');
  if (prompt.length > 1000) bad('prompt must be at most 1000 characters');
  const quality = body.quality == null ? 'medium' : String(body.quality);
  if (!QUALITIES.includes(quality)) bad(`quality must be one of ${QUALITIES.join(', ')}`);
  return { area: tileArea(lon, lat, zoom, tiles), prompt, quality };
}

/** Satellite picture of the area, as { data, type }. */
export async function fetchAreaImage(mb, area) {
  if (!mb.serverToken) throw Object.assign(new Error('Mapbox is not configured. Set MAPBOX_TOKEN and restart.'), { status: 503, code: 'mapbox_not_configured' });
  const url = `https://api.mapbox.com/styles/v1/mapbox/satellite-v9/static/[${area.bbox.map((v) => v.toFixed(7)).join(',')}]/${PX}x${PX}?logo=false&attribution=false&access_token=${mb.serverToken}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new HttpError(502, 'mapbox_upstream', `Mapbox static image failed (${res.status})`);
  const type = (res.headers.get('content-type') || '').split(';')[0] || 'image/jpeg';
  return { data: Buffer.from(await res.arrayBuffer()), type };
}

const wrap = (prompt) => `This is a straight-down (top-down) satellite photo of a place on the ground. `
  + `Edit it as described below. Keep the same camera angle, framing and scale, keep it looking like real aerial photography, `
  + `and leave everything the description does not mention unchanged.\n\nChange: ${prompt}`;

/** Redraw `image` from the prompt with OpenAI image edits; returns PNG bytes. */
export async function editImage(ai, image, { prompt, quality }) {
  const form = new FormData();
  form.append('model', ai.model);
  form.append('prompt', wrap(prompt));
  form.append('size', `${PX}x${PX}`);
  form.append('quality', quality);
  form.append('n', '1');
  form.append('image', new Blob([image.data], { type: image.type }), `area.${image.type === 'image/png' ? 'png' : 'jpg'}`);
  let res;
  try {
    res = await fetch(`${ai.baseUrl}/images/edits`, { method: 'POST', headers: { Authorization: `Bearer ${ai.apiKey}` }, body: form, signal: AbortSignal.timeout(300_000) });
  } catch (e) {
    throw new HttpError(504, 'ai_timeout', e.name === 'TimeoutError' ? 'The AI took too long to answer. Try again, or use fewer tiles or lower quality.' : `Could not reach the AI service: ${e.message}`);
  }
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new HttpError(502, 'ai_upstream', `AI service: ${json?.error?.message || `${res.status} ${res.statusText}`}`);
  const b64 = json?.data?.[0]?.b64_json;
  if (!b64) throw new HttpError(502, 'ai_upstream', 'The AI service returned no image.');
  return Buffer.from(b64, 'base64');
}
