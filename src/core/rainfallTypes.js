// rainfallTypes.js — branded rainfall value objects.
//
// The areal-vs-point boundary is a RED LINE (docs/03 §4, docs/04 §3.5):
// radar-derived catchment-mean rainfall is ALREADY AREAL and must never have
// ARF applied to it; ARF only ever reduces a POINT design depth to an areal one.
//
// We enforce this structurally, not by convention. An areal value is an
// `ArealRainfall`; a point IFD design depth is a `PointDesignDepth`. `applyArf`
// is the ONLY function that produces an areal value from a point value, it
// accepts ONLY a `PointDesignDepth`, and there is no inverse. An areal mean can
// therefore never re-enter the ARF path — passing the wrong kind throws.
//
// Vanilla ES module, no build step (see DECISIONS.md B-006). JSDoc gives editor
// types; the `__brand` field gives runtime enforcement.

/**
 * @typedef {Object} ArealRainfall
 * @property {'areal'} __brand
 * @property {number} mm  Already-areal depth in millimetres.
 */

/**
 * @typedef {Object} PointDesignDepth
 * @property {'point'} __brand
 * @property {number} mm           Point design depth in millimetres.
 * @property {number} aep          Annual exceedance probability (fraction, e.g. 0.01).
 * @property {string} durationKey  e.g. '24h'.
 */

/**
 * @typedef {Object} ArfFactor
 * @property {'arf'} __brand
 * @property {number} value        Areal reduction factor in (0, 1].
 * @property {boolean} extrapolated True if computed outside the coefficients' valid envelope.
 */

const AREAL = 'areal';
const POINT = 'point';
const ARF = 'arf';

/**
 * Construct an already-areal rainfall value (catchment mean, radar-derived cell value).
 * @param {number} mm
 * @returns {ArealRainfall}
 */
export function arealRainfall(mm) {
  assertFiniteNonNegative(mm, 'arealRainfall.mm');
  return Object.freeze({ __brand: AREAL, mm });
}

/**
 * Construct a point IFD design depth.
 * @param {number} mm
 * @param {number} aep
 * @param {string} durationKey
 * @returns {PointDesignDepth}
 */
export function pointDesignDepth(mm, aep, durationKey) {
  assertFiniteNonNegative(mm, 'pointDesignDepth.mm');
  if (!(typeof aep === 'number' && aep > 0 && aep <= 1)) {
    throw new TypeError(`pointDesignDepth.aep must be in (0,1], got ${aep}`);
  }
  if (typeof durationKey !== 'string' || !durationKey) {
    throw new TypeError('pointDesignDepth.durationKey must be a non-empty string');
  }
  return Object.freeze({ __brand: POINT, mm, aep, durationKey });
}

/**
 * Construct an ARF factor.
 * @param {number} value in (0,1]
 * @param {boolean} [extrapolated=false]
 * @returns {ArfFactor}
 */
export function arfFactor(value, extrapolated = false) {
  if (!(typeof value === 'number' && value > 0 && value <= 1)) {
    throw new TypeError(`arfFactor.value must be in (0,1], got ${value}`);
  }
  return Object.freeze({ __brand: ARF, value, extrapolated: Boolean(extrapolated) });
}

/** @param {*} v @returns {v is ArealRainfall} */
export function isAreal(v) {
  return Boolean(v) && v.__brand === AREAL && typeof v.mm === 'number';
}

/** @param {*} v @returns {v is PointDesignDepth} */
export function isPoint(v) {
  return Boolean(v) && v.__brand === POINT && typeof v.mm === 'number';
}

/** @param {*} v @returns {v is ArfFactor} */
export function isArf(v) {
  return Boolean(v) && v.__brand === ARF && typeof v.value === 'number';
}

/**
 * The ONLY point -> areal reduction. Accepts only a PointDesignDepth and an
 * ArfFactor; returns an ArealRainfall. Throws on anything else — in particular
 * it will throw if handed an ArealRainfall, which is exactly the double-ARF
 * mistake we are preventing.
 * @param {PointDesignDepth} point
 * @param {ArfFactor} arf
 * @returns {ArealRainfall}
 */
export function applyArf(point, arf) {
  if (!isPoint(point)) {
    throw new TypeError(
      'applyArf expects a PointDesignDepth as its first argument. ' +
      'Passing an areal value here is the forbidden double-ARF reduction ' +
      '(docs/01 §7, docs/04 §3.5).'
    );
  }
  if (!isArf(arf)) {
    throw new TypeError('applyArf expects an ArfFactor as its second argument.');
  }
  // point design depth (areal-equivalent after reduction) — now an areal value.
  return arealRainfall(point.mm * arf.value);
}

/**
 * Extract the plain mm number for display/serialisation. Accepts areal, point,
 * or null (a gap). A gap returns null — never coerced to 0 (gap-honesty red line).
 * @param {ArealRainfall|PointDesignDepth|null|undefined} v
 * @returns {number|null}
 */
export function mmOf(v) {
  if (v == null) return null;
  if (isAreal(v) || isPoint(v)) return v.mm;
  throw new TypeError('mmOf expects a branded rainfall value or null.');
}

function assertFiniteNonNegative(mm, label) {
  if (typeof mm !== 'number' || !Number.isFinite(mm) || mm < 0) {
    throw new TypeError(`${label} must be a finite number >= 0, got ${mm}`);
  }
}
