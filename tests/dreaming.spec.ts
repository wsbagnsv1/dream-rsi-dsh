/**
 * Dreaming tests (spec §6): PolicyDsl validation, the deterministic
 * interpreter (selectBatch), branch trajectory views, the dream loop with a
 * hand-computed Eq. 1 score, selection/tie-breaking/guards, determinism, and
 * the optional beta sweep.
 *
 * @module
 */

import { describe, expect, it } from 'vitest'
import {
  INVALID_SCORE,
  buildBranchViews,
  defaultPolicyDsl,
  runDream,
  selectBatch,
  validatePolicyDsl,
  type DreamInput,
} from '../src/dreaming.ts'
import { buildWorld, commitReveals, initObserved, step, type ReplayWorld } from '../src/replay.ts'
import type { PolicyDsl, ReplayStopReason, WorldReplayResult } from '../src/types.ts'
import {
  attemptNode,
  fixtureNodesSingleChain,
  fixtureNodesTwoBranches,
  makeConfig,
  makeDsl,
  must,
  rootNode,
} from './fixtures.ts'

function twoBranchWorld(): ReplayWorld {
  return buildWorld('r0001', fixtureNodesTwoBranches())
}

function singleChainWorld(): ReplayWorld {
  return buildWorld('r0002', fixtureNodesSingleChain())
}

function dreamInput(overrides: Partial<DreamInput> & { candidates: DreamInput['candidates'] }): DreamInput {
  return {
    worlds: [],
    config: makeConfig(),
    runId: 'd0001',
    createdAt: '2026-01-01T00:00:00.000Z',
    sweepBetas: [],
    strictGuards: false,
    ...overrides,
  }
}

/** Earliest candidate index achieving the max mean score. */
function expectedArgmax(ranking: { candidate: number; meanScore: number }[]): number {
  let best = must(ranking[0])
  for (const entry of ranking) {
    if (entry.meanScore > best.meanScore) best = entry
  }
  return best.candidate
}

describe('validatePolicyDsl (spec §6.1 invariants)', () => {
  it('accepts the bootstrap default and a minimally valid DSL', () => {
    expect(validatePolicyDsl(defaultPolicyDsl(makeConfig())).ok).toBe(true)
    const result = validatePolicyDsl(makeDsl({ guidance: 'x'.repeat(201) }))
    expect(result.ok).toBe(true)
    expect(result.warnings.some((w) => w.includes('guidance'))).toBe(true)
  })

  it('rejects non-objects and reports every invariant violation with a reason', () => {
    expect(validatePolicyDsl(null).ok).toBe(false)
    expect(validatePolicyDsl('nope').errors).toContain('candidate must be a PolicyDsl object')

    const bad = validatePolicyDsl({
      name: '',
      W: 0,
      beta: 1.5,
      gridPlan: { branchCount: 0, refineCount: -1, reason: '' },
      portfolio: { exploitationShare: 0.8, explorationShare: 0.5, recoverySlots: 2 },
      ranking: { anchorScore: -1, parentChildGain: 0, trend: 0, recoverability: 0, remainingDepth: 0, recency: 0 },
      pruning: { repairableClasses: ['not-a-class'], hardFailClasses: [], closeAfterConsecutiveFailures: 0, minEvidenceForClosure: 0 },
      stopping: { stagnationRounds: 0, maxRoundsK2: 0.5 },
      guidance: 42,
    })
    expect(bad.ok).toBe(false)
    const errors = bad.errors.join('\n')
    for (const fragment of [
      'name must be a non-empty string',
      'W must be an integer ≥ 1',
      'beta must be a number in [0, 1]',
      'gridPlan.branchCount',
      'gridPlan.refineCount',
      'gridPlan.reason',
      'exploitationShare + explorationShare',
      'recoverySlots',
      'ranking.anchorScore',
      'unknown failClass "not-a-class"',
      'closeAfterConsecutiveFailures',
      'minEvidenceForClosure',
      'stagnationRounds',
      'maxRoundsK2',
      'guidance must be a string',
    ]) {
      expect(errors).toContain(fragment)
    }
  })

  it('validates the optional novel descriptor', () => {
    expect(validatePolicyDsl(makeDsl({ novel: { mechanism: '', tags: ['x'], summary: 's' } })).ok).toBe(false)
    expect(validatePolicyDsl(makeDsl({ novel: { mechanism: 'm', tags: ['x'], summary: '' } })).ok).toBe(false)
    const badTags = makeDsl() as unknown as Record<string, unknown>
    badTags.novel = { mechanism: 'm', tags: 'nope', summary: 's' }
    expect(validatePolicyDsl(badTags).ok).toBe(false)
    expect(validatePolicyDsl(makeDsl({ novel: { mechanism: 'm', tags: [], summary: 's' } })).ok).toBe(true)
  })
})

