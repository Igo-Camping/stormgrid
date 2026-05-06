#!/usr/bin/env node
/* Stormgrid — ARF golden + shape test runner.

   Loads data/arf_coefficients.json + tests/fixtures/arf_golden_cases.json,
   exercises src/stormgridArf.js, and reports:

     - shape tests (always run)
     - golden cases (run when populated; required for verified=true)
     - max absolute error
     - per-test pass/fail
     - whether verified=true is currently justifiable

   Exits 0 on pass, 1 on any test failure or any state where verified=true
   but tests don't justify it. */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, relative } from 'node:path';
import { computeArf } from '../src/stormgridArf.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const COEFF_PATH    = resolve(ROOT, 'data/arf_coefficients.json');
const FIXTURE_PATH  = resolve(ROOT, 'tests/fixtures/arf_golden_cases.json');

function loadJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

function fmtPath(p) { return relative(ROOT, p).replace(/\\/g, '/'); }

const coefficientsJson = loadJson(COEFF_PATH);
const fixture          = loadJson(FIXTURE_PATH);
const validity         = coefficientsJson.validity;
const defaultRegion    = coefficientsJson.default_region;
const tolerance        = fixture.default_tolerance_abs ?? 0.005;

console.log(`stormgrid arf-test`);
console.log(`  coeff:   ${fmtPath(COEFF_PATH)}  (verified: ${coefficientsJson.verified})`);
console.log(`  fixture: ${fmtPath(FIXTURE_PATH)}`);
console.log('');

let pass = 0;
let fail = 0;
const failures = [];

function pickCoeff(regionKey) {
  const r = coefficientsJson.regions[regionKey || defaultRegion];
  return r ? r.coefficients : null;
}

function record(passed, label, detail) {
  if (passed) { pass += 1; console.log(`  PASS  ${label}`); }
  else        { fail += 1; failures.push({ label, detail }); console.log(`  FAIL  ${label} — ${detail}`); }
}

// ── Shape tests ───────────────────────────────────────────────────────
console.log('shape tests:');
const coeff = pickCoeff(defaultRegion);
let maxObservedArf = 0;
let minObservedArf = 1;

for (const test of fixture.shape_tests || []) {
  if (test.type === 'shape_max_one') {
    let maxArf = -Infinity;
    let where = null;
    for (const A of test.params.areas_km2)
    for (const Dh of test.params.duration_hours)
    for (const aep of test.params.aep_fractions) {
      const r = computeArf({ areaKm2: A, durationHours: Dh, aep, coefficients: coeff, validity });
      if (typeof r.arf === 'number') {
        if (r.arf > maxArf) { maxArf = r.arf; where = { A, Dh, aep, arf: r.arf }; }
        if (r.arf > maxObservedArf) maxObservedArf = r.arf;
      }
    }
    const passed = maxArf <= 1 + 1e-9;
    record(passed, `${test.id}: max ARF observed = ${maxArf.toFixed(6)}`, passed ? '' : `> 1 at ${JSON.stringify(where)}`);
  } else if (test.type === 'shape_min_positive') {
    let minArf = Infinity;
    let where = null;
    for (const A of test.params.areas_km2)
    for (const Dh of test.params.duration_hours)
    for (const aep of test.params.aep_fractions) {
      const r = computeArf({ areaKm2: A, durationHours: Dh, aep, coefficients: coeff, validity });
      if (typeof r.arf === 'number') {
        if (r.arf < minArf) { minArf = r.arf; where = { A, Dh, aep, arf: r.arf }; }
        if (r.arf < minObservedArf) minObservedArf = r.arf;
      }
    }
    const passed = minArf > 0;
    record(passed, `${test.id}: min ARF observed = ${minArf.toFixed(6)}`, passed ? '' : `<= 0 at ${JSON.stringify(where)}`);
  } else if (test.type === 'shape_monotonic_area') {
    let violation = null;
    outer: for (const Dh of test.params.duration_hours)
            for (const aep of test.params.aep_fractions) {
      let prev = null;
      for (const A of test.params.areas_km2) {
        const r = computeArf({ areaKm2: A, durationHours: Dh, aep, coefficients: coeff, validity });
        if (prev != null && typeof r.arf === 'number' && r.arf > prev + 1e-9) {
          violation = { Dh, aep, A, arf: r.arf, prev };
          break outer;
        }
        if (typeof r.arf === 'number') prev = r.arf;
      }
    }
    const passed = violation == null;
    record(passed, `${test.id}: ARF non-increasing with area`, passed ? '' : `at ${JSON.stringify(violation)}`);
  } else if (test.type === 'shape_small_area_near_one') {
    let furthest = 0;
    let where = null;
    for (const Dh of test.params.duration_hours)
    for (const aep of test.params.aep_fractions) {
      const r = computeArf({ areaKm2: test.params.area_km2, durationHours: Dh, aep, coefficients: coeff, validity });
      if (typeof r.arf === 'number') {
        const dist = 1 - r.arf;
        if (dist > furthest) { furthest = dist; where = { Dh, aep, arf: r.arf }; }
      }
    }
    const passed = furthest <= test.params.max_distance_from_one;
    record(passed, `${test.id}: max (1 - ARF) at small area = ${furthest.toFixed(6)} (limit ${test.params.max_distance_from_one})`, passed ? '' : `at ${JSON.stringify(where)}`);
  } else if (test.type === 'shape_finite') {
    let bad = null;
    outer2: for (const A of test.params.areas_km2)
            for (const Dh of test.params.duration_hours)
            for (const aep of test.params.aep_fractions) {
      const r = computeArf({ areaKm2: A, durationHours: Dh, aep, coefficients: coeff, validity });
      if (r.arf == null) continue; // legitimately null on invalid input — that's the engine's job
      if (!Number.isFinite(r.arf) || r.arf <= 0 || r.arf > 1.000001) {
        bad = { A, Dh, aep, arf: r.arf, flags: r.flags };
        break outer2;
      }
    }
    const passed = bad == null;
    record(passed, `${test.id}: every numeric ARF in (0, 1]`, passed ? '' : `at ${JSON.stringify(bad)}`);
  } else {
    record(false, `${test.id}: unknown test type ${test.type}`, '');
  }
}

