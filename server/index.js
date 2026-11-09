import { loadConfig } from './config.js';
import { createApp } from './app.js';

const cfg = loadConfig();
const { server } = await createApp(cfg);

server.listen(cfg.port, cfg.host, () => {
  const url = `http://localhost:${cfg.port}`;
  const mk = cfg.mapbox.token ? 'token configured' : 'NOT CONFIGURED (set MAPBOX_TOKEN, see .env.example)';
  console.log(`LiteMap running at ${url}`);
  console.log(`  API docs:  ${url}/docs   OpenAPI: ${url}/openapi.json`);
  console.log(`  Mapbox:    ${mk}`);
  console.log(`  API auth:  ${cfg.apiKeys.length ? `${cfg.apiKeys.length} key(s) required` : 'open (set LITEMAP_API_KEY to require a key)'}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)));
