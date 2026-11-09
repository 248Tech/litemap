# Security policy

## Supported versions

Security fixes are made for the latest release.

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Use GitHub's [private vulnerability reporting](https://github.com/248Tech/litemap/security/advisories/new) instead. Include steps to reproduce and the impact you expect. You'll get an acknowledgement within a few business days.

## Deployment checklist

- Set `LITEMAP_API_KEY` (and `CORS_ORIGINS`) before exposing the API to the internet.
- Serve LiteMap over HTTPS behind a reverse proxy.
- Use a **public** Mapbox token restricted to your domains. If server-side calls need it, put an unrestricted token in `MAPBOX_SERVER_TOKEN`; it is never sent to browsers.
- Keep `DATA_DIR` on persistent, backed-up storage.
