#!/usr/bin/env python3
"""Build Stormgrid catchment rainfall JSON from a local Lizard GeoTIFF archive.

Local-only. The Lizard archive itself stays on the operator's laptop — pass
its path with --archive (or set STORMGRID_LIZARD_DIR). Output is the small
JSON the live site reads at /data/catchment_rainfall_*.json.

Reads:
    data/catchments/catchments_dissolved.geojson
    <archive>/raw_payloads/*.tif

Single-window mode (default and back-compat):
    python scripts/build_static_rainfall.py --hours 24 --archive PATH
    python scripts/build_static_rainfall.py --hours 168 --window-name 7d --archive PATH

Standard-windows mode (one frame-pass, multiple JSONs):
    python scripts/build_static_rainfall.py --build-standard-windows --archive PATH
        writes data/catchment_rainfall_24h.json
        writes data/catchment_rainfall_7d.json
        writes data/catchment_rainfall_30d.json
        writes data/catchment_rainfall_latest.json (copy of 24h)

All outputs use schema_version: stormgrid.catchment_rainfall.v2.

Rules:
- No placeholder values. If denominator is unsafe, report null + reason.
- Catchments with zero candidate pixel-frame samples are skipped.
- Missing / unreadable frames are logged and skipped without aborting.
- Does not import Stormgauge code. No AEP/IFD/ARF logic.

Usage:
    python scripts/build_static_rainfall.py [-h] [--hours N] [--window-name N]
        [--end ISO] [--archive PATH] [--build-standard-windows]
"""
import argparse
import glob
import json
import os
import shutil
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import rasterio
from rasterio.mask import mask as rio_mask
from shapely.geometry import shape as shp_shape, mapping as shp_mapping
from shapely.ops import transform as shp_transform
from pyproj import Transformer

REPO            = Path(__file__).resolve().parent.parent
CATCHMENT_PATH  = REPO / 'data/catchments/catchments_dissolved.geojson'
OUT_DIR         = REPO / 'data'

DEFAULT_ARCHIVE = os.environ.get('STORMGRID_LIZARD_DIR', '')

SOURCE_NAME            = 'lizard_precipitation_australia'
SCHEMA_VERSION         = 'stormgrid.catchment_rainfall.v2'
LOW_COVERAGE_THRESH    = 0.70
HIGH_CONFIDENCE_THRESH = 0.90

# Lizard frames are 3-hourly. Durations supported are integer multiples
# of this cadence; 1h-equivalents cannot be derived from 3h data.
FRAME_INTERVAL_HOURS = 3

# Standard window definitions (name, hours).
STANDARD_WINDOWS = [
    ('24h',  24),
    ('7d',   168),
    ('30d',  720),
]
DEFAULT_LATEST_FROM = '24h'  # latest is a copy of this window's output

# Duration sub-windows analysed by rolling N-frame max within each
# parent accumulation window. Supported only when N <= parent frame count.
STANDARD_DURATIONS = [
    ('3h',   3),
    ('6h',   6),
    ('12h',  12),
    ('24h',  24),
    ('48h',  48),
    ('72h',  72),
]


def parse_args():
    ap = argparse.ArgumentParser(description=__doc__.split('\n', 1)[0])
    ap.add_argument('--hours', type=int, default=24,
                    help='Trailing window in hours (default 24)')
    ap.add_argument('--window-name', type=str, default=None,
                    help='Output filename suffix; e.g. 24h, 7d, 30d. '
                         'If omitted, single-window mode writes catchment_rainfall_latest.json.')
    ap.add_argument('--end', type=str, default=None,
                    help='ISO UTC end of window (default: timestamp of latest frame)')
    ap.add_argument('--archive', type=str, default=DEFAULT_ARCHIVE,
                    help='Path to Lizard archive root (containing raw_payloads/). '
                         'Defaults to $STORMGRID_LIZARD_DIR.')
    ap.add_argument('--build-standard-windows', action='store_true',
                    help='Build 24h, 7d, 30d in a single frame pass (also updates latest).')
    return ap.parse_args()


