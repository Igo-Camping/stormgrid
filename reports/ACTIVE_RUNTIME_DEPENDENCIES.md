# ACTIVE_RUNTIME_DEPENDENCIES — Stormgrid

**Audit branch:** `audit/dead-file-audit-stormgrid`.

This is the positive list — files that any cleanup pass must NOT touch. **All 67 tracked files are in this list.** The reference tracer found zero genuine dead files in Stormgrid.

---

## Live SPA — entry points

| File | Reached from |
|---|---|
| `index.html` | Cloudflare Pages root |
| `stormgrid.css` | `<link>` in index.html |
| `CNAME` | Cloudflare Pages |
| `.nojekyll` | Cloudflare Pages |
| `.gitignore` | Git |
| `README.md` | GitHub repo UI |
| `package.json` | npm scripts (test:arf, build:rainfall, build:ifd) |

## ES modules under `src/` (26 files)

All `src/stormgrid*.js` files are reachable from `mountStormgridShell` in `src/stormgridUi.js` (the single inline-module import in `index.html`). The module graph is closed.

| File | Status |
|---|---|
| `src/stormgridAddressSearch.js` | ACTIVE |
| `src/stormgridArf.js` | ACTIVE — ARR2019 ARF engine |
| `src/stormgridAssets.js` | ACTIVE |
| `src/stormgridAvailability.js` | ACTIVE |
| `src/stormgridCalibration.js` | ACTIVE |
| `src/stormgridCatchmentMap.js` | ACTIVE |
| `src/stormgridCumulativeOverlay.js` | ACTIVE |
| `src/stormgridDataLoader.js` | ACTIVE |
| `src/stormgridDefaults.js` | ACTIVE |
| `src/stormgridDesignComparison.js` | ACTIVE |
| `src/stormgridEventArchive.js` | ACTIVE |
| `src/stormgridEventInterpretation.js` | ACTIVE |
| `src/stormgridEventWindowDetection.js` | ACTIVE |
| `src/stormgridExports.js` | ACTIVE |
| `src/stormgridGeo.js` | ACTIVE |
| `src/stormgridIfdLoader.js` | ACTIVE |
| `src/stormgridIfdPanel.js` | ACTIVE |
| `src/stormgridMapBridge.js` | ACTIVE |
| `src/stormgridOperationalContextPanel.js` | ACTIVE |
| `src/stormgridRanking.js` | ACTIVE |
| `src/stormgridReadme.md` | DOC for module authors (not loaded at runtime; consumed by humans) |
| `src/stormgridReviewModel.js` | ACTIVE |
| `src/stormgridSnapshot.js` | ACTIVE |
| `src/stormgridState.js` | ACTIVE |
| `src/stormgridUi.js` | ACTIVE — mount entry point |
| `src/stormgridValidation.js` | ACTIVE |

## Data files

| File | Loader | Status |
|---|---|---|
| `data/arf_coefficients.json` | `stormgridArf.js` | ACTIVE — placeholder coefficients with `verified: false` (per Phase 1 reports) |
| `data/asset_metadata.json` | `stormgridAssets.js` | ACTIVE |
| `data/assets/stormwater_assets.geojson` | `stormgridAssets.js` | ACTIVE — synthetic with `is_synthetic: true` flag |
| `data/catchment_ifd_centroid.json` | `stormgridIfdLoader.js` | ACTIVE |
| `data/catchment_rainfall_24h.json` | `stormgridDataLoader.js` | ACTIVE |
| `data/catchment_rainfall_30d.json` | same | ACTIVE |
| `data/catchment_rainfall_7d.json` | same | ACTIVE |
| `data/catchment_rainfall_latest.json` | same | ACTIVE |
| `data/catchments/catchments_dissolved.geojson` | `stormgridCatchmentMap.js` | ACTIVE |
| `data/catchments/catchments_index.csv` | refs from manifest + scripts | ACTIVE |
| `data/catchments/catchments_parts.geojson` | `stormgridCatchmentMap.js` | ACTIVE |
| `data/catchments/extraction_report.md` | Doc | ACTIVE doc |
| `data/catchments/manifest.json` | refs from scripts | ACTIVE |
| `data/event_archive/catchment_climatology.json` | `stormgridEventArchive.js` | ACTIVE |
| `data/event_archive/evt_24h_*` | `stormgridEventArchive.js` | ACTIVE event snapshot |
| `data/event_archive/evt_30d_*` | same | ACTIVE event snapshot |
| `data/event_archive/evt_7d_*` | same | ACTIVE event snapshot |
| `data/event_archive/index.json` | `stormgridEventArchive.js` | ACTIVE |
| `data/gauge_observations.json` | `stormgridCalibration.js` | ACTIVE — `is_synthetic: true` placeholder |
| `data/overlays/cumulative/latest/metadata.json` | `stormgridCumulativeOverlay.js` | ACTIVE |
| `data/overlays/cumulative/latest/rainfall_grid.json` | same | ACTIVE |
| `data/overlays/cumulative/latest/rainfall_overlay.png` | same | ACTIVE |
| `data/stormwater_assets.json` | older asset register format | ACTIVE (legacy alongside the .geojson; both loaded) |

## Operator scripts (referenced from `package.json` and docs)

| File | Triggered by |
|---|---|
| `scripts/build_asset_snapshot.py` | Operator command |
| `scripts/build_assets.py` | Operator command |
| `scripts/build_catchment_ifd.py` | `npm run build:ifd` |
| `scripts/build_cumulative_overlay.py` | Operator command |
| `scripts/build_event_archive.py` | Operator command |
| `scripts/build_gauge_observations.py` | Operator command (currently a stub returning `None`) |
| `scripts/build_static_rainfall.py` | `npm run build:rainfall` |

## Tests

| File | Run via |
|---|---|
| `tests/run_arf_golden_tests.mjs` | `npm run test:arf` |
| `tests/fixtures/arf_golden_cases.json` | Loaded by the runner |

## Documentation

| File | Status |
|---|---|
| `docs/arf_methodology.md` | ACTIVE doc |
| `docs/asset_data_schema.md` | ACTIVE doc |

---

## Total ACTIVE count: 67 files (= total tracked files)

Stormgrid has zero deletion candidates.
