# Stormgrid — SourceAdapter Contract (Phase B.1)

**Date:** 2026-05-21
**Status:** Authoritative interface contract. Everything in the Aggregation, Map, Analysis, Export, and Methodology layers consumes this and nothing else for rainfall data. Changing this contract is a cross-cutting change — do it deliberately.

The SourceAdapter is the seam from doc 03 §8: the single boundary between *where rainfall comes from* and *everything that uses it*. `LizardArchiveAdapter` satisfies it today (precomputed offline archive); a future `RadarAdapter` (BoM primary + RainViewer fallback) will satisfy the identical contract with no downstream change.

Code: `src/core/sourceAdapter.js` (interface, validator, registry) and `src/core/rainfallTypes.js` (branded value objects).

---

## 1. Design rules baked into the contract

1. **Areal vs point is a type boundary, not a flag** (doc 03 §4, red line). The observed catchment value the adapter returns is an `ArealRainfall` value object. Point IFD design depths are `PointDesignDepth` value objects. ARF conversion only accepts a `PointDesignDepth` and only emits an `ArealRainfall`. There is no code path where a number can stand in for either, and no flag toggles between them — passing the wrong kind throws. This makes "apply ARF twice to an already-areal mean" structurally impossible: the observed areal mean is never a `PointDesignDepth`, so it can never be fed to the ARF converter.
2. **Gaps propagate, never default** (red line). Every result carries `coverage`, `frameLog`, and `confidence`. A missing value is `null` with a recorded reason, never `0` and never absent. Consumers that drop a gap field fail validation.
3. **Provenance travels** (doc 02 §6, doc 03 §8). Every result carries a `source` descriptor (id, kind, build version, fallback usage). It flows unchanged into `buildEventFootprint` and every export, so any number can be traced to its origin.
4. **One uniform return shape** regardless of source kind. A precomputed window and a live aggregation return the same `RainfallWindowResult`. Consumers branch on data, never on `source.kind`.

---

## 2. The interface

```
SourceAdapter {
  describe(): SourceDescriptor
  getWindow(request: WindowRequest): Promise<RainfallWindowResult>
  listEventCandidates(request: EventScanRequest): AsyncIterable<EventCandidate>
}
```

