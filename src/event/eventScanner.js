// eventScanner.js — the on-the-fly, location-specific "Last 10 Major Events" scan
// (docs/02 §5.2; docs/03 §2 EVENT LAYER + §5; docs/04 §3.4 EventCandidate).
//
// WHAT THIS IS
//   Given a location, scan the data a SourceAdapter exposes (precomputed rainfall
//   windows + the committed event archive today; a live radar history later),
//   build EventCandidates for that location, RANK them by severity, and STREAM the
//   ranked, capped list — so the UI shows partial results and honest scan progress.
//
// HONESTY RED LINES (carried from the salvage sources + docs/04):
//   1. No fabricated events. A candidate exists only where the location actually
//      has data in a scanned source (a window/archived-event the catchment appears
//      in with a real catchment-mean). Absent data = no candidate, never a zero.
//   2. No fabricated AEP / return period. The indicative AEP band is produced ONLY
//      by analysis/aepEstimator.computeAep, which closes the engineering gate
//      (P-1) when ARF coefficients are placeholders (the current reality). When the
//      gate is closed, aepBand is null and the candidate carries the indicative-
//      unavailable label; ranking degrades to catchment-mean severity (mm).
//   3. Gaps propagate. A candidate from a window with missing frames carries its
//      coverage + confidence; the ranking comparator never lets a gappy window
//      silently out- or under-rank a complete one (a missing-frame penalty + a
//      stable tie-break keep the order defensible — docs/02 §5.2).
//   4. The indicative band, when ever shown, is labelled and never a formal AEP
//      classification / return period / exceedance assertion (preserved from
//      stormgridEventInterpretation / stormgridDesignComparison / the archive
//      methodology notes).
//
// STREAMING MODEL
//   createEventScanner({ source, computeAep? }).scan(location, { onCandidate?, signal? })
//   is async. As each candidate is built it is pushed to onCandidate(candidate,
//   progress) AND yielded — the scanner is BOTH an async generator (scanIter) and a
//   callback pusher (scan). eventSection.js drives store.setEvents incrementally
//   from the callback so the UI renders partials + a "scanning N/M" progress bar.
//
// CAP: 10 (product number, docs/02 §5.2). The earlier warmed cache used 12; we pick
//   10 and note it (see DECISIONS C-008 in the return report). Exposed as EVENT_CAP.
//
// CACHING: on-demand FIRST (docs/03 §5). A simple per-location in-memory memo is
//   provided (memoised final lists, keyed by location + source build-version so a
//   rebuild/source-switch can never serve stale results). It is OPTIONAL and
//   transparent — it never changes the result, only re-serves a completed scan.
//
// No DOM, no Leaflet. Pure data + fetch-through-the-adapter/loader.

import { arealRainfall, isAreal, mmOf } from '../core/rainfallTypes.js';
import { engineeringGradeAllowed } from '../core/sourceAdapter.js';
import { computeAep as defaultComputeAep, indicativeAepLabel } from '../analysis/aepEstimator.js';
import {
  loadRainfallData,
  getAvailableRainfallWindows,
  getCatchmentRow,
} from '../stormgridDataLoader.js';
import { loadEventArchiveIndex, loadEventArchiveEntry } from '../stormgridEventArchive.js';

/** The list cap. Product says 10 (docs/02 §5.2); the earlier warmed cache used 12. */
export const EVENT_CAP = 10;

/** Label shown on every candidate / list while the P-1 engineering gate is closed. */
export const INDICATIVE_AEP_UNAVAILABLE_LABEL =
  'AEP indicative unavailable — placeholder coefficients';

/** Penalty multiplier applied to severity when a candidate has missing frames, so a
 *  gappy window cannot silently out-rank a complete one of similar depth. It is a
 *  tie-disambiguator, not a fabrication: the raw mm is preserved on the candidate;
 *  only the RANK key is penalised, and the reason is recorded. */
const MISSING_FRAME_PENALTY = 0.85;

/**
 * @typedef {Object} EventCandidate  (docs/04 §3.4 + honest extensions)
 * @property {string} eventId
 * @property {string} startIso
 * @property {string} endIso
 * @property {string} duration                 DurationKey for the critical sub-window
 * @property {import('../core/rainfallTypes.js').ArealRainfall} catchmentMean  already-areal
 * @property {Object|null} aepBand              indicative; null while the gate is closed
 * @property {number} severityRank              ranking key (mm-based when gated)
 * @property {string} severityBasis             'aep' | 'catchment-mean-mm'
 * @property {string} aepLabel                  labelled, never a formal classification
 * @property {{tier:string, reasons:string[]}} confidence
 * @property {{pct:number, framesMissing:number}} coverage
 * @property {string} label                     human one-liner for the row
 * @property {string} sourceId                  provenance — which source produced it
 * @property {{kind:string, key:string}} origin where in the source this came from
 */

