/**
 * The global discovery forest: every round's tree in its own band, bands
 * left→right chronologically, with the cross-round champion lineage
 * highlighted end-to-end.
 *
 * Rendering over the pure forest layout (forest-layout.ts, which reuses the
 * W2 tidy-tree per band): subtle separators + round-id labels between bands,
 * nodes colored by the same score gradient with failed attempts dimmed, the
 * global best path (each round's best chain, concatenated) emphasized, and
 * native `<title>` hover tooltips. No dependencies, no randomness.
 */
import { useMemo } from 'react'
import type { ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { FLOORED_SCORE } from './read.ts'
import type { NodeRow } from './read.ts'
import { layoutForest } from './forest-layout.ts'
import type { ForestRound } from './forest-layout.ts'
import { scoreColor } from './tree-layout.ts'
import type {} from './locales.ts'

/** The forest's props: every round's nodes and the copy. */
export interface ForestGraphProps {
  /** One entry per round (any order; the layout sorts chronologically). */
  rounds: readonly ForestRound[]
  /** Namespace-bound translate. */
  t: TranslateNS<'dreamRsi'>
}

/** Forest geometry: the global canvas scales to the pane width. */
const SCALE = 0.62
const BAND_GAP = 44
const OFFSET_Y = 26

const EDGE_COLOR = '#b9c0c9'
const BEST_PATH_COLOR = '#1f8a5f'
const NEUTRAL_FILL = '#9aa3ad'
const BAND_COLOR = '#d4d9df'
const TEXT_COLOR = '#667085'

const css = {
  graphScroll: { overflowX: 'auto', overflowY: 'hidden' } satisfies React.CSSProperties,
  svg: { display: 'block' } satisfies React.CSSProperties,
  legend: { display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginTop: 4, fontSize: 11, color: TEXT_COLOR } satisfies React.CSSProperties,
  legendItem: { display: 'inline-flex', alignItems: 'center', gap: 4 } satisfies React.CSSProperties,
  legendLine: { width: 16, height: 0, borderTop: `2px solid ${BEST_PATH_COLOR}`, display: 'inline-block' } satisfies React.CSSProperties,
  swatch: { width: 9, height: 9, borderRadius: '50%', display: 'inline-block' } satisfies React.CSSProperties,
}

/** Score formatter for tooltips. */
function scoreText(score: number | undefined, floored: boolean): string {
  if (floored) return '−∞'
  if (score === undefined) return '—'
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 }).format(score)
}

/**
 * Draw the whole accumulated discovery forest.
 * @param props - the rounds and copy.
 * @returns the banded SVG forest with its legend, or nothing without nodes.
 */
