/**
 * Store tests: discovery-tree CRUD, structural invariants, lineage
 * derivation, batch bookkeeping, persistence reload, the policy registry,
 * and the audit log (spec §2, §8.5).
 *
 * @module
 */

import { readFile } from 'node:fs/promises'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DreamStore, StoreError, nodeIdOf, rootIdOf } from '../src/store.ts'
import type { PolicyEvaluation } from '../src/types.ts'
import {
  cleanupTempRoots,
  makeClock,
  makeConfig,
  makeDecision,
  makeTempRoot,
  must,
} from './fixtures.ts'

afterEach(async () => {
  await cleanupTempRoots()
})

/** Fresh store on a temp dir with a deterministic clock. */
async function makeStore(): Promise<{ store: DreamStore; root: string }> {
  const root = await makeTempRoot()
  const store = new DreamStore({ config: makeConfig({ dataDir: root }), workspaceRoot: root, clock: makeClock() })
  return { store, root }
}

describe('DreamStore — rounds and nodes', () => {
  it('createRound allocates sequential ids, an open round, and exactly one root', async () => {
    const { store } = await makeStore()
    const round1 = await store.createRound('v0001', { maxRounds: 16, maxParallelism: 4 })
    const round2 = await store.createRound('v0001', { maxRounds: 16, maxParallelism: 4 })
    expect(round1.roundId).toBe('r0001')
    expect(round2.roundId).toBe('r0002')
    expect(round1.status).toBe('open')
    expect(round1.policyVersion).toBe('v0001')
    expect(round1.limits).toEqual({ maxRounds: 16, maxParallelism: 4 })
    expect(round1.endedAt).toBeNull()

    const nodes = await store.getNodes('r0001')
    expect(nodes).toHaveLength(1)
    const root = must(nodes[0])
    expect(root.kind).toBe('root')
    expect(root.parentId).toBeNull()
    expect(root.id).toBe(rootIdOf('r0001'))
    expect((await store.getNodes('r0001')).filter((node) => node.kind === 'root')).toHaveLength(1)
  })

  it('appendNodes round-trips every NodeRecord field', async () => {
    const { store } = await makeStore()
    await store.createRound('v0001', { maxRounds: 16, maxParallelism: 4 })
    const action = { summary: 'try simulated annealing', mechanism: 'anneal', tags: ['anneal', 'meta'], artifactPaths: ['a/proposal.md'], evalProgramPath: 'a/eval.py' }
    const { accepted } = await store.appendNodes('r0001', [makeDecision({
      parentId: null,
      action,
      score: 0.7,
      evaluated: true,
      valid: true,
      failClass: 'ok',
      error: null,
      deltaVsBaseline: 0.2,
      deltaVsParent: null,
      agentCalls: 2,
      wallMs: 1500,
      notes: 'promising',
    })])
    expect(accepted).toHaveLength(1)
    const node = must(accepted[0])
    expect(node.id).toBe(nodeIdOf('r0001', 1))
    expect(node.roundId).toBe('r0001')
    expect(node.kind).toBe('attempt')
    expect(node.action).toEqual(action)
    expect(node.outcome).toMatchObject({ score: 0.7, evaluated: true, valid: true, failClass: 'ok', error: null, deltaVsBaseline: 0.2 })
    expect(node.metrics).toEqual({ agentCalls: 2, wallMs: 1500 })
    expect(node.notes).toBe('promising')
    expect(node.lineage.policyVersion).toBe('v0001')
    expect(node.lineage.seq).toBe(1)
    // Clock: init's config snapshot consumes tick 0, the round start tick 1,
    // the appended node tick 2.
    expect(node.lineage.createdAt).toBe('2026-01-01T00:00:02.000Z')

    const reread = must((await store.getNodes('r0001')).find((n) => n.id === node.id))
    expect(reread).toEqual(node)
  })

  it('derives lineage: depth, branchId, seqInBranch, root-branch numbering, seq order', async () => {
    const { store } = await makeStore()
    await store.createRound('v0001', { maxRounds: 16, maxParallelism: 4 })
    const { accepted } = await store.appendNodes('r0001', [
      makeDecision({ parentId: null, action: { summary: 'a', mechanism: 'm1', tags: [], artifactPaths: [] } }),
      makeDecision({ parentId: null, action: { summary: 'b', mechanism: 'm2', tags: [], artifactPaths: [] } }),
    ])
    const [first, second] = accepted
    expect(must(first).state).toMatchObject({ depth: 1, branchId: 0, seqInBranch: 0 })
    expect(must(second).state).toMatchObject({ depth: 1, branchId: 1, seqInBranch: 0 })
    expect(must(first).lineage.seq).toBe(1)
    expect(must(second).lineage.seq).toBe(2)

    await store.appendNodes('r0001', [makeDecision({ parentId: must(first).id, score: 0.9 })])
    const nodes = await store.getNodes('r0001')
    const child = must(nodes.find((n) => n.parentId === must(first).id))
    expect(child.state).toMatchObject({ depth: 2, branchId: 0, seqInBranch: 1 })
    // Root child inherits its branch from the parent chain, not a new branch id.
    expect(child.state.branchId).toBe(must(first).state.branchId)
  })

  it('derives deltaVsParent from the parent score when the caller omits it', async () => {
    const { store } = await makeStore()
    await store.createRound('v0001', { maxRounds: 16, maxParallelism: 4 })
    const { accepted } = await store.appendNodes('r0001', [
      makeDecision({ parentId: null, score: 0.4 }),
      makeDecision({ parentId: null, score: 0, evaluated: false, valid: false, failClass: 'compile', error: 'nope' }),
    ])
    const parent = must(accepted[0])
    const unevaluatedParent = must(accepted[1])
    const { accepted: children } = await store.appendNodes('r0001', [makeDecision({ parentId: parent.id, score: 0.6, deltaVsParent: null })])
    expect(must(children[0]).outcome.deltaVsParent).toBeCloseTo(0.2, 10)
    // Unevaluated parents contribute no derived delta.
    const { accepted: unevaluatedChildren } = await store.appendNodes('r0001', [makeDecision({ parentId: unevaluatedParent.id, score: 1, deltaVsParent: null })])
    expect(must(unevaluatedChildren[0]).outcome.deltaVsParent).toBeNull()
  })

  it('records siblingCountAtDecision from the pre-batch selectable set', async () => {
    const { store } = await makeStore()
    await store.createRound('v0001', { maxRounds: 16, maxParallelism: 4 })
    const { accepted } = await store.appendNodes('r0001', [makeDecision({ parentId: null })])
    // Fresh round: selectable = {root} ⇒ 1.
    expect(must(accepted[0]).state.siblingCountAtDecision).toBe(1)
    const { accepted: second } = await store.appendNodes('r0001', [makeDecision({ parentId: null }), makeDecision({ parentId: must(accepted[0]).id })])
    // Second batch: selectable = {root, first leaf} ⇒ 2.
    expect(must(second[0]).state.siblingCountAtDecision).toBe(2)
    expect(must(second[1]).state.siblingCountAtDecision).toBe(2)
  })

  it('rejects unknown parents with a warning and skips the decision', async () => {
    const { store } = await makeStore()
    await store.createRound('v0001', { maxRounds: 16, maxParallelism: 4 })
    const { accepted, warnings } = await store.appendNodes('r0001', [
      makeDecision({ parentId: 'r0001-n999' }),
      makeDecision({ parentId: null }),
    ])
    expect(accepted).toHaveLength(1)
    expect(warnings.some((w) => w.includes('unknown parentId r0001-n999'))).toBe(true)
  })

  it('throws the hard chain-invariant error when a non-root parent gets a second child', async () => {
    const { store } = await makeStore()
    await store.createRound('v0001', { maxRounds: 16, maxParallelism: 4 })
    const { accepted } = await store.appendNodes('r0001', [makeDecision({ parentId: null })])
    const parent = must(accepted[0])
    await store.appendNodes('r0001', [makeDecision({ parentId: parent.id })])
    await expect(store.appendNodes('r0001', [makeDecision({ parentId: parent.id })]))
      .rejects.toThrow(StoreError)
    await expect(store.appendNodes('r0001', [makeDecision({ parentId: parent.id })]))
      .rejects.toThrow(/chain invariant/)
  })

  it('throws the chain-invariant error for two children of the same non-root parent within one batch', async () => {
    const { store } = await makeStore()
    await store.createRound('v0001', { maxRounds: 16, maxParallelism: 4 })
    const { accepted } = await store.appendNodes('r0001', [makeDecision({ parentId: null })])
    const parent = must(accepted[0])
    await expect(store.appendNodes('r0001', [
      makeDecision({ parentId: parent.id, score: 0.1 }),
      makeDecision({ parentId: parent.id, score: 0.2 }),
    ])).rejects.toThrow(/chain invariant/)
  })

  it('rejects (with a warning) a decision whose parent was created in the same batch', async () => {
    const { store } = await makeStore()
    await store.createRound('v0001', { maxRounds: 16, maxParallelism: 4 })
    // Node ids are deterministic: the first decision of the batch is r0001-n001.
    // A second decision referencing it cannot resolve it (batch parents are
    // resolved against pre-existing nodes only) and is rejected as unknown.
    const { accepted, warnings } = await store.appendNodes('r0001', [
      makeDecision({ parentId: null, action: { summary: 'new branch', mechanism: 'm', tags: [], artifactPaths: [] } }),
      makeDecision({ parentId: nodeIdOf('r0001', 1), score: 0.3 }),
    ])
    expect(accepted).toHaveLength(1)
    expect(warnings.some((w) => w.includes('unknown parentId r0001-n001'))).toBe(true)
    // The rejected decision left no node behind.
    expect(await store.getNodes('r0001')).toHaveLength(2)
  })

  it('warns when a batch exceeds the round parallelism W but still appends', async () => {
    const { store } = await makeStore()
    await store.createRound('v0001', { maxRounds: 16, maxParallelism: 2 })
    const { accepted, warnings } = await store.appendNodes('r0001', [
      makeDecision({ parentId: null }),
      makeDecision({ parentId: null }),
      makeDecision({ parentId: null }),
    ])
    expect(accepted).toHaveLength(3)
    expect(warnings.some((w) => w.includes('exceeds round parallelism W=2'))).toBe(true)
  })

  it('rejects appends to unknown or closed rounds (nodes immutable once written)', async () => {
    const { store } = await makeStore()
    await expect(store.appendNodes('r9999', [makeDecision({ parentId: null })])).rejects.toThrow(StoreError)
    const round = await store.createRound('v0001', { maxRounds: 16, maxParallelism: 4 })
    await store.appendNodes(round.roundId, [makeDecision({ parentId: null })])
    await store.closeRound(round.roundId)
    await expect(store.appendNodes(round.roundId, [makeDecision({ parentId: null })]))
      .rejects.toThrow(/closed; nodes are immutable/)
  })

  it('nodes.jsonl on disk is one JSON object per line', async () => {
    const { store, root } = await makeStore()
    await store.createRound('v0001', { maxRounds: 16, maxParallelism: 4 })
    await store.appendNodes('r0001', [makeDecision({ parentId: null }), makeDecision({ parentId: null })])
    const text = await readFile(path.join(root, 'trees', 'r0001', 'nodes.jsonl'), 'utf8')
    const lines = text.split('\n').filter((line) => line.trim().length > 0)
    expect(lines).toHaveLength(3)
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow()
  })
})

