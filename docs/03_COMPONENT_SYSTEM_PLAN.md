# Stormgrid — Component / System Plan (Phase A, doc 03)

**Date:** 2026-05-21
**Builds on:** `docs/01_CODEBASE_AUDIT.md` and `docs/02_UX_ARCHITECTURE.md`. Carries the three Phase-A decisions: **dual source-abstraction** (Lizard precompute now, BoM-radar + RainViewer later, behind one boundary), **on-the-fly AEP-threshold "Last 10 Major Events"**, **greenfield engineering exports on the existing footprint model**.

This document specifies the component tree, the state model and store technology, data flow, caching, rendering, performance boundaries, and the boundary between Stormgrid and shared Pluviometrics infrastructure.

---

## 1. Architectural shape

The current app is one 51 KB function owning all state in a closure with a monolithic re-render (`stormgridUi.js:84-1156`, `01 §2`). The rebuild keeps the parts that are already good — pure derived-model functions (`stormgridReviewModel.js`, `stormgridDefaults.js`, `stormgridEventInterpretation.js`), a clean data loader with caching (`stormgridDataLoader.js`), and a clean dependency DAG (`01 §3.7`) — and adds the one thing missing: **a single shared store with unidirectional flow**, plus a **source-abstraction boundary** so the data origin can change without touching the UI.

```
                         ┌─────────────────────────────────────────┐
   user action ─────────▶│            STORE (single source)         │
   (select / change)     │  context + workflow state, immutable     │
                         │  updates via dispatch(action)            │
                         └───────────────┬──────────────┬───────────┘
                                         │ notify        │ serialise
                              selectors  │               │   ▼
                                         ▼            URL (History API) ── shareable result
                    ┌────────────────────────────────────────┐
                    │  COMPONENTS (pure render from state)     │
                    │  Shell · Location · Event · Map ·        │
                    │  Analysis · Confidence · Export · Methods│
                    └───────────────┬──────────────────────────┘
                                    │ requests (load window, scan events, aggregate)
                                    ▼
                    ┌────────────────────────────────────────┐
                    │  SERVICES                                │
                    │  SourceAdapter (Lizard | radar later) ── workers
                    │  EventScanner (on-the-fly, AEP)  ── worker
                    │  Analysis (ARF/IFD/stats)  Footprint  Export
                    └──────────────────────────────────────────┘
```

Flow is one-directional: action → store update → selectors → component render → (side-effecting) service request → action with the result → store update. No component mutates state directly; no service writes the DOM. This is the discipline the closure model lacks today.

---

## 2. Component tree

Organised under the architecture layers of `OVERVIEW §8`. For each component: **(new)** or the existing module it is **(salvaged from)** / **(refactored from)** per `01 §4–6`.

