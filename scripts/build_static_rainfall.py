#!/usr/bin/env python3
"""Build Stormgrid catchment rainfall JSON from a local Lizard GeoTIFF archive.

Local-only. The Lizard archive itself stays on the operator's laptop — pass
its path with --archive (or set STORMGRID_LIZARD_DIR). Output is the small
JSON the live site reads at /data/catchment_rainfall_latest.json.

Reads:
    data/catchments/catchments_dissolved.geojson
    <archive>/raw_payloads/*.tif

Writes (compact JSON):
    data/catchment_rainfall_latest.json

Schema v2 ("stormgrid.catchment_rainfall.v2") adds real coverage and
confidence fields per catchment plus a top-level frame_log:

{
  "schema_version": "stormgrid.catchment_rainfall.v2",
  "generated_at": "<ISO UTC>",
  "source": "lizard_precipitation_australia",
  "window": {"start": "<ISO>", "end": "<ISO>", "frame_count": <n>},
  "quality": {
    "coverage_rule": "valid pixel-frame samples / candidate pixel-frame samples",
    "low_coverage_threshold": 0.70,
    "high_confidence_threshold": 0.90,
    "notes": [...]
  },
  "frame_log": [
    {"timestamp", "status", "catchments_with_valid_data",
     "catchments_missing_data", "notes"}
  ],
  "catchments": {
    "<id>": {
      "total_mm", "mean_mm", "min_mm", "max_mm", "sample_count",
      "coverage_fraction", "coverage_pct",
      "frames_used", "frames_missing", "frames_partial", "frame_count",
      "confidence"
    }
  }
}

Rules:
- No placeholder values. If denominator is unsafe, report null + reason.
- Catchments with zero candidate pixel-frame samples (no overlap with the
  raster) are skipped entirely. Catchments with samples but zero valid
  values get coverage_fraction = 0 and confidence = "low".
- Missing / unreadable frames are logged and skipped.

Usage:
    python scripts/build_static_rainfall.py [--hours N] [--end ISO] \\
        [--archive PATH]
"""
import argparse
import glob
import json
import os
import sys
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
OUT_PATH        = REPO / 'data/catchment_rainfall_latest.json'

DEFAULT_ARCHIVE = os.environ.get('STORMGRID_LIZARD_DIR', '')

SOURCE_NAME           = 'lizard_precipitation_australia'
SCHEMA_VERSION        = 'stormgrid.catchment_rainfall.v2'
LOW_COVERAGE_THRESH   = 0.70
HIGH_CONFIDENCE_THRESH = 0.90


def parse_args():
    ap = argparse.ArgumentParser(description=__doc__.split('\n', 1)[0])
    ap.add_argument('--hours', type=int, default=24,
                    help='Trailing window in hours (default 24)')
    ap.add_argument('--end', type=str, default=None,
                    help='ISO UTC end of window (default: timestamp of latest frame)')
    ap.add_argument('--archive', type=str, default=DEFAULT_ARCHIVE,
                    help='Path to Lizard archive root (containing raw_payloads/). '
                         'Defaults to $STORMGRID_LIZARD_DIR.')
    return ap.parse_args()


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


def collect_frames(archive_root, end_dt, hours):
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


def mask_polygon(src, geom_4326_mapping, nodata):
    """Return (inside_count, valid_count, valid_values) for a single (frame, polygon).

    inside_count: pixels inside the polygon (regardless of nodata).
    valid_count:  subset that is finite, not nodata, and not the sentinel.
    valid_values: 1-D ndarray of those valid values (may be empty).
    Raises on errors so caller can record 'error' for that (frame, catchment).
    """
    masked, _ = rio_mask(src, [geom_4326_mapping], crop=True, nodata=nodata, filled=False)
    arr = masked[0]
    if hasattr(arr, 'mask') and arr.mask is not np.ma.nomask:
        inside_mask = ~arr.mask
        inside_count = int(np.count_nonzero(inside_mask))
        if inside_count == 0:
            return 0, 0, np.array([], dtype=arr.dtype)
        inside_values = np.asarray(arr.data)[inside_mask]
    else:
        inside_count = int(arr.size)
        inside_values = np.asarray(arr).flatten()

    valid = inside_values[np.isfinite(inside_values)]
    if nodata is not None:
        valid = valid[valid != nodata]
    valid = valid[valid > -1000.0]
    return inside_count, int(valid.size), valid


