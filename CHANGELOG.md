# Changelog

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
