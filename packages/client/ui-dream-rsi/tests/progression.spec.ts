/**
 * W4 progression-chart tests: the pure iteration model — global iteration
 * ordering across rounds, subpoint counts (roots, score-0, floored), Pareto
 * monotonicity, and policy-change markers at iteration indices.
 */
import { describe, expect, it } from 'vitest'
import {
  computeProgression, paretoPolyline, roundColor, thinIndices, toIterationNodes,
} from '../src/client/progression.ts'
import type { IterationPoint, RoundNodes } from '../src/client/progression.ts'
import type { NodeRow } from '../src/client/read.ts'

/** A node factory matching the parser's narrowed shape. */
function node(id: string, parentId: string | null, score: number | undefined, options?: {
  valid?: boolean
  evaluated?: boolean
  policyVersion?: string
  mechanism?: string
  failClass?: string
}): NodeRow {
  return {
    id,
    parentId,
    kind: parentId === null ? 'root' : 'attempt',
    mechanism: options?.mechanism,
    summary: `summary ${id}`,
    score,
    valid: options?.valid ?? score !== undefined,
    evaluated: options?.evaluated ?? score !== undefined,
    failClass: options?.failClass,
    notes: undefined,
    policyVersion: options?.policyVersion,
  }
}

/**
 * Two rounds: r0001 (root + 2 attempts, one failed) and r0002 (root + 3
 * attempts incl. a floored one). Given in the dashboard's order (newest
 * first) to prove the flattening sorts them.
 */
function fixtureRounds(): RoundNodes[] {
  return [
    {
      roundId: 'r0002',
      truncated: false,
      nodes: [
        node('r0002-n000', null, 0, { valid: false, evaluated: false, policyVersion: 'v0015', mechanism: 'root' }),
        node('r0002-n001', 'r0002-n000', 1.8, { policyVersion: 'v0015', mechanism: 'ladder' }),
        node('r0002-n002', 'r0002-n001', -1e12, { valid: false, failClass: 'replay-illegal', policyVersion: 'v0015', mechanism: 'greedy' }),
        node('r0002-n003', 'r0002-n001', 2.6359830849, { policyVersion: 'v0015', mechanism: 'contact-ladder' }),
      ],
    },
    {
      roundId: 'r0001',
      truncated: false,
      nodes: [
        node('r0001-n000', null, 0, { valid: false, evaluated: false, policyVersion: 'v0001', mechanism: 'root' }),
        node('r0001-n001', 'r0001-n000', 0.9598, { policyVersion: 'v0001', mechanism: 'fleet-seed' }),
        node('r0001-n002', 'r0001-n001', 0, { valid: false, failClass: 'correctness', policyVersion: 'v0001', mechanism: 'wrong-transform' }),
      ],
    },
  ]
}

describe('toIterationNodes', () => {
  it('orders iterations across rounds (round id asc, then file order) and numbers them globally', () => {
    const { iterations, truncated } = toIterationNodes(fixtureRounds())
    expect(truncated).toBe(false)
    expect(iterations.map(point => `${point.roundId}/${point.nodeId}`)).toEqual([
      'r0001/r0001-n000',
      'r0001/r0001-n001',
      'r0001/r0001-n002',
      'r0002/r0002-n000',
      'r0002/r0002-n001',
      'r0002/r0002-n002',
      'r0002/r0002-n003',
    ])
    expect(iterations.map(point => point.iteration)).toEqual([0, 1, 2, 3, 4, 5, 6])
  })

  it('carries score, validity, mechanism, and the floored flag per subpoint', () => {
    const { iterations } = toIterationNodes(fixtureRounds())
    const root = iterations[0]
    expect(root).toMatchObject({ score: 0, valid: false, evaluated: false, floored: false, mechanism: 'root', policyVersion: 'v0001' })
    const floored = iterations[5]
    expect(floored).toMatchObject({ nodeId: 'r0002-n002', score: -1e12, valid: false, floored: true, failClass: 'replay-illegal' })
    const champion = iterations[6]
    expect(champion).toMatchObject({ score: 2.6359830849, valid: true, floored: false, mechanism: 'contact-ladder' })
  })

  it('flags truncation when any round was cut', () => {
    const rounds = fixtureRounds()
    const first = rounds[0]
    rounds[0] = {
      roundId: first?.roundId ?? 'r0002',
      nodes: first?.nodes ?? [],
      truncated: true,
    }
    expect(toIterationNodes(rounds).truncated).toBe(true)
  })

  it('coerces missing scores to 0 and keeps the point', () => {
    const { iterations } = toIterationNodes([
      { roundId: 'r0001', truncated: false, nodes: [{ id: 'n000', parentId: null }] },
    ])
    expect(iterations).toHaveLength(1)
    expect(iterations[0]).toMatchObject({ score: 0, evaluated: false, valid: false, floored: false })
  })
})

