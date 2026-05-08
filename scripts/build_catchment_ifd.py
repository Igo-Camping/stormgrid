#!/usr/bin/env python3
"""Build a per-catchment point IFD asset for Stormgrid.

Reads a BOM IFD cache + verified station list (operator-only files,
typically in the pluvio-stormgauge working tree) and writes the small
JSON Stormgrid serves at /data/catchment_ifd_centroid.json.

For each catchment it picks the nearest verified BOM station to the
catchment centroid and snapshots the station's IFD values for the
six Stormgrid durations (3 h, 6 h, 12 h, 24 h, 48 h, 72 h) at AEPs
1 %, 2 %, 5 %, 20 %.

The result is **point IFD only** — ARF is not applied. The header
records that explicitly so downstream consumers cannot mistake it
for a catchment areal design rainfall.

Usage:
    python scripts/build_catchment_ifd.py --pluvio-root "C:\\Users\\fonzi\\Weather App Folder"
"""
import argparse
import json
import math
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

REPO            = Path(__file__).resolve().parent.parent
CATCHMENT_PATH  = REPO / 'data/catchments/catchments_dissolved.geojson'
OUT_PATH        = REPO / 'data/catchment_ifd_centroid.json'

DURATIONS_MIN = {
    '3h':   180,
    '6h':   360,
    '12h':  720,
    '24h':  1440,
    '48h':  2880,
    '72h':  4320,
}
AEP_KEYS = ['1%', '2%', '5%', '20%']

DEFAULT_PLUVIO_ROOT = os.environ.get(
    'STORMGRID_PLUVIO_ROOT',
    r'C:\Users\fonzi\Weather App Folder')


def parse_args():
    ap = argparse.ArgumentParser(description=__doc__.split('\n', 1)[0])
    ap.add_argument('--pluvio-root', type=str, default=DEFAULT_PLUVIO_ROOT,
                    help='Path to pluvio-stormgauge working tree (read-only).')
    return ap.parse_args()


def haversine_km(lat1, lon1, lat2, lon2):
    R = 6371.0
    p1 = math.radians(lat1); p2 = math.radians(lat2)
    dp = math.radians(lat2 - lat1); dl = math.radians(lon2 - lon1)
    a = math.sin(dp/2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl/2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


def main():
    args = parse_args()
    pluvio = Path(args.pluvio_root)
    ifd_path     = pluvio / 'data/pluviometrics_ifd_cache.json'
    station_path = pluvio / 'data/station-verification/verified_bom_rainfall_stations.json'
    if not ifd_path.exists():
        print(f'[stormgrid-ifd] missing: {ifd_path}', file=sys.stderr); sys.exit(2)
    if not station_path.exists():
        print(f'[stormgrid-ifd] missing: {station_path}', file=sys.stderr); sys.exit(2)
    if not CATCHMENT_PATH.exists():
        print(f'[stormgrid-ifd] missing: {CATCHMENT_PATH}', file=sys.stderr); sys.exit(2)

    with open(ifd_path, 'r', encoding='utf-8') as f:
        ifd = json.load(f)
    with open(station_path, 'r', encoding='utf-8') as f:
        stations = json.load(f)
    with open(CATCHMENT_PATH, 'r', encoding='utf-8') as f:
        gj = json.load(f)

    # Index stations that have IFD data.
    by_id = {}
    for s in stations:
        sid = s.get('station_id')
        if sid and sid in ifd and isinstance(s.get('lat'), (int, float)) and isinstance(s.get('lon'), (int, float)):
            by_id[sid] = s
    print(f'[stormgrid-ifd] verified stations with IFD: {len(by_id)}', file=sys.stderr)

    out_catchments = {}
    for feat in gj['features']:
        props = feat['properties']
        cid = props.get('catchment_id')
        clat = props.get('centroid_lat'); clon = props.get('centroid_lon')
        if not (cid and isinstance(clat, (int, float)) and isinstance(clon, (int, float))):
            continue

        # Nearest IFD-equipped station to the catchment centroid.
        best_sid = None; best_d = float('inf')
        for sid, s in by_id.items():
            d = haversine_km(clat, clon, s['lat'], s['lon'])
            if d < best_d:
                best_d, best_sid = d, sid
        if best_sid is None:
            continue
        st = by_id[best_sid]
        st_ifd = ifd[best_sid]

        durations = {}
        for dur_key, dur_min in DURATIONS_MIN.items():
            row = st_ifd.get(str(dur_min))
            if not row:
                durations[dur_key] = None
                continue
            durations[dur_key] = {
                'duration_minutes': dur_min,
                'aep': {k: row.get(k) for k in AEP_KEYS},
            }

        # Monotonicity quality filter: each AEP column must be non-decreasing
        # as duration grows. Flag entries where an AEP value is strictly less than
        # the value at any longer included duration — those are scrape errors
        # in the source cache (e.g. 6h reporting 447 mm while 24h is 270).
        ordered = ['3h', '6h', '12h', '24h', '48h', '72h']
        # Walk longest → shortest, track the running maximum of "valid larger" values per AEP.
        running_max_by_aep: dict = {}
        for k in reversed(ordered):
            d = durations.get(k)
            if not d: continue
            suspect_aeps = []
            for aep_key, v in d.get('aep', {}).items():
                if v is None:
                    continue
                prev = running_max_by_aep.get(aep_key)
                if prev is not None and v < prev:
                    # Strictly less than only — equality is acceptable and does not trigger suspect.
                    suspect_aeps.append(aep_key)
                else:
                    # Update only for non-suspect values; preserve last good value for flagged columns.
                    running_max_by_aep[aep_key] = v

            if suspect_aeps:
                d['quality_flag'] = 'suspect_non_monotonic'
                d['suspect_aep_columns'] = sorted(suspect_aeps)

        out_catchments[cid] = {
            'catchment_centroid':       [round(clon, 6), round(clat, 6)],
            'reference_station_id':     best_sid,
            'reference_station_name':   st.get('station_name'),
            'reference_station_lonlat': [round(st['lon'], 6), round(st['lat'], 6)],
            'reference_station_distance_km': round(best_d, 3),
            'durations': durations,
        }

    payload = {
        'schema_version': 'stormgrid.point_ifd.v1',
        'generated_at':   datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'methodology': {
            'point_ifd_only': True,
            'arf_applied':    False,
            'reference_point_rule': 'nearest verified BOM station to each catchment centroid',
            'warning': (
                'Point IFD design depths only. ARF (areal reduction factor) is NOT applied. '
                'Do not interpret any comparison as a catchment AEP classification. '
                'Catchment-mean rainfall must be compared to ARF-adjusted areal design rainfall '
                'before assigning event AEP.'
            ),
        },
        'source': {
            'kind':        'bom_ifd_cache (verified-station subset)',
            'cache_path':  str(ifd_path).replace('\\', '/'),
            'station_path': str(station_path).replace('\\', '/'),
        },
        'durations':       DURATIONS_MIN,
        'aep_keys':        AEP_KEYS,
        'catchment_count': len(out_catchments),
        'catchments':      out_catchments,
    }

    raw = json.dumps(payload, separators=(',', ':')).encode('utf-8')
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_bytes(raw)
    print(f'[stormgrid-ifd] wrote {OUT_PATH.relative_to(REPO)} ({len(raw)/1024:.2f} KB, '
          f'{len(out_catchments)} catchments)', file=sys.stderr)


if __name__ == '__main__':
    main()
