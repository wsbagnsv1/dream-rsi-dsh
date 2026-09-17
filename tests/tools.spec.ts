/**
 * Tool-surface tests (spec §7) with a stub execution context.
 *
 * The plugin typechecks standalone against `src/dsh-ambient.d.ts` (types
 * only), so at vitest runtime the bare DSH specifiers are aliased to minimal
 * runtime stubs here: `defineTool` is the identity (registration borrows the
 * definition), which is exactly the documented contract shape. The engine
 * behind the tools is the real implementation on a temp data dir.
 *
 * @module
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AnyToolDefinition, ToolExecuteContext } from '@deepseek-ai/dsh-tools'

vi.mock('@deepseek-ai/dsh-tools', () => ({
  defineTool: (definition: unknown) => definition,
}))

import { buildToolDefinitions, DREAMRSI_TOOLS } from '../src/tools.ts'
import { DreamEngine } from '../src/engine.ts'
import { EngineError } from '../src/engine.ts'
import type { PolicyDsl } from '../src/types.ts'
import { cleanupTempRoots, makeClock, makeConfig, makeDsl, makeTempRoot, must } from './fixtures.ts'

afterEach(async () => {
  await cleanupTempRoots()
})

/** Minimal ToolExecuteContext stub per the ambient mirror. */
function stubExec(name: string, args: unknown): ToolExecuteContext {
  return {
    signal: new AbortController().signal,
    callId: `test-${name}`,
    name,
    arguments: args,
    token: null,
  }
}

/** Engine + its seven tool definitions on a fresh temp data dir. */
async function makeHarness() {
  const root = await makeTempRoot()
  const engine = new DreamEngine({ config: makeConfig({ dataDir: root }), workspaceRoot: root, clock: makeClock() })
  const defs = buildToolDefinitions(engine)
  const byName = new Map<string, AnyToolDefinition>(defs.map((def) => [def.name, def]))
  const call = async (name: string, args: unknown = {}): Promise<unknown> => {
    const def = must(byName.get(name), `tool ${name} not registered`)
    return def.execute(args as Record<string, unknown>, stubExec(name, args))
  }
  return { engine, defs, byName, call, root }
}

const decision = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  parentId: null,
  action: { summary: 'anneal the schedule', mechanism: 'anneal', tags: ['anneal'], artifactPaths: [] },
  outcome: { score: 0.5, evaluated: true, valid: true, failClass: 'ok', error: null, deltaVsBaseline: null, deltaVsParent: null },
  metrics: { agentCalls: 1, wallMs: null },
  notes: '',
  ...overrides,
})

describe('tool registration (spec §7)', () => {
  it('exposes exactly the seven spec tools in registration order', () => {
    expect(DREAMRSI_TOOLS).toEqual([
      'dreamrsi_begin_round',
      'dreamrsi_log_decision',
      'dreamrsi_end_round',
      'dreamrsi_history',
      'dreamrsi_dream',
      'dreamrsi_policy_get',
      'dreamrsi_policy_set',
    ])
  })

  it('builds well-formed definitions: name, description, parameters, output schema + render, execute', async () => {
    const { defs } = await makeHarness()
    expect(defs.map((def) => def.name)).toEqual([...DREAMRSI_TOOLS])
    for (const def of defs) {
      expect(typeof def.description).toBe('string')
      expect(def.description.length).toBeGreaterThan(20)
      expect(def.parameters).toBeTypeOf('object')
      expect(def.output.schema).toBeTypeOf('object')
      expect(typeof def.execute).toBe('function')
      const blocks = def.output.render({} as never, { probe: true })
      expect(blocks).toHaveLength(1)
      expect(blocks[0]?.type).toBe('text')
      expect(typeof blocks[0]?.text).toBe('string')
    }
  })
})

