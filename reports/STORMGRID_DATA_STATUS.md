# STORMGRID_DATA_STATUS

**Scope:** Provenance and engineering-readiness of every data source that ships in the Stormgrid repo.
**Branch:** `audit/assessment-hardening-stormgrid` (off `main`).
**Status:** Report only. No data changed.

---

## Headline

The assessment characterises Stormgrid as having "synthetic gauges, placeholder ARF, `verified:false`, `is_synthetic:true`" as if these are *bugs*. **They are not.** They are deliberate fail-loud markers that the Stormgrid team built so that synthetic data cannot quietly contaminate engineering outputs.

This report:
1. Confirms the assessment's factual observations are correct,
2. Reframes them as a methodology-honest design choice,
3. Identifies what real-data wiring is needed before commercial use,
4. Lists what is **NOT** safe to remove from the codebase (the warning machinery itself).

---

## Inventory: every data file in the repo

| File | Size | Provenance | `is_synthetic` | `verified` | Engineering-safe? |
|---|---|---|---|---|---|
| `data/arf_coefficients.json` | 4 KB | Operator-supplied (currently default placeholder) | n/a | **`verified: false`** | **No** — explicitly flagged. |
| `data/asset_metadata.json` | small | n/a | `false` (this file is metadata) | n/a | n/a |
| `data/assets/stormwater_assets.geojson` | 15.3 MB | `scripts/build_assets.py` from catchment polygons | **`is_synthetic: true`** (every record) | n/a | **No** — explicitly flagged. |
| `data/stormwater_assets.json` | (older / now superseded by .geojson?) | Same | `is_synthetic: true` (~110 records) | n/a | **No** — flagged. |
| `data/gauge_observations.json` | small | Synthetic with bias factors | `is_synthetic: true` | n/a | **No** — flagged. |
| `data/catchment_ifd_centroid.json` | small | `scripts/build_catchment_ifd.py` from BOM IFD via Pluvio | n/a | n/a | Real (subject to BOM IFD licensing) |
| `data/catchments/catchments_dissolved.geojson` | 6.2 MB | `lizard_raster_export` (per `properties.source` field) | n/a | `is_authoritative: false` (per UI banner) | Real (Lizard-derived) |
| `data/catchments/catchments_parts.geojson` | 6.4 MB | Same | n/a | Same | Real (Lizard-derived) |
| `data/catchments/manifest.json` | small | Build provenance | n/a | n/a | Metadata only. **Contains `C:\Users\fonzi\...` paths — see `PATH_LEAK_AUDIT.md` in pluvio-stormgauge.** |
| `data/catchment_rainfall_24h.json` / `_7d` / `_30d` / `_latest` | 121 KB max | `scripts/build_static_rainfall.py` — precomputed from `lizard_precipitation_australia` | n/a | "uncalibrated, non-engineering" banner shown in UI | Real (Lizard-derived, uncalibrated) |
| `data/event_archive/evt_*/event.json` | 110–210 KB each | Captured event snapshots | n/a | n/a | Real |

---

## How the warning machinery works (do not remove)

### `data/arf_coefficients.json`

```json
{
  "verified": false,
  "warning": "DEFAULT PLACEHOLDER COEFFICIENTS. The ARR2019 Book 2 Chapter 4
   Table 2.4.1 values for the operator's region must be transcribed in
   before any engineering use. While verified=false, every ARF-adjusted
   output in the UI carries the unverified banner and exports carry
   coefficients_verified=false."
}
```

This file:
- Surfaces the unverified banner via `src/stormgridEventInterpretation.js` and `src/stormgridIfdPanel.js`.
- Tags every export with `coefficients_verified: false` via `src/stormgridSnapshot.js`.
- Blocks the `tests/run_arf_golden_tests.mjs` test runner from claiming verified status (`verified=false and no golden cases populated. Build the fixture before flipping verified=true.`).

**Removing or silently flipping `verified: true` would silently contaminate any engineering output that consumes ARF-adjusted rainfall.** The placeholder coefficients are deliberately wrong-by-construction so a misconfigured deployment fails loudly.

### `data/gauge_observations.json`

```json
{
  "is_synthetic": true,
  "warning": "SYNTHETIC PLACEHOLDER VALUES. These gauge totals are
   illustrative — they were authored to exercise the calibration framework,
   NOT derived from BOM/MHL feeds. Replace via
   scripts/build_gauge_observations.py before any operational use.
   Calibrated rainfall built on synthetic gauges is meaningless for
   engineering decisions."
}
```

The corresponding builder `scripts/build_gauge_observations.py` is **explicitly an unimplemented stub**:

