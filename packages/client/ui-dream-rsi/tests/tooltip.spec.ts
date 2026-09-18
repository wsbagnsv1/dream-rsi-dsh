/**
 * W9 addendum fence: the styled tooltip's content model. Every subpoint kind
 * yields the required fields — roundId, node id, mechanism, FULL-precision
 * score, valid/failClass — and the champion lineage nodes add the
 * "champion at this iteration" line.
 */
import { describe, expect, it } from 'vitest'
import { tooltipLinesOf } from '../src/client/ProgressionChart.tsx'
import type { IterationPoint } from '../src/client/progression.ts'

function point(overrides: Partial<IterationPoint>): IterationPoint {
  return {
    iteration: 3,
    roundId: 'r0006',
    nodeId: 'r0006-n001',
    mechanism: 'contact-ladder',
    score: 2.6359830849,
    valid: true,
    evaluated: true,
    floored: false,
    ...overrides,
  }
}

const CHAMPION_LINE = 'champion at this iteration'

describe('tooltipLinesOf — every subpoint kind', () => {
  it('a valid subpoint: identity, mechanism, full-precision score, status', () => {
    const lines = tooltipLinesOf(point({}), CHAMPION_LINE)
    expect(lines[0]).toEqual({ text: 'r0006 · r0006-n001', strong: true })
    expect(lines[1]).toEqual({ text: 'contact-ladder' })
    expect(lines[2]).toEqual({ text: 'score: 2.6359830849' }) // FULL precision, not tick-rounded
    expect(lines[3]).toEqual({ text: 'valid', muted: true })
    expect(lines).toHaveLength(4)
  })

  it('a champion subpoint carries the champion line', () => {
    const lines = tooltipLinesOf(point({ champion: true }), CHAMPION_LINE)
    expect(lines[4]).toEqual({ text: CHAMPION_LINE, muted: true })
  })

  it('a failed subpoint reports the failClass; the champion line never appears', () => {
    const lines = tooltipLinesOf(point({ valid: false, failClass: 'correctness' }), CHAMPION_LINE)
    expect(lines[3]).toEqual({ text: 'failed (correctness)', muted: true })
    expect(lines.some(line => line.text === CHAMPION_LINE)).toBe(false)
  })

  it('a floored subpoint reads as −∞; an unscored one as unscored; mechanism optional', () => {
    const floored = tooltipLinesOf(point({ score: -1e12, valid: false, floored: true, mechanism: undefined }), CHAMPION_LINE)
    expect(floored[1]).toEqual({ text: 'score: −∞' })
    const unscored = tooltipLinesOf(point({ score: 0, valid: false, evaluated: false, mechanism: undefined }), CHAMPION_LINE)
    expect(unscored[1]).toEqual({ text: 'score: 0' })
    expect(unscored[2]).toEqual({ text: 'unscored', muted: true })
  })

  it('without the champion line the champion marker is absent (hover off non-lineage)', () => {
    const lines = tooltipLinesOf(point({ champion: true }))
    expect(lines).toHaveLength(4)
  })
})