```
ShellComponent  (new — replaces mountStormgridShell; owns layout, not state)
│   three regions: ContextSpine | MapStage | ResultsPanel  (02 §1)
│
├── LOCATION LAYER
│   ├── LocationSection            (spine entry; new, wraps existing selection paths)
│   ├── AddressSearch              (salvaged: stormgridAddressSearch.js)
│   ├── MapSelectController        (refactored: catchment-click in stormgridCatchmentMap.js)
│   │      modes: catchment | point | area(draw, NEW)
│   ├── GeoResolver                (salvaged: stormgridGeo.js — confidence+reason, never guesses)
│   └── RecentLocationsStore       (NEW — localStorage; no persistence exists today, 01 §3.7)
│
├── EVENT LAYER
│   ├── EventSection               (spine entry; new)
│   ├── ManualTimeframePicker      (refactored from window/duration selectors in stormgridUi.js)
│   ├── MajorEventsList            (refactored: stormgridRanking.js + stormgridEventArchive.js)
│   │      now ON-THE-FLY + AEP-threshold ranked (decision), streams results (02 §5.2)
│   └── EventWindowDetector        (refactored: stormgridEventWindowDetection.js → worker)
│
├── RAINFALL AGGREGATION LAYER   (the source-abstraction boundary lives here — §8)
│   ├── SourceAdapter (interface)  (NEW — the dual-source seam)
│   │     ├── LizardArchiveAdapter (salvaged: stormgridDataLoader.js + build_static_rainfall.py)
│   │     └── RadarAdapter         (FUTURE — BoM primary + RainViewer fallback; greenfield)
│   ├── FrameQC / CoverageModel    (salvaged: stormgridAvailability.js logic)
│   ├── CumulativeRasterBuilder    (salvaged: build_cumulative_overlay.py [real mode] + frontend overlay)
│   └── CalibrationService         (salvaged: stormgridCalibration.js — raw-preserving, versioned)
│
├── MAP LAYER  (dominant surface, 02 §7)
│   ├── MapStage                   (refactored: stormgridCatchmentMap.js owns the Leaflet instance)
│   ├── BasemapLayer               (CARTO light — index.html / stormgridCatchmentMap.js:126)
│   ├── RainfallRasterLayer        (salvaged: stormgridCumulativeOverlay.js — L.imageOverlay PNG)
│   ├── CatchmentBoundaryLayer     (salvaged: GeoJSON polygons, stormgridCatchmentMap.js:160)
│   ├── MapLegend                  (consolidated — ONE legend, was two; 02 §7)
│   ├── HoverReadout               (consolidated — ONE readout, was two; probe-point abstraction, 02 §9)
│   └── TimeScrubber               (FUTURE placeholder strip; do not block by binding to a single frame)
│
├── ANALYSIS LAYER
│   ├── SummaryStats               (refactored: ranking/availability stats → SummaryStats panel, 02 §10.5)
│   ├── ArfEngine                  (salvaged: stormgridArf.js — point IFD→areal ONLY, 01 §7)
│   ├── IfdService                 (salvaged: stormgridIfdLoader.js + build_catchment_ifd.py — point IFD)
│   ├── DesignComparison           (salvaged: stormgridDesignComparison.js — ratio, no exceedance claim)
│   ├── AepEstimator               (refactored from IfdPanel comparison logic; indicative band, labelled)
│   ├── EventInterpretation        (salvaged: stormgridEventInterpretation.js — pure, non-classifying)
│   └── RegionRanking              (salvaged: stormgridRanking.js — secondary panel, 02 §8)
│
├── EXPORT LAYER
│   ├── FootprintBuilder           (salvaged: stormgridSnapshot.js buildEventFootprint — provenance master)
│   ├── CsvExporter                (salvaged — works, 01 §3.6)
│   ├── JsonExporter               (salvaged — works)
│   ├── GeoJsonExporter            (salvaged — polygon, works)
│   ├── PngSnapshot                (salvaged — fix the phantom fallback, 01 §6)
│   ├── PdfReport / HtmlReport     (GREENFIELD — council/insurance, on FootprintBuilder)
│   ├── XlsxExporter               (GREENFIELD)
│   ├── RasterGeoExporter          (GREENFIELD — GeoTIFF; overlay metadata exists, image never exported)
│   └── TwelveDExporter / DrainsExporter (GREENFIELD — need exact target-format specs, 01 §8)
│
├── METHODOLOGY LAYER  (always-visible chip + routed detail, never modal; 02 §6)
│   ├── ConfidenceChip             (refactored: stormgridAvailability.js + operationalContext → permanent fixture)
│   ├── MethodologyPanel           (routed surface; frame log, IFD station, ARF status, calibration detail)
│   └── FrameLog                   (salvaged: stormgridAvailability.js:237-268)
│
└── LABS  (explicitly separated, off by default; 02 §8)
    ├── AssetExposureOverlay       (demoted: stormgridAssets.js — synthetic today, 01 §3.3)
    └── ExperimentalColourModes    (demoted: extra modes from stormgridCatchmentMap.js)
```

