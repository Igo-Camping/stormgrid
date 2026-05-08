#!/usr/bin/env python3
"""Regression fixture for C2/C3 behavior of compute_duration_stats and aggregate_window."""
import sys
from datetime import datetime, timezone, timedelta

FRAME_INTERVAL_HOURS = 3
LOW_COVERAGE_THRESH = 0.70
HIGH_CONFIDENCE_THRESH = 0.90
STANDARD_DURATIONS = [('3h', 3), ('6h', 6), ('12h', 12), ('24h', 24), ('48h', 48), ('72h', 72)]

def confidence_for(cf, fm):
    if cf is None: return 'unknown'
    if cf < LOW_COVERAGE_THRESH or fm > 0: return 'low'
    if cf >= HIGH_CONFIDENCE_THRESH: return 'high'
    return 'medium'

def compute_duration_stats(ts_in_window, intermediates, cid, duration_hours):
    """C2: Only fully-valid windows (all non-None means) are considered for argmax."""
    n = duration_hours // FRAME_INTERVAL_HOURS
    if n < 1 or len(ts_in_window) < n:
        return None
    rows = [
        (intermediates.get(ts) or {}).get(cid) or
        {'inside': 0, 'valid': 0, 'mean': None, 'min': None, 'max': None, 'inside_values': None}
        for ts in ts_in_window
    ]
    if all(r['inside'] == 0 for r in rows):
        return None
    means = [r['mean'] for r in rows]
    n_positions = len(rows) - n + 1
    best_i = None
    best_sum = float('-inf')
    for i in range(n_positions):
        window_means = means[i:i + n]
        if any(m is None for m in window_means):
            continue
        rolling = sum(window_means)
        if rolling > best_sum:
            best_sum, best_i = rolling, i
    if best_i is None:
        return None
    sub = rows[best_i:best_i + n]
    sub_inside = sum(r['inside'] for r in sub)
    sub_valid = sum(r['valid'] for r in sub)
    frames_used = sum(1 for r in sub if r['valid'] > 0)
    frames_missing = n - frames_used
    coverage_fraction = sub_valid / sub_inside if sub_inside > 0 else 0.0
    valid_rows = [r for r in sub if r['valid'] > 0]
    sub_mins = [r['min'] for r in valid_rows if r['min'] is not None]
    sub_maxes = [r['max'] for r in valid_rows if r['max'] is not None]
    sub_means_only_valid = [r['mean'] for r in valid_rows]
    win_start_ts = ts_in_window[best_i]
    win_end_ts = win_start_ts + timedelta(hours=duration_hours)
    return {
        'max_total_mm': round(float(best_sum), 4),
        'window_start': win_start_ts.strftime('%Y-%m-%dT%H:%M:%SZ'),
        'window_end': win_end_ts.strftime('%Y-%m-%dT%H:%M:%SZ'),
        'mean_mm': round(float(sum(sub_means_only_valid) / len(sub_means_only_valid)), 4) if sub_means_only_valid else None,
        'min_mm': round(float(min(sub_mins)), 4) if sub_mins else None,
        'max_mm': round(float(max(sub_maxes)), 4) if sub_maxes else None,
        'coverage_pct': round(float(coverage_fraction * 100), 1),
        'frames_used': int(frames_used),
        'frames_missing': int(frames_missing),
        'confidence': confidence_for(coverage_fraction, frames_missing),
    }

