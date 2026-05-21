# Stormgrid Rebuild — Decision Log (Phases B–F autonomous run)

Append-only. Each entry: question · options · choice · reason · reversibility. Newest at the bottom of each phase. This log lets the run be reviewed without replaying the conversation.

Run started: 2026-05-21. Branch: `rebuild/phases-b-to-f` (off `docs/phase-a-architecture`).

---

## Phase B

### B-001 — Branch base
**Q:** Branch the rebuild off `main` (as the prompt's literal text says) or off `docs/phase-a-architecture`?
**Options:** (a) off `main` — rebuild lacks the Phase A docs in-tree; (b) off `docs/phase-a-architecture` — docs travel with the rebuild as one reviewable lineage.
**Chose:** (b), off `docs/phase-a-architecture`.
**Reason:** Phase A docs are the declared source of truth; keeping them in the same branch makes the rebuild reviewable as one history and a single eventual PR to main. The prompt's intent ("Phase A is committed and untouched") is preserved — that branch is pushed and unmodified.
**Reversibility:** Trivial — rebase onto main later if a clean separation is wanted.

### B-002 — Remote save state
**Q:** Push `docs/phase-a-architecture` to the remote, or keep it local-only?
**Chose:** Pushed both `docs/phase-a-architecture` and `rebuild/phases-b-to-f` to `origin`.
**Reason:** Prompt wants the remote branch as the save state and `docs/phase-a-architecture` as the rollback point; having both on the remote makes rollback robust from any clone. Neither is `main`; no history rewritten.
**Reversibility:** Branches can be deleted by Mark; the run will never delete remote refs (red line).

### B-003 — `area_ha` unit (Phase A open question)
**Q:** Is the catchment GeoJSON `area_ha` property genuinely hectares, as `stormgridUi.js:361` (`area_ha/100 → km²`) assumes?
**Verified:** Computed equirectangular polygon areas for 4 features vs the stated `area_ha`: ratio 0.998 across all (e.g. 783.3 ha prop ≈ 781.6 ha computed ≈ 7.816 km²). The GeoJSON also exposes `area_m2` directly.
**Chose:** Confirmed hectares. The `/100` conversion is correct. The rebuild's catchment contract will declare area in m² as canonical (using the existing `area_m2` property) to remove the `/100` indirection; `area_ha` retained as a convenience field.
**Reason:** `area_m2` is present and unambiguous; deriving km² from m² avoids a magic constant.
**Reversibility:** Pure read of an existing property; no data change.

### B-004 — ARF coefficients (Phase A open question)
**Q:** Are real ARR2019 ARF coefficients available in `D:\LIBRARY\00_SOURCE`?
**Verified:** `D:\LIBRARY\00_SOURCE` exists but is **empty**. No ARR2019 / ARF / IFD source material on disk.
**Chose:** Keep placeholder coefficients, but (a) rename them `PLACEHOLDER_*` in code, (b) gate any AEP / engineering-grade output behind a runtime check that refuses to emit while placeholders are active, (c) surface "ARF coefficients: placeholder — not engineering-defensible" in the methodology layer whenever the gate is active. Recorded as a Phase D prerequisite (see `05_PHASE_D_PREREQUISITES.md`).
**Reason:** The prompt's red line: never silently produce numbers from placeholder coefficients. Real values are not obtainable from disk.
**Reversibility:** When Mark supplies ARR2019 coefficients, replace the placeholder table and the gate flips off — no structural change.

### B-005 — Lizard frame units (Phase A open question)
**Q:** Are Lizard GeoTIFF frame values "mm per 3 h interval" as the accumulation assumes?
**Chose:** Assume mm/3h (matches existing code), and enforce with a runtime sanity-envelope assertion in `LizardArchiveAdapter` (per-frame plausibility range). Documented as a Phase D prerequisite requiring vendor confirmation.
**Reason:** Unconfirmable from disk; the assertion catches gross unit errors (e.g. m vs mm, cumulative vs per-interval) without falsely claiming confirmation.
**Reversibility:** Assertion is a guard; the assumption is one constant + one doc line to change on confirmation.

### B-006 — No TypeScript; runtime-branded value objects for the areal-vs-point boundary
**Q:** "Encode the areal-vs-point boundary in types, not flags." Vanilla JS has no static types — adopt TypeScript (build step) or runtime value objects?
**Options:** (a) TypeScript — contradicts doc 03's no-build vanilla recommendation and adds a CSP/CDN/pipeline change; (b) runtime-branded value objects (`ArealRainfall`, `PointDesignDepth`) where ARF conversion only accepts a point depth and only emits an areal value, plus JSDoc typedefs for editor support.
**Chose:** (b) runtime-branded value objects + JSDoc.
**Reason:** Keeps the approved no-build architecture; makes "pass an areal value where a point is expected" throw at runtime rather than be a silent flag mistake — which is the actual protection the red line wants.
**Reversibility:** JSDoc typedefs can be promoted to TS later if a build step is ever added.

### B-007 — Build the shared store before the B.2 fan-out (not as a parallel slice)
**Q:** The prompt's B.2 lists five parallel slices including the shared store. But the shell, Lizard adapter, and map host all depend on the store's API.
**Chose:** Build the store (`src/core/store.js`, `urlState.js`, `persistence.js`) serially first, then fan out the remaining four slices (shell, adapter, map host, containment) in parallel against the real store API.
**Reason:** AGENTS.md §3 — slices touching the same shared state run sequentially. Letting three subagents code against a guessed store API in parallel would guarantee a costly coherence merge. The store is the shared state; everything else gets disjoint file ownership (core/ vs shell/ vs adapters/ vs map/ vs scripts/).
**Reversibility:** N/A — sequencing only.

### B-008 — `index.html` wired during coherence merge, not by a parallel subagent
**Q:** Both the navigation shell and the map host need to be reachable from the page entry; `index.html` is a single shared file.
**Chose:** Parallel subagents write only new modules under their own directories; the orchestrator wires `index.html` to the new shell during the serial B.3 coherence merge. The existing `index.html` and `src/stormgrid*.js` stay untouched until then, so the current app keeps working.
**Reason:** §3 — never fan out writes to the same file. Keeps the tree buildable at every commit.
**Reversibility:** index.html change is one commit, revertible.
