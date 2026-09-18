/**
 * Pure iteration progression: every logged discovery attempt across all
 * rounds, the Pareto frontier through them, and the policy-change markers.
 *
 * Input is the flat iteration list the face assembles from the rounds'
 * `nodes.jsonl` (chronological: round order, then file order within each
 * round). Everything here is pure and order-deterministic — no clock, no
 * randomness.
 *
 * @module
 */
import { FLOORED_SCORE } from './read.ts'
import type { NodeRow } from './read.ts'

/** One plotted subpoint: one logged node, at its global iteration index. */
export interface IterationPoint {
  /** Global iteration index (0 = the oldest plotted node). */
  iteration: number
  /** The round the node belongs to. */
  roundId: string
  /** The node's id within its round. */
  nodeId: string
  /** The attempt's mechanism, when recorded. */
  mechanism?: string | undefined
  /** The recorded outcome score (0 for unevaluated roots). */
  score: number
  /** Whether the attempt evaluated validly (unevaluated roots are not valid). */
  valid: boolean
  /** Whether the node was evaluated at all (roots are not). */
  evaluated: boolean
  /** The failure class of an invalid attempt. */
  failClass?: string | undefined
  /** The policy version that logged this node, when recorded. */
  policyVersion?: string | undefined
  /** Whether the score is the −∞ replay floor (drawn clamped, excluded from the domain). */
  floored: boolean
  /** The round's objective era (undefined when the round carries no score to classify). */
  era?: Era | undefined
}

/**
 * The objective era of a round's score scale: scores from different eras are
 * NOT comparable (a 1000/median-ms speed score is not a sum_radii ratio), so
 * the panel tags them and keeps the comparable climb separate.
 */
export type Era = 'ratio' | 'raw'

/**
 * The era threshold: a round whose bestScore exceeds this is a raw-scale
 * legacy probe/toy round; at or below it, the ratio-scale objective era
 * (sum_radii / 2.635). Documented panel constant — 10 sits far above every
 * circle-packing ratio seen (≤ 2.64) and far below every probe score (≥ 50).
 */
export const SCORE_ERA_THRESHOLD = 10

/**
 * Classify one round's score scale (deterministic heuristic).
 * @param bestScore - the round's best score (from round.json stats).
 * @returns the era, or undefined when the round carries no numeric score.
 */
export function eraOf(bestScore: number | undefined): Era | undefined {
  if (typeof bestScore !== 'number' || Number.isNaN(bestScore)) return undefined
  return bestScore > SCORE_ERA_THRESHOLD ? 'raw' : 'ratio'
}

/** A round's nodes as the face read them (one loadNodes outcome). */
export interface RoundNodes {
  roundId: string
  nodes: readonly NodeRow[]
  /** The nodes read hit the page cap before the file's end. */
  truncated: boolean
  /** The round's objective era, classified from its best score. */
  era?: Era | undefined
}

/** One policy-change marker: the first node logged under a new policy version. */
export interface PolicyMarker {
  /** Global iteration index of that first node. */
  iteration: number
  roundId: string
  nodeId: string
  /** The version that took over here. */
  version: string
  /** The version it replaced, when earlier nodes named one. */
  previousVersion?: string | undefined
}

/** The progression model: the subpoints, the Pareto frontier, the markers, the y domain. */
export interface Progression {
  /** Chronological subpoints (every logged node of every round). */
  points: IterationPoint[]
  /**
   * Pareto frontier over VALID attempts only: runningBest[i] = max(score of
   * the valid points[0..i]); monotone non-decreasing where defined. Failed,
   * invalid, and unevaluated attempts never shape it (and a floored −∞ score
   * is invalid by construction). `undefined` before the first valid attempt.
   */
  runningBest: (number | undefined)[]
  /** Policy-change markers in chronological order. */
  markers: PolicyMarker[]
  /** Minimum plotted value over NON-floored scores, before padding. */
  min: number
  /** Maximum plotted value over NON-floored scores, before padding. */
  max: number
  /** How many distinct rounds the points span. */
  rounds: number
}

/**
 * Flatten the per-round node lists into the chronological iteration sequence.
 *
 * Rounds are ordered by round id ascending (r0001 before r0002 — the
 * dashboard carries them newest first, so order here does not depend on the
 * caller); within a round, file order (the append order of nodes.jsonl, i.e.
 * lineage order) is kept.
 * @param rounds - one entry per round, in any order.
 * @returns the iteration sequence and the truncation flag.
 */