# ──────────────────────────────────────────────────────────────────────────
# IO helpers
# ──────────────────────────────────────────────────────────────────────────

def parse_frame_ts(filename):
    base = os.path.basename(filename)
    return datetime.strptime(base.split('_')[0], '%Y%m%dT%H%M%SZ').replace(tzinfo=timezone.utc)


def load_catchments_in_4326(path):
    with open(path, 'r', encoding='utf-8') as f:
        gj = json.load(f)
    src_crs = (gj.get('metadata', {}) or {}).get('projection_original') or 'EPSG:4326'
    transformer = Transformer.from_crs(src_crs, 'EPSG:4326', always_xy=True)

    def _xform(x, y, z=None):
        return transformer.transform(x, y)

    out = []
    for feat in gj['features']:
        props = feat['properties']
        geom_src = shp_shape(feat['geometry'])
        geom_4326 = shp_transform(_xform, geom_src) if str(src_crs) != 'EPSG:4326' else geom_src
        out.append({
            'id': props['catchment_id'],
            'geom_4326_mapping': shp_mapping(geom_4326),
        })
    return out, str(src_crs)


def collect_frames_window(archive_root, end_dt, hours):
    """Return (frames sorted by ts, start_dt, end_dt) for the requested window."""
    pattern = os.path.join(archive_root, 'raw_payloads', '*.tif')
    paths = sorted(glob.glob(pattern))
    if not paths:
        return [], None, None
    if end_dt is None:
        end_dt = parse_frame_ts(paths[-1])
    start_dt = end_dt - timedelta(hours=hours)
    out = []
    for p in paths:
        try:
            ts = parse_frame_ts(p)
        except Exception:
            continue
        if start_dt <= ts <= end_dt:
            out.append((ts, p))
    return out, start_dt, end_dt


# ──────────────────────────────────────────────────────────────────────────
# Per-(frame, catchment) compact intermediates
# ──────────────────────────────────────────────────────────────────────────

def mask_polygon_to_intermediate(src, geom_4326_mapping, nodata):
    """Return per-(frame, catchment) compact stats: a small dict, never the
    pixel array. None on hard error; zero-row on no overlap."""
    try:
        masked, _ = rio_mask(src, [geom_4326_mapping], crop=True, nodata=nodata, filled=False)
    except (ValueError, rasterio.errors.RasterioError):
        return {'inside': 0, 'valid': 0, 'mean': None, 'min': None, 'max': None}
    arr = masked[0]
    if hasattr(arr, 'mask') and arr.mask is not np.ma.nomask:
        inside_mask = ~arr.mask
        inside_count = int(np.count_nonzero(inside_mask))
        if inside_count == 0:
            return {'inside': 0, 'valid': 0, 'mean': None, 'min': None, 'max': None}
        inside_values = np.asarray(arr.data)[inside_mask]
    else:
        inside_count = int(arr.size)
        inside_values = np.asarray(arr).flatten()

    valid = inside_values[np.isfinite(inside_values)]
    if nodata is not None:
        valid = valid[valid != nodata]
    valid = valid[valid > -1000.0]

    if valid.size == 0:
        return {'inside': inside_count, 'valid': 0, 'mean': None, 'min': None, 'max': None}
    return {
        'inside': inside_count,
        'valid':  int(valid.size),
        'mean':   float(np.mean(valid)),
        'min':    float(np.min(valid)),
        'max':    float(np.max(valid)),
    }


