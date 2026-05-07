"""Stormgrid — safe stormwater asset snapshot builder (Phase 15A).

Reads a council asset CSV export READ-ONLY and emits two sanitized
files:

    data/assets/stormwater_assets.geojson   (FeatureCollection, WGS84)
    data/assets/asset_metadata.json         (provenance + drop manifest)

The script:
  - never mutates the source file
  - never connects to CiAnywhere or any live system
  - drops sensitive fields unconditionally (PII, internal IDs, audit
    metadata, h/t/pagekey-style URLs, comment / address / property text)
  - keeps a hashed asset id (sha1, 10 hex chars) so refreshes are stable
  - normalises asset class to {pipe, culvert, open_channel}
  - parses size/length/condition into typed numeric fields
  - emits LineString geometry when XStart/YStart/XEnd/YEnd are present,
    otherwise Point geometry from Longitude/Latitude
  - skips rows missing coordinates entirely
  - refuses to overwrite an existing authoritative snapshot without
    --force

Usage:
    python scripts/build_asset_snapshot.py \\
        --source "D:/Packaging/data/assets_with_coords.csv"
    python scripts/build_asset_snapshot.py --dry-run
    python scripts/build_asset_snapshot.py --force
"""

import argparse
import csv
import hashlib
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT     = Path(__file__).resolve().parent.parent
OUTPUT_DIR    = REPO_ROOT / "data" / "assets"
OUTPUT_GEO    = OUTPUT_DIR / "stormwater_assets.geojson"
OUTPUT_META   = OUTPUT_DIR / "asset_metadata.json"

DEFAULT_SOURCE = Path(r"D:\Packaging\data\assets_with_coords.csv")

OUTPUT_SCHEMA = "stormgrid.assets.geojson.v1"
META_SCHEMA   = "stormgrid.asset_metadata.v1"

# ─── Sanitization config ───────────────────────────────────────────────
# Sensitive fields are dropped unconditionally. The list errs on the side
# of dropping anything that could carry PII, council-internal identifiers
# (TechnologyOne CiA pagekeys, h/t session URLs, property numbers) or
# free-text fields that have been observed to contain location-specific
# notes. Audit columns (Created_By, Changed_By, terminals, windows) are
# also dropped — they belong to the source register, not Stormgrid.

# NB: matching is performed on a normalised key form (lower + collapse
# underscores/spaces/dashes), so "Asset_Address", "Asset Address", and
# "asset-address" are all treated identically.
SENSITIVE_FIELDS_DROP = {
    # PII / addresses
    "asset address", "asset address search path",
    "pipe start address", "formatted address", "prop description",
    "asset street", "asset suburb",
    # Internal council references (CiAnywhere session-style)
    "ci propertyno", "old techone id", "old pit numbers", "old pit number",
    "mapkey", "catlg id", "asset register", "asset register2",
    "asset", "asset2", "parent asset", "node number",
    # Catchment-name leak: SW_Sub_Catchment carries street names in this
    # dataset (e.g. "Sangrado Street") — drop unconditionally; the macro
    # SW_Catchment (e.g. "Manly Lagoon") is kept and emitted.
    "sw sub catchment",
    # Free-text notes
    "comments", "description",
    "acquisition comment 1", "acquisition comment 2", "acquisition comment 3",
    "hazard", "nbc asset risk",
    # Audit metadata (source-system provenance, not snapshot relevant)
    "created by", "changed by",
    "date created", "date changed", "create time", "last changed time",
    "create terminal", "last changed terminal",
    "create window", "last changed window",
    "cond. last changed", "last changed",
    # Internal ranking / scoring (decisional, not raw asset attributes)
    "score", "fencescore", "ranking", "near fid", "near dist",
    "risk consequence", "risk likelihood", "criticality", "inherent risk",
    # Anything matching CiA session URL patterns is dropped via regex below
}


