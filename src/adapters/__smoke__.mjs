// __smoke__.mjs — reusable smoke test for the Lizard mapping (run under node).
//
//   node src/adapters/__smoke__.mjs
//
// Browser fetch of ./data does not work under node, so this reads the real
// precomputed JSON via fs and feeds it through the PURE mapping function
// (mapToWindowResult), asserting validateWindowResult() passes for a real
// catchment. It also asserts: catchmentMean is a branded ArealRainfall, the
// descriptor declares isPlaceholder + mm_per_3h, the P-2 envelope is exercised,
// and a forged out-of-envelope value trips the guard + downgrades confidence.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { mapToWindowResult, describeFromData } from './lizardWindowMapping.js';
import { validateWindowResult } from '../core/sourceAdapter.js';
import { isAreal } from '../core/rainfallTypes.js';
import { checkFrameDepth, LIZARD_3H_ENVELOPE } from './lizardSanityEnvelope.js';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(here, '../../data');

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

function loadJson(name) {
  return JSON.parse(readFileSync(resolve(dataDir, name), 'utf8'));
}

let failures = 0;
function run(name, fn) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`FAIL  ${name}: ${err.message}`);
  }
}

console.log('Lizard adapter mapping smoke test');

const data = loadJson('catchment_rainfall_latest.json');
const firstId = Object.keys(data.catchments)[0];

run('descriptor declares placeholder + mm_per_3h + precomputed', () => {
  const d = describeFromData(data);
  assert(d.id === 'lizard-archive', `id was ${d.id}`);
  assert(d.kind === 'precomputed', `kind was ${d.kind}`);
  assert(d.unit === 'mm_per_3h', `unit was ${d.unit}`);
  assert(d.isPlaceholder === true, 'isPlaceholder must be true (P-1)');
  assert(d.buildVersion === data.schema_version, 'buildVersion from schema_version');
  assert(d.lastBuilt === data.generated_at, 'lastBuilt from generated_at');
});

run(`real catchment '${firstId}' maps to a contract-valid result`, () => {
  const result = mapToWindowResult(data, firstId, { durationKey: '24h' });
  validateWindowResult(result); // throws on any violation
  assert(isAreal(result.catchmentMean), 'catchmentMean must be ArealRainfall');
  assert(result.catchmentMean.mm === data.catchments[firstId].mean_mm, 'catchmentMean mm preserved');
  assert(result.warnings.includes('placeholder-arf'), 'placeholder-arf warning carried');
  assert(result.coverage.framesMissing === (data.catchments[firstId].frames_missing || 0), 'framesMissing preserved');
  assert(result.frameLog.length > 0, 'frameLog non-empty');
  assert(Array.isArray(result.durationStats) && result.durationStats.length > 0, 'durationStats present');
});

run('all 35 catchments in latest map to contract-valid results', () => {
  let n = 0;
  for (const id of Object.keys(data.catchments)) {
    validateWindowResult(mapToWindowResult(data, id, { durationKey: '24h' }));
    n += 1;
  }
  assert(n === Object.keys(data.catchments).length, 'mapped all catchments');
});

run('24h window file also maps clean for a real catchment', () => {
  const d24 = loadJson('catchment_rainfall_24h.json');
  const id = Object.keys(d24.catchments)[0];
  validateWindowResult(mapToWindowResult(d24, id, { durationKey: '12h' }));
});

run('P-2 envelope: plausible passes, gross unit error trips', () => {
  assert(checkFrameDepth(50).ok, '50 mm/3h should pass');
  assert(checkFrameDepth(0).ok, '0 should pass');
  assert(checkFrameDepth(null).ok, 'null gap should pass (not the guard\'s job)');
  assert(!checkFrameDepth(-1).ok, 'negative should trip');
  assert(!checkFrameDepth(LIZARD_3H_ENVELOPE.maxMm + 1).ok, 'over-envelope should trip');
});

run('forged out-of-envelope value carries warning + low confidence', () => {
  const forged = JSON.parse(JSON.stringify(data));
  const id = Object.keys(forged.catchments)[0];
  forged.catchments[id].mean_mm = 9999; // metres-as-mm style gross error
  const result = mapToWindowResult(forged, id, { durationKey: '24h' });
  validateWindowResult(result); // still a valid SHAPE — the error is surfaced, not thrown
  assert(result.warnings.includes('sanity-envelope-violation'), 'envelope warning carried');
  assert(result.confidence.tier === 'low', 'confidence downgraded to low');
  assert(result.confidence.reasons.some((r) => r.startsWith('sanity-envelope:')), 'reason recorded');
});

run('missing catchment throws a clear error', () => {
  let threw = false;
  try { mapToWindowResult(data, 'no_such_catchment'); } catch { threw = true; }
  assert(threw, 'should throw for unknown catchment');
});

console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
