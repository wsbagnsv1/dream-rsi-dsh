/**
 * Dreaming-based policy improvement (spec §6): PolicyDsl validation, the
 * deterministic policy interpreter, the replay-scoring dream loop (Eq. 1 with
 * the §5.3 batch-diversity parallelism term), and selection with
 * no-regression guards.
 *
 * The policy-development agent is the CALLING model, never this plugin: the
 * plugin only validates, interprets, scores, and reports. Everything here is
 * deterministic — identical inputs (same worlds, candidate DSLs, config)
 * produce byte-identical reports.
 *
 * @module
 */

import {
  batchDiversity,
  checkBatchRecords,
  commitReveals,
  computeNormalization,
  initObserved,
  isExhausted,
  normalizeScore,
  step,
  type ActionDescriptor,
  type BranchRole,
  type EstimateContext,
  type Normalization,
  type ReplayWorld,
  type StructuralAnchor,
} from './replay.ts'
import { FAIL_CLASSES, type DreamRankingEntry, type DreamReport, type FailClass, type NodeRecord, type PluginConfig, type PolicyDsl, type Reveal, type ReplayStopReason, type WorldReplayResult } from './types.ts'

/** Score assigned to candidates that produced an illegal batch or invalid DSL. */
export const INVALID_SCORE = -1e12

// ---------------------------------------------------------------------------
// DSL validation (spec §6.1 "schema + invariants")
// ---------------------------------------------------------------------------

/** Result of {@link validatePolicyDsl}. */
export interface DslValidation {
  ok: boolean
  errors: string[]
  warnings: string[]
}

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0

/**
 * Validate a candidate policy object against the PolicyDsl schema and
 * invariants: `W ≥ 1`, `beta ∈ [0,1]`, non-negative quotas summing ≤ 1,
 * non-negative finite ranking weights, known fail-class names, positive
 * stopping thresholds, and a bounded `guidance` string.
 */