The mapping is deliberately conservative: most components are *salvaged* or *refactored* from existing, working, constraint-compliant code. The genuinely new build is the **store + URL layer**, the **SourceAdapter seam**, the **on-the-fly EventScanner**, and the **greenfield exporters**.

---

## 3. State model — local vs store vs URL

Three tiers, with a clear rule for which tier a piece of state lives in.

### 3.1 URL-encoded (the canonical, shareable result)

The minimum tuple that defines *what the map is showing*, so a link reproduces a result (nothing is URL-encoded today — `01 §3.7`):

```
?loc=<catchmentId | lat,lon | areaGeomRef>
&tf=<event:ID | window:24h@2026-05-18T12:00Z>
&dur=24h
&mode=rainfall            (colour/display mode)
&cal=raw                  (raw | calibrated)
&layers=raster,catchment  (visible layers)
```

The URL is the **serialisation of the context tier** (§3.2). On load, the store hydrates from the URL; on context change, the store writes back via `history.replaceState` (replace, not push, except for "result-defining" changes like location/event which `pushState` so Back works). Methodology and Labs are separate routes (`#methodology`, `#labs`) so a link can deep-open them (`02 §2`).

### 3.2 Shared store (the context + workflow state)

Everything that survives across workflow steps or that more than one component reads (`02 §4` persistence table):

```
context:   location, timeframe/event, duration, colourMode, calibrationMode, layers
workflow:  phase (EMPTY|LOCATED|AGGREGATING|SETTLED|DEGRADED|ERROR)  (02 §3)
data:      rainfallWindow, raster, coverage/confidence, summaryStats, aepBand, eventsList
derived:   (computed by pure selectors from the above — not stored)
```

This is essentially today's `createStormgridState` shape (`stormgridState.js:39-66`) **plus** the runtime state currently stranded in the UI closure and module globals (archive entries, calibration mode, asset filters, overlay state, ranking filters — `01 §3.7`), lifted into one place. Updates are immutable (`dispatch(action) → new state`), enabling cheap change detection and the existing pure derived-model pattern to drive rendering.

### 3.3 Local component state (ephemeral, never persisted)

UI-only, reconstructable, dies with the component: input focus and in-progress text (the address bar already preserves this across re-renders — `stormgridAddressSearch.js`), hover position and the transient hover readout (`02 §7`, never persisted), expanded/collapsed disclosure toggles, export-dialog selections before download.

### 3.4 Store technology recommendation

**Recommendation: a small, hand-rolled observable store module (~100–150 lines), framework-free, plus History-API URL sync. Do not introduce React/Redux or a build step.**

Why:

- The app is a **no-bundler, ES-module, CSP-locked static site** (`index.html:6`, `package.json` has no bundler). Pulling in a framework means a build pipeline, a new CDN entry in the CSP, and a paradigm shift away from the working vanilla modules. That cost is not justified for a single-product, single-author tool.
- The hard part is **already solved**: the pure `state → view-model` transforms (`stormgridReviewModel.js`, `stormgridDefaults.js`, `stormgridEventInterpretation.js`) are exactly the selector pattern a store needs. The store formalises ownership and notification around code that already works.
- A tiny store gives the three things the closure model lacks: a single owner, subscribe/notify so components re-render on the slices they care about (not a full-page re-render), and a serialisable snapshot for the URL layer.

Shape of the store module (new):

```
createStore(initialState) → {
  getState(),
  dispatch(action),          // action → reducer → new immutable state → notify
  subscribe(selector, cb),   // cb fires only when selector(state) changes
  toUrl() / fromUrl()        // context-tier (de)serialisation
}
```

If a build step is ever adopted for other reasons, `nanostores` (≈1 KB, framework-agnostic, atom-based) is the natural drop-in replacement for this hand-rolled store — but it is **not** worth adding a bundler for on its own. Record this as the documented upgrade path, not a now-decision.

---

## 4. Data flow — Location → Event → Aggregation → Map

