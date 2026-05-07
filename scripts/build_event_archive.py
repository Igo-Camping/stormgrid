"""Stormgrid — event archive builder (Phase 13).

Walks a folder of historical catchment_rainfall_*.json snapshots and
produces a browseable event archive:

    data/event_archive/
        index.json                  manifest (one row per archived event)
        catchment_climatology.json  per-catchment band counters
        <event-id>/event.json       full lossless snapshot per event

Usage:
    python scripts/build_event_archive.py
    python scripts/build_event_archive.py --source data/_archive_inbox
    python scripts/build_event_archive.py --include-current

The default source directory is data/_archive_inbox/ (operators drop
historical catchment_rainfall_*.json files in there). With
--include-current, the three live precomputed snapshots
(catchment_rainfall_24h/7d/30d.json) are also archived under stable
event-ids derived from each snapshot's window.

Bands are descriptive volume tiers. They are NOT AEP, NOT return-period,
NOT formal exceedance — they only describe how much rain fell:

    light       <  10 mm
    moderate    10 – 25 mm
    heavy       25 – 50 mm
    very_heavy  50 – 100 mm
    extreme     >= 100 mm

The script is idempotent — re-running on the same inputs produces the
same outputs.
"""

import argparse
import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

REPO_ROOT  = Path(__file__).resolve().parent.parent
ARCHIVE_DIR = REPO_ROOT / "data" / "event_archive"
DEFAULT_INBOX = REPO_ROOT / "data" / "_archive_inbox"
LIVE_SNAPSHOTS = [
    REPO_ROOT / "data" / "catchment_rainfall_24h.json",
    REPO_ROOT / "data" / "catchment_rainfall_7d.json",
    REPO_ROOT / "data" / "catchment_rainfall_30d.json",
]

INDEX_SCHEMA       = "stormgrid.event_archive_index.v1"
EVENT_SCHEMA       = "stormgrid.event_archive_entry.v1"
CLIMATOLOGY_SCHEMA = "stormgrid.catchment_climatology.v1"

# Descriptive volume bands (NOT AEP, NOT return-period). A row's band is
# computed against `total_mm` (the catchment's window total) so events
# from different accumulation windows are not blended in counts —
# climatology is grouped by accumulation_window in the output JSON.
BANDS = [
    ("light",       0,    10),
    ("moderate",    10,   25),
    ("heavy",       25,   50),
    ("very_heavy",  50,   100),
    ("extreme",     100,  10**9),
]

METHODOLOGY_NOTE = (
    "Bands describe rainfall volume only. They are NOT an AEP "
    "classification, NOT a return-period assignment, and NOT a formal "
    "exceedance assertion. Use them for qualitative operational context "
    "only."
)


def band_for_mm(total_mm):
    if total_mm is None or not isinstance(total_mm, (int, float)):
        return None
    for name, lo, hi in BANDS:
        if lo <= total_mm < hi:
            return name
    return BANDS[-1][0]


def event_id_for(snapshot_path: Path, snapshot: dict) -> str:
    """Stable id derived from the source file's window — re-running on
    the same snapshot produces the same id, so the archive is idempotent."""
    win = snapshot.get("window") or {}
    start = (win.get("start") or "").replace(":", "").replace("-", "")
    end   = (win.get("end")   or "").replace(":", "").replace("-", "")
    frames = win.get("frame_count")
    accum = guess_accumulation_window(snapshot)
    seed = f"{accum}|{start}|{end}|{frames}|{snapshot_path.name}"
    digest = hashlib.sha1(seed.encode("utf-8")).hexdigest()[:10]
    return f"evt_{accum or 'win'}_{start[:13] or 'na'}_{digest}"


def guess_accumulation_window(snapshot: dict) -> str:
    """Infer accumulation_window key from the snapshot.
    Looks for an explicit field; falls back to window length in hours."""
    explicit = snapshot.get("accumulation_window") or snapshot.get("window_key")
    if isinstance(explicit, str) and explicit:
        return explicit
    win = snapshot.get("window") or {}
    start = win.get("start")
    end = win.get("end")
    if not (start and end):
        return "unknown"
    try:
        a = datetime.fromisoformat(start.replace("Z", "+00:00"))
        b = datetime.fromisoformat(end.replace("Z", "+00:00"))
        hours = round((b - a).total_seconds() / 3600.0)
    except Exception:
        return "unknown"
    if hours == 24: return "24h"
    if hours == 24 * 7: return "7d"
    if hours == 24 * 30: return "30d"
    if hours == 1: return "1h"
    if hours == 3: return "3h"
    if hours == 6: return "6h"
    if hours == 12: return "12h"
    if hours == 48: return "48h"
    if hours == 72: return "72h"
    return f"{hours}h"