export function ForestGraph({ rounds, t }: ForestGraphProps): ReactNode {
  const layout = useMemo(() => layoutForest(rounds, { bandGap: BAND_GAP, offsetY: OFFSET_Y }), [rounds])
  const byKey = useMemo(() => {
    const map = new Map<string, NodeRow>()
    for (const round of rounds) {
      for (const node of round.nodes) map.set(`${round.roundId}/${node.id}`, node)
    }
    return map
  }, [rounds])
  const onGlobalPath = useMemo(() => new Set(layout.globalBestPath.length > 0
    ? layout.bands.flatMap(band => {
        // A path segment is global-best only when it climbs to the band's
        // own champion — every round's best chain is part of the lineage.
        return band.bestPath.map(nodeId => `${band.roundId}/${nodeId}`)
      })
    : []), [layout])

  const totalNodes = layout.positions.size
  if (totalNodes === 0) return null

  const tooltipOf = (node: NodeRow, roundId: string): string => {
    const floored = typeof node.score === 'number' && node.score <= FLOORED_SCORE / 2
    const lines = [
      `${roundId} · ${node.id}`,
      node.mechanism,
      node.summary,
      `${t('rounds.best')}: ${scoreText(node.score, floored)}`,
      node.evaluated === true
        ? node.valid === true ? t('progress.valid') : `${t('progress.failed')}${node.failClass === undefined ? '' : ` (${node.failClass})`}`
        : t('tree.unscored'),
    ]
    return lines.filter(line => line !== undefined).join('\n')
  }

  return (
    <div data-dream-rsi='forest' data-dream-rsi-bands={String(layout.bands.length)}>
      <div style={css.graphScroll}>
        <svg
          style={css.svg}
          width={layout.width * SCALE}
          height={layout.height * SCALE}
          viewBox={`0 0 ${String(layout.width)} ${String(layout.height)}`}
          role='img'
          aria-label={t('forest.title')}
        >
          {/* band separators */}
          {layout.separators.map((x) => (
            <line
              key={`sep-${String(x)}`}
              x1={x} y1={4} x2={x} y2={layout.height - 4}
              stroke={BAND_COLOR} strokeWidth={1} strokeDasharray='2,4'
            />
          ))}
          {/* band labels */}
          {layout.bands.map((band) => (
            <text
              key={`label-${band.roundId}`}
              x={band.x + band.layout.width / 2} y={12}
              textAnchor='middle' fontSize={10} fill={TEXT_COLOR}
              data-dream-rsi-band={band.roundId}
            >
              {band.roundId}{band.truncated ? ' …' : ''}
            </text>
          ))}
          {/* edges */}
          {layout.bands.map((band) => band.layout.edges.map(([parentId, childId]) => {
            const from = layout.positions.get(`${band.roundId}/${parentId}`)
            const to = layout.positions.get(`${band.roundId}/${childId}`)
            if (from === undefined || to === undefined) return null
            const best = onGlobalPath.has(`${band.roundId}/${parentId}`)
              && onGlobalPath.has(`${band.roundId}/${childId}`)
            return (
              <line
                key={`${band.roundId}/${parentId}-${childId}`}
                x1={from.x} y1={from.y} x2={to.x} y2={to.y}
                stroke={best ? BEST_PATH_COLOR : EDGE_COLOR}
                strokeWidth={best ? 2.2 : 1}
                strokeLinecap='round'
                opacity={best ? 1 : 0.55}
              />
            )
          }))}
          {/* nodes */}
          {layout.bands.map((band) => band.layout.order.map((nodeId) => {
            const position = layout.positions.get(`${band.roundId}/${nodeId}`)
            const node = byKey.get(`${band.roundId}/${nodeId}`)
            if (position === undefined || node === undefined) return null
            const floored = typeof node.score === 'number' && node.score <= FLOORED_SCORE / 2
            const evaluated = node.evaluated === true && typeof node.score === 'number' && !floored
            const fill = evaluated ? scoreColor(node.score ?? 0) : NEUTRAL_FILL
            const dimmed = node.evaluated === true && node.valid === false
            const onPath = onGlobalPath.has(`${band.roundId}/${nodeId}`)
            return (
              <circle
                key={`${band.roundId}/${nodeId}`}
                cx={position.x} cy={position.y} r={evaluated ? 4.5 : 4}
                fill={fill}
                opacity={dimmed ? 0.4 : onPath ? 1 : 0.85}
                stroke={onPath ? BEST_PATH_COLOR : 'transparent'}
                strokeWidth={onPath ? 1.8 : 0}
                data-dream-rsi-node={nodeId}
                data-dream-rsi-round={band.roundId}
                data-dream-rsi-score={node.score === undefined ? '' : String(node.score)}
              >
                <title>{tooltipOf(node, band.roundId)}</title>
              </circle>
            )
          }))}
        </svg>
      </div>
      <div style={css.legend}>
        <span style={css.legendItem}>
          <span style={css.legendLine} />{t('forest.bestPath')}
        </span>
        <span style={css.legendItem}>
          <span style={{ ...css.swatch, background: scoreColor(0) }} />
          <span style={{ ...css.swatch, background: scoreColor(1), marginLeft: -8 }} />
          {t('forest.scoreGradient')}
        </span>
        <span style={css.legendItem}>
          <span style={{ ...css.swatch, background: NEUTRAL_FILL, opacity: 0.5 }} />
          {t('progress.failed')}
        </span>
      </div>
    </div>
  )
}
