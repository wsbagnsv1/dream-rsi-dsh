/**
 * W2 graph-view tests: the nodes.jsonl parser, the deterministic tidy-tree
 * layout, and the best-path computation — all against fixture trees
 * transcribed from the live store's node shapes.
 */
import { describe, expect, it } from 'vitest'
import {
  bestPath, buildTreeIndex, parseNodesPage,
} from '../src/client/read.ts'
import type { NodeRow } from '../src/client/read.ts'
import { layoutTree, scoreColor } from '../src/client/tree-layout.ts'

/** One live-store-shaped node line (r0004's root and first attempt). */
const ROOT_LINE = '{"id":"r0004-n000","roundId":"r0004","parentId":null,"kind":"root","state":{"depth":0,"branchId":-1,"seqInBranch":0,"workspaceSummary":"","inheritedContextNote":"","siblingCountAtDecision":1},"action":{"summary":"initial workspace","mechanism":"root","tags":[],"artifactPaths":[]},"outcome":{"score":0,"evaluated":false,"valid":false,"failClass":"ok","error":null,"deltaVsBaseline":null,"deltaVsParent":null},"metrics":{"agentCalls":0,"wallMs":null},"notes":"root created by dreamrsi_begin_round","lineage":{"createdAt":"2026-09-17T21:53:14.855Z","evaluatedAt":null,"policyVersion":"v0014","seq":0}}'
const ATTEMPT_LINE = '{"id":"r0004-n001","roundId":"r0004","parentId":"r0004-n000","kind":"attempt","state":{"depth":1,"branchId":0,"seqInBranch":0,"workspaceSummary":"initial workspace","inheritedContextNote":"","siblingCountAtDecision":1},"action":{"summary":"l1b_v52: implicit-Gram KKT active-set engine","mechanism":"implicit-gram-active-set","tags":["kkt-active-set"],"artifactPaths":[]},"outcome":{"score":0,"evaluated":true,"valid":false,"failClass":"correctness","error":"potrf fails","deltaVsBaseline":null,"deltaVsParent":null},"metrics":{"agentCalls":1,"wallMs":null},"notes":"Gram+Cholesky structurally dead.","lineage":{"createdAt":"2026-09-17T22:58:38.445Z","evaluatedAt":"2026-09-17T22:58:38.445Z","policyVersion":"v0014","seq":1}}'

describe('parseNodesPage', () => {
  it('parses live-store node lines, narrowing action/outcome/state/lineage', () => {
    const rows = parseNodesPage([ROOT_LINE, ATTEMPT_LINE].join('\n'))
    expect(rows).toEqual([
      {
        id: 'r0004-n000',
        roundId: 'r0004',
        parentId: null,
        kind: 'root',
        mechanism: 'root',
        summary: 'initial workspace',
        score: 0,
        valid: false,
        evaluated: false,
        failClass: 'ok',
        notes: 'root created by dreamrsi_begin_round',
        depth: 0,
        policyVersion: 'v0014',
        createdAt: '2026-09-17T21:53:14.855Z',
      },
      {
        id: 'r0004-n001',
        roundId: 'r0004',
        parentId: 'r0004-n000',
        kind: 'attempt',
        mechanism: 'implicit-gram-active-set',
        summary: 'l1b_v52: implicit-Gram KKT active-set engine',
        score: 0,
        valid: false,
        evaluated: true,
        failClass: 'correctness',
        notes: 'Gram+Cholesky structurally dead.',
        depth: 1,
        policyVersion: 'v0014',
        createdAt: '2026-09-17T22:58:38.445Z',
      },
    ])
  })

  it('skips malformed and id-less lines, and blank lines', () => {
    const rows = parseNodesPage([
      ATTEMPT_LINE,
      'not json at all',
      '{"kind":"attempt"}',
      '',
    ].join('\n'))
    expect(rows.map(row => row.id)).toEqual(['r0004-n001'])
  })
})

/** A fixture tree: root, two branches (one deeper chain), a sibling chain. */
function fixtureNodes(): NodeRow[] {
  const node = (id: string, parentId: string | null, score: number | undefined, valid = true): NodeRow => ({
    id,
    parentId,
    kind: parentId === null ? 'root' : 'attempt',
    mechanism: parentId === null ? 'root' : `mech-${id}`,
    summary: `summary ${id}`,
    score,
    evaluated: score !== undefined,
    valid,
    failClass: valid ? 'ok' : 'correctness',
  })
  return [
    node('n000', null, 0),
    node('n001', 'n000', 10), // branch A: chain n001 -> n003 (total 30)
    node('n002', 'n000', 25), // branch B: leaf (total 25)
    node('n003', 'n001', 20), // branch A leaf (total 30) — the best path
    node('n004', 'n000', undefined), // unscored branch: leaf
  ]
}

