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

`bench/perf-gate.mjs` measures the replay wall-time of `poolSize: 32` code
candidates × the store's closed worlds (one subprocess per candidate, every
world inside it) and prints per-phase timings. Run it against a store with a
few closed rounds:

```sh
node bench/perf-gate.mjs [--rounds 10] [--pool 32] [--dir .dreamrsi-bench]
```

The gate's budget: poolSize 32 × 10 worlds "in under a few minutes on a
laptop" (ROADMAP-v0.2 F4). The measured number for the current machine is
recorded in the v0.2 PR description and CHANGELOG.

## What the suite deliberately does not cover

- A live `dsh-agent-presets` mount inside a running DSH process — preset tests
  validate composition structure and health-check shapes; the mount itself is
  the harness package's own tested contract.
- Concurrency races between sessions sharing one standing mount.
- Model-facing behavior (prompt adherence) — the persona guidance is
  structural, not behavioral.
