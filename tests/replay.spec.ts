/**
 * Replay simulator tests (spec §4, §5): world indexing, the paper's `Child`
 * transition, novel-action estimation (RCO), Eq. 1 support helpers, and the
 * purity/determinism contract. All fixtures are hand-built `NodeRecord`
 * trees — no store, no clock, no fs.
 *
 * @module
 */

import { describe, expect, it } from 'vitest'
import {
  actionSimilarity,
  batchDiversity,
  buildCorpus,
  buildWorld,
  checkBatch,
  checkBatchRecords,
  commitReveals,
  computeNormalization,
  cosineTf,
  docTerms,
  estimateOutcome,
  initObserved,
  isExhausted,
  jaccard,
  normalizeScore,
  pessimisticPrior,
  step,
  structuralSimilarity,
  tokenize,
  type EstimateContext,
  type ReplayWorld,
} from '../src/replay.ts'
import type { NodeRecord, PluginConfig, PolicyDsl } from '../src/types.ts'
import {
  attemptNode,
  fixtureNodesSingleChain,
  fixtureNodesTwoBranches,
  makeConfig,
  makeDsl,
  must,
  rootNode,
} from './fixtures.ts'

/** Build the two-branch fixture world. */
function twoBranchWorld(): ReplayWorld {
  return buildWorld('r0001', fixtureNodesTwoBranches())
}

/** EstimateContext over one world with default config/DSL (RCO on per the fixture). */
function estFor(world: ReplayWorld, pool: readonly ReplayWorld[] = [world], dsl: PolicyDsl = makeDsl(), config: PluginConfig = makeConfig({ estimate: 'rco' })): EstimateContext {
  return { world, pool, config, dsl, estimate: config.estimate }
}

describe('buildWorld — immutable world index (spec §4.3)', () => {
  it('indexes nodes, sorts root children by lineage.seq regardless of input order', () => {
    const nodes = fixtureNodesTwoBranches()
    // Hand the nodes out of seq order; the index must restore creation order.
    const shuffled = [must(nodes[3]), must(nodes[1]), must(nodes[0]), must(nodes[2])]
    const world = buildWorld('r0001', shuffled)
    expect(world.rootId).toBe('r0001-n000')
    expect(world.rootChildren.map((node) => node.id)).toEqual(['r0001-n001', 'r0001-n003'])
    expect(world.nodeById.size).toBe(4)
    expect(world.childOf.get('r0001-n001')).toBe('r0001-n002')
    // The root itself maps to its first recorded child (step() never consults
    // childOf for the root — the root rule is one branch per selection).
    expect(world.childOf.get('r0001-n000')).toBe('r0001-n001')
    expect(world.branchIds).toEqual([0, 1])
  })

  it('computes score stats over evaluated attempts and a corpus over action texts', () => {
    const world = twoBranchWorld()
    expect(world.scoreStats).toMatchObject({ min: 0.4, max: 0.9 })
    expect(world.scoreStats.values).toEqual([0.4, 0.9, 0.8])
    expect(world.corpus.docCount).toBe(3) // three attempt action documents
  })

  it('an empty tree (root only) yields empty stats and no branches', () => {
    const world = buildWorld('r0000', [rootNode('r0000')])
    expect(world.rootChildren).toEqual([])
    expect(world.branchIds).toEqual([])
    expect(world.scoreStats).toMatchObject({ min: 0, max: 0 })
    expect(world.scoreStats.values).toEqual([])
  })
})

