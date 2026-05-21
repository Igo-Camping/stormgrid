# Stormgrid — Methodology Verification (Phase D)

**Date:** 2026-05-21
**Scope:** Verifies the rebuilt (Phase B/C) code against the non-negotiable methodology constraints. Evidence is concrete: each verdict cites the enforcing code, the test that exercises it, and/or a static check run across `src/`. Where a concern is blocked by a prerequisite (placeholder ARF, unconfirmed Lizard unit, synthetic gauges), the block is stated plainly — no falsified sign-off.

**Method note:** verification leaned on the layers' own executable smoke suites (independent assertions written by the implementing slices) plus static checks (grep across `src/`) run during this phase. **In-browser behavioural verification remains the one outstanding item** (no browser is available on disk this run) — carried to Phase F / a manual pass. The checks below are code-level and test-level, which is what the environment supports.

---

## (i) ARF correctness — never applied to an already-areal catchment mean

**Verdict: PASS — structurally enforced, single call site, tested.**

- The areal-vs-point boundary is a runtime type, not a flag: `applyArf(point, arf)` (`src/core/rainfallTypes.js`) accepts only a `PointDesignDepth` and throws on an `ArealRainfall`. There is no inverse and no `ArealRainfall → PointDesignDepth` path, so an observed mean can never re-enter the ARF path.
- **The only `applyArf` call site in the entire codebase** is `src/analysis/aepEstimator.js:136` — `const arealDesign = applyArf(point, factor)` — applied to the point IFD design depth. (Static check: the only non-comment `applyArf(` usages outside `rainfallTypes.js` are this one call.)
- Static check for any ARF multiplication of an observed/areal/catchment value (`*arf` on `catchmentMean`/`observed`/`mean`): **none found**.
- The observed catchment mean (`windowResult.catchmentMean`, an `ArealRainfall` whose lineage is the already-areal per-frame catchment means, doc 01 §7) is compared **directly** to the ARF-reduced point design depth — never reduced.
- **Test evidence** (`src/analysis/__smoke__.mjs`, 12/12 PASS): "applyArf(observedArealMean, arf) THROWS"; "observed areal mean is unchanged (268 mm) after computeAep"; "applyArf(point 270mm, arf 0.93) = 251.1mm areal (< 270mm point)".

This is the rebuild upholding the guardrail the Phase A audit (doc 01 §7) found the legacy code already honoured — now enforced by types, not convention.

## (ii) AEP estimation — placeholder gate active and correct

**Verdict: PASS for the gate; engineering-grade AEP output BLOCKED on P-1.**

- ARF coefficients are placeholders (`data/arf_coefficients.json`, `D:\LIBRARY\00_SOURCE` empty — B-004). The active `LizardArchiveAdapter.describe()` returns `isPlaceholder: true`.
- `engineeringGradeAllowed(source)` (`src/core/sourceAdapter.js`) returns false under a placeholder source; `computeAep` (`src/analysis/aepEstimator.js`) then returns `{ aepBand: null, gated: true, reason: "ARF coefficients: placeholder — not engineering-defensible" }`. No AEP number is emitted.
- **Test evidence** (analysis smoke): "isPlaceholderTable: unverified → placeholder (gate stays closed); fully verified → engineering-grade"; the ungated path produces only an *indicative* label ("~1% AEP (indicative · point-IFD, ARF-adjusted · not a classification)") with no return-period phrasing.
- Surfaced honestly: the confidence chip and methodology panel show "ARF coefficients: placeholder — not engineering-defensible"; the event scanner labels candidates "AEP indicative unavailable — placeholder coefficients"; exports carry the placeholder flag in the footprint.

**BLOCKED:** engineering-grade AEP is unavailable until P-1 clears (real ARR2019 coefficients + golden cases). This is the intended behaviour, not a defect.

## (iii) IFD basis declarations

**Verdict: PASS.**

