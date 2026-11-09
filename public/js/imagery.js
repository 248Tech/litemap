/*
 * Imagery catalog, shared by the UI and the API.
 *
 * Every source here allows direct browser use (CORS) and needs no key.
 * `captured` is an ISO date for sources flown on a known date; sources whose date
 * varies by location have a `metadata` lookup instead (see server/imagery.js).
 *
 * To add a county or state orthophoto service, append an entry with `bounds`
 * so it only shows up where it has coverage.
 */

const GIBS = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best';

export const IMAGERY_SOURCES = [
  {
    id: 'esri',
    name: 'Esri World Imagery',
    group: 'High resolution',
    provider: 'Esri · Vantor (Maxar), Airbus, local providers',
    resolution: '≈30–60 cm',
    type: 'xyz',
    url: 'https://services.arcgisonline.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    tileSize: 256,
    maxzoom: 19,
    metadata: { type: 'esri', url: 'https://services.arcgisonline.com/arcgis/rest/services/World_Imagery/MapServer' },
    attribution: 'Imagery © Esri, Vantor, Earthstar Geographics',
    notes: 'Refreshed several times a year; often newer than Mapbox. Capture date varies by location and is looked up automatically.',
  },
  {
    id: 'wayback',
    name: 'Esri Wayback (past releases)',
    group: 'High resolution',
    provider: 'Esri World Imagery archive',
    resolution: '≈30–60 cm',
    type: 'wayback',
    tileSize: 256,
    maxzoom: 19,
    configUrl: 'https://s3-us-west-2.amazonaws.com/config.maptiles.arcgis.com/waybackconfig.json',
    attribution: 'Imagery © Esri World Imagery Wayback',
    notes: 'Every published version of Esri World Imagery since 2014. Use it to see what a site looked like before.',
  },
  {
    id: 'naip',
    name: 'USDA NAIP',
    group: 'High resolution',
    provider: 'USDA Farm Service Agency',
    resolution: '60 cm',
    type: 'arcgis-image',
    url: 'https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer',
    bounds: [-125.0, 24.4, -66.9, 49.4],
    metadata: { type: 'arcgis-catalog', dateField: 'acquisition_date' },
    attribution: 'Imagery: USDA NAIP / USGS',
    notes: 'Statewide summer flights every 2–3 years (contiguous US).',
  },
  {
    id: 'mi-oakland-2025',
    name: 'Oakland County, MI · Spring 2025',
    group: 'Local aerial',
    provider: 'Oakland County, MI (Sanborn)',
    resolution: '7.6 cm (3 in)',
    captured: '2025-05-12',
    capturedLabel: 'Apr 27 – May 12, 2025',
    type: 'arcgis-image',
    url: 'https://gisservices.oakgov.com/arcgis/rest/services/ImageServices/EnterpriseOrthoTC2025ImageService/ImageServer',
    bounds: [-83.72, 42.327, -83.052, 42.995],
    attribution: 'Imagery: Oakland County, MI',
    notes: 'Leaf-off county flight at 3-inch resolution.',
  },
  {
    id: 'mi-oakland-2023',
    name: 'Oakland County, MI · Spring 2023',
    group: 'Local aerial',
    provider: 'Oakland County, MI (Sanborn)',
    resolution: '7.6 cm (3 in)',
    captured: '2023-05-01',
    capturedLabel: 'Spring 2023',
    type: 'arcgis-image',
    url: 'https://gisservices.oakgov.com/arcgis/rest/services/ImageServices/EnterpriseOrthoTC2023ImageService/ImageServer',
    bounds: [-83.72, 42.327, -83.052, 42.995],
    attribution: 'Imagery: Oakland County, MI',
  },
  {
    id: 'gibs-hls-s30',
    name: 'NASA GIBS · HLS Sentinel-2',
    group: 'NASA GIBS (daily, coarse)',
    provider: 'NASA / ESA Harmonized Landsat Sentinel-2',
    resolution: '30 m',
    type: 'xyz',
    dated: true,
    url: `${GIBS}/HLS_S30_Nadir_BRDF_Adjusted_Reflectance/default/{date}/GoogleMapsCompatible_Level12/{z}/{y}/{x}.png`,
    tileSize: 256,
    maxzoom: 12,
    attribution: 'Imagery: NASA GIBS / HLS',
    notes: 'Revisit every 2–3 days, but 30 m pixels: shows land clearing, large builds, flooding, and snow, not backyard detail. Days with no pass over the site are blank or cloudy.',
  },
  {
    id: 'gibs-hls-l30',
    name: 'NASA GIBS · HLS Landsat',
    group: 'NASA GIBS (daily, coarse)',
    provider: 'NASA / USGS Harmonized Landsat Sentinel-2',
    resolution: '30 m',
    type: 'xyz',
    dated: true,
    url: `${GIBS}/HLS_L30_Nadir_BRDF_Adjusted_Reflectance/default/{date}/GoogleMapsCompatible_Level12/{z}/{y}/{x}.png`,
    tileSize: 256,
    maxzoom: 12,
    attribution: 'Imagery: NASA GIBS / HLS',
  },
  {
    id: 'gibs-viirs',
    name: 'NASA GIBS · VIIRS daily',
    group: 'NASA GIBS (daily, coarse)',
    provider: 'NASA / NOAA Suomi NPP',
    resolution: '375 m',
    type: 'xyz',
    dated: true,
    url: `${GIBS}/VIIRS_SNPP_CorrectedReflectance_TrueColor/default/{date}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg`,
    tileSize: 256,
    maxzoom: 9,
    attribution: 'Imagery: NASA GIBS / VIIRS',
    notes: 'Whole-region daily view (weather, smoke, snow cover).',
  },
];

