// __smoke__.mjs — contract tests for the core (Phase E: contracts airtight).
// Covers the branded areal/point types, the SourceAdapter result validator
// (gap-honesty + reconciliation), the gate, and the store's phase machine +
// invalidation + URL round-trip. Run: node src/core/__smoke__.mjs
//
// Node-runnable (no DOM): the store and these contracts are framework-free.

import { arealRainfall, pointDesignDepth, arfFactor, applyArf, isAreal, mmOf } from './rainfallTypes.js';
import {
  sourceDescriptor, coverage, frameLogEntry, confidence,
  validateWindowResult, engineeringGradeAllowed,
} from './sourceAdapter.js';
import { createStore, actions, select } from './store.js';
import { contextToQuery, queryToContext } from './urlState.js';

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name); } }
function throws(name, fn) { try { fn(); ok(name, false); } catch { ok(name, true); } }

// ── branded types ────────────────────────────────────────────────────────────
ok('arealRainfall is branded areal', isAreal(arealRainfall(10)));
ok('applyArf(point, arf) reduces to areal', applyArf(pointDesignDepth(300, 0.01, '24h'), arfFactor(0.9)).mm === 270);
throws('applyArf(areal, arf) throws (no double-ARF)', () => applyArf(arealRainfall(268), arfFactor(0.9)));
ok('mmOf(null) is null, never 0 (gap honesty)', mmOf(null) === null);
throws('arealRainfall(negative) throws', () => arealRainfall(-1));

// ── a valid result for the validator ─────────────────────────────────────────
function validResult(overrides = {}) {
  return {
    source: sourceDescriptor({ id: 'lizard-archive', kind: 'precomputed', unit: 'mm_per_3h', isPlaceholder: true }),
    raster: null,
    catchmentMean: arealRainfall(268),
    stats: { maxCell: arealRainfall(312), minCell: arealRainfall(141), meanCell: arealRainfall(268), areaAbove: [], spatialCv: 0.18 },
    coverage: coverage({ pct: 96, framesUsed: 1, framesExpected: 3, framesMissing: 2 }),
    frameLog: [
      frameLogEntry({ iso: 't1', status: 'valid', meanMm: 10 }),
      frameLogEntry({ iso: 't2', status: 'missing', meanMm: null }),
      frameLogEntry({ iso: 't3', status: 'missing', meanMm: null }),
    ],
    confidence: confidence('high', ['96% coverage']),
    durationStats: [], calibration: null, warnings: ['placeholder-arf'],
    ...overrides,
  };
}

// ── validator: gap-honesty + reconciliation ──────────────────────────────────
ok('valid result passes validateWindowResult', !!validateWindowResult(validResult()));
throws('missing coverage rejected', () => validateWindowResult(validResult({ coverage: undefined })));
throws('empty frameLog rejected', () => validateWindowResult(validResult({ frameLog: [] })));
throws('framesMissing mismatch rejected', () => validateWindowResult(validResult({
  coverage: coverage({ pct: 96, framesUsed: 1, framesExpected: 3, framesMissing: 99 }),
})));
throws('missing frame with a value rejected at construction', () => frameLogEntry({ iso: 't', status: 'missing', meanMm: 0 }));
throws('catchmentMean as bare number rejected', () => validateWindowResult(validResult({ catchmentMean: 268 })));

// ── the engineering gate (P-1) ────────────────────────────────────────────────
ok('placeholder source: engineering-grade NOT allowed', engineeringGradeAllowed(sourceDescriptor({ id: 'x', kind: 'precomputed', unit: 'mm_per_3h', isPlaceholder: true })) === false);
ok('non-placeholder source: engineering-grade allowed', engineeringGradeAllowed(sourceDescriptor({ id: 'x', kind: 'live', unit: 'mm_per_3h' })) === true);

// ── store: phase machine + invalidation ───────────────────────────────────────
const s = createStore();
ok('initial phase EMPTY', select.phase(s.getState()) === 'EMPTY');
s.dispatch(actions.setLocation({ catchmentId: 'C12' }));
ok('setLocation -> LOCATED', select.phase(s.getState()) === 'LOCATED');
s.dispatch(actions.setTimeframe({ kind: 'window', windowKey: '24h', endIso: '2026-05-18T12:00:00Z' }));
ok('setTimeframe -> AGGREGATING', select.phase(s.getState()) === 'AGGREGATING');
ok('setTimeframe invalidates windowResult', select.windowResult(s.getState()) === null);
s.dispatch(actions.setWindowData(validResult()));
ok('setWindowData with missing frames -> DEGRADED', select.phase(s.getState()) === 'DEGRADED');
s.dispatch(actions.setLocation({ catchmentId: 'C13' }));
ok('changing location invalidates the window', select.windowResult(s.getState()) === null && select.phase(s.getState()) === 'LOCATED');

// ── URL round-trip ────────────────────────────────────────────────────────────
s.dispatch(actions.setTimeframe({ kind: 'event', eventId: 'E7' }));
const q = contextToQuery(select.context(s.getState()));
const ctx = queryToContext(q);
ok('URL round-trip preserves location', ctx.location && ctx.location.catchmentId === 'C13');
ok('URL round-trip preserves event timeframe', ctx.timeframe && ctx.timeframe.kind === 'event' && ctx.timeframe.eventId === 'E7');
ok('a query with no loc yields no fabricated location', queryToContext('dur=24h').location === undefined);

console.log(`\ncore contract smoke: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