def collect_intermediates(archive_root, end_dt, hours, catchments):
    """Iterate frames in [end - hours, end], compute per-(frame, catchment)
    compact intermediates, return:
      frames: list of (ts, path)
      intermediates: dict[ts -> dict[cid -> stats]]
      (window start_dt, end_dt)
      frames_skipped: int
    """
    frames, start_dt, end_dt = collect_frames_window(archive_root, end_dt, hours)
    intermediates = {}
    frames_skipped = 0
    if not frames:
        return frames, intermediates, start_dt, end_dt, frames_skipped

    cids = [c['id'] for c in catchments]
    for i, (ts, path) in enumerate(frames):
        if i % 50 == 0 or i == len(frames) - 1:
            print(f'[stormgrid]   frame {i+1}/{len(frames)}: {ts.isoformat()}', file=sys.stderr)
        if not os.path.exists(path):
            print(f'[stormgrid]   missing: {path}', file=sys.stderr)
            frames_skipped += 1
            intermediates[ts] = {cid: {'inside': 0, 'valid': 0, 'mean': None, 'min': None, 'max': None}
                                  for cid in cids}
            continue
        try:
            with rasterio.open(path) as src:
                nodata = src.nodata
                row = {}
                for c in catchments:
                    row[c['id']] = mask_polygon_to_intermediate(src, c['geom_4326_mapping'], nodata)
                intermediates[ts] = row
        except Exception as exc:
            print(f'[stormgrid]   error reading {os.path.basename(path)}: {exc}', file=sys.stderr)
            frames_skipped += 1
            intermediates[ts] = {cid: {'inside': 0, 'valid': 0, 'mean': None, 'min': None, 'max': None}
                                  for cid in cids}
    return frames, intermediates, start_dt, end_dt, frames_skipped


# ──────────────────────────────────────────────────────────────────────────
# Window aggregation
# ──────────────────────────────────────────────────────────────────────────

def confidence_for(coverage_fraction, frames_missing):
    if coverage_fraction is None:
        return 'unknown'
    if coverage_fraction < LOW_COVERAGE_THRESH or frames_missing > 0:
        return 'low'
    if coverage_fraction >= HIGH_CONFIDENCE_THRESH:
        return 'high'
    return 'medium'


def compute_duration_stats(ts_in_window, intermediates, cid, duration_hours):
    """Sliding rolling-N-frame max over per-frame catchment means.

    Returns the dict spec'd in Phase 3 — or None when there aren't enough
    frames in the parent window to evaluate the duration.

    Computation is from real per-(frame, catchment) intermediates. Frames
    with no valid pixels contribute 0 to the rolling sum but are counted
    in frames_missing for the chosen sub-window so the result's confidence
    correctly reflects data quality.
    """
    n = duration_hours // FRAME_INTERVAL_HOURS
    if n < 1 or len(ts_in_window) < n:
        return None

    rows = []
    for ts in ts_in_window:
        row = (intermediates.get(ts) or {}).get(cid)
        rows.append(row or {'inside': 0, 'valid': 0, 'mean': None, 'min': None, 'max': None})

    # If no candidate sub-window contains a single inside-pixel, the
    # catchment doesn't overlap the raster anywhere within this window;
    # the per-window aggregation will already have skipped it.
    if all(r['inside'] == 0 for r in rows):
        return None

    means = [r['mean'] if r['mean'] is not None else 0.0 for r in rows]

    # Find argmax of rolling sum of per-frame means (real frame data —
    # never a scaled total).
    n_positions = len(rows) - n + 1
    best_i = 0
    best_sum = float('-inf')
    rolling = sum(means[:n])
    if rolling > best_sum:
        best_sum, best_i = rolling, 0
    for i in range(1, n_positions):
        rolling += means[i + n - 1] - means[i - 1]
        if rolling > best_sum:
            best_sum, best_i = rolling, i

    sub = rows[best_i:best_i + n]
    sub_inside  = sum(r['inside'] for r in sub)
    sub_valid   = sum(r['valid']  for r in sub)
    frames_used = sum(1 for r in sub if r['valid'] > 0)
    frames_missing = n - frames_used
    coverage_fraction = sub_valid / sub_inside if sub_inside > 0 else 0.0

    valid_rows = [r for r in sub if r['valid'] > 0]
    sub_mins = [r['min'] for r in valid_rows if r['min'] is not None]
    sub_maxes = [r['max'] for r in valid_rows if r['max'] is not None]
    sub_means_only_valid = [r['mean'] for r in valid_rows]

    win_start_ts = ts_in_window[best_i]
    win_end_ts   = win_start_ts + timedelta(hours=duration_hours)

    return {
        'max_total_mm':  round(float(best_sum), 4),
        'window_start':  win_start_ts.strftime('%Y-%m-%dT%H:%M:%SZ'),
        'window_end':    win_end_ts.strftime('%Y-%m-%dT%H:%M:%SZ'),
        'mean_mm':       round(float(sum(sub_means_only_valid) / len(sub_means_only_valid)), 4) if sub_means_only_valid else None,
        'min_mm':        round(float(min(sub_mins)), 4) if sub_mins else None,
        'max_mm':        round(float(max(sub_maxes)), 4) if sub_maxes else None,
        'coverage_pct':  round(float(coverage_fraction * 100), 1),
        'frames_used':   int(frames_used),
        'frames_missing': int(frames_missing),
        'confidence':    confidence_for(coverage_fraction, frames_missing),
    }


