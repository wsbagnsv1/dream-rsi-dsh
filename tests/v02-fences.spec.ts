/**
 * v0.2 verification fences (V2-3 / task-15): the cross-cutting guarantees the
 * feature specs do not each cover — protocol invalidation shapes, selection
 * invariants over CODE policies, the scale gate, and docs currency.
 *
 * Plan: docs/test-plan.md (V2-3). Environment gates:
 * - code-policy fences skip when Python is unavailable (they drive real
 *   `python -I` episodes through the ambient subprocess handle);
 * - the real-validator fence lives in dsh-schema.spec.ts and skips without
 *   the optional @deepseek-ai junctions;
 * - the standard-assembly comparison in preset.spec.ts runs only with
 *   DREAM_RSI_HARNESS_ROOT set.
 *
 * @module
 */

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn as nodeSpawn, spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { DreamEngine } from '../src/engine.ts'
import { BOOTSTRAP_POLICY_SOURCE } from '../src/bootstrap-policy.ts'
import type { SubprocessService } from '../src/policy-runtime.ts'
import type { PluginConfig } from '../src/types.ts'
import { cleanupTempRoots, makeClock, makeConfig, makeTempRoot, must } from './fixtures.ts'

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pythonAvailable = spawnSync('python', ['--version'], { timeout: 10000 }).status === 0

/** The documented scale-gate budget (ROADMAP-v0.2 F4: "a few minutes"). */
const SCALE_BUDGET_MS = 300_000
const SCALE_WORLDS = 10
const SCALE_POOL = 32

/** Minimal local SubprocessService over node:child_process (same shape as code-policy.spec.ts). */
function localSubprocess(): SubprocessService {
  return {
    spawn(spec) {
      const child = nodeSpawn(spec.argv[0] as string, spec.argv.slice(1), {
        cwd: spec.cwd,
        env: { ...process.env, ...spec.env },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
      const proc = child as import('node:child_process').ChildProcessWithoutNullStreams
      let settled = false
      const done = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        proc.on('error', reject)
        proc.on('close', (code, signal) => {
          settled = true
          resolve({ exitCode: code, signal: signal ?? null })
        })
      })
      return {
        stdin: proc.stdin,
        stdout: proc.stdout,
        stderr: proc.stderr,
        collected: {},
        done,
        terminate() {
          if (!settled) proc.kill()
        },
        async waitForExit() {
          await done.catch(() => undefined)
          return true
        },
      }
    },
  }
}

const configs: PluginConfig[] = []

async function makeFenceHarness(overrides: Partial<PluginConfig> = {}): Promise<{ engine: DreamEngine; root: string }> {
  const root = await makeTempRoot()
  const config = makeConfig({ dataDir: root, policyEpisodeTimeoutMs: 15000, ...overrides })
  configs.push(config)
  const engine = new DreamEngine({ config, workspaceRoot: root, clock: makeClock(), subprocess: localSubprocess() })
  return { engine, root }
}

/** Seed one closed round (one root child) as a replay world. */
async function seedRound(engine: DreamEngine, root: string, score = 0.5): Promise<string> {
  const begin = await engine.beginRound({ workspaceRoot: root, workspaceSource: 'session' })
  await engine.logDecision({
    roundId: begin.roundId,
    batchSeq: 1,
    decisions: [{
      parentId: null,
      action: { summary: 'anneal the schedule', mechanism: 'anneal', tags: ['anneal'] },
      outcome: { score, evaluated: true, valid: true, failClass: 'ok', error: null, deltaVsBaseline: null, deltaVsParent: null },
      metrics: { agentCalls: 1, wallMs: 5 },
    }],
  }, { workspaceRoot: root, workspaceSource: 'session' })
  await engine.endRound({ roundId: begin.roundId }, { workspaceRoot: root, workspaceSource: 'session' })
  return begin.roundId
}

afterEach(async () => {
  configs.length = 0
  await cleanupTempRoots()
})