def summarise_snapshot(snapshot: dict) -> dict:
    catchments = snapshot.get("catchments") or {}
    rows = []
    for cid, c in catchments.items():
        if not isinstance(c, dict):
            continue
        total = c.get("total_mm")
        if not isinstance(total, (int, float)):
            continue
        rows.append({
            "catchment_id": cid,
            "total_mm":     round(float(total), 3),
            "coverage_pct": _maybe_round(c.get("coverage_pct"), 2),
            "confidence":   c.get("confidence"),
            "band":         band_for_mm(float(total)),
        })
    rows.sort(key=lambda r: r["total_mm"], reverse=True)
    top = rows[0] if rows else None
    return {
        "catchment_count": len(rows),
        "top_catchment":   top["catchment_id"] if top else None,
        "top_total_mm":    top["total_mm"]      if top else None,
        "top_band":        top["band"]          if top else None,
        "rows":            rows,
    }


def _maybe_round(v, digits):
    if isinstance(v, (int, float)):
        return round(float(v), digits)
    return None


def archive_one(snapshot_path: Path, dry_run: bool = False) -> dict:
    raw = snapshot_path.read_text(encoding="utf-8")
    snapshot = json.loads(raw)
    accum_key = guess_accumulation_window(snapshot)
    event_id = event_id_for(snapshot_path, snapshot)
    summary  = summarise_snapshot(snapshot)
    archived_at = (snapshot.get("generated_at")
                   or datetime.now(timezone.utc).isoformat())

    entry = {
        "schema_version":      EVENT_SCHEMA,
        "event_id":            event_id,
        "label":               build_label(snapshot, accum_key),
        "archived_at":         archived_at,
        "source_file":         str(snapshot_path.relative_to(REPO_ROOT)).replace("\\", "/"),
        "accumulation_window": accum_key,
        "source_window":       snapshot.get("window"),
        "catchment_count":     summary["catchment_count"],
        "top_catchment":       summary["top_catchment"],
        "top_total_mm":        summary["top_total_mm"],
        "top_band":            summary["top_band"],
        "rainfall_data":       snapshot,
        "methodology_note":    METHODOLOGY_NOTE,
    }
    out_dir  = ARCHIVE_DIR / event_id
    out_path = out_dir / "event.json"
    if not dry_run:
        out_dir.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps(entry, indent=2), encoding="utf-8")

    return {
        "event_id":            event_id,
        "label":               entry["label"],
        "archived_at":         archived_at,
        "source_file":         entry["source_file"],
        "archive_path":        str(out_path.relative_to(REPO_ROOT)).replace("\\", "/"),
        "accumulation_window": accum_key,
        "catchment_count":     summary["catchment_count"],
        "top_catchment":       summary["top_catchment"],
        "top_total_mm":        summary["top_total_mm"],
        "top_band":            summary["top_band"],
        "_summary_rows":       summary["rows"],
    }


def build_label(snapshot: dict, accum_key: str) -> str:
    win = snapshot.get("window") or {}
    start = (win.get("start") or "").replace("T", " ").replace(":00Z", " UTC").replace("Z", " UTC")
    return f"{accum_key} window ending {start[:16]} UTC" if start else f"{accum_key} window"


def collect_inputs(inbox: Path, include_current: bool) -> list[Path]:
    paths: list[Path] = []
    if inbox.exists():
        for p in sorted(inbox.glob("catchment_rainfall_*.json")):
            paths.append(p)
    if include_current:
        for p in LIVE_SNAPSHOTS:
            if p.exists():
                paths.append(p)
    return paths