def aggregate_window(catchments, intermediates, ts_in_window):
    """Aggregate the window's intermediates into a payload-ready dict.
    Returns (payload_catchments, frame_log, frames_used, durations_meta).
    intermediates: dict[ts -> dict[cid -> stats]] (covers a superset)
    ts_in_window: list of timestamps (sorted) within this window's [start, end]"""
    cids = [c['id'] for c in catchments]
    frame_records = []
    frames_used = 0
    frame_count_total = len(ts_in_window)

    # per-catchment accumulators (ints/floats only, no big arrays)
    per_inside  = {cid: 0 for cid in cids}
    per_valid   = {cid: 0 for cid in cids}
    per_means   = {cid: [] for cid in cids}
    per_min     = {cid: None for cid in cids}
    per_max     = {cid: None for cid in cids}
    per_used    = {cid: 0 for cid in cids}
    per_missing = {cid: 0 for cid in cids}
    per_partial = {cid: 0 for cid in cids}

    for ts in ts_in_window:
        row = intermediates.get(ts)
        if row is None:
            # Frame not loaded at all; treat as fully missing for every catchment.
            frame_records.append({
                'timestamp': ts.strftime('%Y-%m-%dT%H:%M:%SZ'),
                'status': 'missing',
                'catchments_with_valid_data': 0,
                'catchments_missing_data': len(cids),
                'notes': 'frame not in intermediates',
            })
            for cid in cids:
                per_missing[cid] += 1
            continue

        per_catch_status = {}
        for cid in cids:
            it = row.get(cid) or {'inside': 0, 'valid': 0, 'mean': None, 'min': None, 'max': None}
            per_inside[cid] += int(it['inside'])
            per_valid[cid]  += int(it['valid'])
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
        if cnt_valid_or_partial == 0:
            frame_status = 'missing'
        elif cnt_missing == 0:
            frame_status = 'valid'
        else:
            frame_status = 'partial'
        notes_parts = []
        if cnt_partial:  notes_parts.append(f'{cnt_partial} partial')
        if cnt_missing:  notes_parts.append(f'{cnt_missing} missing')
        frame_records.append({
            'timestamp': ts.strftime('%Y-%m-%dT%H:%M:%SZ'),
            'status': frame_status,
            'catchments_with_valid_data': cnt_valid_or_partial,
            'catchments_missing_data': cnt_missing,
            'notes': '; '.join(notes_parts),
        })
        if frame_status != 'missing':
            frames_used += 1

    out_catchments = {}
    for cid in cids:
        if per_inside[cid] == 0:
            continue   # no overlap with raster across the entire window — skip
        coverage_fraction = per_valid[cid] / per_inside[cid] if per_inside[cid] > 0 else None
        means = per_means[cid]
        if not means:
            out_catchments[cid] = {
                'total_mm':          None,
                'mean_mm':           None,
                'min_mm':            None,
                'max_mm':            None,
                'sample_count':      0,
                'coverage_fraction': 0.0,
                'coverage_pct':      0.0,
                'frames_used':       0,
                'frames_missing':    int(per_missing[cid]),
                'frames_partial':    int(per_partial[cid]),
                'frame_count':       frame_count_total,
                'confidence':        'low',
            }
            continue

        out_catchments[cid] = {
            'total_mm':          round(float(sum(means)), 4),
            'mean_mm':           round(float(sum(means) / len(means)), 4),
            'min_mm':            round(float(per_min[cid]), 4) if per_min[cid] is not None else None,
            'max_mm':            round(float(per_max[cid]), 4) if per_max[cid] is not None else None,
            'sample_count':      int(per_valid[cid]),
            'coverage_fraction': round(float(coverage_fraction), 4),
            'coverage_pct':      round(float(coverage_fraction * 100), 1),
            'frames_used':       int(per_used[cid]),
            'frames_missing':    int(per_missing[cid]),
            'frames_partial':    int(per_partial[cid]),
            'frame_count':       frame_count_total,
            'confidence':        confidence_for(coverage_fraction, int(per_missing[cid])),
        }

    # ── Duration analysis ────────────────────────────────────────────────
    # Top-level availability is per-window: a duration is available iff
    # the parent window has at least N frames at the 3 h cadence.
    parent_frame_count = len(ts_in_window)
    durations_meta = {}
    for dname, dhours in STANDARD_DURATIONS:
        n = dhours // FRAME_INTERVAL_HOURS
        durations_meta[dname] = {
            'duration_hours': dhours,
            'frame_count': n,
            'available': bool(parent_frame_count >= n),
        }

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


