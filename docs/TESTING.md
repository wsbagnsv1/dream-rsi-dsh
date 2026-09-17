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
| `plugin.spec.ts` | Loader-safe export shape; `apply()` mount with a stub context; effect cleanup |
| `preset.spec.ts` | The `Dream-RSI` agent preset: composition shape, standard-assembly coverage, persona workflow guidance, realm discipline, roots overlay, legacy host-mount example |
| `workspace.spec.ts` | Per-workspace `dataDir` resolution (two workspaces → two stores; same-root reuse; disclosed `process.cwd()` fallback) |
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

## What the suite deliberately does not cover

- A live `dsh-agent-presets` mount inside a running DSH process — preset tests
  validate composition structure and health-check shapes; the mount itself is
  the harness package's own tested contract.
- Concurrency races between sessions sharing one standing mount.
- Model-facing behavior (prompt adherence) — the persona guidance is
  structural, not behavioral.
