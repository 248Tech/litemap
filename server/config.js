import path from 'node:path';

export const ROOT = path.resolve(import.meta.dirname, '..');

const list = (v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);

export function loadConfig(env = process.env) {
  const token = env.MAPBOX_TOKEN || null;
  return {
    port: Number(env.PORT || 8787),
    host: env.HOST || '0.0.0.0',
    publicUrl: env.PUBLIC_URL || null,
    dataDir: path.resolve(ROOT, env.DATA_DIR || 'data'),
    publicDir: path.join(ROOT, 'public'),
    apiKeys: list(env.LITEMAP_API_KEYS || env.LITEMAP_API_KEY),
    corsOrigins: list(env.CORS_ORIGINS).length ? list(env.CORS_ORIGINS) : ['*'],
    mapbox: {
      // Public (pk.*) token: sent to browsers for map tiles and search.
      token,
      // Token for server-side geocoding/static images. Defaults to the public token;
      // set separately if the public token is URL-restricted.
      serverToken: env.MAPBOX_SERVER_TOKEN || token,
    },
    skyfi: {
      apiKey: env.SKYFI_API_KEY || null,
      baseUrl: (env.SKYFI_API_URL || 'https://app.skyfi.com/platform-api').replace(/\/$/, ''),
    },
  };
}
