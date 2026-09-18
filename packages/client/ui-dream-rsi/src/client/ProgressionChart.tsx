/**
 * The progression chart: every logged discovery attempt and the Pareto
 * frontier through them.
 *
 * X is the GLOBAL ITERATION INDEX — one subpoint per logged node across all
 * rounds, chronological (round order, then file order within each round).
 * Valid attempts draw as solid dots, failed/invalid/unevaluated ones as
 * hollow dots (score 0 included — the climb story is honest), both colored
 * by round through a cycled deterministic palette. The headline line is the
 * Pareto frontier: the monotone running maximum, step-drawn. Vertical
 * dashed markers flag the iteration where the active policy version
 * changed. Pure SVG over the precomputed progression model
 * (progression.ts) — no dependencies, no timers, no randomness.
 */
import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { roundColor, thinIndices, X_LABEL_CAP, STAR_GLYPH } from './progression.ts'
import type { IterationPoint, Progression } from './progression.ts'
import { ChartTooltip } from './ChartTooltip.tsx'
import type { ChartTooltipLine } from './ChartTooltip.tsx'
import type {} from './locales.ts'

/** The chart's props: the precomputed model and copy. */
export interface ProgressionChartProps {
  /** The progression model (see computeProgression). */
  progression: Progression
  /** Namespace-bound translate. */
  t: TranslateNS<'dreamRsi'>
}

/**
 * The tooltip model of one subpoint (pure; the styled tooltip renders it).
 * The score keeps FULL precision — the chart's tick text rounds, this does not.
 * @param point - the hovered subpoint.
 * @param championHere - the "champion at this iteration" line, when the point attains.
 * @returns the ordered tooltip lines.
 */
export function tooltipLinesOf(point: IterationPoint, championHere?: string | undefined): ChartTooltipLine[] {
  const score = point.floored ? '−∞' : String(point.score)
  const status = point.evaluated
    ? point.valid ? 'valid' : `failed${point.failClass === undefined ? '' : ` (${point.failClass})`}`
    : 'unscored'
  return [
    { text: `${point.roundId} · ${point.nodeId}`, strong: true },
    ...(point.mechanism !== undefined ? [{ text: point.mechanism }] : []),
    { text: `score: ${score}` },
    { text: status, muted: true },
    ...(point.champion === true && championHere !== undefined ? [{ text: championHere, muted: true }] : []),
  ]
}

/** Chart geometry in viewBox units; the svg scales to the pane width. */
const WIDTH = 640
const HEIGHT = 260
const MARGIN = { top: 26, right: 14, bottom: 24, left: 46 } as const
/** Y-domain padding fraction beyond the data range. */
const Y_PADDING = 0.08

const PARETO_COLOR = '#1f8a5f'
const MARKER_COLOR = '#8e7cc3'
const GRID_COLOR = '#e4e7eb'
const TEXT_COLOR = '#667085'

/** Chart-only inline styles (the section frame is the panel's). */
const css = {
  svg: { display: 'block', width: '100%', height: 'auto' } satisfies React.CSSProperties,
  legend: { display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginTop: 4, fontSize: 11, color: TEXT_COLOR } satisfies React.CSSProperties,
  legendItem: { display: 'inline-flex', alignItems: 'center', gap: 4 } satisfies React.CSSProperties,
  legendLine: { width: 16, height: 0, borderTop: `2px solid ${PARETO_COLOR}`, display: 'inline-block' } satisfies React.CSSProperties,
  legendDot: { width: 8, height: 8, borderRadius: '50%', background: 'hsl(212, 58%, 48%)', display: 'inline-block' } satisfies React.CSSProperties,
  legendHollow: { width: 8, height: 8, borderRadius: '50%', border: '1px solid hsl(212, 58%, 48%)', display: 'inline-block' } satisfies React.CSSProperties,
  legendDash: { width: 16, height: 0, borderTop: `1px dashed ${MARKER_COLOR}`, display: 'inline-block' } satisfies React.CSSProperties,
}

/** Y-tick values: four evenly spaced values across the padded domain. */
function yTicks(min: number, max: number): number[] {
  return [0, 1, 2, 3].map(slot => min + (max - min) * (slot / 3))
}

/** Axis label formatting: compact for wide ranges, precise for narrow ones. */
function tickText(value: number): string {
  const magnitude = Math.abs(value)
  if (magnitude !== 0 && (magnitude >= 10000 || magnitude < 0.01)) return value.toExponential(1)
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 3 }).format(value)
}

/**
 * Draw the iteration scatter with its Pareto frontier.
 * @param props - the progression model and copy.
 * @returns the SVG chart with its legend, or nothing without points.
 */
