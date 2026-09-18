/**
 * W8 tests: the graph star (the champion terminal of the best path — forest
 * + per-round semantics) and the plotted-range window (slicing, the
 * within-window Pareto restart, full-range default).
 */
import { describe, expect, it } from 'vitest'
import { forestStar } from '../src/client/forest-layout.ts'
import type { ForestRound } from '../src/client/forest-layout.ts'
import { computeProgression, sliceWindow, toIterationNodes } from '../src/client/progression.ts'
import { bestPath } from '../src/client/read.ts'
import type { NodeRow } from '../src/client/read.ts'

/** A node factory matching the parser's narrowed shape. */
function node(id: string, parentId: string | null, score: number | undefined, options?: {
  valid?: boolean
}): NodeRow {
  return {
    id,
    parentId,
    kind: parentId === null ? 'root' : 'attempt',
    mechanism: parentId === null ? 'root' : `mech-${id}`,
    summary: `summary ${id}`,
    score,
    valid: options?.valid ?? score !== undefined,
    evaluated: score !== undefined,
    failClass: undefined,
    notes: undefined,
    policyVersion: 'v0001',
  }
}

/**
 * Mixed-era forest: a raw probe band (588 — never stars), a ratio band
 * peaking at 2.5, and the champion ratio band peaking at 2.636.
 */
function fixtureForest(): ForestRound[] {
  return [
    {
      roundId: 'r0002', truncated: false, era: 'raw',
      nodes: [node('r0002-n000', null, 0, { valid: false }), node('r0002-n001', 'r0002-n000', 588.062)],
    },
    {
      roundId: 'r0005', truncated: false, era: 'ratio',
      nodes: [node('r0005-n000', null, 0, { valid: false }), node('r0005-n001', 'r0005-n000', 2.5)],
    },
    {
      roundId: 'r0006', truncated: false, era: 'ratio',
      nodes: [node('r0006-n000', null, 0, { valid: false }), node('r0006-n001', 'r0006-n000', 2.6359830849)],
    },
  ]
}

describe('forestStar — the champion terminal of the best ratio band', () => {
  it('stars the terminal of the best ratio band s path; raw bands never star', () => {
    const star = forestStar(fixtureForest())
    expect(star).toEqual({ roundId: 'r0006', nodeId: 'r0006-n001', score: 2.6359830849 })
  })

  it('ties keep the first band chronologically', () => {
    const star = forestStar([
      { roundId: 'r0009', truncated: false, era: 'ratio', nodes: [node('r0009-n000', null, 0, { valid: false }), node('r0009-n001', 'r0009-n000', 2.636)] },
      { roundId: 'r0005', truncated: false, era: 'ratio', nodes: [node('r0005-n000', null, 0, { valid: false }), node('r0005-n001', 'r0005-n000', 2.636)] },
    ])
    expect(star).toEqual({ roundId: 'r0005', nodeId: 'r0005-n001', score: 2.636 })
  })

  it('a forest with only raw bands stars nothing', () => {
    expect(forestStar([fixtureForest()[0] as ForestRound])).toBeUndefined()
  })

  it('an empty forest stars nothing', () => {
    expect(forestStar([])).toBeUndefined()
  })
})

describe('the per-round tree star (TreeGraph s inputs)', () => {
  it('the star node is the terminal of the round s best path', () => {
    const nodes = fixtureForest()[2]?.nodes ?? []
    const path = bestPath(nodes)
    expect(path).toEqual(['r0006-n000', 'r0006-n001'])
    expect(path?.[path.length - 1]).toBe('r0006-n001')
  })

  it('a raw-era round has a best path but must not star it (era gate is the section s job)', () => {
    const raw = fixtureForest()[0]?.nodes ?? []
    expect(bestPath(raw)).toEqual(['r0002-n000', 'r0002-n001']) // path exists…
    // …and eraOf classifies the round raw, so TreeGraph (era !== 'ratio') renders no star.
  })
})

describe('sliceWindow + the within-window progression', () => {
  // 6 iterations across two ratio rounds (scores 0, 1, 0 | 0, 2, 3).
  const { iterations } = toIterationNodes([
    {
      roundId: 'r0002', truncated: false, era: 'ratio',
      nodes: [node('a0', null, 0, { valid: false }), node('a1', 'a0', 1), node('a2', 'a1', 0, { valid: false })],
    },
    {
      roundId: 'r0003', truncated: false, era: 'ratio',
      nodes: [node('b0', null, 0, { valid: false }), node('b1', 'b0', 2), node('b2', 'b1', 3)],
    },
  ])

  it('the full range is the identity', () => {
    expect(sliceWindow(iterations, 0, iterations.length - 1)).toEqual(iterations)
    expect(sliceWindow(iterations, -5, 99)).toEqual(iterations)
  })

  it('a window keeps only the included iterations', () => {
    const windowed = sliceWindow(iterations, 2, 4)
    expect(windowed.map(point => point.nodeId)).toEqual(['a2', 'b0', 'b1'])
  })

  it('reversed bounds normalize; out-of-range windows clamp to the data edge', () => {
    expect(sliceWindow(iterations, 4, 2).map(point => point.nodeId)).toEqual(['a2', 'b0', 'b1'])
    // A fully-out-of-range window clamps to the nearest edge (the last
    // iteration), keeping the chart non-empty — the range control's UX.
    expect(sliceWindow(iterations, 10, 20).map(point => point.nodeId)).toEqual(['b2'])
    expect(sliceWindow([], 0, 5)).toEqual([])
  })

  it('the within-window Pareto restarts at the window start', () => {
    const windowed = sliceWindow(iterations, 3, 5)
    const progression = computeProgression(windowed, { eraFilter: 'ratio' })
    // Only the window's valid attempts shape the frontier: 2 then 3.
    expect(progression.runningBest).toEqual([undefined, 2, 3])
    expect(progression.points.map(point => point.iteration)).toEqual([0, 1, 2])
  })

  it('markers recompute for the window only', () => {
    // One policy change inside the window (b1 AND b2 run v0002): the marker
    // index is window-local.
    const withChange = iterations.map(point =>
      point.nodeId === 'b1' || point.nodeId === 'b2' ? { ...point, policyVersion: 'v0002' } : point)
    const windowed = sliceWindow(withChange, 3, 5)
    const progression = computeProgression(windowed, { eraFilter: 'ratio' })
    expect(progression.markers).toEqual([
      { iteration: 1, roundId: 'r0003', nodeId: 'b1', version: 'v0002', previousVersion: 'v0001' },
    ])
  })

  it('the era filter composes with the window', () => {
    const rawMixed = [
      ...toIterationNodes([{ roundId: 'r0001', truncated: false, era: 'raw' as const, nodes: [node('z0', null, 0, { valid: false }), node('z1', 'z0', 588)] }]).iterations,
      ...iterations,
    ]
    const windowed = sliceWindow(rawMixed, 0, rawMixed.length - 1)
    expect(computeProgression(windowed, { eraFilter: 'ratio' }).points.every(point => point.era === 'ratio')).toBe(true)
    expect(computeProgression(windowed, { eraFilter: 'ratio' }).points).toHaveLength(6)
  })
})
