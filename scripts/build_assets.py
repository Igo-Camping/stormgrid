"""Stormgrid — synthetic stormwater asset generator (Phase 15).

Reads data/catchments/catchments_dissolved.geojson and emits
data/stormwater_assets.json (a FeatureCollection of asset Points). The
output is loudly tagged is_synthetic:true and is_authoritative:false —
operators replace it via their TechnologyOne / Intramaps export
pipeline.

Per-catchment counts are derived from area_ha so larger catchments get
more assets. Class / size / condition distributions follow plausible
priors for a metropolitan stormwater network. Placement uses rejection
sampling inside each polygon so every asset is geometrically inside its
parent catchment.

Run:
    python scripts/build_assets.py
    python scripts/build_assets.py --seed 42
"""

import argparse
import hashlib
import json
import random
import sys
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT     = Path(__file__).resolve().parent.parent
CATCHMENTS    = REPO_ROOT / "data" / "catchments" / "catchments_dissolved.geojson"
OUTPUT_PATH   = REPO_ROOT / "data" / "stormwater_assets.json"

# Realistic distribution priors. These are *plausible* averages for a
# Sydney metropolitan stormwater network — they are NOT a substitute for
# the operator's authoritative asset register.
ASSET_CLASSES = [
    # (class, weight, size_min_mm, size_max_mm)
    ("pit",           0.35, 300,   900),
    ("pipe",          0.40, 225,  1500),
    ("culvert",       0.07, 600,  2400),
    ("headwall",      0.06, 300,  1800),
    ("open_channel",  0.07, 1000, 5000),
    ("scour_protection", 0.05, 0, 0),
]
CONDITION_WEIGHTS = [
    (1, 0.10),  # excellent
    (2, 0.30),  # good
    (3, 0.35),  # fair
    (4, 0.18),  # poor
    (5, 0.07),  # very poor
]
MATERIAL_BY_CLASS = {
    "pit":              ["concrete", "brick", "polymer"],
    "pipe":             ["concrete", "pvc", "vitrified_clay", "ductile_iron"],
    "culvert":          ["concrete", "corrugated_steel"],
    "headwall":         ["concrete", "stone_masonry"],
    "open_channel":     ["earth_lined", "concrete_lined", "rock_lined"],
    "scour_protection": ["rock_armour", "concrete_apron"],
}


def stable_random(seed_str: str) -> random.Random:
    """Deterministic RNG so re-running the script produces the same dataset."""
    h = hashlib.sha256(seed_str.encode("utf-8")).hexdigest()
    return random.Random(int(h[:16], 16))


def weighted_pick(rng: random.Random, items: list[tuple]) -> tuple:
    """items: [(value, weight)] or [(value, weight, *extras)]."""
    total = sum(w for _v, w, *_x in items)
    r = rng.random() * total
    cum = 0.0
    for it in items:
        v, w = it[0], it[1]
        cum += w
        if r < cum:
            return it
    return items[-1]


def point_in_ring(lon: float, lat: float, ring: list[list[float]]) -> bool:
    inside = False
    n = len(ring)
    j = n - 1
    for i in range(n):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        if (yi > lat) != (yj > lat):
            if lon < (xj - xi) * (lat - yi) / ((yj - yi) or 1e-12) + xi:
                inside = not inside
        j = i
    return inside


def point_in_feature(lon: float, lat: float, feature: dict) -> bool:
    g = feature.get("geometry") or {}
    polys = []
    if g.get("type") == "Polygon":
        polys = [g.get("coordinates") or []]
    elif g.get("type") == "MultiPolygon":
        polys = g.get("coordinates") or []
    else:
        return False
    for poly in polys:
        if not poly:
            continue
        outer = poly[0]
        if not point_in_ring(lon, lat, outer):
            continue
        in_hole = False
        for h in poly[1:]:
            if point_in_ring(lon, lat, h):
                in_hole = True
                break
        if not in_hole:
            return True
    return False