def make_payload(out_catchments, frame_records, start_dt, end_dt, frames_used, durations_meta):
    return {
        'schema_version': SCHEMA_VERSION,
        'generated_at': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'source': SOURCE_NAME,
        'window': {
            'start': start_dt.strftime('%Y-%m-%dT%H:%M:%SZ'),
            'end':   end_dt.strftime('%Y-%m-%dT%H:%M:%SZ'),
            'frame_count': frames_used,
        },
        'quality': {
            'coverage_rule': 'valid pixel-frame samples / candidate pixel-frame samples',
            'low_coverage_threshold':    LOW_COVERAGE_THRESH,
            'high_confidence_threshold': HIGH_CONFIDENCE_THRESH,
            'notes': [
                'Catchments below 70% coverage are flagged and should not be silently averaged.',
                'Rainfall is uncalibrated Lizard precipitation archive output.',
                'Duration max_total_mm is the rolling N-frame maximum within the parent window. Not an AEP, not a design rainfall, no IFD or ARF comparison performed.',
            ],
        },
        'durations': durations_meta,
        'frame_log': frame_records,
        'catchments': out_catchments,
    }


def write_payload(payload, filename):
    raw = json.dumps(payload, separators=(',', ':')).encode('utf-8')
    out_path = OUT_DIR / filename
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_bytes(raw)
    return out_path, len(raw)


# ──────────────────────────────────────────────────────────────────────────
# Main
# ──────────────────────────────────────────────────────────────────────────

