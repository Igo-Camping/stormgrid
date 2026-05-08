# Stormgrid Builder Regression Fixtures

Regression test harness for C2/C3 behavior in `scripts/build_static_rainfall.py`.

## Fixture Design

**Synthetic in-memory fixture:**
- 8 sequential frames at 3-hour intervals (24-hour window)
- Frame means: [2.0, 3.0, 1.0, 4.0, None, 2.0, 3.0, 1.0]
- Frame 4 (index 4) has mean=None to represent missing data
- Single catchment with 100 pixels inside raster boundary
- All non-missing frames have 100 valid pixels with the specified mean

## C2 Behavior (compute_duration_stats)

**Key assertion:** Rolling windows are only evaluated when every frame in the window has valid pixel data (non-None mean). Windows containing missing frames are excluded entirely from the rolling maximum calculation.

**Test cases:**
1. 12h duration (4 frames): window [0,1,2,3] all valid, sum=10.0
2. 24h duration (8 frames): only window includes frame 4 (None), result=None
3. 18h duration (6 frames): all 6-frame windows include frame 4, result=None
4. 6h duration (2 frames): multiple valid windows, best=5.0

## C3 Behavior (aggregate_window)

**Key assertion:** `present_total_mm` is the sum of valid-frame means only; missing frames are NOT zero-filled.

**Test case:**
- 8-frame window with 7 valid frames: present_total_mm = 2+3+1+4+2+3+1 = 16.0
- frames_missing = 1
- frames_used = 7
- mean_mm = 16.0 / 7 ≈ 2.2857
- confidence = 'low' (due to frames_missing > 0)

## Running Tests

```bash
python tests/test_builder_fixtures.py
```

Exit code 0 if all assertions pass; 1 otherwise.

## Assertion Count

- C2 tests: 6 assertions
- C3 tests: 8 assertions
- **Total: 14 assertions**

## Design Notes

- Functions are self-contained copies from build_static_rainfall.py to avoid rasterio dependency
- No external files or raster data required
- Tests directly verify the post-C2/C3 implementation without modifying source logic
- Comments include hand-calculated expected values with working shown
