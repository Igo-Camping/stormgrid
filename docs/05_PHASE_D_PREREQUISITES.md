# Stormgrid — Phase D Methodology Prerequisites

Outstanding items that must be resolved before the methodology/analysis layer can be declared **engineering-defensible**. Until each is cleared, the corresponding output path is either gated off or labelled as not engineering-grade. None of these block the rebuild's structure — they block the *defensibility claim* on numeric output.

Status legend: **BLOCKED** (needs external input that does not exist on disk) · **ASSERTED** (assumption enforced by a runtime guard, pending confirmation) · **CLEARED**.

---

## P-1 — ARF coefficients are placeholders  ·  status: BLOCKED

`data/arf_coefficients.json` carries placeholder values (only `a,b,c` non-zero; `d–h`=0). `D:\LIBRARY\00_SOURCE` is empty — no ARR2019 Book 2 source material on disk to substitute real coefficients.

**Consequence (enforced in code):**
- Coefficients are named `PLACEHOLDER_*` and the table is tagged `is_placeholder: true`.
- Any AEP estimate / engineering-grade output path is gated by a runtime check (`assertEngineeringGradeArf`) that **refuses to emit** while placeholders are active.
- The methodology layer surfaces: *"ARF coefficients: placeholder — not engineering-defensible."*
- The ARF *engine* (shape, clipping, extrapolation flags) remains usable for non-engineering, clearly-labelled illustrative comparison only.

**To clear:** Mark supplies ARR2019 East Coast (and other relevant region) ARF coefficients + ≥6 golden test cases per region. Replace the table, populate `tests/fixtures/arf_golden_cases.json`, run `npm run test:arf` to green, set `is_placeholder: false`. The gate then opens automatically.

---

## P-2 — Lizard frame unit unconfirmed (assumed mm/3h)  ·  status: ASSERTED

The accumulation assumes each Lizard GeoTIFF frame is "mm per 3 h interval." Unconfirmable from disk.

**Consequence (enforced in code):** `LizardArchiveAdapter` runs a per-frame sanity-envelope assertion (plausible mm range per 3 h interval). Gross unit errors (metres vs mm, cumulative vs per-interval) trip the assertion and surface as a data-quality error rather than a silent miscalculation. The assumption is documented at the adapter boundary.

**To clear:** Vendor/product confirmation of the Lizard `lizard_precipitation_australia` frame unit and temporal semantics. On confirmation, record the unit in the SourceAdapter contract and relax/keep the assertion as a regression guard.

---

## P-3 — Catchment polygons are non-authoritative  ·  status: ASSERTED (provenance-labelled)

`catchments_dissolved.geojson` features carry `is_authoritative: false` (raster-derived). This is correctly surfaced today and must remain surfaced in the rebuilt UI and in every export. Not a blocker for analysis, but a permanent provenance label — any engineering output must state the boundary is non-authoritative.

**To clear:** Authoritative catchment boundaries (e.g. council/utility GIS) replace the raster-derived set, flipping `is_authoritative: true`. Out of scope for this run.

---

## P-4 — Calibration runs on synthetic gauge data  ·  status: ASSERTED (labelled)

`data/gauge_observations.json` is `is_synthetic: true`. The calibration framework is correct and raw-preserving, but calibrated output is illustrative until real gauge observations are wired (`build_gauge_observations.py` fetch is a stub). Calibrated output must be labelled "synthetic gauges" until then.

**To clear:** Implement the real gauge fetch (BoM CDO / MHL-WISKI per the stub's TODO) and replace the synthetic file. The refuse-to-fabricate guard in the builder stays.
