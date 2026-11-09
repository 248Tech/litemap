# Contributing to LiteMap

Thanks for helping out. LiteMap deliberately stays small and dependency-free, so please keep that in mind when proposing changes.

## Development

```bash
git clone https://github.com/248Tech/litemap.git
cd litemap
cp .env.example .env     # add a Mapbox public token
npm run dev              # restarts the server on change → http://localhost:8787
npm test                 # node:test suites (geodesy, API, imagery, objects)
```

No build step: edit files in `public/` and reload the browser.

## Guidelines

- **No new runtime dependencies.** Use the Node standard library on the server and plain ES modules in the browser. Large optional assets, such as AI runtimes, load lazily from a CDN.
- **Shared math lives in `public/js/geo.js`.** The browser and the API both use it, so the numbers always match. Add tests in `test/geo.test.js` for any geometry change.
- **API changes** must update `server/openapi.js` and add or extend a test in `test/api.test.js`.
- Keep the UI keyboard-friendly, and keep measurements the most legible thing on the map.
- Match the existing style: 2-space indent, semicolons, single quotes, small functions.

## Pull requests

1. Fork the repo and create a branch from `main`.
2. Make your change and run `npm test`.
3. Describe what changed and why. Include a screenshot for UI changes.

## Reporting bugs

Open an issue with steps to reproduce, the expected and actual behaviour, your browser and OS, and the badge text in the top-left of the map if the problem involves imagery. **Never paste your Mapbox token or API keys into an issue.**
