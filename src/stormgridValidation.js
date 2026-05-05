/* Stormgrid v0 — validation.
   Run is enabled only when all of the following are true:
     1. Static rainfall JSON loaded
     2. A catchment is selected
     3. data.catchments[selectedId] exists with a numeric total_mm */

export function validateRunReadiness(state) {
  if (!state) {
    return { ready: false, reasons: ['Stormgrid state not initialised.'] };
  }
  const reasons = [];
  if (!state.rainfallData) {
    reasons.push(state.rainfallError
      ? `Rainfall data not available (${state.rainfallError}). Run local generator.`
      : 'Rainfall data not available. Run local generator.');
  }
  if (!state.selectedCatchmentId) {
    reasons.push('No catchment selected — click a catchment on the map.');
  }
  if (state.rainfallData && state.selectedCatchmentId) {
    const row = state.rainfallData.catchments && state.rainfallData.catchments[state.selectedCatchmentId];
    if (!row || typeof row.total_mm !== 'number') {
      reasons.push(`No precomputed data for catchment ${state.selectedCatchmentId}.`);
    }
  }
  if (reasons.length === 0) {
    return { ready: true, reasons: [] };
  }
  return { ready: false, reasons };
}

export function isRunEnabled(state) {
  return validateRunReadiness(state).ready === true;
}
