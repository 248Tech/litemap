/*
 * Mapbox integration: Geocoding API v6 and Static Images API.
 */
export const STYLES = {
  hybrid: 'satellite-streets-v12',
  satellite: 'satellite-v9',
  streets: 'streets-v12',
  light: 'light-v11',
};

const notConfigured = () => Object.assign(new Error('Mapbox is not configured. Set MAPBOX_TOKEN and restart.'), { status: 503, code: 'mapbox_not_configured' });
const upstream = (what, status) => Object.assign(new Error(`Mapbox ${what} failed (${status})`), { status: 502, code: 'mapbox_upstream' });

export async function geocode(mb, q, { language = 'en', country, proximity, limit = 5 } = {}) {
  if (!mb.serverToken) throw notConfigured();
  const u = new URL('https://api.mapbox.com/search/geocode/v6/forward');
  u.searchParams.set('q', q);
  u.searchParams.set('limit', String(limit));
  u.searchParams.set('language', language);
  if (country) u.searchParams.set('country', country);
  if (proximity) u.searchParams.set('proximity', proximity);
  u.searchParams.set('access_token', mb.serverToken);
  const res = await fetch(u);
  if (!res.ok) throw upstream('geocoding', res.status);
  const body = await res.json();
  return (body.features || []).map((f) => ({
    name: f.properties?.name ?? null,
    formattedAddress: f.properties?.full_address || f.properties?.place_formatted || f.properties?.name || '',
    coordinate: f.geometry.coordinates,
    bbox: f.properties?.bbox ?? null,
    countryCode: f.properties?.context?.country?.country_code?.toUpperCase() ?? null,
    featureType: f.properties?.feature_type ?? null,
  }));
}

/**
 * Static satellite image URL with the site's features drawn as a GeoJSON overlay
 * (simplestyle properties). Viewport is fitted automatically.
 */
export function staticImageUrl(mb, { features, center, zoom = 17, size = '600x400', retina = true, mapType = 'satellite' }) {
  if (!mb.serverToken) throw notConfigured();
  const style = STYLES[mapType] || STYLES.satellite;
  const [w, h] = size.split('x').map(Number);
  const dims = `${Math.min(w, 1280)}x${Math.min(h, 1280)}${retina ? '@2x' : ''}`;
  const build = (dp) => {
    const r = (c) => c.map((v) => (Array.isArray(v) ? r(v) : +v.toFixed(dp)));
    const fc = {
      type: 'FeatureCollection',
      features: features.map((f) => {
        const c = f.properties.color;
        const props = f.geometry.type === 'Point'
          ? { 'marker-color': c, 'marker-size': 'small' }
          : f.geometry.type === 'LineString'
            ? { stroke: c, 'stroke-width': f.properties.kind === 'drawing' ? Math.max(1, Math.round(f.properties.style?.width ?? 3)) : 3 }
            : { stroke: c, 'stroke-width': 2, fill: c, 'fill-opacity': f.properties.kind === 'reference' ? 0.4 : 0.2 };
        return { type: 'Feature', properties: props, geometry: { type: f.geometry.type, coordinates: r(f.geometry.coordinates) } };
      }),
    };
    const overlay = features.length ? `geojson(${encodeURIComponent(JSON.stringify(fc))})/` : '';
    const viewport = features.length ? 'auto' : `${center[0].toFixed(6)},${center[1].toFixed(6)},${zoom}`;
    return `https://api.mapbox.com/styles/v1/mapbox/${style}/static/${overlay}${viewport}/${dims}?padding=40&logo=false&access_token=${mb.serverToken}`;
  };
  for (const dp of [6, 5]) {
    const url = build(dp);
    if (url.length <= 8192) return url;
  }
  throw Object.assign(new Error('Site has too many vertices for a static image (URL exceeds 8 KB). Export GeoJSON instead.'), { status: 400, code: 'too_large' });
}
