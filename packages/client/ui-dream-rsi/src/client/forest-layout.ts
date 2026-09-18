/**
 * The global discovery forest: every round's tree laid out in its own band,
 * bands left→right chronologically, with the cross-round best path computed
 * per round and chained.
 *
 * Pure and order-deterministic: band order is round-id ascending, within a
 * band the tidy-tree layout is the W2 one, file order breaks every tie.
 *
 * @module
 */
import { bestPath } from './read.ts'
import type { NodeRow } from './read.ts'
import { layoutTree } from './tree-layout.ts'
import type { TreeLayout } from './tree-layout.ts'

/** A round's nodes as the forest reads them (one loadNodes outcome). */
export interface ForestRound {
  roundId: string
  nodes: readonly NodeRow[]
  /** The nodes read hit the page cap before the file's end. */
  truncated: boolean
}

/** One round's band: its local layout shifted into the global canvas. */
export interface ForestBand {
  roundId: string
  /** The band's first x (its left edge, separators live between bands). */
  x: number
  /** The band's own layout (positions are band-local). */
  layout: TreeLayout
  /** The round's best path (root→leaf, highest summed score), node ids. */
  bestPath: readonly string[]
  /** The band's width on the global canvas. */
  width: number
  truncated: boolean
}

/** The laid-out forest: where every node of every round sits, globally. */
export interface ForestLayout {
  /** One band per round, chronological. */
  bands: ForestBand[]
  /**
   * Global position per node, keyed `${roundId}/${nodeId}` (node ids repeat
   * across rounds; the round prefix is the disambiguator).
   */
  positions: Map<string, { x: number; y: number; roundId: string; nodeId: string }>
  /** X positions of the separators BETWEEN bands (bands.length − 1 of them). */
  separators: number[]
  /** The cross-round champion lineage: each round's best path, chained. */
  globalBestPath: readonly string[]
  /** Total canvas width. */
  width: number
  /** Total canvas height. */
  height: number
}

/** Forest layout knobs. */
export interface ForestOptions {
  /** Gap between bands (the separator travels its middle). */
  bandGap?: number | undefined
  /** Vertical offset applied to every band (room for the labels). */
  offsetY?: number | undefined
}

const DEFAULTS = { bandGap: 36, offsetY: 18 } as const

/**
 * Lay out the whole forest.
 * @param rounds - one entry per round, in any order (sorted by round id).
 * @param options - band gap and vertical offset.
 * @returns the forest layout; empty input lays out to a zero-size canvas.
 */
export function layoutForest(rounds: readonly ForestRound[], options: ForestOptions = {}): ForestLayout {
  const bandGap = options.bandGap ?? DEFAULTS.bandGap
  const offsetY = options.offsetY ?? DEFAULTS.offsetY

  const ordered = [...rounds].sort((left, right) => left.roundId < right.roundId ? -1 : left.roundId > right.roundId ? 1 : 0)
  const bands: ForestBand[] = []
  const positions = new Map<string, { x: number; y: number; roundId: string; nodeId: string }>()
  const separators: number[] = []
  const globalBestPath: string[] = []

  let cursor = 0
  let maxHeight = 0
  for (const round of ordered) {
    const layout = layoutTree(round.nodes)
    const path = bestPath(round.nodes) ?? []
    // The separator travels the middle of the gap that PRECEDES this band
    // (cursor already includes the gap added by the previous iteration).
    if (bands.length > 0) separators.push(cursor - bandGap / 2)
    for (const [nodeId, position] of layout.positions) {
      positions.set(`${round.roundId}/${nodeId}`, {
        x: cursor + position.x,
        y: offsetY + position.y,
        roundId: round.roundId,
        nodeId,
      })
    }
    const width = layout.width
    bands.push({
      roundId: round.roundId,
      x: cursor,
      layout,
      bestPath: path,
      width,
      truncated: round.truncated,
    })
    globalBestPath.push(...path)
    maxHeight = Math.max(maxHeight, layout.height)
    cursor += width + bandGap
  }

  return {
    bands,
    positions,
    separators,
    globalBestPath,
    width: Math.max(cursor - bandGap, 0),
    height: maxHeight === 0 ? 0 : maxHeight + offsetY,
  }
}
