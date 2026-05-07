# PHASE1_VALIDATION — Stormgrid

**Branch:** `feature/phase1-safe-hardening-stormgrid`.
**Caveat:** Static validation only. Operator must run a browser smoke test before merge.

## Static checks

| Check | Result |
|---|---|
| `data/catchments/manifest.json` parses as valid JSON after edit | ✓ PASS |
| Top-level manifest keys preserved (`generated_at`, `status`, `version`, `is_authoritative`, `source`, `input_geotiff`, `raster`, `parameters`, `feature_counts`, `validation`, `spatial_accuracy`, `fitness_for_use`, `outputs`) | ✓ PASS |
| Tracked occurrences of `C:\Users\fonzi` in manifest after edit | **0** ✓ |
| All other tracked Stormgrid files identical to `origin/main` | ✓ confirmed via `git diff` |
| All synthetic / verified=false flags preserved | ✓ — no data files were modified |
| All warning banners and methodology-honest UI strings preserved | ✓ — no source files were modified |

## Browser smoke test (operator action required)

Open Stormgrid locally and confirm:

- [ ] Catchment map renders.
- [ ] Click-to-analyse still produces a rainfall summary identical to pre-change.
- [ ] ARF panel still shows the unverified-coefficients warning banner.
- [ ] Asset list still shows `is_synthetic: true` banner per record.
- [ ] Address search still works (Nominatim).
- [ ] No new console errors or CSP violations.

## Recommendation

**Safe to merge to `main` after operator confirms the smoke test.** The change is metadata-only on a build provenance file; no runtime path is affected.
