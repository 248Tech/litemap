# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.1.0] - 2026-11-11

### Added
- Top-down model skins for every built-in catalog object: tents (pyramid, hip and gable clearspan roofs with bays and legs to scale), stages, dance floors, cars, pickups, box trucks, tractor-trailers, containers, forklifts, boom lifts, dumpsters, generators, parking stalls, restrooms, banquet and round tables with chairs, people, and courts and fields with regulation markings.
- Skins are drawn in the browser at real size, follow rotation and resizing, take the object's colour as a tint, and also show in the ghost preview, the *How many fit?* layout and the catalog thumbnails. A **Skins** toggle switches back to flat footprints.
- Tent ballast: every tent skin shows one galvanized ballast plate per leg (angle-iron curbs, end stops, D-ring tie-downs) carrying two 2.5 ft concrete blocks side by side, drawn to scale just outside the wall line. A **Ballast** toggle next to **Skins** turns it off.
- Per-object labels: untick **Label → Show on map** in the inspector to hide one object's label while the others stay visible. Stored as `showLabel: false` and accepted by the REST API.
- **Show measurements** button in the inspector: keeps every side length (areas, distances, rectangular objects), the diameter (circles) or the length (drawings) on the map without selecting the feature. Stored as `showMeasurements: true` and accepted by the REST API.
- Site addresses: every site shows its street address under the name and in the Sites list (where it is also searchable). It is looked up from the site location with Mapbox reverse geocoding when you save, follows the site if it moves, and can be typed over by clicking it; clear it to go back to automatic. Existing sites are filled in at startup. The API exposes `address` and `addressAuto`. Set `LITEMAP_AUTO_ADDRESS=0` to turn lookups off.
- 3D tent builder: **Build a tent…** in the Tents section of the object catalog, and **Open tent builder…** in the inspector for any placed tent. Set width and length, roof style (pyramid, hip or gable), leg and peak heights, bay spacing, sidewalls per side (open, solid, windows or clear) and fabric colour in a 3D preview you can orbit and zoom. The builder also works out footprint, roof fabric area, sidewall length and area, leg and ballast block counts, and interior volume. Unchanged settings follow the tent size automatically.
- **3D** switch: stands every tent up on the map (roof, sidewalls, legs and ballast blocks), tilts the map, and lets you tilt it further by right-dragging.
- Tent skins now use the builder settings, so the top-down plan shows the same roof style, bays and legs as the 3D model, plus a band along each sidewall.
- 90 stock tent sizes in three catalog groups: frame and canopy tents (10×10 to 40×160 ft), clearspan structures (50×50 to 120×300 ft) and metric clearspans (10×10 to 40×100 m). Existing tent ids are unchanged. Stages and dance floors move to their own **Stages & floors** group. The builder's stock size list is grouped the same way.
- Clearspans from 10 m (33 ft) wide default to 5 m bays, and tents over 80 ft wide to 14 ft legs.
- **3D Modeler** page at `/modeler`: the tent builder as a full workspace with a ballast switch and an export pipeline. **Save to LiteMap** keeps the model in a library, **Place on map** puts it on a site as a 3D-capable tent reference (also listed under **My models**), and **Download .glb** exports a glTF binary for other 3D tools with the editable recipe embedded so it can be imported again. New REST endpoints `/api/v1/models` (CRUD) and `/api/v1/models/{id}/glb`.
- New `tent-custom` catalog template, for tents of any size. Placed tents accept `reference.tent` (`roof`, `eave`, `peak`, `bay`, `walls`) in the REST API, and it is validated.
- Local catalog: put your own objects (for example your company's tent line, with roof style, heights and walls) in `data/catalog.json` and they appear first in the object list and the builder's stock sizes, and are accepted by the API. The `data/` folder is git-ignored, so the list stays private.
- Online demo of the 3D Modeler at https://248tech.github.io/litemap/modeler/ (editing and file export; saving and placing need a LiteMap server). Rebuild it with `node scripts/build-pages.mjs`.

### Changed
- Map labels shrink as you zoom out, and fade away when the object they belong to is too small on screen to hold them. The selected object keeps its label.

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

[Unreleased]: https://github.com/248Tech/litemap/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/248Tech/litemap/releases/tag/v1.1.0
[1.0.0]: https://github.com/248Tech/litemap/releases/tag/v1.0.0