```python
"""Stormgrid — gauge observations builder (Phase 14, stub)."""
def fetch_gauge_total(...):
    """Stub. Replace with a real BOM/MHL/WISKI fetch."""
    # TODO: real implementation. For now, return None so the script
    #       fails to overwrite the synthetic placeholder dataset.
```

The script intentionally returns `None` so it cannot accidentally overwrite the synthetic dataset with non-data. Real wiring requires implementing the BOM/MHL/WISKI fetchers.

### `data/assets/stormwater_assets.geojson` (and the older `data/stormwater_assets.json`)

Every record has `is_synthetic: true`. The UI in `src/stormgridAssets.js:424` shows a warning banner when `meta.is_synthetic` is true. The dataset header has the same warning string as gauges.

### `data/catchments/catchments_*.geojson`

`is_authoritative: false` per the UI footer text in `index.html`:
> *"Catchment polygons are derived from a raster export and are flagged `is_authoritative: false`."*

These are real Lizard-derived data — they reflect what the satellite/radar archive shows, not the council's authoritative catchment GIS. The flag is correct labelling.

### `data/catchment_rainfall_*.json`

UI explicitly displays:
> *"Click a catchment, then click Run analysis. Stats come from the precomputed Lizard rainfall JSON (uncalibrated, non-engineering)."*

And:
> *"Uncalibrated rainfall product · not engineering rainfall · Stormgauge AEP/IFD logic remains authoritative."*

These banners are in `index.html` and `src/stormgridUi.js`.

---

## What real-data wiring requires (for each synthetic source)

| Synthetic source | Real wiring needed | Owner | Estimated effort |
|---|---|---|---|
| `arf_coefficients.json` | Transcribe ARR2019 Book 2 Ch. 4 Table 2.4.1 values for "East Coast North" region into the JSON. Add ≥6 golden test cases per region from ARR worked examples or Data Hub. Update `source_note` to cite the table. Run `tests/run_arf_golden_tests.mjs` and confirm pass before flipping `verified: true`. | Operator (engineer) | ~1 day |
| `gauge_observations.json` | Implement `scripts/build_gauge_observations.py` BOM/MHL/WISKI fetchers. Return real totals. Run script. Inspect output. **Then** the dataset becomes operational. | Engineering team | ~2–3 days |
| `stormwater_assets.geojson` | Replace with TechnologyOne CiA / Intramaps export of the council asset register. Set `is_synthetic: false` per record (or remove the flag if irrelevant). The script `scripts/build_assets.py` from synthetic should be retired in favour of an importer. | Operator + GIS | ~1 day to wire, longer to validate per-record schema match |
| `catchments_*.geojson` | Already real, just Lizard-derived. To make authoritative, replace with council's authoritative catchment GIS export. Keep `is_authoritative: false` until that's done. | Operator + GIS | ~half-day |
| `catchment_rainfall_*.json` | Already real (Lizard precomputed). To meet engineering-grade, calibrate against gauges per Phase 14 calibration framework — requires real `gauge_observations.json` first. | Engineering team | dependent on gauge wiring |

---

## What is safe (today)

- Stormgrid is **safe to demo and explore** without engineering claim.
- Stormgrid is **safe to use for catchment rainfall comparison** (the Lizard-derived precomputed values), with the existing "uncalibrated" banner.
- Stormgrid is **safe to use for ARF demonstration** with the `verified: false` banner shown.
- Stormgrid does **NOT silently substitute missing data** — every consumer of synthetic data sees a banner.
- Stormgrid exports carry the `verified=false` flag through to file output.

## What is NOT safe (today)

- Stormgrid asset register **must not be used** for inspection prioritisation, maintenance scheduling, or capital planning. The synthetic asset dataset is geometrically/structurally illustrative and was never derived from a council register.
- Stormgrid ARF coefficients **must not be used** for engineering design.
- Stormgrid calibrated rainfall **does not exist yet** (gauges are synthetic).

---

## Recommended next fixes (NOT applied)

These are the minimum to convert Stormgrid from "honest demo" to "honest engineering-grade tool":

1. **Implement `scripts/build_gauge_observations.py` real fetchers.** Highest-leverage single change — unlocks calibration. Risk: zero to existing flags; the script self-protects by returning `None` until implemented.
2. **Transcribe ARR2019 ARF coefficients.** Mechanical work; engineer must do it. Risk: zero (existing tests will catch regressions if golden cases are added per the recommendation in `data/arf_coefficients.json` itself).
3. **Source real council asset export and replace synthetic GeoJSON.** Operator-side work.
4. **Sanitise `data/catchments/manifest.json`** path leaks per `PATH_LEAK_AUDIT.md`.

## What this report does NOT do

- Does not modify any data file.
- Does not implement gauge fetchers.
- Does not flip any flag.
- Does not remove any warning banner.
