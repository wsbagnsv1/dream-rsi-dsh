/**
 * The discovery-tree graph: one round's nodes and edges as inline SVG.
 *
 * Pure rendering over pre-parsed rows: the layout and the best path are pure
 * functions (tree-layout.ts / read.ts), the score gradient is a fixed HSL
 * ramp, and the hover tooltip is the SVG-native `<title>` — no dependencies,
 * no timers, no randomness. The parent section owns the round selector and
 * the best-path toggle; this component only draws what it is given.
 */
import { useMemo } from 'react'
import type { ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { bestPath, FLOORED_SCORE } from './read.ts'
import { useState } from 'react'
import type { NodeRow } from './read.ts'
import { layoutTree, scoreColor } from './tree-layout.ts'
import { STAR_GLYPH } from './progression.ts'
import { ChartTooltip } from './ChartTooltip.tsx'
import type { ChartTooltipLine } from './ChartTooltip.tsx'
import type {} from './locales.ts'

/** The graph's props: one round's rows, its id, copy, and the toggle state. */
export interface TreeGraphProps {
  /** The round's parsed node rows, in file order. */
  nodes: readonly NodeRow[]
  /** The round the rows belong to (tooltip context). */
  roundId: string
  /** Whether the best path is emphasized. */
  showBestPath: boolean
  /**
   * The round's objective era: only a ratio-era round stars its best-path
   * terminal (the rounds-table semantics — raw probes never star).
   */
  era?: 'ratio' | 'raw' | undefined
  /** Namespace-bound translate. */
  t: TranslateNS<'dreamRsi'>
}

/** Graph-specific inline styles (the panel styles the frame around it). */
const css = {
  graphScroll: { overflowX: 'auto', overflowY: 'hidden' } satisfies React.CSSProperties,
  svg: { display: 'block' } satisfies React.CSSProperties,
  legend: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 6, flexWrap: 'wrap' } satisfies React.CSSProperties,
  legendBar: {
    width: 96, height: 8, borderRadius: 4,
    background: `linear-gradient(90deg, ${scoreColor(0)}, ${scoreColor(0.5)}, ${scoreColor(1)})`,
  } satisfies React.CSSProperties,
  legendText: { fontSize: 11, color: 'var(--dsh-fg-muted, #888)', fontVariantNumeric: 'tabular-nums' } satisfies React.CSSProperties,
  legendChip: {
    display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11,
    color: 'var(--dsh-fg-muted, #888)',
  } satisfies React.CSSProperties,
  swatch: { width: 9, height: 9, borderRadius: '50%', display: 'inline-block' } satisfies React.CSSProperties,
}

const NEUTRAL_FILL = '#9aa3ad'
const EDGE_COLOR = '#b9c0c9'
const BEST_PATH_COLOR = '#1f8a5f'
const INVALID_STROKE = '#c0392b'

/** One hex digit of stroke emphasis. */
const BEST_NODE_STROKE = '#0f6b47'

/**
 * Format one score for the tooltip; floored scores read as −∞.
 * @param score - the raw score.
 * @returns the display string.
 */
function scoreText(score: number | undefined): string {
  if (score === undefined) return '—'
  if (score <= FLOORED_SCORE / 2) return '−∞'
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 }).format(score)
}

/**
 * Draw one round's discovery tree.
 * @param props - the rows, round id, toggle state, and copy.
 * @returns the SVG graph with its legend.
 */
