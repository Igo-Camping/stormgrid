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

Schema:
{
  "generated_at": "<ISO UTC>",
  "source": "lizard_precipitation_australia",
  "window": {"start": "<ISO>", "end": "<ISO>", "frame_count": <n>},
  "catchments": {
    "<catchment_id>": {
      "total_mm":     <sum of per-frame catchment means>,
      "mean_mm":      <average per-frame catchment mean>,
      "min_mm":       <min pixel-frame value>,
      "max_mm":       <max pixel-frame value>,
      "sample_count": <pixel-frame count>
    }
  }
}

Rules:
- No placeholder values. Catchments with zero valid samples are skipped.
- Missing / unreadable frames are logged and skipped (script does not abort).

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

SOURCE_NAME     = 'lizard_precipitation_australia'


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


def valid_pixels(arr, nodata):
    if hasattr(arr, 'mask'):
        flat = arr.compressed()
    else:
        flat = arr.flatten()
        if nodata is not None:
            flat = flat[flat != nodata]
    flat = flat[np.isfinite(flat)]
    flat = flat[flat > -1000.0]
    return flat


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

    per_catch_pool        = {c['id']: []  for c in catchments}
    per_catch_frame_means = {c['id']: [] for c in catchments}

    frames_used = 0
    frames_skipped = 0
    for ts, path in frames:
        if not os.path.exists(path):
            print(f'[stormgrid]   missing: {path}', file=sys.stderr)
            frames_skipped += 1
            continue
        try:
            with rasterio.open(path) as src:
                nodata = src.nodata
                for c in catchments:
                    try:
                        masked, _ = rio_mask(src, [c['geom_4326_mapping']],
                                             crop=True, nodata=nodata, filled=False)
                        flat = valid_pixels(masked[0], nodata)
                    except (ValueError, Exception):
                        continue
                    if flat.size == 0:
                        continue
                    per_catch_pool[c['id']].append(flat)
                    per_catch_frame_means[c['id']].append(float(np.mean(flat)))
        except Exception as exc:
            print(f'[stormgrid]   error reading {os.path.basename(path)}: {exc}', file=sys.stderr)
            frames_skipped += 1
            continue
        frames_used += 1

    out_catchments = {}
    for cid in (c['id'] for c in catchments):
        means = per_catch_frame_means[cid]
        pool_chunks = per_catch_pool[cid]
        if not means or not pool_chunks:
            continue
        pool = np.concatenate(pool_chunks)
        if pool.size == 0:
            continue
        out_catchments[cid] = {
            'total_mm':     round(float(sum(means)),     4),
            'mean_mm':      round(float(sum(means) / len(means)), 4),
            'min_mm':       round(float(np.min(pool)),  4),
            'max_mm':       round(float(np.max(pool)),  4),
            'sample_count': int(pool.size),
        }

    payload = {
        'generated_at': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'source': SOURCE_NAME,
        'window': {
            'start': start_dt.strftime('%Y-%m-%dT%H:%M:%SZ'),
            'end':   end_dt.strftime('%Y-%m-%dT%H:%M:%SZ'),
            'frame_count': frames_used,
        },
        'catchments': out_catchments,
    }

    raw = json.dumps(payload, separators=(',', ':')).encode('utf-8')
    size_kb = len(raw) / 1024
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_bytes(raw)

    print('[stormgrid] ────── summary ──────', file=sys.stderr)
    print(f'[stormgrid] frames used:    {frames_used}', file=sys.stderr)
    print(f'[stormgrid] frames skipped: {frames_skipped}', file=sys.stderr)
    print(f'[stormgrid] catchments in:  {len(catchments)}', file=sys.stderr)
    print(f'[stormgrid] catchments out: {len(out_catchments)}', file=sys.stderr)
    print(f'[stormgrid] payload:        {size_kb:.2f} KB', file=sys.stderr)
    print(f'[stormgrid] wrote {OUT_PATH.relative_to(REPO)}', file=sys.stderr)


if __name__ == '__main__':
    main()