describe('computeProgression', () => {
  it('builds the Pareto frontier over VALID attempts only (failed never shapes it)', () => {
    const { iterations } = toIterationNodes(fixtureRounds())
    const progression = computeProgression(iterations)
    // The frontier is "best valid so far": undefined before the first valid
    // attempt, then carried forward — invalid attempts never move it.
    expect(progression.runningBest).toEqual([
      undefined, 0.9598, 0.9598, 0.9598, 1.8, 1.8, 2.6359830849,
    ])
    let last: number | undefined
    for (const value of progression.runningBest) {
      if (value === undefined) continue
      expect(value).toBeGreaterThanOrEqual(last ?? Number.NEGATIVE_INFINITY)
      last = value
    }
  })

  it('marks the champion chain: every valid attainer of a new running best', () => {
    const { iterations } = toIterationNodes(fixtureRounds())
    const progression = computeProgression(iterations)
    // Attainers: the first valid (0.9598), the 1.8, and the 2.6359 — NOT the
    // failed nodes, NOT valid attempts that merely tie or sit below the best.
    expect(progression.points.map(point => point.champion === true)).toEqual([
      false, true, false, false, true, false, true,
    ])
    // The FINAL champion carries the ★: the last attainer.
    expect(progression.finalChampionIndex).toBe(6)
    expect(progression.points[6]?.nodeId).toBe('r0002-n003')
  })

  it('the ratio-only default keeps the raw-probe 588 out of the y domain', () => {
    // The live-store mix: r0002 is the raw toy-task round (588.062).
    const mixed = toIterationNodes([
      {
        roundId: 'r0002', truncated: false, era: 'raw',
        nodes: [
          { id: 'r0002-n000', parentId: null, score: 0, evaluated: false, valid: false },
          { id: 'r0002-n001', parentId: 'r0002-n000', score: 588.062, evaluated: true, valid: true },
        ],
      },
      {
        roundId: 'r0005', truncated: false, era: 'ratio',
        nodes: [
          { id: 'r0005-n000', parentId: null, score: 0, evaluated: false, valid: false },
          { id: 'r0005-n001', parentId: 'r0005-n000', score: 2.6359830849, evaluated: true, valid: true },
        ],
      },
    ]).iterations
    // DEFAULT (the section passes eraFilter 'ratio'): the domain fits the climb.
    const ratio = computeProgression(mixed, { eraFilter: 'ratio' })
    expect(ratio.min).toBe(0)
    expect(ratio.max).toBe(2.6359830849)
    expect(ratio.points.some(point => point.roundId === 'r0002')).toBe(false)
    // The champion chain is ratio-only too: the final champion is the ratio round's node.
    expect(ratio.finalChampionIndex).toBe(1)
    // Toggling legacy in rescales the domain (the user sees the stretch).
    const all = computeProgression(mixed, { eraFilter: 'all' })
    expect(all.max).toBe(588.062)
    expect(all.finalChampionIndex).toBe(1) // the raw attempt attains over everything
  })

  it('a window restarts the champion chain (the within-window attainers)', () => {
    const { iterations } = toIterationNodes(fixtureRounds())
    // No era filter: the fixture carries no era; the window restarts the chain.
    // slice(4) = [1.8 valid, floored invalid, 2.636 valid]: the first valid
    // attempt attains afresh, the invalid one doesn't, the 2.636 raises again.
    const windowed = computeProgression(iterations.slice(4))
    expect(windowed.points.map(point => point.champion === true)).toEqual([true, false, true])
    expect(windowed.finalChampionIndex).toBe(2)
  })

  it('a failed attempt between two valid ones does NOT drop the frontier', () => {
    const { iterations } = toIterationNodes(fixtureRounds())
    const progression = computeProgression(iterations)
    // r0001-n002 (failed, 0) sits between the valid 0.9598 and r0002's valid 1.8:
    // the frontier carries 0.9598 straight through it (best so far never regresses).
    expect(progression.runningBest[1]).toBe(0.9598)
    expect(progression.runningBest[2]).toBe(0.9598)
    expect(progression.runningBest[3]).toBe(0.9598) // carried across r0002's invalid root
    expect(progression.runningBest[4]).toBe(1.8)
  })

  it('excludes floored scores from the y domain but keeps them as subpoints', () => {
    const { iterations } = toIterationNodes(fixtureRounds())
    const progression = computeProgression(iterations)
    expect(progression.points).toHaveLength(7)
    expect(progression.min).toBe(0)
    expect(progression.max).toBe(2.6359830849)
    expect(progression.rounds).toBe(2)
  })

  it('the Pareto polyline TERMINATES at the last attainer — no carry-forward tail (W10)', () => {
    // runningBest carries 2.636 flat through iterations 6 (the champion's own
    // index) — wait, the champion IS at 6 here; use a tail case: the champion
    // attains at 4 and 6 is dominated.
    const runningBest: (number | undefined)[] = [
      undefined, 0.9598, 0.9598, 0.9598, 1.8, 1.8, 1.8, 1.8, 1.8,
    ]
    const polyline = paretoPolyline(runningBest)
    // The staircase: start at the first attainer (1, 0.9598), rise at 4 (1.8),
    // and END at iteration 4 — iterations 5-8 are dominated, not on the frontier.
    expect(polyline).toEqual([
      { iteration: 1, value: 0.9598 },
      { iteration: 4, value: 0.9598 },
      { iteration: 4, value: 1.8 },
    ])
    expect(Math.max(...polyline.map(vertex => vertex.iteration))).toBe(4)
    // The attainer staircase is unchanged up to the end (one rise, one start).
    expect(polyline).toHaveLength(3)
  })

  it('the polyline ends exactly at the champion (the final attainer) on the W4 fixture', () => {
    const { iterations } = toIterationNodes(fixtureRounds())
    const progression = computeProgression(iterations)
    const polyline = paretoPolyline(progression.runningBest)
    const last = polyline[polyline.length - 1]
    expect(last).toEqual({ iteration: progression.finalChampionIndex, value: 2.6359830849 })
    expect(Math.max(...polyline.map(vertex => vertex.iteration))).toBe(progression.finalChampionIndex ?? 0)
  })

  it('an all-undefined frontier yields no polyline; a single attainer yields one vertex', () => {
    expect(paretoPolyline([undefined, undefined])).toEqual([])
    expect(paretoPolyline([undefined, 2.5, 2.5])).toEqual([{ iteration: 1, value: 2.5 }])
  })

  it('marks policy changes at iteration indices (first node under the new version)', () => {
    const { iterations } = toIterationNodes(fixtureRounds())
    const progression = computeProgression(iterations)
    expect(progression.markers).toEqual([
      { iteration: 3, roundId: 'r0002', nodeId: 'r0002-n000', version: 'v0015', previousVersion: 'v0001' },
    ])
  })

  it('a versionless node neither creates nor clears a marker', () => {
    const iterations: IterationPoint[] = [
      { iteration: 0, roundId: 'r0001', nodeId: 'a', score: 0, valid: false, evaluated: false, floored: false, policyVersion: 'v0001' },
      { iteration: 1, roundId: 'r0001', nodeId: 'b', score: 1, valid: true, evaluated: true, floored: false },
      { iteration: 2, roundId: 'r0001', nodeId: 'c', score: 2, valid: true, evaluated: true, floored: false, policyVersion: 'v0001' },
      { iteration: 3, roundId: 'r0001', nodeId: 'd', score: 3, valid: true, evaluated: true, floored: false, policyVersion: 'v0002' },
    ]
    expect(computeProgression(iterations).markers).toEqual([
      { iteration: 3, roundId: 'r0001', nodeId: 'd', version: 'v0002', previousVersion: 'v0001' },
    ])
  })

  it('handles empty and single-node forests', () => {
    expect(computeProgression([]).points).toEqual([])
    const single = computeProgression(toIterationNodes([
      { roundId: 'r0001', truncated: false, nodes: [node('n000', null, 0, { valid: false, evaluated: false, policyVersion: 'v0001' })] },
    ]).iterations)
    expect(single.points).toHaveLength(1)
    expect(single.runningBest).toEqual([undefined]) // no valid attempt: no frontier yet
    expect(single.markers).toEqual([])
  })

  it('a forest with no valid attempts at all has no frontier (dots still render)', () => {
    const progression = computeProgression(toIterationNodes([
      { roundId: 'r0001', truncated: false, nodes: [
        node('n000', null, 0, { valid: false, evaluated: false }),
        node('n001', 'n000', -1e12, { valid: false, failClass: 'replay-illegal' }),
      ] },
    ]).iterations)
    expect(progression.runningBest.every(value => value === undefined)).toBe(true)
    expect(progression.points).toHaveLength(2)
  })

  it('an all-floored forest still renders (domain falls back, dots clamp)', () => {
    const progression = computeProgression(toIterationNodes([
      { roundId: 'r0001', truncated: false, nodes: [node('n000', null, -1e12, { valid: false, failClass: 'replay-illegal' })] },
    ]).iterations)
    expect(progression.points).toHaveLength(1)
    expect(progression.points[0]?.floored).toBe(true)
    expect(progression.min).toBe(0)
    expect(progression.max).toBe(1)
  })
})

describe('roundColor', () => {
  it('cycles a deterministic palette (same round index, same color; wraps)', () => {
    expect(roundColor(0)).toBe(roundColor(0))
    expect(roundColor(0)).not.toBe(roundColor(1))
    expect(roundColor(8)).toBe(roundColor(0))
  })
})

describe('thinIndices', () => {
  it('keeps every index under the cap and thins evenly above it', () => {
    expect(thinIndices(4)).toEqual([0, 1, 2, 3])
    const thinned = thinIndices(11)
    expect(thinned.length).toBeLessThanOrEqual(6)
    expect(thinned[0]).toBe(0)
    expect(thinned[thinned.length - 1]).toBe(10)
  })

  it('handles degenerate counts', () => {
    expect(thinIndices(0)).toEqual([])
    expect(thinIndices(1)).toEqual([0])
  })
})