export function ProgressionChart({ progression, t }: ProgressionChartProps): ReactNode {
  const { points, runningBest, markers, min, max } = progression
  const iterations = points.length
  // The hovered subpoint (the styled tooltip's anchor); undefined = hidden.
  const [hover, setHover] = useState<IterationPoint | undefined>(undefined)
  const hoverLines = useMemo(
    () => (hover === undefined ? undefined : tooltipLinesOf(hover, t('progress.championHere'))),
    [hover, t],
  )
  const hovered = hover === undefined ? undefined : points.find(point => point.nodeId === hover.nodeId && point.roundId === hover.roundId)

  const yMin = min - (max - min) * Y_PADDING
  const yMax = max + (max - min) * Y_PADDING
  const scaleX = (iteration: number): number => iterations <= 1
    ? MARGIN.left + (WIDTH - MARGIN.left - MARGIN.right) / 2
    : MARGIN.left + (WIDTH - MARGIN.left - MARGIN.right) * (iteration / (iterations - 1))
  const scaleY = (value: number): number =>
    HEIGHT - MARGIN.bottom - (HEIGHT - MARGIN.top - MARGIN.bottom) * ((value - yMin) / (yMax - yMin))

  // Round identity for coloring: chronological position of each round's first dot.
  const roundOrder = useMemo(() => {
    const order = new Map<string, number>()
    for (const point of points) {
      if (!order.has(point.roundId)) order.set(point.roundId, order.size)
    }
    return order
  }, [points])

  // X labels at round starts (the first iteration of each round), thinned.
  const roundStarts = useMemo(() => {
    const starts = new Map<string, number>()
    for (const point of points) {
      if (!starts.has(point.roundId)) starts.set(point.roundId, point.iteration)
    }
    return [...starts.entries()].map(([roundId, iteration]) => ({ roundId, iteration }))
  }, [points])
  const keptStarts = useMemo(
    () => new Set(thinIndices(roundStarts.length).map(position => roundStarts[position]?.roundId)),
    [roundStarts],
  )

  const paretoPath = useMemo(() => {
    if (points.length === 0) return ''
    const segments: string[] = []
    let started = false
    let lastValue: number | undefined
    for (let index = 0; index < points.length; index += 1) {
      const value = runningBest[index]
      // Before the first valid attempt the frontier does not exist yet.
      if (value === undefined) continue
      const x = scaleX(index)
      const y = scaleY(value)
      if (!started) {
        segments.push(`M${x.toFixed(1)},${y.toFixed(1)}`)
        started = true
        lastValue = value
        continue
      }
      // hv step: horizontal at the previous frontier value up to this x
      // (carried across invalid gaps), then the jump when it moved.
      if (lastValue !== undefined && lastValue !== value) {
        segments.push(`L${x.toFixed(1)},${scaleY(lastValue).toFixed(1)}`)
      }
      segments.push(`L${x.toFixed(1)},${y.toFixed(1)}`)
      lastValue = value
    }
    return segments.join(' ')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points, min, max])

  if (points.length === 0) return null

  return (
    <div data-dream-rsi='progression' data-dream-rsi-points={String(iterations)}>
      <div style={{ position: 'relative' }}>
      <svg
        style={css.svg}
        viewBox={`0 0 ${String(WIDTH)} ${String(HEIGHT)}`}
        role='img'
        aria-label={t('progress.title')}
      >
        {/* y grid + labels */}
        {yTicks(yMin, yMax).map((value) => {
          const y = scaleY(value)
          return (
            <g key={`tick-${String(value)}`}>
              <line x1={MARGIN.left} y1={y} x2={WIDTH - MARGIN.right} y2={y} stroke={GRID_COLOR} strokeWidth={1} />
              <text x={MARGIN.left - 6} y={y + 3} textAnchor='end' fontSize={9} fill={TEXT_COLOR}>
                {tickText(value)}
              </text>
            </g>
          )
        })}
        {/* x labels at round starts, thinned */}
        {roundStarts.map((start) => keptStarts.has(start.roundId)
          ? (
              <text
                key={`x-${start.roundId}`}
                x={scaleX(start.iteration)} y={HEIGHT - 8}
                textAnchor='middle' fontSize={9} fill={TEXT_COLOR}
              >
                {start.roundId}
              </text>
            )
          : undefined)}
        {/* policy-change markers at iteration indices */}
        {markers.map((marker) => {
          const x = scaleX(marker.iteration)
          return (
            <g key={`marker-${marker.nodeId}`}>
              <line
                x1={x} y1={MARGIN.top - 6} x2={x} y2={HEIGHT - MARGIN.bottom}
                stroke={MARKER_COLOR} strokeWidth={1} strokeDasharray='3,3'
              />
              <text x={x + 3} y={MARGIN.top - 9} fontSize={9} fill={MARKER_COLOR}>
                {marker.version}
              </text>
              <title>{`${marker.roundId}/${marker.nodeId}: ${marker.previousVersion ?? '·'} → ${marker.version}`}</title>
            </g>
          )
        })}
        {/* subpoints: valid solid, failed/invalid/unevaluated hollow; colored by round.
            EVERY subpoint carries the styled hover (the tooltip follows the point). */}
        {points.map((point) => {
          const x = scaleX(point.iteration)
          const clamped = point.floored ? Math.max(yMin, point.score) : point.score
          const y = scaleY(clamped)
          const hue = roundColor(roundOrder.get(point.roundId) ?? 0)
          const solid = point.valid
          return (
            <circle
              key={point.nodeId}
              cx={x} cy={y} r={solid ? 3 : 2.8}
              fill={solid ? hue : 'transparent'}
              stroke={hue}
              strokeWidth={solid ? 0 : 1.2}
              opacity={point.champion === true ? 1 : point.evaluated ? 0.9 : 0.55}
              onMouseEnter={() => { setHover(point) }}
              onMouseLeave={() => { setHover(undefined) }}
              data-dream-rsi-point={point.nodeId}
              data-dream-rsi-round={point.roundId}
              data-dream-rsi-score={String(point.score)}
              data-dream-rsi-valid={String(point.valid)}
              data-dream-rsi-champion={point.champion === true || undefined}
            />
          )
        })}
        {/* the champion lineage: accent ring + larger marker on every attainer */}
        {points.filter(point => point.champion === true).map((point) => {
          const x = scaleX(point.iteration)
          const clamped = point.floored ? Math.max(yMin, point.score) : point.score
          const y = scaleY(clamped)
          return (
            <circle
              key={`champion-${point.nodeId}`}
              cx={x} cy={y} r={6}
              fill='transparent'
              stroke={PARETO_COLOR}
              strokeWidth={2}
              pointerEvents='none'
              data-dream-rsi-champion-ring={point.nodeId}
            />
          )
        })}
        {/* Pareto frontier on top */}
        <path d={paretoPath} fill='none' stroke={PARETO_COLOR} strokeWidth={2.5} strokeLinejoin='round' pointerEvents='none' />
        {/* the final champion's ★ (same glyph as the graphs) */}
        {(() => {
          if (progression.finalChampionIndex === undefined) return null
          const point = points[progression.finalChampionIndex]
          if (point === undefined) return null
          const clamped = point.floored ? Math.max(yMin, point.score) : point.score
          return (
            <text
              x={scaleX(point.iteration)} y={scaleY(clamped) - 10}
              textAnchor='middle' fontSize={12} fill={PARETO_COLOR}
              pointerEvents='none'
              data-dream-rsi-progression-star=''
              data-dream-rsi-node={point.nodeId}
            >
              {STAR_GLYPH}
            </text>
          )
        })()}
      </svg>
      <ChartTooltip
        x={hovered === undefined ? 0 : scaleX(hovered.iteration)}
        y={hovered === undefined ? 0 : scaleY(hovered.floored ? Math.max(yMin, hovered.score) : hovered.score)}
        width={WIDTH}
        height={HEIGHT}
        lines={hovered === undefined ? undefined : hoverLines}
      />
      <div style={css.legend}>
        <span style={css.legendItem}>
          <span style={css.legendLine} />{t('progress.pareto')}
        </span>
        <span style={css.legendItem}>
          <span style={css.legendDot} />{t('progress.valid')}
        </span>
        <span style={css.legendItem}>
          <span style={css.legendHollow} />{t('progress.failed')}
        </span>
        {points.some(point => point.champion === true) && (
          <span style={css.legendItem}>
            <span style={{ ...css.legendDot, background: 'transparent', border: `2px solid ${PARETO_COLOR}`, width: 10, height: 10 }} />
            {t('progress.championLineage')}
          </span>
        )}
        {markers.length > 0 && (
          <span style={css.legendItem}>
            <span style={css.legendDash} />{t('progress.markers')}
          </span>
        )}
      </div>
      {iterations > X_LABEL_CAP && (
        <div style={{ fontSize: 10, color: TEXT_COLOR, marginTop: 2 }}>
          {`${String(iterations)} ${t('progress.attempts')} · ${points[0]?.roundId ?? ''} → ${points[points.length - 1]?.roundId ?? ''}`}
        </div>
      )}
      </div>
    </div>
  )
}