describe('protocol invalidation shapes (v0.2 F1 fences)', () => {
  it.skipIf(!pythonAvailable)('a wrong-shaped solve() return value invalidates the episode', async () => {
    const { engine, root } = await makeFenceHarness()
    await engine.bootstrap()
    await seedRound(engine, root)
    const report = await engine.dream({
      candidates: ['def solve(view):\n    return {"batch": "not-a-list", "stop": False}\n'],
    }, { workspaceRoot: root, workspaceSource: 'session' })
    const candidate = must(report.ranking[1])
    expect(candidate.invalid).not.toBeNull()
    expect(candidate.meanScore).toBe(-1e12)
    expect(report.selectedCandidate).toBe(0)
  })

  it.skipIf(!pythonAvailable)('garbage on the policy stdout invalidates the episode without crashing the run', async () => {
    const { engine, root } = await makeFenceHarness()
    await engine.bootstrap()
    await seedRound(engine, root)
    const report = await engine.dream({
      candidates: ['def solve(view):\n    print("this is not a protocol line")\n    return {"batch": [], "stop": True}\n'],
    }, { workspaceRoot: root, workspaceSource: 'session' })
    const candidate = must(report.ranking[1])
    expect(candidate.invalid).not.toBeNull()
    expect(report.selectedCandidate).toBe(0)
  })

  it.skipIf(!pythonAvailable)('an over-W batch from a code policy scores −∞ (6 leaves selectable, W = 4)', async () => {
    const { engine, root } = await makeFenceHarness()
    await engine.bootstrap()
    // World: six root children + one grandchild under the last one. Opening a
    // branch per round reveals 7 of 8 nodes — NOT exhausted — so the next
    // decision sees six selectable leaves; batching them all exceeds W = 4
    // and the batch gate invalidates the episode before any reveal.
    const begin = await engine.beginRound({ workspaceRoot: root, workspaceSource: 'session' })
    await engine.logDecision({
      roundId: begin.roundId,
      batchSeq: 1,
      decisions: Array.from({ length: 6 }, (_, index) => ({
        parentId: null,
        action: { summary: `mechanism ${index}`, mechanism: `mech-${index}`, tags: [`t${index}`] },
        outcome: { score: 0.1 + index * 0.1, evaluated: true, valid: true, failClass: 'ok', error: null, deltaVsBaseline: null, deltaVsParent: null },
        metrics: { agentCalls: 1, wallMs: 5 },
      })),
    }, { workspaceRoot: root, workspaceSource: 'session' })
    const sixth = must((await engine.store.getNodes(begin.roundId)).find((node) => node.action.mechanism === 'mech-5'))
    await engine.logDecision({
      roundId: begin.roundId,
      batchSeq: 2,
      decisions: [{
        parentId: sixth.id,
        action: { summary: 'deepen the best branch', mechanism: 'mech-5', tags: ['t5'] },
        outcome: { score: 0.9, evaluated: true, valid: true, failClass: 'ok', error: null, deltaVsBaseline: null, deltaVsParent: null },
        metrics: { agentCalls: 1, wallMs: 5 },
      }],
    }, { workspaceRoot: root, workspaceSource: 'session' })
    await engine.endRound({ roundId: begin.roundId }, { workspaceRoot: root, workspaceSource: 'session' })

    const openThenFlood = 'def solve(view):\n    roots = [s["id"] for s in view["selectable"] if s["kind"] == "root"]\n    leaves = [s["id"] for s in view["selectable"] if s["kind"] != "root"]\n    if len(roots) > 0 and len(leaves) < 6:\n        return {"batch": roots[:1], "stop": False}\n    return {"batch": leaves, "stop": False}\n'
    const report = await engine.dream({ candidates: [openThenFlood] }, { workspaceRoot: root, workspaceSource: 'session' })
    const candidate = must(report.ranking[1])
    expect(candidate.invalid).not.toBeNull()
    expect(candidate.invalid).toMatch(/W=4|exceeds|parallelism/i)
    expect(candidate.meanScore).toBe(-1e12)
    expect(report.selectedCandidate).toBe(0)
  })

  it.skipIf(!pythonAvailable)('a parent+child batch from a code policy scores −∞', async () => {
    const { engine, root } = await makeFenceHarness()
    await engine.bootstrap()
    // Chain world: root → n001 → n002. After revealing n001, root and n001 are
    // both selectable and are parent+child.
    const begin = await engine.beginRound({ workspaceRoot: root, workspaceSource: 'session' })
    await engine.logDecision({
      roundId: begin.roundId,
      batchSeq: 1,
      decisions: [{
        parentId: null,
        action: { summary: 'chain start', mechanism: 'anneal', tags: ['anneal'] },
        outcome: { score: 0.5, evaluated: true, valid: true, failClass: 'ok', error: null, deltaVsBaseline: null, deltaVsParent: null },
        metrics: { agentCalls: 1, wallMs: 5 },
      }],
    }, { workspaceRoot: root, workspaceSource: 'session' })
    await engine.logDecision({
      roundId: begin.roundId,
      batchSeq: 2,
      decisions: [{
        parentId: must((await engine.store.getNodes(begin.roundId)).find((node) => node.parentId !== null))?.id ?? null,
        action: { summary: 'chain refine', mechanism: 'anneal', tags: ['anneal'] },
        outcome: { score: 0.8, evaluated: true, valid: true, failClass: 'ok', error: null, deltaVsBaseline: null, deltaVsParent: null },
        metrics: { agentCalls: 1, wallMs: 5 },
      }],
    }, { workspaceRoot: root, workspaceSource: 'session' })
    await engine.endRound({ roundId: begin.roundId }, { workspaceRoot: root, workspaceSource: 'session' })

    const bothSelectable = 'def solve(view):\n    ids = [s["id"] for s in view["selectable"]]\n    if len(ids) >= 2:\n        return {"batch": ids[:2], "stop": False}\n    return {"batch": ids, "stop": False}\n'
    const report = await engine.dream({ candidates: [bothSelectable] }, { workspaceRoot: root, workspaceSource: 'session' })
    const candidate = must(report.ranking[1])
    expect(candidate.invalid).not.toBeNull()
    expect(candidate.invalid).toMatch(/parent and child|illegal/i)
    expect(report.selectedCandidate).toBe(0)
  })

  it.skipIf(!pythonAvailable)('a non-selectable node id in a code batch is an ILLEGAL batch (−∞), never silently skipped', async () => {
    const { engine, root } = await makeFenceHarness()
    await engine.bootstrap()
    // Two rounds with distinct scores: a real score span keeps the probing
    // incumbent strictly ahead of a do-nothing challenger (a single-score
    // world normalizes quality to 0 for everything).
    await seedRound(engine, root, 0.2)
    await seedRound(engine, root, 0.8)
    const phantom = 'def solve(view):\n    return {"batch": ["r0001-n999"], "stop": False}\n'
    const report = await engine.dream({ candidates: [phantom] }, { workspaceRoot: root, workspaceSource: 'session' })
    const candidate = must(report.ranking[1])
    // ENFORCED (v0.2 F-a, lead-adjudicated): the replay action space is the
    // recorded tree — unknown/non-selectable ids are an illegal batch (−∞),
    // with the offending ids surfaced in the invalid reason.
    expect(candidate.invalid).toContain('outside the replay action space')
    expect(candidate.invalid).toContain('r0001-n999')
    expect(candidate.meanScore).toBe(-1e12)
    expect(report.selectedCandidate).toBe(0)
    expect(report.guards.noRegression).toBe(true)
  })
})

