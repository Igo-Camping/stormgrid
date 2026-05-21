// lizardArchiveAdapter.js — the first concrete SourceAdapter (Phase B.2, slice c).
//
// Satisfies the SourceAdapter contract (docs/04) for the precomputed offline
// Lizard precipitation archive. A future RadarAdapter satisfies the IDENTICAL
// contract with no downstream change.
//
// It REUSES the existing static data pipeline rather than re-implementing it:
//   - fetch + per-window cache: src/stormgridDataLoader.js (loadRainfallData)
//   - coverage / confidence / frame-log logic: already baked into the precomputed
//     JSON by scripts/build_static_rainfall.py; the adapter is a faithful
//     translator (see lizardWindowMapping.js), not a recomputation.
//
// describe()      → SourceDescriptor (id 'lizard-archive', kind 'precomputed',
//                   unit 'mm_per_3h', isPlaceholder:true per P-1).
// getWindow()     → fetch the requested window JSON, find the catchment, map to a
//                   contract RainfallWindowResult (validated before return).
// listEventCandidates() → stubbed (empty) — see the comment on the method. The
//                   real on-the-fly AEP event scan is Phase C (Event Layer).
//
// Registered via registerSourceAdapter('lizard-archive', factory) at module load.

import {
  loadRainfallData,
  DEFAULT_WINDOW_KEY,
} from '../stormgridDataLoader.js';
import { registerSourceAdapter } from '../core/sourceAdapter.js';
import { describeFromData, mapToWindowResult, LIZARD_SOURCE_ID } from './lizardWindowMapping.js';

/**
 * Resolve a WindowRequest's window key. The contract's timeframe carries a
 * windowKey for window requests; we default to the loader's DEFAULT_WINDOW_KEY.
 * Event timeframes ({kind:'event'}) are not served by the precomputed window
 * loader — that is the Event Layer's job (Phase C); we surface a clear error.
 * @param {Object} request
 * @returns {string}
 */
function resolveWindowKey(request) {
  const tf = request && request.timeframe;
  if (tf && tf.kind === 'event') {
    throw new Error(
      "lizard-archive getWindow() does not serve event timeframes; " +
      "use listEventCandidates()/the Event Layer (Phase C)."
    );
  }
  return (tf && tf.windowKey) || DEFAULT_WINDOW_KEY;
}

/**
 * Resolve the catchment id from the request location. The precomputed archive is
 * keyed by catchmentId; {lat,lon}/geometry resolution is the map/geo layer's job
 * (out of scope for this adapter slice).
 * @param {Object} request
 * @returns {string}
 */
function resolveCatchmentId(request) {
  const loc = request && request.location;
  if (typeof loc === 'string') return loc;
  if (loc && typeof loc.catchmentId === 'string') return loc.catchmentId;
  throw new Error(
    'lizard-archive getWindow() requires a catchmentId location ' +
    '(point/geometry resolution is not handled by the precomputed adapter).'
  );
}

/**
 * Factory: returns a SourceAdapter for the precomputed Lizard archive.
 * @returns {import('../core/sourceAdapter.js').SourceAdapter}
 */
export function createLizardArchiveAdapter() {
  // describe() must be synchronous + cheap (drives the ConfidenceChip). We have
  // no data loaded yet at describe()-time in the worst case, so we describe from
  // a null payload (buildVersion/lastBuilt null) and let getWindow() return the
  // data-derived descriptor inside each result.
  let lastSeenData = null;

  return {
    describe() {
      return describeFromData(lastSeenData);
    },

    async getWindow(request) {
      const windowKey = resolveWindowKey(request);
      const catchmentId = resolveCatchmentId(request);

      // Reuse the existing fetch + per-window cache.
      const loaded = await loadRainfallData(windowKey);
      if (!loaded || !loaded.ok || !loaded.data) {
        throw new Error(
          `lizard-archive: rainfall window '${windowKey}' not available ` +
          `(${(loaded && loaded.error) || 'unknown error'})`
        );
      }
      lastSeenData = loaded.data;

      // Detect whether an associated overlay is a synthetic preview, so we can
      // carry the 'synthetic-preview-overlay' warning. We do NOT fetch the
      // overlay raster here (the map layer owns that); we only flag it if the
      // request asks us to carry a preview raster reference.
      const raster = request && request.raster ? request.raster : null;

      // Pure mapping does the contract translation + validation.
      return mapToWindowResult(loaded.data, catchmentId, {
        durationKey: request && request.duration,
        raster,
      });
    },

    // listEventCandidates — INTENTIONAL STUB.
    // The real "Last N Major Events" scan is an on-the-fly AEP event scan that
    // belongs to the Event Layer (Phase C), not to this precomputed adapter.
    // Faking events here would violate the no-fabrication red line (docs/04 §3.4:
    // aepBand must be null while the P-1 gate is closed, and events must be real).
    // We therefore return an empty async-iterable and emit nothing. When Phase C
    // lands, it will either implement this here or wrap the adapter.
    async *listEventCandidates(_request) {
      // yields nothing — no real event scan exists for the precomputed archive yet.
      return;
    },
  };
}

// Register at module load. Selecting an adapter is a deliberate, logged action
// elsewhere — registration only makes it available by id.
registerSourceAdapter(LIZARD_SOURCE_ID, createLizardArchiveAdapter);

export { LIZARD_SOURCE_ID };