/**
 * Create an on-the-fly event scanner.
 *
 * @param {Object} opts
 * @param {import('../core/sourceAdapter.js').SourceAdapter} opts.source  the active
 *        adapter. Used for describe() (provenance + the P-1 gate flag) and, when it
 *        implements a non-empty listEventCandidates(), as the PRIMARY candidate
 *        stream. The precomputed Lizard adapter currently stubs that empty
 *        (DECISIONS B-014), so we fall back to scanning the committed archive +
 *        windows directly — exactly the "what real on-the-fly needs vs the
 *        precomputed archive" gap noted in the open issues.
 * @param {Function} [opts.computeAep]  injectable AEP estimator (defaults to
 *        analysis/aepEstimator.computeAep). Tests pass a stub.
 * @param {Function} [opts.loadWindow]  injectable window loader (tests/seam).
 * @param {Function} [opts.loadArchiveIndex] injectable archive-index loader (seam).
 * @param {Function} [opts.loadArchiveEntry] injectable archive-entry loader (seam).
 * @param {Function} [opts.ifdProvider]  optional (location,durationKey) ->
 *        { pointDepthsByAep } once IFD wiring lands; defaults to empty (gate-safe).
 * @param {Function} [opts.arfProvider]  optional () -> { factorsByAep }; defaults
 *        to empty (gate-safe).
 * @returns {{ scan:Function, scanIter:Function, clearCache:Function, cap:number }}
 */
