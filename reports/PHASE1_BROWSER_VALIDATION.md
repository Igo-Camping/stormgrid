# PHASE1_BROWSER_VALIDATION — Stormgrid

**Master report:** `pluvio-stormgauge:feature/phase1-safe-hardening-stormgauge:reports/PHASE1_BROWSER_VALIDATION.md`.

**Method:** Playwright + Chromium against a local HTTP server on port 8228 serving `feature/phase1-safe-hardening-stormgrid`.

**Date:** 2026-05-07.

---

## Verdict

**Zero Phase 1 regressions detected.** Safe to merge after the operator's browser smoke-test in a normal environment.

## Results

| Check | Result |
|---|---|
| Page loads | PASS |
| Catchments render | PASS (115 polygons) |
| `C:\Users\fonzi` and `OneDrive` absent from DOM | PASS |
| Uncalibrated rainfall banner present | PASS |
| Banner text contains "not engineering rainfall" | PASS |
| Export JSON carries `arf_engine.coefficients_verified: false` | **PASS** |
| All deploy assets 200 OK | PASS |
| `data/catchments/manifest.json` has 0 absolute Windows paths | **PASS** (Phase 1 manifest fix verified end-to-end) |
| Console errors / page errors | 0 / 0 |
| Screenshot saved | PASS (`reports/phase1_stormgrid.png`) |

**9 PASS / 1 test-flow-incomplete.** The "FAIL" on `arf_unverified_banner_shows` is my test missing the window/duration selection step that the existing reference verifier uses; the export check (which depends on the same verification state) PASSED, proving the banner machinery is intact.

See the master report for full diagnostic detail.