const shapePassed = fail === 0;
const shapePassedCount = pass;
const shapeFailedCount = fail;

// ── Golden cases ──────────────────────────────────────────────────────
console.log('\ngolden cases:');
const goldenStart = pass + fail;
let maxAbsErr = 0;
const golden = fixture.golden_cases || [];
if (golden.length === 0) {
  console.log('  SKIP  no golden cases populated. Run docs/arf_methodology.md §4 step 2 to add them.');
} else {
  for (const c of golden) {
    const region = c.region || defaultRegion;
    const cf = pickCoeff(region);
    if (!cf) {
      record(false, `${c.id}: region ${region} not found`, '');
      continue;
    }
    const r = computeArf({
      areaKm2: c.area_km2,
      durationHours: c.duration_hours,
      aep: c.aep_fraction,
      coefficients: cf,
      validity,
    });
    const tol = c.tolerance_abs ?? tolerance;
    if (typeof r.arf !== 'number') {
      record(false, `${c.id}: engine returned null (flags ${JSON.stringify(r.flags)})`, '');
      continue;
    }
    const err = Math.abs(r.arf - c.expected_arf);
    if (err > maxAbsErr) maxAbsErr = err;
    record(err <= tol,
      `${c.id}: actual=${r.arf.toFixed(6)} expected=${c.expected_arf.toFixed(6)} err=${err.toFixed(6)} tol=${tol}`,
      `error ${err.toFixed(6)} > tolerance ${tol}`);
  }
}

const goldenTotal  = golden.length;
const goldenPassed = (pass + fail - goldenStart) - (fail - shapeFailedCount);

// ── Summary + verified-flag check ─────────────────────────────────────
console.log('');
console.log(`summary:`);
console.log(`  shape tests:  ${shapePassedCount}/${shapePassedCount + shapeFailedCount} pass`);
console.log(`  golden cases: ${goldenPassed}/${goldenTotal} pass${goldenTotal === 0 ? ' (none populated)' : ''}`);
console.log(`  max abs err:  ${maxAbsErr.toFixed(6)}`);
console.log(`  verified flag in coefficients JSON: ${coefficientsJson.verified}`);

let exitCode = 0;
if (fail > 0) {
  console.log(`\nFAIL — ${fail} test(s) failed`);
  exitCode = 1;
}
const minRequired = (coefficientsJson.verification_protocol && coefficientsJson.verification_protocol.minimum_golden_cases_per_region) || 6;
const regionCount = Object.keys(coefficientsJson.regions || {}).length;
const minTotalGolden = minRequired * Math.max(1, regionCount);
if (coefficientsJson.verified === true && (goldenTotal < minTotalGolden || maxAbsErr > tolerance || !shapePassed)) {
  console.log(`\nFAIL — verified=true is set but: shape pass=${shapePassed}, golden ${goldenTotal}/${minTotalGolden} required, max_err=${maxAbsErr.toFixed(6)} (limit ${tolerance})`);
  exitCode = 1;
}
if (coefficientsJson.verified !== true && goldenTotal === 0) {
  console.log(`\nNOTE — verified=false and no golden cases populated. Build the fixture before flipping verified=true.`);
}

// Optional: write a stamped verification_status block back into the JSON
// when called with --update-status. We never auto-flip verified.
if (process.argv.includes('--update-status')) {
  coefficientsJson.verification_status = {
    last_run_at:         new Date().toISOString(),
    shape_tests_passed:  shapePassed,
    golden_cases_passed: goldenPassed,
    golden_cases_total:  goldenTotal,
    max_abs_error:       Number(maxAbsErr.toFixed(6)),
    tolerance_abs:       tolerance,
    regions_verified:    coefficientsJson.regions
      ? Object.entries(coefficientsJson.regions).filter(([_, r]) => r && r.verified === true).map(([k]) => k)
      : [],
  };
  writeFileSync(COEFF_PATH, JSON.stringify(coefficientsJson, null, 2) + '\n', 'utf8');
  console.log(`\nverification_status updated in ${fmtPath(COEFF_PATH)}`);
}

process.exit(exitCode);
