# Stormgrid

Catchment-scale rainfall preview built from a local Lizard precipitation
archive. Runs as a static site at <https://stormgrid.pluviometrics.com.au/>.
Independent of Stormgauge — does not import or modify Stormgauge AEP/IFD/
station/radar/export logic.

## Layout

```
.
├── index.html                      Static page (Pages serves this at /)
├── stormgrid.css                   Page styles
├── CNAME                           stormgrid.pluviometrics.com.au
├── .nojekyll                       Disable Jekyll on Pages
├── data/
│   ├── catchment_rainfall_latest.json   Output of build_static_rainfall.py
│   └── catchments/
│       ├── catchments_dissolved.geojson Polygons rendered on the map
│       ├── catchments_index.csv         Metadata index
│       └── manifest.json
├── scripts/
│   └── build_static_rainfall.py    Local builder (reads Lizard GeoTIFFs)
└── src/                            Browser modules (ES modules, no bundler)
    ├── stormgridUi.js              Mount entry — `mountStormgridShell(host)`
    ├── stormgridState.js
    ├── stormgridDefaults.js
    ├── stormgridReviewModel.js
    ├── stormgridValidation.js
    ├── stormgridMapBridge.js
    ├── stormgridCatchmentMap.js
    ├── stormgridDataLoader.js
    └── stormgridAvailability.js
```

## Rebuilding the rainfall JSON

The Lizard GeoTIFF archive lives **on the operator's laptop only** (never
committed). Run the builder against your local copy:

```bash
python scripts/build_static_rainfall.py \
    --hours 24 \
    --archive "C:\path\to\lizard_precipitation_australia"
```

Or set the env var once:

```bash
export STORMGRID_LIZARD_DIR="C:/path/to/lizard_precipitation_australia"
python scripts/build_static_rainfall.py
```

The script writes `data/catchment_rainfall_latest.json`. Commit and push
to deploy.

Required Python deps: `rasterio`, `shapely`, `numpy`, `pyproj`.

## Local preview

Any static file server works:

```bash
python -m http.server 8000
# then open http://localhost:8000/
```

## Deploy

GitHub Pages serves from `main` branch root. The `CNAME` file maps the
custom domain. Add a DNS `CNAME` record for `stormgrid` →
`igo-camping.github.io` at the registrar.

## Scope

Stormgrid only renders the precomputed JSON. It does not call radar APIs,
not gauge APIs, and not the Stormgauge AEP/IFD pipelines.