def main():
    args = parse_args()
    if not args.archive:
        print('[stormgrid] no archive path. Pass --archive PATH or set $STORMGRID_LIZARD_DIR.', file=sys.stderr)
        sys.exit(2)
    archive_root = os.path.abspath(args.archive)
    if not os.path.isdir(archive_root):
        print(f'[stormgrid] archive not found: {archive_root}', file=sys.stderr)
        sys.exit(2)

    end_dt = None
    if args.end:
        end_dt = datetime.fromisoformat(args.end.replace('Z', '+00:00'))
        if end_dt.tzinfo is None:
            end_dt = end_dt.replace(tzinfo=timezone.utc)

    if not CATCHMENT_PATH.exists():
        print(f'[stormgrid] catchment file missing: {CATCHMENT_PATH}', file=sys.stderr)
        sys.exit(2)

    print(f'[stormgrid] catchments: {CATCHMENT_PATH.relative_to(REPO)}', file=sys.stderr)
    catchments, catchment_src_crs = load_catchments_in_4326(CATCHMENT_PATH)
    print(f'[stormgrid] loaded {len(catchments)} catchments (src CRS: {catchment_src_crs})', file=sys.stderr)
    print(f'[stormgrid] archive: {archive_root}', file=sys.stderr)

    if args.build_standard_windows:
        # ── single frame pass over the largest window, aggregate three ways ──
        max_hours = max(h for _, h in STANDARD_WINDOWS)
        print(f'[stormgrid] building standard windows ({", ".join(n for n, _ in STANDARD_WINDOWS)}); '
              f'pass over last {max_hours} h', file=sys.stderr)
        t0 = time.monotonic()
        frames, intermediates, max_start, max_end, frames_skipped = \
            collect_intermediates(archive_root, end_dt, max_hours, catchments)
        if not frames:
            print(f'[stormgrid] no frames in window under {archive_root}', file=sys.stderr)
            sys.exit(2)
        print(f'[stormgrid] frame pass complete in {time.monotonic() - t0:.1f} s '
              f'({len(frames)} frames, {frames_skipped} skipped)', file=sys.stderr)

        ts_sorted = sorted(intermediates.keys())
        for name, hours in STANDARD_WINDOWS:
            wstart = max_end - timedelta(hours=hours)
            ts_in = [t for t in ts_sorted if wstart <= t <= max_end]
            t0 = time.monotonic()
            out_catchments, frame_records, frames_used, durations_meta = aggregate_window(
                catchments, intermediates, ts_in)
            payload = make_payload(out_catchments, frame_records, wstart, max_end, frames_used, durations_meta)
            out_path, size = write_payload(payload, f'catchment_rainfall_{name}.json')
            print(f'[stormgrid]   {name}: {len(ts_in)} frames, {len(out_catchments)}/{len(catchments)} '
                  f'catchments out, {size/1024:.2f} KB → {out_path.relative_to(REPO)} '
                  f'(agg {time.monotonic() - t0:.2f} s)', file=sys.stderr)

        # latest = copy of DEFAULT_LATEST_FROM
        src_path = OUT_DIR / f'catchment_rainfall_{DEFAULT_LATEST_FROM}.json'
        dst_path = OUT_DIR / 'catchment_rainfall_latest.json'
        shutil.copyfile(src_path, dst_path)
        print(f'[stormgrid]   latest = {DEFAULT_LATEST_FROM} (copied to {dst_path.relative_to(REPO)})',
              file=sys.stderr)

        print('[stormgrid] ----- summary -----', file=sys.stderr)
        print(f'[stormgrid] total runtime:  {time.monotonic() - t0:.1f} s + frame pass', file=sys.stderr)
        print(f'[stormgrid] schema:         {SCHEMA_VERSION}', file=sys.stderr)
        return

    # ── single-window mode ────────────────────────────────────────────────
    frames, intermediates, start_dt, end_dt, frames_skipped = \
        collect_intermediates(archive_root, end_dt, args.hours, catchments)
    if not frames:
        print(f'[stormgrid] no frames in window under {archive_root}', file=sys.stderr)
        sys.exit(2)
    print(f'[stormgrid] window: {start_dt.isoformat()} -> {end_dt.isoformat()} '
          f'({len(frames)} frames, {frames_skipped} skipped)', file=sys.stderr)

    ts_sorted = sorted(intermediates.keys())
    out_catchments, frame_records, frames_used, durations_meta = aggregate_window(
        catchments, intermediates, ts_sorted)
    payload = make_payload(out_catchments, frame_records, start_dt, end_dt, frames_used, durations_meta)

    name = args.window_name or 'latest'
    out_path, size = write_payload(payload, f'catchment_rainfall_{name}.json')
    print(f'[stormgrid] payload: {size/1024:.2f} KB', file=sys.stderr)
    print(f'[stormgrid] schema:  {SCHEMA_VERSION}', file=sys.stderr)
    print(f'[stormgrid] wrote {out_path.relative_to(REPO)}', file=sys.stderr)


if __name__ == '__main__':
    main()
