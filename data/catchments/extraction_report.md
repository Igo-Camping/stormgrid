# Lizard catchment raster-derived extraction report (v2)

_Generated: 2026-05-04T00:24:06.061175+00:00_  
_Status: **OK**_  
_Source GeoTIFF: `C:\Users\fonzi\Weather App Folder\Assets\Catchments\northern-beaches-subcatchmentsZ_2026-05-04T00_05_35Z.tiff`_  
_Authoritative: **NO** -- raster-derived, non-authoritative._

## Critical disclaimer

Polygons are derived by tracing pixel boundaries of a categorical GeoTIFF and dissolving by label. They are reproducible from the source raster but inherit the source's pixel-grid stairstep edges. They are NOT a substitute for an authoritative vector catchment dataset. `is_authoritative=false` on every feature.

## Numbers

- Unique labels detected: **35**
- Raw polygon parts (after >= 100 m^2 filter): **38**
- Dropped small parts (< 100 m^2): **15**
- Dissolved features (one per label): **35**

## Validation

- Pairwise overlap issues: **0**
- All geometries valid: **True**
- Coverage audit:
  - raster non-nodata area: **258399664 m^2**
  - polygon total area: **258414902 m^2**
  - ratio polygon/raster: **1.0001** (within 1%: True, within 5%: True)

## Spatial accuracy

- Pixel resolution (m): **4.398 x 5.287**
- Boundary uncertainty: **>= 6.877 m** (one pixel diagonal)
- Note: Boundary precision >= 1 source-pixel diagonal.

## Fitness for use

- Visual overlay: **True**
- Indicative area attribution: **True**
- Centroid lookup (e.g. nearest-station joins): **True**
- Design or regulatory use: **False**
- Rationale: Polygons are reproducible from the source raster but inherit pixel-grid stairsteps and any rasterisation artefacts. They are NOT a substitute for an authoritative vector dataset.

## Output schema (per dissolved feature)

| Property | Type | Note |
|---|---|---|
| catchment_id | string | `catch_<label>` -- stable across re-runs |
| pixel_value | int | label value from source raster |
| rgb_hex | string | `#RRGGBB`; from GeoTIFF palette if present, else deterministic golden-angle HSV |
| rgb_alpha | int | nullable; only set if palette has alpha |
| rgb_source | string | `geotiff_palette` or `deterministic_hsv_golden_angle` |
| area_m2 / area_ha | number | geodesic spherical area |
| perimeter_m | number | geodesic haversine sum |
| vertex_count | int | total across all rings/parts |
| part_count | int | 1 for Polygon, N for MultiPolygon |
| centroid_lon / centroid_lat | number | shapely.representative_point (always inside geom) |
| bbox_min/max_lon/lat | number | EPSG:4326 axis-aligned envelope |
| is_authoritative | boolean | **always false** |
| projection_original | string | source CRS (e.g. EPSG:4283) |
| extraction_timestamp | string | ISO 8601 UTC |

## Comparison with v1

- v1: 38 polygons (one per disjoint connected component, no dissolve, no centroid/bbox/perimeter, no rgb_hex).
- v2: 35 dissolved features (one per label) with full geometry metrics + deterministic colour mapping.