describe('DreamStore — batch bookkeeping and round stats', () => {
  it('recordBatch opens a new batchSizes entry per batchSeq and grows it for repeats', async () => {
    const { store } = await makeStore()
    const round = await store.createRound('v0001', { maxRounds: 16, maxParallelism: 4 })
    await store.appendNodes(round.roundId, [makeDecision({ parentId: null })])
    await store.recordBatch(round.roundId, 1, 1)
    await store.recordBatch(round.roundId, 1, 1) // incremental call for the same batch
    await store.recordBatch(round.roundId, 2, 2)
    const updated = must(await store.getRound(round.roundId))
    expect(updated.stats.decisionRounds).toBe(2)
    expect(updated.stats.batchSizes).toEqual([2, 2])
    expect(updated.batchSeqIndex).toEqual({ '1': 0, '2': 1 })
  })

  it('closeRound freezes stats: nodes, attempts, bestScore, composition, avgBatchSize', async () => {
    const { store } = await makeStore()
    const round = await store.createRound('v0001', { maxRounds: 16, maxParallelism: 4 })
    const { accepted: branchA } = await store.appendNodes(round.roundId, [
      makeDecision({ parentId: null, score: 0.4 }),
    ])
    await store.appendNodes(round.roundId, [
      makeDecision({ parentId: must(branchA[0]).id, score: 0.9 }),
      makeDecision({ parentId: null, score: 0, evaluated: false, valid: false, failClass: 'timeout', error: 'too slow' }),
    ])
    await store.recordBatch(round.roundId, 1, 1)
    await store.recordBatch(round.roundId, 2, 2)
    const closed = await store.closeRound(round.roundId, 'done')
    expect(closed.status).toBe('closed')
    expect(closed.summary).toBe('done')
    expect(closed.endedAt).not.toBeNull()
    expect(new Date(must(closed.endedAt)).getTime()).toBeGreaterThanOrEqual(new Date(closed.startedAt).getTime())
    expect(closed.stats.nodes).toBe(4)
    expect(closed.stats.attempts).toBe(3)
    expect(closed.stats.bestScore).toBe(0.9)
    expect(closed.stats.decisionRounds).toBe(2)
    expect(closed.stats.batchSizes).toEqual([1, 2])
    // composition: 2 root children = exploration; the refinement of a failed
    // parent? No — parent score 0.4 ok ⇒ exploitation; 1 exploitation + 2 exploration + 0 recovery.
    expect(closed.stats.composition).toEqual({ exploitation: 1, exploration: 2, recovery: 0 })
    expect(closed.stats.avgBatchSize).toBeCloseTo(3 / 2, 10)
  })

  it('closeRound is idempotent-hostile: double close throws', async () => {
    const { store } = await makeStore()
    const round = await store.createRound('v0001', { maxRounds: 16, maxParallelism: 4 })
    await store.closeRound(round.roundId)
    await expect(store.closeRound(round.roundId)).rejects.toThrow(/already closed/)
  })

  it('rounds with no evaluated attempts report bestScore null', async () => {
    const { store } = await makeStore()
    const round = await store.createRound('v0001', { maxRounds: 16, maxParallelism: 4 })
    await store.appendNodes(round.roundId, [makeDecision({ parentId: null, evaluated: false, valid: false, failClass: 'compile' })])
    const closed = await store.closeRound(round.roundId)
    expect(closed.stats.bestScore).toBeNull()
  })
})

