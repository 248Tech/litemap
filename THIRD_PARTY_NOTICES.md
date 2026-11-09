# Third-party notices

LiteMap's own source code is MIT-licensed (see [LICENSE](LICENSE)). It bundles or loads the following third-party components, which keep their own licenses.

## Bundled model weights (`public/models/`)

| File | Project | License |
| --- | --- | --- |
| `realesr-general-x4v3.onnx` | [Real-ESRGAN](https://github.com/xinntao/Real-ESRGAN) by Xintao Wang et al. (ONNX export by `jonathanst29/tinier-upscale-models`) | BSD-3-Clause |
| `u2netp.onnx` | [U²-Net](https://github.com/xuebinqin/U-2-Net) by Xuebin Qin et al. (ONNX export from [rembg](https://github.com/danielgatis/rembg)) | Apache-2.0 |

SHA-256 checksums are listed in [`public/models/README.txt`](public/models/README.txt).

## Loaded at runtime from CDNs (not redistributed)

| Component | Source | License |
| --- | --- | --- |
| Mapbox GL JS v3 | api.mapbox.com | Mapbox Terms of Service (requires a Mapbox account and token) |
| ONNX Runtime Web | cdn.jsdelivr.net | MIT |
| Swagger UI | cdn.jsdelivr.net | Apache-2.0 |

## Map data and imagery

Basemaps, imagery and geocoding are provided by Mapbox, Esri, USDA (NAIP), NASA GIBS, county GIS services, and optionally SkyFi. Each remains © its provider and is subject to that provider's terms. Attribution is shown on the map.