export function validatePolicyDsl(candidate: unknown): DslValidation {
  const errors: string[] = []
  const warnings: string[] = []
  if (typeof candidate !== 'object' || candidate === null) {
    return { ok: false, errors: ['candidate must be a PolicyDsl object'], warnings }
  }
  const dsl = candidate as Record<string, unknown>
  if (!isNonEmptyString(dsl.name)) errors.push('name must be a non-empty string')

  if (!isFiniteNumber(dsl.W) || !Number.isInteger(dsl.W) || dsl.W < 1) {
    errors.push('W must be an integer ≥ 1 (max parallelism)')
  }
  if (!isFiniteNumber(dsl.beta) || dsl.beta < 0 || dsl.beta > 1) {
    errors.push('beta must be a number in [0, 1]')
  }

  const grid = dsl.gridPlan as Record<string, unknown> | undefined
  if (typeof grid !== 'object' || grid === null) {
    errors.push('gridPlan is required')
  } else {
    if (!isFiniteNumber(grid.branchCount) || !Number.isInteger(grid.branchCount) || grid.branchCount < 1) {
      errors.push('gridPlan.branchCount must be an integer ≥ 1')
    }
    if (!isFiniteNumber(grid.refineCount) || !Number.isInteger(grid.refineCount) || grid.refineCount < 0) {
      errors.push('gridPlan.refineCount must be an integer ≥ 0')
    }
    if (!isNonEmptyString(grid.reason)) errors.push('gridPlan.reason must be a non-empty factual reason')
  }

  const portfolio = dsl.portfolio as Record<string, unknown> | undefined
  if (typeof portfolio !== 'object' || portfolio === null) {
    errors.push('portfolio is required')
  } else {
    const exploitation = portfolio.exploitationShare
    const exploration = portfolio.explorationShare
    if (!isFiniteNumber(exploitation) || exploitation < 0) errors.push('portfolio.exploitationShare must be ≥ 0')
    if (!isFiniteNumber(exploration) || exploration < 0) errors.push('portfolio.explorationShare must be ≥ 0')
    if (isFiniteNumber(exploitation) && isFiniteNumber(exploration) && exploitation + exploration > 1) {
      errors.push('portfolio.exploitationShare + explorationShare must be ≤ 1')
    }
    if (!isFiniteNumber(portfolio.recoverySlots) || portfolio.recoverySlots < 0 || portfolio.recoverySlots > 1) {
      errors.push('portfolio.recoverySlots must be a number in [0, 1] (at most one recovery per batch)')
    }
  }

  const ranking = dsl.ranking as Record<string, unknown> | undefined
  if (typeof ranking !== 'object' || ranking === null) {
    errors.push('ranking is required')
  } else {
    for (const key of ['anchorScore', 'parentChildGain', 'trend', 'recoverability', 'remainingDepth', 'recency'] as const) {
      if (!isFiniteNumber(ranking[key]) || ranking[key] < 0) {
        errors.push(`ranking.${key} must be a finite number ≥ 0`)
      }
    }
  }

  const pruning = dsl.pruning as Record<string, unknown> | undefined
  if (typeof pruning !== 'object' || pruning === null) {
    errors.push('pruning is required')
  } else {
    for (const key of ['repairableClasses', 'hardFailClasses'] as const) {
      const list = pruning[key]
      if (!Array.isArray(list) || list.some((entry) => typeof entry !== 'string')) {
        errors.push(`pruning.${key} must be an array of failClass strings`)
      } else {
        for (const entry of list as string[]) {
          if (!(FAIL_CLASSES as readonly string[]).includes(entry)) {
            errors.push(`pruning.${key} contains unknown failClass "${entry}"`)
          }
        }
      }
    }
    if (!isFiniteNumber(pruning.closeAfterConsecutiveFailures) || pruning.closeAfterConsecutiveFailures < 1) {
      errors.push('pruning.closeAfterConsecutiveFailures must be ≥ 1')
    }
    if (!isFiniteNumber(pruning.minEvidenceForClosure) || pruning.minEvidenceForClosure < 1) {
      errors.push('pruning.minEvidenceForClosure must be ≥ 1')
    }
  }

  const stopping = dsl.stopping as Record<string, unknown> | undefined
  if (typeof stopping !== 'object' || stopping === null) {
    errors.push('stopping is required')
  } else {
    if (!isFiniteNumber(stopping.stagnationRounds) || stopping.stagnationRounds < 1) {
      errors.push('stopping.stagnationRounds must be ≥ 1')
    }
    if (!isFiniteNumber(stopping.maxRoundsK2) || !Number.isInteger(stopping.maxRoundsK2) || stopping.maxRoundsK2 < 1) {
      errors.push('stopping.maxRoundsK2 must be an integer ≥ 1')
    }
  }

  if (typeof dsl.guidance !== 'string') {
    errors.push('guidance must be a string (keep it short, weak, or empty)')
  } else if (dsl.guidance.length > 200) {
    warnings.push('guidance is long; the paper found strong directional guidance harmful — keep it short/weak/empty')
  } else if (dsl.guidance.length === 0) {
    // Preferred shape; nothing to report.
  }

  if (dsl.novel !== undefined) {
    const novel = dsl.novel as Record<string, unknown>
    if (typeof novel !== 'object' || novel === null) {
      errors.push('novel must be an object { mechanism, tags, summary }')
    } else {
      if (!isNonEmptyString(novel.mechanism)) errors.push('novel.mechanism must be a non-empty string')
      if (typeof novel.summary !== 'string' || novel.summary.length === 0) errors.push('novel.summary must be a non-empty string')
      if (!Array.isArray(novel.tags) || novel.tags.some((tag) => typeof tag !== 'string')) {
        errors.push('novel.tags must be an array of strings')
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings }
}

/** The bootstrap policy registered when the store has no versions yet. */
export function defaultPolicyDsl(config: PluginConfig): PolicyDsl {
  return {
    name: 'bootstrap-balanced',
    W: 4,
    gridPlan: {
      branchCount: 4,
      refineCount: 4,
      reason: 'bootstrap: no replay history yet; balanced 4x4 branch/depth grid',
    },
    // Listing 2 cross-cycle rule: history insufficient → moderately exploratory 0.6.
    beta: 0.6,
    portfolio: { exploitationShare: 0.5, explorationShare: 0.5, recoverySlots: 1 },
    ranking: { anchorScore: 1, parentChildGain: 1, trend: 1, recoverability: 1, remainingDepth: 1, recency: 0.5 },
    pruning: {
      // Defaults favor repairability (spec §11.10): Listing 2 treats compile,
      // runtime, correctness, and resource failures as normally repairable.
      repairableClasses: ['compile', 'runtime', 'correctness', 'resource'],
      hardFailClasses: [],
      closeAfterConsecutiveFailures: 3,
      minEvidenceForClosure: 2,
    },
    stopping: { stagnationRounds: 4, maxRoundsK2: config.maxReplayRounds },
    guidance: '',
  }
}

// ---------------------------------------------------------------------------
// Policy interpreter (spec §6.1): trajectories → ranking → pruning → portfolio
// ---------------------------------------------------------------------------

/** Reconstructed trajectory of one opened branch within the observed prefix. */
export interface BranchView {
  branchId: number
  /** Revealed chain from the branch start down to the frontier. */
  chain: NodeRecord[]
  frontier: NodeRecord | null
  /** Best successful anchor: max score among successful evaluations (failClass ok). */
  bestAnchor: number | null
  lastScore: number | null
  lastDeltaVsParent: number | null
  /** Slope of first→last evaluated score along the chain (0 when < 2 points). */
  trend: number
  /** Trailing run of failed attempts (unevaluated counts as failed). */
  consecutiveFailures: number
  attempts: number
  /** Attempts since the best anchor was set (all attempts when never improved). */
  roundsSinceImprovement: number
  lastFailureClass: FailClass | null
  /** `lineage.seq` of the branch start — recency anchor. */
  openedAtSeq: number
}

/** Whether an attempt's outcome counts as a failure (spec §11.4: unevaluated = score 0). */
function isFailure(node: NodeRecord): boolean {
  return !node.outcome.evaluated || node.outcome.failClass !== 'ok'
}

/** Whether an attempt is a successful evaluation (Listing 2 success semantics). */
function isSuccess(node: NodeRecord): boolean {
  return node.outcome.evaluated && node.outcome.failClass === 'ok' && node.outcome.error === null
}

/**
 * Reconstruct branch trajectories from the observed prefix. Branch identity
 * follows the recorded `state.branchId`; the chain order follows the linear
 * parent→child links (each non-root node has ≤ 1 child, spec §0).
 */
export function buildBranchViews(world: ReplayWorld, revealed: ReadonlyMap<string, Reveal>): BranchView[] {
  const byBranch = new Map<number, NodeRecord[]>()
  for (const reveal of revealed.values()) {
    const node = reveal.node
    if (node.kind !== 'attempt') continue
    const list = byBranch.get(node.state.branchId) ?? []
    list.push(node)
    byBranch.set(node.state.branchId, list)
  }
  const views: BranchView[] = []
  for (const [branchId, nodesRaw] of byBranch) {
    // The frontier is the one revealed chain node whose recorded child is not
    // (yet) revealed — either it has none (chain end) or it is unrevealed.
    const byId = new Map(nodesRaw.map((node) => [node.id, node]))
    let frontier: NodeRecord | undefined
    for (const node of nodesRaw) {
      const childId = world.childOf.get(node.id)
      const childRevealed = childId !== undefined && byId.has(childId)
      if (!childRevealed) {
        frontier = node
        break
      }
    }
    if (!frontier) continue
    const chain: NodeRecord[] = [frontier]
    let cursor: NodeRecord | undefined = frontier
    while (cursor !== undefined) {
      const parentId: string | null = cursor.parentId
      const parent: NodeRecord | undefined = parentId !== null ? byId.get(parentId) : undefined
      if (parent === undefined) break
      chain.unshift(parent)
      cursor = parent
    }
    const evaluated = chain.filter((node) => node.outcome.evaluated)
    const successful = chain.filter((node) => isSuccess(node))
    const bestAnchor = successful.length > 0 ? Math.max(...successful.map((node) => node.outcome.score)) : null
    const last = chain[chain.length - 1]
    const firstScore = evaluated.length > 0 ? evaluated[0]?.outcome.score ?? null : null
    const lastScore = last ? last.outcome.score : null
    const trend = evaluated.length >= 2 && firstScore !== null && lastScore !== null
      ? (lastScore - firstScore) / (evaluated.length - 1)
      : 0
    let consecutiveFailures = 0
    for (let i = chain.length - 1; i >= 0; i--) {
      const node = chain[i]
      if (node && isFailure(node)) consecutiveFailures += 1
      else break
    }
    const anchorIdx = bestAnchor !== null
      ? chain.findIndex((node) => isSuccess(node) && node.outcome.score === bestAnchor)
      : -1
    const roundsSinceImprovement = anchorIdx >= 0 ? chain.length - 1 - anchorIdx : chain.length
    const lastFailureClass = last && isFailure(last) ? last.outcome.failClass : null
    views.push({
      branchId,
      chain,
      frontier: last ?? null,
      bestAnchor,
      lastScore,
      lastDeltaVsParent: last?.outcome.deltaVsParent ?? null,
      trend,
      consecutiveFailures,
      attempts: chain.length,
      roundsSinceImprovement,
      lastFailureClass,
      openedAtSeq: chain[0]?.lineage.seq ?? 0,
    })
  }
  return views.sort((a, b) => a.branchId - b.branchId)
}

/** Beta schedule (Listing 2: "route every behavioral threshold through one _schedule"). */
function schedule(beta: number): { patience: number } {
  return { patience: 0.5 + Math.min(1, Math.max(0, beta)) }
}

/** Deterministic squash for unbounded prefix signals. */
function squash(x: number): number {
  return 1 / (1 + Math.exp(-2 * x))
}

/** One rankable decision candidate: the root (open a branch) or a frontier. */
interface Rankable {
  nodeId: string
  role: 'root' | 'frontier'
  score: number
  view: BranchView | null
}

/**
 * The deterministic interpreter: reconstruct trajectories, apply beta-scaled
 * pruning closures, rank legal roots/frontiers with the DSL's `ranking`
 * weights, and compose a portfolio batch (exploitation / exploration /
 * recovery, ≤ W, never parent+child together, no duplicates). Returns the
 * selected node ids; an empty list means "stop".
 */
export function selectBatch(dsl: PolicyDsl, world: ReplayWorld, revealed: ReadonlyMap<string, Reveal>): string[] {
  const views = buildBranchViews(world, revealed)
  const { patience } = schedule(dsl.beta)
  const closeAfter = Math.max(1, Math.round(dsl.pruning.closeAfterConsecutiveFailures * patience))
  const stagnation = Math.max(1, Math.round(dsl.stopping.stagnationRounds * patience))

  // --- pruning closures (a later success reopens: counters are prefix-derived) ---
  const isClosed = new Set<number>()
  for (const view of views) {
    const enoughEvidence = view.attempts >= dsl.pruning.minEvidenceForClosure
    const hardFailure = view.lastFailureClass !== null
      && dsl.pruning.hardFailClasses.includes(view.lastFailureClass)
      && view.consecutiveFailures >= closeAfter
    const stagnant = view.roundsSinceImprovement >= stagnation
    if (enoughEvidence && (hardFailure || stagnant)) isClosed.add(view.branchId)
  }

  // --- legal candidates ---
  const candidates: Rankable[] = []
  const maxAnchor = Math.max(...views.map((view) => view.bestAnchor ?? Number.NEGATIVE_INFINITY))
  const maxSeq = Math.max(1, ...views.map((view) => view.openedAtSeq))
  const recordedRootLeaves = world.rootChildren.filter((child) => !revealed.has(child.id)).length

  // Root: legal when recorded branches remain, or the grid plan budgets novel ones.
  const canOpenRecorded = recordedRootLeaves > 0
  const canOpenNovel = observedBranchCount(revealed) < dsl.gridPlan.branchCount
  if (canOpenRecorded || canOpenNovel) {
    // High beta = width preference: opening roots is more attractive.
    const rootScore = canOpenRecorded ? 0.4 + 0.6 * dsl.beta : 0.2 + 0.3 * dsl.beta
    candidates.push({ nodeId: world.rootId, role: 'root', score: rootScore, view: null })
  }

  for (const view of views) {
    if (isClosed.has(view.branchId)) continue
    const frontier = view.frontier
    if (!frontier) continue
    // Refinement budget: the new node would sit at seqInBranch + 1 ≤ refineCount.
    if (frontier.state.seqInBranch >= dsl.gridPlan.refineCount) continue
    // Anchor signal is prefix-relative (Listing 2: no absolute score cutoffs).
    let anchorNorm = 0
    if (view.bestAnchor !== null) {
      anchorNorm = maxAnchor > 0 ? view.bestAnchor / maxAnchor : (view.bestAnchor === maxAnchor ? 1 : 0)
    }
    const remainingNorm = (dsl.gridPlan.refineCount - frontier.state.seqInBranch) / Math.max(1, dsl.gridPlan.refineCount)
    const recencyNorm = frontier.lineage.seq / maxSeq
    const repairable = view.lastFailureClass !== null && dsl.pruning.repairableClasses.includes(view.lastFailureClass)
    const score =
      dsl.ranking.anchorScore * anchorNorm
      + dsl.ranking.parentChildGain * squash(view.lastDeltaVsParent ?? 0)
      + dsl.ranking.trend * squash(view.trend)
      + dsl.ranking.recoverability * (repairable ? 1 : 0)
      + dsl.ranking.remainingDepth * remainingNorm
      + dsl.ranking.recency * recencyNorm
    candidates.push({ nodeId: frontier.id, role: 'frontier', score, view })
  }

  if (candidates.length === 0) return []

  // --- deterministic ranking (score desc, roots before frontiers, id asc) ---
  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    if (a.role !== b.role) return a.role === 'root' ? -1 : 1
    return a.nodeId.localeCompare(b.nodeId)
  })

  // --- portfolio composition (spec §6.1 interpreter + Listing 2 rules) ---
  //
  // The root (open a NEW branch) and the root's direct children (depth-1
  // frontiers) can never share a batch — parent+child legality (spec §6.3).
  // Since "exploration" in the paper's dynamic portfolio means new roots OR
  // underexplored branches, the interpreter composes two deterministic plans
  // and keeps the one that uses parallelism better:
  //
  //   plan A (with root):    [root] + non-root-child frontiers by rank
  //   plan B (frontiers only): all frontiers by rank
  //
  // Plan A wins when it is strictly larger (the root fills an idle worker —
  // "must not leave workers idle"), or on a size tie when the DSL asks for
  // exploration (explorationShare > 0). A justified recovery (repairable
  // frontier) fills an idle slot last and never displaces normal refinements.
  const rootCandidate = candidates.find((candidate) => candidate.role === 'root') ?? null
  const frontierCandidates = candidates.filter((candidate) => candidate.role === 'frontier')
  const capacity = Math.min(dsl.W, candidates.length)
  const repairableTop = frontierCandidates.find(
    (candidate) =>
      candidate.view?.lastFailureClass != null
      && dsl.pruning.repairableClasses.includes(candidate.view.lastFailureClass),
  )

  const composePlan = (withRoot: boolean): Rankable[] => {
    const plan: Rankable[] = []
    if (withRoot && rootCandidate) plan.push(rootCandidate)
    for (const candidate of frontierCandidates) {
      if (plan.length >= capacity) break
      if (withRoot && rootCandidate && candidate.view?.frontier?.parentId === world.rootId) continue
      plan.push(candidate)
    }
    return plan
  }

  const planWithRoot = rootCandidate ? composePlan(true) : []
  const planWithoutRoot = composePlan(false)
  const preferRoot = rootCandidate !== null
    && (planWithRoot.length > planWithoutRoot.length
      || (planWithRoot.length === planWithoutRoot.length && dsl.portfolio.explorationShare > 0))
  let plan = preferRoot && rootCandidate ? planWithRoot : planWithoutRoot

  if (
    repairableTop
    && !plan.some((candidate) => candidate.nodeId === repairableTop.nodeId)
    && plan.length < capacity
  ) {
    plan = [...plan, repairableTop]
  }
  return plan.map((candidate) => candidate.nodeId)
}

