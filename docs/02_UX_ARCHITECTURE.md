# Stormgrid — UX Architecture (Phase A, doc 02)

**Date:** 2026-05-21
**Builds on:** `docs/01_CODEBASE_AUDIT.md`. Reflects three Phase-A decisions: (1) **dual data source** — design a source-abstraction boundary so today's precomputed Lizard archive plugs in now and BoM-radar + RainViewer fallback plug in later without re-architecting; (2) **on-the-fly, location-specific "Last 10 Major Events" ranked against an AEP threshold**; (3) **all engineering exports (PDF/HTML/XLSX/12d/DRAINS) are greenfield**, built on the existing `buildEventFootprint` provenance model.

This document defines the screen hierarchy, workflow states, persistent context, map interaction, confidence surfacing, and progressive disclosure. It does not specify components or state technology — that is doc 03.

---

## 1. The core loop is a spine, not a wizard

The agreed workflow is `Location → Event/Timeframe → Aggregated Map → Summary Stats → Confidence → Export`. The current app (`stormgridUi.js:124-240`) presents all of this at once in a vertical stack — the failure mode. The opposite mistake would be a rigid step-by-step wizard that hides the map until the end.

Stormgrid is neither. It is a **single persistent workspace with one dominant map**, where the workflow is a *spine of context* that accumulates down the left, and the map plus its readouts fill the centre and right. The user is always looking at the map; the spine records and lets them change *what the map is showing*.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  TOP BAR:  Stormgrid    [ Location ▸ Event ▸ Map ]  breadcrumb     [Export ▾] │ data-source + freshness chip
├───────────────┬────────────────────────────────────────────┬─────────────────┤
│  CONTEXT      │                                            │  RESULTS         │
│  SPINE        │              MAP (dominant)                │  (stats +        │
│  (left rail)  │                                            │   confidence)    │
│               │   aggregated rainfall raster               │                  │
│  ▸ Location   │   + catchment boundary                     │  Summary stats   │
│  ▸ Event /    │   + single legend (bottom-right)           │  ───────────     │
│    Timeframe  │   + hover readout (follows cursor)         │  Confidence /    │
│  ▸ Layers     │                                            │  methodology     │
│               │                                            │  (always shown)  │
│  [confidence  │                                            │                  │
│   chip]       │                                            │  [Export ▾]      │
└───────────────┴────────────────────────────────────────────┴─────────────────┘
```

Three columns: **context spine (left, ~280–320 px)**, **map (centre, takes all remaining width, full height)**, **results panel (right, ~340–380 px)**. This is a deliberate inversion of today's layout, where the map is a 460 px tile (`stormgrid.css:302-305`) buried in a single column.

---

## 2. Screen hierarchy

There is **one primary screen** (the workspace above) and a small number of secondary surfaces. Stormgrid is not a multi-page app; secondary surfaces are overlays or routed panels *within* the workspace, never replacements for it.

```
Stormgrid
│
├── WORKSPACE  (the primary and almost-always-visible screen)
│     ├── Context spine        (Location, Event/Timeframe, Layers)
│     ├── Map                  (dominant surface)
│     └── Results panel        (Summary stats + Confidence/methodology + Export entry)
│
├── LOCATION PICKER            (overlay/expanded state of the spine's Location section)
├── EVENT / TIMEFRAME PICKER   (overlay/expanded state of the spine's Event section)
│     └── "Last 10 Major Events" list  (on-the-fly, AEP-ranked)
│
├── EXPORT FLOW                (right-anchored panel/drawer; never leaves the workspace)
│
├── METHODOLOGY                (full-detail surface, reachable from any inline confidence chip;
│                               a routed panel, NOT a modal — see §6)
│
└── LABS                       (explicitly separated; houses off-core features:
                                asset-exposure overlay, experimental colour modes,
                                future calibration tooling)
```

**URL-addressable surfaces.** The workspace state that defines a result must be encodable in the URL so a result is linkable (today nothing is — `01 §3.7`). The minimum shareable tuple is `location + timeframe/event + duration + layer/colour mode`. Methodology and Labs are also routable so a link can open directly to "show me the methodology for this result." Export flow is transient and not URL-encoded.

---

## 3. Workflow states

At every moment the workspace is in one of a small set of states. The state determines what the map shows, what the spine offers, and what the results panel says. The guiding rule from the brief — **"report gaps, never silently fill"** — means *every* loading and partial state is explicit; the UI never shows a settled-looking map built from incomplete data without saying so.

```
EMPTY ──select location──▶ LOCATED ──select event/timeframe──▶ AGGREGATING ──▶ SETTLED
  │                           │                                     │             │
  │                           │                              (streams partials)   │
  └─ map: AU/region view      └─ map: catchment framed,       └─ map: raster      └─ map: full raster
     spine: "Select a            boundary drawn, no raster        fades in by         + boundary + legend
     location"                   yet; Event picker open           coverage;           results: stats +
     results: empty-state        results: "Choose a               results: coverage   confidence settled
                                  timeframe or pick from           % climbing,         export: enabled
                                  Last 10 Major Events"            confidence forming
```

State definitions:

- **EMPTY** — no location. Map shows a regional view; spine prompts for location; results panel is an explicit empty state (not a fake zeroed map). Mirrors today's honest empty-state discipline (`stormgridDefaults.js` empty branches, `stormgridReviewModel.js:3` "does not invent values").
- **LOCATED** — a catchment (or point/area) is selected; boundary is drawn and framed; **no rainfall raster yet**. The Event/Timeframe picker becomes the focus. The map is already useful (you can see the catchment), which is why this is not a blank wizard step.
- **AGGREGATING** — a timeframe/event is chosen and the aggregated raster is being produced. Per the dual-source decision this may be a fetch of a precomputed window (fast, the Lizard reality today) or, later, a live radar aggregation (slower). The UI must handle both: a fast settle should not flash a heavy spinner, a slow aggregation must **stream** — raster cells appear as coverage resolves, coverage % and confidence climb visibly, and the frame log fills. This is where gap-honesty is most visible: missing frames are shown forming, not hidden behind a spinner that resolves to a clean map.
- **SETTLED** — aggregation complete. Full raster, boundary, single legend, hover readout live; summary stats and confidence settled; export enabled.
- **DEGRADED** (a settled sub-state, not a separate screen) — aggregation completed but coverage is low (<70%, the existing `stormgridAvailability.js:176` threshold) or frames are missing. The map renders what exists with no-coverage cells transparent (`stormgridCumulativeOverlay.js:119-136`), and the confidence panel leads with the limitation. Export stays enabled but every export carries the degraded provenance (the footprint model already does this).
- **ERROR** — load/aggregation failed. Explicit message, retry affordance; never a silent fallback to stale or fabricated data (`stormgridDataLoader.js` already returns `{ok:false}` rather than throwing or faking).

State transitions are driven by the spine. Changing location from SETTLED returns to LOCATED (raster invalidated, see §4). Changing only the duration or colour mode stays in SETTLED and re-derives without a full reload, because duration stats are already part of the loaded window data.

---

## 4. Persistent context model — what survives, what resets

The brief calls today's state management a core weakness (`01 §3.7`: state stranded in a UI closure and module globals). The rebuild needs an explicit contract for what persists across workflow steps.

```
SURVIVES across steps (the "context")          RESETS / re-derives on change
────────────────────────────────────          ──────────────────────────────
Selected location (catchment / point / area)   Aggregated raster      ← resets when location
Selected timeframe or event                       OR timeframe changes
Selected duration window                        Summary statistics    ← re-derived from raster
Active colour/display mode                      Confidence figures     ← re-derived
Layer visibility (overlay on/off)               Hover readout          ← transient, never persisted
Data source + freshness (which source,          "Last 10 Major Events" ← recomputed per location
   last built, calibration on/off)                 (cached per location, §5)
Recent / saved locations (NEW — none today)     Export selections      ← transient per export
```

**Invalidation rules (explicit, because silent staleness is the enemy):**

- Change **location** → raster, stats, confidence, and the events list all invalidate; timeframe *may* persist if still valid for the new location, otherwise it resets and the UI says so.
- Change **timeframe/event** → raster, stats, confidence invalidate; location persists.
- Change **duration** (within a loaded window) → stats and confidence re-derive from already-loaded data; raster legend updates; no reload. (Duration stats are precomputed per window — `build_static_rainfall.py:335`.)
- Change **colour mode / layer visibility** → pure presentation; nothing invalidates, only the map restyles (`stormgridCatchmentMap.js:207-340`).
- Toggle **calibration (Raw/Calibrated)** → re-derives stats/confidence from the parallel calibrated object; raw is preserved and one keystroke away (`stormgridCalibration.js:270` deep-clone). This is a display state, not a workflow reset.

**New persistence the rebuild introduces** (absent today, `01 §3.7`): recent/saved locations and URL-encoded shareable results. Both are explicitly in the persistent set. Saved locations are the only thing that should outlive a session (localStorage); everything else is reconstructable from the URL + the committed data.

---

## 5. The Location and Event/Timeframe pickers

### 5.1 Location picker

Today three selection paths exist (`01 §3.3`): click a catchment, address→Nominatim→nearest catchment, and a crude `window.prompt` ID override. Area/draw selection and saved locations are absent. The rebuilt picker is the expanded state of the spine's Location section:

```
┌─ LOCATION ──────────────────────────────┐
│ [ 🔍 Search address or place…        ]   │  ← Nominatim, AU-scoped (stormgridAddressSearch.js)
│   ↳ live results, keyboard-navigable     │
│                                          │
│ Or select on map:                        │
│   ◉ Catchment   ○ Point   ○ Area (draw)  │  ← Point/Area are NEW (only catchment+address today)
│                                          │
│ Recent                                   │  ← NEW (no persistence today)
│   • Narrabeen Lagoon catchment           │
│   • 14 Pittwater Rd                      │
│                                          │
│ Selected: Narrabeen Lagoon               │
│   area 1,240 ha · raster-derived         │  ← provenance surfaced inline (is_authoritative:false)
│   ⚠ non-authoritative boundary           │
└──────────────────────────────────────────┘
```

When a location resolves by *nearest-centroid fallback* rather than true containment, the UI must show that it is a geometric guess at `medium` confidence, not a containment hit — `stormgridGeo.js:107-116` already returns the confidence + a human reason; surface it here rather than presenting the auto-selected catchment as certain.

### 5.2 Event/Timeframe picker and "Last 10 Major Events"

Two ways to define what the map aggregates: a **manual timeframe** (window + duration) or a **major event** picked from the on-the-fly list. Per the decision, the events list is **computed on demand for the selected location and ranked against an AEP threshold** — not the current precomputed, raw-mm ranking (`stormgridRanking.js:51`, `01 §3.4`).

```
┌─ EVENT / TIMEFRAME ─────────────────────────────────────┐
│ Mode:  ◉ Major events    ○ Manual timeframe              │
│                                                          │
│ ── Last 10 Major Events (Narrabeen Lagoon) ───────────── │
│  Computing… ▓▓▓▓▓▓░░░░  scanning archive · 6/12 windows  │  ← on-the-fly, streams (§3 AGGREGATING)
│                                                          │
│  #  Date         Dur    Catchment mean   ~AEP band   Conf│
│  1  2022-03-08   24 h   312 mm           ~1% (rare)   ●●●│  ← ranked vs AEP threshold, not raw mm
│  2  2021-03-20   48 h   268 mm           ~2%          ●●○│
│  3  2020-02-09   24 h   201 mm           ~5%          ●●●│
│  …                                                       │
│  ⓘ AEP band is indicative, point-IFD basis, ARF-adjusted │  ← methodology inline, links to §6
│    for areal comparison. Not a formal AEP classification.│
│                                                          │
│ ── Manual timeframe ──────────────────────────────────── │
│  Window: [24h ▾]   ending [2026-05-18 12:00 ▾]           │
│  Duration: [3h][6h][12h][●24h][48h][72h]                 │
└──────────────────────────────────────────────────────────┘
```

Critical UX constraints carried from the methodology (`01 §7`):

- The "~AEP band" column is **indicative and labelled as such**, never a bare return-period number presented as fact. Every interpretation surface in the current code already carries a non-classification disclaimer (`stormgridEventInterpretation.js:159`); preserve that discipline.
- The list **streams** as it computes (the on-demand-then-cached plumbing partly exists — `stormgridUi.js:1094-1106`). First results appear before the full scan finishes; the progress bar is honest about how much of the archive has been scanned.
- A window with **missing frames** must show its confidence and the fact that its catchment-mean is a *floor* (the disclosed zero-fill, `01 §7` nuance, `build_static_rainfall.py:362`). A gappy event must not out- or under-rank a complete one silently.

---

## 6. Inline confidence and methodology — always visible, never modal

This is the product's identity (`OVERVIEW §4.4, §7.7`). Confidence is not a panel you open; it is **always on screen** at two depths, with full detail one click away on a routed surface (never a modal that interrupts the map).

**Depth 1 — the confidence chip (always visible).** A compact, persistent readout in the results panel and mirrored as a small chip in the top bar. It answers "can I rely on this, and why" at a glance:

```
┌─ CONFIDENCE ─────────────────────────┐
│ Confidence:     High        ●●●       │
│ Coverage:       96%   (81/84 frames)  │
│ Data source:    Lizard archive        │  ← source-aware (dual-source decision)
│ Freshness:      built 2026-05-18      │
│ Calibration:    Not applied  [Raw ▾]  │
│ IFD basis:      BoM 2016 / ARR, point │
│ ARF:            applied to IFD only    │  ← states the guardrail that 01 §7 verified
│ Missing frames: 3 of 84   [view log]  │
│                         [Methodology ▸]│
└────────────────────────────────────────┘
```

This is essentially the existing availability panel (`stormgridAvailability.js`) and operational-context audit trail (`stormgridOperationalContextPanel.js`) promoted from buried panels #11–12 to a permanent fixture. The fields adapt to the source: when a future BoM-radar source is active, "Data source: BoM radar (RainViewer fallback: 2 frames)" appears in the same slot — the chip is source-agnostic by design.

**Depth 2 — the Methodology surface (routed, not modal).** Clicking `Methodology ▸` opens a routed panel (URL-addressable, §2) with the full detail: per-frame log, coverage map, IFD station and distance, ARF coefficients and their *unverified* status (`arf_coefficients.json` placeholders, `01 §7`), calibration method and gauge pairing, and the limitations text. It opens beside or over the results column but **the map stays visible** — methodology never blanks the workspace. The "view log" link expands the frame-by-frame valid/partial/missing breakdown that already exists (`stormgridAvailability.js:237-268`).

Rule: nothing that bears on defensibility is ever *only* in a modal or *only* one tooltip deep. The chip is always there; the detail is always one predictable click away.

---

## 7. Map interaction model

The map is the dominant surface, so its interaction model is the product's centre of gravity.

**Layers and z-order** (carried from `01 §3.5`, consolidated):

```
top    ┌─ catchment boundary (selected, highlighted)       z 400
       ├─ aggregated rainfall raster (imageOverlay PNG)     z 350   ← the product
       └─ basemap (CARTO light)                             z 200
bottom
       Labs-only, behind a flag:  asset-exposure markers
```

The current code already orders the rainfall overlay below the polygons so polygon clicks still register and `pointerEvents:'none'` lets hover pass through (`stormgridCumulativeOverlay.js:86-92`) — keep this. The asset-marker layer (`stormgridAssets.js:250`) moves to Labs and is off by default.

**Selection.** Click a catchment to select (drives the spine's Location). In Point mode, click drops a point and resolves to the containing/nearest catchment with confidence (`stormgridGeo.js:77`). In Area mode (new), draw a polygon/bbox. Selection restyles the boundary and frames it (`stormgridCatchmentMap.js:169-197`).

**Hover / click readout — one system, not two.** Today there are two readouts (polygon tooltip + overlay hover) and two legends (`01 §3.5`). Consolidate to **one** cursor-following readout that reports, for the point under the cursor: rainfall depth (mm), whether the point is in-coverage, and the catchment it falls in. Crucially it distinguishes **in-bounds-but-no-coverage** from **out-of-bounds** (the data already carries `in_bounds`/`has_coverage`, `stormgridCumulativeOverlay.js:119-136`) — a no-coverage cell reads "no coverage here," never "0 mm."

**Legend — one, bound to data.** A single legend (bottom-right) whose colour stops and range come from the live data metadata in mm (`stormgridCumulativeOverlay.js:248-252`), not hardcoded. When colour mode changes (rainfall depth / confidence / spatial variability), the legend swaps content in place.

**Future: animation / time scrubber.** Deferred, but the layout reserves a horizontal strip along the map's bottom edge for a frame scrubber. The frame log already exists per window; a scrubber would step through frames. Design note: do not bind the legend or hover readout to a single static frame in a way that blocks later per-frame scrubbing — keep them parameterised by "current frame or accumulated window."

---

## 8. Progressive disclosure rules

The brief's central failure is "too many competing concepts visible at once." The disclosure contract:

```
ON THE MAIN SCREEN (always visible)
  • The map (dominant), boundary, rainfall raster, single legend, hover readout
  • Context spine: current Location, current Event/Timeframe, duration
  • Summary stats (max, mean, area above threshold, indicative AEP)
  • Confidence chip (coverage, source, calibration, missing frames)
  • Export entry point

ONE LEVEL DEEP (expand in place / routed panel, map stays visible)
  • Location picker (search, point/area modes, recent)
  • Event/Timeframe picker + Last 10 Major Events
  • Methodology detail (frame log, IFD station, ARF status, calibration detail)
  • Export flow (format choice + preview)

IN A SIDE PANEL / SECONDARY (available, not competing for primary attention)
  • Per-catchment ranking across the region
  • Event archive / catchment history
  • Calibration controls (beyond the Raw/Calibrated toggle)

IN LABS (explicitly separated, off by default)
  • Asset-exposure overlay and inspection-priority scoring (synthetic today, 01 §3.3)
  • Experimental colour modes beyond the core rainfall ramp
  • Future calibration/QC tooling
```

The decision rule for any feature: *does it serve "analyse the spatial severity of a rainfall event over a catchment" (OVERVIEW §7.2)?* If yes and it is needed to read the current result → main screen. If yes but only sometimes → one level deep. If it answers a different question (asset inspection) → Labs.

The six controls + thirteen panels of today (`01 §2`) collapse into: ~3 always-visible regions, ~4 expand-in-place surfaces, a couple of secondary panels, and a Labs bucket.

---

## 9. Mobile adaptation (deferred — desktop-blocking risks flagged now)

Mobile polish is deferred (`OVERVIEW §7.8`), but two desktop decisions would block a clean mobile pass later and must be made mobile-aware now:

- **Three-column layout.** The spine/map/results triptych cannot survive on a phone. The mobile pass will collapse it to: map full-screen, spine as a top sheet, results/confidence as a bottom sheet. *Desktop-blocking risk:* if the spine and results are built as hard-docked siblings that assume horizontal space, the collapse is a rewrite. **Mitigation:** treat spine and results as overlay-capable regions from the start (they already need overlay behaviour for the pickers, §5) so "dock on desktop, sheet on mobile" is a layout switch, not a re-architecture.
- **Hover-dependent readout.** The single cursor-following readout (§7) has no hover on touch. *Desktop-blocking risk:* binding rainfall readout *only* to `mousemove`. **Mitigation:** drive the readout from a "probe point" abstraction (cursor on desktop, tap on mobile) rather than directly from the mouse event, so the mobile pass swaps the input without touching the readout logic. The current code already throttles and clears on mouseout (`stormgridUi.js:954-963`) — generalise the trigger.

Everything else (confidence chip, legend, pickers) is already panel-shaped and will reflow.

---

## 10. Wireframes (text)

### 10.1 Main map screen — SETTLED state

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ Stormgrid    Location ▸ Event ▸ Map           Lizard archive · built 18 May   [Export ▾]│
├────────────────────┬──────────────────────────────────────────────┬────────────────────┤
│ LOCATION           │                                              │ SUMMARY            │
│  Narrabeen Lagoon  │                                              │  Max     312 mm    │
│  1,240 ha          │                                              │  Mean    268 mm    │
│  ⚠ non-authoritative│            [ aggregated rainfall            │  >200mm  62% area  │
│  [change]          │              raster over catchment           │  ~AEP    ~1% (ind.)│
│                    │              boundary, single legend          │ ─────────────────  │
│ EVENT / TIMEFRAME  │              bottom-right ]                   │ CONFIDENCE         │
│  8 Mar 2022, 24h   │                                              │  High      ●●●     │
│  (Major event #1)  │                                              │  Coverage  96%     │
│  [change]          │                                              │  Source    Lizard  │
│                    │                                              │  Calib.    Raw ▾   │
│ LAYERS             │                                              │  Missing   3/84    │
│  ☑ Rainfall raster │                                  ┌─────────┐ │  [Methodology ▸]   │
│  ☑ Catchment       │                                  │ legend  │ │ ─────────────────  │
│  ☐ (Labs) Assets   │                                  │ 0––312mm│ │  [Export ▾]        │
│                    │   hover: 287 mm · in coverage    └─────────┘ │                    │
└────────────────────┴──────────────────────────────────────────────┴────────────────────┘
```

### 10.2 Location picker — see §5.1.   ### 10.3 Event/Timeframe + Last 10 Major Events — see §5.2.   ### 10.4 Confidence panel — see §6.

### 10.5 Summary stats panel

```
┌─ SUMMARY ──────────────────────────────┐
│ Catchment mean   268 mm                 │  ← areal (already-areal radar/archive mean, 01 §7)
│ Max cell          312 mm                │
│ Min cell          141 mm                │
│ Area > 100 mm     94%                   │
│ Area > 200 mm     62%                   │
│ Spatial CV        0.18  (fairly uniform)│
│ Critical duration 24 h                  │
│ ~AEP (indicative) ~1%   ⓘ point-IFD,    │  ← indicative, links to Methodology, never bare RP
│                         ARF-adj, not a   │
│                         classification   │
└──────────────────────────────────────────┘
```

### 10.6 Export flow

```
┌─ EXPORT ────────────────────────────────────────────────┐
│ This export carries: location, timeframe, all stats,     │
│ coverage %, missing frames, source, calibration status,  │  ← provenance travels (buildEventFootprint)
│ IFD basis, ARF status.  Gaps are reported, not filled.   │
│                                                          │
│ Report                                                   │
│   ○ PDF report (council / insurance)        [greenfield] │
│   ○ HTML report                             [greenfield] │
│ Tabular                                                  │
│   ◉ CSV            ● works today                         │
│   ○ XLSX                                    [greenfield] │
│ Geospatial                                               │
│   ○ GeoJSON (polygons)   ● works today                  │
│   ○ Geospatial raster (GeoTIFF)             [greenfield] │
│ Engineering                                              │
│   ○ 12d export                              [greenfield] │
│   ○ DRAINS export                           [greenfield] │
│ Image                                                    │
│   ○ PNG snapshot   ● works (no embedded provenance)      │
│                                                          │
│              [ Preview ]      [ Download ]               │
└──────────────────────────────────────────────────────────┘
```

The export panel is honest about what is real today (CSV/JSON/GeoJSON/PNG, `01 §3.6`) versus greenfield, and leads with the provenance the output will carry — because a defensible export is the whole point for council and insurance users. As greenfield formats land, the `[greenfield]` markers are removed; the panel structure does not change.

---

## 11. What this UX deliberately removes from the current app

So the rebuild is not just additive, the explicit deletions/demotions from today's shell (`01 §2`):

- The 6-control top strip (window, duration, colour mode, calibration, overlay toggle, address) is **split** between the spine (location, event/timeframe, duration) and the layers/confidence regions — never a flat strip of six.
- The two legends become **one**; the two hover/click readouts become **one** (§7).
- The seven "assumption cards" grid, the separate operational-context panel, calibration panel, overlay legend, infra-exposure, event archive, event summary, frame log, and ranking — the ~13 stacked panels — are redistributed across the disclosure tiers of §8. Most are not on the main screen.
- The asset subsystem and experimental colour modes move to **Labs**.
- "Stormgrid v0 shell" labelling (`stormgridUi.js:159`, `stormgridState.js:5`) is retired.
