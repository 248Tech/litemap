/* OpenAPI 3.1 description of the LiteMap API. Served at /openapi.json. */
export const API_VERSION = '1.1.0';

const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema) => ({ 'application/json': { schema } });
const ok = (description, schema) => ({ description, content: json(schema) });
const errors = (...codes) => Object.fromEntries(codes.map((c) => [String(c), { $ref: `#/components/responses/E${c}` }]));
const siteId = { name: 'siteId', in: 'path', required: true, schema: { type: 'string' } };
const featureId = { name: 'featureId', in: 'path', required: true, schema: { type: 'string' } };

const footprintParams = {
  templateId: { type: 'string', description: 'Reference catalog id (see GET /reference-objects). Supplies shape/width/length when omitted.', examples: ['tent-40x80'] },
  shape: { type: 'string', enum: ['rect', 'circle'], default: 'rect' },
  width: { type: 'number', description: 'Meters across (diameter for circles).', minimum: 0.01 },
  length: { type: 'number', description: 'Meters along the rotation axis. Ignored for circles.', minimum: 0.01 },
  clearance: { type: 'number', description: 'Setback in meters kept clear around the object on every side.', minimum: 0, default: 0 },
};

export function buildOpenApi(serverUrl) {
  return {
    openapi: '3.1.0',
    info: {
      title: 'LiteMap API',
      version: API_VERSION,
      summary: 'Remote site measurement on Mapbox satellite imagery.',
      description: [
        'Measure distances and areas, place to-scale reference objects (tents, vehicles, courts, custom shapes),',
        'test whether a footprint fits on a site, and count how many fit, without a site visit.',
        '',
        '**Conventions**',
        '- Coordinates are GeoJSON order: `[longitude, latitude]` (WGS84).',
        '- Lengths are meters, areas are square meters, rotations are degrees clockwise from true north (the direction of the object\'s *length* axis).',
        '- Metrics are always computed on the server (ellipsoidal distances, local-plane areas) and returned in `properties.metrics`.',
        '- Feature kinds: `distance` (LineString), `area` (Polygon), `marker` (Point), `reference` (to-scale object; geometry is generated from `properties.reference`), `text` (Point text box), `drawing` (freehand LineString).',
        '',
        '**Embedding**: the UI can be iframed at `/?embed=1&site={id}` and driven with `postMessage`. See the README.',
      ].join('\n'),
    },
    servers: [{ url: serverUrl || '/' }],
    security: [{ ApiKey: [] }, { Bearer: [] }],
    tags: [
      { name: 'Sites', description: 'Saved sites and their measurements.' },
      { name: 'Features', description: 'Individual measurements within a site.' },
      { name: 'Analysis', description: 'Stateless geometry tools.' },
      { name: 'Objects', description: 'Your own to-scale objects: cut-out images with a real-world size.' },
      { name: 'Models', description: '3D tent models made in the 3D Modeler (`/modeler`): saved as editable recipes, placed on sites as 3D-capable tent references, exported as .glb.' },
      { name: 'Mapbox', description: 'Map configuration, geocoding, and static satellite images.' },
      { name: 'Imagery', description: 'Alternate and newer imagery sources, capture dates, and SkyFi archive search.' },
      { name: 'System' },
    ],
    paths: {
      '/api/v1/health': {
        get: {
          tags: ['System'], operationId: 'getHealth', security: [], summary: 'Service health and configuration',
          responses: { 200: ok('OK', ref('Health')) },
        },
      },
      '/api/v1/map/config': {
        get: {
          tags: ['Mapbox'], operationId: 'getMapConfig', security: [], summary: 'Map client configuration',
          description: 'Public Mapbox access token and style ids used by the bundled UI. Use it to initialize your own Mapbox GL JS map.',
          responses: {
            200: ok('Config', {
              type: 'object',
              properties: {
                provider: { type: 'string', const: 'mapbox' },
                accessToken: { type: 'string', description: 'Public (pk.*) Mapbox token' },
                styles: { type: 'object', additionalProperties: { type: 'string' }, description: 'mapType -> Mapbox style id (mapbox://styles/mapbox/{id})' },
              },
            }),
            ...errors(503),
          },
        },
      },
      '/api/v1/geocode': {
        get: {
          tags: ['Mapbox'], operationId: 'geocode', summary: 'Geocode an address (Mapbox Geocoding v6)',
          parameters: [
            { name: 'q', in: 'query', required: true, schema: { type: 'string' }, example: '1200 W 55th St, Kansas City, MO' },
            { name: 'language', in: 'query', schema: { type: 'string', default: 'en' } },
            { name: 'country', in: 'query', schema: { type: 'string' }, description: 'Comma-separated ISO 3166 alpha-2 codes.' },
            { name: 'proximity', in: 'query', schema: { type: 'string' }, description: 'Bias results toward "lon,lat".' },
            { name: 'limit', in: 'query', schema: { type: 'integer', default: 5, maximum: 10 } },
          ],
          responses: { 200: ok('Results', { type: 'object', properties: { results: { type: 'array', items: ref('GeocodeResult') } } }), ...errors(400, 401, 502, 503) },
        },
      },
      '/api/v1/imagery/sources': {
        get: {
          tags: ['Imagery'], operationId: 'listImagerySources', security: [], summary: 'Imagery overlay catalog',
          description: 'Raster sources the UI can overlay on Mapbox (Esri World Imagery, Esri Wayback, USDA NAIP, county aerials, NASA GIBS). `skyfi` reports whether SkyFi search is configured.',
          responses: { 200: ok('Catalog', { type: 'object', properties: { skyfi: { type: 'boolean' }, items: { type: 'array', items: ref('ImagerySource') } } }) },
        },
      },
      '/api/v1/imagery/dates': {
        get: {
          tags: ['Imagery'], operationId: 'imageryDates', summary: 'Which imagery is newest at a location?',
          description: 'Looks up the capture date of every catalog source covering the point (Esri World Imagery metadata, NAIP catalog, county flight dates) and returns them newest first.',
          parameters: [
            { name: 'lon', in: 'query', schema: { type: 'number' } },
            { name: 'lat', in: 'query', schema: { type: 'number' } },
            { name: 'siteId', in: 'query', schema: { type: 'string' }, description: 'Use a saved site instead of lon/lat.' },
          ],
          responses: { 200: ok('Dates', ref('ImageryDates')), ...errors(400, 401, 404) },
        },
      },
      '/api/v1/imagery/skyfi/archives': {
        post: {
          tags: ['Imagery'], operationId: 'searchSkyfiArchives', summary: 'Search the SkyFi commercial archive',
          description: 'Proxies SkyFi `POST /archives` (requires SKYFI_API_KEY on the server). Returns scenes newest first, each with an estimated price for the AOI (the SkyFi minimum order area applies). Does not place orders.',
          requestBody: { required: true, content: json({ allOf: [ref('AreaSource'), {
            type: 'object',
            properties: {
              bbox: { type: 'array', items: { type: 'number' }, minItems: 4, maxItems: 4, description: '[west, south, east, north], alternative to polygon' },
              fromDate: { type: 'string', format: 'date', description: 'Default: 2 years ago' },
              toDate: { type: 'string', format: 'date', description: 'Default: now' },
              maxCloudCoveragePercent: { type: 'number' },
              maxOffNadirAngle: { type: 'number' },
              resolutions: { type: 'array', items: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH', 'VERY HIGH', 'SUPER HIGH', 'ULTRA HIGH', 'CM 30', 'CM 50'] } },
              providers: { type: 'array', items: { type: 'string' }, examples: [['VANTOR', 'PLANET', 'SATELLOGIC']] },
              productTypes: { type: 'array', items: { type: 'string' }, default: ['DAY'] },
              openData: { type: 'boolean' },
              limit: { type: 'integer', default: 50, maximum: 100 },
            },
          }] }) },
          responses: { 200: ok('Scenes', ref('SkyfiSearchResult')), ...errors(400, 401, 404, 502, 503) },
        },
      },
      '/api/v1/objects': {
        get: {
          tags: ['Objects'], operationId: 'listObjects', summary: 'List uploaded objects',
          responses: { 200: ok('Objects', { type: 'object', properties: { items: { type: 'array', items: ref('UploadedObject') } } }), ...errors(401) },
        },
        post: {
          tags: ['Objects'], operationId: 'uploadObject', summary: 'Upload a cut-out image as a to-scale object',
          description: 'Send the image bytes as the body (PNG/WebP with transparency recommended; the web UI isolates and crops the object first). `length` defaults to `width` × the image aspect ratio. Place it on a site as a `reference` feature with `reference.objectId`.',
          parameters: [
            { name: 'name', in: 'query', schema: { type: 'string', maxLength: 200 } },
            { name: 'width', in: 'query', required: true, schema: { type: 'number', minimum: 0.01 }, description: 'Meters (image left–right).' },
            { name: 'length', in: 'query', schema: { type: 'number', minimum: 0.01 }, description: 'Meters (image top–bottom).' },
          ],
          requestBody: { required: true, content: { 'image/png': { schema: { type: 'string', format: 'binary' } }, 'image/webp': { schema: { type: 'string', format: 'binary' } }, 'image/jpeg': { schema: { type: 'string', format: 'binary' } } } },
          responses: { 201: ok('Created', ref('UploadedObject')), 413: { description: 'Image larger than 8 MB' }, 415: { description: 'Not a PNG, WebP or JPEG' }, ...errors(400, 401) },
        },
      },
      '/api/v1/objects/{objectId}': {
        parameters: [{ name: 'objectId', in: 'path', required: true, schema: { type: 'string' } }],
        get: { tags: ['Objects'], operationId: 'getObject', summary: 'Get an uploaded object', responses: { 200: ok('Object', ref('UploadedObject')), ...errors(401, 404) } },
        patch: {
          tags: ['Objects'], operationId: 'updateObject', summary: 'Rename or change the default size',
          requestBody: { required: true, content: json({ type: 'object', properties: { name: { type: 'string' }, width: { type: 'number' }, length: { type: 'number' } } }) },
          responses: { 200: ok('Object', ref('UploadedObject')), ...errors(400, 401, 404) },
        },
        delete: { tags: ['Objects'], operationId: 'deleteObject', summary: 'Delete an uploaded object and its image', responses: { 204: { description: 'Deleted' }, ...errors(401, 404) } },
      },
      '/api/v1/objects/{objectId}/image': {
        get: {
          tags: ['Objects'], operationId: 'getObjectImage', security: [], summary: 'The object image (public, immutable)',
          parameters: [{ name: 'objectId', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'Image', content: { 'image/png': {}, 'image/webp': {}, 'image/jpeg': {} } }, ...errors(404) },
        },
      },
      '/api/v1/models': {
        get: {
          tags: ['Models'], operationId: 'listModels', summary: 'List saved 3D models',
          responses: { 200: ok('Models', { type: 'object', properties: { items: { type: 'array', items: ref('Model') } } }), ...errors(401) },
        },
        post: {
          tags: ['Models'], operationId: 'createModel', summary: 'Save a 3D model',
          description: 'Send the fields below, or a `litemap-model` document exported from the 3D Modeler. To use it on a site, create a `reference` feature with `templateId` `tent-custom` (or the stock `tent-WxL` id), the model\'s `width`, `length` and `tent`, and `properties.color` set to the model\'s `color`. It then shows in 3D on the map like any tent.',
          requestBody: { required: true, content: json(ref('ModelInput')) },
          responses: { 201: ok('Created', ref('Model')), ...errors(400, 401) },
        },
      },
      '/api/v1/models/{modelId}': {
        parameters: [{ name: 'modelId', in: 'path', required: true, schema: { type: 'string' } }],
        get: { tags: ['Models'], operationId: 'getModel', summary: 'Get a 3D model', responses: { 200: ok('Model', ref('Model')), ...errors(401, 404) } },
        patch: {
          tags: ['Models'], operationId: 'updateModel', summary: 'Change a 3D model',
          requestBody: { required: true, content: json(ref('ModelInput')) },
          responses: { 200: ok('Model', ref('Model')), ...errors(400, 401, 404) },
        },
        delete: { tags: ['Models'], operationId: 'deleteModel', summary: 'Delete a 3D model (placed copies keep working)', responses: { 204: { description: 'Deleted' }, ...errors(401, 404) } },
      },
      '/api/v1/models/{modelId}/glb': {
        get: {
          tags: ['Models'], operationId: 'getModelGlb', summary: 'Export the model as a glTF binary (.glb)',
          description: 'Metres, +Y up, ground at y = 0, footprint centred on the origin, front facing +Z. The recipe is embedded in `asset.extras.litemap`, so the 3D Modeler can import the file again.',
          parameters: [{ name: 'modelId', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'glTF 2.0 binary', content: { 'model/gltf-binary': { schema: { type: 'string', format: 'binary' } } } }, ...errors(401, 404) },
        },
      },
      '/api/v1/reference-objects': {
        get: {
          tags: ['Analysis'], operationId: 'listReferenceObjects', security: [], summary: 'Catalog of to-scale reference objects',
          responses: { 200: ok('Catalog', { type: 'object', properties: { items: { type: 'array', items: ref('ReferenceObject') } } }) },
        },
      },
      '/api/v1/measure': {
        post: {
          tags: ['Analysis'], operationId: 'measure', summary: 'Measure arbitrary GeoJSON',
          description: 'Accepts a Geometry, a Feature, or a FeatureCollection and returns metrics for each item plus totals.',
          requestBody: { required: true, content: json({ oneOf: [ref('Geometry'), ref('FeatureInput'), ref('FeatureCollectionInput')] }) },
          responses: { 200: ok('Metrics', ref('MeasureResponse')), ...errors(400, 401) },
        },
      },
      '/api/v1/footprint': {
        post: {
          tags: ['Analysis'], operationId: 'footprint', summary: 'Generate a to-scale reference object footprint',
          requestBody: { required: true, content: json(ref('FootprintRequest')) },
          responses: { 200: ok('A reference Feature', ref('Feature')), ...errors(400, 401) },
        },
      },
      '/api/v1/fit': {
        post: {
          tags: ['Analysis'], operationId: 'fit', summary: 'Will it fit? Place an object inside an area',
          description: 'Searches positions and rotations for a placement of the object (plus clearance) fully inside the polygon, maximizing the margin to the boundary. Set `findLargest` to also get the largest uniform scale that fits.',
          requestBody: { required: true, content: json(ref('FitRequest')) },
          responses: { 200: ok('Fit result', ref('FitResult')), ...errors(400, 401, 404) },
        },
      },
      '/api/v1/pack': {
        post: {
          tags: ['Analysis'], operationId: 'pack', summary: 'How many fit? Tile copies of an object into an area',
          description: 'Grid-packs copies (e.g. parking stalls, tables, tents) aligned with the area\'s dominant edges. Clearance is kept around each copy.',
          requestBody: { required: true, content: json(ref('PackRequest')) },
          responses: { 200: ok('Pack result', ref('PackResult')), ...errors(400, 401, 404) },
        },
      },
      '/api/v1/sites': {
        get: {
          tags: ['Sites'], operationId: 'listSites', summary: 'List sites',
          parameters: [
            { name: 'q', in: 'query', schema: { type: 'string' }, description: 'Case-insensitive match on name, description, and tags.' },
            { name: 'tag', in: 'query', schema: { type: 'string' } },
            { name: 'limit', in: 'query', schema: { type: 'integer', default: 50, maximum: 500 } },
            { name: 'offset', in: 'query', schema: { type: 'integer', default: 0 } },
          ],
          responses: { 200: ok('Sites (without features)', ref('SiteList')), ...errors(401) },
        },
        post: {
          tags: ['Sites'], operationId: 'createSite', summary: 'Create a site',
          description: 'If `address` is given and no `view`, the address is geocoded with Mapbox to set the initial view.',
          requestBody: { required: true, content: json(ref('SiteInput')) },
          responses: { 201: ok('Created', ref('Site')), ...errors(400, 401) },
        },
      },
      '/api/v1/sites/{siteId}': {
        parameters: [siteId],
        get: { tags: ['Sites'], operationId: 'getSite', summary: 'Get a site with all features', responses: { 200: ok('Site', ref('Site')), ...errors(401, 404) } },
        put: {
          tags: ['Sites'], operationId: 'replaceSite', summary: 'Replace a site',
          requestBody: { required: true, content: json(ref('SiteInput')) },
          responses: { 200: ok('Site', ref('Site')), ...errors(400, 401, 404) },
        },
        patch: {
          tags: ['Sites'], operationId: 'updateSite', summary: 'Partially update a site (only provided fields change)',
          requestBody: { required: true, content: json(ref('SiteInput')) },
          responses: { 200: ok('Site', ref('Site')), ...errors(400, 401, 404) },
        },
        delete: { tags: ['Sites'], operationId: 'deleteSite', summary: 'Delete a site', responses: { 204: { description: 'Deleted' }, ...errors(401, 404) } },
      },
      '/api/v1/sites/{siteId}/features': {
        parameters: [siteId],
        get: { tags: ['Features'], operationId: 'listFeatures', summary: 'Features as GeoJSON', responses: { 200: ok('FeatureCollection', ref('FeatureCollection')), ...errors(401, 404) } },
        post: {
          tags: ['Features'], operationId: 'addFeature', summary: 'Add a measurement or reference object',
          requestBody: { required: true, content: json(ref('FeatureInput')) },
          responses: { 201: ok('Created', ref('Feature')), ...errors(400, 401, 404) },
        },
      },
      '/api/v1/sites/{siteId}/features/{featureId}': {
        parameters: [siteId, featureId],
        get: { tags: ['Features'], operationId: 'getFeature', summary: 'Get one feature', responses: { 200: ok('Feature', ref('Feature')), ...errors(401, 404) } },
        put: {
          tags: ['Features'], operationId: 'replaceFeature', summary: 'Replace a feature',
          requestBody: { required: true, content: json(ref('FeatureInput')) },
          responses: { 200: ok('Feature', ref('Feature')), ...errors(400, 401, 404) },
        },
        delete: { tags: ['Features'], operationId: 'deleteFeature', summary: 'Delete a feature', responses: { 204: { description: 'Deleted' }, ...errors(401, 404) } },
      },
      '/api/v1/sites/{siteId}/geojson': {
        parameters: [siteId],
        get: {
          tags: ['Sites'], operationId: 'exportGeoJson', summary: 'Download the site as a GeoJSON file',
          responses: { 200: { description: 'GeoJSON', content: { 'application/geo+json': { schema: ref('FeatureCollection') } } }, ...errors(401, 404) },
        },
      },
      '/api/v1/sites/{siteId}/snapshot': {
        parameters: [siteId],
        get: {
          tags: ['Mapbox'], operationId: 'siteSnapshot', summary: 'Static satellite image of the site with measurements drawn',
          description: 'Returns a Mapbox Static Images URL (viewport fitted to the features), or redirects to it with `format=redirect`. Handy for reports, emails, and CRM records.',
          parameters: [
            { name: 'size', in: 'query', schema: { type: 'string', default: '600x400', pattern: '^\\d{2,4}x\\d{2,4}$' }, description: 'Max 1280x1280.' },
            { name: 'retina', in: 'query', schema: { type: 'boolean', default: true } },
            { name: 'mapType', in: 'query', schema: { type: 'string', enum: ['satellite', 'hybrid', 'streets', 'light'], default: 'satellite' } },
            { name: 'format', in: 'query', schema: { type: 'string', enum: ['json', 'redirect'], default: 'json' } },
          ],
          responses: {
            200: ok('Snapshot URL', { type: 'object', properties: { url: { type: 'string', format: 'uri' } } }),
            302: { description: 'Redirect to the image' },
            ...errors(401, 404, 503),
          },
        },
      },
    },
    components: {
      securitySchemes: {
        ApiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key', description: 'Required only when the server sets LITEMAP_API_KEY(S).' },
        Bearer: { type: 'http', scheme: 'bearer', description: 'Alternative to X-API-Key: `Authorization: Bearer <key>`.' },
      },
      responses: Object.fromEntries([400, 401, 404, 502, 503].map((c) => [`E${c}`, {
        description: { 400: 'Invalid request', 401: 'Missing or invalid API key', 404: 'Not found', 502: 'Mapbox upstream error', 503: 'Mapbox token not configured' }[c],
        content: json(ref('Error')),
      }])),
      schemas: {
        Error: {
          type: 'object', required: ['error'],
          properties: { error: { type: 'object', required: ['code', 'message'], properties: { code: { type: 'string' }, message: { type: 'string' }, details: {} } } },
        },
        Health: {
          type: 'object',
          properties: {
            status: { type: 'string', const: 'ok' }, version: { type: 'string' },
            mapbox: { type: 'boolean', description: 'Mapbox token configured (map, geocoding, snapshots)' },
            skyfi: { type: 'boolean', description: 'SkyFi archive search configured' },
            authRequired: { type: 'boolean' },
          },
        },
        LonLat: { type: 'array', prefixItems: [{ type: 'number', minimum: -180, maximum: 180 }, { type: 'number', minimum: -90, maximum: 90 }], minItems: 2, maxItems: 3, description: '[longitude, latitude]' },
        Point: { type: 'object', required: ['type', 'coordinates'], properties: { type: { const: 'Point' }, coordinates: ref('LonLat') } },
        LineString: { type: 'object', required: ['type', 'coordinates'], properties: { type: { const: 'LineString' }, coordinates: { type: 'array', minItems: 2, items: ref('LonLat') } } },
        Polygon: {
          type: 'object', required: ['type', 'coordinates'],
          properties: { type: { const: 'Polygon' }, coordinates: { type: 'array', minItems: 1, items: { type: 'array', minItems: 3, items: ref('LonLat') }, description: 'Outer ring then holes. Rings are auto-closed.' } },
        },
        Geometry: { oneOf: [ref('Point'), ref('LineString'), ref('Polygon')], discriminator: { propertyName: 'type' } },
        Metrics: {
          type: 'object',
          properties: {
            lengthM: { type: 'number' }, areaM2: { type: 'number' }, perimeterM: { type: 'number' },
            segmentsM: { type: 'array', items: { type: 'number' }, description: 'Length of each edge, in order.' },
            vertices: { type: 'integer' },
          },
        },
        ReferenceParams: {
          type: 'object', required: ['center'],
          properties: {
            ...footprintParams,
            center: ref('LonLat'),
            rotation: { type: 'number', default: 0, description: 'Bearing of the length axis, degrees clockwise from north.' },
            objectId: { type: 'string', description: 'Uploaded object (see /objects) drawn as an image on the footprint. The image top edge faces `rotation`; width is left–right, length is top–bottom. Requires shape `rect`.' },
            opacity: { type: 'number', minimum: 0.05, maximum: 1, default: 1, description: 'Image opacity (uploaded objects only).' },
            lockAspect: { type: 'boolean', default: true, description: 'UI hint: corner drags keep the image proportions (uploaded objects only).' },
            tent: {
              type: 'object',
              description: 'Tent builder settings (tent templates `tent-*` only, including `tent-custom` for any size). Omitted fields use defaults for the size: tents up to 20 ft wide get pyramid or hip roofs and 8 ft legs; wider ones get gable roofs with 10–14 ft legs. Bays are 10 ft, or 5 m from 10 m (33 ft) wide. Drives the top-down skin and the 3D view.',
              properties: {
                roof: { type: 'string', enum: ['auto', 'pyramid', 'hip', 'gable'] },
                eave: { type: 'number', minimum: 1.5, maximum: 8, description: 'Leg (eave) height in meters.' },
                peak: { type: 'number', minimum: 2, maximum: 25, description: 'Ridge or peak height in meters; must be above `eave`.' },
                bay: { type: 'number', minimum: 1, maximum: 12, description: 'Leg spacing along the walls in meters.' },
                walls: {
                  type: 'object', description: 'Sidewall per side. Front is the end facing `rotation`.',
                  properties: Object.fromEntries(['front', 'back', 'left', 'right'].map((s) => [s, { type: 'string', enum: ['none', 'solid', 'window', 'clear'] }])),
                  additionalProperties: false,
                },
              },
              additionalProperties: false,
            },
          },
        },
        UploadedObject: {
          type: 'object',
          properties: {
            id: { type: 'string' }, name: { type: 'string' },
            width: { type: 'number', description: 'Default real-world width in meters (image left–right).' },
            length: { type: 'number', description: 'Default real-world length in meters (image top–bottom).' },
            format: { type: 'string', enum: ['png', 'webp', 'jpg'] }, contentType: { type: 'string' },
            pixelWidth: { type: ['integer', 'null'] }, pixelHeight: { type: ['integer', 'null'] }, bytes: { type: 'integer' },
            imageUrl: { type: 'string', format: 'uri', description: 'Public, immutable image URL.' },
            createdAt: { type: 'string', format: 'date-time' }, updatedAt: { type: 'string', format: 'date-time' },
          },
        },
        ModelInput: {
          type: 'object',
          properties: {
            name: { type: 'string', maxLength: 200 },
            width: { type: 'number', minimum: 1, maximum: 200, description: 'Meters across.' },
            length: { type: 'number', minimum: 1, maximum: 400, description: 'Meters along.' },
            color: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$', default: '#f6f6f3', description: 'Fabric colour.' },
            ballast: { type: 'boolean', default: true, description: 'Show a ballast plate with two concrete blocks at every leg.' },
            tent: { type: 'object', description: 'Same object as `reference.tent` (roof, eave, peak, bay, walls). Omitted fields use defaults for the size.' },
          },
          required: ['width', 'length'],
        },
        Model: {
          type: 'object',
          allOf: [ref('ModelInput'), {
            type: 'object',
            properties: {
              id: { type: 'string' }, format: { const: 'litemap-model' }, version: { const: 1 }, kind: { const: 'tent' },
              glbUrl: { type: 'string', format: 'uri', description: 'Authenticated .glb download.' },
              createdAt: { type: 'string', format: 'date-time' }, updatedAt: { type: 'string', format: 'date-time' },
            },
          }],
        },
        FeatureProperties: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['distance', 'area', 'marker', 'reference', 'text', 'drawing'], description: 'Inferred from geometry when omitted (a Point with `text` is a text box).' },
            text: { type: 'string', maxLength: 1000, description: 'Text box content (kind `text`, Point geometry). Newlines allowed.' },
            style: { type: 'object', description: 'Text: `{ size: 8–72 px, box: boolean }`. Drawing: `{ width: 0.5–40 px }`.', properties: { size: { type: 'number' }, box: { type: 'boolean' }, width: { type: 'number' } } },
            name: { type: 'string', maxLength: 200 },
            color: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' },
            notes: { type: 'string', maxLength: 5000 },
            showLabel: { type: 'boolean', default: true, description: 'Set `false` to hide the map label of this feature even when labels are on. Omitted when true.' },
            showMeasurements: { type: 'boolean', default: false, description: 'Set `true` to keep side lengths (areas, distances, rectangular objects), the diameter (circles) or the path length (drawings) on the map even when the feature is not selected. Omitted when false.' },
            reference: ref('ReferenceParams'),
            data: { type: 'object', description: 'Free-form integration data (<= 16 KB), stored and returned unchanged.' },
          },
        },
        FeatureInput: {
          type: 'object', required: ['type'],
          description: 'A GeoJSON Feature. For `reference` features geometry may be omitted or a Point (used as center).',
          properties: { type: { const: 'Feature' }, id: { type: 'string', pattern: '^[\\w.-]{1,64}$' }, geometry: ref('Geometry'), properties: ref('FeatureProperties') },
        },
        Feature: {
          type: 'object', required: ['type', 'id', 'geometry', 'properties'],
          properties: {
            type: { const: 'Feature' }, id: { type: 'string' }, geometry: ref('Geometry'),
            properties: { allOf: [ref('FeatureProperties'), { type: 'object', required: ['kind', 'name', 'color', 'metrics'], properties: { metrics: ref('Metrics') } }] },
          },
        },
        FeatureCollectionInput: { type: 'object', required: ['type', 'features'], properties: { type: { const: 'FeatureCollection' }, features: { type: 'array', items: ref('FeatureInput') } } },
        FeatureCollection: { type: 'object', required: ['type', 'features'], properties: { type: { const: 'FeatureCollection' }, features: { type: 'array', items: ref('Feature') } } },
        View: {
          type: 'object', required: ['center'],
          properties: {
            center: ref('LonLat'),
            zoom: { type: 'number', minimum: 0, maximum: 24 },
            bearing: { type: 'number', description: 'Map rotation, degrees clockwise from north.' },
            mapType: { type: 'string', enum: ['hybrid', 'satellite', 'streets', 'light'] },
          },
        },
        SiteInput: {
          type: 'object',
          properties: {
            name: { type: 'string', maxLength: 200 },
            description: { type: 'string', maxLength: 5000 },
            tags: { type: 'array', items: { type: 'string' } },
            metadata: { type: 'object', description: 'Free-form integration data (<= 16 KB), e.g. CRM/order ids.' },
            units: { type: 'string', enum: ['imperial', 'metric'] },
            view: { oneOf: [ref('View'), { type: 'null' }] },
            address: { type: 'string', maxLength: 300, description: 'Street address shown with the site. A non-empty value is kept as typed (on create without `view` it is also geocoded to set the view). An empty string switches back to an automatic address, looked up from the site location on save. Omit it to leave the address unchanged.' },
            features: { oneOf: [ref('FeatureCollectionInput'), { type: 'array', items: ref('FeatureInput') }] },
          },
        },
        SiteSummaryStats: {
          type: 'object',
          properties: {
            featureCount: { type: 'integer' },
            counts: { type: 'object', additionalProperties: { type: 'integer' } },
            totalAreaM2: { type: 'number', description: 'Sum over `area` features.' },
            totalLengthM: { type: 'number', description: 'Sum over `distance` features.' },
          },
        },
        SiteSummary: {
          type: 'object', required: ['id', 'name', 'createdAt', 'updatedAt'],
          properties: {
            id: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' },
            address: { type: 'string', description: 'Street address of the site; empty until one is typed in or found.' },
            addressAuto: { type: 'boolean', description: '`true` when the address was looked up from the site location (it follows the site if it moves); `false` when it was typed in.' },
            tags: { type: 'array', items: { type: 'string' } }, metadata: { type: 'object' },
            units: { type: 'string', enum: ['imperial', 'metric'] }, view: { oneOf: [ref('View'), { type: 'null' }] },
            createdAt: { type: 'string', format: 'date-time' }, updatedAt: { type: 'string', format: 'date-time' },
            summary: ref('SiteSummaryStats'),
            url: { type: 'string', description: 'Link to open the site in the LiteMap UI.' },
            embedUrl: { type: 'string', description: 'Link for an iframe embed.' },
          },
        },
        Site: { allOf: [ref('SiteSummary'), { type: 'object', properties: { features: ref('FeatureCollection') } }] },
        SiteList: { type: 'object', properties: { items: { type: 'array', items: ref('SiteSummary') }, total: { type: 'integer' } } },
        ReferenceObject: {
          type: 'object',
          properties: {
            id: { type: 'string' }, category: { type: 'string' }, name: { type: 'string' },
            shape: { type: 'string', enum: ['rect', 'circle'] }, width: { type: 'number' }, length: { type: 'number' }, color: { type: 'string' },
          },
        },
        MeasureResponse: {
          type: 'object',
          properties: {
            items: { type: 'array', items: { type: 'object', properties: { id: { type: ['string', 'null'] }, geometryType: { type: 'string' }, metrics: ref('Metrics') } } },
            totals: { type: 'object', properties: { lengthM: { type: 'number' }, areaM2: { type: 'number' }, perimeterM: { type: 'number' } } },
          },
        },
        FootprintRequest: {
          type: 'object', required: ['center'],
          properties: { ...footprintParams, center: ref('LonLat'), rotation: { type: 'number', default: 0 }, name: { type: 'string' } },
        },
        AreaSource: {
          type: 'object',
          description: 'Provide either `polygon`, or `siteId` + `featureId` of an `area` feature.',
          properties: { polygon: ref('Polygon'), siteId: { type: 'string' }, featureId: { type: 'string' } },
        },
        FitRequest: {
          allOf: [ref('AreaSource'), {
            type: 'object',
            properties: {
              ...footprintParams,
              allowRotation: { type: 'boolean', default: true },
              rotation: { type: 'number', description: 'Fixed rotation when allowRotation=false.' },
              findLargest: { type: 'boolean', default: false },
            },
          }],
        },
        FitResult: {
          type: 'object',
          properties: {
            fits: { type: 'boolean' },
            center: ref('LonLat'),
            rotation: { type: 'number' },
            slackM: { type: 'number', description: 'Smallest gap between the object (incl. clearance) and the area boundary.' },
            footprint: ref('Polygon'),
            clearanceFootprint: { oneOf: [ref('Polygon'), { type: 'null' }] },
            largest: {
              type: 'object',
              properties: { fits: { type: 'boolean' }, scale: { type: 'number' }, width: { type: 'number' }, length: { type: 'number' }, center: ref('LonLat'), rotation: { type: 'number' } },
            },
          },
        },
        PackRequest: {
          allOf: [ref('AreaSource'), {
            type: 'object',
            properties: { ...footprintParams, rotation: { type: 'number', description: 'Force a grid rotation; otherwise edge-aligned rotations are tried.' }, includeFootprints: { type: 'boolean', default: false } },
          }],
        },
        PackResult: {
          type: 'object',
          properties: {
            count: { type: 'integer' }, rotation: { type: 'number' },
            centers: { type: 'array', items: ref('LonLat') },
            footprints: { type: 'array', items: ref('Polygon') },
          },
        },
        ImagerySource: {
          type: 'object',
          properties: {
            id: { type: 'string' }, name: { type: 'string' }, group: { type: 'string' }, provider: { type: 'string' }, resolution: { type: 'string' },
            type: { type: 'string', enum: ['xyz', 'wayback', 'arcgis-image', 'arcgis-tile', 'arcgis-export'] },
            url: { type: 'string', description: 'Tile template or ArcGIS service URL. `{date}` is a YYYY-MM-DD placeholder for daily NASA GIBS layers.' },
            captured: { type: 'string', format: 'date', description: 'Flight date for single-date sources' },
            bounds: { type: 'array', items: { type: 'number' }, description: '[west, south, east, north] coverage' },
            maxzoom: { type: 'integer' }, dated: { type: 'boolean' }, notes: { type: 'string' }, attribution: { type: 'string' },
          },
        },
        ImageryDates: {
          type: 'object',
          properties: {
            point: ref('LonLat'),
            newest: { type: ['string', 'null'], description: 'sourceId of the newest capture' },
            results: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  sourceId: { type: 'string' }, name: { type: 'string' }, captured: { type: ['string', 'null'], format: 'date' },
                  capturedLabel: { type: 'string' }, resolution: { type: 'string' }, provider: { type: 'string' }, note: { type: 'string' }, error: { type: 'string' },
                },
              },
            },
          },
        },
        SkyfiScene: {
          type: 'object',
          properties: {
            archiveId: { type: 'string' }, provider: { type: 'string' }, constellation: { type: 'string' }, productType: { type: 'string' },
            captured: { type: 'string', format: 'date-time' }, resolution: { type: 'string' }, resolutionCm: { type: ['number', 'null'] },
            cloudCoveragePercent: { type: ['number', 'null'] }, offNadirAngle: { type: ['number', 'null'] },
            footprint: { description: 'GeoJSON Polygon or MultiPolygon' },
            openData: { type: 'boolean' }, fullSceneOnly: { type: 'boolean' }, minSqKm: { type: 'number' },
            pricePerSqKmUsd: { type: 'number' }, priceFullSceneUsd: { type: 'number' },
            estimatedPriceUsd: { type: 'number', description: 'Price for this AOI, applying the minimum order area' }, billableSqKm: { type: 'number' },
            deliveryTimeHours: { type: ['number', 'null'] }, thumbnailUrls: { type: 'object' }, tilesUrl: { type: ['string', 'null'] },
          },
        },
        SkyfiSearchResult: {
          type: 'object',
          properties: { aoiSqKm: { type: 'number' }, count: { type: 'integer' }, nextPage: { type: ['string', 'null'] }, items: { type: 'array', items: ref('SkyfiScene') } },
        },
        GeocodeResult: {
          type: 'object',
          properties: {
            name: { type: ['string', 'null'] }, formattedAddress: { type: 'string' }, coordinate: ref('LonLat'),
            bbox: { type: ['array', 'null'], items: { type: 'number' }, description: '[west, south, east, north]' },
            countryCode: { type: ['string', 'null'] },
            featureType: { type: ['string', 'null'], description: 'address, street, place, postcode, ...' },
          },
        },
      },
    },
  };
}