describe('DreamStore — queries', () => {
  it('getNode, getSubtree, getOpenRound, listRounds behave and empty stores degrade gracefully', async () => {
    const { store } = await makeStore()
    // Empty store: every read is empty, never throws.
    expect(await store.listRoundIds()).toEqual([])
    expect(await store.listRounds()).toEqual([])
    expect(await store.getOpenRound()).toBeNull()
    expect(await store.getNodes('r0001')).toEqual([])
    expect(await store.getNode('r0001-n001')).toBeNull()
    expect(await store.getSubtree('r0001', 'r0001-n000')).toEqual([])

    const round = await store.createRound('v0001', { maxRounds: 16, maxParallelism: 4 })
    const { accepted } = await store.appendNodes(round.roundId, [
      makeDecision({ parentId: null, action: { summary: 'a', mechanism: 'm', tags: [], artifactPaths: [] } }),
    ])
    const parent = must(accepted[0])
    await store.appendNodes(round.roundId, [makeDecision({ parentId: parent.id, score: 0.8 })])

    expect(must(await store.getOpenRound()).roundId).toBe('r0001')
    expect(must(await store.getNode('r0001-n001')).id).toBe('r0001-n001')
    expect(await store.getNode('nope-n001')).toBeNull()

    const subtree = await store.getSubtree('r0001', 'r0001-n001')
    expect(subtree.map((node) => node.id)).toEqual(['r0001-n001', 'r0001-n002'])
    const full = await store.getSubtree('r0001', 'r0001-n000')
    expect(full).toHaveLength(3)
  })
})