/** Number of distinct branches opened so far in the observed prefix. */
function observedBranchCount(revealed: ReadonlyMap<string, Reveal>): number {
  let max = -1
  for (const reveal of revealed.values()) {
    if (reveal.node.kind === 'attempt') max = Math.max(max, reveal.node.state.branchId)
  }
  return max + 1
}

// ---------------------------------------------------------------------------
// Dream loop (spec §6.2 pseudocode) and selection (§6.3)
// ---------------------------------------------------------------------------

/** Inputs to {@link runDream}. */
export interface DreamInput {
  /** Candidate list; candidate 0 MUST be the incumbent (engine prepends it). */
  candidates: readonly { dsl: PolicyDsl; version: string | null }[]
  /** The whole simulator pool (every closed tree). */
  worlds: readonly ReplayWorld[]
  config: PluginConfig
  runId: string
  createdAt: string
  /** Optional deterministic beta sweep (spec §6.4). */
  sweepBetas: readonly number[]
  /** Disqualify degenerate-behavior flags (spec §6.3.4) when true. */
  strictGuards: boolean
}

/** Per-world replay episode for one policy. */
function replayWorld(
  dsl: PolicyDsl,
  world: ReplayWorld,
  pool: readonly ReplayWorld[],
  config: PluginConfig,
  normalization: Normalization,
): { result: WorldReplayResult; openedBranches: number; allBatches: number[]; estCount: number; reveals: number } {
  const observed = initObserved(world)
  const est: EstimateContext = { world, pool, config, dsl }
  const capK = Math.min(config.maxReplayRounds, dsl.stopping.maxRoundsK2)
  let invalid: string | null = null
  let stopReason: ReplayStopReason = 'round-cap'
  const batchSizes: number[] = []
  const diversityItems: { descriptor: ActionDescriptor; anchor: StructuralAnchor }[] = []

  while (observed.rounds < capK && !isExhausted(world, observed)) {
    const batch = selectBatch(dsl, world, observed.revealed)
    if (batch.length === 0) {
      stopReason = 'empty-batch'
      break
    }
    const violation = checkBatchRecords(world, observed, batch, dsl.W)
    if (violation !== null) {
      invalid = violation
      stopReason = 'invalid'
      break
    }
    // Diversity items describe the selected probes BEFORE their outcomes exist.
    diversityItems.length = 0
    for (const nodeId of batch) {
      const reveal = observed.revealed.get(nodeId)
      if (!reveal) continue
      const node = reveal.node
      const role: BranchRole = node.kind === 'root' || node.parentId === world.rootId ? 'root-open' : 'refine'
      diversityItems.push({
        descriptor: node.kind === 'root'
          ? { summary: 'open new branch', mechanism: 'root-open', tags: ['root'] }
          : { summary: node.action.summary, mechanism: node.action.mechanism, tags: node.action.tags },
        anchor: { depth: node.state.depth, parentId: node.parentId, role },
      })
    }
    const diversity = batchDiversity(diversityItems, world.corpus)
    const { revealed } = step(world, observed, batch, est)
    commitReveals(observed, batch, revealed)
    observed.bonusNum += batch.length * Math.sqrt(diversity)
    batchSizes.push(batch.length)
  }
  if (invalid === null && isExhausted(world, observed)) stopReason = 'exhausted'

  const qualityRaw = observed.bestQuality
  const quality = qualityRaw !== null ? normalizeScore(normalization, qualityRaw) : 0
  const cost = config.beta1 * observed.reveals
  const parallelism = config.beta2 * observed.bonusNum / Math.max(1, observed.rounds)
  const result: WorldReplayResult = {
    worldId: world.worldId,
    score: quality - cost + parallelism,
    rounds: observed.rounds,
    reveals: observed.reveals,
    stopReason: invalid !== null ? 'invalid' : stopReason,
    terms: { quality, cost, parallelism },
    estOutcomeFraction: observed.reveals > 0 ? observed.estCount / observed.reveals : 0,
    batchSizes,
    ...(invalid !== null ? { invalid } : {}),
  }
  return {
    result,
    openedBranches: observed.branchCount,
    allBatches: batchSizes,
    estCount: observed.estCount,
    reveals: observed.reveals,
  }
}

