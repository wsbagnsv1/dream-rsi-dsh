/**
 * Dream-RSI v0.2 F4 perf gate — standalone entry point.
 *
 * Thin wrapper that runs the TypeScript gate (bench/perf-gate.ts) under
 * Node's TS type-stripping (the same mechanism the run-from-source DSH
 * deployment uses), so no build step is required:
 *
 *   node bench/perf-gate.mjs [--rounds 10] [--pool 32] [--dir .dreamrsi-bench]
 *
 * See bench/perf-gate.ts for the measurement body; the in-suite CI fence
 * lives in tests/v02-fences.spec.ts (scale gate) and remains the CI gate.
 */

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import process from 'node:process'

const here = path.dirname(fileURLToPath(import.meta.url))
const gateTs = path.join(here, 'perf-gate.ts')
const result = spawnSync(process.execPath, ['--experimental-strip-types', gateTs, ...process.argv.slice(2)], {
  stdio: 'inherit',
  windowsHide: true,
})
process.exit(result.status ?? 1)