describe('online rollout through the tools (spec §7.1–7.3)', () => {
  it('begin → log (batch) → log (incremental, same batchSeq) → end produces a consistent round', async () => {
    const { call, engine } = await makeHarness()

    const begin = await call('dreamrsi_begin_round') as { roundId: string; policyVersion: string; policy: PolicyDsl; limits: { maxRounds: number; maxParallelism: number }; historyDigest: Record<string, unknown> }
    expect(begin.roundId).toBe('r0001')
    expect(begin.policyVersion).toBe('v0001')
    expect(begin.policy.name).toBe('bootstrap-balanced')
    expect(begin.limits).toEqual({ maxRounds: 16, maxParallelism: 4 })
    expect(begin.historyDigest).toMatchObject({ rounds: 0, totalNodes: 0, bestScoreOverall: null })

    const first = await call('dreamrsi_log_decision', {
      roundId: begin.roundId,
      batchSeq: 1,
      decisions: [decision(), decision({ action: { summary: 'tune gpu kernel blocks', mechanism: 'gpu-kernel', tags: ['cuda'], artifactPaths: [] }, outcome: { score: 0.8, evaluated: true, valid: true, failClass: 'ok', error: null, deltaVsBaseline: null, deltaVsParent: null } })],
    }) as { accepted: string[]; treeStats: { nodes: number; bestScore: number | null; decisionRounds: number }; warnings: string[] }
    expect(first.accepted).toEqual(['r0001-n001', 'r0001-n002'])
    expect(first.treeStats).toEqual({ nodes: 3, bestScore: 0.8, decisionRounds: 1 })
    expect(first.warnings).toEqual([])

    // Incremental call with the same batchSeq grows the same batch entry.
    const second = await call('dreamrsi_log_decision', {
      roundId: begin.roundId,
      batchSeq: 1,
      decisions: [decision({ parentId: first.accepted[0], outcome: { score: 0.9, evaluated: true, valid: true, failClass: 'ok', error: null, deltaVsBaseline: null, deltaVsParent: 0.4 } })],
    }) as { accepted: string[]; treeStats: { nodes: number; decisionRounds: number } }
    expect(second.accepted).toEqual(['r0001-n003'])
    expect(second.treeStats.decisionRounds).toBe(1)

    const end = await call('dreamrsi_end_round', { roundId: begin.roundId, summary: 'good round' }) as { roundStats: { nodes: number; attempts: number; bestScore: number | null; decisionRounds: number; batchSizes: number[] }; worldId: string; simulator: { nodes: number; branches: number; maxDepth: number }; activePolicyVersion: string }
    expect(end.worldId).toBe('r0001')
    expect(end.roundStats.batchSizes).toEqual([3]) // one decision round, three nodes
    expect(end.roundStats.bestScore).toBe(0.9)
    expect(end.simulator).toEqual({ nodes: 4, branches: 2, maxDepth: 2 })
    expect(end.activePolicyVersion).toBe('v0001')

    // The audit log records the mutating calls (bootstrap also logs
    // policy.register/policy.set; assert the dreamrsi sequence itself).
    const events = await engine.store.readEvents()
    expect(events.map((event) => event.call).filter((callName) => callName.startsWith('dreamrsi_')))
      .toEqual(['dreamrsi_begin_round', 'dreamrsi_log_decision', 'dreamrsi_log_decision', 'dreamrsi_end_round'])
  })

  it('rejects a second begin while a round is open, and surfaces engine errors for bad calls', async () => {
    const { call } = await makeHarness()
    await call('dreamrsi_begin_round')
    await expect(call('dreamrsi_begin_round')).rejects.toThrow(/still open/)
    await expect(call('dreamrsi_log_decision', { roundId: 'r9999', batchSeq: 1, decisions: [decision()] })).rejects.toThrow(EngineError)
    await expect(call('dreamrsi_log_decision', { roundId: 'r0001', batchSeq: 0, decisions: [decision()] })).rejects.toThrow(/batchSeq/)
    await expect(call('dreamrsi_log_decision', { roundId: 'r0001', batchSeq: 1, decisions: [decision({ action: { summary: '  ', mechanism: 'm', tags: [], artifactPaths: [] } })] })).rejects.toThrow(/action\.summary/)
    await expect(call('dreamrsi_end_round', { roundId: 'r9999' })).rejects.toThrow(/unknown round/)
    await expect(call('dreamrsi_history', { roundId: 'r9999' })).rejects.toThrow(/unknown round/)
    await expect(call('dreamrsi_policy_get', { version: 'v9999' })).rejects.toThrow(/unknown policy version/)
    await expect(call('dreamrsi_policy_set', { version: 'v0001', policy: makeDsl() })).rejects.toThrow(/not both/)
  })
})