describe('DreamStore — persistence reload', () => {
  it('a fresh store instance over the same data dir restores rounds, nodes, policies, and events losslessly', async () => {
    const { store, root } = await makeStore()
    const round = await store.createRound('v0001', { maxRounds: 16, maxParallelism: 4 })
    await store.appendNodes(round.roundId, [makeDecision({ parentId: null, score: 0.5 })])
    await store.recordBatch(round.roundId, 1, 1)
    await store.closeRound(round.roundId, 'first')
    const evaluation: PolicyEvaluation = { meanReplayScore: 1.04, perWorldScores: [{ worldId: 'r0001', score: 1.04 }], betaSweep: null }
    const { defaultPolicyDsl } = await import('../src/dreaming.ts')
    const params = defaultPolicyDsl(makeConfig())
    const v1 = await store.registerPolicy(params, 'first policy', null)
    await store.attachEvaluation(v1.version, evaluation)
    await store.setActivePolicy(v1.version, false)
    await store.logEvent('test.call', { a: 1 }, { ok: true }, v1.version)

    const reloaded = new DreamStore({ config: makeConfig({ dataDir: root }), workspaceRoot: root, clock: makeClock() })
    expect(await reloaded.listRoundIds()).toEqual(['r0001'])
    expect(await reloaded.getNodes('r0001')).toEqual(await store.getNodes('r0001'))
    expect(await reloaded.getRound('r0001')).toEqual(await store.getRound('r0001'))
    expect(await reloaded.listRounds()).toEqual(await store.listRounds())
    expect(await reloaded.getPolicy(v1.version)).toEqual(v1.version ? { ...v1, status: 'active', evaluation } : null)
    expect(await reloaded.getActivePolicyVersion()).toBe(v1.version)
    expect(await reloaded.listPolicyEntries()).toEqual(await store.listPolicyEntries())
    expect(await reloaded.readEvents()).toEqual(await store.readEvents())
    expect(await reloaded.nextRoundId()).toBe('r0002')
    expect(await reloaded.nextPolicyVersion()).toBe('v0002')
  })

  it('config.json is write-once: init() twice leaves the snapshot untouched', async () => {
    const { store, root } = await makeStore()
    await store.init()
    const configPath = path.join(root, 'config.json')
    const first = await readFile(configPath, 'utf8')
    await store.init()
    expect(await readFile(configPath, 'utf8')).toBe(first)
    const parsed = JSON.parse(first) as { config: { beta1: number } }
    expect(parsed.config.beta1).toBe(0.01)
  })
})