describe('selection invariants over code policies (v0.2 F1/F2 fences)', () => {
  it.skipIf(!pythonAvailable)('no-regression: an invalid challenger never displaces the incumbent', async () => {
    const { engine, root } = await makeFenceHarness()
    await engine.bootstrap()
    await seedRound(engine, root)
    const report = await engine.dream({
      candidates: ['def solve(view):\n    raise RuntimeError("nope")\n'],
    }, { workspaceRoot: root, workspaceSource: 'session' })
    expect(report.ranking[0]?.candidate).toBe(0)
    expect(report.selectedCandidate).toBe(0)
    expect(report.guards.noRegression).toBe(true)
  })

  it.skipIf(!pythonAvailable)('earliest-tie: identical code candidates tie and the earliest index wins the argmax', async () => {
    const { engine, root } = await makeFenceHarness()
    await engine.bootstrap()
    await seedRound(engine, root, 0.9)
    const twin = BOOTSTRAP_POLICY_SOURCE
    const report = await engine.dream({
      candidates: [twin, twin],
    }, { workspaceRoot: root, workspaceSource: 'session' })
    const scores = report.ranking.map((entry) => ({ candidate: entry.candidate, meanScore: entry.meanScore }))
    const best = Math.max(...scores.map((s) => s.meanScore))
    const earliestBest = must(scores.find((s) => s.meanScore === best)).candidate
    expect(report.selectedCandidate).toBe(earliestBest)
    expect(report.guards.noRegression).toBe(true)
  })

  it.skipIf(!pythonAvailable)('degenerate detection from replay behavior: an immediately-stopping code policy is disqualified under strictGuards', async () => {
    const { engine, root } = await makeFenceHarness()
    await engine.bootstrap()
    await seedRound(engine, root)
    const quitter = 'def solve(view):\n    return {"batch": [], "stop": True}\n'
    const lenient = await engine.dream({ candidates: [quitter] }, { workspaceRoot: root, workspaceSource: 'session' })
    const lenientEntry = must(lenient.ranking[1])
    expect(lenientEntry.diagnostics.stopsImmediately).toBe(true)
    expect(lenientEntry.invalid).toBeNull()

    const strict = await engine.dream({ candidates: [quitter], strictGuards: true }, { workspaceRoot: root, workspaceSource: 'session' })
    const strictEntry = must(strict.ranking[1])
    expect(strictEntry.invalid).toMatch(/stops-immediately|degenerate/)
    expect(strictEntry.meanScore).toBe(-1e12)
    expect(strict.selectedCandidate).toBe(0)
  })

  it('code-policy lineage: policy_set { code } versions vNNNN.py with incumbent parentage and hydrating reads', async () => {
    const { engine, root } = await makeFenceHarness()
    await engine.bootstrap()
    const result = await engine.policySet({ code: BOOTSTRAP_POLICY_SOURCE, name: 'twin-bootstrap', notes: 'first code challenger' }, { workspaceRoot: root, workspaceSource: 'session' })
    expect(result.accepted).toBe(true)
    expect(result.activeVersion).toBe('v0002') // v0001 is the bootstrap
    expect(result.previousVersion).toBe('v0001')

    const record = must(await engine.store.getPolicy('v0002'))
    expect(record.kind).toBe('code')
    expect(record.parentId).toBe('v0001')
    expect(record.code).toContain('def solve(view)')
    expect(existsSync(path.join(root, 'policies', 'v0002.py'))).toBe(true)
    const onDisk = await readFile(path.join(root, 'policies', 'v0002.py'), 'utf8')
    expect(onDisk).toContain('def solve(view)')

    const history = (await engine.policyGet({}, { workspaceRoot: root, workspaceSource: 'session' })) as { history: { version: string }[] }
    expect(history.history.map((entry) => entry.version)).toContain('v0002')
    // The index records the code kind (the policy_get history projection
    // carries version/status/name only — as-built).
    const indexEntry = must((await engine.store.listPolicyEntries()).find((entry) => entry.version === 'v0002'))
    expect(indexEntry.kind).toBe('code')
  })
})