describe('history views through the tools (spec §7.4)', () => {
  async function seedHistory(): Promise<Awaited<ReturnType<typeof makeHarness>>> {
    const harness = await makeHarness()
    const { call } = harness
    const begin = await call('dreamrsi_begin_round') as { roundId: string }
    await call('dreamrsi_log_decision', {
      roundId: begin.roundId,
      batchSeq: 1,
      decisions: [
        decision(),
        decision({ action: { summary: 'tune gpu kernel blocks', mechanism: 'gpu-kernel', tags: ['cuda'], artifactPaths: [] }, outcome: { score: 0.8, evaluated: true, valid: true, failClass: 'ok', error: null, deltaVsBaseline: null, deltaVsParent: null } }),
        decision({ outcome: { score: 0, evaluated: false, valid: false, failClass: 'compile', error: 'SyntaxError: unexpected token' } }),
      ],
    })
    await call('dreamrsi_end_round', { roundId: begin.roundId })
    return harness
  }

  it('tree view returns per-round abridged nodes', async () => {
    const { call } = await seedHistory()
    const tree = await call('dreamrsi_history', { view: 'tree' }) as { rounds: { roundId: string; policyVersion: string; nodes: { id: string; depth: number; mechanism: string; score: number; failClass: string }[] }[] }
    expect(tree.rounds).toHaveLength(1)
    const round = must(tree.rounds[0])
    expect(round.roundId).toBe('r0001')
    expect(round.nodes).toHaveLength(4)
    expect(round.nodes.map((node) => node.mechanism)).toEqual(['root', 'anneal', 'gpu-kernel', 'anneal'])
  })

  it('best-paths, failures, rounds, summary, and nodeId subtree views work', async () => {
    const { call } = await seedHistory()
    const best = await call('dreamrsi_history', { view: 'best-paths' }) as { bestPaths: { branchId: number; cumulativeScore: number; length: number }[] }
    expect(best.bestPaths[0]).toMatchObject({ branchId: 1, cumulativeScore: 0.8, length: 1 })

    const failures = await call('dreamrsi_history', { view: 'failures' }) as { failures: { mechanism: string; count: number; errorDigest: string }[] }
    expect(failures.failures).toHaveLength(1)
    expect(must(failures.failures[0])).toMatchObject({ mechanism: 'anneal', count: 1 })
    expect(must(failures.failures[0]).errorDigest).toContain('SyntaxError')

    const rounds = await call('dreamrsi_history', { view: 'rounds' }) as { rounds: { roundId: string; status: string }[] }
    expect(must(rounds.rounds[0])).toMatchObject({ roundId: 'r0001', status: 'closed' })

    const summary = await call('dreamrsi_history', { view: 'summary' }) as { bestScoreOverall: number | null; mechanisms: { mechanism: string; count: number }[]; rounds: { cumulativeAgentCalls: number }[] }
    expect(summary.bestScoreOverall).toBe(0.8)
    expect(summary.rounds[0]?.cumulativeAgentCalls).toBe(3)

    const subtree = await call('dreamrsi_history', { nodeId: 'r0001-n001' }) as { node: { id: string }; subtree: { id: string }[] }
    expect(subtree.node.id).toBe('r0001-n001')
    expect(subtree.subtree.map((node) => node.id)).toEqual(['r0001-n001'])
  })

  it('persists history: a fresh engine over the same data dir sees the same world and rounds', async () => {
    const { call, root } = await seedHistory()
    const engine2 = new DreamEngine({ config: makeConfig({ dataDir: root }), workspaceRoot: root, clock: makeClock() })
    const world = await engine2.getWorld('r0001')
    expect(world.nodes).toHaveLength(4)
    expect(world.rootChildren).toHaveLength(3) // all three batch members are root children
    // bootstrap() is idempotent: no duplicate policy registration after reload.
    const before = (await engine2.store.listPolicyEntries()).length
    await engine2.bootstrap()
    expect(await engine2.store.listPolicyEntries()).toHaveLength(before)
    const begin = await call('dreamrsi_begin_round') as { roundId: string; historyDigest: { rounds: number; totalNodes: number; bestScoreOverall: number | null } }
    expect(begin.roundId).toBe('r0002')
    expect(begin.historyDigest).toMatchObject({ rounds: 1, totalNodes: 4, bestScoreOverall: 0.8 })
  })
})

describe('dreaming through the tools (spec §7.5)', () => {
  it('auto-prepends the incumbent as candidate 0 and returns a ranked, guarded report', async () => {
    const { call, engine } = await makeHarness()
    const begin = await call('dreamrsi_begin_round') as { roundId: string }
    await call('dreamrsi_log_decision', { roundId: begin.roundId, batchSeq: 1, decisions: [decision(), decision({ action: { summary: 'tune gpu kernel blocks', mechanism: 'gpu-kernel', tags: ['cuda'], artifactPaths: [] }, outcome: { score: 0.8, evaluated: true, valid: true, failClass: 'ok', error: null, deltaVsBaseline: null, deltaVsParent: null } })] })
    await call('dreamrsi_end_round', { roundId: begin.roundId })

    const report1 = await call('dreamrsi_dream', { candidates: [makeDsl({ name: 'challenger', W: 2 })] }) as { runId: string; selectedCandidate: number; ranking: { candidate: number; version: string | null; name: string; meanScore: number }[]; guards: { noRegression: boolean; incumbentScore: number }; historySize: number }
    expect(report1.historySize).toBe(1)
    expect(report1.ranking).toHaveLength(2)
    expect(report1.ranking[0]).toMatchObject({ candidate: 0, version: 'v0001', name: 'bootstrap-balanced' })
    expect(report1.ranking[1]).toMatchObject({ candidate: 1, version: null, name: 'challenger' })
    expect(report1.selectedCandidate).toBeGreaterThanOrEqual(0)
    expect(report1.guards.noRegression).toBe(true)
    // The report is persisted under dreams/ and the active policy is untouched.
    expect(await engine.store.getDreamReport(report1.runId)).not.toBeNull()
    expect(await engine.store.getActivePolicyVersion()).toBe('v0001')
  })

  it('is deterministic across repeated dream runs on the same history', async () => {
    const { call } = await makeHarness()
    const begin = await call('dreamrsi_begin_round') as { roundId: string }
    await call('dreamrsi_log_decision', { roundId: begin.roundId, batchSeq: 1, decisions: [decision()] })
    await call('dreamrsi_end_round', { roundId: begin.roundId })
    const args = { candidates: [makeDsl({ name: 'wide', W: 2 }), makeDsl({ name: 'serial', W: 1 })] }
    const first = await call('dreamrsi_dream', args) as { ranking: unknown[]; selectedCandidate: number; guards: unknown; historySize: number; normalization: unknown }
    const second = await call('dreamrsi_dream', args) as { ranking: unknown[]; selectedCandidate: number; guards: unknown; historySize: number; normalization: unknown }
    expect(second.ranking).toEqual(first.ranking)
    expect(second.selectedCandidate).toBe(first.selectedCandidate)
    expect(second.guards).toEqual(first.guards)
    expect(second.normalization).toEqual(first.normalization)
  })
})