def confidence_for(coverage_fraction, frames_missing):
    if coverage_fraction is None:
        return 'unknown'
    if coverage_fraction < LOW_COVERAGE_THRESH or frames_missing > 0:
        return 'low'
    if coverage_fraction >= HIGH_CONFIDENCE_THRESH:
        return 'high'
    return 'medium'


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

    frames, start_dt, end_dt = collect_frames(archive_root, end_dt, args.hours)
    if not frames:
        print(f'[stormgrid] no frames in window under {archive_root}', file=sys.stderr)
        sys.exit(2)
    print(f'[stormgrid] archive: {archive_root}', file=sys.stderr)
    print(f'[stormgrid] window: {start_dt.isoformat()} -> {end_dt.isoformat()} '
          f'({len(frames)} frames)', file=sys.stderr)

    cids = [c['id'] for c in catchments]

    # Per-(catchment, frame) accumulators
    per_inside  = {cid: [] for cid in cids}   # inside-pixel count per frame
    per_valid   = {cid: [] for cid in cids}   # valid-pixel count per frame
    per_pool    = {cid: [] for cid in cids}   # ndarrays of valid pixel values
    per_means   = {cid: [] for cid in cids}   # per-frame catchment mean (only when valid > 0)

    frame_records = []
    frames_used = 0
    frames_skipped = 0

    for ts, path in frames:
        if not os.path.exists(path):
            print(f'[stormgrid]   missing: {path}', file=sys.stderr)
            frames_skipped += 1
            continue

        per_catch_status = {}
        try:
            with rasterio.open(path) as src:
                nodata = src.nodata
                for c in catchments:
                    cid = c['id']
                    try:
                        inside_count, valid_count, valid = mask_polygon(
                            src, c['geom_4326_mapping'], nodata)
                    except (ValueError, rasterio.errors.RasterioError):
                        # Polygon falls outside raster bounds, etc.
                        per_inside[cid].append(0)
                        per_valid[cid].append(0)
                        per_catch_status[cid] = 'missing'
                        continue
                    except Exception as exc:
                        print(f'[stormgrid]   {cid} mask error: {exc}', file=sys.stderr)
                        per_inside[cid].append(0)
                        per_valid[cid].append(0)
                        per_catch_status[cid] = 'missing'
                        continue

                    per_inside[cid].append(inside_count)
                    per_valid[cid].append(valid_count)
                    if valid_count > 0:
                        per_pool[cid].append(valid)
                        per_means[cid].append(float(np.mean(valid)))
                        frame_cov = valid_count / inside_count if inside_count > 0 else 0.0
                        per_catch_status[cid] = 'valid' if frame_cov >= LOW_COVERAGE_THRESH else 'partial'
                    else:
                        per_catch_status[cid] = 'missing'

        except Exception as exc:
            print(f'[stormgrid]   error reading {os.path.basename(path)}: {exc}', file=sys.stderr)
            frames_skipped += 1
            # also append zeros so per-catchment arrays stay aligned with frame count
            for cid in cids:
                if len(per_inside[cid]) < (frames_used + frames_skipped):
                    per_inside[cid].append(0)
                    per_valid[cid].append(0)
                per_catch_status[cid] = 'missing'
            frame_records.append({
                'timestamp': ts.strftime('%Y-%m-%dT%H:%M:%SZ'),
                'status': 'missing',
                'catchments_with_valid_data': 0,
                'catchments_missing_data': len(cids),
                'notes': f'frame read error: {type(exc).__name__}',
            })
            continue

        cnt_valid_or_partial = sum(1 for s in per_catch_status.values() if s in ('valid', 'partial'))
        cnt_partial = sum(1 for s in per_catch_status.values() if s == 'partial')
        cnt_missing = sum(1 for s in per_catch_status.values() if s == 'missing')
        if cnt_valid_or_partial == 0:
            frame_status = 'missing'
        elif cnt_missing == 0:
            frame_status = 'valid'
        else:
            frame_status = 'partial'
        notes = []
        if cnt_partial:
            notes.append(f'{cnt_partial} partial')
        if cnt_missing:
            notes.append(f'{cnt_missing} missing')
        frame_records.append({
            'timestamp': ts.strftime('%Y-%m-%dT%H:%M:%SZ'),
            'status': frame_status,
            'catchments_with_valid_data': cnt_valid_or_partial,
            'catchments_missing_data': cnt_missing,
            'notes': '; '.join(notes),
        })
        frames_used += 1

    # ── Aggregate per catchment ───────────────────────────────────────────
    out_catchments = {}
    frame_count_total = len(frame_records)   # frames considered (incl. errors)

    for cid in cids:
        inside_seq = per_inside[cid]
        valid_seq  = per_valid[cid]
        means      = per_means[cid]
        pool_chunks = per_pool[cid]

        if sum(inside_seq) == 0:
            # No overlap with raster across the whole window — skip entirely.
            continue

        pool = np.concatenate(pool_chunks) if pool_chunks else np.array([])
        if pool.size == 0:
            # We tried, but nothing valid in any frame. Keep the row with
            # explicit zero-coverage so the UI can flag it instead of hiding.
            out_catchments[cid] = {
                'total_mm':          None,
                'mean_mm':           None,
                'min_mm':            None,
                'max_mm':            None,
                'sample_count':      0,
                'coverage_fraction': 0.0,
                'coverage_pct':      0.0,
                'frames_used':       0,
                'frames_missing':    int(sum(1 for v in valid_seq if v == 0)),
                'frames_partial':    0,
                'frame_count':       frame_count_total,
                'confidence':        'low',
            }
            continue

        total_inside = int(sum(inside_seq))
        total_valid  = int(sum(valid_seq))
        coverage_fraction = total_valid / total_inside if total_inside > 0 else None

        frames_used_n    = int(sum(1 for v in valid_seq if v > 0))
        frames_missing_n = int(sum(1 for v in valid_seq if v == 0))
        # per-frame coverage for partial-count
        frames_partial_n = 0
        for ic, vc in zip(inside_seq, valid_seq):
            if ic <= 0 or vc <= 0:
                continue
            cov = vc / ic
            if 0.0 < cov < LOW_COVERAGE_THRESH:
                frames_partial_n += 1

        out_catchments[cid] = {
            'total_mm':          round(float(sum(means)), 4) if means else 0.0,
            'mean_mm':           round(float(sum(means) / len(means)), 4) if means else 0.0,
            'min_mm':            round(float(np.min(pool)), 4),
            'max_mm':            round(float(np.max(pool)), 4),
            'sample_count':      int(pool.size),
            'coverage_fraction': round(float(coverage_fraction), 4) if coverage_fraction is not None else None,
            'coverage_pct':      round(float(coverage_fraction * 100), 1) if coverage_fraction is not None else None,
            'frames_used':       frames_used_n,
            'frames_missing':    frames_missing_n,
            'frames_partial':    frames_partial_n,
            'frame_count':       frame_count_total,
            'confidence':        confidence_for(coverage_fraction, frames_missing_n),
        }

    # ── Top-level payload ─────────────────────────────────────────────────
    payload = {
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
            'low_coverage_threshold':  LOW_COVERAGE_THRESH,
            'high_confidence_threshold': HIGH_CONFIDENCE_THRESH,
            'notes': [
                'Catchments below 70% coverage are flagged and should not be silently averaged.',
                'Rainfall is uncalibrated Lizard precipitation archive output.',
            ],
        },
        'frame_log': frame_records,
        'catchments': out_catchments,
    }

    raw = json.dumps(payload, separators=(',', ':')).encode('utf-8')
    size_kb = len(raw) / 1024
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_bytes(raw)

    print('[stormgrid] ----- summary -----', file=sys.stderr)
    print(f'[stormgrid] frames used:    {frames_used}', file=sys.stderr)
    print(f'[stormgrid] frames skipped: {frames_skipped}', file=sys.stderr)
    print(f'[stormgrid] catchments in:  {len(catchments)}', file=sys.stderr)
    print(f'[stormgrid] catchments out: {len(out_catchments)}', file=sys.stderr)
    print(f'[stormgrid] payload:        {size_kb:.2f} KB', file=sys.stderr)
    print(f'[stormgrid] schema:         {SCHEMA_VERSION}', file=sys.stderr)
    print(f'[stormgrid] wrote {OUT_PATH.relative_to(REPO)}', file=sys.stderr)


if __name__ == '__main__':
    main()
