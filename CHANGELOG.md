# Changelog

## 0.3.3 — progression rework: iteration scatter + Pareto frontier

- **Reworked by user directive**: the progression chart now plots EVERY logged
  discovery attempt across all rounds — x = global iteration index
  (chronological: round order, then file/lineage order within each round).
  Valid attempts draw as solid dots, failed/invalid/unevaluated ones as
  hollow dots (score 0 included — the climb story is honest), colored by
  round through a cycled deterministic palette. The headline line is the
  **Pareto frontier** (the monotone running maximum), step-drawn. Policy
  markers moved to the iteration index where a new version first logged.
  Hover per subpoint: round, node id, mechanism, score, valid/failClass.
- **Removed** the per-round series and the AlphaEvolve 2.635 reference line.
- Floored (−∞) scores plot clamped to the domain floor and are excluded from
  the y domain (one −1e12 dot must not flatten the chart); they never win the
  frontier.
- Data: the refresh now also reads every round's `nodes.jsonl` (paged, capped)
  and flattens it (`toIterationNodes`) — the same read the tree view uses,
  no new files.
- Tests: progression.spec rewritten (13 cases: cross-round iteration ordering,
  subpoint counts, Pareto monotonicity + floored semantics, markers at
  iteration indices, palette, thinning); the AlphaEvolve tests are gone.
  Package suite: 46.

## 0.3.2 — progression chart

- **Best-score-over-rounds chart** in the sidebar panel (after the champion
  card, above the discovery tree): the per-round best series, the monotone
  running-best climb curve (hv step line), a dashed AlphaEvolve 2.635
  reference line that participates in the y domain (the crossing is always
  visible), and vertical policy-change markers where the active version
  changed between consecutive rounds (versionless rounds neither create nor
  clear a marker). Hover tooltips per round (bestScore, policyVersion,
  nodes, running best); x labels thinned evenly; y auto-domain ±8% padding.
- Pure model in `progression.ts` (chronological points, null-skip, running
  best, markers, domain) — reuses the already-loaded `trees/*/round.json`
  rows, zero new file reads, zero dependencies. Single-round stores render
  one point; scoreless stores render no chart section.
- Tests: +9 (ordering + null-skip, running-best monotonicity, marker
  extraction incl. versionless gaps, domain ∪ reference, single-round edge,
  empty stores, x-label thinning). Package suite: 42.

## 0.3.1 — discovery-tree graph view

- **Graph view in the sidebar panel**: one selected round's discovery tree
  (`trees/<roundId>/nodes.jsonl`) as inline SVG — deterministic tidy-tree
  layout (depth → x, leaves → sequential rows; zero dependencies), nodes
  colored by an HSL score gradient with native-SVG hover tooltips (mechanism,
  score, valid/failClass, notes excerpt), a round selector (default latest),
  and a toggleable best-path highlight (root→leaf chain with the highest
  summed score; unscored trees show none).
- Nodes load on demand for the selected round (paged read, ≈10k-node cap,
  truncation surfaced); the dashboard refresh keeps the selected tree.
- Tests: nodes parser (live-store shapes), layout determinism + no-overlap
  invariants + cycle guard, best-path fixture semantics. Package suite: 33.

## 0.3.0 — web UI campaign dashboard

- **Dream-RSI sidebar panel** (`packages/client/ui-dream-rsi/`, new client
  plugin package): a right-Sidebar page type — the same class of surface as
  the workspace file tree — rendering the live state of the workspace's
  `.dreamrsi/` store READ-ONLY through the workspace-files pipe: champion
  card, policy lineage (`v0001 → vNNNN`), rounds table, dream reports with
  valid-world counts, events tail, on-demand refresh, and a graceful empty
  state when no store exists yet.
- Two-plane mounting: the preset's `ui-dream-rsi` row mounts the package's
  host half (self-describing preset); the browser half is served once the
  package is also mounted in the host composition (`install.ps1 -WithWebUI`
  links the package into the web profile and inserts the patch row).
- Standalone build: esbuild produces the browser bundle in the DSH
  client-module closure-factory format; the package typechecks and tests
  standalone (ambient mirrors + a faithful store stub; 20 package tests).
- Preset composition gained a second validated row + 4 new preset fences
  (row resolution, manifest, bundle format, two-stage registration); suite:
  166 root tests + 20 package tests green.

## 0.2.0 — paper-faithful core

- **Code policies** (`OptimalPolicy` as Python): policies are executable
  modules (`def solve(view) -> dict`) run through `ctx.subprocess` in an
  isolated `python -I` interpreter over a JSON-lines decision protocol —
  per-episode timeouts, abort/terminate, malformed-output → episode invalid.
  Built-in bootstrap code policy ports v0001 semantics; DSL policies keep
  replaying under `policyEngine: 'legacy'`.
- **LLM policy-development loop** (Appendix B Listing 2, verbatim prompt):
  after every cycle the framework calls the configured LLM with trajectory
  digests + score stats + the incumbent's source, parses a fenced candidate
  pool (`poolSize`, default 32), versions candidates with lineage, and replays
  them against all worlds. `devLoop: 'agent-relay'` (default) | `'host-llm'`
  via `ctx.llm`; failures degrade to the incumbent, never a crashed cycle.
- **Strictly on-manifold replay by default**: `estimate: 'off'` gates the RCO
  similarity estimator behind opt-in (`'rco'`); illegal batches (unknown/
  non-selectable ids) are now −∞ per the paper's action-space semantics.
- **Dreaming is a mandatory cycle stage**: `autoDream: 'every-cycle'` default
  (`'on-stagnation'` / `'off'` remain); trajectory digests per candidate ×
  world feed the Listing 2 payload and the dream reports.
- **Preset row v2**: injects `subprocess`, paper-faithful config defaults,
  persona workflow updated to the code-policy cycle.
- **Perf gate**: 32 candidates × 10 worlds ≈ 3.3–7.7 s measured (budget 300 s);
  `bench/perf-gate.mjs` shipped standalone; in-suite fence is the CI gate.
- Suite: 150 passed + 9 skipped (junction-gated real-validator fence).

## 0.1.0 — initial release

- Dream-RSI engine: discovery-tree store (`.dreamrsi/` layout, tree invariants,
  immutable policy versions, audit log), replay simulator (paper's `Child()`
  reveal rules, RCO LLM-free off-policy estimator), dreaming loop (Eq. 1 with
  per-term logging, no-regression selection, optional beta sweep), engine
  facade, and the seven `dreamrsi_*` model-facing tools.
- Per-workspace stores: relative `dataDir` resolves per call against the
  calling agent's session workspace; absolute pins one shared store.
- `Dream-RSI` agent preset: full standard assembly + the plugin row + a
  workflow persona; the baseline stays clean unless a session picks the preset.
- Tool schemas validated against the real DSH schema validator
  (`tests/dsh-schema.spec.ts` regression fence).
- Installer (`install.ps1` / `install.sh`) and a roots-discovery overlay
  example for portable installation.