describe('defaultPolicyDsl — bootstrap policy', () => {
  it('is valid, balanced, and derives maxRoundsK2 from the config', () => {
    const dsl = defaultPolicyDsl(makeConfig({ maxReplayRounds: 32 }))
    const validation = validatePolicyDsl(dsl)
    expect(validation.ok).toBe(true)
    expect(dsl.name).toBe('bootstrap-balanced')
    expect(dsl.W).toBe(4)
    expect(dsl.beta).toBe(0.6) // Listing 2 cross-cycle rule: insufficient history → 0.6
    expect(dsl.stopping.maxRoundsK2).toBe(32)
    expect(dsl.pruning.repairableClasses).toContain('compile')
    expect(dsl.pruning.hardFailClasses).toEqual([])
    expect(dsl.guidance).toBe('')
  })
})

describe('buildBranchViews — trajectory reconstruction', () => {
  it('reconstructs chains with anchors, trend, and failure runs from the revealed prefix', () => {
    const world = twoBranchWorld()
    const observed = initObserved(world)
    // [root] reveals n001; [n001] reveals its chain child n002; [root] again
    // opens the second branch (n003) — one branch per root selection.
    for (const batch of [['r0001-n000'], ['r0001-n001'], ['r0001-n000']]) {
      commitReveals(observed, batch, step(world, observed, batch, null).revealed)
    }
    const views = buildBranchViews(world, observed.revealed)
    expect(views.map((view) => view.branchId)).toEqual([0, 1])

    const branch0 = must(views.find((view) => view.branchId === 0))
    expect(branch0.chain.map((node) => node.id)).toEqual(['r0001-n001', 'r0001-n002'])
    expect(branch0.frontier?.id).toBe('r0001-n002')
    expect(branch0.bestAnchor).toBe(0.9)
    expect(branch0.trend).toBeCloseTo(0.5, 10)
    expect(branch0.consecutiveFailures).toBe(0)
    expect(branch0.attempts).toBe(2)
    expect(branch0.openedAtSeq).toBe(1)

    const branch1 = must(views.find((view) => view.branchId === 1))
    expect(branch1.chain.map((node) => node.id)).toEqual(['r0001-n003'])
    expect(branch1.bestAnchor).toBe(0.8)
  })

  it('counts trailing consecutive failures (unevaluated counts as failure)', () => {
    // Chain root → f1 (runtime failure) → f2 (unevaluated).
    const root = rootNode('r0003')
    const f1 = attemptNode({ id: 'r0003-n001', roundId: 'r0003', parentId: root.id, seq: 1, depth: 1, branchId: 0, seqInBranch: 0, score: 0, evaluated: true, failClass: 'runtime', error: 'boom' })
    const f2 = attemptNode({ id: 'r0003-n002', roundId: 'r0003', parentId: f1.id, seq: 2, depth: 2, branchId: 0, seqInBranch: 1, score: 0, evaluated: false, failClass: 'ok' })
    const world = buildWorld('r0003', [root, f1, f2])
    const observed = initObserved(world)
    for (const batch of [['r0003-n000'], ['r0003-n001']]) {
      commitReveals(observed, batch, step(world, observed, batch, null).revealed)
    }
    const views = buildBranchViews(world, observed.revealed)
    expect(views).toHaveLength(1)
    expect(must(views[0]).consecutiveFailures).toBe(2)
    expect(must(views[0]).bestAnchor).toBeNull()
    expect(must(views[0]).lastFailureClass).toBe('ok') // unevaluated f2: failClass ok but isFailure
  })

  it('unrevealed nodes never appear in views (prefix-only)', () => {
    const world = twoBranchWorld()
    const observed = initObserved(world)
    expect(buildBranchViews(world, observed.revealed)).toEqual([])
  })
})

