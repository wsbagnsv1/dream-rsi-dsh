/**
 * The progression chart: how fast the optimization climbs.
 *
 * Two series over the same x (rounds, chronological): the per-round best
 * (thin line + hoverable points) and the running best (the monotone step
 * line — the climb curve). A dashed horizontal reference line marks the
 * benchmark to beat, and dashed vertical markers flag rounds where the
 * active policy version changed. Pure SVG over the precomputed progression
 * model (progression.ts) — no dependencies, no timers, no randomness.
 */
import { useMemo } from 'react'
import type { ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { REFERENCE_SCORE, thinIndices, X_LABEL_CAP } from './progression.ts'
import type { Progression } from './progression.ts'
import type {} from './locales.ts'

/** The chart's props: the precomputed model and copy. */
export interface ProgressionChartProps {
  /** The progression model (see computeProgression). */
  progression: Progression
  /** Namespace-bound translate. */
  t: TranslateNS<'dreamRsi'>
}

/** Chart geometry in viewBox units; the svg scales to the pane width. */
const WIDTH = 640
const HEIGHT = 240
const MARGIN = { top: 26, right: 14, bottom: 24, left: 46 } as const
/** Y-domain padding fraction beyond the data range. */
const Y_PADDING = 0.08

const PER_ROUND_COLOR = '#7a8694'
const RUNNING_COLOR = '#1f8a5f'
const REFERENCE_COLOR = '#b8860b'
const MARKER_COLOR = '#8e7cc3'
const GRID_COLOR = '#e4e7eb'
const TEXT_COLOR = '#667085'

/** Chart-only inline styles (the section frame is the panel's). */
const css = {
  svg: { display: 'block', width: '100%', height: 'auto' } satisfies React.CSSProperties,
  legend: { display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginTop: 4, fontSize: 11, color: TEXT_COLOR } satisfies React.CSSProperties,
  legendItem: { display: 'inline-flex', alignItems: 'center', gap: 4 } satisfies React.CSSProperties,
  legendLine: { width: 16, height: 0, borderTop: `2px solid ${RUNNING_COLOR}`, display: 'inline-block' } satisfies React.CSSProperties,
  legendThin: { width: 16, height: 0, borderTop: `1px solid ${PER_ROUND_COLOR}`, display: 'inline-block' } satisfies React.CSSProperties,
  legendDash: { width: 16, height: 0, borderTop: `1px dashed ${REFERENCE_COLOR}`, display: 'inline-block' } satisfies React.CSSProperties,
  legendDot: { width: 8, height: 8, borderRadius: '50%', background: MARKER_COLOR, display: 'inline-block' } satisfies React.CSSProperties,
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
 * Draw the climb curve.
 * @param props - the progression model and copy.
 * @returns the SVG chart with its legend, or nothing without points.
 */
export function ProgressionChart({ progression, t }: ProgressionChartProps): ReactNode {
  const { points, runningBest, markers, min, max } = progression
  const hasReference = Number.isFinite(REFERENCE_SCORE)
  const yMin = min - (max - min) * Y_PADDING
  const yMax = max + (max - min) * Y_PADDING

  const scaleX = (index: number): number => points.length <= 1
    ? MARGIN.left + (WIDTH - MARGIN.left - MARGIN.right) / 2
    : MARGIN.left + (WIDTH - MARGIN.left - MARGIN.right) * (index / (points.length - 1))
  const scaleY = (value: number): number =>
    HEIGHT - MARGIN.bottom - (HEIGHT - MARGIN.top - MARGIN.bottom) * ((value - yMin) / (yMax - yMin))

  const perRoundPath = useMemo(
    () => points.map((point, index) => `${index === 0 ? 'M' : 'L'}${scaleX(index).toFixed(1)},${scaleY(point.bestScore).toFixed(1)}`).join(' '),
    // Recomputed only when the model changes; scaleX/scaleY are pure over it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [points, min, max],
  )
  const runningPath = useMemo(() => {
    if (points.length === 0) return ''
    const segments: string[] = [`M${scaleX(0).toFixed(1)},${scaleY(runningBest[0] ?? 0).toFixed(1)}`]
    for (let index = 1; index < points.length; index += 1) {
      const previous = runningBest[index - 1] ?? 0
      const current = runningBest[index] ?? 0
      const x = scaleX(index)
      // hv step: horizontal at the previous running best, then vertical jump.
      segments.push(`L${x.toFixed(1)},${scaleY(previous).toFixed(1)}`)
      segments.push(`L${x.toFixed(1)},${scaleY(current).toFixed(1)}`)
    }
    return segments.join(' ')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points, min, max])

  if (points.length === 0) return null
  const referenceY = hasReference ? scaleY(REFERENCE_SCORE) : 0
  const labelIndices = new Set(thinIndices(points.length))

  const tooltipOf = (index: number): string => {
    const point = points[index]
    if (point === undefined) return ''
    const lines = [
      point.roundId,
      `${t('rounds.best')}: ${tickText(point.bestScore)}`,
      point.policyVersion === undefined ? undefined : `${t('rounds.policy')}: ${point.policyVersion}`,
      point.nodes === undefined ? undefined : `${t('rounds.nodes')}: ${String(point.nodes)}`,
      `${t('progress.runningBest')}: ${tickText(runningBest[index] ?? point.bestScore)}`,
    ]
    return lines.filter(line => line !== undefined).join('\n')
  }

  return (
    <div data-dream-rsi='progression' data-dream-rsi-points={String(points.length)}>
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
        {/* x labels, thinned */}
        {points.map((point, index) => labelIndices.has(index)
          ? (
              <text
                key={`x-${point.roundId}`}
                x={scaleX(index)} y={HEIGHT - 8}
                textAnchor='middle' fontSize={9} fill={TEXT_COLOR}
              >
                {point.roundId}
              </text>
            )
          : undefined)}
        {/* policy-change markers */}
        {markers.map((marker) => {
          const x = scaleX(marker.index)
          return (
            <g key={`marker-${marker.roundId}`}>
              <line
                x1={x} y1={MARGIN.top - 6} x2={x} y2={HEIGHT - MARGIN.bottom}
                stroke={MARKER_COLOR} strokeWidth={1} strokeDasharray='3,3'
              />
              <text x={x + 3} y={MARGIN.top - 9} fontSize={9} fill={MARKER_COLOR}>
                {marker.version}
              </text>
              <title>{`${marker.roundId}: ${marker.previousVersion ?? '·'} → ${marker.version}`}</title>
            </g>
          )
        })}
        {/* reference line */}
        {hasReference && (
          <g>
            <line
              x1={MARGIN.left} y1={referenceY} x2={WIDTH - MARGIN.right} y2={referenceY}
              stroke={REFERENCE_COLOR} strokeWidth={1.5} strokeDasharray='6,4'
            />
            <text x={WIDTH - MARGIN.right - 4} y={referenceY - 4} textAnchor='end' fontSize={10} fill={REFERENCE_COLOR}>
              {t('progress.reference', { score: tickText(REFERENCE_SCORE) })}
            </text>
          </g>
        )}
        {/* per-round best */}
        <path d={perRoundPath} fill='none' stroke={PER_ROUND_COLOR} strokeWidth={1} opacity={0.9} />
        {/* running best (the climb curve) */}
        <path d={runningPath} fill='none' stroke={RUNNING_COLOR} strokeWidth={2.5} strokeLinejoin='round' />
        {/* hoverable points */}
        {points.map((point, index) => (
          <circle
            key={point.roundId}
            cx={scaleX(index)} cy={scaleY(point.bestScore)} r={3.5}
            fill={PER_ROUND_COLOR}
            data-dream-rsi-point={point.roundId}
            data-dream-rsi-best={String(point.bestScore)}
          >
            <title>{tooltipOf(index)}</title>
          </circle>
        ))}
      </svg>
      <div style={css.legend}>
        <span style={css.legendItem}>
          <span style={css.legendLine} />{t('progress.runningBest')}
        </span>
        <span style={css.legendItem}>
          <span style={css.legendThin} />{t('progress.perRound')}
        </span>
        <span style={css.legendItem}>
          <span style={css.legendDash} />{t('progress.reference', { score: tickText(REFERENCE_SCORE) })}
        </span>
        {markers.length > 0 && (
          <span style={css.legendItem}>
            <span style={css.legendDot} />{t('progress.markers')}
          </span>
        )}
      </div>
      {points.length > X_LABEL_CAP && (
        <div style={{ fontSize: 10, color: TEXT_COLOR, marginTop: 2 }}>
          {`${String(points.length)} · ${points[0]?.roundId ?? ''} → ${points[points.length - 1]?.roundId ?? ''}`}
        </div>
      )}
    </div>
  )
}
