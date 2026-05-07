# Data Provenance — Stormgrid

Source-of-truth notes for every data input Stormgrid depends on. The
"Licensing status" column reflects the maintainer's current
understanding and does not constitute legal advice. Items marked
**"Requires confirmation"** must be verified in writing with the
publisher before commercial redistribution or commercial-volume use.

## Real (operational) data shipped with the repo

| Dataset | Source | File | Authority flag | Licensing status |
|---|---|---|---|---|
| Catchment polygons (dissolved) | Derived from a Lizard raster export | `data/catchments/catchments_dissolved.geojson` | `is_authoritative: false` (raster-derived, not council vector authority) | **Requires confirmation.** Lizard (Nelen & Schuurmans) data licensing depends on the specific dataset. Confirm before commercial use. |
| Catchment polygons (parts) | Same | `data/catchments/catchments_parts.geojson` | Same | Same. |
| Catchment rainfall (precomputed, multiple windows) | `lizard_precipitation_australia` archive, processed by `scripts/build_static_rainfall.py` | `data/catchment_rainfall_*.json` | UI banner: "uncalibrated, non-engineering" | **Requires confirmation.** Lizard licensing as above. |
| Centroid IFD per catchment | BoM IFD via Pluviometrics (cross-product) | `data/catchment_ifd_centroid.json` | Real | Inherits Stormgauge's BoM IFD licensing posture (see `pluvio-stormgauge/DATA_PROVENANCE.md`). |
| Event archive snapshots | Internal builds | `data/event_archive/*/event.json` | Real | Proprietary first-party. |

## Synthetic (illustrative) data shipped with the repo

These files exist to exercise the calibration / ARF / asset-management
framework. **They are NOT real engineering data.** Each carries an
explicit `is_synthetic: true` or `verified: false` flag; the UI shows a
warning banner; exports carry the unverified flag through to file
output. See `reports/STORMGRID_DATA_STATUS.md` for the full provenance
discussion.

| Dataset | File | Flag | Replace via |
|---|---|---|---|
| Synthetic gauge observations | `data/gauge_observations.json` | `is_synthetic: true` | `scripts/build_gauge_observations.py` (currently a stub returning `None` until real BoM/MHL/WISKI fetchers are implemented). |
| Synthetic stormwater asset register | `data/stormwater_assets.json`, `data/assets/stormwater_assets.geojson` | `is_synthetic: true` per record | Replace with TechnologyOne CiA / Intramaps export of the council asset register. |
| Placeholder ARF coefficients | `data/arf_coefficients.json` | `verified: false` | Operator must transcribe ARR2019 Book 2 Chapter 4 Table 2.4.1 values for their region. See file `recommended_replacement_steps`. |

## Live API dependencies

| Service | Endpoint | Use | Licensing status |
|---|---|---|---|
| Cloudflare basemaps | `*.basemaps.cartocdn.com` | Catchment map basemap | **Requires confirmation** for commercial volume. |
| OpenStreetMap Nominatim | `https://nominatim.openstreetmap.org` | Address search | Strict usage policy: max 1 req/s, no heavy use. **Commercial volume must use a paid geocoder.** |

## Methodology references

| Reference | Used for |
|---|---|
| Australian Rainfall and Runoff (ARR) 2019, Book 2 Chapter 4 (Areal Reduction Factors) | ARF engine in `src/stormgridArf.js`, gated by operator-supplied coefficients |

## Outstanding items before commercial release

1. Written confirmation from Lizard (Nelen & Schuurmans) on commercial use of the precipitation archive and any derived rasters used for catchment extraction.
2. Operator transcription of ARR2019 Book 2 Ch. 4 Table 2.4.1 coefficients for the deployment region, with golden test cases populated and `verified` flipped to `true` only after tests pass.
3. Real-data wiring in `scripts/build_gauge_observations.py` BEFORE `data/gauge_observations.json` is treated as operational.
4. Replacement of the synthetic asset register with a real council export BEFORE Stormgrid is used for inspection prioritisation.
5. CARTO commercial plan selection if Stormgrid serves commercial-volume traffic.
6. Replacement of OSM Nominatim with a paid geocoder if commercial volume.
