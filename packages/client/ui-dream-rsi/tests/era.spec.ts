/**
 * W7 objective-era tests: the deterministic scale classification on the live
 * store's mixed rounds, era propagation into the iteration points, and the
 * era filter (default ratio-only climb, legacy probes toggled in).
 */
import { describe, expect, it } from 'vitest'
import {
  computeProgression, eraOf, SCORE_ERA_THRESHOLD, toIterationNodes,
} from '../src/client/progression.ts'
import type { RoundNodes } from '../src/client/progression.ts'
import type { NodeRow } from '../src/client/read.ts'

describe('eraOf — the documented heuristic (threshold 10)', () => {
  it('classifies the live store s mixed rounds', () => {
    // Campaign 1 toy task: a 1000/median-ms SPEED score.
    expect(eraOf(588.062)).toBe('raw')
    // Smoke probes: arbitrary sanity scores.
    expect(eraOf(100)).toBe('raw')
    expect(eraOf(75)).toBe('raw')
    expect(eraOf(50)).toBe('raw')
    // Circle packing: the ratio-scale objective era.
    expect(eraOf(0.951)).toBe('ratio')
    expect(eraOf(2.6359830849)).toBe('ratio')
    expect(eraOf(2.636)).toBe('ratio')
  })

  it('the threshold boundary is documented and inclusive toward ratio', () => {
    expect(SCORE_ERA_THRESHOLD).toBe(10)
    expect(eraOf(10)).toBe('ratio') // ≤ 10 → ratio
    expect(eraOf(10.001)).toBe('raw') // > 10 → raw
    expect(eraOf(0)).toBe('ratio')
  })

  it('a round without a numeric score is unclassified', () => {
    expect(eraOf(undefined)).toBeUndefined()
    expect(eraOf(Number.NaN)).toBeUndefined()
  })
})

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
 * The live store's era mix as round entries: r0002 is the raw toy-task round
 * (588.062), r0005+ are the ratio-scale circle-packing rounds.
 */
function mixedEraRounds(): RoundNodes[] {
  return [
    {
      roundId: 'r0006', truncated: false, era: 'ratio',
      nodes: [node('r0006-n000', null, 0, { valid: false }), node('r0006-n001', 'r0006-n000', 2.636)],
    },
    {
      roundId: 'r0005', truncated: false, era: 'ratio',
      nodes: [node('r0005-n000', null, 0, { valid: false }), node('r0005-n001', 'r0005-n000', 2.5)],
    },
    {
      roundId: 'r0002', truncated: false, era: 'raw',
      nodes: [node('r0002-n000', null, 0, { valid: false }), node('r0002-n001', 'r0002-n000', 588.062)],
    },
  ]
}

describe('era propagation', () => {
  it('toIterationNodes copies the round s era onto every subpoint', () => {
    const { iterations } = toIterationNodes(mixedEraRounds())
    expect(iterations.filter(point => point.era === 'ratio')).toHaveLength(4)
    expect(iterations.filter(point => point.era === 'raw')).toHaveLength(2)
    expect(iterations.every(point => point.era !== undefined)).toBe(true)
  })

  it('an unclassified round leaves the era undefined', () => {
    const { iterations } = toIterationNodes([
      { roundId: 'r0001', truncated: false, nodes: [node('n000', null, 0, { valid: false })] },
    ])
    expect(iterations[0]?.era).toBeUndefined()
  })
})

describe('computeProgression eraFilter', () => {
  const { iterations } = toIterationNodes(mixedEraRounds())

  it('defaults to all eras (pure model, no hidden filtering)', () => {
    expect(computeProgression(iterations).points).toHaveLength(6)
    expect(computeProgression(iterations).max).toBe(588.062)
  })

  it('ratio-only keeps the comparable climb and recomputes indices densely', () => {
    const progression = computeProgression(iterations, { eraFilter: 'ratio' })
    expect(progression.points.map(point => point.roundId)).toEqual(['r0005', 'r0005', 'r0006', 'r0006'])
    expect(progression.points.map(point => point.iteration)).toEqual([0, 1, 2, 3])
    expect(progression.max).toBe(2.636)
    expect(progression.min).toBe(0)
    expect(progression.rounds).toBe(2)
  })

  it('the Pareto frontier is valid+ratio-only by default-filtered input', () => {
    const progression = computeProgression(iterations, { eraFilter: 'ratio' })
    expect(progression.runningBest).toEqual([undefined, 2.5, 2.5, 2.636])
  })

  it('the toggle re-includes the legacy probes (frontier stretches honestly)', () => {
    const all = computeProgression(iterations, { eraFilter: 'all' })
    expect(all.points).toHaveLength(6)
    // Chronological order sorts r0002 (raw, valid 588.062) FIRST — the raw
    // score dominates the whole frontier once included. That is exactly the
    // "incompatible scales stretch the climb" effect the default avoids.
    expect(all.runningBest).toEqual([undefined, 588.062, 588.062, 588.062, 588.062, 588.062])
    expect(all.max).toBe(588.062)
  })

  it('raw-only isolates the legacy era', () => {
    const raw = computeProgression(iterations, { eraFilter: 'raw' })
    expect(raw.points.map(point => point.roundId)).toEqual(['r0002', 'r0002'])
    expect(raw.max).toBe(588.062)
  })

  it('an unclassified round rides with raw/all but not with ratio', () => {
    const { iterations: withUnclassified } = toIterationNodes([
      ...mixedEraRounds(),
      { roundId: 'r0001', truncated: false, nodes: [node('r0001-n000', null, 0, { valid: false })] },
    ])
    expect(computeProgression(withUnclassified, { eraFilter: 'ratio' }).points.every(point => point.era === 'ratio')).toBe(true)
    expect(computeProgression(withUnclassified, { eraFilter: 'raw' }).points.some(point => point.roundId === 'r0001')).toBe(true)
    expect(computeProgression(withUnclassified, { eraFilter: 'all' }).points).toHaveLength(7)
  })
})