def random_point_in_feature(rng: random.Random, feature: dict, max_tries: int = 250) -> tuple[float, float] | None:
    p = feature.get("properties") or {}
    minx, miny = p.get("bbox_min_lon"), p.get("bbox_min_lat")
    maxx, maxy = p.get("bbox_max_lon"), p.get("bbox_max_lat")
    if None in (minx, miny, maxx, maxy):
        return None
    for _ in range(max_tries):
        lon = rng.uniform(minx, maxx)
        lat = rng.uniform(miny, maxy)
        if point_in_feature(lon, lat, feature):
            return (lon, lat)
    return (p.get("centroid_lon"), p.get("centroid_lat"))


def assets_for_catchment(rng: random.Random, feature: dict, catchment_id: str) -> list[dict]:
    """Return 1-4 assets for the catchment, sized by area_ha."""
    p = feature.get("properties") or {}
    area_ha = float(p.get("area_ha") or 0)
    n = max(1, min(4, int(round(area_ha / 250))))   # roughly 1 per 250 ha
    out = []
    for i in range(n):
        rid = f"{catchment_id}_a{i+1}"
        sub = stable_random(f"{rid}|asset")
        cls_pick = weighted_pick(sub, [(c, w, lo, hi) for (c, w, lo, hi) in ASSET_CLASSES])
        cls, _w, size_min, size_max = cls_pick
        if size_max > 0 and size_min > 0:
            size_mm = sub.choice(range(size_min, size_max + 1, 75))
        else:
            size_mm = None
        cond = weighted_pick(sub, CONDITION_WEIGHTS)[0]
        material = sub.choice(MATERIAL_BY_CLASS[cls])
        install_year = sub.randint(1960, 2024)
        coords = random_point_in_feature(sub, feature)
        if coords is None or coords[0] is None:
            continue
        out.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [round(coords[0], 7), round(coords[1], 7)]},
            "properties": {
                "asset_id":           rid,
                "asset_class":        cls,
                "size_mm":            size_mm,
                "condition_grade":    cond,
                "material":           material,
                "install_year":       install_year,
                "catchment_id":       catchment_id,
                "is_synthetic":       True,
                "is_authoritative":   False,
            },
        })
    return out


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--seed", default="stormgrid-phase15", help="Seed string for deterministic generation.")
    args = p.parse_args(list(argv) if argv is not None else None)

    if not CATCHMENTS.exists():
        print(f"[assets] {CATCHMENTS} missing", file=sys.stderr)
        return 2
    gj = json.loads(CATCHMENTS.read_text(encoding="utf-8"))
    feats = gj.get("features") or []
    print(f"[assets] {len(feats)} catchment features")

    all_assets: list[dict] = []
    for feat in feats:
        cid = (feat.get("properties") or {}).get("catchment_id")
        if not cid:
            continue
        rng = stable_random(f"{args.seed}|{cid}")
        all_assets.extend(assets_for_catchment(rng, feat, cid))

    out = {
        "type": "FeatureCollection",
        "name": "stormgrid_synthetic_stormwater_assets",
        "metadata": {
            "schema_version":   "stormgrid.assets.v1",
            "generated_at":     datetime.now(timezone.utc).isoformat(),
            "is_authoritative": False,
            "is_synthetic":     True,
            "asset_count":      len(all_assets),
            "warning":          (
                "SYNTHETIC PLACEHOLDER ASSETS. These features are illustrative — they were "
                "generated by scripts/build_assets.py from catchment polygons, NOT from a "
                "council asset register. Replace with a real export from TechnologyOne CiA / "
                "Intramaps before any operational use. Inspection-priority calculations on "
                "synthetic assets are meaningless for engineering or maintenance decisions."
            ),
            "replace_with_real_data": True,
            "source_note":      "Real implementation should pull stormwater pits, pipes, culverts, headwalls, channels, and scour protection from the council asset register and re-emit this file with is_authoritative:true.",
            "asset_classes":    [c for (c, *_x) in ASSET_CLASSES],
            "condition_scale":  {"1": "excellent", "2": "good", "3": "fair", "4": "poor", "5": "very_poor"},
            "methodology_note": "Inspection-priority scoring is a transparent heuristic for triage only. NOT a failure prediction. NOT an assertion of design exceedance. NOT an AEP classification. NOT a return-period assignment. NOT a legal-liability indicator.",
        },
        "features": all_assets,
    }
    OUTPUT_PATH.write_text(json.dumps(out, indent=2), encoding="utf-8")
    print(f"[assets] wrote {OUTPUT_PATH} ({len(all_assets)} assets)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
