# PHASE1_IMPLEMENTATION — Stormgrid

**Branch:** `feature/phase1-safe-hardening-stormgrid` (off `main`).
**Scope:** Stormgrid-specific Phase 1 changes. Cross-repo summary lives in `pluvio-stormgauge:feature/phase1-safe-hardening-stormgauge:reports/PHASE1_IMPLEMENTATION.md`.

---

## Files changed

| File | Change |
|---|---|
| `data/catchments/manifest.json` | 5 line edits — `input_geotiff` and four `outputs.*` entries changed from absolute Windows paths (`C:\Users\fonzi\Weather App Folder\Assets\Catchments\...`) to repo-relative paths. **Build provenance only — not consumed by runtime.** |
| `LICENSE` | New — proprietary, all rights reserved. |
| `THIRD_PARTY_NOTICES.md` | New — runtime libraries (Leaflet, html2canvas), map services (CARTO, OSM Nominatim), hosting (Cloudflare Pages). |
| `DATA_PROVENANCE.md` | New — explicit synthetic-vs-real surface (catchments are real Lizard-derived; gauges/assets/ARF are synthetic placeholders with the existing fail-loud warning machinery preserved). |
| `docs/OPERATIONS.md` | New — Cloudflare Pages topology, branch model, separation from Stormgauge, data refresh procedure. |

## What was deliberately not touched

- All `src/*.js` modules — including `stormgridArf.js`, `stormgridAssets.js`, `stormgridDataLoader.js`, etc. **No code change.**
- Every data file other than `manifest.json` — including `data/arf_coefficients.json`, `data/gauge_observations.json`, `data/stormwater_assets.json`, `data/assets/stormwater_assets.geojson`, the catchments GeoJSONs, the catchment rainfall JSONs, and the event archive snapshots. **No data change.** All `is_synthetic: true` and `verified: false` flags untouched.
- `index.html` — unchanged.
- The `tests/` directory — unchanged.
- `scripts/build_*.py` — unchanged. (Note: `scripts/build_asset_snapshot.py:25` and `scripts/build_catchment_ifd.py:18` retain operator-side absolute paths in CLI defaults / docstrings. Per the audit, these are not deployed and are out of Phase 1 scope.)

## Validation

See `reports/PHASE1_VALIDATION.md` and the cross-repo report in `pluvio-stormgauge`.
