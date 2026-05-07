# DEAD_FILE_AUDIT — Stormgrid

**Branch:** `audit/dead-file-audit-stormgrid` (off `main`).
**Method:** Same reference tracer as Stormgauge. Strict basename + relative-path literal matching across all tracked text files.
**Date:** 2026-05-07.

**Audit only — no files deleted, moved, or edited.**

---

## Headline

| Property | Value |
|---|---|
| Total tracked files | 67 |
| Strict-unreferenced | 5 |
| Genuinely dead | **0** |
| Operator decision required | **0** |
| ACTIVE / config / entry-point | 67 |

**Stormgrid is clean.** Every tracked file is reachable by the runtime, used by a documented operator workflow, or is an entry point that other tools consume directly (not via cross-file reference).

The 5 "unreferenced" files are all expected:

| File | Why it's "unreferenced" but not dead |
|---|---|
| `.gitignore` | Consumed by Git directly. |
| `README.md` | GitHub repo overview. Not loaded at runtime; consumed by GitHub's repo UI and human readers. |
| `package.json` | Consumed by `npm` (test scripts: `test:arf`, `test:arf:update`; build scripts: `build:rainfall`, `build:ifd`). |
| `docs/asset_data_schema.md` | Operator documentation for the asset register schema. Cross-references in `NEEDS_CONFIRMATION_CANDIDATES.md` discussion. |
| `src/stormgridReadme.md` | Internal subtree README (the markdown file in `src/`). Documentation for module authors. |

## Sibling reports (this branch)

- `reports/SAFE_DELETE_CANDIDATES.md` — empty (zero candidates).
- `reports/NEEDS_CONFIRMATION_CANDIDATES.md` — empty (zero candidates).
- `reports/ACTIVE_RUNTIME_DEPENDENCIES.md` — confirms the 67-file active surface.
- `reports/HISTORICAL_REFERENCE_FILES.md` — empty (no historical files to flag).

## Cross-repo

Comprehensive cleanup work for Phase 2A is in `pluvio-stormgauge:audit/dead-file-audit-stormgauge`. Stormgrid requires no Phase 2A action.