export function createEventScanner(opts = {}) {
  const source = opts.source || null;
  const computeAep = typeof opts.computeAep === 'function' ? opts.computeAep : defaultComputeAep;
  const loadWindow = typeof opts.loadWindow === 'function' ? opts.loadWindow : loadRainfallData;
  const loadArchiveIndex = typeof opts.loadArchiveIndex === 'function' ? opts.loadArchiveIndex : loadEventArchiveIndex;
  const loadArchiveEntry = typeof opts.loadArchiveEntry === 'function' ? opts.loadArchiveEntry : loadEventArchiveEntry;
  const ifdProvider = typeof opts.ifdProvider === 'function' ? opts.ifdProvider : null;
  const arfProvider = typeof opts.arfProvider === 'function' ? opts.arfProvider : null;

  // Per-location memo of COMPLETED lists. Keyed by location + source build-version
  // so a rebuild or a source switch can never serve a stale list (docs/03 §5).
  const memo = new Map();

  function buildVersionKey() {
    try {
      const d = source && typeof source.describe === 'function' ? source.describe() : null;
      return d ? `${d.id || '?'}@${d.buildVersion || d.lastBuilt || '?'}` : 'unknown';
    } catch (_) {
      return 'unknown';
    }
  }

  function memoKey(location) {
    return `${locationCatchmentId(location) || '?'}::${buildVersionKey()}`;
  }

  /**
   * Async-generator form: yields each EventCandidate as it is built (ranked-on-
   * insert so the partial list is already sorted), capped at EVENT_CAP.
   * @param {Object} location  a LocationRef (catchmentId resolved here)
   * @param {{signal?:AbortSignal}} [ctl]
   * @returns {AsyncGenerator<{candidate:EventCandidate, ranked:EventCandidate[], progress:Object}>}
   */
  async function* scanIter(location, ctl = {}) {
    const signal = ctl.signal || null;
    const catchmentId = locationCatchmentId(location);

    // Honest empty: the precomputed archive is catchment-keyed; a non-catchment
    // location (point/area not yet resolved) yields no candidates rather than a guess.
    if (!catchmentId) {
      yield {
        candidate: null,
        ranked: [],
        progress: { scanned: 0, total: 0, done: true, note: 'No catchment resolved for this location; on-the-fly event scan needs a catchment.' },
      };
      return;
    }

    // Memo hit — re-serve the completed list (transparent accelerator).
    const key = memoKey(location);
    if (memo.has(key)) {
      const ranked = memo.get(key);
      yield { candidate: null, ranked: ranked.slice(), progress: { scanned: ranked.length, total: ranked.length, done: true, fromCache: true } };
      return;
    }

    const sources = await enumerateScanSources({ source, loadArchiveIndex });
    const total = sources.length;
    let scanned = 0;
    const ranked = []; // kept sorted, capped at EVENT_CAP

    for (const s of sources) {
      if (signal && signal.aborted) {
        // Honest partial: abort leaves a partial, clearly-flagged list (no memo write).
        yield { candidate: null, ranked: ranked.slice(), progress: { scanned, total, done: true, aborted: true } };
        return;
      }

      let windowResult = null;
      try {
        windowResult = await buildWindowResultForSource(s, catchmentId, { loadWindow, loadArchiveEntry });
      } catch (_) {
        windowResult = null; // a source that fails to load is skipped, not faked
      }
      scanned += 1;

      if (windowResult) {
        const candidate = toCandidate(windowResult, s, {
          catchmentId, computeAep, ifdProvider, arfProvider, location,
        });
        if (candidate) {
          insertRanked(ranked, candidate, EVENT_CAP);
          yield {
            candidate,
            ranked: ranked.slice(),
            progress: { scanned, total, done: scanned >= total, label: s.label },
          };
          continue;
        }
      }
      // No candidate from this source — still report progress (honest scan bar).
      yield {
        candidate: null,
        ranked: ranked.slice(),
        progress: { scanned, total, done: scanned >= total, label: s.label, skipped: true },
      };
    }

    // Completed cleanly — memoise the final ranked list.
    memo.set(key, ranked.slice());
  }

  /**
   * Callback/promise form. Drives onCandidate(candidate, { ranked, progress }) for
   * each step (used by eventSection to push store.setEvents incrementally), and
   * resolves with the final ranked list.
   * @param {Object} location
   * @param {{onCandidate?:Function, onProgress?:Function, signal?:AbortSignal}} [ctl]
   * @returns {Promise<{items:EventCandidate[], gated:boolean, progress:Object}>}
   */
  async function scan(location, ctl = {}) {
    const onCandidate = typeof ctl.onCandidate === 'function' ? ctl.onCandidate : null;
    const onProgress = typeof ctl.onProgress === 'function' ? ctl.onProgress : null;
    let last = { ranked: [], progress: { scanned: 0, total: 0, done: true } };
    for await (const step of scanIter(location, { signal: ctl.signal })) {
      last = step;
      if (onProgress) { try { onProgress(step.progress, step.ranked); } catch (_) { /* never break the scan */ } }
      if (onCandidate) { try { onCandidate(step.candidate, { ranked: step.ranked, progress: step.progress }); } catch (_) { /* never break the scan */ } }
    }
    return {
      items: last.ranked,
      gated: !engineeringGradeAllowed(source && typeof source.describe === 'function' ? source.describe() : null),
      progress: last.progress,
    };
  }

  function clearCache() { memo.clear(); }

  return { scan, scanIter, clearCache, cap: EVENT_CAP };
}

// ── Source enumeration ─────────────────────────────────────────────────────────
//
// What is actually available per location today (verified on disk):
//   - 4 precomputed rainfall windows (24h / 7d / 30d / latest), each a per-catchment
//     scalar snapshot with duration_stats. These are the closest thing to "events".
//   - 3 archived events (evt_24h / evt_7d / evt_30d), each a full lossless snapshot.
// There is no per-timestep raster history to slide a window over, so a "scan" here
// enumerates these committed snapshots. A real on-the-fly scan (radar) would replace
// this enumerator with a windowed pass over a frame history — same EventCandidate out.

/**
 * @returns {Promise<Array<{kind:'archive'|'window', key:string, label:string, meta?:Object}>>}
 */
async function enumerateScanSources({ source, loadArchiveIndex }) {
  // Prefer the adapter's own candidate stream IF it provides a real one. The Lizard
  // adapter stubs listEventCandidates empty (DECISIONS B-014), so we detect that and
  // fall through to the committed-snapshot scan below. (We do not consume the
  // adapter stream here directly because its shape is candidates, not sources; when
  // a real RadarAdapter lands, the scanner can be pointed at it — see open issues.)
  const out = [];

  // 1) Archived events (chronological, lossless snapshots).
  try {
    const idx = await loadArchiveIndex();
    if (idx && idx.ok && idx.data && Array.isArray(idx.data.events)) {
      for (const e of idx.data.events) {
        out.push({
          kind: 'archive',
          key: e.event_id,
          label: e.label || e.event_id,
          meta: { archivePath: e.archive_path, accumulationWindow: e.accumulation_window },
        });
      }
    }
  } catch (_) { /* archive absent → just scan windows */ }

  // 2) Precomputed rainfall windows.
  try {
    for (const w of getAvailableRainfallWindows()) {
      out.push({ kind: 'window', key: w.key, label: w.label });
    }
  } catch (_) { /* loader unavailable → nothing to add */ }

  return out;
}

