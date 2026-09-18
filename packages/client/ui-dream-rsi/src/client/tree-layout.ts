/**
 * Deterministic tidy-tree layout for one round's discovery tree.
 *
 * Depth maps to the horizontal axis; leaves take sequential vertical rows and
 * an internal node sits at the midpoint of its first and last child (the
 * Reingold–Tilford idea, reduced to what a fan-out ≤ 6 tree needs). Pure and
 * order-deterministic: file order breaks every tie, there is no randomness,
 * and identical input yields identical positions.
 */
import { buildTreeIndex } from './read.ts'
import type { NodeRow } from './read.ts'

/** Layout knobs (all optional; the defaults suit the panel's width). */
export interface LayoutOptions {
  /** Horizontal distance between depth levels. */
  columnWidth?: number | undefined
  /** Vertical distance between adjacent leaf rows. */
  rowHeight?: number | undefined
  /** Left margin. */
  marginX?: number | undefined
  /** Top margin. */
  marginY?: number | undefined
}

/** One node's layout position (SVG user units, y grows downward). */
export interface LayoutPosition {
  x: number
  y: number
  /** Computed depth from the visible root (roots are depth 0). */
  depth: number
}

/** The laid-out tree: where every node sits, and how large the canvas is. */
export interface TreeLayout {
  /** Position per node id (only nodes that are part of the drawn forest). */
  positions: Map<string, LayoutPosition>
  /** Parent→child edges in stable drawing order. */
  edges: readonly (readonly [string, string])[]
  /** Node ids in DFS drawing order (roots in file order, children in file order). */
  order: readonly string[]
  /** Total canvas width. */
  width: number
  /** Total canvas height. */
  height: number
}

/** Defaults for the panel's rendering box. */
const DEFAULTS = { columnWidth: 96, rowHeight: 34, marginX: 28, marginY: 20 } as const

/**
 * Lay out one round's nodes.
 * @param nodes - the parsed node rows of one round (file order).
 * @param options - layout knobs; omitted members use the defaults.
 * @returns the layout; an empty input lays out to a zero-size canvas.
 */
export function layoutTree(nodes: readonly NodeRow[], options: LayoutOptions = {}): TreeLayout {
  const columnWidth = options.columnWidth ?? DEFAULTS.columnWidth
  const rowHeight = options.rowHeight ?? DEFAULTS.rowHeight
  const marginX = options.marginX ?? DEFAULTS.marginX
  const marginY = options.marginY ?? DEFAULTS.marginY

  const positions = new Map<string, LayoutPosition>()
  const edges: [string, string][] = []
  if (nodes.length === 0) {
    return { positions, edges, order: [], width: 0, height: 0 }
  }
  const { children, roots } = buildTreeIndex(nodes)

  let nextLeafY = 0
  let maxDepth = 0
  const order: string[] = []
  // A malformed file could carry a cycle; the visited set keeps the walk finite.
  const visited = new Set<string>()

  /**
   * Assign y for one subtree; returns its y.
   * @param id - the subtree root's node id.
   * @param depth - its computed depth.
   * @returns the node's y position.
   */
  const assign = (id: string, depth: number): number => {
    visited.add(id)
    order.push(id)
    maxDepth = Math.max(maxDepth, depth)
    const kids = children.get(id)
    if (kids === undefined) {
      const y = nextLeafY * rowHeight
      nextLeafY += 1
      positions.set(id, { x: marginX + depth * columnWidth, y, depth })
      return y
    }
    let firstY = 0
    let lastY = 0
    let index = 0
    for (const kid of kids) {
      if (visited.has(kid)) continue
      const kidY = assign(kid, depth + 1)
      edges.push([id, kid])
      if (index === 0) firstY = kidY
      lastY = kidY
      index += 1
    }
    const y = index === 0 ? nextLeafY * rowHeight : (firstY + lastY) / 2
    if (index === 0) nextLeafY += 1
    positions.set(id, { x: marginX + depth * columnWidth, y, depth })
    return y
  }

  for (const root of roots) {
    if (visited.has(root)) continue
    assign(root, 0)
  }

  const leafRows = nextLeafY
  return {
    positions,
    edges,
    order,
    width: marginX * 2 + maxDepth * columnWidth,
    height: leafRows === 0 ? marginY * 2 : marginY * 2 + leafRows * rowHeight,
  }
}

/**
 * The score gradient the graph colors nodes with: HSL hue 4 (red) → 142
 * (green) at fixed saturation/lightness, so equal scores render equally on
 * every platform. Neutral for unevaluated nodes is the caller's business.
 * @param fraction - normalized score in [0, 1] (clamped).
 * @returns an HSL color string.
 */
export function scoreColor(fraction: number): string {
  const clamped = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0
  const hue = 4 + (142 - 4) * clamped
  return `hsl(${hue.toFixed(1)}, 62%, 46%)`
}
