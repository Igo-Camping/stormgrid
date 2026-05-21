// __smoke__.mjs — node smoke test for the aggregation layer (run under node):
//
//   node src/aggregation/__smoke__.mjs
//
// Exercises the real store + the real Lizard mapping (fed an fs-read JSON), with
// a fake adapter, to assert the controller's spine behaviour and the calibration
// service's raw-preservation — the two load-bearing red lines:
//   • a settled fetch lands a contract-valid window in the store
//   • a stale resolve (request key changed mid-flight) is DROPPED, never stored
//   • a failed fetch produces an ERROR with a data-quality message, never stale data
//   • a duration change does NOT trigger a refetch (re-derive from durationStats)
//   • a calibration toggle re-derives from the loaded window WITHOUT a refetch
//   • the calibrated copy preserves raw_* and tags applied/method/version + synthetic

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { createStore, initialState, actions, select } from '../core/store.js';
import { isAreal } from '../core/rainfallTypes.js';
import { mapToWindowResult } from '../adapters/lizardWindowMapping.js';
import { createAggregationController } from './aggregationController.js';
import { deriveCalibratedResult } from './calibrationService.js';
import * as coverageModel from './coverageModel.js';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(here, '../../data');
const loadJson = (n) => JSON.parse(readFileSync(resolve(dataDir, n), 'utf8'));

const data = loadJson('catchment_rainfall_latest.json');
const CID = Object.keys(data.catchments)[0];
const realResult = () => mapToWindowResult(data, CID, { durationKey: '24h' });

function assert(cond, msg) { if (!cond) throw new Error(`ASSERT FAILED: ${msg}`); }
const tick = () => new Promise((r) => setTimeout(r, 0));

let failures = 0;
async function run(name, fn) {
  try { await fn(); console.log(`  ok  ${name}`); }
  catch (err) { failures += 1; console.error(`FAIL  ${name}: ${err.message}`); }
}

console.log('Aggregation layer smoke test');

// ── Controller: happy path settles a window ─────────────────────────────────
await run('AGGREGATING → fetch → SETTLED stores the contract-valid window', async () => {
  const store = createStore(seed());
  let calls = 0;
  const source = {
    describe: () => ({ label: 'fake' }),
    async getWindow() { calls += 1; return realResult(); },
  };
  const ctrl = createAggregationController(store, source);
  ctrl.start();
  store.dispatch(actions.setLocation({ catchmentId: CID }));
  store.dispatch(actions.setTimeframe({ kind: 'window', windowKey: 'latest' }));
  await tick();
  assert(calls === 1, `getWindow called once, got ${calls}`);
  const phase = select.phase(store.getState());
  assert(phase === 'SETTLED' || phase === 'DEGRADED', `phase was ${phase}`);
  assert(isAreal(select.windowResult(store.getState()).catchmentMean), 'catchmentMean is areal');
  ctrl.stop();
});

// ── Controller: latest-wins — a stale resolve is dropped ─────────────────────
await run('stale resolve (key changed mid-flight) is DROPPED, never stored', async () => {
  const store = createStore(seed());
  let release1;
  const gate1 = new Promise((r) => { release1 = r; });
  let n = 0;
  const source = {
    describe: () => ({ label: 'fake' }),
    async getWindow(req) {
      n += 1;
      if (n === 1) { await gate1; return tagged(realResult(), 'STALE'); }
      return tagged(realResult(), 'FRESH');
    },
  };
  const ctrl = createAggregationController(store, source);
  ctrl.start();
  store.dispatch(actions.setLocation({ catchmentId: CID }));
  store.dispatch(actions.setTimeframe({ kind: 'window', windowKey: 'A' })); // fires fetch #1 (gated)
  store.dispatch(actions.setTimeframe({ kind: 'window', windowKey: 'B' })); // fires fetch #2 (fresh)
  await tick();
  release1(); // now let the STALE fetch #1 resolve late
  await tick();
  const stored = select.windowResult(store.getState());
  assert(stored && stored.__tag === 'FRESH', `stored tag was ${stored && stored.__tag} (stale must be dropped)`);
  ctrl.stop();
});

// ── Controller: a failed fetch is an ERROR, never stale/fabricated data ──────
await run('failed fetch → ERROR with data-quality message, no stale data', async () => {
  const store = createStore(seed());
  const source = {
    describe: () => ({ label: 'Lizard archive' }),
    async getWindow() { throw new Error('window not available'); },
  };
  const ctrl = createAggregationController(store, source);
  ctrl.start();
  store.dispatch(actions.setLocation({ catchmentId: CID }));
  store.dispatch(actions.setTimeframe({ kind: 'window', windowKey: 'X' }));
  await tick();
  assert(select.phase(store.getState()) === 'ERROR', 'phase must be ERROR');
  assert(select.windowResult(store.getState()) === null, 'no window data on error');
  const msg = select.error(store.getState());
  assert(/Lizard archive/.test(msg) && /No fallback/.test(msg), `message was: ${msg}`);
  ctrl.stop();
});