How a request propagates, and where the boundaries are:

```
1. LOCATION
   user selects catchment/point/area
   → GeoResolver resolves to catchment + confidence (stormgridGeo.js, never guesses)
   → dispatch(setLocation)   store.context.location updated; phase → LOCATED
   → URL pushState(loc=…)
   → MapStage frames boundary; EventSection becomes focus
        ── boundary: store does NOT yet hold a raster ──

2. EVENT / TIMEFRAME
   user picks manual timeframe OR a Major Event
   (a) Major Events list was requested on LOCATED via EventScanner (worker, §5/§7),
       streaming AEP-ranked candidates into store.data.eventsList
   → dispatch(setTimeframe)  phase → AGGREGATING
   → URL pushState(tf=…, dur=…)

3. AGGREGATION                          ◀── THE SOURCE-ABSTRACTION BOUNDARY (§8)
   → SourceAdapter.getWindow(location, timeframe, duration)
        LizardArchiveAdapter today: fetch precomputed window JSON (stormgridDataLoader.js, cached)
        RadarAdapter later: aggregate frames → raster (worker), same return contract
   → returns { rasterRef, coverage, confidence, frameLog, durationStats }  (uniform shape)
   → FrameQC/CoverageModel annotates; CalibrationService optionally derives calibrated copy
   → dispatch(setWindowData)  phase → SETTLED (or DEGRADED if coverage<70%)

4. MAP + ANALYSIS (derived, no new fetch)
   selectors compute from store.data:
   → RainfallRasterLayer draws the imageOverlay PNG; MapLegend binds to data range
   → SummaryStats: max/mean/area-above-threshold (areal mean — already-areal, no ARF here)
   → AepEstimator: ArfEngine(point IFD)→areal, DesignComparison vs observed areal mean
       ── ARF applied to IFD ONLY; observed mean never ARF-reduced (01 §7 guardrail) ──
   → ConfidenceChip: coverage, source, calibration, missing frames (always visible)
```

**Boundaries that matter:**

- **SourceAdapter** is the seam between "where rainfall comes from" and "everything downstream." Steps 4 onward never know whether the raster came from a precomputed Lizard window or a live radar aggregation — they consume the uniform return contract. This is what makes "Lizard now, radar later" a plug-in rather than a rewrite (the decision).
- **Areal-vs-point boundary** is enforced in the Analysis layer: the observed catchment mean (areal) and the point IFD (ARF-reduced to areal) only meet inside `DesignComparison`, and only the IFD side is ever multiplied by ARF. This is the single most important methodological boundary (`01 §7`) and it must remain a hard rule in any refactor.
- **Render boundary**: services return data, components render from store selectors. A service never touches Leaflet or the DOM; a component never fetches.

---

## 5. Caching strategy

Three tiers, matching the data's volatility:

```
COMPUTE ON DEMAND (never pre-warmed)
  • Aggregated raster for a (location, timeframe, duration) not yet requested
  • Summary stats, AEP band, confidence  — pure selectors, recomputed from store, effectively free

CACHE PER SESSION (in-memory, dies on reload)
  • Rainfall windows by key            (exists: stormgridDataLoader.js:24-25, + in-flight dedupe)
  • Event-scan results per location    (exists partially: stormgridEventArchive.js eventCache)
  • Resolved geo lookups
  These live IN THE STORE / service caches, not in module globals (lift from 01 §3.7)

PERSISTED (localStorage, survives reload)
  • Recent / saved locations only       (NEW — nothing persists today)
  • Everything else is reconstructable from URL + committed data, so nothing else persists
```

**"Last 10 Major Events" placement (per the on-the-fly decision):** it is **on-demand first** — computed by the EventScanner when a location is selected, streaming results into the store (`02 §5.2`). Caching is a *later optimisation*, layered as: (1) session cache keyed by location (the partial plumbing already exists, `stormgridUi.js:1094-1106`), then (2) optional persisted cache keyed by `location + archive-version` once the on-demand path is proven. The architecture must make on-demand correct first; the cache is a transparent accelerator that never changes results. This ordering is explicit in `OVERVIEW §7.6`.

