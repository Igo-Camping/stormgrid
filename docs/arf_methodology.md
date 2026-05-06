# Stormgrid — ARR2019 ARF Methodology

This document describes Stormgrid's Areal Reduction Factor (ARF) engine,
the equation form it implements, the coefficient values it ships, the
validity ranges it enforces, and the **verification protocol** the
operator must complete before flipping `verified: true` in
`data/arf_coefficients.json`.

> **Stormgrid does not classify event AEP, does not calculate return
> period, does not assert formal exceedance.** The ARF engine only
> converts published point IFD design depths into ARF-adjusted areal
> design rainfall for catchment-scale comparison.

---

## 1. References

The intended authoritative source is:

- **Australian Rainfall and Runoff (ARR) — A Guide to Flood Estimation,
  2019 edition, Book 2 Chapter 4 ("Areal Reduction Factors"),
  Table 2.4.1** — long-duration ARF coefficients keyed by region
  (East Coast North, East Coast South, Semi-arid SE, Semi-arid SW,
  Tasmania, Southern Temperate, Northern Coast, Inland NSW, …).

The operator must obtain these tables from the ARR website
(<https://arr.ga.gov.au/>) or the published monograph. Stormgrid does
**not** ship the published numbers automatically — it ships placeholder
coefficients and a `verified: false` flag until the operator runs the
verification protocol below.

---

## 2. Equation form (long-duration)

Stormgrid implements the **long-duration** ARR2019 ARF form, valid for
**duration ∈ [24 h, 168 h]** and **catchment area ∈ [1 km², 30 000 km²]**:

```
ARF = min(1,
          1
          − a · A^b · D^(−c)
          + d · A^e · D^(−f) · (0.3 + log10(AEP))
          + g · 10^(h · A · D / 1440) · (0.3 + log10(AEP)))
```

where

| Symbol | Meaning | Units |
|---|---|---|
| A | Catchment area | km² |
| D | Duration | minutes |
| AEP | Annual exceedance probability as a fraction (`0.01` for 1 %) | — |
| a, b, c, d, e, f, g, h | Region-specific coefficients (per ARR2019 Table 2.4.1) | — |

Stormgrid's `computeArf({areaKm2, durationHours, aep, coefficients,
validity})` evaluates this expression, clips the result to `(0, 1]`,
and returns the raw value alongside `valid`/`flags` metadata so the
caller can detect extrapolation (area or duration outside the
documented range).

### Short-duration ARF
ARR2019 publishes a **separate** short-duration ARF form (different
equation, different coefficients) for D ≤ 12 h. Stormgrid currently
**does not implement** the short-duration form. Durations 3 h, 6 h,
and 12 h are flagged `duration_below_validity` and the long-duration
form is **not** silently re-applied — instead the result is clearly
extrapolated with an explanatory note in the UI and an
`extrapolated`-style flag in exports.

When the operator implements the short-duration form, they should add
it as a sibling block in `data/arf_coefficients.json` (`form: "short_duration"`)
and route durations < 12 h through that engine.

### 12 h–18 h gap
ARR2019 has an implicit gap between the short-duration form's upper
limit (12 h) and the long-duration form's lower limit (24 h). Stormgrid
treats 12–24 h as extrapolated for both forms; the operator can
decide to interpolate per the published guidance.

---

## 3. Validity ranges

Configured in `data/arf_coefficients.json → validity`:

| Field | Default | Meaning |
|---|---|---|
| `duration_min_hours` | 24 | Below this the long-duration form is extrapolated. |
| `duration_max_hours` | 168 | Above this the long-duration form is extrapolated. |
| `area_min_km2` | 1 | Below this the long-duration form is extrapolated; ARF approaches 1 anyway. |
| `area_max_km2` | 30 000 | Above this the long-duration form is extrapolated. |

Out-of-range inputs are flagged via `flags: ["area_below_validity",
"duration_below_validity", …]` and the consuming UI marks the row /
banner accordingly.

---

## 4. Verification protocol

The flag `verified: true` may be set in `data/arf_coefficients.json`
**only after every step below succeeds**. Until then, every
ARF-adjusted output in the UI carries the yellow "ARF COEFFICIENTS
UNVERIFIED" banner and the export's `arf_engine.coefficients_verified`
remains `false`.

### Step 1 — Obtain published coefficients
For each region you intend to use, transcribe the eight long-duration
coefficients (a..h) from **ARR2019 Book 2 Chapter 4 Table 2.4.1** into
`data/arf_coefficients.json → regions[<key>].coefficients`. Update
`regions[<key>].source_note` to cite the table (page number, edition
date) and remove the "placeholder" wording.

### Step 2 — Add at least 6 golden cases
Open `tests/fixtures/arf_golden_cases.json`. For each region you've
populated, add at least 6 worked examples taken from the ARR2019
document or the published ARR Data Hub
(<https://data.arr-software.org/>). Each case is a JSON object:

```json
{
  "id": "ECN_24h_5pct_50km2",
  "region": "east_coast_north",
  "area_km2": 50,
  "duration_hours": 24,
  "aep_fraction": 0.05,
  "expected_arf": 0.892,
  "source": "ARR2019 Book 2 Ch. 4 worked example p. XX",
  "tolerance": 0.005
}
```

Tolerance defaults to ±0.005 absolute (≈ 0.5 % ARF). Pick at least:

- 2 cases at **A ≈ 1 km²** (lower validity edge — ARF should be near 1)
- 2 cases at **A ≈ 1 000 km²** (mid-range)
- 2 cases at **A ≈ 10 000 km²** (upper validity edge)

…spread across at least two AEPs and at least two durations.

### Step 3 — Run the test suite
From the repo root:

```bash
node tests/run_arf_golden_tests.mjs
# or
npm run test:arf
```

The runner:

- Loads `data/arf_coefficients.json` and `tests/fixtures/arf_golden_cases.json`.
- Runs **shape tests** (always): ARF ≤ 1, monotonic decrease with area,
  monotonic increase with duration, ARF → 1 as area → 1 km².
- Runs **golden cases** (when populated): for each, calls
  `computeArf` and compares to `expected_arf` with the case's tolerance.
- Reports **max error**, pass/fail counts, exits `0` on pass / `1` on
  any failure.

### Step 4 — Update the verification status
After all tests pass, edit `data/arf_coefficients.json`:

```json
"verified": true,
"verification_status": {
  "last_run_at":         "<ISO timestamp>",
  "shape_tests_passed":  true,
  "golden_cases_passed": <count>,
  "golden_cases_total":  <count>,
  "max_abs_error":       <number>,
  "tolerance":           0.005,
  "regions_verified":    ["east_coast_north", …]
}
```

Commit, push, deploy. The yellow UI banner will disappear and exports
will carry `coefficients_verified: true` plus the `verification_status`
block.

### Step 5 — Periodic re-verification
The operator should re-run the test suite after any coefficient change,
fixture update, or engine refactor. The CI option (Stormgrid does not
ship CI yet) is to run `npm run test:arf` on every PR and fail the
build if it exits non-zero.

---

## 5. What Stormgrid will NEVER claim

Even after `verified: true`, Stormgrid still:

- does **not** classify an event AEP
- does **not** compute a return period
- does **not** use "1 in X" wording
- does **not** assert formal exceedance

ARF-adjusted areal design rainfall is **input** to engineering AEP
classification — not the classification itself. That step is the
responsibility of an engineer using the verified output, not the
Stormgrid UI.