// ── Controller: duration change does NOT refetch ─────────────────────────────
await run('SET_DURATION does not trigger a refetch (re-derive from durationStats)', async () => {
  const store = createStore(seed());
  let calls = 0;
  const source = { describe: () => ({}), async getWindow() { calls += 1; return realResult(); } };
  const ctrl = createAggregationController(store, source);
  ctrl.start();
  store.dispatch(actions.setLocation({ catchmentId: CID }));
  store.dispatch(actions.setTimeframe({ kind: 'window', windowKey: 'latest' }));
  await tick();
  assert(calls === 1, 'one fetch after timeframe');
  store.dispatch(actions.setDuration('12h')); // must NOT refetch
  await tick();
  assert(calls === 1, `still one fetch after duration change, got ${calls}`);
  // and the loaded window carries the 12h durationStat for the re-derive
  const ds = coverageModel.durationStatFor(select.windowResult(store.getState()), '12h');
  assert(ds && ds.durationKey === '12h', '12h durationStat available for re-derive');
  ctrl.stop();
});

// ── Controller: calibration toggle re-derives WITHOUT a refetch ──────────────
await run('calibration toggle re-derives from loaded window, no refetch', async () => {
  const store = createStore(seed());
  let calls = 0;
  const source = { describe: () => ({}), async getWindow() { calls += 1; return realResult(); } };
  const ctrl = createAggregationController(store, source);
  ctrl.start();
  store.dispatch(actions.setLocation({ catchmentId: CID }));
  store.dispatch(actions.setTimeframe({ kind: 'window', windowKey: 'latest' }));
  await tick();
  assert(calls === 1, 'one fetch after timeframe');
  store.dispatch(actions.setCalibration('calibrated'));
  await tick();
  assert(calls === 1, `no refetch on calibration toggle, got ${calls} calls`);
  const r = select.windowResult(store.getState());
  assert(r.calibration && r.calibration.rawPreserved === true, 'calibrated copy in store, raw preserved');
  ctrl.stop();
});

// ── CalibrationService: raw preserved, labelled, versioned, synthetic warned ─
await run('deriveCalibratedResult preserves raw + tags meta + synthetic warning', async () => {
  const raw = realResult();
  const rawMean = raw.catchmentMean.mm;
  const cal = await deriveCalibratedResult(raw, { factor: 1.25, synthetic: true });
  // raw object untouched
  assert(raw.catchmentMean.mm === rawMean, 'raw result not mutated');
  assert(Object.isFrozen(raw.catchmentMean), 'raw areal value still frozen');
  // calibrated scaled + raw preserved on the copy
  // scaleAreal rounds calibrated mm to 3 dp (round3) by design; compare to the
  // same rounded expectation rather than the unrounded product.
  const expectedMean = Math.round(rawMean * 1.25 * 1000) / 1000;
  assert(Math.abs(cal.catchmentMean.mm - expectedMean) < 1e-9, 'calibrated mean scaled by factor (3dp)');
  assert(cal.raw_catchmentMean.mm === rawMean, 'raw_catchmentMean preserved on copy');
  assert(isAreal(cal.catchmentMean), 'calibrated mean still branded areal');
  // meta tagged + versioned + labelled
  assert(cal.calibration.applied === true, 'calibration.applied true for factor != 1');
  assert(cal.calibration.method === 'multiplicative_bias_idw_p2', 'method tagged');
  assert(typeof cal.calibration.version === 'string' && cal.calibration.version, 'version tagged');
  assert(cal.calibration.rawPreserved === true, 'rawPreserved flag');
  assert(cal.warnings.includes('synthetic-gauges'), 'synthetic-gauges warning carried (P-4)');
  // gaps unchanged
  assert(cal.coverage.framesMissing === raw.coverage.framesMissing, 'coverage unchanged');
});

await run('deriveCalibratedResult with no pairing inputs degrades to labelled identity', async () => {
  const raw = realResult();
  const cal = await deriveCalibratedResult(raw, { synthetic: true }); // no factor/inputs
  assert(cal.calibration.applied === false, 'identity when no factor resolvable');
  assert(Math.abs(cal.catchmentMean.mm - raw.catchmentMean.mm) < 1e-6, 'identity leaves value unchanged');
  assert(cal.warnings.includes('synthetic-gauges'), 'still labelled synthetic');
});

// ── helpers ──────────────────────────────────────────────────────────────────
function seed() {
  const s = initialState();
  return s;
}
function tagged(result, tag) { return { ...result, __tag: tag }; }

console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
