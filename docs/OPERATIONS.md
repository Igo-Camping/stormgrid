# Stormgrid — Operations

## Hosting

- **Platform:** Cloudflare Pages.
- **Custom domain:** stormgrid.pluviometrics.com.au
- **Deploy branch:** `main` (root of `main` is what Pages serves).
- No build step, no bundler. ES modules under `src/` are fetched by the browser at runtime.

## Branch model

| Branch | Purpose |
|---|---|
| `main` | Production. What stormgrid.pluviometrics.com.au serves. |
| `feature/*` | Work-in-progress; merge to `main` to deploy. |
| `audit/*` | Read-only audit reports — never merged. |

## Related Pluviometrics products (deliberate separation)

Stormgrid is a **separate product** from Stormgauge:

- Different repo (`pluvio-stormgrid`, formerly `stormgrid`).
- Different domain (stormgrid.pluviometrics.com.au).
- Different scope — Stormgrid is a catchment-scale rainfall preview built from a precomputed Lizard archive. It deliberately does not import Stormgauge AEP/IFD/station/radar/export logic.
- The Stormgauge front door (stormgauge.pluviometrics.com.au) is and remains authoritative for AEP and IFD analysis.

## External dependencies

| Service | Use |
|---|---|
| Cloudflare basemaps (`*.basemaps.cartocdn.com`) | Catchment map basemap |
| OpenStreetMap Nominatim | Address search |

Stormgrid does not currently call any backend API — all data is shipped as static JSON / GeoJSON in `data/`.

See `DATA_PROVENANCE.md` for the full data inventory and licensing posture.

## Local preview

```bash
# any static server works
python3 -m http.server 8000
# then open http://localhost:8000
```

## Data refresh

Static data is rebuilt by Python scripts in `scripts/`:

- `scripts/build_static_rainfall.py` — refreshes `data/catchment_rainfall_*.json` from a Lizard precipitation archive.
- `scripts/build_assets.py` — generates the synthetic asset register (placeholder; replace with a council asset export before operational use).
- `scripts/build_gauge_observations.py` — currently a stub returning `None` (see `data/gauge_observations.json` warning). Implement real BoM/MHL/WISKI fetchers before treating gauge data as operational.
- `scripts/build_catchment_ifd.py` — refreshes `data/catchment_ifd_centroid.json` from the BoM IFD via Pluviometrics.

After rebuilding, commit the generated JSON to `main` and Cloudflare Pages will pick it up on the next deploy.

## Deployment procedure

1. Merge feature work to `main` via PR.
2. Confirm https://stormgrid.pluviometrics.com.au/ updates within ~2 min.
3. Smoke-test in browser: catchment map renders, click-to-analyse works, ARF panel reflects current `data/arf_coefficients.json` `verified` flag.

## Backup and recovery

- Source code: GitHub (`Pluviometrics/pluvio-stormgrid`).
- Cloudflare Pages config: managed via Cloudflare dashboard; `CNAME` and `.nojekyll` files pin the deploy.

## Key references

- `LICENSE` — copyright and reuse terms.
- `THIRD_PARTY_NOTICES.md` — runtime libraries.
- `DATA_PROVENANCE.md` — data sources, including which datasets are synthetic vs real.
- `reports/STORMGRID_DATA_STATUS.md` — provenance discussion of the synthetic-vs-real surface.
- `docs/arf_methodology.md` — ARF engine design notes.
- `docs/asset_data_schema.md` — asset register schema and replacement procedure.