def build_climatology(rows_by_event: list[dict]) -> dict:
    """Per-catchment, per-accumulation-window band counts. The accumulation-
    window grouping prevents 30d-totals from inflating counts for 24h
    decisions and vice versa."""
    catchments: dict[str, dict] = {}
    archive_size_per_window: dict[str, int] = {}
    archive_size_total = 0
    most_recent_per_window: dict[str, dict] = {}

    for entry in rows_by_event:
        accum = entry["accumulation_window"]
        archive_size_total += 1
        archive_size_per_window[accum] = archive_size_per_window.get(accum, 0) + 1
        prev_recent = most_recent_per_window.get(accum)
        if (prev_recent is None) or (entry["archived_at"] > prev_recent["archived_at"]):
            most_recent_per_window[accum] = {
                "event_id": entry["event_id"],
                "archived_at": entry["archived_at"],
            }

        for row in entry["_summary_rows"]:
            cid = row["catchment_id"]
            band = row["band"]
            cnode = catchments.setdefault(cid, {
                "catchment_id": cid,
                "total_events_seen": 0,
                "by_window": {},
            })
            cnode["total_events_seen"] += 1
            wnode = cnode["by_window"].setdefault(accum, {
                "events_seen": 0,
                "band_counts": {b: 0 for b, _, _ in BANDS},
                "highest_total_mm": None,
                "highest_event_id": None,
                "most_recent_event_id": None,
                "most_recent_archived_at": None,
            })
            wnode["events_seen"] += 1
            if band:
                wnode["band_counts"][band] = wnode["band_counts"].get(band, 0) + 1
            tm = row["total_mm"]
            if isinstance(tm, (int, float)):
                if (wnode["highest_total_mm"] is None) or (tm > wnode["highest_total_mm"]):
                    wnode["highest_total_mm"] = tm
                    wnode["highest_event_id"] = entry["event_id"]
            if (wnode["most_recent_archived_at"] is None
                    or entry["archived_at"] > wnode["most_recent_archived_at"]):
                wnode["most_recent_event_id"] = entry["event_id"]
                wnode["most_recent_archived_at"] = entry["archived_at"]

    return {
        "schema_version":  CLIMATOLOGY_SCHEMA,
        "generated_at":    datetime.now(timezone.utc).isoformat(),
        "archive_size":    archive_size_total,
        "archive_size_by_window": archive_size_per_window,
        "most_recent_by_window":  most_recent_per_window,
        "bands":           [{"name": n, "min_mm": lo, "max_mm": (None if hi >= 10**9 else hi)} for n, lo, hi in BANDS],
        "methodology_note": METHODOLOGY_NOTE,
        "catchments":      catchments,
    }


def main(argv: Iterable[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--source", type=Path, default=DEFAULT_INBOX,
                   help="Folder of historical catchment_rainfall_*.json snapshots.")
    p.add_argument("--include-current", action="store_true",
                   help="Also archive the live precomputed 24h/7d/30d snapshots.")
    p.add_argument("--dry-run", action="store_true")
    args = p.parse_args(list(argv) if argv is not None else None)

    inputs = collect_inputs(args.source, args.include_current)
    print(f"[archive] {len(inputs)} input snapshot(s)")
    if not inputs:
        print("[archive] nothing to archive — writing empty index + climatology.")
    if not args.dry_run:
        ARCHIVE_DIR.mkdir(parents=True, exist_ok=True)

    rows: list[dict] = []
    for path in inputs:
        try:
            entry = archive_one(path, dry_run=args.dry_run)
        except Exception as e:
            print(f"[archive] SKIP {path.name}: {e}", file=sys.stderr)
            continue
        rows.append(entry)
        print(f"[archive] {entry['event_id']} <- {entry['source_file']} "
              f"({entry['catchment_count']} catchments, top {entry['top_total_mm']} mm)")

    rows.sort(key=lambda r: r["archived_at"], reverse=True)
    index = {
        "schema_version":  INDEX_SCHEMA,
        "generated_at":    datetime.now(timezone.utc).isoformat(),
        "event_count":     len(rows),
        "bands":           [{"name": n, "min_mm": lo, "max_mm": (None if hi >= 10**9 else hi)} for n, lo, hi in BANDS],
        "methodology_note": METHODOLOGY_NOTE,
        "events": [
            {k: v for k, v in r.items() if k != "_summary_rows"}
            for r in rows
        ],
    }
    climatology = build_climatology(rows)

    if not args.dry_run:
        (ARCHIVE_DIR / "index.json").write_text(json.dumps(index, indent=2), encoding="utf-8")
        (ARCHIVE_DIR / "catchment_climatology.json").write_text(json.dumps(climatology, indent=2), encoding="utf-8")
        print(f"[archive] wrote {ARCHIVE_DIR / 'index.json'}")
        print(f"[archive] wrote {ARCHIVE_DIR / 'catchment_climatology.json'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