`describe()` is synchronous and cheap (drives the always-visible ConfidenceChip's "Data source" + "Freshness" fields, doc 02 §6).
`getWindow()` returns the aggregated raster + statistics + gap accounting for one (location, timeframe, duration).
`listEventCandidates()` **streams** candidates (doc 02 §5.2) for on-the-fly "Last 10 Major Events"; it is an async iterable so the UI renders results as they arrive and shows honest scan progress.

---

## 3. Types

### 3.1 SourceDescriptor
```
SourceDescriptor {
  id:           string          // 'lizard-archive' | 'bom-radar' | …
  label:        string          // human label for the ConfidenceChip
  kind:         'precomputed' | 'live'
  buildVersion: string | null   // archive/build identifier; null for live
  lastBuilt:    ISO8601 | null   // freshness; null for live
  unit:         RainfallUnit     // declared frame unit (see P-2); e.g. 'mm_per_3h'
  isPlaceholder?: boolean        // true if any methodology input is placeholder-grade (P-1)
}
```

### 3.2 WindowRequest
```
WindowRequest {
  location:  LocationRef         // catchmentId | {lat,lon} | areaGeometryRef
  timeframe: Timeframe           // { kind:'window', windowKey, endIso } | { kind:'event', eventId }
  duration:  DurationKey         // '3h'|'6h'|'12h'|'24h'|'48h'|'72h'
  calibration: 'raw' | 'calibrated'
}
```

### 3.3 RainfallWindowResult — the central contract
```
RainfallWindowResult {
  source:        SourceDescriptor

  raster: {
    pngRef:      string          // URL/blob of the georeferenced overlay PNG
    grid:        RainfallGrid     // values_mm 2-D + bounds, for hover lookup
    leafletBounds: [[s,w],[n,e]]
  }

  catchmentMean: ArealRainfall   // ← the already-areal observed value. NEVER a PointDesignDepth.
  stats: {
    maxCell:     ArealRainfall | null
    minCell:     ArealRainfall | null
    meanCell:    ArealRainfall | null
    areaAbove:   { thresholdMm: number, fraction: number }[]
    spatialCv:   number | null
  }

  coverage: {
    pct:         number          // 0..100
    framesUsed:  number
    framesExpected: number
    framesMissing: number
  }
  frameLog:      FrameLogEntry[]  // per-frame: { iso, status:'valid'|'partial'|'missing', meanMm:number|null }
  confidence:    Confidence       // { tier:'high'|'moderate'|'low', reasons:string[] }

  durationStats: DurationStat[]   // rolling critical-duration stats per duration window
  calibration:   CalibrationMeta | null   // { applied, method, version, rawPreserved:true } or null
  warnings:      string[]         // e.g. 'synthetic-preview-overlay', 'placeholder-arf'
}
```

Hard rules on this shape:
- `catchmentMean` and every `stats.*` rainfall figure is an `ArealRainfall` (or `null` for a gap) — never a bare number, never a point value.
- `coverage`, `frameLog`, `confidence` are **required and non-empty**. The validator rejects a result missing any of them, or with a `framesMissing` that contradicts the `frameLog`.
- A gap is `null` + a `frameLog` entry with `status:'missing'`. Never `0`.

### 3.4 EventCandidate (streamed)
```
EventCandidate {
  eventId:      string
  startIso, endIso: ISO8601
  duration:     DurationKey
  catchmentMean: ArealRainfall
  aepBand:      AepBand | null   // indicative; null when the engineering gate (P-1) is closed
  severityRank: number           // ranking key — by AEP severity when gate open, else flagged indicative
  confidence:   Confidence
  coverage:     { pct, framesMissing }
}
```

`aepBand` is **`null` whenever the ARF placeholder gate is active** (P-1) — the stream still ranks and lists events, but the AEP column is suppressed and labelled "not engineering-defensible," never fabricated. When real coefficients land, the same stream populates `aepBand`.

### 3.5 Branded value objects (`rainfallTypes.js`)
```
ArealRainfall    { __brand:'areal',  mm:number }      // catchment-mean / radar-derived; already areal
PointDesignDepth { __brand:'point',  mm:number, aep:number, durationKey:string }   // IFD point value

applyArf(point: PointDesignDepth, arf: ArfFactor): ArealRainfall   // the ONLY areal-producing path from a point
```

`applyArf` is the single legitimate point→areal reduction (doc 01 §7). It throws if given anything that is not a `PointDesignDepth`. There is no inverse and no function that turns an `ArealRainfall` back into a `PointDesignDepth`, so an areal mean can never re-enter the ARF path.

---

## 4. What each consumer takes from the contract

- **Aggregation layer** — produces `RainfallWindowResult` (Lizard: fetch + assert; radar: aggregate in a worker). Owns `FrameQC`/`CoverageModel` and `CalibrationService`.
- **Map layer** — reads `raster`, `coverage`, `confidence`. Draws the imageOverlay PNG; the single legend binds to the grid's mm range; the single hover readout reports `grid` depth + `has_coverage`.
- **Analysis layer** — reads `catchmentMean` (areal) + `stats`; obtains `PointDesignDepth` from `IfdService`; calls `applyArf` on the point side only; compares. Emits `aepBand` only when the P-1 gate is open.
- **Methodology layer** — reads `source`, `coverage`, `frameLog`, `confidence`, `calibration`, `warnings`. Adds nothing of its own; it is a faithful renderer of the contract (doc 02 §6).
- **Export layer** — `buildEventFootprint` serialises `source` + `coverage` + `confidence` + `calibration` into every output; gaps are reported, never filled.

---

## 5. Validation

`validateWindowResult(result)` (in `sourceAdapter.js`) is run on every adapter return before it enters the store. It enforces: required gap fields present and internally consistent (`framesUsed + framesMissing` reconciles with `frameLog`), every rainfall figure is a branded `ArealRainfall` or explicit `null`, `source` present with a known `kind`, and `aepBand` suppressed when `source.isPlaceholder`. A failing result is surfaced as a data-quality ERROR state (doc 02 §3), never silently coerced.
