"""Stormgrid - gauge observations builder (Phase 14, stub).

Operator-run script that refreshes data/gauge_observations.json from real
gauge feeds. The shipping JSON contains SYNTHETIC values exercising the
calibration framework - replace before any operational use.

This is a stub to keep the surface area small while Stormgrid stays
standalone. Real implementations should pull from:

  - BOM Climate Data Online: daily totals for AWS stations
  - MHL/WISKI KiWIS API: 1-min/15-min rainfall for the MHL network
  - or any other gauge feed that provides matched-window totals

For each station listed in data/catchment_ifd_centroid.json, fetch the
station total over the same window endpoints used by
data/catchment_rainfall_<key>.json (windows 24h / 7d / 30d), and write
the result back to data/gauge_observations.json keeping the existing
schema.

The calibration framework in src/stormgridCalibration.js will pick up
the new file on the next page load - no other code changes needed.
"""

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
IFD_PATH       = REPO_ROOT / "data" / "catchment_ifd_centroid.json"
RAINFALL_FILES = {
    "24h": REPO_ROOT / "data" / "catchment_rainfall_24h.json",
    "7d":  REPO_ROOT / "data" / "catchment_rainfall_7d.json",
    "30d": REPO_ROOT / "data" / "catchment_rainfall_30d.json",
}
OUTPUT_PATH = REPO_ROOT / "data" / "gauge_observations.json"

ABS_CAP_MM = 150.0          # intentionally conservative first-pass cap; not a scientifically validated duration-dependent threshold
MAX_REJECT_FRACTION = 0.10
MAX_DRIFT_MM = 5.0


def collect_unique_stations(ifd: dict) -> list[dict]:
    seen: dict[str, dict] = {}
    for _cid, entry in (ifd.get("catchments") or {}).items():
        sid = entry.get("reference_station_id")
        if not sid or sid in seen:
            continue
        seen[sid] = {
            "station_id":   sid,
            "station_name": entry.get("reference_station_name") or sid,
            "lonlat":       entry.get("reference_station_lonlat") or [None, None],
        }
    return list(seen.values())


def window_endpoints() -> dict[str, dict]:
    out = {}
    for k, p in RAINFALL_FILES.items():
        if not p.exists():
            continue
        d = json.loads(p.read_text(encoding="utf-8"))
        out[k] = d.get("window") or {}
    return out


def qc_readings(values: list, station_id: str, window_key: str):
    """Apply per-reading QC before summing. Returns cleaned total mm or None.

    QC rules (applied to each individual reading):
      - Reject negative values
      - Reject non-finite values (NaN, +/-inf)
      - Reject values exceeding ABS_CAP_MM
      - Reject isolated spikes: value > 10x max of finite neighbours AND value > 20 mm
        (only when at least one neighbour is finite and > 0)

    None entries are missing frames - skipped, not counted as rejected.

    Returns None if:
      - rejection fraction exceeds MAX_REJECT_FRACTION
      - cleaned sum differs from raw sum by more than MAX_DRIFT_MM
        (deliberate: a station whose total changes materially under QC is
         unsuitable for calibration rather than silently corrected)
    """
    raw_count = sum(1 for v in values if v is not None)
    rejected = 0
    cleaned = []

    for i, v in enumerate(values):
        if v is None:
            continue
        # Reject negative
        if v < 0:
            rejected += 1
            continue
        # Reject non-finite
        if not (v == v) or v == float('inf') or v == float('-inf'):
            rejected += 1
            continue
        # Reject over cap
        if v > ABS_CAP_MM:
            rejected += 1
            continue
        # Isolated spike check: only if at least one neighbour is finite and > 0
        neighbours = [
            values[j] for j in (i - 1, i + 1)
            if 0 <= j < len(values) and values[j] is not None and values[j] > 0
        ]
        if neighbours and v > 20.0:
            if v > 10.0 * max(neighbours):
                rejected += 1
                continue
        cleaned.append(v)

    if raw_count == 0:
        print(f"[gauges] {station_id} window={window_key}: no readings - returning None", file=sys.stderr)
        return None

    reject_fraction = rejected / raw_count
    if reject_fraction > MAX_REJECT_FRACTION:
        print(
            f"[gauges] {station_id} window={window_key}: rejected {rejected}/{raw_count} readings "
            f"({reject_fraction:.1%}) > {MAX_REJECT_FRACTION:.0%} threshold - returning None",
            file=sys.stderr,
        )
        return None

    raw_sum = sum(v for v in values if v is not None)
    cleaned_sum = sum(cleaned)
    if abs(cleaned_sum - raw_sum) > MAX_DRIFT_MM:
        print(
            f"[gauges] {station_id} window={window_key}: QC drift "
            f"{abs(cleaned_sum - raw_sum):.3f} mm > {MAX_DRIFT_MM} mm limit - "
            f"station unsuitable for calibration",
            file=sys.stderr,
        )
        return None

    print(
        f"[gauges] {station_id} window={window_key}: "
        f"raw={raw_count} readings, rejected={rejected}, cleaned_total={cleaned_sum:.3f} mm",
        file=sys.stderr,
    )
    return round(cleaned_sum, 3)


