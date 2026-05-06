/* Stormgrid — point IFD loader.
   Loads data/catchment_ifd_centroid.json and exposes per-catchment
   helpers. The loaded asset describes POINT IFD only (ARF NOT
   applied) — this module never makes AEP/return-period claims;
   it just hands shaped data to the UI which displays it with
   prominent methodology warnings. */

const IFD_URL = './data/catchment_ifd_centroid.json';

let cached = null;
let inflight = null;

export async function loadCatchmentIfd(url = IFD_URL) {
  if (cached) return cached;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const r = await fetch(url, { cache: 'no-store' });
      if (!r.ok) {
        return { ok: false, status: r.status, error: `HTTP ${r.status}`, data: null, sizeBytes: 0 };
      }
      const text = await r.text();
      const data = JSON.parse(text);
      if (!data || !data.catchments || !data.methodology) {
        return { ok: false, status: r.status, error: 'unexpected IFD JSON shape', data: null, sizeBytes: text.length };
      }
      cached = { ok: true, status: 200, error: null, data, sizeBytes: text.length };
      return cached;
    } catch (err) {
      return { ok: false, status: 0, error: String((err && err.message) || err), data: null, sizeBytes: 0 };
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export function clearCatchmentIfdCache() {
  cached = null;
  inflight = null;
}

export function getCatchmentIfd(ifdData, catchmentId) {
  if (!ifdData || !ifdData.catchments || !catchmentId) return null;
  return ifdData.catchments[catchmentId] || null;
}

export function getMethodology(ifdData) {
  return (ifdData && ifdData.methodology) || null;
}

export function getIfdSource(ifdData) {
  return (ifdData && ifdData.source) || null;
}