/** Score one candidate over the whole pool (single beta). */
function scoreCandidate(
  dsl: PolicyDsl,
  worlds: readonly ReplayWorld[],
  config: PluginConfig,
  normalization: Normalization,
): { perWorld: WorldReplayResult[]; diagnostics: { estCount: number; reveals: number; neverBatched: boolean; singleBranch: boolean; stopsImmediately: boolean; batchSizes: number[] } } {
  const perWorld: WorldReplayResult[] = []
  let estTotal = 0
  let revealsTotal = 0
  let everBatched = false
  let maxBranches = 0
  let allStoppedImmediately = worlds.length > 0
  const batchSizes: number[] = []
  for (const world of worlds) {
    const { result, openedBranches, allBatches, estCount, reveals } = replayWorld(dsl, world, worlds, config, normalization)
    perWorld.push(result)
    estTotal += estCount
    revealsTotal += reveals
    if (allBatches.some((size) => size > 1)) everBatched = true
    maxBranches = Math.max(maxBranches, openedBranches)
    if (!(result.rounds === 0 && world.rootChildren.length > 0)) allStoppedImmediately = false
    batchSizes.push(...allBatches)
  }
  return {
    perWorld,
    diagnostics: {
      estCount: estTotal,
      reveals: revealsTotal,
      // With no worlds there is no behavior to flag as degenerate.
      neverBatched: worlds.length > 0 && !everBatched,
      singleBranch: worlds.length > 0 && maxBranches <= 1,
      stopsImmediately: worlds.length > 0 && allStoppedImmediately,
      batchSizes,
    },
  }
}