def fetch_from_kisters(station: dict, window: dict, window_key: str):
    """Fetch timeseries from MHL/WISKI KiWIS REST API and apply QC.

    Uses stdlib only (urllib). No new dependencies.
    30-second timeout. On network or parse failure, returns None.
    """
    import urllib.request
    import urllib.parse
    import urllib.error

    ts_id = station["ts_id"]
    station_id = station["station_id"]
    params = urllib.parse.urlencode({
        "service": "kisters",
        "type": "queryServices",
        "request": "getTimeseriesValues",
        "datasource": "0",
        "format": "json",
        "ts_id": ts_id,
        "from": window.get("start", ""),
        "to": window.get("end", ""),
        "returnfields": "Timestamp,Value",
    })
    url = f"https://www.mhl.nsw.gov.au/cgi/webservice.exe?{params}"

    try:
        req = urllib.request.Request(url, headers={"User-Agent": "stormgrid-gauge-fetch/1.0"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = resp.read().decode("utf-8")
    except urllib.error.URLError as e:
        print(f"[gauges] {station_id} window={window_key}: KiWIS URLError - {e}", file=sys.stderr)
        return None
    except Exception as e:
        print(f"[gauges] {station_id} window={window_key}: KiWIS fetch error - {e}", file=sys.stderr)
        return None

    try:
        payload = json.loads(body)
        # KiWIS returns a list; first item has 'data'
        data = payload[0].get("data", []) if isinstance(payload, list) else payload.get("data", [])
    except (json.JSONDecodeError, IndexError, KeyError, TypeError) as e:
        print(f"[gauges] {station_id} window={window_key}: KiWIS parse error - {e}", file=sys.stderr)
        return None

    values = []
    for row in data:
        try:
            raw_val = row[1] if isinstance(row, (list, tuple)) else None
            if raw_val in (None, "", "---"):
                values.append(None)
            else:
                values.append(float(raw_val))
        except (ValueError, TypeError):
            values.append(None)

    if not values:
        print(f"[gauges] {station_id} window={window_key}: KiWIS returned no rows", file=sys.stderr)
        return None

    return qc_readings(values, station_id, window_key)


def fetch_station_total(station: dict, window_key: str, window: dict):
    """Fetch station rainfall total for the given window, with QC applied.

    Primary: MHL/WISKI KiWIS REST API (requires station['ts_id']).
    Fallback: None with stderr explanation (BoM CDO not yet implemented).

    Returns mm of cleaned rainfall over the window, or None on failure.
    Does not cache responses.
    """
    if station.get("ts_id"):
        return fetch_from_kisters(station, window, window_key)
    print(
        f"[gauges] {station['station_id']} window={window_key}: "
        f"no ts_id and no verified BoM CDO mapping - skipping",
        file=sys.stderr,
    )
    return None


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--dry-run", action="store_true",
                   help="Print what would be written without touching the file.")
    args = p.parse_args(list(argv) if argv is not None else None)

    if not IFD_PATH.exists():
        print(f"[gauges] {IFD_PATH} missing - cannot enumerate stations.", file=sys.stderr)
        return 2

    ifd = json.loads(IFD_PATH.read_text(encoding="utf-8"))
    stations = collect_unique_stations(ifd)
    windows  = window_endpoints()
    print(f"[gauges] {len(stations)} station(s), {len(windows)} window(s).")

    rows = []
    any_real = False
    for s in stations:
        totals: dict = {}
        for wk in windows.keys():
            v = fetch_station_total(s, wk, windows[wk])
            if v is not None:
                any_real = True
                totals[wk] = round(float(v), 3)
        rows.append({**s, "totals_mm": totals})

    if not any_real:
        print(
            "[gauges] fetch_station_total() returned no values - refusing to "
            "overwrite the synthetic placeholder dataset. Implement the stub.",
            file=sys.stderr,
        )
        return 1

    payload = {
        "schema_version": "stormgrid.gauge_observations.v1",
        "generated_at":   datetime.now(timezone.utc).isoformat(),
        "is_authoritative": True,
        "is_synthetic":     False,
        "warning":          "Real gauge observations. Verify station-window alignment with data/catchment_rainfall_<key>.json before relying on calibration outputs.",
        "method":           "multiplicative_bias_inverse_distance_weighted",
        "windows":          list(windows.keys()),
        "stations":         rows,
        "methodology_note": "NOT an AEP classification, NOT a return-period assignment, NOT a formal exceedance assertion.",
    }
    if args.dry_run:
        print(json.dumps(payload, indent=2)[:1500])
        return 0
    OUTPUT_PATH.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(f"[gauges] wrote {OUTPUT_PATH}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