def aggregate_window(catchments, intermediates, ts_in_window):
    """C3: present_total_mm = sum of valid-frame means only (not zero-filled)."""
    cids = [c['id'] for c in catchments]
    frame_records = []
    frames_used = 0
    frame_count_total = len(ts_in_window)
    per_inside = {cid: 0 for cid in cids}
    per_valid = {cid: 0 for cid in cids}
    per_means = {cid: [] for cid in cids}
    per_min = {cid: None for cid in cids}
    per_max = {cid: None for cid in cids}
    per_used = {cid: 0 for cid in cids}
    per_missing = {cid: 0 for cid in cids}
    per_partial = {cid: 0 for cid in cids}
    for ts in ts_in_window:
        row = intermediates.get(ts)
        if row is None:
            frame_records.append({'timestamp': ts.strftime('%Y-%m-%dT%H:%M:%SZ'), 'status': 'missing',
                                   'catchments_with_valid_data': 0, 'catchments_missing_data': len(cids), 'notes': 'frame not in intermediates'})
            for cid in cids:
                per_missing[cid] += 1
            continue
        per_catch_status = {}
        for cid in cids:
            it = row.get(cid) or {'inside': 0, 'valid': 0, 'mean': None, 'min': None, 'max': None}
            per_inside[cid] += int(it['inside'])
            per_valid[cid] += int(it['valid'])
            if it['valid'] > 0:
                per_used[cid] += 1
                per_means[cid].append(float(it['mean']))
                per_min[cid] = it['min'] if per_min[cid] is None else min(per_min[cid], it['min'])
                per_max[cid] = it['max'] if per_max[cid] is None else max(per_max[cid], it['max'])
                frame_cov = it['valid'] / it['inside'] if it['inside'] > 0 else 0.0
                per_catch_status[cid] = 'valid' if frame_cov >= LOW_COVERAGE_THRESH else 'partial'
                if 0.0 < frame_cov < LOW_COVERAGE_THRESH:
                    per_partial[cid] += 1
            else:
                per_missing[cid] += 1
                per_catch_status[cid] = 'missing'
        cnt_valid_or_partial = sum(1 for s in per_catch_status.values() if s in ('valid', 'partial'))
        cnt_partial = sum(1 for s in per_catch_status.values() if s == 'partial')
        cnt_missing = sum(1 for s in per_catch_status.values() if s == 'missing')
        frame_status = 'missing' if cnt_valid_or_partial == 0 else ('valid' if cnt_missing == 0 else 'partial')
        notes_parts = (([f'{cnt_partial} partial'] if cnt_partial else []) + ([f'{cnt_missing} missing'] if cnt_missing else []))
        frame_records.append({'timestamp': ts.strftime('%Y-%m-%dT%H:%M:%SZ'), 'status': frame_status,
                              'catchments_with_valid_data': cnt_valid_or_partial, 'catchments_missing_data': cnt_missing,
                              'notes': '; '.join(notes_parts)})
        if frame_status != 'missing':
            frames_used += 1
    out_catchments = {}
    for cid in cids:
        if per_inside[cid] == 0:
            continue
        coverage_fraction = per_valid[cid] / per_inside[cid] if per_inside[cid] > 0 else None
        means = per_means[cid]
        if not means:
            out_catchments[cid] = {
                'present_total_mm': None, 'mean_mm': None, 'min_mm': None, 'max_mm': None,
                'sample_count': 0, 'coverage_fraction': 0.0, 'coverage_pct': 0.0,
                'frames_used': 0, 'frames_missing': int(per_missing[cid]), 'frames_partial': int(per_partial[cid]),
                'frame_count': frame_count_total, 'confidence': 'low',
            }
            continue
        out_catchments[cid] = {
            'present_total_mm': round(float(sum(means)), 4),
            'mean_mm': round(float(sum(means) / len(means)), 4),
            'min_mm': round(float(per_min[cid]), 4) if per_min[cid] is not None else None,
            'max_mm': round(float(per_max[cid]), 4) if per_max[cid] is not None else None,
            'sample_count': int(per_valid[cid]),
            'coverage_fraction': round(float(coverage_fraction), 4),
            'coverage_pct': round(float(coverage_fraction * 100), 1),
            'frames_used': int(per_used[cid]),
            'frames_missing': int(per_missing[cid]),
            'frames_partial': int(per_partial[cid]),
            'frame_count': frame_count_total,
            'confidence': confidence_for(coverage_fraction, int(per_missing[cid])),
        }
    durations_meta = {}
    for dname, dhours in STANDARD_DURATIONS:
        n = dhours // FRAME_INTERVAL_HOURS
        durations_meta[dname] = {'duration_hours': dhours, 'frame_count': n, 'available': bool(len(ts_in_window) >= n)}
    for cid in list(out_catchments.keys()):
        duration_stats = {}
        for dname, dhours in STANDARD_DURATIONS:
            if not durations_meta[dname]['available']:
                continue
            stat = compute_duration_stats(ts_in_window, intermediates, cid, dhours)
            if stat is not None:
                duration_stats[dname] = stat
        out_catchments[cid]['duration_stats'] = duration_stats
    return out_catchments, frame_records, frames_used, durations_meta