describe('selectBatch — deterministic interpreter (spec §6.1)', () => {
  it('composes batches within W and never batches a parent with its child', () => {
    const world = twoBranchWorld()
    const observed = initObserved(world)
    const dsl = makeDsl()
    const batch = selectBatch(dsl, world, observed.revealed)
    expect(batch.length).toBeGreaterThan(0)
    expect(batch.length).toBeLessThanOrEqual(dsl.W)
    const rootChildIds = world.rootChildren.map((node) => node.id)
    if (batch.includes(world.rootId)) {
      expect(batch.some((id) => rootChildIds.includes(id))).toBe(false)
    }
    expect(new Set(batch).size).toBe(batch.length)
  })

  it('is deterministic: identical inputs yield identical batches', () => {
    const world = twoBranchWorld()
    const observed = initObserved(world)
    const dsl = makeDsl()
    expect(selectBatch(dsl, world, observed.revealed)).toEqual(selectBatch(dsl, world, observed.revealed))
  })

  it('caps the batch at W=1 (serial policy)', () => {
    const world = twoBranchWorld()
    const observed = initObserved(world)
    const batch = selectBatch(makeDsl({ W: 1 }), world, observed.revealed)
    expect(batch).toHaveLength(1)
  })

  it('stops (empty batch) when the grid budget is exhausted and nothing is legal', () => {
    const world = singleChainWorld()
    const dsl = makeDsl({
      W: 4,
      gridPlan: { branchCount: 1, refineCount: 1, reason: '1x1 grid' },
      portfolio: { exploitationShare: 1, explorationShare: 0, recoverySlots: 0 },
      ranking: { anchorScore: 0, parentChildGain: 0, trend: 0, recoverability: 0, remainingDepth: 0, recency: 0 },
      pruning: { repairableClasses: ['compile'], hardFailClasses: [], closeAfterConsecutiveFailures: 3, minEvidenceForClosure: 2 },
      stopping: { stagnationRounds: 4, maxRoundsK2: 64 },
    })
    const observed = initObserved(world)
    // Round 0: root opens (recorded branch), revealing n001.
    const batch0 = selectBatch(dsl, world, observed.revealed)
    expect(batch0).toEqual(['r0002-n000'])
    commitReveals(observed, batch0, step(world, observed, batch0, null).revealed)
    // Round 1: the only legal move is refining n001 (weights 0, root budget spent).
    const batch1 = selectBatch(dsl, world, observed.revealed)
    expect(batch1).toEqual(['r0002-n001'])
    commitReveals(observed, batch1, step(world, observed, batch1, null).revealed)
    // Round 2: n002 at refineCount limit, root budget spent → stop.
    expect(selectBatch(dsl, world, observed.revealed)).toEqual([])
  })

  it('a valid DSL always finds a candidate on the first round (root budget ≥ 1 branch)', () => {
    for (const world of [twoBranchWorld(), singleChainWorld()]) {
      const observed = initObserved(world)
      expect(selectBatch(makeDsl(), world, observed.revealed).length).toBeGreaterThan(0)
    }
  })
})

