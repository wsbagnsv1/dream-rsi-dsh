/**
 * v0.2 F4 perf gate: measure replay wall-time for a pool of code candidates
 * × the store's closed worlds. One subprocess per candidate; every world of
 * a candidate runs inside that one process (ROADMAP-v0.2 F1).
 *
 * Usage: node bench/perf-gate.mjs [--rounds N] [--pool N] [--dir DIR]
 * Creates a temp store under DIR (default `.dreamrsi-bench`), closes N
 * synthetic discovery rounds, spawns POOL copies of the bootstrap code
 * policy, replays each against every world, and prints the wall-time split.
 */

import { rmSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { spawn as nodeSpawn } from 'node:child_process'
import { DreamEngine } from '../src/engine.ts'
import { BOOTSTRAP_POLICY_SOURCE } from '../src/bootstrap-policy.ts'
import type { PluginConfig, SubprocessRuntime } from '../src/types.ts'

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index !== -1 && args[index + 1] !== undefined ? Number(args[index + 1]) : fallback
}
const dirFlagIndex = args.indexOf('--dir')
const benchDir = path.resolve(dirFlagIndex !== -1 && args[dirFlagIndex + 1] !== undefined ? args[dirFlagIndex + 1] : '.dreamrsi-bench')
const rounds = flag('rounds', 10)
const poolSize = flag('pool', 32)

rmSync(benchDir, { recursive: true, force: true })
mkdirSync(benchDir, { recursive: true })

/** Real local subprocess implementation over node:child_process. */
function localSubprocess() {
  return {
    spawn(spec) {
      const child = nodeSpawn(spec.argv[0], spec.argv.slice(1), {
        cwd: spec.cwd,
        env: { ...process.env },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
      let settled = false
      const done = new Promise((resolve, reject) => {
        child.on('error', reject)
        child.on('close', (code, signal) => {
          settled = true
          resolve({ exitCode: code, signal: signal ?? null })
        })
      })
      return {
        stdin: child.stdin,
        stdout: child.stdout,
        stderr: child.stderr,
        collected: {},
        done,
        terminate() {
          if (!settled) child.kill()
        },
        async waitForExit() {
          await done.catch(() => undefined)
          return true
        },
      }
    },
  }
}

const config = {
  dataDir: benchDir,
  candidateCount: 3,
  maxOnlineRounds: 16,
  maxReplayRounds: 64,
  beta1: 0.01,
  beta2: 0.05,
  normalizeScores: true,
  estimatorMaxAnalogues: 5,
  estimatorMinAnalogues: 3,
  similarityFloor: 0.1,
  hallucinationTau: 0.18,
  noveltyLambda: 0.25,
  confidenceMediumTau: 0.45,
  similarityGamma: 2,
  policyEngine: 'code',
  autoDream: 'off',
  trajectoryCap: 20,
  policyEpisodeTimeoutMs: 60000,
}
const engine = new DreamEngine({ config: config, workspaceRoot: benchDir, clock: () => new Date(Date.UTC(2026, 0, 15)), subprocess: localSubprocess() })
await engine.bootstrap()

const t0 = Date.now()
let lastPolicyVersion = null
for (let round = 0; round < rounds; round++) {
  const begin = await engine.beginRound({ workspaceRoot: benchDir, workspaceSource: 'session' })
  const mechanisms = [
    { summary: `coordinate descent pass ${round}`, mechanism: 'coord-descent', tags: ['optimization'] },
    { summary: `cuda shared-memory kernel ${round}`, mechanism: 'cuda-shared-mem', tags: ['gpu'] },
    { summary: `layout refactor ${round}`, mechanism: 'layout', tags: ['memory'] },
  ]
  for (let batch = 0; batch < 2; batch++) {
    await engine.logDecision({
      roundId: begin.roundId,
      batchSeq: batch + 1,
      decisions: mechanisms.map((entry, index) => ({
        parentId: batch === 0 ? null : `r${String(round + 1).padStart(4, '0')}-n${String(index + 1).padStart(3, '0')}`,
        action: { ...entry, tags: [...entry.tags], artifactPaths: [] },
        outcome: {
          score: 0.4 + 0.05 * round + 0.1 * batch + 0.01 * index,
          evaluated: true,
          valid: true,
          failClass: 'ok',
          error: null,
          deltaVsBaseline: null,
          deltaVsParent: null,
        },
        metrics: { agentCalls: 1, wallMs: 10 },
      })),
    }, { workspaceRoot: benchDir, workspaceSource: 'session' })
  }
  const ended = await engine.endRound({ roundId: begin.roundId }, { workspaceRoot: benchDir, workspaceSource: 'session' })
  lastPolicyVersion = ended.activePolicyVersion
}
const buildMs = Date.now() - t0

const worlds = rounds
const pool = []
for (let index = 0; index < poolSize; index++) {
  pool.push(BOOTSTRAP_POLICY_SOURCE.replaceAll('BETA = 0.6', `BETA = ${(0.3 + 0.4 * (index / Math.max(1, poolSize - 1))).toFixed(2)}`))
}

// Write candidate sources once; the runner loads each per candidate process.
const policyDir = path.join(benchDir, 'policies')
const candidateFiles = []
for (const [index, source] of pool.entries()) {
  const file = path.join(policyDir, `.bench-candidate-${String(index).padStart(3, '0')}.py`)
  writeFileSync(file, source, 'utf8')
  candidateFiles.push(file)
}

const t1 = Date.now()
const reports = []
for (const [index, file] of candidateFiles.entries()) {
  const source = pool[index]
  const report = await engine.dream({ candidates: [source] }, { workspaceRoot: benchDir, workspaceSource: 'session' })
  reports.push({ index, meanScore: report.ranking[1]?.meanScore ?? report.ranking[0]?.meanScore, worlds })
}
const dreamMs = Date.now() - t1

const totalEpisodes = poolSize * worlds
const perEpisodeMs = dreamMs / totalEpisodes
console.log('=== Dream-RSI v0.2 perf gate (F4) ===')
console.log(`poolSize            : ${poolSize}`)
console.log(`worlds              : ${worlds}`)
console.log(`episodes            : ${totalEpisodes} (one subprocess per candidate)`)
console.log(`store build time    : ${buildMs} ms`)
console.log(`replay wall-time    : ${dreamMs} ms`)
console.log(`per-episode average : ${perEpisodeMs.toFixed(1)} ms`)
console.log(`budget              : "a few minutes on a laptop" → ${dreamMs < 180000 ? 'PASS' : 'CHECK'}`)
console.log(`best replayed mean  : ${Math.max(...reports.map((r) => r.meanScore)).toFixed(4)}`)
for (const file of candidateFiles) {
  try { rmSync(file, { force: true }) } catch { /* best-effort cleanup */ }
}
console.log(`store kept for inspection: ${benchDir} (active policy ${lastPolicyVersion})`)