export const IMAGERY_BY_ID = Object.fromEntries(IMAGERY_SOURCES.map((s) => [s.id, s]));

/** Mapbox raster tile URL template(s) for a source. `opts.date` for GIBS, `opts.release` for Wayback. */
export function tileUrls(src, opts = {}) {
  switch (src.type) {
    case 'xyz':
      return [src.url.replace('{date}', opts.date || defaultGibsDate())];
    case 'wayback':
      if (!opts.release) return [];
      return [opts.release.itemURL.replace('{level}', '{z}').replace('{row}', '{y}').replace('{col}', '{x}')];
    case 'arcgis-image':
      return [`${src.url}/exportImage?bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857&size=512,512&format=jpgpng&transparent=true&f=image`];
    case 'arcgis-tile':
      return [`${src.url}/tile/{z}/{y}/{x}`];
    case 'arcgis-export':
      return [`${src.url}/export?bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857&size=512,512&format=png32&transparent=true&f=image`];
    default:
      return [];
  }
}

/** Raster tile size for a source (exportImage/export requests are 512 px). */
export const tileSizeOf = (src) => (src.type === 'arcgis-image' || src.type === 'arcgis-export' ? 512 : src.tileSize || 256);

/** GIBS products appear a few days after capture; default to 3 days ago (UTC). */
export function defaultGibsDate(now = new Date()) {
  return new Date(now.getTime() - 3 * 86400000).toISOString().slice(0, 10);
}

/** Classify a user-supplied URL into a custom source definition. */
export function customSource({ id, name, url, captured, resolution }) {
  const u = url.trim();
  let type;
  if (/\{z\}|\{bbox-epsg-3857\}|\{quadkey\}/.test(u)) type = 'xyz';
  else if (/\/ImageServer\/?$/i.test(u)) type = 'arcgis-image';
  else if (/\/MapServer\/?$/i.test(u)) type = 'arcgis-tile';
  else throw new Error('Use an XYZ template with {z}/{x}/{y}, or an ArcGIS …/ImageServer or …/MapServer URL.');
  return {
    id, name: name || 'Custom layer', group: 'Custom', provider: 'Custom', type,
    url: u.replace(/\/$/, ''), tileSize: type === 'xyz' && /512/.test(u) ? 512 : 256, maxzoom: 22,
    captured: captured || null, capturedLabel: captured || null, resolution: resolution || '', custom: true,
  };
}

export const coversPoint = (src, [lon, lat]) => !src.bounds || (lon >= src.bounds[0] && lon <= src.bounds[2] && lat >= src.bounds[1] && lat <= src.bounds[3]);
export const coversBox = (src, [w, s, e, n]) => !src.bounds || !(e < src.bounds[0] || w > src.bounds[2] || n < src.bounds[1] || s > src.bounds[3]);
