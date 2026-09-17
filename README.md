# Dream-RSI for DSH

A [DeepSeek Harness (DSH)](https://github.com/deepseek-ai) plugin that implements the **Dream-RSI** recursive self-improvement loop — from the paper *"Dream-RSI: Recursive Self-Improvement through Evolving Worlds"* (Tong Zheng et al., UMD College Park & Google DeepMind — [github.com/zhengkid/Dream-RSI](https://github.com/zhengkid/Dream-RSI), [dream-rsi.com](https://dream-rsi.com)) — as a preset-gated, model-facing tool surface.

Give a DSH session a discovery task (algorithm engineering, optimization, kernels…), and the plugin turns its accumulated **discovery history into a replay simulator**: candidate *exploration policies* are replayed against recorded discovery trees for cheap off-policy feedback, the best policy is redeployed, and the loop compounds.

```
        ┌──────────────────────────────────────────────────────────┐
        │                  (outer iteration t)                     │
        │                                                          │
        │   ① ONLINE EXPLORE        current policy guides the      │
        │      discovery agent → discovery tree gets logged        │
        │                           │                              │
        │   ② BUILD SIMULATOR       finished tree joins the pool   │
        │                           │ of replay worlds             │
        │   ③ DREAM                 M candidate policies replayed  │
        │      against every world (read-only, ~zero cost);       │
        │      best challenger wins only if it beats the          │
        │      incumbent (no-regression guarantee)                │
        │                           │                              │
        │   ④ REDEPLOY ─────────────┘  t ← t+1, goto ①            │
        └──────────────────────────────────────────────────────────┘
```

**Key properties of this implementation:**

- **No LLM inside the plugin.** The plugin is a deterministic orchestration layer (store + simulator + scorer + policy registry); the calling agent is the policy *developer*. Exploration policies are small JSON DSLs (`PolicyDsl`) the model writes and the plugin interprets.
- **LLM-free off-policy estimation (RCO).** Novel actions (never recorded in history) get outcomes estimated by a deterministic similarity heuristic — context similarity → weighted recorded-outcome blend → novelty penalty → pessimistic abstention prior — with low-confidence estimates barred from the quality term.
- **Preset-gated.** The seven `dreamrsi_*` tools exist **only** for sessions started on the `Dream-RSI` agent preset. The baseline composition stays clean.
- **Per-workspace state.** Each workspace gets its own `.dreamrsi/` store; absolute `dataDir` pins one shared store instead.
- **Everything is versioned and auditable** — discovery trees, immutable policy versions, dream reports, and a global event log under `.dreamrsi/`.

## What you get

| Tool | Loop stage | What it does |
|---|---|---|
| `dreamrsi_begin_round` | ① online | Opens a round; returns the active policy (JSON DSL to follow), limits, history digest, and the resolved store location |
| `dreamrsi_log_decision` | ① online | Logs one decision round: a batch of attempts + measured outcomes |
| `dreamrsi_end_round` | ② simulator | Closes the round; its tree becomes a replay world |
| `dreamrsi_history` | — | Query trees: best paths, failures, subtrees, rounds, summaries |
| `dreamrsi_dream` | ③ dreaming | Replay-scores K candidate policies against every world; ranked report with per-world diagnostics |
| `dreamrsi_policy_get` | — | Inspect the active policy or any version's full record |
| `dreamrsi_policy_set` | ④ redeploy | Activate a version or register + activate a new DSL (no-regression guard unless `force`) |

Sessions on the preset also get a persona suffix teaching the workflow, so the model knows the loop without extra prompting.

## Requirements

- A DSH installation (run-from-source checkout or installed CLI) with the Web profile
- Node.js ≥ 22, pnpm ≥ 10 (pnpm 11 tested)
- Python not required (the plugin is pure TypeScript; no network at runtime)

## Install

### Option A — installer (recommended)

```sh
git clone <this repo> dream-rsi-dsh
cd dream-rsi-dsh
pnpm install
pnpm build
# Windows:
powershell -File install.ps1
# Linux/macOS:
./install.sh
```

The installer copies `preset/dream-rsi/` into `<dshHome>/.agent-presets/` and rewrites the plugin entry to an absolute path. Then: start DSH Web, open the **new-session preset picker**, choose **Dream-RSI**.

- `install.ps1 -PrintOverlay` / `./install.sh --print-overlay` prints a *roots-discovery* overlay instead (see Option B).

### Option B — roots overlay (no copy)

Point the agent-preset roster at this repo's `preset/` directory:

```sh
pnpm dsh web --patch ./examples/cordis.presets-overlay.yml   # edit the repo path inside first
```

Nothing is mounted into the baseline; the preset row resolves `../dist/index.js` relative to this repo, so keep `dist/` built. A preset **discovery root** is a trust decision (`trust: system`) — only point roots at directories you trust.

### Option C — legacy host mount (power users)

Mount the plugin directly into the host composition via `cordis.host-mount.yml.example`. This puts the seven tools into **every** session — not the recommended mode, kept for completeness.

> **Upgrading:** preset copies are snapshots. Re-run the installer (or re-copy `preset/dream-rsi/`) after pulling code changes; a server restart picks up plugin code changes (preset config edits reach new sessions without one).

## Usage

Start a session on the **Dream-RSI** preset and hand the agent a discovery task:

```text
Use the Dream-RSI loop on this task: <your task>.
Run one online round with the active policy (dreamrsi_begin_round, batched
attempts via dreamrsi_log_decision, dreamrsi_end_round), then dream up 3
improved policies (dreamrsi_dream) and commit the winner with
dreamrsi_policy_set if it beats the incumbent on replay.
```

Any session (even without the preset) can also **delegate directly onto the preset** — this repo's companion harness change makes `agent_preset` an optional parameter on DSH's `subagent` tool:

```json
{ "description": "discovery run", "prompt": "...", "agent_preset": "dream-rsi", "run_in_background": true }
```

Background delegation is recommended for long campaigns.

## Configuration

Set inline in the preset row (`preset/dream-rsi/agent.cordis.yml`) — every key optional:

| Key | Default | Meaning |
|---|---|---|
| `dataDir` | `.dreamrsi` | Store directory. Relative paths resolve **per call** against the calling agent's session workspace; absolute pins one shared store |
| `candidateCount` | `3` | K — how many challenger policies the agent should propose per dream |
| `maxOnlineRounds` | `16` | K₁ — decision-round cap per online round |
| `maxReplayRounds` | `64` | K₂ — per-episode decision-round cap during replay |
| `beta1` / `beta2` | `0.01` / `0.05` | Replay-objective (Eq. 1) cost / parallelism coefficients |
| `normalizeScores` | `true` | Min–max score normalization across each world |
| `maxBatchSize` | `4` | Hard batch cap (policies may set lower `W`) |
| `similarityThreshold`, `similarityTemperature`, `similarityGamma` | `0.35` / `0.25` / `2` | RCO estimator similarity shaping |
| `estimatorMaxAnalogues` / `estimatorMinAnalogues` | `5` / `3` | Top-k recorded analogues blended for novel-action estimates |
| `similarityFloor`, `hallucinationTau`, `noveltyLambda`, `confidenceMediumTau` | `0.1` / `0.18` / `0.25` / `0.45` | Novelty penalty, abstention prior, confidence thresholds |

## Data model

```
.dreamrsi/
  config.json                 # effective plugin config
  trees/<roundId>/nodes.jsonl # discovery tree: one immutable record per attempt
  trees/<roundId>/round.json  # round metadata (policy version, status, stats)
  policies/policy-index.json  # version index + active pointer
  policies/vNNNN.json         # immutable PolicyDsl versions
  dreams/dNNNN.json           # dreaming runs: candidates, per-world scores, selection
  events.jsonl                # append-only audit log of every mutation
```

Node records are full `(state, action, outcome)` tuples with lineage. Trees are one root with many branches; each branch is a unary refinement chain — which is what makes the paper's replay transition cheap and deterministic.

## Architecture

```
src/
  index.ts     Cordis plugin: name/inject/apply, Schemastery config, wiring
  types.ts     Domain types (NodeRecord, RoundRecord, PolicyDsl, ...)
  store.ts     .dreamrsi/ persistence, tree invariants, policy registry
  replay.ts    ReplayWorld: Child() reveal rules, RCO off-policy estimator
  dreaming.ts  PolicyDsl validation + interpreter, Eq. 1 dream loop, selection
  engine.ts    Facade: begin/log/end/history/dream/policy operations
  tools.ts     The seven model-facing tool definitions
  dsh-ambient.d.ts  Type-only mirrors of the DSH runtime surfaces (standalone typecheck)
preset/dream-rsi/   The agent preset (full standard assembly + the plugin row + workflow persona)
tests/              Vitest suite (engine, tools, preset shape, per-workspace isolation,
                    real-validator regression fence)
docs/DREAM-RSI-SPEC.md   Implementation-grade spec distilled from the paper
```

The package typechecks **standalone** (ambient type mirrors stand in for `@deepseek-ai/cordis`, `@deepseek-ai/dsh-tools`, `@deepseek-ai/schemastery`); inside DSH the real modules supply the runtime.

## Development

```sh
pnpm install
pnpm typecheck   # strict tsc --noEmit
pnpm test        # vitest
pnpm build       # dist/ (ESM, relative import extensions rewritten)
```

`tests/dsh-schema.spec.ts` validates all seven tools through the **real** DSH schema validator — the class of bug it fences (undeclared output properties) is invisible to standalone typecheck. It requires linking the harness packages and is skipped automatically when they are absent; see the test file header.

Deviations from the paper are deliberate and documented: policies are a JSON DSL rather than arbitrary Python; novel-action outcomes come from the deterministic RCO estimator rather than an LLM judge. Both keep the loop fully deterministic and testable. See [docs/DREAM-RSI-SPEC.md](docs/DREAM-RSI-SPEC.md) (§10 simplifications) and [docs/TESTING.md](docs/TESTING.md).

## Credits & license

- **Dream-RSI** — Tong Zheng, Xidong Wu, Zheng Zhang, Zhankui He, Chaoyi Zhang, Benjamin Coleman, Ruoqiao Wei, Di Bai, Haolin Liu, Rui Liu, Xue Wang, Yue Zhuan, Wang-Cheng Kang, Renkai Xiang, Heng Huang, Xinwu Cheng, Yunsong Guo (University of Maryland, Google DeepMind, University of Virginia).
- This repository is an independent, community implementation of the paper's method as a DSH plugin; it is not affiliated with the paper's authors.
- MIT — see [LICENSE](LICENSE).
