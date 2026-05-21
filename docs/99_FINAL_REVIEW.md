# Stormgrid — Final Review (Phase F)

**Date:** 2026-05-21
**Reviewed at:** branch `rebuild/phases-b-to-f` @ commit `0d60628`.
**Method:** three independent read-only reviewers (UX+accessibility, architecture+performance, methodology+export-correctness), run without sight of each other's output, synthesised here and ordered by severity. `npm test` was green for all reviewers. Findings are not minimised; intended prerequisite blocks (P-1/P-2/P-4) are listed separately and are not defects.

**One-line honest verdict:** the architecture, the methodology guardrails, and the export provenance are genuinely sound and tested; the **assembled UI is ~two-thirds wired** — the individual layer components are done, but `app.js` integration leaves the default user path erroring and several main-screen elements as placeholders. This is **not yet a coherent shippable product**, but the foundation it stands on is solid.

---

## What is genuinely solid (verified, tested)

- **Areal-vs-point red line — enforced by types, single tested call site.** The only `applyArf` in the product graph is `src/analysis/aepEstimator.js:136`, applied to the point IFD depth; the observed areal mean is compared directly and can never be ARF-reduced (`applyArf` throws on an areal value). Confirmed independently by two reviewers + the analysis smoke (12/12).
- **AEP placeholder gate (P-1) genuinely suppresses output** before any computation, and is surfaced as "not engineering-defensible" in the chip, methodology panel, event list, and exports.
- **Gap-honesty end to end:** a missing frame is structurally forbidden from carrying a value; `validateWindowResult` reconciles coverage↔frameLog; no `?? 0`/`|| 0` on any depth; map reads "no coverage here", never "0 mm".
- **Provenance travels verbatim** into the footprint and every working export; the HTML/PDF report leads with confidence + methodology + placeholder/synthetic caveats (not just numbers).
- **Architecture is coherent:** unidirectional flow (no component mutates state, no service touches the DOM), a real single store, a clean import DAG, correct three-tier state (incl. URL-encoded shareable context), and clean salvage-by-reuse.
- **`npm test` green:** core 22/22, adapters, aggregation, analysis 12/12, export, ARF shape 5/5 (golden cases intentionally empty → `verified:false`).

---

## Outstanding issues (ordered by severity)

### BLOCKER — must fix before the product is usable

1. **The default Event path dead-ends in ERROR.** Selecting a "Last 10 Major Events" row dispatches `setTimeframe({kind:'event'})` (`src/event/eventSection.js:266`), but the only adapter throws on event timeframes (`src/adapters/lizardArchiveAdapter.js:39-44`) — nothing resolves an event to a window. The documented core loop's default mode (docs/02 §5.2) errors. *Fix:* resolve event→window (the scanner already builds a per-event window object, `eventScanner.js:295` — feed that to the store/`getWindow`), or temporarily default to Manual mode and mark Major-event selection not-yet-functional. (Known: DECISIONS C-009.)

2. **The routed methodology overlay has no CSS.** `app.js` creates `<div class="sg-method-overlay">` but no rule for `.sg-method-overlay` exists in any stylesheet — on open it renders in normal flow at the bottom of the page, not docked beside/over the results column. The methodology surface (a core "always one click away" feature) is visually broken. *Fix:* add absolute/right-docked positioning + z-index for `.sg-method-overlay`.

3. **Top bar ships three "pending" placeholders.** `app.js` never injects `breadcrumb`, `sourceChip`, or `topExport`, so the top bar permanently reads "Data source — pending" / "Export — pending" (`src/shell/workspace.js:91-93`). docs/02 §1/§10.1 specify a live data-source + freshness chip. *Fix:* wire the source/freshness chip (data already exists in the confidence chip) and breadcrumb, or remove the empty slots.

### MAJOR

4. **Layers controls are a non-functional placeholder, but the map depends on them.** The `layers` slot is never injected (shows "Layer controls — pending"), yet `mapHost.js` subscribes to `select.layers` for raster/catchment visibility. The user cannot toggle layers. *Fix:* build a small Layers component dispatching `setLayers`, or remove the slot and document the deferral.