Cache-invalidation rule: any cache keyed on archive/source content must include a **source + build-version** in its key, so re-running a builder (new committed JSON) or switching source (Lizard→radar) cannot serve stale results. This guards the "never silently fill / never silently stale" principle at the cache layer.

---

## 6. Rendering strategy — map and raster

**The map.** Leaflet 1.9.4 + CARTO basemap, kept (`01 §3.5`). One `MapStage` owns the single Leaflet instance; layers are added/removed by reference, never by re-creating the map. Catchment boundaries are GeoJSON vector layers (cheap, 35 features). Restyling (colour mode, selection) mutates layer style in place (`stormgridCatchmentMap.js:207-340`) — no re-fetch, no re-mount.

**The aggregated raster.** Rendered as a single georeferenced **`L.imageOverlay` PNG** plus a parallel `rainfall_grid.json` for hover lookup (`stormgridCumulativeOverlay.js:86-108`). This is the right primitive and is kept: one image draw is cheap, the grid lookup is O(1) per hover. The PNG is produced **off the main thread**:

- **Today (Lizard):** the PNG is built offline by `build_cumulative_overlay.py` and fetched — zero client render cost beyond the image draw.
- **Later (radar):** the RadarAdapter aggregates frames into a raster. This is the heavy operation and belongs in a **Web Worker** (optionally `OffscreenCanvas` for the rasterisation), posting back a PNG/ImageBitmap + grid. The MapStage just draws the result. The imageOverlay contract is identical regardless of source.

**Streaming render (AGGREGATING state, `02 §3`).** When aggregation is slow (radar), the raster fades in by coverage and the confidence/frame-log climb visibly rather than blocking behind a spinner. With precomputed Lizard windows the settle is fast enough to skip the heavy progressive animation — the renderer chooses based on how long the adapter takes, so a fast settle does not flash a loader.

**Worker boundary summary** — what moves off the main thread:

```
main thread:   DOM, Leaflet, store, selectors, image draw, O(1) hover lookup  (all cheap)
worker:        EventScanner (scan many windows × AEP comparison)               (§7)
worker:        RadarAdapter aggregation (frames → raster) — FUTURE
worker(opt):   XLSX/PDF generation for large reports — if they prove to block  (§7)
```

---

## 7. Performance boundaries

Budgets the rebuild is held to. "Block" = freezes the main thread / the map; "stream" = partial results land progressively and the UI stays interactive.

```
ACTION                                  BUDGET            BLOCK or STREAM
─────────────────────────────────────   ───────────────   ───────────────
Draw catchment boundary after select    ≤ 200 ms          may block (cheap, 35 features)
Time-to-first-map (precomputed window)  ≤ 1.5 s typical   STREAM (raster fades in)
                                         ≤ 3 s worst case
Time-to-first-map (future radar agg.)   first cells ≤ 3 s STREAM (worker; never blocks)
                                         full ≤ 10 s
Last 10 Major Events — first result     ≤ 1.5 s           STREAM (worker, 02 §5.2)
Last 10 Major Events — full list        ≤ 5 s on-demand   STREAM
                                         (cached: ≤ 200 ms)
Colour-mode / duration change           ≤ 150 ms          may block (pure re-derive)
Hover readout update                    ≤ 16 ms/frame     never blocks (throttled, exists
                                                            stormgridUi.js:954-959)
Export: CSV/JSON/GeoJSON                 ≤ 500 ms          may block (small)
Export: PDF/XLSX (large report)          ≤ 3 s             STREAM/worker if it blocks
```

