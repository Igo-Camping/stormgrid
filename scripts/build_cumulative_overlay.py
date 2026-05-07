"""Stormgrid — cumulative rainfall overlay builder (Phase 16).

Builds three artefacts the static site can render:

    data/overlays/cumulative/latest/metadata.json       overlay metadata
    data/overlays/cumulative/latest/rainfall_grid.json  hover lookup grid
    data/overlays/cumulative/latest/rainfall_overlay.png Leaflet image overlay

Two operating modes:

  --mode real      Reads Lizard GeoTIFFs from --archive, sums frames in the
                   selected window, projects the cumulative array to a tight
                   lat/lon grid covering the catchments, renders the PNG
                   and the downsampled JSON grid for hover. Frames missing
                   from the archive are reported as gaps — never silently
                   filled. Requires rasterio + pyproj.

  --mode preview   No archive needed. Rasterises the per-catchment total_mm
                   from data/catchment_rainfall_<window>.json onto a regular
                   lat/lon grid using the catchment polygons. Output is loud
                   is_synthetic_preview:true so a downstream consumer cannot
                   mistake it for the real radar surface.

Hard rules (matched to Phase 16 prompt):
  - Does not touch / import Stormgauge code.
  - Reads source Lizard GeoTIFFs READ-ONLY, never copies them in to the repo.
  - Missing frames are reported, not silently filled.
  - Output is small enough to ship in the static site (~30-200 KB total).
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
from PIL import Image

REPO = Path(__file__).resolve().parent.parent
CATCHMENTS = REPO / "data/catchments/catchments_dissolved.geojson"
OUT_DIR    = REPO / "data/overlays/cumulative/latest"

DEFAULT_ARCHIVE = os.environ.get("STORMGRID_LIZARD_DIR", "")

OVERLAY_SCHEMA = "stormgrid.cumulative_overlay.v1"
GRID_SCHEMA    = "stormgrid.cumulative_grid.v1"

# Image dimensions are derived from the bbox; pixel density gives ~110 m/pixel.
PIXELS_PER_DEG = 1200
MARGIN_DEG     = 0.005

# Hover-lookup grid resolution (downsampled from the rendered PNG resolution).
GRID_PIXELS_PER_DEG = 250  # ~440 m / cell at -33.7°

# Perceptual rainfall colour scale (depth_mm, [r,g,b,a]). Below 0.05 mm is
# treated as transparent so fully dry cells leave the basemap visible.
COLOR_STOPS: list[tuple[float, list[int]]] = [
    (0.05,  [225, 240, 245, 0]),
    (0.10,  [225, 240, 245, 80]),
    (1.00,  [165, 215, 230, 140]),
    (5.00,  [70,  150, 175, 180]),
    (15.00, [30,  90,  120, 200]),
    (50.00, [110, 35,  100, 220]),
    (200.0, [180, 30,  60,  240]),
]
LEGEND_STOPS = [s for s in COLOR_STOPS if s[1][3] > 0]


def _colour_for(depth_mm: float) -> list[int]:
    if depth_mm is None or not np.isfinite(depth_mm) or depth_mm < COLOR_STOPS[0][0]:
        return [0, 0, 0, 0]
    for i in range(len(COLOR_STOPS) - 1):
        a_d, a_c = COLOR_STOPS[i]
        b_d, b_c = COLOR_STOPS[i + 1]
        if depth_mm <= b_d:
            if b_d == a_d:
                return list(a_c)
            t = (depth_mm - a_d) / (b_d - a_d)
            return [int(round(a_c[k] + (b_c[k] - a_c[k]) * t)) for k in range(4)]
    return list(COLOR_STOPS[-1][1])


def _colour_array(values_2d: np.ndarray) -> np.ndarray:
    """Vectorised colour-mapping: float32 (H, W) → uint8 (H, W, 4)."""
    h, w = values_2d.shape
    flat = values_2d.flatten()
    out = np.zeros((flat.size, 4), dtype=np.uint8)
    for i, v in enumerate(flat):
        out[i] = _colour_for(float(v) if np.isfinite(v) else 0.0)
    return out.reshape(h, w, 4)


def _bbox_of_catchments(gj: dict, margin: float = MARGIN_DEG) -> tuple[float, float, float, float]:
    minlons, maxlons, minlats, maxlats = [], [], [], []
    for f in gj.get("features") or []:
        p = f.get("properties") or {}
        for k, target in (("bbox_min_lon", minlons), ("bbox_max_lon", maxlons),
                          ("bbox_min_lat", minlats), ("bbox_max_lat", maxlats)):
            v = p.get(k)
            if isinstance(v, (int, float)):
                target.append(float(v))
    if not (minlons and maxlons and minlats and maxlats):
        raise SystemExit("[overlay] catchments GeoJSON missing bbox properties")
    return (
        min(minlons) - margin, min(minlats) - margin,
        max(maxlons) + margin, max(maxlats) + margin,
    )


def _grid_dimensions(bbox: tuple[float, float, float, float], px_per_deg: int) -> tuple[int, int]:
    w, s, e, n = bbox
    return (max(8, int(round((n - s) * px_per_deg))),
            max(8, int(round((e - w) * px_per_deg))))


def _stats(values_2d: np.ndarray) -> dict:
    finite = values_2d[np.isfinite(values_2d) & (values_2d > 0)]
    if finite.size == 0:
        return {"depth_min_mm": 0.0, "depth_max_mm": 0.0, "depth_mean_mm": 0.0, "wet_cell_count": 0}
    return {
        "depth_min_mm":   float(round(finite.min(), 4)),
        "depth_max_mm":   float(round(finite.max(), 4)),
        "depth_mean_mm":  float(round(finite.mean(), 4)),
        "wet_cell_count": int(finite.size),
    }


def _grid_payload(values_2d: np.ndarray, bbox: tuple[float, float, float, float]) -> dict:
    """Downsample a float raster to a coarse grid for hover lookup."""
    w, s, e, n = bbox
    target_h, target_w = _grid_dimensions(bbox, GRID_PIXELS_PER_DEG)
    src_h, src_w = values_2d.shape
    # Block-mean downsample (no scipy dependency).
    block_h = max(1, src_h // target_h)
    block_w = max(1, src_w // target_w)
    cropped = values_2d[: (src_h // block_h) * block_h, : (src_w // block_w) * block_w]
    new_h, new_w = cropped.shape[0] // block_h, cropped.shape[1] // block_w
    cropped = cropped[: new_h * block_h, : new_w * block_w]
    coarse = cropped.reshape(new_h, block_h, new_w, block_w).mean(axis=(1, 3))
    # Replace NaNs / non-positives with null so the JSON is honest about gaps.
    out: list[list[float | None]] = []
    for r in range(new_h):
        row: list[float | None] = []
        for c in range(new_w):
            v = float(coarse[r, c])
            row.append(round(v, 3) if (np.isfinite(v) and v > 0) else None)
        out.append(row)
    return {
        "schema_version":    GRID_SCHEMA,
        "rows":              new_h,
        "cols":              new_w,
        "bbox":              [w, s, e, n],
        "cell_size_deg_lon": (e - w) / new_w if new_w else None,
        "cell_size_deg_lat": (n - s) / new_h if new_h else None,
        "values_mm":         out,
    }


# ─── Real mode: read Lizard GeoTIFFs ───────────────────────────────────

def _list_lizard_frames(archive_root: Path):
    """Return [(timestamp, path)] sorted ascending. Frame filenames look
    like 20240101T000000Z_payload.tif under <archive>/raw_payloads/."""
    raw = archive_root / "raw_payloads"
    if not raw.exists():
        raise SystemExit(f"[overlay] {raw} not found")
    out = []
    for p in raw.glob("*.tif"):
        m = re.match(r"(\d{8}T\d{6}Z)_", p.name)
        if not m:
            continue
        ts = datetime.strptime(m.group(1), "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc)
        out.append((ts, p))
    out.sort(key=lambda x: x[0])
    return out


def _build_real(args, gj: dict, bbox: tuple[float, float, float, float]) -> dict:
    try:
        import rasterio
        from rasterio.warp import reproject, Resampling
        from rasterio.transform import from_bounds
    except ImportError:
        raise SystemExit("[overlay] rasterio is required for --mode real")

    archive_root = Path(args.archive or DEFAULT_ARCHIVE)
    if not archive_root.exists():
        raise SystemExit(f"[overlay] archive root {archive_root} not found")

    frames = _list_lizard_frames(archive_root)
    if not frames:
        raise SystemExit(f"[overlay] no frames under {archive_root}/raw_payloads")

    if args.end:
        end_dt = datetime.fromisoformat(args.end.replace("Z", "+00:00"))
    else:
        end_dt = frames[-1][0]
    start_dt = end_dt - timedelta(hours=args.hours)

    ts_in_window = [t for t, _ in frames if start_dt < t <= end_dt]
    expected_count = max(1, args.hours // 3)
    used_paths = [(t, p) for t, p in frames if start_dt < t <= end_dt]

    img_h, img_w = _grid_dimensions(bbox, PIXELS_PER_DEG)
    w, s, e, n = bbox
    target_transform = from_bounds(w, s, e, n, img_w, img_h)

    accum = np.zeros((img_h, img_w), dtype=np.float32)
    coverage = np.zeros((img_h, img_w), dtype=np.uint16)
    frame_records = []
    used = 0

    for ts, p in used_paths:
        try:
            with rasterio.open(p) as src:
                buf = np.zeros((img_h, img_w), dtype=np.float32)
                reproject(
                    source=rasterio.band(src, 1),
                    destination=buf,
                    src_transform=src.transform,
                    src_crs=src.crs,
                    dst_transform=target_transform,
                    dst_crs="EPSG:4326",
                    resampling=Resampling.bilinear,
                    dst_nodata=np.nan,
                )
                # Lizard frames carry mm-of-rain per frame interval. Coverage
                # is "any finite, non-negative value" — we never silently
                # treat NaNs as zero.
                valid = np.isfinite(buf) & (buf >= 0)
                accum += np.where(valid, buf, 0.0)
                coverage += valid.astype(np.uint16)
                used += 1
                frame_records.append({"ts": ts.isoformat(), "ok": True})
        except Exception as ex:  # noqa: BLE001
            frame_records.append({"ts": ts.isoformat(), "ok": False, "reason": str(ex)})

    # Treat cells that NEVER had a valid sample as no-data (NaN), not zero.
    accum_with_nan = np.where(coverage > 0, accum, np.nan)

    rgba = _colour_array(accum_with_nan)
    grid = _grid_payload(accum_with_nan, bbox)

    meta = {
        "mode":               "real",
        "is_synthetic_preview": False,
        "data_source":        "lizard_precipitation_australia",
        "window_key":         args.window_name or f"{args.hours}h",
        "window_start_utc":   start_dt.isoformat(),
        "window_end_utc":     end_dt.isoformat(),
        "frame_interval_hours": 3,
        "frame_count_expected": expected_count,
        "frame_count_used":   used,
        "frames_missing":     [f for f in frame_records if not f.get("ok")],
        "gaps_present":       used < expected_count or any(not f.get("ok") for f in frame_records),
        "frame_records":      frame_records,
    }
    return _finalise(args, rgba, grid, meta, bbox, accum_with_nan)


# ─── Preview mode: rasterise per-catchment totals ──────────────────────

def _ray_cast_polygons(gj: dict, bbox: tuple[float, float, float, float],
                       img_h: int, img_w: int, value_by_cid: dict[str, float]) -> np.ndarray:
    """Burn each catchment's total_mm into a float32 grid via per-row scan
    — no rasterio dependency. Cells outside every polygon stay NaN."""
    w, s, e, n = bbox
    out = np.full((img_h, img_w), np.nan, dtype=np.float32)
    for f in gj.get("features") or []:
        cid = (f.get("properties") or {}).get("catchment_id")
        v = value_by_cid.get(cid)
        if v is None:
            continue
        geom = f.get("geometry") or {}
        polys = geom.get("coordinates") if geom.get("type") == "Polygon" else None
        multi = geom.get("coordinates") if geom.get("type") == "MultiPolygon" else None
        rings = []
        if polys is not None:
            rings.append(polys)
        elif multi is not None:
            for poly in multi:
                rings.append(poly)
        for poly in rings:
            outer = poly[0]
            holes = poly[1:] if len(poly) > 1 else []
            # Polygon bbox in deg
            xs = [pt[0] for pt in outer]; ys = [pt[1] for pt in outer]
            poly_w, poly_e = min(xs), max(xs); poly_s, poly_n = min(ys), max(ys)
            # → pixel range
            col_a = max(0,        int((poly_w - w) / (e - w) * img_w))
            col_b = min(img_w,    int((poly_e - w) / (e - w) * img_w) + 1)
            row_a = max(0,        int((n - poly_n) / (n - s) * img_h))
            row_b = min(img_h,    int((n - poly_s) / (n - s) * img_h) + 1)
            for r in range(row_a, row_b):
                lat = n - (r + 0.5) * (n - s) / img_h
                # Build x-intersections of outer ring with this scanline.
                for ring, sign in [(outer, 1)] + [(h, -1) for h in holes]:
                    xs_int = []
                    nv = len(ring)
                    j = nv - 1
                    for i in range(nv):
                        yi = ring[i][1]; yj = ring[j][1]
                        if (yi > lat) != (yj > lat):
                            xi = ring[i][0]; xj = ring[j][0]
                            xs_int.append(xi + (lat - yi) * (xj - xi) / ((yj - yi) or 1e-12))
                        j = i
                    xs_int.sort()
                    for k in range(0, len(xs_int) - 1, 2):
                        x_lo = xs_int[k]; x_hi = xs_int[k + 1]
                        c_lo = max(col_a, int((x_lo - w) / (e - w) * img_w))
                        c_hi = min(col_b, int((x_hi - w) / (e - w) * img_w) + 1)
                        if sign > 0:
                            out[r, c_lo:c_hi] = v
                        else:
                            out[r, c_lo:c_hi] = np.nan
    return out


def _build_preview(args, gj: dict, bbox: tuple[float, float, float, float]) -> dict:
    win = args.preview_window
    rainfall_path = REPO / f"data/catchment_rainfall_{win}.json"
    if not rainfall_path.exists():
        raise SystemExit(f"[overlay] preview source {rainfall_path} not found")
    rd = json.loads(rainfall_path.read_text(encoding="utf-8"))
    value_by_cid = {
        cid: float(c["total_mm"])
        for cid, c in (rd.get("catchments") or {}).items()
        if isinstance(c.get("total_mm"), (int, float))
    }

    img_h, img_w = _grid_dimensions(bbox, PIXELS_PER_DEG)
    arr = _ray_cast_polygons(gj, bbox, img_h, img_w, value_by_cid)

    rgba = _colour_array(arr)
    grid = _grid_payload(arr, bbox)
    window = rd.get("window") or {}
    quality = rd.get("quality") or {}
    expected = (window.get("frame_count") if isinstance(window.get("frame_count"), int) else None)
    used     = (quality.get("frames_used")  if isinstance(quality.get("frames_used"), int) else None)
    if used is None and expected is not None:
        used = expected
    if expected is None and used is not None:
        expected = used

    meta = {
        "mode":               "preview",
        "is_synthetic_preview": True,
        "data_source":        "stormgrid_preview_from_catchment_rainfall_json",
        "preview_source":     str(rainfall_path.relative_to(REPO)).replace("\\", "/"),
        "window_key":         win,
        "window_start_utc":   window.get("start"),
        "window_end_utc":     window.get("end"),
        "frame_interval_hours": 3,
        "frame_count_expected": expected,
        "frame_count_used":   used,
        "frames_missing":     [],
        "gaps_present":       (expected or 0) != (used or 0),
    }
    return _finalise(args, rgba, grid, meta, bbox, arr)


# ─── Common writer ────────────────────────────────────────────────────

def _finalise(args, rgba: np.ndarray, grid: dict, meta: dict,
              bbox: tuple[float, float, float, float], values_2d: np.ndarray) -> dict:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    img_h, img_w, _ = rgba.shape
    Image.fromarray(rgba, mode="RGBA").save(OUT_DIR / "rainfall_overlay.png", optimize=True)
    (OUT_DIR / "rainfall_grid.json").write_text(json.dumps(grid), encoding="utf-8")

    w, s, e, n = bbox
    full_meta = {
        "schema_version":      OVERLAY_SCHEMA,
        "generated_at":        datetime.now(timezone.utc).isoformat(),
        "bbox":                [w, s, e, n],          # [west, south, east, north]
        "leaflet_bounds":      [[s, w], [n, e]],      # convenience for L.imageOverlay
        "image_path":          "rainfall_overlay.png",
        "image_width_px":      img_w,
        "image_height_px":     img_h,
        "image_pixels_per_deg": PIXELS_PER_DEG,
        "grid_path":           "rainfall_grid.json",
        "grid_pixels_per_deg": GRID_PIXELS_PER_DEG,
        "grid_rows":           grid["rows"],
        "grid_cols":           grid["cols"],
        "is_authoritative":    False,
        "color_scale": {
            "name":  "stormgrid.cumulative.rainfall.v1",
            "stops": [{"depth_mm": d, "rgba": rgba_} for d, rgba_ in LEGEND_STOPS],
        },
        "warning": (
            "Cumulative rainfall overlay is a precomputed visual aid. Bilinear "
            "reprojection from the source raster smooths sub-pixel detail. "
            "Cells with no valid samples remain transparent — gaps are reported, "
            "never silently filled."
        ),
        "methodology_note": (
            "Cumulative depth derived by summing the source rainfall frames "
            "inside the chosen window. NOT an AEP classification, NOT a return-"
            "period assignment, NOT a formal exceedance assertion."
        ),
        **meta,
        "stats": _stats(values_2d),
    }
    (OUT_DIR / "metadata.json").write_text(json.dumps(full_meta, indent=2), encoding="utf-8")
    return full_meta


def _print_summary(meta: dict):
    p = lambda k: meta.get(k)
    sz_png = (OUT_DIR / "rainfall_overlay.png").stat().st_size
    sz_grid = (OUT_DIR / "rainfall_grid.json").stat().st_size
    sz_meta = (OUT_DIR / "metadata.json").stat().st_size
    print(f"[overlay] mode={p('mode')} window={p('window_key')} "
          f"image={p('image_width_px')}x{p('image_height_px')} px "
          f"({sz_png:,} bytes)")
    print(f"[overlay] grid={p('grid_cols')}x{p('grid_rows')} ({sz_grid:,} bytes), "
          f"metadata {sz_meta:,} bytes")
    s = p("stats") or {}
    print(f"[overlay] depth (mm): min={s.get('depth_min_mm')} "
          f"max={s.get('depth_max_mm')} mean={s.get('depth_mean_mm')} "
          f"wet cells={s.get('wet_cell_count')}")
    print(f"[overlay] frames: used={p('frame_count_used')} / expected={p('frame_count_expected')} · "
          f"gaps_present={p('gaps_present')}")


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    p.add_argument("--mode", choices=["real", "preview"], default="preview")
    p.add_argument("--archive", default=DEFAULT_ARCHIVE,
                   help="Lizard archive root (real mode). Default $STORMGRID_LIZARD_DIR.")
    p.add_argument("--hours", type=int, default=24,
                   help="Real mode trailing-window length in hours (default 24).")
    p.add_argument("--end", default=None,
                   help="Real mode end timestamp ISO UTC (default: latest archive frame).")
    p.add_argument("--window-name", default=None,
                   help="Real mode label written into metadata (e.g. 24h, 7d, 30d).")
    p.add_argument("--preview-window", choices=["24h", "7d", "30d"], default="24h",
                   help="Preview mode source window file (default 24h).")
    args = p.parse_args(argv)

    if not CATCHMENTS.exists():
        raise SystemExit(f"[overlay] catchments missing at {CATCHMENTS}")
    gj = json.loads(CATCHMENTS.read_text(encoding="utf-8"))
    bbox = _bbox_of_catchments(gj)

    if args.mode == "real":
        meta = _build_real(args, gj, bbox)
    else:
        meta = _build_preview(args, gj, bbox)

    _print_summary(meta)
    return 0


if __name__ == "__main__":
    sys.exit(main())