describe('buildTreeIndex', () => {
  it('indexes children in file order and finds the root', () => {
    const { children, roots } = buildTreeIndex(fixtureNodes())
    expect(roots).toEqual(['n000'])
    expect(children.get('n000')).toEqual(['n001', 'n002', 'n004'])
    expect(children.get('n001')).toEqual(['n003'])
    expect(children.has('n003')).toBe(false)
  })

  it('promotes nodes with absent parents to roots (truncated pages stay drawable)', () => {
    const { roots } = buildTreeIndex([fixtureNodes()[3]!]) // n003 alone; its parent is absent
    expect(roots).toEqual(['n003'])
  })
})

describe('layoutTree', () => {
  it('is deterministic: identical input yields identical positions', () => {
    const nodes = fixtureNodes()
    const first = layoutTree(nodes)
    const second = layoutTree(nodes)
    expect([...first.positions.entries()]).toEqual([...second.positions.entries()])
    expect(first.edges).toEqual(second.edges)
    expect(first.width).toBe(second.width)
    expect(first.height).toBe(second.height)
  })

  it('orders depth along x and never overlaps sibling subtrees', () => {
    const layout = layoutTree(fixtureNodes())
    // Root at depth 0; children at depth 1; n003 at depth 2.
    expect(layout.positions.get('n000')?.depth).toBe(0)
    expect(layout.positions.get('n001')?.depth).toBe(1)
    expect(layout.positions.get('n003')?.depth).toBe(2)
    const byY = (id: string): number => layout.positions.get(id)?.y ?? Number.NaN
    // Distinct leaves get distinct rows (no overlap).
    const leafYs = ['n002', 'n003', 'n004'].map(byY).sort((a, b) => a - b)
    expect(new Set(leafYs).size).toBe(3)
    // Internal node sits between its child rows: n001 chains to n003, so its y is n003's (single child).
    expect(byY('n001')).toBe(byY('n003'))
    // Root spans its children: between min and max child y (midpoint of n001 and n004 rows).
    const rootY = byY('n000')
    expect(rootY).toBeGreaterThan(Math.min(byY('n001'), byY('n004')) - 1e-9)
    expect(rootY).toBeLessThan(Math.max(byY('n001'), byY('n004')) + 1e-9)
    // Every parent→child pair appears exactly once among the edges.
    expect(layout.edges.filter(([parent]) => parent === 'n000')).toHaveLength(3)
    expect(layout.edges).toContainEqual(['n001', 'n003'])
    expect(layout.order[0]).toBe('n000')
  })

  it('lays out an empty tree to a zero-size canvas', () => {
    const layout = layoutTree([])
    expect(layout.positions.size).toBe(0)
    expect(layout.width).toBe(0)
    expect(layout.height).toBe(0)
  })

  it('survives a malformed cycle (visited guard keeps the walk finite)', () => {
    const cyclic: NodeRow[] = [
      { id: 'a', parentId: null },
      { id: 'b', parentId: 'a' },
      { id: 'a', parentId: 'b' }, // duplicate id → the index makes b's child a, already visited
    ]
    const layout = layoutTree(cyclic)
    expect(layout.positions.size).toBeGreaterThan(0)
  })
})

describe('bestPath', () => {
  it('returns the highest-sum root→leaf path (chain 30 beats leaf 25)', () => {
    const path = bestPath(fixtureNodes())
    expect(path).toEqual(['n000', 'n001', 'n003'])
  })

  it('breaks ties by the first leaf in file order', () => {
    const nodes = fixtureNodes().map(node =>
      node.id === 'n003' ? { ...node, score: 25 } : node)
    // Now both branches sum to 25: n000->n002 (25) vs n000->n001->n003 (25).
    // n001's subtree is walked before n002 (file order), but n002's leaf comes
    // first among equal totals? No — DFS order: n003 is reached before n002.
    // Equal totals keep the FIRST found: n000->n001->n003.
    expect(bestPath(nodes)).toEqual(['n000', 'n001', 'n003'])
  })

  it('is undefined with no scored nodes at all', () => {
    const unscored = fixtureNodes().map(node => ({ ...node, score: undefined, evaluated: false }))
    expect(bestPath(unscored)).toBeUndefined()
    expect(bestPath([])).toBeUndefined()
  })

  it('treats a lone root as its own path', () => {
    expect(bestPath([{ id: 'n000', parentId: null, score: 0 }])).toEqual(['n000'])
  })
})

describe('scoreColor', () => {
  it('maps the gradient endpoints and clamps out-of-range fractions', () => {
    expect(scoreColor(0)).toBe('hsl(4.0, 62%, 46%)')
    expect(scoreColor(1)).toBe('hsl(142.0, 62%, 46%)')
    expect(scoreColor(-5)).toBe(scoreColor(0))
    expect(scoreColor(7)).toBe(scoreColor(1))
    expect(scoreColor(Number.NaN)).toBe(scoreColor(0))
  })
})