describe('policy versioning through the tools (spec §7.6–7.7)', () => {
  it('policy_get returns the active bootstrap policy with its history', async () => {
    const { call } = await makeHarness()
    const result = await call('dreamrsi_policy_get') as { activeVersion: string; policy: { version: string; params: PolicyDsl }; history: { version: string; status: string }[] }
    expect(result.activeVersion).toBe('v0001')
    expect(result.policy.params.name).toBe('bootstrap-balanced')
    expect(result.history.map((entry) => entry.version)).toEqual(['v0001'])
    const named = await call('dreamrsi_policy_get', { version: 'v0001' }) as { policy: { version: string } }
    expect(named.policy.version).toBe('v0001')
  })

  it('policy_set { policy } registers a new immutable version and activates it (fresh guard vacuous)', async () => {
    const { call, engine } = await makeHarness()
    await engine.bootstrap() // create the v0001 incumbent before capturing state
    const before = JSON.stringify((await engine.store.getPolicy('v0001'))?.params)
    const result = await call('dreamrsi_policy_set', { policy: makeDsl({ name: 'portfolio-beta-0.8' }), notes: 'widen the search' }) as { accepted: boolean; activeVersion: string; previousVersion: string | null; guardCheck: { noRegression: boolean; meanReplayScore: number | null } }
    expect(result.accepted).toBe(true)
    expect(result.activeVersion).toBe('v0002')
    expect(result.previousVersion).toBe('v0001')
    expect(result.guardCheck).toMatchObject({ noRegression: true, meanReplayScore: null })
    expect(await engine.store.getActivePolicyVersion()).toBe('v0002')
    // Fresh registration passes the guard vacuously; params of v0001 untouched.
    expect(JSON.stringify((await engine.store.getPolicy('v0001'))?.params)).toBe(before)
    expect((await engine.store.listPolicyEntries()).map((entry) => entry.status)).toEqual(['retired', 'active'])
  })

  it('policy_set { version } re-activates an existing version and reports the previous pointer', async () => {
    const { call, engine } = await makeHarness()
    await call('dreamrsi_policy_set', { policy: makeDsl({ name: 'variant' }) })
    const reactivate = await call('dreamrsi_policy_set', { version: 'v0001' }) as { accepted: boolean; activeVersion: string; previousVersion: string | null }
    expect(reactivate).toMatchObject({ accepted: true, activeVersion: 'v0001', previousVersion: 'v0002' })
    expect(await engine.store.getActivePolicyVersion()).toBe('v0001')
  })

  it('policy_set rejects an invalid PolicyDsl with an engine error', async () => {
    const { call } = await makeHarness()
    await expect(call('dreamrsi_policy_set', { policy: { name: 'broken', W: 0 } })).rejects.toThrow(/invalid PolicyDsl/)
    await expect(call('dreamrsi_policy_set', {})).rejects.toThrow(/provide a `version`/)
  })
})

describe('data-dir isolation', () => {
  it('the store lives entirely under the configured dataDir', async () => {
    const { engine, root } = await makeHarness()
    await engine.bootstrap()
    const round = await engine.store.createRound('v0001', { maxRounds: 16, maxParallelism: 4 })
    expect(round.roundId).toBe('r0001')
    const { access } = await import('node:fs/promises')
    for (const sub of ['trees', 'policies', 'dreams', 'config.json']) {
      await expect(access(`${root}/${sub}`)).resolves.toBeUndefined()
    }
  })
})
