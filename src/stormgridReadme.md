# Stormgrid v0 — Shell

Isolated smart-default workflow scaffold. **No real analysis. No fake rainfall data. Run is disabled.**

## Scope of v0

- Editable assumption cards (Area, Rainfall event, Rainfall source, Gauges, Durations, IFD/AEP, Outputs).
- Each card carries: value, reason, confidence, status (`default` | `manually-changed`), and an Edit affordance.
- Run button is disabled until a real data integration is wired (`state.integrationReady === true`).
- Pure DOM render; no network calls; no imports from Stormgauge logic.

## Files

| File | Purpose |
|---|---|
| `stormgridState.js`        | State container, card keys, status/confidence enums |
| `stormgridDefaults.js`     | Smart-default factory — deterministic, map-context-aware |
| `stormgridReviewModel.js`  | Pure transform: state + defaults → card view-models |
| `stormgridValidation.js`   | Run-readiness gate — always returns `ready: false` in v0 |
| `stormgridMapBridge.js`    | Read-only Leaflet map accessor — null-safe, no imports |
| `stormgridUi.js`           | DOM mount with `mountStormgridShell(hostEl, options?)` |
| `stormgridReadme.md`       | This file |

## Mount

```js
import { mountStormgridShell } from './src/modules/stormgrid/stormgridUi.js';
const handle = mountStormgridShell(document.getElementById('stormgrid-host'));
// handle.state, handle.rerender(), handle.destroy()
```

The shell lives at `/stormgrid/index.html` (staging route). It is not wired into the
production root `index.html`.

## Map context (optional)

Stormgrid will adapt the Area card and the Rainfall event reasoning when a
Leaflet map instance is registered. There are two ways to register one,
both read-only:

```js
// 1. Pass at mount time
mountStormgridShell(host, { map: leafletMapInstance });

// 2. Or register on the global handshake namespace before mounting
window.__stormgrid = window.__stormgrid || {};
window.__stormgrid.map = leafletMapInstance;
```

The bridge probes `getBounds()` / `getCenter()` defensively. Anything
that throws is treated as "no map available" and the static defaults
are used. Stormgrid never mutates the registered map.

## Hands-off list (do NOT touch from this module)

- `src/modules/exports/*` — Stormgauge export logic
- `src/modules/map/*` — Stormgauge map init/layers
- `src/modules/radar/*` — BOM/RainViewer radar
- `src/modules/stations/*` — gauge loader/markers
- `src/modules/ui/*` — Stormgauge controls/theme
- `index.html` AEP/IFD/station/radar/export wiring
- All logo assets — reuse only, never recreate

## Branch

- Feature branch: `feature/stormgrid-v0-shell`
- Branched from: `hotfix/nbc-relining-map-linework` (production)
- Staging only — not deployed to nbc.pluviometrics.com.au or root site until reviewed.
