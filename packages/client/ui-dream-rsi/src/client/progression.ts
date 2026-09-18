/**
 * Pure best-score-over-rounds progression: the climb curve the chart draws.
 *
 * Input is the dashboard's round rows (newest first, exactly as
 * `DashboardData.rounds` carries them); output is chronological. Everything
 * here is pure and order-deterministic — no clock, no randomness.
 *
 * @module
 */
import type { RoundRow } from './read.ts'

/** One plotted round. */
export interface ProgressionPoint {
  /** The round id (x axis). */
  roundId: string
  /** The round's best score (y axis). */
  bestScore: number
  /** The policy the round ran, when the round record names one. */
  policyVersion?: string | undefined
  /** The round's node count, when recorded. */
  nodes?: number | undefined
  /** Chronological position (0 = oldest plotted round). */
  index: number
}

/** One policy-change marker: a round that ran a different policy than every round before it. */
export interface PolicyMarker {
  /** Chronological position of the first round on the new policy. */
  index: number
  roundId: string
  /** The version that started here. */
  version: string
  /** The version it replaced, when the previous rounds named one. */
  previousVersion?: string | undefined
}

/** The progression model: the two series, the markers, and the y domain. */
export interface Progression {
  /** Chronological points (rounds without a numeric bestScore are skipped). */
  points: ProgressionPoint[]
  /** Running best: runningBest[i] = max(bestScore of points[0..i]); monotone non-decreasing. */
  runningBest: number[]
  /** Policy-change markers in chronological order. */
  markers: PolicyMarker[]
  /** Minimum plotted value (data ∪ reference line), before padding. */
  min: number
  /** Maximum plotted value (data ∪ reference line), before padding. */
  max: number
}

/** Options of {@link computeProgression}. */
export interface ProgressionOptions {
  /**
   * A horizontal reference line (the benchmark to beat); it participates in
   * the y domain so the crossing is always in view. Omit for none.
   */
  referenceLine?: number | undefined
}

/**
 * Compute the progression from the dashboard's round rows.
 * @param rounds - round rows, NEWEST first (as `DashboardData.rounds` carries them).
 * @param options - reference-line option.
 * @returns the progression; an empty point list when no round carries a numeric score.
 */
export function computeProgression(
  rounds: readonly RoundRow[],
  options: ProgressionOptions = {},
): Progression {
  const chronological = [...rounds].reverse()
  const points: ProgressionPoint[] = []
  const markers: PolicyMarker[] = []
  let lastSeenVersion: string | undefined
  for (const round of chronological) {
    if (typeof round.bestScore !== 'number' || Number.isNaN(round.bestScore)) continue
    const index = points.length
    const version = round.policyVersion
    points.push({
      roundId: round.roundId,
      bestScore: round.bestScore,
      ...(version !== undefined ? { policyVersion: version } : {}),
      ...(round.nodes !== undefined ? { nodes: round.nodes } : {}),
      index,
    })
    // A round without a recorded version neither creates nor clears a marker:
    // the change is attributed to the next round that names its policy.
    if (version !== undefined) {
      if (lastSeenVersion !== undefined && version !== lastSeenVersion) {
        markers.push({ index, roundId: round.roundId, version, previousVersion: lastSeenVersion })
      }
      lastSeenVersion = version
    }
  }

  const runningBest: number[] = []
  let best = Number.NEGATIVE_INFINITY
  for (const point of points) {
    best = Math.max(best, point.bestScore)
    runningBest.push(best)
  }

  const values = points.map(point => point.bestScore)
  if (typeof options.referenceLine === 'number' && Number.isFinite(options.referenceLine)) {
    values.push(options.referenceLine)
  }
  const min = values.length > 0 ? Math.min(...values) : 0
  const max = values.length > 0 ? Math.max(...values) : 1
  return { points, runningBest, markers, min, max }
}

/**
 * The reference value the chart draws for this repo's benchmark campaign: the
 * published AlphaEvolve/OpenEvolve circle-packing value the campaign matched.
 */
export const REFERENCE_SCORE = 2.635

/** How many x labels the chart draws at most (thinned evenly). */
export const X_LABEL_CAP = 6

/**
 * Thin a label list to at most {@link X_LABEL_CAP} entries, always keeping
 * the first and last.
 * @param labels - the labels in plot order.
 * @returns the kept indices, ascending.
 */
export function thinIndices(count: number): number[] {
  if (count <= 0) return []
  if (count <= X_LABEL_CAP) return Array.from({ length: count }, (_, index) => index)
  const kept = new Set<number>([0, count - 1])
  const stride = (count - 1) / (X_LABEL_CAP - 1)
  for (let slot = 1; slot < X_LABEL_CAP - 1; slot += 1) {
    kept.add(Math.round(slot * stride))
  }
  return [...kept].sort((left, right) => left - right)
}