- `src/analysis/ifdService.js` loads point IFD per catchment centroid and declares the basis: `arf_applied:false`, point-IFD-only, with the note "ARF is applied downstream to the point side only (applyArf); the observed catchment mean (areal) is never ARF-reduced."
- The methodology panel (`src/methodology/methodologyPanel.js`) renders the IFD station + basis as part of the always-available detail; the confidence chip shows the IFD/ARF basis line. These are faithful reads of the contract/data — the layer adds no numbers of its own.

## (iv) Missing-frame handling — propagates, never silently defaults

**Verdict: PASS in the rebuilt pipeline; one disclosed upstream nuance noted.**

- A missing frame is structurally forbidden from carrying a value: `frameLogEntry({status:'missing', meanMm})` throws unless `meanMm === null` (`src/core/sourceAdapter.js`). Tested: aggregation smoke and the store smoke both assert "zero-fill on missing frame correctly rejected".
- `validateWindowResult` reconciles `coverage.framesMissing` against the count of `missing` frames in the log and rejects a mismatch — a dropped or invented gap fails validation before entering the store.
- The store lands `DEGRADED` (not `SETTLED`) when `coverage.pct < 70` or `framesMissing > 0` (`src/core/store.js`), so a gappy result is never presented as settled.
- The map's hover readout returns "no coverage here" / "outside data extent", never "0 mm" (`src/map/`); the event scanner penalises gappy windows in rank only, preserving raw mm.
- Static check: **no zero-fill (`?? 0` / `|| 0`) on any mean/depth** across `src/core|analysis|aggregation|event|map|export`.

**Disclosed nuance (carried from doc 01 §7, not introduced by the rebuild):** the *offline* builder `scripts/build_static_rainfall.py:362` substitutes `0` for a missing frame's contribution to the rolling sum — disclosed, counted in `frames_missing`, and confidence-degraded there. The rebuilt frontend does not reintroduce this; it consumes the builder's already-computed coverage/frameLog faithfully. Confirming/changing that builder convention is a methodology decision for the data owner, tracked separately.

## (v) Confidence propagation — nothing strips it on the way up

**Verdict: PASS.**

- `confidence`, `coverage`, and `frameLog` are **required** fields of every `RainfallWindowResult`; `validateWindowResult` rejects a result missing any of them, so no adapter can return a confidence-stripped result.
- They travel unchanged: SourceAdapter → store (`select.windowResult`) → methodology renderer (chip + panel render them verbatim, adding nothing) → export footprint (`src/export/footprint.js` copies `source/coverage/confidence/calibration/warnings` verbatim into every export; the export smoke asserts the placeholder flag, `framesMissing`, missing-frame null, and non-authoritative boundary all appear in CSV/JSON/GeoJSON/HTML).
- Calibration preserves `raw_*` and tags method/version (`src/aggregation/calibrationService.js`); a multiplicative bias never alters which frames are missing.

---

## Blocked / asserted prerequisites (no sign-off claimed)

| Ref | Concern | State |
|---|---|---|
| P-1 | ARF coefficients placeholder | **BLOCKED** — engineering-grade AEP gated off until real ARR2019 coefficients + golden cases supplied. Gate verified working. |
| P-2 | Lizard frame unit (mm/3h) | **ASSERTED** — 0–400 mm/3h sanity envelope guards gross unit errors; vendor confirmation outstanding. |
| P-4 | Synthetic gauge data | **ASSERTED/labelled** — calibration framework correct but illustrative until real gauges; output carries 'synthetic-gauges'. |
| — | Synthetic preview overlay | **labelled** (C-011) — the only spatial surface today; badged synthetic, kept out of the validated result path. |
| — | In-browser behavioural verification | **OUTSTANDING** — not exercised this run (no browser); Phase F / manual. |

The methodology layer is **structurally sound and honest** — the red lines are enforced in types and tests, and every not-yet-defensible path is gated and labelled rather than faked. It is **not yet engineering-defensible for AEP output**, by design, until P-1 (and ideally P-2/P-4) clear.