describe('replay transition — the paper\'s Child rule (spec §4.1)', () => {
  it('initObserved starts from {root}; isExhausted false until every node is revealed', () => {
    const world = twoBranchWorld()
    const observed = initObserved(world)
    expect(observed.revealed.size).toBe(1)
    expect(observed.revealed.has('r0001-n000')).toBe(true)
    expect(isExhausted(world, observed)).toBe(false)
  })

  it('selecting the root reveals the earliest-created unrevealed branch start, one per step', () => {
    const world = twoBranchWorld()
    const est = estFor(world)
    let observed = initObserved(world)

    const first = step(world, observed, ['r0001-n000'], est)
    expect(first.revealed.map((r) => r.node.id)).toEqual(['r0001-n001'])
    expect(first.revealed.every((r) => !r.estimated)).toBe(true)
    commitReveals(observed, ['r0001-n000'], first.revealed)

    const second = step(world, observed, ['r0001-n000'], est)
    expect(second.revealed.map((r) => r.node.id)).toEqual(['r0001-n003'])
    commitReveals(observed, ['r0001-n000'], second.revealed)

    // Both root children revealed, no grid budget: the root yields nothing.
    const third = step(world, observed, ['r0001-n000'], null)
    expect(third.revealed).toEqual([])
  })

  it('refining a leaf reveals its unique recorded chain child; re-selecting yields nothing', () => {
    const world = twoBranchWorld()
    const observed = initObserved(world)

    const reveal = step(world, observed, ['r0001-n001'], null)
    expect(reveal.revealed.map((r) => r.node.id)).toEqual(['r0001-n002'])
    commitReveals(observed, ['r0001-n001'], reveal.revealed)

    // The recorded child is already revealed; with no estimator the leaf is
    // exhausted and yields nothing.
    expect(step(world, observed, ['r0001-n001'], null).revealed).toEqual([])
  })

  it('isExhausted flips true only when every recorded node is revealed', () => {
    const world = twoBranchWorld()
    const est = estFor(world)
    const observed = initObserved(world)
    for (const batch of [['r0001-n000'], ['r0001-n001'], ['r0001-n003']]) {
      const { revealed } = step(world, observed, batch, est)
      commitReveals(observed, batch, revealed)
    }
    expect(isExhausted(world, observed)).toBe(true)
    expect(step(world, observed, ['r0001-n002'], null).revealed).toEqual([])
  })

  it('unknown batch ids are skipped silently', () => {
    const world = twoBranchWorld()
    const observed = initObserved(world)
    const { revealed } = step(world, observed, ['r0001-nope'], null)
    expect(revealed).toEqual([])
  })

  it('step is pure: the observed prefix is unchanged until commitReveals folds results in', () => {
    const world = twoBranchWorld()
    const observed = initObserved(world)
    const before = observed.revealed.size
    step(world, observed, ['r0001-n000', 'r0001-n001'], estFor(world))
    expect(observed.revealed.size).toBe(before)
    expect(observed.rounds).toBe(0)
    expect(observed.reveals).toBe(0)
  })
})