5. **No top-bar / spine confidence mirror.** docs/02 §6 specifies confidence "mirrored as a small chip in the top bar"; only the results-panel chip is mounted (`spineConfidence` stays "pending"). Always-visible holds for the results column only.

6. **No focus management on the methodology surface + near-absent focus-visible styling.** Opening `#methodology` never moves focus in; closing never restores it; only one `:focus` rule exists in all rebuilt CSS (the address input). Keyboard users are stranded. *Fix:* focus the panel on open, restore to the trigger on close, add a global `:focus-visible` outline for `.sg-*` controls; consider `inert` on the background.

7. **Moderate-confidence amber `#E0A030` as text fails WCAG AA (~2.0:1)** on white (`methodology.css:50,174`). *Fix:* use the darker amber already used for the synth badge.

### MINOR

8. **Catchment GeoJSON (6.2 MB) is fetched + parsed twice** (`src/location/locationSection.js:178`, `src/map/layers.js:154`) — the largest main-thread cost on the time-to-first-map path. *Fix:* load once into a shared cache and share the parsed FeatureCollection.

9. **The Event scanner sidesteps the SourceAdapter contract** — it reads the legacy data loaders directly and hard-codes `id:'lizard-archive'` / `isPlaceholder:true` (`eventScanner.js:340-349`). Correct today (the Lizard `listEventCandidates` is a stub) but the one place not consuming only the contract; wrong the moment a second source is active. *Fix when RadarAdapter lands:* route the scan through `source.listEventCandidates()`; meanwhile derive the descriptor from `source.describe()` rather than a literal.

10. **Legacy `src/stormgrid*.js` is dead but un-quarantined** — it still contains live `point × arf` sites (`stormgridIfdPanel.js:182,198,511`, correct direction, unreachable from `app.js`). A re-wiring hazard. *Fix:* prune the provably-unreachable legacy modules (the live-import closure keeps only `stormgridDataLoader`/`stormgridEventArchive`/`stormgridCalibration` + transitive deps; everything else is dead — E-001).

11. **Streaming AGGREGATING is unexercised** — the precomputed Lizard source settles in one resolve, so the streaming-raster UX is modelled but never run; untested until a live/slow adapter exists.

12. **GeoJSON export omits the full per-frame log** (carries missing-frame ISOs + counts; full log is in the JSON export). Note this in its metadata block.

13. **The synthetic preview overlay is the only spatial surface** app-wide (every real `windowResult.raster` is null today). Honestly badged, but the product's centrepiece currently shows placeholder spatial data.

### Claim check — "RadarAdapter needs no downstream change"
**Partially true.** Holds for the window/map/analysis/export consumers (they branch on data, not `source.kind`). **Does not hold** for the Event layer (scanner bypasses the contract, #9) and the real-`windowResult.raster` map draw is written but **unproven** (only the synthetic-preview fallback has been exercised).

---

## Intended prerequisite blocks (not defects — see docs/05)

- **P-1** placeholder ARF coefficients → engineering-grade AEP gated off until real ARR2019 coefficients + golden cases supplied. Gate verified working.
- **P-2** Lizard mm/3h unit assumed under a 0–400 mm/3h sanity guard; vendor confirmation outstanding.
- **P-4** calibration runs on synthetic gauges; output labelled illustrative.
- **P-5/P-6/P-7** XLSX (library+CSP), 12d/DRAINS (format specs), GeoTIFF (encoder+real grid) — honest stubs that refuse, not fake.

## The single biggest outstanding verification
**In-browser behavioural verification was never run** (no browser available this run). Every UI finding above is from static + module-graph + test-suite analysis. The mounted workspace, the map render, the PDF print path, and the BLOCKER items must be confirmed in a real browser before any use. This is the first thing a follow-up session should do.

---

## Recommended next-session order
1. Browser smoke of the mounted app (confirm/triage the BLOCKERs).
2. Fix BLOCKERs 1–3 (event→window resolution; `.sg-method-overlay` CSS; top-bar wiring).
3. MAJORs 4–7 (Layers control; confidence mirror; focus management + focus-visible; amber contrast).
4. MINORs 8–13 as cleanup; prune dead legacy modules (E-001).
5. When ARR2019 coefficients arrive: populate `arf_coefficients.json` + golden cases, flip the P-1 gate, inject IFD/ARF into the event scanner and summary.
