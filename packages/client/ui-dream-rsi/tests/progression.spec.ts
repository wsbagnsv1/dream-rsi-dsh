/**
 * W3 progression-chart tests: the pure progression model — chronological
 * ordering, null skipping, running-best monotonicity, policy-change marker
 * extraction, and the single-round / empty edges.
 */
import { describe, expect, it } from 'vitest'
import { computeProgression, REFERENCE_SCORE, thinIndices } from '../src/client/progression.ts'
import type { RoundRow } from '../src/client/read.ts'

/** Rounds in the dashboard's order: NEWEST first (as listRoundRows sorts them). */
function fixtureRounds(): RoundRow[] {
  return [
    { roundId: 'r0006', status: 'closed', policyVersion: 'v0015', bestScore: 2.6359830849, nodes: 9 },
    { roundId: 'r0005', status: 'closed', policyVersion: 'v0015', bestScore: 21.4, nodes: 8 },
    { roundId: 'r0004', status: 'closed', policyVersion: 'v0014', bestScore: 102.9, nodes: 7 },
    { roundId: 'r0003', status: 'closed', policyVersion: 'v0006', bestScore: 16.4, nodes: 5 },
    { roundId: 'r0002', status: 'closed', bestScore: undefined, nodes: 4 }, // skipped
    { roundId: 'r0001', status: 'closed', policyVersion: 'v0001', bestScore: 0.9598, nodes: 3 },
  ]
}

describe('computeProgression', () => {
  it('orders points chronologically and skips rounds without a numeric bestScore', () => {
    const progression = computeProgression(fixtureRounds())
    expect(progression.points.map(point => point.roundId))
      .toEqual(['r0001', 'r0003', 'r0004', 'r0005', 'r0006'])
    expect(progression.points.map(point => point.bestScore))
      .toEqual([0.9598, 16.4, 102.9, 21.4, 2.6359830849])
    expect(progression.points[4]).toMatchObject({ index: 4, policyVersion: 'v0015', nodes: 9 })
    // The skipped round leaves no hole: indices are dense.
    expect(progression.points.map(point => point.index)).toEqual([0, 1, 2, 3, 4])
  })

  it('running best is monotone non-decreasing and equals the running maximum', () => {
    const progression = computeProgression(fixtureRounds())
    expect(progression.runningBest).toEqual([0.9598, 16.4, 102.9, 102.9, 102.9])
    for (let index = 1; index < progression.runningBest.length; index += 1) {
      expect(progression.runningBest[index])
        .toBeGreaterThanOrEqual(progression.runningBest[index - 1] ?? Number.NaN)
    }
  })

  it('extracts policy-change markers only where the version actually changed', () => {
    const progression = computeProgression(fixtureRounds())
    expect(progression.markers).toEqual([
      { index: 1, roundId: 'r0003', version: 'v0006', previousVersion: 'v0001' },
      { index: 2, roundId: 'r0004', version: 'v0014', previousVersion: 'v0006' },
      { index: 3, roundId: 'r0005', version: 'v0015', previousVersion: 'v0014' },
    ])
  })

  it('a versionless round neither creates nor clears a marker', () => {
    const rounds: RoundRow[] = [
      { roundId: 'r0004', policyVersion: 'v0002', bestScore: 3 },
      { roundId: 'r0003', bestScore: 2.5 }, // no version: gap, no marker, no clearing
      { roundId: 'r0002', policyVersion: 'v0002', bestScore: 2 }, // same as r0004's: no marker
      { roundId: 'r0001', policyVersion: 'v0001', bestScore: 1 },
    ]
    const progression = computeProgression(rounds)
    expect(progression.markers).toEqual([
      { index: 1, roundId: 'r0002', version: 'v0002', previousVersion: 'v0001' },
    ])
  })

  it('the y domain includes the reference line', () => {
    const progression = computeProgression(
      [{ roundId: 'r0001', bestScore: 1.2 }, { roundId: 'r0002', bestScore: 2.4 }].reverse(),
      { referenceLine: REFERENCE_SCORE },
    )
    expect(progression.min).toBeLessThanOrEqual(REFERENCE_SCORE)
    expect(progression.max).toBeGreaterThanOrEqual(REFERENCE_SCORE)
  })

  it('single-round stores render one point with no markers', () => {
    const progression = computeProgression(
      [{ roundId: 'r0001', policyVersion: 'v0001', bestScore: 0.9598, nodes: 3 }],
      { referenceLine: REFERENCE_SCORE },
    )
    expect(progression.points).toHaveLength(1)
    expect(progression.points[0]).toMatchObject({ roundId: 'r0001', index: 0, bestScore: 0.9598 })
    expect(progression.runningBest).toEqual([0.9598])
    expect(progression.markers).toEqual([])
  })

  it('rounds with no scores at all produce an empty progression', () => {
    const progression = computeProgression(
      [{ roundId: 'r0002', bestScore: undefined }, { roundId: 'r0001', bestScore: undefined }],
    )
    expect(progression.points).toEqual([])
    expect(progression.runningBest).toEqual([])
    expect(progression.markers).toEqual([])
    expect(computeProgression([]).points).toEqual([])
  })
})

describe('thinIndices', () => {
  it('keeps every index under the cap and thins evenly above it', () => {
    expect(thinIndices(4)).toEqual([0, 1, 2, 3])
    const thinned = thinIndices(11)
    expect(thinned.length).toBeLessThanOrEqual(6)
    expect(thinned[0]).toBe(0)
    expect(thinned[thinned.length - 1]).toBe(10)
    expect(new Set(thinned).size).toBe(thinned.length)
  })

  it('handles degenerate counts', () => {
    expect(thinIndices(0)).toEqual([])
    expect(thinIndices(1)).toEqual([0])
  })
})
