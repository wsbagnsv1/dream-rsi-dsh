# Dream-RSI v0.2 — verification plan (V2-3 / task-15)

Owner: `qa-tester`. Subject under test: this repository on branch
`feat/v0.2-paper-faithful` — the v0.2 paper-faithful core (code policies via
subprocess, LLM policy-development loop, strictly on-manifold replay). Features
land via V2-1/V2-2 (task-14); this plan fixes the verification fences before
implementation, and the report (`docs/TEST-REPORT.md`) records results after.

Environment notes for this repo's suite:

- The suite runs **without junctions**: `dsh-schema.spec.ts` (real-validator
  fence) skips when the optional `node_modules/@deepseek-ai/*` junctions are
  absent, and `preset.spec.ts`'s standard-assembly comparison runs only when
  the `DREAM_RSI_HARNESS_ROOT` env var points at a DeepSeek Harness checkout.
  Neither gate may hard-code machine paths.
- Every existing test stays green or is **explicitly migrated** — the RCO
  tests move behind the opt-in estimate mode (V1), they are not deleted.

## V1 — On-manifold identity (F3)

> **Status (V2-3 close-out):** LANDED — F3 shipped in the adjudication batch
> (task-16: `estimate: 'off' | 'rco'`, default `off`, preset row + schema
> updated). The identity fences live in `tests/v02-fences.spec.ts`
> (default-off resolution, zero estimated nodes on live-store fixtures with a
> non-vacuous `'rco'` contrast pin, replay-level off-vs-rco
> exhausted-continuation identity), and the §5.3 RCO tests are grouped behind
> the opt-in `estimate: 'rco'` block in `replay.spec.ts`.

`estimate: 'off' | 'rco'` with **`off` as the new default**. Off = the paper's
replay: recorded reveals only, empty-reveal → episode exhaustion (quality 0),
illegal batches → −∞.

| # | Case | What it asserts |
|---|------|-----------------|
| V1.1 | default is off | the resolved config's `estimate` is `'off'` when unset (schema default + preset row) |
| V1.2 | zero estimated nodes | dream reports on live-store-derived fixtures (real store → closed rounds → worlds) contain **zero** estimated reveals: no `~est-N` ids, `estOutcomeFraction === 0`, no `replay-estimate` lineage anywhere |
| V1.3 | paper semantics on exhausted continuations | stepping an exhausted branch under `off` yields nothing (no synthetic reveal); the episode's stopReason is `empty-batch`/`exhausted`, never an estimate |
| V1.4 | byte-identity vs recorded semantics | identical inputs with `estimate: 'off'` produce identical reports across runs (determinism fence preserved) |
| V1.5 | RCO tests relocated | every §5.3 RCO test (novel-action blend, abstention prior, confidence bookkeeping, estOutcomeFraction) now runs under an opt-in `estimate: 'rco'` describe block and stays green there |

## V2 — Protocol conformance (F1)

The code-policy subprocess protocol: one `python -I` subprocess per policy per
dream run, JSON-lines decision protocol over stdin/stdout; policy returns
`{ batch, stop, notes }`.

| # | Case | What it asserts |
|---|------|-----------------|
| V2.1 | valid batch round-trip | a scripted policy returning a legal batch reveals the recorded children per the `Child()` rules; the episode advances |
| V2.2 | malformed policy output | unparseable / wrong-shaped protocol lines mark the episode **invalid** (−∞ for that candidate × world) without crashing the run |
| V2.3 | timeout | a policy that never answers hits the per-episode timeout: the episode terminates with an invalid verdict, the subprocess is reaped, and the dream run completes |
| V2.4 | illegal batches | parent+child together, over-W, and non-selectable node ids each score −∞ and surface in the report's invalid reasons |
| V2.5 | bootstrap policy | the built-in bootstrap code policy mounts on a fresh store and passes its **first `solve()` call** (protocol handshake end-to-end) |
| V2.6 | legacy interpreter | `policyEngine: 'legacy'` keeps DSL policies replaying unchanged (existing dreaming.spec fixtures pass under the legacy engine) |

## V3 — Selection invariants on code policies

Unchanged invariants, now over generated `vNNNN.py` policies.

| # | Case | What it asserts |
|---|------|-----------------|
| V3.1 | no-regression | the incumbent always runs as candidate 0 and argmax selection never regresses on the replay history |
| V3.2 | earliest-tie | equal mean scores select the earliest candidate index |
| V3.3 | degenerate detection | never-batched / single-branch / stops-immediately code policies are disqualified from selection (replay-behavior derived, not source-derived) |
| V3.4 | lineage | generated policies version as `vNNNN.py` with correct lineage (parentId = incumbent, monotonic versions, immutable payloads) |

## V4 — Scale gate (F4)

| # | Case | What it asserts |
|---|------|-----------------|
| V4.1 | perf budget | `poolSize: 32` × ~10 worlds replay completes within the documented budget (target: a few minutes on a laptop; the fence asserts the budget and records the **measured** wall-clock number in `docs/TESTING.md`) |
| V4.2 | determinism at scale | the measured run is deterministic: identical fixture inputs ⇒ identical report (the perf harness doubles as the determinism check at scale) |

## V5 — Preset inject/config (delivery form)

| # | Case | What it asserts |
|---|------|-----------------|
| V5.1 | inject list | the preset row's `inject` grows `'subprocess'` (host-plane service, no realm needed) while keeping the prior entries |
| V5.2 | config defaults | the preset row's config block carries the new keys with their defaults: `autoDream: 'every-cycle'`, `poolSize` (32), `devLoop`, `estimate: 'off'`, `policyEngine: 'code'` |
| V5.3 | persona v2 | the persona suffix carries the v2 workflow text (code policies, Listing 2 loop, trajectory digests) |
| V5.4 | structure intact | the task-7 fences stay green: no plugin host insert, roots-only overlay, composition validates |

## V6 — Docs currency

| # | Case | What it asserts |
|---|------|-----------------|
| V6.1 | README | the code-policy section + config table document F1/F2/F3 knobs as implemented |
| V6.2 | TESTING.md | `docs/TESTING.md` lists the new fence groups and the measured scale-gate number |

## Gates

`pnpm typecheck` 0 · `pnpm test` green (full suite) · `pnpm build` 0 · stability
re-run. Results land in `docs/TEST-REPORT.md` (sanitized — no machine paths; the
junction/harness-root gates are described as env switches, not locations).
