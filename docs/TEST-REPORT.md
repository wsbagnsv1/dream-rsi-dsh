# Dream-RSI v0.2 — verification report (V2-3 / task-15, closed after V2-4)

Owner: `qa-tester`. Subject: this repository on branch `feat/v0.2-paper-faithful`
(v0.2 paper-faithful core: F1 code policies via `ctx.subprocess`, F2 Listing 2
policy-development loop, F3 strictly on-manifold replay, F4 every-cycle dreaming
+ trajectory digests). Plan: `docs/test-plan.md` (fence groups V1–V6). The
legacy `dream-rsi-plugin` directory is frozen; this repo is canonical.

## Verdict (final, after the V2-4 adjudication batch)

| Gate | Command | Result |
| --- | --- | --- |
| Typecheck | `pnpm typecheck` | **PASS** (exit 0) |
| Tests | `pnpm test` | **PASS — 150 passed + 9 skipped (159 total, 11 files)** |
| Build | `pnpm build` | **PASS** (exit 0) |
| Stability | full-suite re-run | **PASS** (same totals, back-to-back) |
| Standalone bench | `node bench/perf-gate.mjs --rounds 10 --pool 32` | **PASS — replay wall-time 7,754 ms (≈ 24 ms/episode) vs the 300 s budget** |

Environment: Windows, node 24, Python 3.12 (code-policy fences drive the real
`python -I` protocol). Suite runs **without junctions**: the real-validator
regression fence (`dsh-schema.spec.ts`, 9 tests) skips, and the standard-assembly
comparison in `preset.spec.ts` runs only when `DREAM_RSI_HARNESS_ROOT` names a
DeepSeek Harness checkout. Both gates are env switches — no machine paths in the
repo.

## Fence results (all six groups closed)

### V1 — on-manifold identity (F3) — PASS (closed by the V2-4 adjudication batch)

- **Default is `'off'`**: the resolved config's `estimate` defaults to `off`
  (schema default asserted) and the preset row carries `estimate: 'off'`.
- **Zero estimated nodes by default**: dream reports on live-store-derived
  fixtures (real temp store → seeded closed rounds → worlds) contain zero
  estimated reveals — `estOutcomeFraction === 0` per world, no
  `estimatedOnly` trajectory steps, no `~est-` synthetic ids in any batch.
  Code candidates are on-manifold in **every** mode (no gridPlan → no
  estimator context).
- **Non-vacuous contrast pin**: the identical store under the opt-in
  `estimate: 'rco'` DOES estimate where the default did not (the fixture's
  branch shape — a depth-2 frontier — makes the legacy interpreter re-open the
  root, which is exactly the novel action the gate covers).
- **Replay-level identity**: exhausted root continuations reveal nothing under
  `off`; the identical world and batch under `'rco'` produce a synthetic
  `~est-` reveal (paper `Child()` rule vs §5.3 extension, side by side).
- **RCO relocation**: the §5.3 tests are grouped behind the explicitly
  opt-in `estimate: "rco"` block in `replay.spec.ts` (the shared `estFor`
  fixture pins the mode) and stay green there.

### V2 — protocol conformance (F1) — PASS (F-a now ENFORCED)

The engineer's `code-policy.spec.ts` pins: the bootstrap policy's first
`solve()` handshake on a fresh store (with `v0001.py` + `.runner.py`
persisted), `solve()` exceptions → episode invalid (−∞), per-episode timeout →
terminate + invalid, missing subprocess seam → invalid candidate / healthy run,
and `autoDream` every-cycle/off. `tests/v02-fences.spec.ts` adds:

- **Wrong-shaped return** (`{"batch": "not-a-list"}`) → episode invalid, −∞,
  incumbent selected.
- **Garbage on policy stdout** (non-protocol lines) → episode invalid without
  crashing the run.
- **Over-W batch** (6 leaves selectable, W = 4, policy floods all leaves) →
  −∞ with the `exceeds W=4` reason — caught at the batch gate before any
  reveal (the fence needed a non-exhausted world: six root children plus one
  grandchild tail).
- **Parent+child batch** → −∞.
- **Non-selectable/unknown batch ids → −∞ (F-a ENFORCED, lead-adjudicated):**
  a code policy returning `r0001-n999` produces an illegal batch —
  `stopReason: 'invalid'`, `meanScore: −∞`, and the offending ids surfaced in
  the invalid reason ("outside the replay action space"). The earlier as-built
  leniency (silent skip) is gone.