describe('DreamStore — policy registry', () => {
  it('registers immutable versions with monotonic ids and lineage', async () => {
    const { store } = await makeStore()
    const params = (await import('../src/dreaming.ts')).defaultPolicyDsl(makeConfig())
    const v1 = await store.registerPolicy(params, 'initial', null)
    const v2 = await store.registerPolicy({ ...params, name: 'variant' }, 'derived', v1.version)
    expect(v1.version).toBe('v0001')
    expect(v2.version).toBe('v0002')
    expect(v2.parentId).toBe('v0001')
    expect(v1.status).toBe('candidate')
    expect(v1.evaluation).toEqual({ meanReplayScore: null, perWorldScores: null, betaSweep: null })
    expect((await store.getPolicy('v0002'))?.params.name).toBe('variant')
    expect(await store.getPolicy('v9999')).toBeNull()
    expect((await store.listPolicyEntries()).map((entry) => entry.version)).toEqual(['v0001', 'v0002'])
  })

  it('setActivePolicy flips the pointer, retires the incumbent, and never touches params payloads', async () => {
    const { store } = await makeStore()
    const params = (await import('../src/dreaming.ts')).defaultPolicyDsl(makeConfig())
    const v1 = await store.registerPolicy(params, 'initial', null)
    const v2 = await store.registerPolicy({ ...params, name: 'variant' }, 'derived', v1.version)
    const paramsBefore = JSON.parse(JSON.stringify((await store.getPolicy('v0001'))?.params))

    await store.setActivePolicy(v1.version, false)
    expect(await store.getActivePolicyVersion()).toBe('v0001')
    expect((await store.getPolicy('v0001'))?.status).toBe('active')
    await store.setActivePolicy(v2.version, false)
    expect(await store.getActivePolicyVersion()).toBe('v0002')
    const entries = await store.listPolicyEntries()
    expect(must(entries.find((e) => e.version === 'v0001')).status).toBe('retired')
    expect(must(entries.find((e) => e.version === 'v0002')).status).toBe('active')
    expect((await store.getActivePolicy())?.version).toBe('v0002')
    // Params payloads never change in place — only status/evaluation bookkeeping.
    expect(JSON.parse(JSON.stringify((await store.getPolicy('v0001'))?.params))).toEqual(paramsBefore)
  })

  it('setActivePolicy enforces the no-regression guard between evaluated versions unless forced', async () => {
    const { store } = await makeStore()
    const params = (await import('../src/dreaming.ts')).defaultPolicyDsl(makeConfig())
    const v1 = await store.registerPolicy(params, 'incumbent', null)
    const v2 = await store.registerPolicy({ ...params, name: 'worse' }, 'challenger', v1.version)
    await store.attachEvaluation(v1.version, { meanReplayScore: 1.0, perWorldScores: null, betaSweep: null })
    await store.setActivePolicy(v1.version, false)
    await store.attachEvaluation(v2.version, { meanReplayScore: 0.5, perWorldScores: null, betaSweep: null })

    const rejected = await store.setActivePolicy(v2.version, false)
    expect(rejected.accepted).toBe(false)
    expect(rejected.guard).toMatchObject({ meanReplayScore: 0.5, incumbentScore: 1.0, noRegression: false, forced: false })
    expect(await store.getActivePolicyVersion()).toBe('v0001')

    const forced = await store.setActivePolicy(v2.version, true)
    expect(forced.accepted).toBe(true)
    expect(forced.guard.forced).toBe(true)
    expect(await store.getActivePolicyVersion()).toBe('v0002')
  })

  it('markPolicyStatus and attachEvaluation update bookkeeping only', async () => {
    const { store } = await makeStore()
    const params = (await import('../src/dreaming.ts')).defaultPolicyDsl(makeConfig())
    const v1 = await store.registerPolicy(params, 'x', null)
    await store.markPolicyStatus(v1.version, 'rejected')
    expect((await store.listPolicyEntries()).find((e) => e.version === 'v0001')?.status).toBe('rejected')
    expect((await store.getPolicy('v0001'))?.status).toBe('rejected')
    await store.attachEvaluation(v1.version, { meanReplayScore: 2, perWorldScores: [{ worldId: 'r0001', score: 2 }], betaSweep: [{ beta: 0, reward: 1 }] })
    const updated = must(await store.getPolicy('v0001'))
    expect(updated.evaluation.meanReplayScore).toBe(2)
    expect(updated.params).toEqual(params)
  })
})