export function toIterationNodes(rounds: readonly RoundNodes[]): { iterations: IterationPoint[]; truncated: boolean } {
  const ordered = [...rounds].sort((left, right) => left.roundId < right.roundId ? -1 : left.roundId > right.roundId ? 1 : 0)
  const iterations: IterationPoint[] = []
  let truncated = false
  for (const round of ordered) {
    truncated = truncated || round.truncated
    for (const node of round.nodes) {
      const score = typeof node.score === 'number' && !Number.isNaN(node.score) ? node.score : 0
      const valid = node.valid === true
      iterations.push({
        iteration: iterations.length,
        roundId: round.roundId,
        nodeId: node.id,
        ...(node.mechanism !== undefined ? { mechanism: node.mechanism } : {}),
        score,
        valid,
        evaluated: node.evaluated === true,
        ...(node.failClass !== undefined ? { failClass: node.failClass } : {}),
        ...(node.policyVersion !== undefined ? { policyVersion: node.policyVersion } : {}),
        floored: score <= FLOORED_SCORE / 2,
        ...(round.era !== undefined ? { era: round.era } : {}),
      })
    }
  }
  return { iterations, truncated }
}

/** Which objective eras the progression includes. */
export type EraFilter = 'ratio' | 'raw' | 'all'

/** Options of {@link computeProgression}. */
export interface ProgressionOptions {
  /**
   * Which objective eras to include. `'ratio'` (the comparable climb —
   * sum_radii / 2.635) or `'raw'` (legacy probe/toy rounds) keeps that era
   * only; `'all'` (the default) includes everything. Unclassified rounds
   * (no numeric round score) ride with `'all'` and `'raw'` — they are not
   * provably ratio-scale.
   */
  eraFilter?: EraFilter | undefined
}

/**
 * Compute the progression: the Pareto frontier through every subpoint, the
 * policy markers at iteration indices, and the y domain.
 * @param iterations - the chronological iteration sequence (see {@link toIterationNodes}).
 * @param options - the era filter (default `'all'`).
 * @returns the progression; empty points yield an empty model. Filtering
 *   happens before re-indexing, so iteration indices, markers, and the
 *   domain are always dense over the INCLUDED set.
 */
export function computeProgression(iterations: readonly IterationPoint[], options: ProgressionOptions = {}): Progression {
  const eraFilter = options.eraFilter ?? 'all'
  const included = eraFilter === 'all'
    ? iterations
    : iterations.filter((point) => eraFilter === 'ratio' ? point.era === 'ratio' : point.era !== 'ratio')
  const points: IterationPoint[] = included.map((point, iteration) => ({ ...point, iteration }))

  const markers: PolicyMarker[] = []
  let lastSeenVersion: string | undefined
  for (const point of points) {
    const version = point.policyVersion
    if (version === undefined) continue
    if (lastSeenVersion !== undefined && version !== lastSeenVersion) {
      markers.push({
        iteration: point.iteration,
        roundId: point.roundId,
        nodeId: point.nodeId,
        version,
        previousVersion: lastSeenVersion,
      })
    }
    lastSeenVersion = version
  }

  // Pareto frontier over VALID attempts only (user amendment): failed,
  // invalid, and unevaluated attempts stay visible as subpoints but never
  // shape the line. Undefined until the first valid attempt lands.
  const runningBest: (number | undefined)[] = []
  let best = Number.NEGATIVE_INFINITY
  for (const point of points) {
    if (point.valid && typeof point.score === 'number' && !Number.isNaN(point.score)) {
      best = Math.max(best, point.score)
    }
    runningBest.push(best === Number.NEGATIVE_INFINITY ? undefined : best)
  }

  // Domain over non-floored scores: one −1e12 dot must not flatten the chart.
  const plottable = points.filter(point => !point.floored).map(point => point.score)
  const min = plottable.length > 0 ? Math.min(...plottable) : 0
  const max = plottable.length > 0 ? Math.max(...plottable) : 1
  const rounds = new Set(points.map(point => point.roundId)).size
  return { points, runningBest, markers, min, max, rounds }
}

/**
 * The deterministic round palette: eight evenly spaced hues, cycled by round
 * position (rounds are few; the color says WHICH round a dot came from).
 * @param index - the round's chronological position (0-based).
 * @returns an HSL color string.
 */
export function roundColor(index: number): string {
  const hues = [212, 280, 340, 24, 80, 152, 196, 258]
  const hue = hues[((index % hues.length) + hues.length) % hues.length]
  return `hsl(${String(hue)}, 58%, 48%)`
}

/**
 * Thin a label list to at most {@link X_LABEL_CAP} entries, always keeping
 * the first and last.
 * @param count - the number of labels.
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

/** How many x labels the chart draws at most (thinned evenly). */
export const X_LABEL_CAP = 6
