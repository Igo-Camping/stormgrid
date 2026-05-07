# Stormgrid asset snapshot — schema and provenance

This document describes how `data/assets/stormwater_assets.geojson` is
produced, what survives the sanitisation pass, and how to refresh the
snapshot when a new council export is available.

The snapshot is **derived from a live council asset CSV** but does not
replace it: it is a static, sanitised, point/line representation
optimised for use by the Stormgrid web app. It is **not authoritative**
for engineering or maintenance decisions.

## Files

| Path | Purpose |
|---|---|
| `scripts/build_asset_snapshot.py` | Read-only builder that loads the source CSV, drops sensitive fields, types the rest, writes the GeoJSON + metadata. |
| `data/assets/stormwater_assets.geojson` | Sanitised FeatureCollection in WGS84 (EPSG:4326). |
| `data/assets/asset_metadata.json` | Provenance + sanitisation manifest (fields kept / dropped, row counts, source mtime). |

## Source of truth

| Path | `D:\Packaging\data\assets_with_coords.csv` |
|---|---|
| Why this file | Has both `Longitude/Latitude` AND `XStart/YStart/XEnd/YEnd` line endpoints, and includes Stormwater Pipes plus Culverts and Open Channels in the same export. |
| Source mtime captured at snapshot time | written into `metadata.source_mtime_utc` |
| Read mode | the script never writes back to this path |

If the source path changes, pass `--source <path>` to the builder.

## Sanitisation contract

Per-feature properties are constructed by `build_feature(row)`. Only the
keys below are ever emitted; everything else in the source row is
discarded.

| Property | Source column(s) | Notes |
|---|---|---|
| `asset_id_hash` | `OBJECTID` | sha1 truncated to 10 hex chars, prefixed `sw_` — stable across refreshes. The raw `OBJECTID` is never emitted. |
| `asset_class` | `Asset_Classification` (fallback `Description`) | Normalised to one of `pipe`, `culvert`, `open_channel`, `pit`, `headwall`. Source values like `Stormwater\Stormwater Pipe` map to `pipe`. |
| `material` | `SWP__Pipe_Material` / `SWC_Culvert_Material` / `SWO__Open_Material` | Lower-cased, spaces → underscores. |
| `size_mm` | `SWP_Pipe_Diameter_mm` (preferred); culvert width/diameter or open-channel top width × 1000 | Largest integer extracted from the field (handles values like `"1050mm"`). |
| `length_m` | `Spatial_Length_m` (preferred), `Length_m` (fallback) | Rounded to 2 dp. |
| `condition_grade` | First numeric in 1..5 from `Schedule7_Condition`, `Schedule_7_Condition`, `Calculated_Condition`, `Observed_Condition` | Integer. |
| `condition_label` | derived from `condition_grade` | `excellent`/`good`/`fair`/`poor`/`very_poor`. |
| `install_year` | `Construction_Date` | Year only. |
| `sw_catchment` | `SW_Catchment` | **Macro hydrological catchment name** (e.g. `Manly Lagoon`). Public boundary, not PII. |
| `service_status`, `operating_status`, `status` | source columns of the same name | Free-text status labels. |
| `grade_pct` | `Grade__%` (or `Grade_Percentage`) | Rounded to 3 dp. |
| `us_inv_level_m`, `ds_inv_level_m` | `US_InvLevel_m`, `DS_InvLevel_m` | Rounded to 3 dp. |

Geometry: a `LineString` from `XStart/YStart` → `XEnd/YEnd` when both
endpoints are present and distinct, otherwise a `Point` from
`Longitude/Latitude` (or `XMid/YMid` as last resort). Rows missing
coordinates entirely are skipped.

## Drop rules

The script drops a source column whenever any of the following match:

1. The column's normalised name (lower-cased, runs of `_-/\.\\` and
   whitespace collapsed to a single space) appears in
   `SENSITIVE_FIELDS_DROP`. This catches both `Asset_Address` and
   `Asset Address`, both `Old_TechOne_ID` and `Old TechOne ID`, etc.
