# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [1.0.0] - 2026-11-09

First public release.

### Measuring and layout
- Distance and area tools with per-segment labels, running totals, vertex snapping and undo.
- To-scale reference catalog: tents from 10×10 to 100×200 ft, stages, vehicles, trailers, containers, equipment, site furniture, sports courts and fields, and custom shapes, each with a clearance setting.
- Site fit: *Will it fit?*, *Largest fit*, and *How many fit?* (grid packing).
- Pins, text boxes, freehand drawing, notes and labels.

### Uploaded objects
- Upload, paste or drop an image. The object is isolated and cropped in the browser: U²-Net AI for photos (multi-threaded, with a mirrored pass and guided-filter edge snapping), colour keying for plain backgrounds, or the image's existing transparency.
- Click to pick the object or drag a box around it; set a real width or length, or stretch to exact dimensions.
- Saved to an object library and reusable on any site.

### Imagery
- Overlays: Esri World Imagery and Wayback, USDA NAIP, 3-inch county aerials, NASA GIBS, and custom XYZ or ArcGIS layers.
- Capture-date lookup that ranks sources newest-first at the map center.
- Optional SkyFi commercial archive search.
- Enhance: artifact-free sharpening, or in-browser AI super-resolution.

### Platform
- OpenAPI 3.1 REST API with Swagger UI, API-key auth and CORS.
- Embeddable iframe with read-only mode and a `postMessage` API.
- Saved sites showing their last-saved date; GeoJSON and CSV export; static satellite snapshots.
- Zero runtime dependencies, Node ≥ 22.9, Dockerfile included.

[1.0.0]: https://github.com/248Tech/litemap/releases/tag/v1.0.0
