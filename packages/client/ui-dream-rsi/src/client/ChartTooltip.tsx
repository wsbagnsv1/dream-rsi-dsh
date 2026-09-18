/**
 * The styled hover tooltip for the SVG charts: a positioned HTML div
 * overlaying the svg, following the hovered point.
 *
 * Replaces the native `<title>` (≈1 s browser delay, easy to miss) with an
 * immediate dark box. Positioning is percentage-based against the svg's
 * viewBox so it tracks the point at any rendered scale, and it is CLAMPED
 * inside the pane (flipping below the point near the top edge, pulling the
 * horizontal anchor inward near the sides) so it never flickers or
 * overflows at the edges. Pure presentation: the caller owns the hover
 * state and passes the field lines.
 */
import type { ReactNode } from 'react'

/** One rendered line of the tooltip. */
export interface ChartTooltipLine {
  text: string
  /** The first line renders bold (the identity line). */
  strong?: boolean | undefined
  /** Muted styling (notes, secondary facts). */
  muted?: boolean | undefined
}

/** The tooltip's props: the anchor in viewBox units, the canvas, the lines. */
export interface ChartTooltipProps {
  /** Anchor x in viewBox units. */
  x: number
  /** Anchor y in viewBox units. */
  y: number
  /** The svg's viewBox width. */
  width: number
  /** The svg's viewBox height. */
  height: number
  /** The rendered lines; undefined renders nothing. */
  lines: readonly ChartTooltipLine[] | undefined
}

/** Horizontal anchor clamp (percent of the canvas) so the box stays inside. */
const LEFT_CLAMP = 14
const RIGHT_CLAMP = 86
/** Below this top percent the box flips under the anchor instead of above. */
const FLIP_BELOW = 16

const css = {
  tooltip: {
    position: 'absolute',
    transform: 'translate(-50%, calc(-100% - 10px))',
    background: 'rgba(28, 32, 38, 0.94)',
    color: '#e8eaed',
    borderRadius: 6,
    padding: '6px 9px',
    fontSize: 11,
    lineHeight: 1.45,
    pointerEvents: 'none',
    whiteSpace: 'nowrap',
    zIndex: 5,
    boxShadow: '0 2px 8px rgba(0,0,0,0.35)',
  } satisfies React.CSSProperties,
  tooltipBelow: {
    transform: 'translate(-50%, 12px)',
  } satisfies React.CSSProperties,
  strong: { fontWeight: 600 } satisfies React.CSSProperties,
  muted: { color: '#9aa3ad' } satisfies React.CSSProperties,
}

/**
 * Render the tooltip box for one hovered anchor.
 * @param props - anchor (viewBox units), canvas size, and the lines.
 * @returns the absolutely-positioned tooltip, or nothing without lines.
 */
export function ChartTooltip(props: {
  x: number
  y: number
  width: number
  height: number
  lines: readonly ChartTooltipLine[] | undefined
}): ReactNode {
  const { x, y, width, height, lines } = props
  if (lines === undefined || lines.length === 0) return null
  const leftPercent = Math.min(RIGHT_CLAMP, Math.max(LEFT_CLAMP, (x / width) * 100))
  const topPercent = (y / height) * 100
  const below = topPercent < FLIP_BELOW
  return (
    <div
      style={{
        ...css.tooltip,
        ...(below ? css.tooltipBelow : {}),
        left: `${leftPercent.toFixed(2)}%`,
        top: `${topPercent.toFixed(2)}%`,
      }}
      data-dream-rsi-tooltip=''
      role='status'
    >
      {lines.map((line, index) => (
        <div key={`${String(index)}-${line.text}`} style={line.strong === true ? css.strong : line.muted === true ? css.muted : undefined}>
          {line.text}
        </div>
      ))}
    </div>
  )
}