// OPT-IN BLOCK: every test here runs the RCO estimator explicitly
// (`estFor` pins `estimate: 'rco'`). The v0.2 default is `estimate: 'off'`
// (strictly on-manifold replay) — the default-mode identity fences live in
// v02-fences.spec.ts.
describe('novel (off-manifold) actions — RCO estimation (spec §5.3, opt-in estimate: "rco")', () => {
  it('exhausted branches estimate a synthetic reveal when the grid plan budgets the move', () => {
    const world = twoBranchWorld()
    const dsl = makeDsl({ gridPlan: { branchCount: 4, refineCount: 4, reason: 'test grid' } })
    const est = estFor(world, [world], dsl)
    const observed = initObserved(world)
    for (const batch of [['r0001-n000'], ['r0001-n000']]) {
      commitReveals(observed, batch, step(world, observed, batch, est).revealed)
    }
    // Both recorded branches open; a further root selection is a novel open.
    const { revealed } = step(world, observed, ['r0001-n000'], est)
    expect(revealed).toHaveLength(1)
    const reveal = must(revealed[0])
    expect(reveal.estimated).toBe(true)
    expect(reveal.node.id).toBe('r0001~est-1')
    expect(reveal.node.lineage.policyVersion).toBe('replay-estimate')
    expect(reveal.node.lineage.seq).toBe(-1)
    expect(reveal.node.kind).toBe('attempt')
    expect(reveal.node.parentId).toBe('r0001-n000')
    expect(reveal.node.state.depth).toBe(1)
  })

  it('novel branch opens are blocked once the grid branch budget is spent', () => {
    const world = twoBranchWorld()
    const dsl = makeDsl({ gridPlan: { branchCount: 2, refineCount: 4, reason: 'tight width' } })
    const est = estFor(world, [world], dsl)
    const observed = initObserved(world)
    for (const batch of [['r0001-n000'], ['r0001-n000']]) {
      commitReveals(observed, batch, step(world, observed, batch, est).revealed)
    }
    expect(step(world, observed, ['r0001-n000'], est).revealed).toEqual([])
  })

  it('novel refinements respect the per-chain refine budget', () => {
    const world = buildWorld('r0002', fixtureNodesSingleChain())
    const est = estFor(world, [world], makeDsl({ gridPlan: { branchCount: 1, refineCount: 1, reason: 'shallow' } }))
    const observed = initObserved(world)
    // Reveal n001 and n002 (the whole chain).
    for (const batch of [['r0002-n000'], ['r0002-n001']]) {
      commitReveals(observed, batch, step(world, observed, batch, est).revealed)
    }
    // n002 sits at seqInBranch 1 ≥ refineCount 1 → no novel refinement.
    expect(step(world, observed, ['r0002-n002'], est).revealed).toEqual([])
  })

  it('a novel action close to recorded history blends recorded outcomes at medium confidence', () => {
    const world = twoBranchWorld()
    const estimate = estimateOutcome(
      estFor(world),
      null,
      'root-open',
      { summary: 'tune gpu kernel blocks', mechanism: 'gpu-kernel', tags: ['cuda'] },
      1,
    )
    expect(estimate.abstained).toBe(false)
    expect(estimate.confidence).toBe('medium')
    expect(estimate.sMax).toBeGreaterThanOrEqual(0.45)
    expect(estimate.usedAnalogues).toBeGreaterThanOrEqual(1)
    // Blended recorded outcomes minus the novelty penalty stay in range and
    // never exceed the best analogue's recorded score.
    expect(estimate.score).toBeGreaterThan(0.4)
    expect(estimate.score).toBeLessThanOrEqual(0.8)
  })

  it('a novel action history cannot vouch for abstains to the pessimistic prior (confidence none)', () => {
    const world = twoBranchWorld()
    const estimate = estimateOutcome(
      estFor(world),
      must(world.nodeById.get('r0001-n002')),
      'refine',
      { summary: 'zzz qqq xyzzy plugh', mechanism: 'qqq-zzz', tags: ['qqq'] },
      3,
    )
    expect(estimate.abstained).toBe(true)
    expect(estimate.confidence).toBe('none')
    expect(estimate.usedAnalogues).toBe(0)
    // Recorded evaluated scores are 0.4, 0.9, 0.8 → 25th percentile ≈ 0.6.
    expect(estimate.score).toBeCloseTo(0.6, 10)
  })

  it('estimateOutcome is deterministic and does not mutate its inputs', () => {
    const world = twoBranchWorld()
    const est = estFor(world)
    const nodesBefore = JSON.stringify(world.nodes)
    const a = estimateOutcome(est, null, 'root-open', { summary: 'anneal the schedule', mechanism: 'anneal', tags: ['anneal'] }, 1)
    const b = estimateOutcome(est, null, 'root-open', { summary: 'anneal the schedule', mechanism: 'anneal', tags: ['anneal'] }, 1)
    expect(a).toEqual(b)
    expect(JSON.stringify(world.nodes)).toBe(nodesBefore)
  })
})

describe('pessimisticPrior — 25th percentile with linear interpolation', () => {
  it('interpolates deterministically', () => {
    expect(pessimisticPrior([0, 0.1, 0.8, 0.9])).toBeCloseTo(0.075, 10)
    expect(pessimisticPrior([0.4, 0.9, 0.8])).toBeCloseTo(0.6, 10)
    expect(pessimisticPrior([0.5])).toBe(0.5)
    expect(pessimisticPrior([])).toBe(0)
  })
})

describe('batch legality gates (spec §6.3.3)', () => {
  it('checkBatch rejects duplicates and over-W batches, accepts legal ones', () => {
    expect(checkBatch(['a', 'a'], 4)).toMatch(/duplicate/)
    expect(checkBatch(['a', 'b', 'c'], 2)).toMatch(/exceeds W=2/)
    expect(checkBatch(['a', 'b'], 2)).toBeNull()
    expect(checkBatch([], 2)).toBeNull()
  })

  it('checkBatchRecords additionally rejects parent+child pairs', () => {
    const world = twoBranchWorld()
    const observed = initObserved(world)
    expect(checkBatchRecords(world, observed, ['r0001-n000', 'r0001-n001'], 4)).toMatch(/parent and child/)
    expect(checkBatchRecords(world, observed, ['r0001-n001', 'r0001-n003'], 4)).toBeNull()
    expect(checkBatchRecords(world, observed, ['r0001-n001', 'r0001-n001'], 4)).toMatch(/duplicate/)
  })
})