/**
 * Run the full dreaming phase: validate candidates, replay-score each over
 * every world (Eq. 1 + §5.3 step 5), apply the optional beta sweep, and rank
 * with the §6.3 guards. Candidate 0 is the incumbent; ties select the
 * earliest candidate, so selection can never regress on the replay history.
 */
export function runDream(input: DreamInput): DreamReport {
  const { candidates, worlds, config, runId, createdAt, sweepBetas, strictGuards } = input
  const normalization = computeNormalization(worlds, config.normalizeScores)
  const ranking: DreamRankingEntry[] = []

  candidates.forEach((candidate, index) => {
    const validation = validatePolicyDsl(candidate.dsl)
    if (!validation.ok) {
      ranking.push({
        candidate: index,
        name: typeof candidate.dsl?.name === 'string' ? candidate.dsl.name : `candidate-${index}`,
        version: candidate.version,
        meanScore: INVALID_SCORE,
        perWorld: [],
        invalid: `invalid PolicyDsl: ${validation.errors.join('; ')}`,
        diagnostics: {
          batchSizes: [],
          estOutcomeFraction: 0,
          neverBatched: true,
          singleBranch: true,
          stopsImmediately: true,
        },
      })
      return
    }
    const { perWorld, diagnostics } = scoreCandidate(candidate.dsl, worlds, config, normalization)
    const worldScores = perWorld.map((result) => result.score)
    const anyInvalid = perWorld.find((result) => result.invalid !== undefined)

    // Validity + degeneracy gate (spec §6.3.3/§6.3.4): an illegal batch, an
    // invalid DSL, or — under strictGuards — a degenerate behavior profile
    // (never batches / single branch / stops immediately everywhere) scores
    // INVALID_SCORE, so selection's argmax can never pick it.
    const degenerate = diagnostics.neverBatched || diagnostics.singleBranch || diagnostics.stopsImmediately
    const invalidReason = anyInvalid !== undefined
      ? anyInvalid.invalid ?? 'illegal batch'
      : strictGuards && degenerate
        ? `degenerate behavior: ${[
          diagnostics.neverBatched ? 'never-batched' : null,
          diagnostics.singleBranch ? 'single-branch' : null,
          diagnostics.stopsImmediately ? 'stops-immediately' : null,
        ].filter(Boolean).join(', ')}`
        : null
    const meanScore = invalidReason !== null
      ? INVALID_SCORE
      : worldScores.length > 0
        ? worldScores.reduce((sum, score) => sum + score, 0) / worldScores.length
        : 0

    // Optional deterministic beta sweep (spec §6.4): re-score the SAME
    // candidate at each sweep beta; the frontier informs the proposer's next
    // baked-in default beta.
    let betaSweep: { beta: number; reward: number }[] | null = null
    if (sweepBetas.length > 0) {
      betaSweep = sweepBetas.map((beta) => {
        const swept: PolicyDsl = { ...candidate.dsl, beta }
        const sweptRun = scoreCandidate(swept, worlds, config, normalization)
        const scores = sweptRun.perWorld.map((result) => result.score)
        const sweptInvalid = sweptRun.perWorld.find((result) => result.invalid !== undefined)
        return {
          beta,
          reward: sweptInvalid !== undefined || scores.length === 0
            ? INVALID_SCORE
            : scores.reduce((sum, score) => sum + score, 0) / scores.length,
        }
      })
    }

    ranking.push({
      candidate: index,
      name: candidate.dsl.name,
      version: candidate.version,
      meanScore,
      perWorld,
      invalid: invalidReason,
      diagnostics: {
        batchSizes: diagnostics.batchSizes,
        estOutcomeFraction: diagnostics.reveals > 0 ? diagnostics.estCount / diagnostics.reveals : 0,
        neverBatched: diagnostics.neverBatched,
        singleBranch: diagnostics.singleBranch,
        stopsImmediately: diagnostics.stopsImmediately,
      },
      ...(betaSweep !== null ? { betaSweep } : {}),
    })
  })

  // --- selection (§6.3): argmax mean score; ties → earliest candidate. ---
  const ordering = [...ranking].sort((a, b) => {
    if (b.meanScore !== a.meanScore) return b.meanScore - a.meanScore
    return a.candidate - b.candidate
  })
  const best = ordering[0]
  const selected = best ?? ranking[0]
  const incumbent = ranking[0]
  const selectedScore = selected?.meanScore ?? INVALID_SCORE
  const incumbentScore = incumbent?.meanScore ?? INVALID_SCORE
  const noRegression = selectedScore >= incumbentScore - 1e-9

  return {
    runId,
    createdAt,
    selectedCandidate: selected?.candidate ?? 0,
    selectedName: selected?.name ?? 'unknown',
    selectedVersion: selected?.version ?? null,
    selectedParams: candidates[selected?.candidate ?? 0]?.dsl ?? ({} as PolicyDsl),
    ranking,
    guards: { noRegression, incumbentScore },
    historySize: worlds.length,
    normalization: normalization.enabled
      ? { min: normalization.min, max: normalization.max, enabled: true }
      : { min: 0, max: 0, enabled: false },
  }
}