export function TreeGraph({ nodes, roundId, showBestPath, era, t }: TreeGraphProps): ReactNode {
  const layout = useMemo(() => layoutTree(nodes), [nodes])
  // The hovered node (the styled tooltip's anchor); undefined = hidden.
  const [hover, setHover] = useState<NodeRow | undefined>(undefined)
  // The best path (and its terminal's star) exists whenever the round has a
  // scored chain — independent of the emphasis toggle.
  const path = useMemo(() => bestPath(nodes), [nodes])
  const emphasized = showBestPath ? path : undefined
  const onPath = useMemo(() => new Set(emphasized ?? []), [emphasized])
  const pathEdges = useMemo(() => new Set(
    emphasized === undefined ? [] : emphasized.slice(1).map((id, index) => `${String(emphasized[index])}->${id}`),
  ), [emphasized])
  const starNode = useMemo(() => {
    if (era !== 'ratio' || path === undefined || path.length === 0) return undefined
    return path[path.length - 1]
  }, [era, path])
  const byId = useMemo(() => new Map(nodes.map(node => [node.id, node])), [nodes])

  // Score domain over evaluated nodes; min === max renders the single score full green.
  const scored = useMemo(
    () => nodes.filter(node => typeof node.score === 'number' && !Number.isNaN(node.score)),
    [nodes],
  )
  const min = scored.reduce((least, node) => Math.min(least, node.score ?? 0), Number.POSITIVE_INFINITY)
  const max = scored.reduce((most, node) => Math.max(most, node.score ?? 0), Number.NEGATIVE_INFINITY)
  const fractionOf = (score: number): number => (max > min ? (score - min) / (max - min) : 1)

  if (layout.positions.size === 0) return null

  /** The styled tooltip's lines for one node (full-precision score). */
  const tooltipLinesOf = (node: NodeRow): ChartTooltipLine[] => {
    const floored = typeof node.score === 'number' && node.score <= FLOORED_SCORE / 2
    const score = floored ? '−∞' : node.score === undefined ? '—' : String(node.score)
    return [
      { text: `${roundId} · ${node.id}`, strong: true },
      ...(node.mechanism === undefined ? [] : [{ text: node.mechanism }]),
      ...(node.summary === undefined ? [] : [{ text: node.summary, muted: true }]),
      { text: `${t('rounds.best')}: ${score}${node.valid === false ? ` · ${node.failClass ?? t('dreams.floored')}` : ''}` },
      ...(node.notes === undefined ? [] : [{ text: node.notes.length > 160 ? `${node.notes.slice(0, 160)}…` : node.notes, muted: true }]),
    ]
  }

  return (
    <div data-dream-rsi='tree-graph' data-dream-rsi-round={roundId}>
      <div style={css.graphScroll}>
        {/* The relative wrapper hugs the svg (its exact size), so the tooltip's
            percentage anchor tracks the node at any scroll position. */}
        <div style={{ position: 'relative', width: layout.width, height: layout.height }}>
        <svg
          style={css.svg}
          width={layout.width}
          height={layout.height}
          viewBox={`0 0 ${String(layout.width)} ${String(layout.height)}`}
          role='img'
          aria-label={`${t('tree.title')} ${roundId}`}
        >
          {layout.edges.map(([parentId, childId]) => {
            const from = layout.positions.get(parentId)
            const to = layout.positions.get(childId)
            if (from === undefined || to === undefined) return null
            const best = pathEdges.has(`${parentId}->${childId}`)
            return (
              <line
                key={`${parentId}-${childId}`}
                x1={from.x} y1={from.y} x2={to.x} y2={to.y}
                stroke={best ? BEST_PATH_COLOR : EDGE_COLOR}
                strokeWidth={best ? 2.5 : 1}
                strokeLinecap='round'
                opacity={best === false && emphasized !== undefined ? 0.55 : 1}
              />
            )
          })}
          {layout.order.map((id) => {
            const position = layout.positions.get(id)
            const node = byId.get(id)
            if (position === undefined || node === undefined) return null
            const evaluated = node.evaluated === true && typeof node.score === 'number'
            const fraction = evaluated ? fractionOf(node.score ?? 0) : 0
            const fill = evaluated ? scoreColor(fraction) : NEUTRAL_FILL
            const radius = evaluated ? 5 + fraction * 3 : 4.5
            const highlighted = onPath.has(id)
            return (
              <circle
                key={id}
                cx={position.x} cy={position.y} r={radius}
                fill={fill}
                stroke={node.evaluated === true && node.valid === false
                  ? INVALID_STROKE
                  : highlighted ? BEST_NODE_STROKE : 'transparent'}
                strokeWidth={highlighted || (node.evaluated === true && node.valid === false) ? 2 : 0}
                onMouseEnter={() => { setHover(node) }}
                onMouseLeave={() => { setHover(undefined) }}
                data-dream-rsi-node={id}
                data-dream-rsi-score={node.score === undefined ? '' : String(node.score)}
              />
            )
          })}
          {/* the round's champion node ★ (ratio-era rounds only) */}
          {starNode !== undefined && (() => {
            const position = layout.positions.get(starNode)
            if (position === undefined) return null
            return (
              <text
                x={position.x} y={position.y - 10}
                textAnchor='middle' fontSize={12} fill={BEST_PATH_COLOR}
                data-dream-rsi-tree-star=''
                data-dream-rsi-node={starNode}
              >
                {STAR_GLYPH}
                <title>{t('forest.star', { round: roundId, node: starNode })}</title>
              </text>
            )
          })()}
        </svg>
        <ChartTooltip
          x={hover === undefined ? 0 : layout.positions.get(hover.id)?.x ?? 0}
          y={hover === undefined ? 0 : layout.positions.get(hover.id)?.y ?? 0}
          width={Math.max(layout.width, 1)}
          height={Math.max(layout.height, 1)}
          lines={hover === undefined ? undefined : tooltipLinesOf(hover)}
        />
        </div>
      </div>
      <div style={css.legend}>
        <span style={css.legendChip}>
          <span style={{ ...css.swatch, background: NEUTRAL_FILL }} />
          {t('tree.unscored')}
        </span>
        <span style={css.legendChip}>
          <span style={{ ...css.swatch, background: scoreColor(0) }} />
          {scored.length === 0 ? '—' : scoreText(min)}
        </span>
        <span style={css.legendBar} />
        <span style={css.legendChip}>
          <span style={{ ...css.swatch, background: scoreColor(1) }} />
          {scored.length === 0 ? '—' : scoreText(max)}
        </span>
        {path !== undefined && (
          <span style={css.legendChip}>
            <span style={{ ...css.swatch, background: BEST_PATH_COLOR, borderRadius: 2 }} />
            {t('tree.bestPath')}: {String(path.length)} · {path[path.length - 1] ?? ''}
          </span>
        )}
      </div>
    </div>
  )
}