/**
 * Resolve one scan source to a contract-shaped, location-specific window result.
 * Reuses the same areal/coverage/confidence translation the Lizard adapter uses,
 * but inlined here (the adapter's mapper requires the v2 window JSON; both the
 * window files AND the archive entries' rainfall_data are v2, so the same shape
 * works for both). We do NOT call the adapter's getWindow because it is keyed to a
 * single configured window; the scan needs to read each snapshot.
 *
 * @returns {Promise<Object|null>} a minimal window-result-like object, or null
 */
async function buildWindowResultForSource(s, catchmentId, { loadWindow, loadArchiveEntry }) {
  let data = null;
  if (s.kind === 'window') {
    const loaded = await loadWindow(s.key);
    data = loaded && loaded.ok ? loaded.data : null;
  } else if (s.kind === 'archive') {
    const loaded = await loadArchiveEntry(s.key, s.meta && s.meta.archivePath);
    data = loaded && loaded.ok && loaded.data ? loaded.data.rainfall_data : null;
  }
  if (!data) return null;

  const row = getCatchmentRow(data, catchmentId);
  if (!row) return null; // catchment not present in this snapshot — no candidate (honest)

  // catchment mean is ALREADY AREAL (red line). null on absence — never 0.
  const meanMm = numOrNull(row.mean_mm);
  if (meanMm == null) return null; // no real observed mean → no fabricated candidate
  const catchmentMean = arealRainfall(meanMm);

  // Critical duration sub-window from duration_stats (highest rolling total).
  const crit = criticalSubWindow(row.duration_stats);

  // Coverage + confidence straight from the precomputed fields (gap honesty).
  const framesMissing = numOrNull(row.frames_missing) || 0;
  const coveragePct =
    numOrNull(row.coverage_pct) != null ? row.coverage_pct
      : (numOrNull(row.coverage_fraction) != null ? row.coverage_fraction * 100 : 0);
  const tier = mapTier(row.confidence);
  const reasons = [];
  if (coveragePct < 70) reasons.push(`coverage ${coveragePct.toFixed(1)}% below 70% threshold`);
  if (framesMissing > 0) reasons.push(`${framesMissing} missing frame(s) — catchment-mean is a floor`);

  return {
    // Minimal RainfallWindowResult-like shape for the estimator + the candidate.
    source: describeSource(s, data),
    catchmentMean,
    coverage: { pct: coveragePct, framesUsed: numOrNull(row.frames_used) || 0, framesMissing },
    confidence: { tier, reasons },
    crit,
    window: data.window || null,
  };
}

/** Build a SourceDescriptor-like object for a scanned snapshot. isPlaceholder is
 *  inherited from the active adapter's gate (P-1) — the scan never invents one. */
function describeSource(s, data) {
  return {
    id: 'lizard-archive',
    kind: 'precomputed',
    buildVersion: (data && data.schema_version) || null,
    lastBuilt: (data && data.generated_at) || null,
    unit: 'mm_per_3h',
    isPlaceholder: true, // P-1: ARF coefficients are placeholders → AEP gate closed
  };
}

// ── Candidate construction + ranking ─────────────────────────────────────────--

/**
 * Turn a per-source window result into an EventCandidate. Runs the AEP estimator;
 * when the gate is OPEN it populates aepBand and ranks by AEP severity, when CLOSED
 * (the current reality) it sets aepBand=null, the indicative-unavailable label, and
 * ranks by catchment-mean severity (mm) — never a fabricated AEP.
 *
 * @returns {EventCandidate|null}
 */