Hard rules:
- **Nothing that scans the archive or aggregates frames runs on the main thread.** The EventScanner and the future RadarAdapter are workers. This is the difference between an interactive map and a frozen one.
- **The map is never blocked by analysis.** Summary stats, AEP estimation, and confidence are pure selectors over already-loaded data — fast — but if any proves heavy it moves to a worker too, behind the same store-dispatch contract.
- **A slow source must degrade visibly, not silently.** If an adapter exceeds its budget, the AGGREGATING state stays honest (coverage climbing, frame log filling) rather than showing a spinner that hides whether data is missing.

---

## 8. The source-abstraction boundary (dual-source decision)

The single most important new boundary. Defined as one interface that both the current Lizard pipeline and a future radar pipeline implement:

```
interface SourceAdapter {
  describe()  → { id, label, kind: 'precomputed'|'live', buildVersion, lastBuilt }
  getWindow(location, timeframe, duration)
        → {
            rasterRef,        // imageOverlay PNG + grid (uniform regardless of source)
            coverage,         // % + frame-level: used / partial / missing
            confidence,       // tier + reasons
            frameLog,         // per-frame valid/partial/missing (gap honesty)
            durationStats,    // rolling critical-duration stats
            source            // { id, kind, buildVersion } — travels into the footprint/exports
          }
  listEventCandidates(location, aepThreshold)   // feeds EventScanner / Major Events
}
```

Implementations:

- **`LizardArchiveAdapter` (now)** — wraps `stormgridDataLoader.js` + the committed output of `build_static_rainfall.py`. `kind:'precomputed'`, `lastBuilt` from the file. Fast, offline, uncalibrated, single-source — exactly today's reality (`01 §7` contradiction #1), now behind the seam instead of assumed throughout.
- **`RadarAdapter` (future, greenfield)** — BoM radar primary, RainViewer fallback (`OVERVIEW §5`). `kind:'live'`. Aggregation runs in a worker (§6). Fallback is **labelled in `source`**, never silently substituted ("fallback never means pretend the source is identical" — `OVERVIEW §5`). Returns the same contract, so no downstream component changes.

Because `source` travels in the return contract and into `buildEventFootprint` (`stormgridSnapshot.js`), every stat, confidence figure, and export automatically states which source produced it — the dual-source design and the "defensible output" requirement reinforce each other. The ConfidenceChip's "Data source" field (`02 §6`) reads straight off `describe()`/`source`.

---

## 9. Stormgrid ↔ Pluviometrics infrastructure boundary

**Stormgauge is not a dependency, and the audit confirms it currently is not** (`01 §7`: no Stormgauge imports anywhere in `src/`; all references are independence-asserting comments or banner text). The rebuild preserves this hard boundary:

```
ALLOWED to share with the wider Pluviometrics ecosystem
  • Branding / static assets (logos in PLUVIOMETRICS_HUB)        — read-only, copied, not imported
  • Domain conventions (AEP/IFD/ARF terminology, AU units)       — conceptual, not code
  • Host-page-level integration (hub nav, auth) IF it ever exists — injected at index.html,
                                                                     not imported into Stormgrid modules

FORBIDDEN
  • Importing any Stormgauge JS module (AEP/IFD/station/radar/export logic)
  • A shared UI shell or shared map instance with Stormgauge
  • A shared runtime store across products
  • Any code path that makes Stormgrid's behaviour depend on Stormgauge being present
```

Rule for any future "shared Pluviometrics infrastructure": it enters Stormgrid only as **data or configuration injected at the host-page boundary** (`index.html`), or as a **separately-versioned static asset**, never as a direct module import that couples the two products' internals. The existing read-only map-context handshake (`window.__stormgrid.map`, `stormgridMapBridge.js:27-73`) is the correct pattern for any such integration: a defensive, null-safe, no-import handshake — not a shared dependency.

The seven architecture layers (§2) are the natural parallel-build seams for Phase B/C: Location, Event, Aggregation, Map, Analysis, Export, Methodology are independent enough to be implemented by separate sessions against the store contract, merging at the store and the SourceAdapter interface.
