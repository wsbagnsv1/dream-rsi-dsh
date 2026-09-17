/**
 * v0.2 F1 code-policy tests: the `python -I` JSON-lines decision protocol
 * over a minimal local spawn implementation, the shipped bootstrap policy,
 * malformed/timeout invalidation, per-workspace stores bootstrapping
 * `v0001.py`, and the autoDream cycle stage.
 *
 * The spawn stub wraps `node:child_process.spawn` with the exact handle
 * shape the ambient mirror declares, so the real protocol (piped stdio,
 * JSON lines, terminate escalation) runs end-to-end against the real Python
 * interpreter. Tests skip when Python is unavailable.
 *
 * @module
 */

import { spawn as nodeSpawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { DreamEngine, type EngineError } from '../src/engine.ts'
import { BOOTSTRAP_POLICY_SOURCE, PYTHON_RUNNER_SOURCE } from '../src/bootstrap-policy.ts'
import type { SubprocessService } from '../src/policy-runtime.ts'
import type { PluginConfig } from '../src/types.ts'
import { cleanupTempRoots, makeClock, makeConfig, makeTempRoot, must } from './fixtures.ts'

const pythonAvailable = spawnSync('python', ['--version'], { timeout: 10000 }).status === 0

/** Minimal local SubprocessService implementing the ambient handle shape. */
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
const roots: string[] = []

async function makeCodeHarness(overrides: Partial<PluginConfig> = {}): Promise<{ engine: DreamEngine; root: string; config: PluginConfig }> {
  const root = await makeTempRoot()
  roots.push(root)
  const config = makeConfig({ dataDir: root, policyEpisodeTimeoutMs: 15000, ...overrides })
  configs.push(config)
  const engine = new DreamEngine({ config, workspaceRoot: root, clock: makeClock(), subprocess: localSubprocess() })
  return { engine, root, config }
}

afterEach(async () => {
  configs.length = 0
  await cleanupTempRoots()
})

describe('code policies via ctx.subprocess (v0.2 F1)', () => {
  it.skipIf(!pythonAvailable)('ships a bootstrap policy whose source defines solve(view) and drives a real episode', async () => {
    expect(BOOTSTRAP_POLICY_SOURCE).toContain('def solve(view)')
    expect(PYTHON_RUNNER_SOURCE).toContain('json.loads')
    const { engine, root } = await makeCodeHarness()
    await engine.bootstrap()
    // Fresh stores under policyEngine 'code' persist v0001.py + the runner.
    expect(existsSync(path.join(root, 'policies', 'v0001.py'))).toBe(true)
    expect(existsSync(path.join(root, 'policies', '.runner.py'))).toBe(true)
    const source = (await engine.store.getPolicy('v0001'))?.code ?? ''
    expect(source).toContain('def solve(view)')

    // The bootstrap policy answers a real JSON-lines episode through python -I.
    const begin = await engine.beginRound({ workspaceRoot: root, workspaceSource: 'session' })
    expect(begin.policyKind).toBe('code')
    expect(begin.policySource).toContain('def solve(view)')
    expect(begin.limits.maxParallelism).toBe(4)
    await engine.endRound({ roundId: begin.roundId }, { workspaceRoot: root, workspaceSource: 'session' })
  })

  it.skipIf(!pythonAvailable)('replays a code candidate end-to-end in a dream and ranks it', async () => {
    const { engine, root } = await makeCodeHarness()
    await engine.bootstrap()
    const begin = await engine.beginRound({ workspaceRoot: root, workspaceSource: 'session' })
    await engine.logDecision({
      roundId: begin.roundId,
      batchSeq: 1,
      decisions: [
        { parentId: null, action: { summary: 'anneal schedule baseline', mechanism: 'anneal', tags: ['anneal'] }, outcome: { score: 0.5, evaluated: true, valid: true, failClass: 'ok', error: null, deltaVsBaseline: null, deltaVsParent: null }, metrics: { agentCalls: 1, wallMs: 5 } },
        { parentId: null, action: { summary: 'cuda shared memory kernel', mechanism: 'cuda-shared-mem', tags: ['gpu'] }, outcome: { score: 0.8, evaluated: true, valid: true, failClass: 'ok', error: null, deltaVsBaseline: null, deltaVsParent: null }, metrics: { agentCalls: 1, wallMs: 5 } },
      ],
    }, { workspaceRoot: root, workspaceSource: 'session' })
    await engine.endRound({ roundId: begin.roundId }, { workspaceRoot: root, workspaceSource: 'session' })

    const report = await engine.dream({
      candidates: [BOOTSTRAP_POLICY_SOURCE],
    }, { workspaceRoot: root, workspaceSource: 'session' })
    expect(report.historySize).toBe(1)
    expect(report.ranking).toHaveLength(2)
    for (const entry of report.ranking) {
      expect(entry.kind).toBe('code')
      expect(entry.invalid).toBeNull()
      expect(entry.perWorld[0]?.trajectory.steps.length).toBeGreaterThan(0)
      expect(entry.perWorld[0]?.stopReason).toBe('exhausted')
    }
    expect(report.guards.noRegression).toBe(true)
  })

  it.skipIf(!pythonAvailable)('marks an episode invalid when the policy raises in solve()', async () => {
    const { engine, root } = await makeCodeHarness()
    await engine.bootstrap()
    const begin = await engine.beginRound({ workspaceRoot: root, workspaceSource: 'session' })
    await engine.logDecision({
      roundId: begin.roundId,
      batchSeq: 1,
      decisions: [
        { parentId: null, action: { summary: 'anneal schedule baseline', mechanism: 'anneal', tags: ['anneal'] }, outcome: { score: 0.5, evaluated: true, valid: true, failClass: 'ok', error: null, deltaVsBaseline: null, deltaVsParent: null }, metrics: { agentCalls: 1, wallMs: 5 } },
      ],
    }, { workspaceRoot: root, workspaceSource: 'session' })
    await engine.endRound({ roundId: begin.roundId }, { workspaceRoot: root, workspaceSource: 'session' })
    const report = await engine.dream({
      candidates: ['def solve(view):\n    raise RuntimeError("boom")\n'],
    }, { workspaceRoot: root, workspaceSource: 'session' })
    const candidate = must(report.ranking[1])
    expect(candidate.invalid).toContain('policy solve() failed')
    expect(candidate.meanScore).toBe(-1e12)
    expect(report.selectedCandidate).toBe(0)
  })

  it.skipIf(!pythonAvailable)('terminates a policy that exceeds the per-episode timeout and marks it invalid', async () => {
    const { engine, root } = await makeCodeHarness({ policyEpisodeTimeoutMs: 400 })
    await engine.bootstrap()
    const begin = await engine.beginRound({ workspaceRoot: root, workspaceSource: 'session' })
    await engine.logDecision({
      roundId: begin.roundId,
      batchSeq: 1,
      decisions: [
        { parentId: null, action: { summary: 'anneal schedule baseline', mechanism: 'anneal', tags: ['anneal'] }, outcome: { score: 0.5, evaluated: true, valid: true, failClass: 'ok', error: null, deltaVsBaseline: null, deltaVsParent: null }, metrics: { agentCalls: 1, wallMs: 5 } },
      ],
    }, { workspaceRoot: root, workspaceSource: 'session' })
    await engine.endRound({ roundId: begin.roundId }, { workspaceRoot: root, workspaceSource: 'session' })
    const report = await engine.dream({
      candidates: ['import time\ndef solve(view):\n    time.sleep(5)\n    return {"batch": [], "stop": True}\n'],
    }, { workspaceRoot: root, workspaceSource: 'session' })
    const candidate = must(report.ranking[1])
    expect(candidate.invalid).toContain('timed out')
    expect(report.selectedCandidate).toBe(0)
  })

  it('invalidates code candidates (and never the run) when no subprocess seam exists', async () => {
    const root = await makeTempRoot()
    roots.push(root)
    const config = makeConfig()
    configs.push(config)
    const engine = new DreamEngine({ config, workspaceRoot: root, clock: makeClock() })
    await engine.bootstrap()
    const begin = await engine.beginRound({ workspaceRoot: root, workspaceSource: 'session' })
    await engine.endRound({ roundId: begin.roundId }, { workspaceRoot: root, workspaceSource: 'session' })
    const report = await engine.dream({ candidates: [BOOTSTRAP_POLICY_SOURCE] }, { workspaceRoot: root, workspaceSource: 'session' })
    expect(report.ranking[1]?.invalid).toContain('no subprocess runtime')
    expect(report.selectedCandidate).toBe(0)
  })

  it('autoDream runs dreaming after every end_round by default and can be turned off', async () => {
    const { engine, root } = await makeCodeHarness()
    await engine.bootstrap()
    const begin = await engine.beginRound({ workspaceRoot: root, workspaceSource: 'session' })
    const ended = await engine.endRound({ roundId: begin.roundId }, { workspaceRoot: root, workspaceSource: 'session' })
    expect(ended.autoDream?.report).not.toBeNull()
    expect(ended.autoDream?.report?.selectedCandidate).toBe(0)

    const offRoot = await makeTempRoot()
    roots.push(offRoot)
    const offEngine = new DreamEngine({
      config: makeConfig({ autoDream: 'off' }),
      workspaceRoot: offRoot,
      clock: makeClock(),
      subprocess: localSubprocess(),
    })
    await offEngine.bootstrap()
    const offBegin = await offEngine.beginRound({ workspaceRoot: offRoot, workspaceSource: 'session' })
    const offEnded = await offEngine.endRound({ roundId: offBegin.roundId }, { workspaceRoot: offRoot, workspaceSource: 'session' })
    expect(offEnded.autoDream?.report).toBeNull()
    expect(offEnded.autoDream?.skippedReason).toContain('autoDream is off')
  })

  it('rejects a code policy without a solve() definition at policy_set time', async () => {
    const { engine, root } = await makeCodeHarness()
    await engine.bootstrap()
    await engine.beginRound({ workspaceRoot: root, workspaceSource: 'session' })
    await expect(
      engine.policySet({ code: 'x = 1\n', notes: 'no solve' }, { workspaceRoot: root, workspaceSource: 'session' }),
    ).rejects.toThrow(/def solve/)
    void (0 as unknown as EngineError)
  })
})