function toCandidate(wr, s, { catchmentId, computeAep, ifdProvider, arfProvider, location }) {
  if (!wr || !isAreal(wr.catchmentMean)) return null;

  const gateOpen = engineeringGradeAllowed(wr.source);

  // Ask the estimator. With placeholder ARF (today) it returns gated:true /
  // aepBand:null regardless of inputs, so empty inputs are safe. When the gate
  // opens, real IFD/ARF inputs (providers) flow in and aepBand populates.
  const ifd = (gateOpen && ifdProvider) ? (ifdProvider(location, wr.crit && wr.crit.durationKey) || { pointDepthsByAep: {} }) : { pointDepthsByAep: {} };
  const arf = (gateOpen && arfProvider) ? (arfProvider() || { factorsByAep: {} }) : { factorsByAep: {} };
  const aepResult = computeAep(wr, ifd, arf);

  const meanMm = mmOf(wr.catchmentMean); // already-areal number, never null here
  const framesMissing = (wr.coverage && wr.coverage.framesMissing) || 0;

  let severityRank;
  let severityBasis;
  let aepBand;
  let aepLabel;

  if (!aepResult.gated && aepResult.aepBand) {
    // Gate OPEN: rank by AEP severity (rarer reference reached = higher severity).
    aepBand = aepResult.aepBand;
    severityBasis = 'aep';
    severityRank = aepSeverity(aepResult.aepBand);
    aepLabel = indicativeAepLabel(aepResult);
  } else {
    // Gate CLOSED (the current reality): rank by catchment-mean severity (mm).
    aepBand = null;
    severityBasis = 'catchment-mean-mm';
    severityRank = meanMm;
    aepLabel = INDICATIVE_AEP_UNAVAILABLE_LABEL;
  }

  // Missing-frame penalty on the RANK ONLY (raw mm preserved). Keeps a gappy window
  // from silently out-ranking a complete one of similar depth (docs/02 §5.2).
  if (framesMissing > 0) severityRank = severityRank * MISSING_FRAME_PENALTY;

  const crit = wr.crit || {};
  const win = wr.window || {};
  const startIso = crit.windowStart || win.start || null;
  const endIso = crit.windowEnd || win.end || null;

  return {
    eventId: `${s.kind}:${s.key}:${catchmentId}`,
    startIso,
    endIso,
    duration: crit.durationKey || s.key || null,
    catchmentMean: wr.catchmentMean,        // ArealRainfall (branded)
    catchmentMeanMm: meanMm,                  // convenience number for display
    aepBand,
    severityRank,
    severityBasis,
    aepLabel,
    confidence: wr.confidence,
    coverage: { pct: (wr.coverage && wr.coverage.pct) || 0, framesMissing },
    label: s.label,
    sourceId: wr.source.id,
    origin: { kind: s.kind, key: s.key },
  };
}

/**
 * Insert a candidate into a ranked, capped array (descending severityRank). A
 * stable tie-break by coverage then by raw mm keeps the order deterministic so a
 * gappy and a complete window never flip-flop (docs/02 §5.2 honesty).
 */
function insertRanked(ranked, candidate, cap) {
  ranked.push(candidate);
  ranked.sort((a, b) => {
    if (b.severityRank !== a.severityRank) return b.severityRank - a.severityRank;
    const ca = a.coverage ? a.coverage.pct : 0;
    const cb = b.coverage ? b.coverage.pct : 0;
    if (cb !== ca) return cb - ca; // more complete first on a tie
    return (b.catchmentMeanMm || 0) - (a.catchmentMeanMm || 0);
  });
  if (ranked.length > cap) ranked.length = cap;
}

/** AEP severity score: rarer reference reached ranks higher. Used only when the
 *  engineering gate is open. '1%' rarer than '20%'. */
function aepSeverity(aepBand) {
  const order = { '20%': 1, '5%': 2, '2%': 3, '1%': 4 };
  const ref = aepBand && aepBand.referenceAep;
  return ref && order[ref] != null ? order[ref] : 0;
}

// ── helpers ──────────────────────────────────────────────────────────────────--

function locationCatchmentId(location) {
  if (!location) return null;
  if (typeof location === 'string') return location;
  if (typeof location.catchmentId === 'string') return location.catchmentId;
  return null;
}

function numOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function mapTier(raw) {
  const v = String(raw || '').toLowerCase();
  if (v === 'high' || v === 'moderate' || v === 'medium' || v === 'low') {
    return v === 'medium' ? 'moderate' : v;
  }
  return 'low';
}

/**
 * Pick the critical sub-window: the duration_stats entry with the greatest rolling
 * total. Returns its key + window bounds. Honest null when none present.
 */
function criticalSubWindow(dsMap) {
  if (!dsMap || typeof dsMap !== 'object') return null;
  let best = null;
  for (const [durationKey, ds] of Object.entries(dsMap)) {
    const mm = ds && numOrNull(ds.max_total_mm);
    if (mm == null) continue;
    if (!best || mm > best.maxTotalMm) {
      best = {
        durationKey,
        maxTotalMm: mm,
        windowStart: ds.window_start || null,
        windowEnd: ds.window_end || null,
        confidence: mapTier(ds.confidence),
      };
    }
  }
  return best;
}