def _normalise_key(name: str) -> str:
    """Lower-case, collapse runs of [_- /\\] into single space, trim."""
    s = (name or "").lower()
    s = re.sub(r"[_\-/\\.]+", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s

# Any column whose lowered name contains one of these substrings is
# dropped — catch-all for h/t/pagekey-style session URL columns,
# locality / address fragments, and common audit fields with name
# variations. NB sub-catchment names in this dataset are street names
# (e.g. "Sangrado Street") — see also build_feature where
# sw_sub_catchment is intentionally NOT emitted into properties.
SENSITIVE_NAME_SUBSTRINGS = (
    "address", "comment", "pagekey", "session", "url",
    "terminal", "window", "h_value", "t_value",
    "street", "road", "suburb", "location", "property",
)

# Pattern that matches values resembling a TechOne CiA session URL.
CIA_SESSION_VALUE_RE = re.compile(
    r"https?://.+ciap?(?:anywhere)?[^\s]*[?&](?:h|t|pagekey)=", re.IGNORECASE)


def is_dropped(field_name: str) -> bool:
    norm = _normalise_key(field_name)
    if norm in SENSITIVE_FIELDS_DROP:
        return True
    for s in SENSITIVE_NAME_SUBSTRINGS:
        if s in norm:
            return True
    return False


# ─── Type coercion helpers ─────────────────────────────────────────────

def to_float(s):
    if s is None:
        return None
    s = str(s).strip()
    if s == "" or s.lower() in ("not applicable", "nan", "tbd", "to be determined"):
        return None
    try:
        return float(s)
    except ValueError:
        return None


def to_int(s):
    f = to_float(s)
    return int(f) if f is not None else None


def parse_year(s) -> int | None:
    if s is None:
        return None
    s = str(s).strip()
    if not s:
        return None
    # Try "1/02/1963", "01/02/1963", "1963-02-01", "1963"
    for fmt in ("%d/%m/%Y", "%Y-%m-%d", "%Y/%m/%d", "%Y"):
        try:
            return datetime.strptime(s, fmt).year
        except ValueError:
            pass
    # Last-ditch: extract a 4-digit year
    m = re.search(r"\b(19|20)\d{2}\b", s)
    return int(m.group(0)) if m else None


# Pipe diameter values come in as e.g. "1050mm", "375", "300x150". Pull
# the largest numeric integer.
def parse_size_mm(s):
    if s is None:
        return None
    s = str(s).strip()
    if not s or s.lower() in ("not applicable", "tbd", "to be determined"):
        return None
    nums = [int(n) for n in re.findall(r"\d+", s)]
    return max(nums) if nums else None


CONDITION_LABEL = {
    1: "excellent",
    2: "good",
    3: "fair",
    4: "poor",
    5: "very_poor",
}


def normalise_condition(*candidates):
    """Pick the first numeric condition in {1..5} from the candidates."""
    for c in candidates:
        v = to_float(c)
        if v is None:
            continue
        iv = int(round(v))
        if 1 <= iv <= 5:
            return iv
    return None


def normalise_class(asset_classification: str, description: str | None = None) -> str | None:
    """Produce a stable Stormgrid class key from the source classification."""
    s = (asset_classification or "").strip().lower()
    if "open" in s:
        return "open_channel"
    if "culvert" in s:
        return "culvert"
    if "pipe" in s:
        return "pipe"
    if "headwall" in s:
        return "headwall"
    if "pit" in s:
        return "pit"
    # fall back to the description column
    d = (description or "").strip().lower()
    if "pipe" in d: return "pipe"
    if "culvert" in d: return "culvert"
    if "open" in d or "channel" in d: return "open_channel"
    if "pit" in d: return "pit"
    if "headwall" in d: return "headwall"
    return None


def hash_id(seed: str, length: int = 10) -> str:
    return hashlib.sha1(seed.encode("utf-8")).hexdigest()[:length]


# ─── Geometry ──────────────────────────────────────────────────────────

def lon_lat_pair(s_lon, s_lat):
    lon, lat = to_float(s_lon), to_float(s_lat)
    if lon is None or lat is None:
        return None
    # Sanity: NB sits roughly within (151.0..151.4, -34.0..-33.5)
    if not (140 < lon < 155 and -45 < lat < -10):
        return None
    return [round(lon, 7), round(lat, 7)]


def line_geometry(row: dict):
    a = lon_lat_pair(row.get("XStart"), row.get("YStart"))
    b = lon_lat_pair(row.get("XEnd"), row.get("YEnd"))
    if a and b and a != b:
        return {"type": "LineString", "coordinates": [a, b]}
    return None


def point_geometry(row: dict):
    p = lon_lat_pair(row.get("Longitude"), row.get("Latitude"))
    if not p:
        # try the midpoint as a last resort
        p = lon_lat_pair(row.get("XMid"), row.get("YMid"))
    if not p:
        return None
    return {"type": "Point", "coordinates": p}


def best_geometry(row: dict):
    return line_geometry(row) or point_geometry(row)


# ─── Row builder ───────────────────────────────────────────────────────

def build_feature(row: dict) -> dict | None:
    cls = normalise_class(row.get("Asset_Classification"), row.get("Description"))
    if cls is None:
        return None
    geom = best_geometry(row)
    if geom is None:
        return None

    # Stable identifier: hash whatever the source uses for OBJECTID. We
    # never emit OBJECTID itself because it can be cross-referenced back
    # to the live register.
    objid = (row.get("OBJECTID") or "").strip()
    if not objid:
        return None
    aid = "sw_" + hash_id(f"swsnapshot|{objid}", length=10)

    cond = normalise_condition(
        row.get("Schedule7_Condition"),
        row.get("Schedule_7_Condition"),
        row.get("Calculated_Condition"),
        row.get("Observed_Condition"),
    )

    size_mm = parse_size_mm(row.get("SWP_Pipe_Diameter_mm"))
    if size_mm is None and cls == "culvert":
        # culverts use width/diameter in metres
        for f in ("Culvert_Width_m", "Culvert_Diameter_m", "Culvert_Height_m"):
            v = to_float(row.get(f))
            if v is not None:
                size_mm = int(round(v * 1000))
                break
    if size_mm is None and cls == "open_channel":
        for f in ("Top_Width_m", "Height_m"):
            v = to_float(row.get(f))
            if v is not None:
                size_mm = int(round(v * 1000))
                break

    length_m = to_float(row.get("Spatial_Length_m"))
    if length_m is None:
        length_m = to_float(row.get("Length_m"))
    if length_m is not None:
        length_m = round(length_m, 2)

    install_year = parse_year(row.get("Construction_Date"))

    catchment = (row.get("SW_Catchment") or "").strip() or None
    # SW_Sub_Catchment in this dataset carries street names (e.g.
    # "Sangrado Street") — that's PII. Intentionally NOT emitted; only
    # the macro SW_Catchment (a hydrological boundary, e.g. "Manly
    # Lagoon") is preserved.

    material = (
        (row.get("SWP__Pipe_Material") or "").strip()
        or (row.get("SWC_Culvert_Material") or "").strip()
        or (row.get("SWO__Open_Material") or "").strip()
        or None
    )
    if material:
        material = material.strip().lower().replace(" ", "_")

    service_status = (row.get("Service_Status") or "").strip() or None
    operating_status = (row.get("Operating_Status") or "").strip() or None
    status = (row.get("Status") or "").strip() or None

    grade_pct = to_float(row.get("Grade__%"))
    if grade_pct is None:
        grade_pct = to_float(row.get("Grade_Percentage"))
    if grade_pct is not None:
        grade_pct = round(grade_pct, 3)

    us_inv = to_float(row.get("US_InvLevel_m"))
    ds_inv = to_float(row.get("DS_InvLevel_m"))

    props = {
        "asset_id_hash":     aid,
        "asset_class":       cls,
        "material":          material,
        "size_mm":           size_mm,
        "length_m":          length_m,
        "condition_grade":   cond,
        "condition_label":   CONDITION_LABEL.get(cond) if cond else None,
        "install_year":      install_year,
        "sw_catchment":      catchment,
        "service_status":    service_status,
        "operating_status":  operating_status,
        "status":            status,
        "grade_pct":         grade_pct,
        "us_inv_level_m":    round(us_inv, 3) if us_inv is not None else None,
        "ds_inv_level_m":    round(ds_inv, 3) if ds_inv is not None else None,
    }
    # Drop None-valued props for compactness — schema readers can treat
    # missing keys as null.
    props = {k: v for k, v in props.items() if v is not None}

    return {
        "type": "Feature",
        "geometry": geom,
        "properties": props,
    }


# ─── Main ──────────────────────────────────────────────────────────────

def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--source", type=Path, default=DEFAULT_SOURCE,
                   help=f"Council asset CSV export (default: {DEFAULT_SOURCE}).")
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--force", action="store_true",
                   help="Overwrite an existing authoritative snapshot.")
    args = p.parse_args(list(argv) if argv is not None else None)

    src = args.source
    if not src.exists():
        print(f"[snapshot] source not found: {src}", file=sys.stderr)
        return 2
    src_stat = src.stat()
    print(f"[snapshot] source: {src} ({src_stat.st_size:,} bytes, "
          f"mtime {datetime.fromtimestamp(src_stat.st_mtime).isoformat()})")

    # Refuse to overwrite an authoritative snapshot unless --force.
    if OUTPUT_GEO.exists() and not args.force and not args.dry_run:
        try:
            existing_meta = json.loads(OUTPUT_META.read_text(encoding="utf-8")) if OUTPUT_META.exists() else {}
            if existing_meta.get("is_authoritative"):
                print("[snapshot] existing snapshot is authoritative; refusing without --force", file=sys.stderr)
                return 3
        except Exception:
            pass

    rows_in = 0
    rows_out = 0
    rows_dropped_no_class = 0
    rows_dropped_no_geom = 0
    rows_dropped_no_objid = 0
    cia_session_value_drops = 0
    fields_seen: set[str] = set()
    fields_dropped: set[str] = set()
    class_counts: dict[str, int] = {}

    features = []
    with src.open("r", encoding="utf-8-sig", newline="") as f:
        rdr = csv.DictReader(f)
        for col in rdr.fieldnames or []:
            fields_seen.add(col)
            if is_dropped(col):
                fields_dropped.add(col)
        for row in rdr:
            rows_in += 1
            # Defence-in-depth: scan retained values for CiA session URL
            # patterns and drop the entire row if matched.
            sanitised_row = {}
            kill_row = False
            for k, v in row.items():
                if is_dropped(k):
                    continue
                if isinstance(v, str) and v and CIA_SESSION_VALUE_RE.search(v):
                    cia_session_value_drops += 1
                    kill_row = True
                    break
                sanitised_row[k] = v
            if kill_row:
                continue
            cls_check = normalise_class(sanitised_row.get("Asset_Classification"), sanitised_row.get("Description"))
            if cls_check is None:
                rows_dropped_no_class += 1
                continue
            if not (sanitised_row.get("OBJECTID") or "").strip():
                rows_dropped_no_objid += 1
                continue
            if best_geometry(sanitised_row) is None:
                rows_dropped_no_geom += 1
                continue
            feat = build_feature(sanitised_row)
            if feat is None:
                rows_dropped_no_geom += 1
                continue
            class_counts[feat["properties"]["asset_class"]] = (
                class_counts.get(feat["properties"]["asset_class"], 0) + 1
            )
            features.append(feat)
            rows_out += 1

    print(f"[snapshot] rows in: {rows_in:,}")
    print(f"[snapshot] rows out: {rows_out:,}")
    print(f"[snapshot] rows dropped: no class={rows_dropped_no_class}, "
          f"no objid={rows_dropped_no_objid}, no geom={rows_dropped_no_geom}, "
          f"cia session value match={cia_session_value_drops}")
    print(f"[snapshot] class counts: {class_counts}")

    fields_kept = sorted(fields_seen - fields_dropped)
    fields_dropped_sorted = sorted(fields_dropped)

    fc = {
        "type": "FeatureCollection",
        "name": "stormgrid_stormwater_assets",
        "metadata": {
            "schema_version":   OUTPUT_SCHEMA,
            "generated_at":     datetime.now(timezone.utc).isoformat(),
            "source_basename":  src.name,
            "source_mtime_utc": datetime.fromtimestamp(src_stat.st_mtime, tz=timezone.utc).isoformat(),
            "asset_count":      len(features),
            "is_authoritative": False,    # flip to True only after operator review
            "is_synthetic":     False,
            "crs":              "EPSG:4326",
            "warning":          (
                "Council asset snapshot derived from a council CSV export. Sensitive "
                "fields (addresses, internal CiAnywhere IDs, audit metadata, free-text "
                "comments) have been dropped at snapshot time. Verify the field-drop "
                "list before flipping is_authoritative to true."
            ),
            "methodology_note": (
                "Snapshot is sanitised raw register data only. NOT a failure prediction. "
                "NOT an assertion of design exceedance. NOT an AEP classification. "
                "NOT a return-period assignment. NOT a legal-liability indicator."
            ),
            "fields_dropped":   fields_dropped_sorted,
            "fields_kept":      fields_kept,
        },
        "features": features,
    }

    meta = {
        "schema_version":         META_SCHEMA,
        "generated_at":           fc["metadata"]["generated_at"],
        "source_basename":        src.name,
        "source_size_bytes":      src_stat.st_size,
        "source_mtime_utc":       fc["metadata"]["source_mtime_utc"],
        "asset_count":            len(features),
        "is_authoritative":       False,
        "is_synthetic":           False,
        "crs":                    "EPSG:4326",
        "rows_in":                rows_in,
        "rows_out":               rows_out,
        "rows_dropped_no_class":  rows_dropped_no_class,
        "rows_dropped_no_geom":   rows_dropped_no_geom,
        "rows_dropped_no_objid":  rows_dropped_no_objid,
        "cia_session_value_drops": cia_session_value_drops,
        "fields_seen_count":      len(fields_seen),
        "fields_dropped":         fields_dropped_sorted,
        "fields_kept":            fields_kept,
        "class_counts":           class_counts,
        "asset_id_hash_algorithm": "sha1[0:10]",
        "warning":                fc["metadata"]["warning"],
        "methodology_note":       fc["metadata"]["methodology_note"],
    }

    if args.dry_run:
        print(f"[snapshot] dry-run: would write {OUTPUT_GEO} and {OUTPUT_META}")
        return 0

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    OUTPUT_GEO.write_text(json.dumps(fc, indent=1), encoding="utf-8")
    OUTPUT_META.write_text(json.dumps(meta, indent=2), encoding="utf-8")
    print(f"[snapshot] wrote {OUTPUT_GEO} ({OUTPUT_GEO.stat().st_size:,} bytes)")
    print(f"[snapshot] wrote {OUTPUT_META}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
