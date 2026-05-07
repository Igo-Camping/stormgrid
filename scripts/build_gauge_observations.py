"""Stormgrid — gauge observations builder (Phase 14, stub).

Operator-run script that refreshes data/gauge_observations.json from real
gauge feeds. The shipping JSON contains SYNTHETIC values exercising the
calibration framework — replace before any operational use.

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
the new file on the next page load — no other code changes needed.
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


def fetch_station_total(station: dict, window_key: str, window: dict) -> float | None:
    """Stub. Replace with a real BOM/MHL/WISKI fetch.

    `station['lonlat']` and `window['start']` / `window['end']` are
    everything you need. Return mm of rainfall over the window, or
    None if the station has no data for that window."""
    # TODO: real implementation. For now, return None so the script
    # never silently fabricates values when re-run.
    return None


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--dry-run", action="store_true",
                   help="Print what would be written without touching the file.")
    args = p.parse_args(list(argv) if argv is not None else None)

    if not IFD_PATH.exists():
        print(f"[gauges] {IFD_PATH} missing — cannot enumerate stations.", file=sys.stderr)
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
        print("[gauges] fetch_station_total() returned no values — refusing to "
              "overwrite the synthetic placeholder dataset. Implement the stub.",
              file=sys.stderr)
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