describe('Eq. 1 support — normalization and diversity (spec §5.2, §5.3 step 5, §8.4)', () => {
  it('computeNormalization unions recorded scores; normalizeScore handles the degenerate span', () => {
    const world = twoBranchWorld()
    const norm = computeNormalization([world], true)
    expect(norm).toEqual({ enabled: true, min: 0.4, max: 0.9 })
    expect(normalizeScore(norm, 0.4)).toBe(0)
    expect(normalizeScore(norm, 0.9)).toBe(1)
    expect(normalizeScore(norm, 0.65)).toBeCloseTo(0.5, 10)
    expect(normalizeScore({ enabled: true, min: 0.5, max: 0.5 }, 0.5)).toBe(0)
    expect(normalizeScore({ enabled: false, min: 0, max: 0 }, 42)).toBe(42)
    expect(computeNormalization([world], false).enabled).toBe(false)
    expect(computeNormalization([], true)).toEqual({ enabled: false, min: 0, max: 0 })
  })

  it('structuralSimilarity weights depth, parent, and role (0.5/0.3/0.2)', () => {
    const anchor = { depth: 1, parentId: 'p1', role: 'refine' as const }
    expect(structuralSimilarity(anchor, { ...anchor })).toBe(1)
    const diff = structuralSimilarity(
      anchor,
      { depth: 3, parentId: 'p2', role: 'refine' },
    )
    expect(diff).toBeCloseTo(0.5 * Math.exp(-1) + 0.2, 10)
  })

  it('actionSimilarity is deterministic and maximal for identical descriptors and anchors', () => {
    const world = twoBranchWorld()
    const a = { descriptor: { summary: 'tune gpu kernel blocks', mechanism: 'gpu-kernel', tags: ['cuda'] }, anchor: { depth: 1, parentId: null, role: 'root-open' as const } }
    // Identical text + tags, but the recorded analogue hangs off the root while
    // the novel action has parent null → structural 0.5·1 + 0.3·0 + 0.2·1 = 0.7
    // ⇒ sim = 0.55·1 + 0.25·1 + 0.2·0.7 = 0.94.
    const nearIdentical = actionSimilarity(a, { descriptor: a.descriptor, anchor: { depth: 1, parentId: 'r0001-n000', role: 'root-open' } }, world.corpus)
    expect(nearIdentical).toBeCloseTo(0.94, 10)
    const b = { descriptor: { summary: 'zzz qqq', mechanism: 'qqq-zzz', tags: ['qqq'] }, anchor: { depth: 3, parentId: null, role: 'refine' as const } }
    expect(actionSimilarity(a, b, world.corpus)).toBeLessThan(0.4)
  })

  it('batchDiversity: singletons are fully diverse; duplicates contribute nothing', () => {
    const corpus = buildCorpus(['x y z', 'x y z'])
    const item = { descriptor: { summary: 'same same', mechanism: 'same', tags: ['s'] }, anchor: { depth: 1, parentId: null, role: 'root-open' as const } }
    expect(batchDiversity([item], corpus)).toBe(1)
    expect(batchDiversity([item, { ...item }], corpus)).toBe(0)
    const other = { descriptor: { summary: 'other thing entirely', mechanism: 'other', tags: ['o'] }, anchor: { depth: 2, parentId: 'p', role: 'refine' as const } }
    const diverse = batchDiversity([item, other], corpus)
    expect(diverse).toBeGreaterThan(0.5)
    expect(diverse).toBeLessThanOrEqual(1)
  })
})

