# Testing

The suite runs standalone — no DSH installation required:

```sh
pnpm install
pnpm typecheck   # strict tsc --noEmit
pnpm test        # vitest
pnpm build       # dist/ emit
```

## Suite layout

| File | Covers |
|---|---|
| `store.spec.ts` | Discovery-tree CRUD, tree invariants (single root, unary chains), policy registry immutability, no-regression guard, audit log, lossless persistence reload |
| `replay.spec.ts` | Replay-world construction, the paper's `Child()` reveal rules, RCO estimator (novel-action penalty, abstention prior, confidence bookkeeping), Eq. 1 helpers, purity/determinism |
| `dreaming.spec.ts` | PolicyDsl validation (14 violation classes), the deterministic interpreter, hand-computed Eq. 1 run, tie-breaking, degenerate-behavior guards, byte-identical dream reports, beta sweep |
| `tools.spec.ts` | All seven tools through a stub context; full online loop; incremental `batchSeq` logging; versioning; error paths |
| `plugin.spec.ts` | Loader-safe export shape (`inject: ['tools', 'subprocess']`); `apply()` mount with a stub context; effect cleanup |
| `preset.spec.ts` | The `Dream-RSI` agent preset: composition shape, standard-assembly coverage, persona workflow guidance, realm discipline, roots overlay, legacy host-mount example |
| `workspace.spec.ts` | Per-workspace `dataDir` resolution (two workspaces → two stores; same-root reuse; disclosed `process.cwd()` fallback) |
| `code-policy.spec.ts` | **v0.2 F1/F4**: the `python -I` JSON-lines decision protocol against the real interpreter (bootstrap episode, candidate replay, `solve()` failure → invalid, per-episode timeout → terminate + invalid, missing subprocess seam → invalid candidate never invalid run), fresh stores shipping `v0001.py` + `.runner.py`, `autoDream` every-cycle/off |
| `dev-loop.spec.ts` | **v0.2 F2**: Listing 2 candidate-block parsing (skip-and-log), host-llm replay through a stub `llm` surface, failure degradation to the incumbent, agent-relay default, replay determinism for identical store + policy code + pool |
| `v02-fences.spec.ts` | **V2-3 verification fences**: protocol invalidation shapes (malformed returns, garbage stdout, over-W, parent+child), selection invariants over code policies (no-regression, earliest-tie, replay-behavior degenerate detection, `vNNNN.py` lineage), the in-suite scale gate, docs-currency fences |
| `dsh-schema.spec.ts` | **Real-validator regression fence** (see below) |

## The real-validator regression fence

`dsh-schema.spec.ts` imports the **actual** `@deepseek-ai/dsh-tools` package and
validates representative results and arguments for all seven tools against
their declared schemas through the harness's own validator
(`validateJsonSchemaValue`). This class of test exists because a live incident
showed the real validator is stricter than standalone typechecking: an
undeclared output property passed every stubbed test and failed only when the
plugin mounted inside DSH.

The harness package is not an npm dependency, so this spec resolves it through
optional junctions and **skips when they are absent**:

```sh
# from the plugin repo root — enables the real-validator spec
node -e "const fs=require('fs');for(const [link,target] of [['node_modules/@deepseek-ai/dsh-tools','<HARNESS_CHECKOUT>/packages/core/tools'],['node_modules/@deepseek-ai/schemastery','<HARNESS_CHECKOUT>/vendor/schemastery'],['node_modules/@deepseek-ai/cordis','<HARNESS_CHECKOUT>/vendor/cordis']]){fs.mkdirSync(require('path').dirname(link),{recursive:true});fs.symlinkSync(target,link,'junction')}"
```

(`junction` is Windows; use `symlinkSync(target, link, 'dir')` on POSIX.)
Without the junctions the rest of the suite still runs — only the
real-enforcement class is skipped, which the report line marks as skipped.

## Python dependency (v0.2)

`code-policy.spec.ts` drives the real `python -I` decision protocol. Tests
skip automatically when `python --version` fails; Python 3.12+ with the
standard library only (no third-party packages needed by the bootstrap
policy). Set nothing — the skip is reported in the vitest output.

## Perf gate (v0.2 F4)

Two measurement vehicles, same shape (one `python -I` subprocess per candidate,
every world inside it):

1. **In-suite fence** (the CI gate): `tests/v02-fences.spec.ts` (skips when
   Python is unavailable) seeds ~10 closed worlds on a temp store and replays
   `poolSize: 32` code candidates against all of them, asserting completion
   within the ROADMAP-v0.2 F4 budget ("a few minutes on a laptop"; the fence
   asserts < 300 s) and printing the measured wall-time as `[scale-gate] …`.
   Measured on the development machine (consumer laptop-class, Windows,
   Python 3.12): **≈ 3.2–3.5 s** for 32 candidates × 10 worlds.
2. **Standalone bench**: `node bench/perf-gate.mjs [--rounds 10] [--pool 32]`
   measures the same shape against a store it builds itself, printing the
   store-build and replay phases separately plus PASS/CHECK against the 300 s
   budget. Measured: **replay wall-time 7,754 ms (≈ 24 ms per episode) for
   32 × 10 worlds — PASS**; store-build phase 431 ms. The bench keeps its
   store under `.dreamrsi-bench/` for inspection (add that directory to
   `.gitignore` if you run it).

The same in-suite fence doubles as the at-scale determinism check: replaying
the identical pool twice over the same worlds yields identical candidate ×
mean-score rankings.

## What the suite deliberately does not cover

- A live `dsh-agent-presets` mount inside a running DSH process — preset tests
  validate composition structure and health-check shapes; the mount itself is
  the harness package's own tested contract.
- Concurrency races between sessions sharing one standing mount.
- Model-facing behavior (prompt adherence) — the persona guidance is
  structural, not behavioral.
