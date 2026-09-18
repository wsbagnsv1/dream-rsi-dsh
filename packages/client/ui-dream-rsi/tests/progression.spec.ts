/**
 * W4 progression-chart tests: the pure iteration model — global iteration
 * ordering across rounds, subpoint counts (roots, score-0, floored), Pareto
 * monotonicity, and policy-change markers at iteration indices.
 */
import { describe, expect, it } from 'vitest'
import {
  computeProgression, roundColor, thinIndices, toIterationNodes,
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
  it('builds a monotone Pareto frontier where floored scores never win', () => {
    const { iterations } = toIterationNodes(fixtureRounds())
    const progression = computeProgression(iterations)
    expect(progression.runningBest).toEqual([0, 0.9598, 0.9598, 0.9598, 1.8, 1.8, 2.6359830849])
    for (let index = 1; index < progression.runningBest.length; index += 1) {
      expect(progression.runningBest[index])
        .toBeGreaterThanOrEqual(progression.runningBest[index - 1] ?? Number.NaN)
    }
  })

  it('excludes floored scores from the y domain but keeps them as subpoints', () => {
    const { iterations } = toIterationNodes(fixtureRounds())
    const progression = computeProgression(iterations)
    expect(progression.points).toHaveLength(7)
    expect(progression.min).toBe(0)
    expect(progression.max).toBe(2.6359830849)
    expect(progression.rounds).toBe(2)
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
    expect(single.runningBest).toEqual([0])
    expect(single.markers).toEqual([])
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