describe('text similarity primitives (spec §5.3 step 2)', () => {
  it('tokenize lowercases, splits on non-alphanumerics, and drops the 33-word stoplist', () => {
    expect(tokenize('Anneal the Schedule! v2')).toEqual(['anneal', 'schedule', 'v2'])
    expect(tokenize('the and of')).toEqual([])
    expect(tokenize('')).toEqual([])
    // The stoplist has exactly 33 members (spec fixes the size).
    expect(new Set(tokenize('a an the and or but if then else when at by for with from to of in on is are was were be been being it its this that these those as')).size).toBe(0)
  })

  it('docTerms unites word tokens with character 3-grams; cosineTf is deterministic', () => {
    const terms = docTerms('abcd')
    expect(terms.get('abcd')).toBe(1)
    expect(terms.get('abc')).toBe(1)
    expect(terms.get('bcd')).toBe(1)
    const corpus = buildCorpus(['abcd', 'zzzz'])
    const v1 = docTerms('abcd')
    expect(cosineTf(v1, docTerms('abcd'), corpus)).toBeCloseTo(1, 10)
    expect(cosineTf(v1, docTerms('zzzz'), corpus)).toBe(0)
    expect(cosineTf(new Map(), docTerms('abcd'), corpus)).toBe(0)
  })

  it('jaccard treats two empty tag sets as identical', () => {
    expect(jaccard([], [])).toBe(1)
    expect(jaccard(['a'], ['a'])).toBe(1)
    expect(jaccard(['a'], ['b'])).toBe(0)
    expect(jaccard(['a', 'b'], ['b', 'c'])).toBeCloseTo(1 / 3, 10)
  })
})

describe('commitReveals — observed-prefix bookkeeping (spec §5.3 estimated bookkeeping)', () => {
  function recordingNode(id: string, score: number, branchId: number): NodeRecord {
    return attemptNode({ id, roundId: 'r0001', parentId: 'r0001-n000', seq: 1, depth: 1, branchId, seqInBranch: 0, score })
  }

  it('counts reveals, tracks bestQuality, rounds, batch sizes, and branch count', () => {
    const world = twoBranchWorld()
    const observed = initObserved(world)
    commitReveals(observed, ['r0001-n000'], [{ node: must(world.nodeById.get('r0001-n001')), estimated: false, confidence: null }])
    expect(observed.reveals).toBe(1)
    expect(observed.bestQuality).toBe(0.4)
    expect(observed.rounds).toBe(1)
    expect(observed.batchSizes).toEqual([1])
    expect(observed.branchCount).toBe(1)
    commitReveals(observed, ['r0001-n000', 'r0001-n001'], [
      { node: recordingNode('r0001~x1', 0.7, 2), estimated: false, confidence: null },
      { node: recordingNode('r0001~x2', 0.3, 1), estimated: false, confidence: null },
    ])
    expect(observed.bestQuality).toBe(0.7)
    expect(observed.branchCount).toBe(3)
  })

  it('estimated reveals count toward quality only at medium confidence', () => {
    const world = twoBranchWorld()
    const observed = initObserved(world)
    // None-confidence estimate first: must not set bestQuality.
    commitReveals(observed, ['r0001-n000'], [{ node: recordingNode('r0001~est-1', 0.99, 2), estimated: true, confidence: 'none' }])
    expect(observed.bestQuality).toBeNull()
    // A low-confidence estimate is likewise excluded.
    commitReveals(observed, ['r0001-n000'], [{ node: recordingNode('r0001~est-2', 0.98, 3), estimated: true, confidence: 'low' }])
    expect(observed.bestQuality).toBeNull()
    // Medium confidence counts.
    commitReveals(observed, ['r0001-n000'], [{ node: recordingNode('r0001~est-3', 0.97, 4), estimated: true, confidence: 'medium' }])
    expect(observed.bestQuality).toBe(0.97)
    // A recorded reveal always counts and can raise quality.
    commitReveals(observed, ['r0001-n000'], [{ node: recordingNode('r0001-n005', 0.5, 5), estimated: false, confidence: null }])
    expect(observed.bestQuality).toBe(0.97)
    // But a higher recorded score replaces it.
    commitReveals(observed, ['r0001-n000'], [{ node: recordingNode('r0001-n006', 0.99, 6), estimated: false, confidence: null }])
    expect(observed.bestQuality).toBe(0.99)
    expect(observed.estCount).toBe(3)
    expect(observed.reveals).toBe(5)
  })
})