describe('DreamStore — audit log and dreams', () => {
  it('logEvent appends JSONL rows with injected timestamps and digests; readEvents preserves order', async () => {
    const { store, root } = await makeStore()
    await store.init()
    await store.logEvent('call.one', { k: 1 }, { ok: true }, 'v0001')
    await store.logEvent('call.two', {}, {}, 'v0002')
    const events = await store.readEvents()
    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({ call: 'call.one', argsDigest: '{"k":1}', resultDigest: '{"ok":true}', policyVersion: 'v0001' })
    // Clock: init's config snapshot consumed tick 0; the two events get 1 and 2.
    expect(events[0]?.ts).toBe('2026-01-01T00:00:01.000Z')
    expect(events[1]?.call).toBe('call.two')
    expect(events[1]?.ts).toBe('2026-01-01T00:00:02.000Z')
    // A second store instance over the same dir sees the same events.
    const reloaded = new DreamStore({ config: makeConfig({ dataDir: store.root }), workspaceRoot: root, clock: makeClock() })
    expect(await reloaded.readEvents()).toHaveLength(2)
  })

  it('dream reports persist and reload; run ids increment', async () => {
    const { store } = await makeStore()
    await store.init()
    expect(await store.nextDreamRunId()).toBe('d0001')
    await store.saveDreamReport({ runId: 'd0001', ranking: [] })
    expect(await store.nextDreamRunId()).toBe('d0002')
    expect(await store.getDreamReport('d0001')).toMatchObject({ runId: 'd0001' })
    expect(await store.getDreamReport('d9999')).toBeNull()
  })
})
