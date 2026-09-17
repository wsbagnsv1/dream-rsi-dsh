# Changelog

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
