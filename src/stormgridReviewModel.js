/* Stormgrid v0 — review model.
   Pure transform: state + defaults → array of card view-models for the UI.
   Does not mutate state. Does not invent values. */

import { CARD_KEYS, STATUS } from './stormgridState.js';

export function buildReviewModel(state, defaults) {
  return CARD_KEYS.map((key) => {
    const card = state.cards[key];
    const fallback = defaults[key];
    const isManual = card.status === STATUS.MANUAL;
    return {
      key,
      label: card.label,
      value: isManual ? card.value : fallback.value,
      reason: isManual
        ? 'Manually changed by user.'
        : fallback.reason,
      confidence: isManual ? 'manual' : fallback.confidence,
      status: card.status,
      canEdit: true,
    };
  });
}