describe('runDream — Eq. 1 scoring, selection, guards (spec §6.2, §6.3)', () => {
  it('scores a hand-computable episode exactly (quality − β₁·N + β₂·bonus/max(1,k))', () => {
    const world = singleChainWorld()
    const dsl = makeDsl({
      W: 4,
      gridPlan: { branchCount: 1, refineCount: 1, reason: '1x1 grid' },
      portfolio: { exploitationShare: 1, explorationShare: 0, recoverySlots: 0 },
      ranking: { anchorScore: 0, parentChildGain: 0, trend: 0, recoverability: 0, remainingDepth: 0, recency: 0 },
      pruning: { repairableClasses: ['compile'], hardFailClasses: [], closeAfterConsecutiveFailures: 3, minEvidenceForClosure: 2 },
      stopping: { stagnationRounds: 4, maxRoundsK2: 64 },
    })
    const report = runDream(dreamInput({ candidates: [{ dsl, version: 'v0001' }], worlds: [world] }))
    expect(report.historySize).toBe(1)
    expect(report.normalization).toEqual({ min: 0.6, max: 1.0, enabled: true })
    const entry = must(report.ranking[0])
    const perWorld: WorldReplayResult = must(entry.perWorld[0])
    // Trajectory: [root] reveals n001 (0.6); [n001] reveals n002 (1.0); exhausted.
    expect(perWorld.rounds).toBe(2)
    expect(perWorld.reveals).toBe(2)
    expect(perWorld.batchSizes).toEqual([1, 1])
    expect(perWorld.stopReason).toBe('exhausted' satisfies ReplayStopReason)
    expect(perWorld.terms.quality).toBeCloseTo(1, 10) // (1.0 − 0.6) / 0.4
    expect(perWorld.terms.cost).toBeCloseTo(0.02, 10) // β₁ · N
    expect(perWorld.terms.parallelism).toBeCloseTo(0.05, 10) // β₂ · 2 / 2
    expect(perWorld.score).toBeCloseTo(1.03, 10)
    expect(entry.meanScore).toBeCloseTo(1.03, 10)
    expect(entry.version).toBe('v0001')
    expect(entry.invalid).toBeNull()
    expect(report.selectedCandidate).toBe(0)
    expect(report.selectedParams).toEqual(dsl)
    expect(report.guards).toEqual({ noRegression: true, incumbentScore: entry.meanScore })
    expect(entry.diagnostics.estOutcomeFraction).toBe(0)
  })

  it('auto-respects candidate 0 as incumbent and never regresses below it', () => {
    const world = twoBranchWorld()
    const serial = makeDsl({ name: 'serial', W: 1 })
    const wide = makeDsl({ name: 'wide', W: 2 })
    const report = runDream(dreamInput({ candidates: [{ dsl: serial, version: 'v0001' }, { dsl: wide, version: null }], worlds: [world] }))
    expect(report.ranking).toHaveLength(2)
    expect(report.ranking[0]?.candidate).toBe(0)
    const selected = must(report.ranking.find((entry) => entry.candidate === report.selectedCandidate))
    expect(selected.meanScore).toBeGreaterThanOrEqual(must(report.ranking[0]).meanScore - 1e-9)
    expect(report.guards.noRegression).toBe(true)
    expect(report.guards.incumbentScore).toBe(must(report.ranking[0]).meanScore)
  })

  it('breaks score ties toward the earliest candidate', () => {
    const world = singleChainWorld()
    const a = makeDsl({ name: 'twin-a' })
    const b = makeDsl({ name: 'twin-b' })
    // Identical behavior ⇒ identical scores; the earlier candidate must win.
    const report = runDream(dreamInput({
      candidates: [
        { dsl: makeDsl({ name: 'incumbent', W: 1 }), version: 'v0001' },
        { dsl: a, version: null },
        { dsl: b, version: null },
      ],
      worlds: [world],
    }))
    const scores = report.ranking.map((entry) => ({ candidate: entry.candidate, meanScore: entry.meanScore }))
    const twinA = must(scores.find((s) => s.candidate === 1))
    const twinB = must(scores.find((s) => s.candidate === 2))
    expect(twinA.meanScore).toBe(twinB.meanScore)
    expect(report.selectedCandidate).toBe(expectedArgmax(scores))
    if (twinA.meanScore > must(scores.find((s) => s.candidate === 0)).meanScore) {
      expect(report.selectedCandidate).toBe(1)
    }
  })

  it('scores invalid DSL candidates −∞ with a reason and never selects them', () => {
    const world = twoBranchWorld()
    const report = runDream(dreamInput({
      candidates: [
        { dsl: makeDsl({ name: 'incumbent' }), version: 'v0001' },
        { dsl: { name: 'broken', W: 0 } as unknown as PolicyDsl, version: null },
      ],
      worlds: [world],
    }))
    const invalid = must(report.ranking.find((entry) => entry.candidate === 1))
    expect(invalid.meanScore).toBe(INVALID_SCORE)
    expect(invalid.invalid).toMatch(/invalid PolicyDsl/)
    expect(invalid.perWorld).toEqual([])
    expect(report.selectedCandidate).toBe(0)
    expect(report.selectedName).toBe('incumbent')
  })

  it('strictGuards disqualify never-batching policies with INVALID_SCORE (spec §6.3.4)', () => {
    const world = twoBranchWorld()
    const serial = makeDsl({ name: 'serial', W: 1 })
    const lenient = runDream(dreamInput({ candidates: [{ dsl: serial, version: null }], worlds: [world], strictGuards: false }))
    const lenientEntry = must(lenient.ranking[0])
    expect(lenientEntry.invalid).toBeNull()
    expect(lenientEntry.meanScore).toBeGreaterThan(INVALID_SCORE)
    expect(lenientEntry.diagnostics.neverBatched).toBe(true)

    const strict = runDream(dreamInput({ candidates: [{ dsl: serial, version: null }], worlds: [world], strictGuards: true }))
    const strictEntry = must(strict.ranking[0])
    // strictGuards disqualification follows the same path as illegal batches:
    // the entry is marked invalid AND forced to INVALID_SCORE, so argmax
    // selection can never pick a degenerate candidate (spec §6.3.4).
    expect(strictEntry.invalid).toMatch(/degenerate behavior: never-batched/)
    expect(strictEntry.meanScore).toBe(INVALID_SCORE)
    expect(strict.selectedCandidate).toBe(0) // single-candidate run still selects it

    // The disqualification is consequential: a degenerate challenger loses to
    // a healthy incumbent even when it would have scored higher unguarded.
    const guarded = runDream(dreamInput({
      candidates: [
        { dsl: makeDsl({ name: 'incumbent', W: 1 }), version: 'v0001' },
        { dsl: serial, version: null },
      ],
      worlds: [world],
      strictGuards: true,
    }))
    expect(must(guarded.ranking.find((entry) => entry.candidate === 1)).meanScore).toBe(INVALID_SCORE)
    expect(guarded.selectedCandidate).toBe(0)
    expect(guarded.selectedName).toBe('incumbent')
  })

  it('produces a well-formed report for an empty world pool', () => {
    const report = runDream(dreamInput({ candidates: [{ dsl: makeDsl(), version: null }], worlds: [] }))
    expect(report.historySize).toBe(0)
    expect(report.ranking).toHaveLength(1)
    const entry = must(report.ranking[0])
    expect(entry.meanScore).toBe(0)
    expect(entry.perWorld).toEqual([])
    expect(report.normalization).toEqual({ min: 0, max: 0, enabled: false })
    expect(entry.diagnostics.neverBatched).toBe(false)
    expect(entry.diagnostics.singleBranch).toBe(false)
    expect(entry.diagnostics.stopsImmediately).toBe(false)
  })

  it('is byte-deterministic: identical inputs produce deep-identical reports', () => {
    const worlds = [twoBranchWorld(), singleChainWorld()]
    const candidates = [
      { dsl: makeDsl({ name: 'incumbent' }), version: 'v0001' },
      { dsl: makeDsl({ name: 'wide', W: 2, beta: 0.8 }), version: null },
      { dsl: makeDsl({ name: 'novel-ish', W: 2, novel: { mechanism: 'anneal', tags: ['anneal'], summary: 'anneal harder' } }), version: null },
    ]
    const first = runDream(dreamInput({ candidates, worlds }))
    const second = runDream(dreamInput({ candidates, worlds }))
    expect(second).toEqual(first)
    // Also identical across a differently-built but content-identical world pool.
    const rebuilt = [buildWorld('r0001', fixtureNodesTwoBranches()), buildWorld('r0002', fixtureNodesSingleChain())]
    expect(runDream(dreamInput({ candidates, worlds: rebuilt }))).toEqual(first)
  })

  it('logs per-world terms separately and reports estimated-outcome fractions', () => {
    const worlds = [twoBranchWorld()]
    const report = runDream(dreamInput({
      candidates: [{ dsl: makeDsl({ name: 'incumbent' }), version: 'v0001' }],
      worlds,
    }))
    const entry = must(report.ranking[0])
    for (const world of entry.perWorld) {
      expect(Object.keys(world.terms).sort()).toEqual(['cost', 'parallelism', 'quality'])
      expect(world.estOutcomeFraction).toBeGreaterThanOrEqual(0)
      expect(world.estOutcomeFraction).toBeLessThanOrEqual(1)
      expect(['empty-batch', 'round-cap', 'exhausted', 'invalid']).toContain(world.stopReason)
    }
  })

  it('runs the optional deterministic beta sweep (spec §6.4)', () => {
    const world = twoBranchWorld()
    const report = runDream(dreamInput({
      candidates: [{ dsl: makeDsl({ name: 'incumbent' }), version: 'v0001' }],
      worlds: [world],
      sweepBetas: [0, 0.6, 1],
    }))
    const entry = must(report.ranking[0])
    expect(entry.betaSweep).not.toBeNull()
    expect(must(entry.betaSweep).map((point) => point.beta)).toEqual([0, 0.6, 1])
    for (const point of must(entry.betaSweep)) {
      expect(Number.isFinite(point.reward)).toBe(true)
    }
    const again = runDream(dreamInput({ candidates: [{ dsl: makeDsl({ name: 'incumbent' }), version: 'v0001' }], worlds: [world], sweepBetas: [0, 0.6, 1] }))
    expect(must(again.ranking[0]).betaSweep).toEqual(entry.betaSweep)
  })
})
