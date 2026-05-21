# Stormgrid — Codebase Audit (Phase A, doc 01)

**Date:** 2026-05-21
**Method:** Read-only audit of the repository at `D:\PROJECTS\PLUVIOMETRICS\PLUVIO_STORMGRID\`, fanned out across seven domain slices (shell/routing, radar/raster pipeline, location/catchment, event+AEP/IFD/ARF methodology, map rendering, exports, state/caching/dependencies) and synthesised here. Every claim is cited to `path:line`. No application code was modified.

This document records **what the repository currently is**. It does not propose the rebuild design — that is docs 02 and 03. Where current reality contradicts `STORMGRID_OVERVIEW.md`, the contradiction is recorded in §7 and §8, not silently resolved.

---

## 1. Top-level repository map

```
PLUVIO_STORMGRID/
├── index.html                  Single static page; mounts the shell (entry point)
├── stormgrid.css               ~72 KB page + map + panel styling
├── package.json                4 npm scripts (arf tests, rainfall + ifd builders); no bundler
├── CNAME / .nojekyll           GitHub Pages static hosting (stormgrid.pluviometrics.com.au)
├── README.md                   Repo readme — partially stale (see §6)
├── .project                    Project marker (untracked)
├── Stormgrid/                  Planning docs only (OVERVIEW + REBUILD_PLAN); no app code
├── docs/                       arf_methodology.md, asset_data_schema.md (+ this audit)
├── scripts/                    7 Python builders (offline, operator-run)
├── data/                       Precomputed JSON + GeoJSON the app fetches at runtime
└── src/                        26 ES modules, no bundler, mounted by stormgridUi.js
```

The application is a **vanilla-JS, no-build, single-page static site**. The browser loads `index.html`, which pulls Leaflet 1.9.4 + html2canvas 1.4.1 from CDN (`index.html:10-12`) and runs one ES-module import: `mountStormgridShell(host)` from `src/stormgridUi.js` (`index.html:41-51`). There is no router, no framework, no state library, no server. All "freshness" depends on an operator re-running the Python builders against a laptop-local archive and committing the resulting JSON.

```
   index.html
      │  import { mountStormgridShell }
      ▼
   src/stormgridUi.js  ── mountStormgridShell()  [~51 KB, single function, the HUB]
      │ imports ~16 modules, owns ALL runtime state in a closure, renders one DOM column
      ▼
   fetch ./data/*.json  (rainfall windows, IFD, ARF coeffs, event archive, assets, overlay)
   fetch CARTO basemap tiles + Nominatim geocoding (the only live network calls)
```

---

## 2. The shell and navigation (slice a)

**`mountStormgridShell`** — `src/stormgridUi.js:84-1156` — is the entire application shell: one function that builds the DOM imperatively, holds ~20 closure-scoped state variables, defines every handler, fires ~10 async loaders, and re-renders the whole column on any change. It returns `{ state, rerender, setWindow, destroy }`.

There is **no routing and no URL state** of any kind — no `location.hash`, no `history`, no query parsing (confirmed across the slice). It is a single mounted shell; nothing is deep-linkable or shareable.

The render order (`stormgridUi.js:124-240`) stacks, top to bottom, in one vertical column:

```
1  Address search bar
2  Controls strip: last-built label + accumulation-window selector
3  Duration selector (3h/6h/12h/24h/48h/72h)
4  Map colour-mode selector (confidence / criticalRainfall / spatialVariability)
5  Calibration mode selector (Raw / Calibrated)
6  Cumulative overlay control (Off / On)
7  Header "Stormgrid v0 shell"
8  sg-top: catchment MAP (left) + availability/results aside (right)   ← only 2-col region
9  Seven assumption cards grid
10 Run bar + Run button
11 IFD comparison panel
12 Operational context panel
13 Calibration panel
14 Overlay legend
15 Asset filters + infrastructure exposure
16 Event archive + catchment history
17 Event summary / exports
18 Frame log
19 Ranking panel
```

That is **6 control widgets and ~13 stacked panels** wrapped around a map that is one fixed-height (~460 px, `stormgrid.css:302-305`) tile in a single two-column row. This is exactly the failure `STORMGRID_OVERVIEW.md:112-116` names: too many competing concepts visible at once, map not dominant, no obvious user journey. The shell does **not** implement the target `Location → Event/Timeframe → Map → Stats → Confidence → Export` flow; it presents everything simultaneously.

**The "Run" gate works and is not permanently disabled.** `stormgridValidation.js:7-34` enables Run when (1) rainfall JSON is loaded, (2) a catchment is selected, and (3) that catchment has a numeric `total_mm` row. `runBtn.disabled = !readiness.ready` (`stormgridUi.js:552`); the handler records the run and re-renders (`:242-247`). With the committed `data/catchment_rainfall_latest.json` present, Run enables on catchment selection.

---

## 3. Module-by-module status

Status legend: **working** (does what it claims, end to end) · **partial** (works but incomplete or running on placeholder data) · **experimental** (scaffold/stub) · **deprecated/stale**.

### 3.1 Shell, state, derived models

| Module | `path` | Status | Recommendation |
|---|---|---|---|
| Shell mount | `stormgridUi.js:84` | working but overgrown (51 KB single fn) | **refactor** — decompose into the layered components of doc 03 |
| State container | `stormgridState.js:39-66` | working (plain mutable object, no reactivity) | **keep model, refactor ownership** — shape is sound; problem is it lives in the UI closure |
| Review model | `stormgridReviewModel.js:7-24` | working, pure (`state+defaults → card VMs`, never invents) | **keep** — template for derived data |
| Defaults builder | `stormgridDefaults.js:8-131` | working, pure | **keep** |
| Validation/Run gate | `stormgridValidation.js:7-34` | working, pure | **keep** |
| Operational context panel | `stormgridOperationalContextPanel.js:16-85` | working — address→catchment→IFD→window→gauges audit trail, each row value/reason/confidence + AUTO/MANUAL badge + override/reset | **keep** — strong fit for "always-visible confidence", currently buried at panel #12 |

State shape (`stormgridState.js:40-65`): `selectedCatchmentId/Feature`, `rainfallData/Error`, `selectedWindow`, `selectedDuration`, `mapColourMode`, `ifdDisplayMode`, `analysisRun`, `lastRunAt`, seven `cards{}`, and `operationalContext{}` (address, catchment, ifd, eventWindow, nearbyGauges[], overrides[] with before/after + ISO timestamps). **A large amount of runtime state lives outside this object** as closure-local `let`s (`stormgridUi.js:91-119`): archive entries, calibration mode, asset filters, overlay state, ranking filters — this is the "insufficient state organisation" weakness.

### 3.2 Radar / raster / rainfall pipeline (slice b)

| Module | `path` | Status | Recommendation |
|---|---|---|---|
| Static rainfall builder | `scripts/build_static_rainfall.py:1-676` | working — masks Lizard GeoTIFF frames to catchments, accumulates per-frame catchment **means** into `total_mm`, computes rolling critical-duration stats, honest coverage/confidence/frame-log | **keep** — the areal-mean computation is the methodological heart |
| Cumulative overlay builder | `scripts/build_cumulative_overlay.py:1-462` | partial — `real` mode (reproject/sum GeoTIFFs → PNG+grid) exists but the **shipped artefact is `preview`** (`data/overlays/cumulative/latest/metadata.json:90-92`, `is_synthetic_preview:true`) | **keep**, make `real` the shipped path |
| Gauge observations builder | `scripts/build_gauge_observations.py:1-128` | experimental stub — `fetch_station_total()` returns `None` (`:72`); **refuses to overwrite** synthetic placeholder unless real values exist (`:101-105`) | **keep** (implement fetch); preserve the refuse-to-fabricate guard |
| Data loader (frontend) | `stormgridDataLoader.js:1-179` | working — fetch + module cache + in-flight dedupe + shape validation; returns `{ok:false}` on failure, never fabricates | **keep** — strongest module in the codebase |
| Availability / results panel | `stormgridAvailability.js:1-453` | working — coverage %, confidence tier, <70% low-coverage warnings, frames used/missing, expandable frame log | **keep** — this is where gap-honesty surfaces in the UI |
| Calibration framework | `stormgridCalibration.js:1-506` | working but fed synthetic gauges — IDW bias factors; `applyCalibration()` deep-clones, preserves `raw_*`, tags `calibration_applied/method`, downgrades confidence if nearest gauge >5 km | **keep** — raw/calibrated separation is exactly per OVERVIEW |
| Cumulative overlay (frontend) | `stormgridCumulativeOverlay.js:1-276` | working — renders whatever was shipped (currently the preview); hover returns `has_coverage:false` outside coverage | **keep** |

### 3.3 Location / catchment / assets (slice c)

| Module | `path` | Status | Recommendation |
|---|---|---|---|
| Catchment map | `stormgridCatchmentMap.js:115` | working — loads 35-feature `catchments_dissolved.geojson`, click-to-select, fit-bounds, 3-mode confidence recolour, dynamic legend | **keep** — core to the Location step |
| Address search | `stormgridAddressSearch.js:21,88` | working — OSM Nominatim, AU-scoped, 350 ms debounce, keyboard nav | **keep**, but note external dependency (see §7) |
| Geo helpers | `stormgridGeo.js` | working, pure — haversine, point-in-polygon (hole-aware), `findCatchmentForPoint` returns confidence + reason + null (never guesses) | **keep** — best-disciplined module in this slice |
| Asset subsystem | `stormgridAssets.js` (23 KB) + `scripts/build_assets.py` + `scripts/build_asset_snapshot.py` | partial/experimental — app loads **synthetic 77-asset** `data/stormwater_assets.json` (`is_synthetic:true`); the real **24,012-pipe** `data/assets/stormwater_assets.geojson` (15 MB, sanitised) is built but **never loaded** | **keep behind a Labs flag** — not part of the core rainfall-severity story; resolve the dual pipeline |

Location selection today: (1) click a catchment polygon (works); (2) address → Nominatim → `findCatchmentForPoint` auto-selects containing/nearest catchment (works); (3) manual catchment-ID via `window.prompt` (`stormgridUi.js:793`, crude). **Area/draw selection does not exist.** **Saved/recent locations do not exist** — no persistence anywhere (no localStorage/sessionStorage/IndexedDB in `src/`).

### 3.4 Event detection / AEP / IFD / ARF (slice d)

| Module | `path` | Status | Recommendation |
|---|---|---|---|
| ARF engine | `stormgridArf.js:63,113` | working — ARR2019 long-duration ARF form, clipped (0,1], extrapolation flags; scoped to "convert point IFD → areal only" (`:11-15`) | **keep** (coefficients are placeholders — §7) |
| IFD comparison panel | `stormgridIfdPanel.js:25` | working — the **only** ARF call site (`:149,183,491`) | **keep** |
| IFD loader | `stormgridIfdLoader.js:13` | working — loads point IFD, "ARF NOT applied" | **keep** |
| Point-IFD builder | `scripts/build_catchment_ifd.py` | working — nearest verified BOM station point IFD per centroid, `arf_applied:false`, monotonicity QC | **keep** (contains out-of-scope path default — §8) |
| Design comparison | `stormgridDesignComparison.js:46` | working — observed/reference ratio + bands, never asserts exceedance | **keep** |
| Event window detection | `stormgridEventWindowDetection.js:31` | working but **precomputed-only** — picks highest rolling `max_total_mm` from static `duration_stats`, not on-the-fly from raw frames | **keep**, refactor toward on-the-fly (§7) |
| Event interpretation | `stormgridEventInterpretation.js:29` | working, pure — nearest-design envelope, consistency, 5-factor confidence, explicit non-classification | **keep** (minor dead branch `:127-129`) |
| Ranking | `stormgridRanking.js:13` | working — ranks catchments by **raw `max_total_mm`** (mm), NOT against an IFD/AEP threshold | **keep**, but does not meet OVERVIEW §7.6 "rank vs AEP threshold" |
| Event archive | `stormgridEventArchive.js` + `scripts/build_event_archive.py` | working, precomputed — volume bands explicitly NOT AEP | **keep** |
| ARF golden tests | `tests/run_arf_golden_tests.mjs` | working, **passing** (5/5 shape tests; 0 golden cases; `verified:false`) | **keep** |

### 3.5 Map rendering (slice e)

| Piece | `path` | Status | Recommendation |
|---|---|---|---|
| Map bridge | `stormgridMapBridge.js:27-73` | working — read-only context reader (`window.__stormgrid.map`); does **not** create the map | **keep** |
| Map creation + CARTO basemap | `stormgridCatchmentMap.js:115-138` | working — Leaflet 1.9.4, CARTO light, no shared Stormgauge shell | **keep** |
| Catchment polygon render | `stormgridCatchmentMap.js:160-201` | working — clickable GeoJSON, tooltips, fit-bounds, graceful fetch-fail fallback | **keep** |
| 3-mode choropleth recolour | `stormgridCatchmentMap.js:207-340` | working — confidence / criticalRainfall / spatialVariability | **keep** (the 3-mode switcher is a "too many controls" candidate) |
| Cumulative rainfall overlay | `stormgridCumulativeOverlay.js:86-108` | working — `L.imageOverlay` PNG on dedicated pane (z350, below polygons, above basemap), parallel `rainfall_grid.json` for hover | **keep** — correct primitive for the dominant-raster target |
| Overlay legend | `stormgridCumulativeOverlay.js:182-257` | working — colour stops + stats bound to actual metadata (mm) | **keep** |
| Catchment legend | `stormgridCatchmentMap.js:301-339` | working — a **second** legend (Leaflet control) distinct from the overlay legend | **keep**, consolidate |
| Hover/click readout | `stormgridCumulativeOverlay.js:119-136` + `stormgridUi.js:941-964` | working — returns explicit `in_bounds`/`has_coverage`, throttled, "no coverage" surfaced | **keep** |
| Asset circle-marker overlay | `stormgridAssets.js:250-277` | working but tangential — third map layer | **refactor/defer** with the asset subsystem |

The rendering primitives are the right ones. The gap to "map is dominant" is **layout and control sprawl, not capability**: the map is a fixed tile in a long vertical stack, with **two legends** (polygon control vs DOM overlay legend) and **two value-readout systems** (polygon tooltip vs overlay hover). Map layer z-order, bottom→top: CARTO basemap → rainfall overlay PNG (z350) → catchment polygons (z400) → asset markers (default pane).

### 3.6 Exports (slice f)

| Format | `path` | Status | Carries provenance? |
|---|---|---|---|
| CSV | `stormgridExports.js:32-59` | **working** — `#`-comment audit header + 13 columns | yes |
| JSON | `stormgridExports.js:61-64` | **working** — full `buildEventFootprint` | yes (everything) |
| GeoJSON (polygon) | `stormgridExports.js:69-112` | **working** — visible catchments + `properties.stormgrid` + metadata block | yes |
| PNG snapshot | `stormgridExports.js:117-138` | **partial** — html2canvas of DOM; documented SVG fallback does **not** exist (throws) | no (filename only) |
| HTML report | — | **absent** — only a label string `stormgridDefaults.js:124` | n/a |
| PDF report | — | **absent** — no jsPDF/pdfmake, not in CSP | n/a |
| XLSX | — | **absent** — label string only | n/a |
| 12d export | — | **absent** | n/a |
| DRAINS export | — | **absent** | n/a |
| Geospatial raster | — | **absent** — overlay PNG metadata recorded but never exported | n/a |

The **provenance model is strong**: `buildEventFootprint` (`stormgridSnapshot.js:18-265`) is a pure, self-describing object where confidence, coverage, frame counts, calibration reversibility (`raw_max_total_mm`/`calibration_factor`), and per-block methodology disclaimers travel with the data. CSV/JSON/GeoJSON all carry it. But the headline "first-class engineering deliverables" (PDF, HTML, XLSX, 12d, DRAINS) are **entirely greenfield** — present only as goals and one misleading default label that advertises a "Full export pack (HTML, XLSX, CSV, GeoJSON)" that does not exist.

### 3.7 State / caching / dependencies (slice g)

**No shared store, no persistence, no URL state.** `createStormgridState()` is instantiated and fully owned inside the `mountStormgridShell` closure (`stormgridUi.js:90`), mutated via direct setters, pushed to the DOM by one monolithic `render()`. Confirmed absent across `src/`: `localStorage`, `sessionStorage`, `indexedDB`, `location.hash/search`, `history.pushState/replaceState`. The only `URLSearchParams` builds the outbound Nominatim query (`stormgridAddressSearch.js:25`). **Nothing is shareable by link today.**

**Caching that already exists** (three module-level caches, none in state): rainfall windows (`stormgridDataLoader.js:24-25`, with in-flight dedupe), event archive (`stormgridEventArchive.js:21-23`, `eventCache:Map`), and HTTP `force-cache` on archive entries + geocoder. The **"Last 10 Major Events" on-demand-then-cached pattern already exists** (`stormgridUi.js:1094-1106` loads the index then warms up to 12 entries) — but it lives in module globals + a UI closure rather than a shared store.

**Dependency graph is a clean DAG, no cycles.** `stormgridUi.js` is the single sink (imports ~16 modules, owns all state). Secondary hubs: `stormgridSnapshot.js` (imports 5 compute modules; consumed by Exports + UI), `stormgridState.js`, `stormgridArf.js`, `stormgridEventInterpretation.js`. Leaves: State, Defaults, Geo, DataLoader, Arf.

---

## 4. Salvage list (survives the rebuild largely as-is)

These are working, disciplined, and already aligned with the product philosophy:

- **Data pipeline core** — `scripts/build_static_rainfall.py` (areal catchment-mean computation, the methodological heart), `stormgridDataLoader.js` (fetch + cache + dedupe + validation).
- **Gap-honesty surface** — `stormgridAvailability.js` (coverage/confidence/frame-log), `stormgridGeo.js` (confidence + reason + null, never guesses).
- **Methodology core** — `stormgridArf.js`, `stormgridIfdPanel.js`, `stormgridDesignComparison.js`, `stormgridIfdLoader.js`, `scripts/build_catchment_ifd.py` (ARF handling is correct; see §5).
- **Derived-model pattern** — `stormgridReviewModel.js`, `stormgridDefaults.js`, `stormgridEventInterpretation.js` (pure, never invent values).
- **Provenance/export backbone** — `stormgridSnapshot.js` (`buildEventFootprint`) and the working CSV/JSON/GeoJSON writers in `stormgridExports.js`.
- **Map primitives** — Leaflet + CARTO + `L.imageOverlay` PNG raster + `rainfall_grid.json` hover (`stormgridCumulativeOverlay.js`, `stormgridCatchmentMap.js`), the right building blocks for a dominant map.
- **Calibration framework** — `stormgridCalibration.js` (raw-preserving, labelled, versioned), pending real gauge data.

## 5. Rebuild list (replaced or substantially restructured)

- **`mountStormgridShell` (`stormgridUi.js`, 51 KB)** — the monolithic single-function shell is replaced by the layered component architecture of doc 03. This is the central rebuild.
- **State ownership** — lift state out of the UI closure and module globals into a single shared store; add URL-encoding for shareable location+timeframe results (none exists). Keep the existing state *shape* and derived-model pattern.
- **Navigation** — introduce the `Location → Event/Timeframe → Map → Stats → Confidence → Export` flow; collapse the 6-control / 13-panel stack into progressive disclosure with the map dominant.
- **Legends + readouts** — consolidate the two legends and two hover/click systems into one.
- **Event detection + ranking** — restructure toward on-the-fly, location-specific, AEP-threshold-based "Last 10 Major Events" (currently precomputed and ranked by raw mm). **Pending product decision — §7.**
- **Exports** — build PDF/HTML/XLSX/12d/DRAINS on top of the existing footprint model.

## 6. Dead / stale (remove or rewrite)

- **`src/stormgridReadme.md`** — materially false: claims "no real analysis, no fake data, Run disabled," "no network calls," lists only 6 of 26 modules, and describes a `src/modules/stormgrid/` directory layout that does not exist. **Replace or delete** in favour of an accurate readme.
- **Stale labels in live code** — version string `v0-shell` (`stormgridState.js:5`) and header "Stormgrid v0 shell" (`stormgridUi.js:159`); the app has long outgrown "v0 shell."
- **Misleading export docstring** — `stormgridExports.js:116` describes an SVG fallback that does not exist (function throws if html2canvas is absent).
- **Aspirational default label** — `stormgridDefaults.js:124` advertises HTML/XLSX outputs that do not exist.
- **Dual asset pipeline** — the synthetic 77-asset JSON is wired in; the real 24,012-pipe sanitised GeoJSON is built but unreachable. `docs/asset_data_schema.md:136` already flags the synthetic file for "Phase 15B" retirement that never happened. Pick one.
- **Possible dead alias** — `loadStormgridData(url)` back-compat alias (`stormgridDataLoader.js:71`) has no `src/` caller found.

---

## 7. Constraint compliance and code-vs-brief contradictions

The non-negotiable methodology constraints from `STORMGRID_OVERVIEW.md` were checked exhaustively. Results:

**PASS — ARF is not double-applied.** The single highest-risk check. ARF (`computeArf`/`computeArfTable`) is called only from `stormgridIfdPanel.js:149,491`. It multiplies only the **point** IFD design depth: `arfDepthsByAep[p] = v * arf` where `v = ifdRow.aep[p]` from `catchment_ifd_centroid.json`, stamped `point_ifd_only:true, arf_applied:false` (`build_catchment_ifd.py:153-162`). The observed value `obsVal = obs.max_total_mm` (`stormgridIfdPanel.js:140`) — whose lineage is the rolling max of **per-frame catchment means** (`build_static_rainfall.py:362`), i.e. already areal — is passed into the comparison **un-reduced** (`stormgridDesignComparison.js:66`, `ratio = observedMm / ref`). This is the legitimate direction (point IFD → areal, then compared to the already-areal radar mean). Calibration applies a multiplicative bias, never ARF.

**PASS — raw immutability / calibration separation.** `applyCalibration()` operates on a deep clone (`stormgridCalibration.js:270`), preserves `raw_*` and `raw_confidence`, tags method/version. Python builders write fresh files and never mutate input GeoTIFFs.

**PASS — Stormgauge independence.** No Stormgauge imports anywhere in `src/` (grep-confirmed across all slices). All "Stormgauge" occurrences are independence-asserting comments, the stale readme's fictional module list, one cosmetic reason-string (`stormgridDefaults.js:109`), and the `index.html` banner text. No shared shell, no code coupling.

**PASS — no operational-vs-research mode split.** No `mode` field in state. The "operational context" panel is an additive address-first audit trail, not a mode toggle. Raw/Calibrated and overlay Off/On are display toggles, not a workflow fork.

**PASS (with one disclosed nuance) — report gaps, never silently fill.** No hidden interpolation/infill anywhere (`interpolat|infill|fillna|ffill|resample|nan_to_num|impute` returns nothing but a stub comment). No-coverage cells are NaN/transparent, not zero. The one item a methodology reviewer should confirm: in the rolling duration sum, a frame with no valid catchment pixels contributes `0.0` (`build_static_rainfall.py:362`). This is **disclosed** — those frames are counted in `frames_missing`, degrade `coverage_pct`/`confidence`, and are documented (`:341-344`) — but it means a low-confidence window's `max_total_mm` is a **floor**, not the true total, and `stormgridRanking.js` ranks purely by that mm value. Not a hidden violation; a convention worth confirming and surfacing more loudly in any ranking UI.

### Code-vs-brief contradictions (require Mark's resolution before docs 02/03)

These are places where the current code and `STORMGRID_OVERVIEW.md` genuinely diverge. Per the Phase A instruction, they are recorded, not silently resolved:

1. **Data source: brief says BoM radar (primary) + RainViewer (fallback); code has neither.** The entire shipped pipeline is **precomputed, offline, single-source** from a laptop-local **Lizard precipitation archive** (`source: "lizard_precipitation_australia"`, uncalibrated, mm/3 h). BoM/RainViewer fallback exists only as prose in OVERVIEW §5/§8 — **zero implementation** in `src/` or `scripts/`. There is no live radar at all. The cumulative overlay currently ships a **synthetic preview**, not a real radar surface. This contradicts §5 and the §8 Rainfall Aggregation Layer.

2. **"Last 10 Major Events": brief says on-the-fly, location-specific, AEP-threshold-ranked; code is precomputed and ranks by raw mm.** Event detection reads static `duration_stats`; ranking (`stormgridRanking.js`) sorts by `max_total_mm`, not against any IFD/AEP threshold. OVERVIEW §7.6 explicitly wants on-demand computation compared to an AEP threshold.

3. **Engineering outputs: brief says first-class; code has none of the named formats.** PDF, HTML, XLSX, 12d, DRAINS are all absent (CSV/JSON/GeoJSON/PNG only). OVERVIEW §7.5.

Lower-stakes but relevant:
- **ARF coefficients are placeholders.** Shipped East Coast North coefficients are explicit placeholders (`arf_coefficients.json:3-4,20`); golden cases are empty (`arf_golden_cases.json:57`). The engine is verified for *shape*, **not numerical accuracy** against published ARR2019 values, and the UI says so. Any AEP/engineering claim depends on real coefficients + golden data.
- **Asset subsystem scope** — large, synthetic-only, off-core. Recommend Labs-tier (resolve in §8 of doc 02).

---

## 8. Open questions (not answerable from code alone)

- **Is the target data source the precomputed Lizard archive (current reality) or live BoM radar (brief)?** This is the load-bearing decision for docs 02/03 — it changes the UX (freshness, "generate map" latency, gap presentation) and the architecture (build-time batch vs runtime fetch/aggregate).
- **Is on-the-fly event detection wanted now, or is precompute acceptable for the first rebuild pass?** OVERVIEW §7.6 says on-the-fly first, caching later; the code is the inverse.
- **`area_ha` units** — `stormgridUi.js:361` does `area_ha / 100 → km²` as the ARF area input; correct only if the GeoJSON property is genuinely hectares. Confirm against `catchments_dissolved.geojson` properties.
- **ARF coefficient provenance** — real ARR2019 Book 2 values + ≥6 golden cases/region are needed before `verified=true`; may exist in `D:\LIBRARY\00_SOURCE\` (not checked — outside slice scope).
- **Lizard frame units** — the sum assumes each GeoTIFF frame is "mm per 3 h interval"; depends on the upstream Lizard product definition, unconfirmable from code.
- **External dependencies vs static posture** — Nominatim geocoding and CDN Leaflet/html2canvas/CARTO are live calls in an otherwise static/offline app; acceptable for the rebuild?
- **"Last 10 Major Events" cap** — code warms **12**, product says **10**. Canonical number?
- **Real asset snapshot** — ship the 15 MB GeoJSON to the browser as-is, tile it, or keep it Labs-only?

### Containment note (AGENTS.md §1.3 / startup requirement #5)

Three references to paths **outside the four in-scope roots** appear inside source files as **string-literal defaults / provenance metadata / docstrings — not as operation targets**, so per §1.3 cases (c) and (e) they were surfaced, not hard-stopped, and nothing acted on them. Recording them verbatim for Mark:

- `C:\Users\fonzi\Weather App Folder\...` — hardcoded `DEFAULT_PLUVIO_ROOT` and docstring in `scripts/build_catchment_ifd.py:18,44`; the same invocation is echoed in a UI hint at `stormgridIfdPanel.js:73`. (Note: user `fonzi`, not `Mark`.)
- `C:\Users\fonzi\Weather App Folder\Assets\Catchments\...` — `input_geotiff` + `outputs.*` provenance fields in `data/catchments/manifest.json`.
- `D:\Packaging\data\assets_with_coords.csv` — `DEFAULT_SOURCE` in `scripts/build_asset_snapshot.py:44` and `docs/asset_data_schema.md:22`. Under `D:\` but **outside** `D:\PROJECTS\` — still out of scope.

Recommendation: parameterise these to env-var-only (no hardcoded out-of-scope default) during the rebuild.
