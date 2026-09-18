/**
 * W5 global-forest tests: the banded multi-round layout (band offsets,
 * separators, determinism) and the cross-round best path — the champion
 * lineage chained across rounds.
 */
import { describe, expect, it } from 'vitest'
import { layoutForest } from '../src/client/forest-layout.ts'
import type { ForestRound } from '../src/client/forest-layout.ts'
import type { NodeRow } from '../src/client/read.ts'

/** A node factory matching the parser's narrowed shape. */
function node(id: string, parentId: string | null, score: number | undefined, options?: {
  valid?: boolean
  evaluated?: boolean
  policyVersion?: string
}): NodeRow {
  return {
    id,
    parentId,
    kind: parentId === null ? 'root' : 'attempt',
    mechanism: parentId === null ? 'root' : `mech-${id}`,
    summary: `summary ${id}`,
    score,
    valid: options?.valid ?? score !== undefined,
    evaluated: options?.evaluated ?? score !== undefined,
    failClass: undefined,
    notes: undefined,
    policyVersion: options?.policyVersion,
  }
}

/**
 * The classic champion-lineage fixture: an early weak round, a middle round
 * with a dead branch and a good chain, and a final round reaching the
 * champion score. Given in dashboard order (newest first) to prove the sort.
 */
function fixtureForest(): ForestRound[] {
  return [
    {
      roundId: 'r0003',
      truncated: false,
      nodes: [
        node('r0003-n000', null, 0, { valid: false, evaluated: false, policyVersion: 'v0015' }),
        node('r0003-n001', 'r0003-n000', 21.4, { policyVersion: 'v0015' }),
        node('r0003-n002', 'r0003-n001', 26.35, { policyVersion: 'v0015' }),
      ],
    },
    {
      roundId: 'r0002',
      truncated: false,
      nodes: [
        node('r0002-n000', null, 0, { valid: false, evaluated: false, policyVersion: 'v0006' }),
        node('r0002-n001', 'r0002-n000', 0, { valid: false, policyVersion: 'v0006' }), // dead branch
        node('r0002-n002', 'r0002-n000', 16.4, { policyVersion: 'v0006' }),
        node('r0002-n003', 'r0002-n002', 18.1, { policyVersion: 'v0006' }),
      ],
    },
    {
      roundId: 'r0001',
      truncated: false,
      nodes: [
        node('r0001-n000', null, 0, { valid: false, evaluated: false, policyVersion: 'v0001' }),
        node('r0001-n001', 'r0001-n000', 2.63, { policyVersion: 'v0001' }),
      ],
    },
  ]
}

describe('layoutForest', () => {
  it('orders bands chronologically (round id asc) regardless of input order', () => {
    const layout = layoutForest(fixtureForest())
    expect(layout.bands.map(band => band.roundId)).toEqual(['r0001', 'r0002', 'r0003'])
  })

  it('offsets bands left→right with separators between them', () => {
    const layout = layoutForest(fixtureForest(), { bandGap: 44 })
    const [first, second, third] = layout.bands
    expect(first?.x).toBe(0)
    expect(second?.x).toBe((first?.width ?? 0) + 44)
    expect(third?.x).toBe((second?.x ?? 0) + (second?.width ?? 0) + 44)
    expect(layout.separators).toHaveLength(2)
    expect(layout.separators[0]).toBeGreaterThan(first?.width ?? 0)
    expect(layout.separators[0]).toBeLessThan(second?.x ?? 0)
    // Bands do not overlap.
    expect(second?.x).toBeGreaterThanOrEqual((first?.x ?? 0) + (first?.width ?? 0))
  })

  it('is deterministic: identical input yields identical bands and positions', () => {
    const first = layoutForest(fixtureForest())
    const second = layoutForest(fixtureForest())
    expect(first.bands.map(band => [band.roundId, band.x, band.width]))
      .toEqual(second.bands.map(band => [band.roundId, band.x, band.width]))
    expect([...first.positions.entries()]).toEqual([...second.positions.entries()])
    expect(first.globalBestPath).toEqual(second.globalBestPath)
  })

  it('keys positions by round and node so cross-round id collisions stay distinct', () => {
    const layout = layoutForest(fixtureForest())
    // Both rounds have an n000 root; both must exist, at different x.
    const a = layout.positions.get('r0001/r0001-n000')
    const b = layout.positions.get('r0002/r0002-n000')
    expect(a).toBeDefined()
    expect(b).toBeDefined()
    expect((b?.x ?? 0)).toBeGreaterThan(a?.x ?? 0)
  })

  it('chains the per-round best paths into the global champion lineage', () => {
    const layout = layoutForest(fixtureForest())
    // r0001: the single valid chain. r0002: 16.4 -> 18.1 beats the dead 0.
    // r0003: 21.4 -> 26.35. Concatenated = the champion lineage.
    expect(layout.globalBestPath).toEqual([
      'r0001-n000', 'r0001-n001',
      'r0002-n000', 'r0002-n002', 'r0002-n003',
      'r0003-n000', 'r0003-n001', 'r0003-n002',
    ])
    // The final segment ends at the champion score's node.
    expect(layout.globalBestPath[layout.globalBestPath.length - 1]).toBe('r0003-n002')
  })

  it('empty input lays out to a zero-size canvas', () => {
    const layout = layoutForest([])
    expect(layout.bands).toEqual([])
    expect(layout.positions.size).toBe(0)
    expect(layout.width).toBe(0)
    expect(layout.height).toBe(0)
  })

  it('a round with only unscored-but-numbered roots still chains its root path', () => {
    const layout = layoutForest([
      { roundId: 'r0001', truncated: false, nodes: [node('r0001-n000', null, 0, { valid: false, evaluated: false })] },
      { roundId: 'r0002', truncated: false, nodes: [node('r0002-n000', null, 0, { valid: false, evaluated: false })] },
    ])
    expect(layout.bands).toHaveLength(2)
    // Score 0 is a number: bestPath exists (the lone root); validity is a
    // rendering concern (the frontier is valid-only, the path highlight is not).
    expect(layout.globalBestPath).toEqual(['r0001-n000', 'r0002-n000'])
  })

  it('a round whose nodes carry no numeric scores at all contributes no path', () => {
    const layout = layoutForest([
      { roundId: 'r0001', truncated: false, nodes: [{ id: 'r0001-n000', parentId: null }] },
    ])
    expect(layout.bands).toHaveLength(1)
    expect(layout.globalBestPath).toEqual([])
  })
})