# Fixture: 8 frames at 3h cadence, frame 4 missing
BASE_TS = datetime(2024, 5, 1, 0, 0, 0, tzinfo=timezone.utc)
ts_sequence = [BASE_TS + timedelta(hours=3 * i) for i in range(8)]
frame_means = [2.0, 3.0, 1.0, 4.0, None, 2.0, 3.0, 1.0]
TEST_CATCHMENT_ID = 'test_c1'
intermediates = {}
for ts, mean_val in zip(ts_sequence, frame_means):
    row_stats = {
        'inside': 100, 'valid': (100 if mean_val is not None else 0), 'mean': mean_val,
        'min': (mean_val - 0.5 if mean_val is not None else None),
        'max': (mean_val + 0.5 if mean_val is not None else None),
        'inside_values': None,
    }
    intermediates[ts] = {TEST_CATCHMENT_ID: row_stats}
catchments = [{'id': TEST_CATCHMENT_ID}]

def test_assert(cond, desc):
    s = "PASS" if cond else "FAIL"
    print(f"  [{s}] {desc}")
    return cond

def test_c2():
    print("\n[TEST] compute_duration_stats (C2)")
    p = True
    r = compute_duration_stats(ts_sequence, intermediates, TEST_CATCHMENT_ID, 12)
    p &= test_assert(r is not None, "12h: result not None")
    if r:
        p &= test_assert(r['max_total_mm'] == 10.0, f"12h: max_total_mm=10.0 (got {r['max_total_mm']})")
        p &= test_assert(r['frames_missing'] == 0, f"12h: frames_missing=0 (got {r['frames_missing']})")
    r = compute_duration_stats(ts_sequence, intermediates, TEST_CATCHMENT_ID, 24)
    p &= test_assert(r is None, "24h: result None (no complete window)")
    r = compute_duration_stats(ts_sequence, intermediates, TEST_CATCHMENT_ID, 18)
    p &= test_assert(r is None, "18h: result None (no complete window)")
    r = compute_duration_stats(ts_sequence, intermediates, TEST_CATCHMENT_ID, 6)
    p &= test_assert(r is not None and r['max_total_mm'] == 5.0, f"6h: max_total_mm=5.0 (got {r['max_total_mm'] if r else 'None'})")
    return p

def test_c3():
    print("\n[TEST] aggregate_window (C3)")
    p = True
    out_c, fr, fu, dm = aggregate_window(catchments, intermediates, ts_sequence)
    p &= test_assert(TEST_CATCHMENT_ID in out_c, "Catchment in output")
    if TEST_CATCHMENT_ID not in out_c:
        return False
    cd = out_c[TEST_CATCHMENT_ID]
    p &= test_assert('present_total_mm' in cd, "present_total_mm key exists")
    p &= test_assert(cd['present_total_mm'] == 16.0, f"present_total_mm=16.0 (got {cd['present_total_mm']})")
    p &= test_assert(cd['frames_missing'] == 1, f"frames_missing=1 (got {cd['frames_missing']})")
    p &= test_assert(cd['frames_used'] == 7, f"frames_used=7 (got {cd['frames_used']})")
    expected_mean = 16.0 / 7.0
    p &= test_assert(abs(cd['mean_mm'] - expected_mean) < 0.01, f"mean_mm={expected_mean:.4f} (got {cd['mean_mm']})")
    missing_count = sum(1 for f in fr if f['status'] == 'missing')
    p &= test_assert(missing_count == 1, f"frame_log: 1 missing (got {missing_count})")
    p &= test_assert(cd['confidence'] == 'low', f"confidence='low' (got {cd['confidence']})")
    return p

def main():
    print("=" * 80)
    print("Stormgrid Regression Fixture Harness (C2 & C3)")
    print("=" * 80)
    print(f"\nFixture: 8 frames at {FRAME_INTERVAL_HOURS}h cadence")
    print(f"  Frames: {frame_means} (frame 4 missing)")
    print(f"  Catchment: {TEST_CATCHMENT_ID}")
    print(f"  Window: {ts_sequence[0].isoformat()} to {ts_sequence[-1].isoformat()}")
    results = [("C2: compute_duration_stats", test_c2()), ("C3: aggregate_window", test_c3())]
    print("\n" + "=" * 80)
    print("Summary")
    print("=" * 80)
    for name, p in results:
        print(f"  [{'PASS' if p else 'FAIL'}] {name}")
    all_p = all(p for _, p in results)
    print("\n" + ("All tests passed!" if all_p else "Some tests FAILED!"))
    return 0 if all_p else 1

if __name__ == '__main__':
    sys.exit(main())
                                                                                                                                                                                                                                                             