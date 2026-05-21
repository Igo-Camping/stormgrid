// __smoke__.mjs — Analysis layer smoke test (node, no browser, no fetch).
//
//   node src/analysis/__smoke__.mjs
//
// Proves the two red lines encoded in the Analysis layer:
//   1. The engineering gate (P-1): a placeholder source suppresses the AEP number
//      (gated:true, aepBand:null) — never fabricated.
//   2. The areal-vs-point boundary: applyArf throws on the observed areal mean
//      (the forbidden double-ARF reduction), and applying ARF to a POINT depth
//      reduces it (areal design < point depth for an ARF < 1).
//
// Plus: ungated path emits an indicative (number-free-of-RP) band; computeSummary
// reads areal values for display and never coerces a gap to 0.

import assert from 'node:assert/strict';
import {
  arealRainfall,
  pointDesignDepth,
  arfFactor,
  applyArf,
  mmOf,
} from '../core/rainfallTypes.js';
import { sourceDescriptor } from '../core/sourceAdapter.js';
import { computeAep, indicativeAepLabel, GATE_REASON_PLACEHOLDER_ARF } from './aepEstimator.js';
import { computeSummary, criticalDurationOf } from './summaryStats.js';
import { arfFactorFor, PLACEHOLDER_COEFFICIENTS, PLACEHOLDER_VALIDITY, isPlaceholderTable } from './arfEngine.js';

let passed = 0;
const ok = (label) => { console.log(`  PASS  ${label}`); passed += 1; };

// ── Fixtures ──────────────────────────────────────────────────────────────────
const placeholderSource = sourceDescriptor({
  id: 'lizard-archive', label: 'Lizard (precomputed)', kind: 'precomputed',
  buildVersion: 'v2', lastBuilt: '2026-05-06T21:13:41Z', unit: 'mm_per_3h',
  isPlaceholder: true, // P-1 gate CLOSED
});
const engineeringSource = sourceDescriptor({
  id: 'bom-radar', label: 'BoM radar', kind: 'live', unit: 'mm_per_3h',
  isPlaceholder: false, // gate OPEN (hypothetical, for the ungated-path test)
});

// observed catchment mean is ALREADY AREAL.
const observedMean = arealRainfall(268);

function makeWindowResult(source) {
  return {
    source,
    catchmentMean: observedMean, // ArealRainfall — never a point value
    stats: {
      maxCell: arealRainfall(312),
      minCell: arealRainfall(141),
      meanCell: observedMean,
      areaAbove: [],
      spatialCv: 0.18,
    },
    coverage: { pct: 96, framesUsed: 24, framesExpected: 24, framesMissing: 0 },
    frameLog: [{ iso: '2026-05-18T00:00:00Z', status: 'valid', meanMm: null }],
    confidence: { tier: 'high', reasons: [] },
    durationStats: [
      { durationKey: '24h', maxAccumulated: arealRainfall(268) },
      { durationKey: '48h', maxAccumulated: arealRainfall(301) },
      { durationKey: '6h', maxAccumulated: arealRainfall(120) },
    ],
    calibration: null,
    warnings: ['placeholder-arf'],
  };
}

console.log('Analysis layer smoke test\n');

// ── 1. GATE: placeholder source suppresses the AEP number ──────────────────────
{
  const wr = makeWindowResult(placeholderSource);
  // Even with REAL-looking IFD + ARF inputs, the gate must close the AEP off.
  const point = pointDesignDepth(270, 0.01, '24h');
  const arf = arfFactor(0.95, false);
  const res = computeAep(wr, { pointDepthsByAep: { '1%': point } }, { factorsByAep: { '1%': arf } });

  assert.equal(res.gated, true, 'placeholder source must gate');
  assert.equal(res.aepBand, null, 'gated result must have aepBand === null');
  assert.equal(res.reason, GATE_REASON_PLACEHOLDER_ARF, 'gated reason must be the placeholder reason');
  ok(`gate closed under placeholder source → gated:true, aepBand:null, reason="${res.reason}"`);

  const label = indicativeAepLabel(res);
  assert.equal(label, GATE_REASON_PLACEHOLDER_ARF, 'gated label must be the reason, not a number');
  assert.equal(/\d/.test(label.replace('P-1', '')), false, 'gated AEP label must contain no AEP number');
  ok(`gated summary label is the reason and contains no AEP number → "${label}"`);
}

// ── 2. RED LINE: applyArf throws on the observed AREAL mean ─────────────────────
{
  const arf = arfFactor(0.9, false);
  assert.throws(
    () => applyArf(observedMean, arf),
    /PointDesignDepth/,
    'applyArf must throw when handed the observed areal mean (double-ARF)'
  );
  ok('applyArf(observedArealMean, arf) THROWS — observed mean can never be ARF-reduced');

  // Belt-and-braces: computeAep itself never reduces the observed mean. We assert
  // the observed value object is byte-for-byte the same areal value after a run.
  const wr = makeWindowResult(engineeringSource);
  const before = mmOf(wr.catchmentMean);
  computeAep(
    wr,
    { pointDepthsByAep: { '1%': pointDesignDepth(270, 0.01, '24h') } },
    { factorsByAep: { '1%': arfFactor(0.95, false) } }
  );
  assert.equal(mmOf(wr.catchmentMean), before, 'observed mean must be unchanged after computeAep');
  assert.equal(before, 268, 'observed mean is the raw areal 268 mm — not ARF-reduced');
  ok('observed areal mean is unchanged (268 mm) after computeAep — compared directly, never reduced');
}