2. The normalised name **contains** one of the substrings:
   `address`, `comment`, `pagekey`, `session`, `url`, `terminal`,
   `window`, `h_value`, `t_value`, `street`, `road`, `suburb`,
   `location`, `property`.
3. Any retained value matches the regex
   `https?://.+ciap?(?:anywhere)?[^\s]*[?&](?:h|t|pagekey)=` — the
   entire row is dropped if a CiAnywhere session URL pattern is detected.

### Categories of dropped fields

- **PII / addresses**: `Asset_Address`, `Pipe_Start_Address`,
  `Formatted_Address`, `Prop_Description`, `Asset Street`,
  `Asset Suburb`, `Location - Street/Road Name`, `Location - Suburb`,
  etc.
- **Council-internal references**: `CI_PropertyNo`, `Old_TechOne_ID`,
  `MAPKEY`, `CATLG_ID`, `Asset_Register`, `Parent_Asset`, `Node_Number`,
  `Old_Pit_Number(s)`, `Investment Property`.
- **Sub-catchment leak**: `SW_Sub_Catchment` is dropped — values in
  this dataset carry **street names** (e.g. `Sangrado Street`), not
  hydrological boundaries.
- **Free-text notes**: `Comments`, `Description`, the three
  `Acquisition Comment` columns, `Hazard`, `NBC_Asset_Risk`.
- **Audit metadata**: `Created_By`, `Changed_By`, all `Date_*`,
  `Create_Time`, `Last_Changed_Time`, `Create_Terminal`,
  `Last_Changed_Terminal`, `Create_Window`, `Last_Changed_Window`.
- **Decisional scoring**: `Risk_Consequence`, `Risk_Likelihood`,
  `Criticality`, `Inherent_Risk`, `Score`, `FenceScore`, `Ranking`,
  `NEAR_FID`, `NEAR_DIST`.
- **CiA session URLs**: any column whose name contains `pagekey`,
  `session`, `url`, `terminal`, `window`, or whose value matches the
  CiA session pattern.

The exhaustive list of fields dropped against the current source is
in `data/assets/asset_metadata.json::fields_dropped`.

## Coordinate reference system

Output features are always WGS84 (EPSG:4326). The source already
provides `Longitude/Latitude` in WGS84 alongside the MGA Zone 56
endpoints; the script uses the WGS84 columns directly when present
and never re-projects MGA coordinates itself.

## Refresh procedure

1. Replace the source CSV with a fresh export from the council asset
   register. The export must contain at least:
   `OBJECTID`, `Asset_Classification`, `Longitude`, `Latitude` (or
   `XStart/YStart/XEnd/YEnd`).
2. Run `python scripts/build_asset_snapshot.py`. The script refuses to
   overwrite an existing **authoritative** snapshot without `--force`
   (see "Authoritative flag" below).
3. Inspect `data/assets/asset_metadata.json` — confirm `rows_in`,
   `rows_out`, `class_counts` look right and that `fields_dropped`
   covers any new sensitive columns the latest export may have
   introduced. If new sensitive columns appear, add them to
   `SENSITIVE_FIELDS_DROP` (or the substring list) and re-run before
   committing.
4. Audit per-feature property values against the substring list
   (see `python scripts/build_asset_snapshot.py` invocation followed by
   the audit pattern in this commit's verification trail).
5. Commit only `data/assets/stormwater_assets.geojson` and
   `data/assets/asset_metadata.json`. **Never commit the raw CSV.**

## Authoritative flag

`asset_metadata.json::is_authoritative` ships as `false`. It is the
operator's responsibility to flip it to `true` after:
- reviewing the field-drop list against the current source,
- confirming `is_synthetic === false`,
- confirming the CRS,
- spot-checking 10+ rows for sensitive value leaks.

The Phase 15 synthetic dataset at `data/stormwater_assets.json` should
be retired in Phase 15B once `is_authoritative === true` here.

## What this snapshot is not

- Not a failure prediction.
- Not an assertion of design exceedance.
- Not an AEP classification.
- Not a return-period assignment.
- Not a legal-liability indicator.
- Not authoritative for engineering decisions — it's a snapshot
  filtered for safe public-facing display.