describe('scale gate (v0.2 F4: poolSize 32 × 10 worlds)', () => {
  it.skipIf(!pythonAvailable)(`replays 32 code candidates × ${SCALE_WORLDS} worlds within the documented budget`, async () => {
    const { engine, root } = await makeFenceHarness()
    await engine.bootstrap()
    for (let index = 0; index < SCALE_WORLDS; index++) {
      await seedRound(engine, root, 0.2 + (index % 5) * 0.15)
    }
    const candidates = Array.from({ length: SCALE_POOL }, () => BOOTSTRAP_POLICY_SOURCE)

    const startedAt = Date.now()
    const report = await engine.dream({ candidates }, { workspaceRoot: root, workspaceSource: 'session' })
    const measuredMs = Date.now() - startedAt

    expect(report.historySize).toBe(SCALE_WORLDS)
    expect(report.ranking).toHaveLength(SCALE_POOL + 1) // incumbent + pool
    expect(measuredMs).toBeLessThan(SCALE_BUDGET_MS)
    // Deterministic at scale: same fixture inputs ⇒ identical report shape.
    const again = await engine.dream({ candidates }, { workspaceRoot: root, workspaceSource: 'session' })
    expect(again.ranking.map((entry) => [entry.candidate, entry.meanScore])).toEqual(
      report.ranking.map((entry) => [entry.candidate, entry.meanScore]),
    )
    // The measured number is surfaced for docs/TESTING.md (run locally to refresh).
    console.log(`[scale-gate] poolSize ${SCALE_POOL} × ${SCALE_WORLDS} worlds: ${measuredMs} ms`)
  }, 600_000)
})

describe('docs currency fences (v0.2)', () => {
  it('README documents the code-policy surface and the new config keys', async () => {
    const readme = await readFile(path.join(PACKAGE_ROOT, 'README.md'), 'utf8')
    expect(readme).toContain('solve(view)')
    for (const key of ['policyEngine', 'autoDream', 'trajectoryCap', 'devLoop', 'poolSize', 'policyEpisodeTimeoutMs']) {
      expect(readme, `README config table documents ${key}`).toContain(key)
    }
  })

  it('TESTING.md documents the v0.2 fence groups and the scale gate', async () => {
    const testing = await readFile(path.join(PACKAGE_ROOT, 'docs', 'TESTING.md'), 'utf8')
    expect(testing).toContain('code-policy')
    expect(testing).toMatch(/scale gate|scale-gate/i)
  })
})
