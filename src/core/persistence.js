// persistence.js — the only thing that outlives a session: saved/recent
// locations (docs/02 §4, docs/03 §3). Everything else is reconstructable from
// the URL + committed data, so nothing else is persisted.
//
// localStorage is accessed defensively: if it is unavailable (private mode,
// disabled, non-browser), every function degrades to a no-op / empty result
// rather than throwing. Persistence failure must never break the workspace.

const KEY_RECENT = 'stormgrid:recentLocations';
const KEY_SAVED = 'stormgrid:savedLocations';
const CAP = 10;

function store() {
  try {
    const ls = globalThis.localStorage;
    // probe — some environments expose the object but throw on access
    const probe = '__sg_probe__';
    ls.setItem(probe, '1'); ls.removeItem(probe);
    return ls;
  } catch {
    return null;
  }
}

function readArray(key) {
  const ls = store();
  if (!ls) return [];
  try {
    const raw = ls.getItem(key);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeArray(key, arr) {
  const ls = store();
  if (!ls) return false;
  try { ls.setItem(key, JSON.stringify(arr.slice(0, CAP))); return true; }
  catch { return false; }
}

/** @returns {Array} recent locations, newest first (possibly empty) */
export function loadRecentLocations() { return readArray(KEY_RECENT); }

/** @param {Array} locations newest-first */
export function saveRecentLocations(locations) { return writeArray(KEY_RECENT, locations); }

/** @returns {Array} explicitly saved locations */
export function loadSavedLocations() { return readArray(KEY_SAVED); }

/** @param {Array} locations */
export function saveSavedLocations(locations) { return writeArray(KEY_SAVED, locations); }

/** True if persistence is actually available in this environment. */
export function persistenceAvailable() { return store() !== null; }