// ── 3. ARF applied to a POINT depth reduces it ─────────────────────────────────
{
  const point = pointDesignDepth(270, 0.01, '24h'); // 1% AEP, 24h point IFD depth
  const arf = arfFactor(0.93, false);
  const areal = applyArf(point, arf); // the ONLY point→areal reduction
  assert.equal(areal.__brand, 'areal', 'applyArf returns an ArealRainfall');
  assert.ok(mmOf(areal) < mmOf(point), 'ARF (<1) must reduce the point depth');
  assert.equal(Number(mmOf(areal).toFixed(2)), Number((270 * 0.93).toFixed(2)), 'areal = point * arf');
  ok(`applyArf(point 270mm, arf 0.93) = ${mmOf(areal).toFixed(1)}mm areal (< 270mm point) — point side reduced`);
}

// ── 4. UNGATED path emits an indicative band; observed compared to ARF-reduced ──
{
  const wr = makeWindowResult(engineeringSource); // gate OPEN
  // point 24h 1% = 270mm; ARF 0.95 → areal design 256.5mm. observed 268mm > 256.5 → at_or_above.
  const res = computeAep(
    wr,
    { pointDepthsByAep: { '1%': pointDesignDepth(270, 0.01, '24h'), '20%': pointDesignDepth(140, 0.2, '24h') } },
    { factorsByAep: { '1%': arfFactor(0.95, false), '20%': arfFactor(0.95, false) } }
  );
  assert.equal(res.gated, false, 'engineering source must not gate');
  assert.ok(res.aepBand, 'ungated result has an aepBand');
  assert.equal(res.aepBand.indicative, true, 'band is flagged indicative');
  assert.equal(res.aepBand.disclaimer.event_aep_classified, false, 'never classifies an event AEP');
  // observed 268 vs ARF-reduced 1% design 256.5 → ratio > 1 → reference reached at 1%.
  assert.equal(res.aepBand.referenceAep, '1%', 'observed exceeds the ARF-reduced 1% areal design');
  const label = indicativeAepLabel(res);
  assert.match(label, /indicative/, 'ungated label is flagged indicative');
  assert.doesNotMatch(label, /1 in /, 'never a "1 in X" return period');
  ok(`ungated path: indicative band referenceAep=1%, label="${label}" (no return period)`);
}

// ── 5. computeSummary reads areal values; gaps stay null, critical duration found ─
{
  const wr = makeWindowResult(placeholderSource);
  const sum = computeSummary(wr, '24h');
  assert.equal(sum.catchmentMean, 268, 'catchment mean read as areal mm');
  assert.equal(sum.maxCell, 312, 'max cell read as areal mm');
  assert.equal(sum.criticalDuration, '48h', 'critical duration = max accumulated (48h, 301mm)');
  assert.equal(sum.criticalDepthMm, 301, 'critical depth = 301mm');
  ok(`computeSummary: mean 268mm, max 312mm, critical 48h@301mm, CV ${sum.spatialCv} (${sum.spatialUniformity})`);

  // gap honesty: a windowResult with a null mean must yield null, never 0.
  const gapWr = makeWindowResult(placeholderSource);
  gapWr.catchmentMean = null;
  const gapSum = computeSummary(gapWr, '24h');
  assert.equal(gapSum.catchmentMean, null, 'a gap stays null — never coerced to 0');
  ok('computeSummary: a missing catchment mean stays null (gap honesty), not 0');

  // empty durationStats → no critical duration, not a fabricated one.
  assert.deepEqual(criticalDurationOf([]), { durationKey: null, depthMm: null });
  ok('criticalDurationOf([]) → null/null (no fabricated critical duration)');
}

// ── 6. arfEngine: placeholder coefficients reduce, table flagged placeholder ────
{
  // Placeholder table (verified:false) is placeholder-grade.
  assert.equal(isPlaceholderTable({ verified: false, default_region: 'east_coast_north', regions: { east_coast_north: { verified: false } } }), true);
  assert.equal(isPlaceholderTable({ verified: true, default_region: 'r', regions: { r: { verified: true } } }), false);
  ok('isPlaceholderTable: unverified → placeholder (gate stays closed); fully verified → engineering-grade');

  // The placeholder form computes an ARF in (0,1] for a typical catchment.
  const r = arfFactorFor({ areaKm2: 7.8, durationHours: 24, aep: 0.01, coefficients: PLACEHOLDER_COEFFICIENTS, validity: PLACEHOLDER_VALIDITY });
  assert.equal(r.ok, true, 'placeholder ARF computes');
  assert.ok(r.factor.value > 0 && r.factor.value <= 1, 'ARF in (0,1]');
  assert.equal(r.factor.extrapolated, false, '24h/7.8km2 is within validity');
  ok(`arfFactorFor(7.8km2, 24h, 1%) = ${r.factor.value} (in (0,1], not extrapolated)`);

  // Out-of-validity duration flags extrapolated.
  const rx = arfFactorFor({ areaKm2: 7.8, durationHours: 6, aep: 0.01, coefficients: PLACEHOLDER_COEFFICIENTS, validity: PLACEHOLDER_VALIDITY });
  assert.equal(rx.factor.extrapolated, true, '6h is below the 24h validity floor → extrapolated');
  ok(`arfFactorFor(6h) flagged extrapolated:true (below 24h validity floor)`);
}

console.log(`\nAll ${passed} assertions passed.`);