### V3 — selection invariants on code policies — PASS

- **No-regression:** an invalid (throwing) challenger never displaces the
  incumbent; `guards.noRegression` stays true.
- **Earliest-tie:** identical code candidates tie and the argmax lands on the
  earliest index (asserted as the report invariant, not a hardcoded winner).
- **Degenerate detection from replay behavior:** an immediately-stopping code
  policy reports `stopsImmediately` (lenient run) and is disqualified with
  −∞ under `strictGuards` — behavior-derived, not source-derived.
- **Lineage:** `policy_set { code }` on a fresh store versions `v0002.py`
  (bootstrap = `v0001`), `parentId` = incumbent, `kind: 'code'` in the index,
  `.py` on disk, and reads hydrate the source.

### V4 — scale gate (F4) — PASS

- **In-suite fence (CI gate):** ~10 closed worlds × `poolSize: 32` code
  candidates (one `python -I` subprocess per candidate, every world inside
  it), completed in **≈ 3.2–3.5 s** on the development machine — far inside
  the documented budget (< 300 s; ROADMAP F4 "a few minutes on a laptop") —
  plus an at-scale determinism re-replay (identical pool ⇒ identical
  candidate × mean-score ranking).
- **Standalone bench (F-c shipped):** `node bench/perf-gate.mjs --rounds 10
  --pool 32` → store-build 431 ms, **replay wall-time 7,754 ms (≈ 24 ms per
  episode), PASS** against the 300 s budget. Both vehicles and the measured
  numbers are recorded in `docs/TESTING.md` (Perf gate section).

### V5 — preset inject/config — PASS

`preset.spec.ts` fences: the dream-rsi row injects `[tools, 'subprocess']`;
the inline config carries the paper-faithful defaults (`policyEngine: 'code'`,
`autoDream: 'every-cycle'`, `trajectoryCap: 20`, `policyEpisodeTimeoutMs:
30000`, `devLoop: 'agent-relay'`, `poolSize: 32`, **`estimate: 'off'`**); the
persona suffix carries the v2 workflow text (code policies via `solve(view)`,
`policySource` hand-off, **mandatory** dreaming, trajectory digests, `{ code }`
submission shape); the plugin entry is preset-relative (`../../dist/index.js`)
with no absolute machine paths anywhere in the preset.

### V6 — docs currency — PASS

`README.md` documents the code-policy surface and every new config key
(fence-asserted); `docs/TESTING.md` lists all eleven spec files including the
new fence groups, both perf-gate vehicles with their measured numbers, and the
junction/env gates.

## Adjudicated findings — all resolved

- **F-a (non-selectable batch ids) — RESOLVED: ENFORCED.** The batch gate now
  rejects ids outside the replay action space with −∞ and lists the offending
  ids; the fence asserts the enforced semantics (invalid reason contains
  "outside the replay action space" + the id, `meanScore === −∞`).
- **F-b (estimate flip) — RESOLVED: LANDED.** `estimate: 'off' | 'rco'`
  (default `off`) gates the RCO estimator in `replay.ts step()`; code
  candidates replay strictly on-manifold in every mode. V1 identity fences
  landed (see above); the §5.3 RCO tests are opt-in.
- **F-c (bench script) — RESOLVED: SHIPPED.** `bench/perf-gate.mjs` + the
  measurement body match the in-suite fence shape and print measured ms with
  PASS/CHECK vs the 300 s budget (measured 7,754 ms — PASS). Follow-up note:
  add `.dreamrsi-bench/` to `.gitignore` (the bench keeps its store for
  inspection; one line, outside my write scope).

## Coverage gaps / not tested (honest list)

- No live `dsh-agent-presets` mount (structure + health-check shapes only —
  the harness package's own contract), no junctions in this environment (the
  real-validator fence skips; re-enable with the documented junction setup),
  no Linux run.
- F2's `host-llm` mode is tested against a stub `llm` surface; no live-model
  cycle was replayed in this verification pass (the running circle-packing
  campaign was explicitly left untouched).
- The scale gate uses synthetic worlds; the standalone bench measures the same
  shape — a perf re-measurement on deep-chain worlds from a real campaign
  would strengthen the budget claim.
- The estimate `'rco'` contrast pins rely on the legacy DSL interpreter (the
  estimator's only client); if a future change routes code policies through
  the estimator, the V1 fences must grow a code-path contrast.
