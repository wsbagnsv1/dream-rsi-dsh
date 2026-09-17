/**
 * Replay simulator over recorded discovery trees (spec §4) plus the RCO
 * deterministic off-policy outcome estimator for novel actions (spec §5.3).
 *
 * Everything here is PURE and DETERMINISTIC: no network, no clock, no
 * randomness. Identical inputs always yield identical outputs, so
 * `dreamrsi_dream` is byte-reproducible.
 *
 * The simulator implements the paper's replay transition: a policy observes a
 * subtree `𝒪` (initially the root), selects a batch of ≤ W selectable nodes
 * ({root} ∪ current leaves), and the simulator *reveals recorded children*:
 *
 * - non-root node: its unique recorded child, if any (unrevealed by
 *   construction, since only frontiers are selectable);
 * - root: the earliest-created (smallest `lineage.seq`) recorded child not yet
 *   revealed — replay opens ONE previously unrevealed branch.
 *
 * Plugin extension (spec §4.2/§5.3): when the recorded continuation is
 * exhausted but the candidate policy's grid plan still budgets the move, the
 * simulator produces a similarity-estimated outcome (RCO), clearly flagged
 * with `estimated: true` and a confidence level. Estimated outcomes never
 * enter history and count toward the Eq. 1 quality term only at medium
 * confidence.
 *
 * @module
 */

import { rootIdOf } from './store.ts'
import type {
  EstimateConfidence,
  NodeRecord,
  PluginConfig,
  PolicyDsl,
  Reveal,
} from './types.ts'

// ---------------------------------------------------------------------------
// World index (spec §4.3: O(N) build, O(|C|) steps)
// ---------------------------------------------------------------------------

/** Score statistics over a world's evaluated attempts. */
export interface WorldScoreStats {
  min: number
  max: number
  values: readonly number[]
}

/** Term document frequencies over a world's recorded action texts (for idf). */
export interface TextCorpus {
  df: Map<string, number>
  docCount: number
}

/** Immutable index of one closed round's tree — one replay world. */
export interface ReplayWorld {
  /** The round id this world was built from. */
  worldId: string
  rootId: string
  /** All recorded nodes in creation order. */
  nodes: readonly NodeRecord[]
  nodeById: ReadonlyMap<string, NodeRecord>
  /** Root children sorted by `lineage.seq` (branch starts, in creation order). */
  rootChildren: readonly NodeRecord[]
  /** Non-root node id → its unique recorded child id (chains, spec §0). */
  childOf: ReadonlyMap<string, string>
  /** Distinct recorded branch ids (ascending). */
  branchIds: readonly number[]
  scoreStats: WorldScoreStats
  /** Document frequencies over recorded attempt action texts (RCO idf). */
  corpus: TextCorpus
}

/**
 * Build the immutable world index for one closed round's tree.
 * The tree structure is trusted to satisfy the store invariants (single root,
 * ≤ 1 child per non-root node); violations surface as missing/ambiguous
 * chain links rather than crashes.
 */
export function buildWorld(worldId: string, nodes: readonly NodeRecord[]): ReplayWorld {
  const nodeById = new Map<string, NodeRecord>()
  for (const node of nodes) nodeById.set(node.id, node)
  const root = nodes.find((node) => node.kind === 'root') ?? null
  const rootId = root?.id ?? rootIdOf(worldId)
  const rootChildren = nodes
    .filter((node) => node.parentId === rootId)
    .sort((a, b) => a.lineage.seq - b.lineage.seq || a.id.localeCompare(b.id))
  const childOf = new Map<string, string>()
  for (const node of nodes) {
    if (node.parentId !== null && node.kind === 'attempt') childOf.set(node.parentId, node.id)
  }
  const branchIdSet = new Set<number>()
  for (const node of nodes) {
    if (node.kind === 'attempt') branchIdSet.add(node.state.branchId)
  }
  const scores = nodes
    .filter((node) => node.kind === 'attempt' && node.outcome.evaluated)
    .map((node) => node.outcome.score)
  const corpus = buildCorpus(
    nodes
      .filter((node) => node.kind === 'attempt')
      .map((node) => actionDoc(node.action.summary, node.action.mechanism)),
  )
  return {
    worldId,
    rootId,
    nodes,
    nodeById,
    rootChildren,
    childOf,
    branchIds: [...branchIdSet].sort((a, b) => a - b),
    scoreStats: {
      min: scores.length > 0 ? Math.min(...scores) : 0,
      max: scores.length > 0 ? Math.max(...scores) : 0,
      values: scores,
    },
    corpus,
  }
}

// ---------------------------------------------------------------------------
// Observed state (the policy's revealed prefix 𝒪)
// ---------------------------------------------------------------------------

/** The policy's revealed prefix within one replay episode. */
export interface ObservedState {
  /** Revealed nodes by id (includes the root). */
  revealed: Map<string, Reveal>
  /** Completed decision rounds k. */
  rounds: number
  /** Revealed non-root nodes N (the would-be generation–evaluation requests). */
  reveals: number
  /** Σ over rounds of |C|·√diversity — numerator of the parallelism term. */
  bonusNum: number
  batchSizes: number[]
  /** Best qualifying (recorded, or medium-confidence estimated) raw score. */
  bestQuality: number | null
  /** Distinct opened branches (recorded + novel). */
  branchCount: number
  /** Estimated reveals so far. */
  estCount: number
  /** Synthetic sequence counter for estimated node ids. */
  estSeq: number
}

/** Start a replay episode: `𝒪 = {root}` (spec §6.2). */
export function initObserved(world: ReplayWorld): ObservedState {
  const root = world.nodeById.get(world.rootId)
  const revealed = new Map<string, Reveal>()
  if (root) {
    revealed.set(root.id, { node: root, estimated: false, confidence: null })
  }
  return {
    revealed,
    rounds: 0,
    reveals: 0,
    bonusNum: 0,
    batchSizes: [],
    bestQuality: null,
    branchCount: 0,
    estCount: 0,
    estSeq: 0,
  }
}

/** True when every recorded node of the world is revealed (`𝒪 = 𝒯`). */
export function isExhausted(world: ReplayWorld, observed: ObservedState): boolean {
  return observed.revealed.size >= world.nodes.length
}

// ---------------------------------------------------------------------------
// Replay transition (spec §4.1 `Child`) with novel-action estimation (§5.3)
// ---------------------------------------------------------------------------

/** Estimator + policy context a replay step needs for novel actions. */
export interface EstimateContext {
  /** The world being replayed. */
  world: ReplayWorld
  /** The whole simulator pool (for cross-world analogues, spec §5.3 step 1). */
  pool: readonly ReplayWorld[]
  /** Resolved plugin config (estimator constants, spec §5.3). */
  config: PluginConfig
  /** The candidate policy (grid plan budgets + novel action descriptor). */
  dsl: PolicyDsl
  /**
   * Estimator mode (v0.2 F3): `'off'` = recorded reveals only (paper
   * default); `'rco'` = similarity-estimated outcomes for novel actions.
   */
  estimate: EstimateMode
}

/** Result of one replay step. */
export interface StepResult {
  /** Newly revealed nodes, in batch order. */
  revealed: Reveal[]
}

/**
 * Execute ONE decision: reveal the recorded children of the selected batch
 * (paper `Child` rule); where the recorded continuation is exhausted but the
 * candidate's grid plan still budgets the move, estimate the outcome (RCO).
 * Does not mutate `observed` — the caller folds `revealed` in via
 * {@link commitReveals}.
 */
/**
 * The replay estimator mode (v0.2 F3): `'off'` (paper-faithful default)
 * reveals recorded children only — a selection whose recorded continuation
 * is exhausted reveals nothing (episode exhaustion semantics); `'rco'`
 * re-enables the §5.3 similarity estimator for novel actions.
 */
export type EstimateMode = 'off' | 'rco'

/**
 * Execute ONE decision: reveal the recorded children of the selected batch
 * (paper `Child` rule). With `est === null` (estimate 'off', the default) or
 * an `est.estimate === 'off'` mode, selections whose recorded continuation is
 * exhausted reveal nothing — strictly on-manifold replay. With
 * `est.estimate === 'rco'`, exhausted selections whose grid-plan budget still
 * holds produce a similarity-estimated outcome (spec §5.3). Does not mutate
 * `observed` — the caller folds `revealed` in via {@link commitReveals}.
 */
export function step(world: ReplayWorld, observed: ObservedState, batch: readonly string[], est: EstimateContext | null): StepResult {
  const revealed: Reveal[] = []
  const rcoOn = est !== null && est.estimate === 'rco'
  for (const nodeId of batch) {
    const fromObserved = observed.revealed.get(nodeId)
    const node: NodeRecord | undefined = fromObserved !== undefined ? fromObserved.node : world.nodeById.get(nodeId)
    if (node === undefined) continue
    if (node.kind === 'root') {
      const next = world.rootChildren.find((child) => !observed.revealed.has(child.id))
      if (next) {
        revealed.push({ node: next, estimated: false, confidence: null })
        continue
      }
      // Novel branch open: only under RCO, while the grid plan budgets it.
      if (rcoOn && observed.branchCount < est.dsl.gridPlan.branchCount) {
        revealed.push(estimateReveal(est, observed, node, 'root-open'))
      }
      continue
    }
    const childId = world.childOf.get(node.id)
    if (childId !== undefined && !observed.revealed.has(childId)) {
      const child = world.nodeById.get(childId)
      if (child) {
        revealed.push({ node: child, estimated: false, confidence: null })
        continue
      }
    }
    // Novel refinement: only under RCO, while the chain budget remains.
    if (rcoOn && node.state.seqInBranch < est.dsl.gridPlan.refineCount) {
      revealed.push(estimateReveal(est, observed, node, 'refine'))
    }
  }
  return { revealed }
}

/**
 * Fold revealed nodes into the observed prefix, maintaining counters and the
 * quality term (recorded reveals always count; estimated reveals count only
 * at medium confidence — spec §5.3 bookkeeping).
 */
export function commitReveals(observed: ObservedState, batch: readonly string[], revealed: readonly Reveal[]): void {
  for (const reveal of revealed) {
    observed.revealed.set(reveal.node.id, reveal)
    if (reveal.node.kind !== 'attempt') continue
    observed.reveals += 1
    if (reveal.estimated) {
      observed.estCount += 1
      if (reveal.confidence === 'medium' && observed.bestQuality === null) {
        observed.bestQuality = reveal.node.outcome.score
      } else if (reveal.confidence === 'medium' && observed.bestQuality !== null) {
        observed.bestQuality = Math.max(observed.bestQuality, reveal.node.outcome.score)
      }
    } else if (observed.bestQuality === null) {
      observed.bestQuality = reveal.node.outcome.score
    } else {
      observed.bestQuality = Math.max(observed.bestQuality, reveal.node.outcome.score)
    }
    observed.branchCount = Math.max(observed.branchCount, reveal.node.state.branchId + 1)
  }
  observed.rounds += 1
  observed.batchSizes.push(batch.length)
}

/**
 * Batch legality gate (spec §6.3.3): duplicate ids or |C| > W are illegal.
 * Returns the violation reason or null. Parent+child detection additionally
 * needs node records — see {@link checkBatchRecords}.
 */
export function checkBatch(batch: readonly string[], maxParallelism: number): string | null {
  const seen = new Set<string>()
  for (const id of batch) {
    if (seen.has(id)) return `duplicate node ${id} in batch`
    seen.add(id)
  }
  if (batch.length > maxParallelism) return `batch size ${batch.length} exceeds W=${maxParallelism}`
  return null
}

/**
 * Parent+child legality over known records (spec §6.3.3): batch elements
 * resolve to revealed nodes; a pair (a, b) with b.parentId === a.id (or the
 * reverse) is illegal.
 */
export function checkBatchRecords(world: ReplayWorld, observed: ObservedState, batch: readonly string[], maxParallelism: number): string | null {
  const dup = checkBatch(batch, maxParallelism)
  if (dup) return dup
  const resolve = (id: string): NodeRecord | undefined => observed.revealed.get(id)?.node ?? world.nodeById.get(id)
  for (const a of batch) {
    const na = resolve(a)
    if (!na) continue
    for (const b of batch) {
      if (a === b) continue
      const nb = resolve(b)
      if (!nb) continue
      if (nb.parentId === na.id || na.parentId === nb.id) {
        return `parent and child batched together: ${na.id} / ${nb.id}`
      }
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Eq. 1 support: score normalization (spec §8.4) and batch diversity (§5.3 step 5)
// ---------------------------------------------------------------------------

/** Global min–max bounds over the scored worlds' recorded scores. */
export interface Normalization {
  enabled: boolean
  min: number
  max: number
}

/** Union of recorded evaluated scores across the pool (spec §8.4). */
export function computeNormalization(pool: readonly ReplayWorld[], enabled: boolean): Normalization {
  const all: number[] = []
  for (const world of pool) all.push(...world.scoreStats.values)
  if (!enabled || all.length === 0) return { enabled: false, min: 0, max: 0 }
  return { enabled: true, min: Math.min(...all), max: Math.max(...all) }
}

/** Apply min–max normalization (max == min maps to 0; disabled passes through). */
export function normalizeScore(n: Normalization, score: number): number {
  if (!n.enabled) return score
  if (n.max <= n.min) return 0
  return (score - n.min) / (n.max - n.min)
}

/** Action descriptor used for similarity computations. */
export interface ActionDescriptor {
  summary: string
  mechanism: string
  tags: readonly string[]
}

/** Branch role of a node: opening a branch off the root vs refining a chain. */
export type BranchRole = 'root-open' | 'refine'

/** Structural anchors of an action within its world. */
export interface StructuralAnchor {
  depth: number
  parentId: string | null
  role: BranchRole
}

/** Structural similarity component (spec §5.3 step 2). */
export function structuralSimilarity(a: StructuralAnchor, r: StructuralAnchor): number {
  const sameParent = (a.parentId ?? '__root__') === (r.parentId ?? '__root__') ? 1 : 0
  const sameRole = a.role === r.role ? 1 : 0
  return 0.5 * Math.exp(-Math.abs(a.depth - r.depth) / 2) + 0.3 * sameParent + 0.2 * sameRole
}

/**
 * Pairwise similarity between two action descriptors (spec §5.3 step 2
 * weights): 0.55·cosTf + 0.25·jaccard(tags) + 0.20·structural.
 */
export function actionSimilarity(
  a: { descriptor: ActionDescriptor; anchor: StructuralAnchor },
  r: { descriptor: ActionDescriptor; anchor: StructuralAnchor },
  corpus: TextCorpus,
): number {
  return (
    0.55 * cosineTf(docTerms(actionDoc(a.descriptor.summary, a.descriptor.mechanism)), docTerms(actionDoc(r.descriptor.summary, r.descriptor.mechanism)), corpus)
    + 0.25 * jaccard(a.descriptor.tags, r.descriptor.tags)
    + 0.20 * structuralSimilarity(a.anchor, r.anchor)
  )
}

/**
 * Batch diversity (spec §5.3 step 5): 1 − mean pairwise similarity between
 * the batch's action descriptors. A single-element batch is fully diverse.
 */
export function batchDiversity(
  items: readonly { descriptor: ActionDescriptor; anchor: StructuralAnchor }[],
  corpus: TextCorpus,
): number {
  if (items.length <= 1) return 1
  let sum = 0
  let pairs = 0
  for (let i = 0; i < items.length; i++) {
    const a = items[i]
    if (!a) continue
    for (let j = i + 1; j < items.length; j++) {
      const b = items[j]
      if (!b) continue
      sum += actionSimilarity(a, b, corpus)
      pairs += 1
    }
  }
  if (pairs === 0) return 1
  return Math.max(0, 1 - sum / pairs)
}

// ---------------------------------------------------------------------------
// RCO — Recorded-Outcome Comparator (spec §5.3)
// ---------------------------------------------------------------------------

/** Result of the RCO estimator. */
export interface RcoEstimate {
  /** Estimated score in the world's raw recorded units. */
  score: number
  confidence: EstimateConfidence
  /** Max analogue similarity observed (diagnostics). */
  sMax: number
  /** How many analogues passed the similarity floor (diagnostics). */
  usedAnalogues: number
  /** True when the pessimistic abstention prior was used (diagnostics). */
  abstained: boolean
}

/**
 * Estimate the outcome of a novel action (spec §5.3, steps 1–4): collect
 * decision-analogous recorded attempts, score them with the deterministic
 * similarity, blend the top-k recorded outcomes, then apply the novelty
 * penalty or the pessimistic abstention prior.
 */
export function estimateOutcome(
  est: EstimateContext,
  parent: NodeRecord | null,
  role: BranchRole,
  action: ActionDescriptor,
  depth: number,
): RcoEstimate {
  const { world, pool, config } = est
  const anchor: StructuralAnchor = { depth, parentId: parent ? parent.id : null, role }

  // Step 1 — candidate reference sets (deduplicated by node id).
  const analogues: { node: NodeRecord; sim: number }[] = []
  const seen = new Set<string>()
  const pushAnalogue = (node: NodeRecord, corpus: TextCorpus = world.corpus): void => {
    if (node.kind !== 'attempt' || seen.has(node.id)) return
    seen.add(node.id)
    const nodeRole: BranchRole = node.parentId === world.rootId ? 'root-open' : 'refine'
    const sim = actionSimilarity(
      { descriptor: action, anchor },
      {
        descriptor: { summary: node.action.summary, mechanism: node.action.mechanism, tags: node.action.tags },
        anchor: { depth: node.state.depth, parentId: node.parentId, role: nodeRole },
      },
      corpus,
    )
    analogues.push({ node, sim })
  }

  // R_parent: recorded children of the same parent (siblings).
  if (parent) {
    for (const node of world.nodes) {
      if (node.parentId === parent.id && node.kind === 'attempt') pushAnalogue(node)
    }
  }
  // R_depth: same depth and seqInBranch position in other branches of this world.
  const expectedSeq = role === 'root-open'
    ? 0
    : parent && parent.kind !== 'root' ? parent.state.seqInBranch + 1 : 0
  const excludeBranch = parent && parent.kind !== 'root' ? parent.state.branchId : null
  const samePosition = world.nodes.filter(
    (node) =>
      node.kind === 'attempt'
      && node.state.depth === depth
      && node.state.seqInBranch === expectedSeq
      && (excludeBranch === null || node.state.branchId !== excludeBranch),
  )
  for (const node of samePosition) pushAnalogue(node)

  const localCount = analogues.length
  // R_cross: other worlds at matching depth, when local evidence is thin.
  if (localCount < config.estimatorMinAnalogues) {
    for (const other of pool) {
      if (other.worldId === world.worldId) continue
      for (const node of other.nodes) {
        if (node.kind !== 'attempt' || node.state.depth !== depth) continue
        // Cross-world analogues are scored with this world's corpus (spec §5.3:
        // "idf is computed over the world's recorded action corpus").
        pushAnalogue(node)
      }
    }
  }

  // Deterministic ordering: similarity desc, then node id asc (spec §5.3 step 3).
  analogues.sort((a, b) => b.sim - a.sim || a.node.id.localeCompare(b.node.id))
  const sMax = analogues.length > 0 ? Math.max(...analogues.map((entry) => entry.sim)) : 0

  // Step 4 — abstention prior for actions history cannot vouch for.
  if (sMax < config.hallucinationTau || analogues.length === 0) {
    return {
      score: pessimisticPrior(world.scoreStats.values),
      confidence: 'none',
      sMax,
      usedAnalogues: 0,
      abstained: true,
    }
  }

  // Step 3 — weighted outcome blend over the top-k analogues above the floor.
  const top = analogues
    .filter((entry) => entry.sim >= config.similarityFloor)
    .slice(0, config.estimatorMaxAnalogues)
  let weightSum = 0
  let weightedScore = 0
  for (const entry of top) {
    const weight = Math.pow(entry.sim, config.similarityGamma)
    weightSum += weight
    weightedScore += weight * entry.node.outcome.score
  }
  let blended = weightSum > 0 ? weightedScore / weightSum : pessimisticPrior(world.scoreStats.values)

  // Step 4 — novelty penalty toward pessimism, in the world's own units.
  const spread = world.scoreStats.max - world.scoreStats.min
  const scale = spread > 0 ? spread : 1
  blended -= config.noveltyLambda * (1 - sMax) * scale

  return {
    score: blended,
    confidence: sMax >= config.confidenceMediumTau ? 'medium' : 'low',
    sMax,
    usedAnalogues: top.length,
    abstained: false,
  }
}

/**
 * 25th percentile of the world's recorded scores, linearly interpolated
 * (deterministic; empty history → 0) — the pessimistic abstention prior.
 */
export function pessimisticPrior(scores: readonly number[]): number {
  if (scores.length === 0) return 0
  const sorted = [...scores].sort((a, b) => a - b)
  const idx = 0.25 * (sorted.length - 1)
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  const a = sorted[lo] ?? 0
  const b = sorted[hi] ?? a
  return a + (b - a) * (idx - lo)
}

/** Build a synthetic estimated reveal node (never persisted to history). */
function estimateReveal(est: EstimateContext, observed: ObservedState, parent: NodeRecord, role: BranchRole): Reveal {
  const novel = est.dsl.novel
  const descriptor: ActionDescriptor = role === 'root-open'
    ? {
      summary: novel?.summary ?? 'novel branch open',
      mechanism: novel?.mechanism ?? 'novel-open',
      tags: novel?.tags ?? ['novel'],
    }
    : {
      summary: novel?.summary ?? 'novel refinement',
      mechanism: novel?.mechanism ?? 'novel-refine',
      tags: novel?.tags ?? ['novel'],
    }
  const depth = parent.kind === 'root' ? 1 : parent.state.depth + 1
  const estimate = estimateOutcome(est, parent.kind === 'root' ? null : parent, role, descriptor, depth)
  observed.estSeq += 1
  const node: NodeRecord = {
    id: `${est.world.worldId}~est-${observed.estSeq}`,
    roundId: est.world.worldId,
    parentId: parent.id,
    kind: 'attempt',
    state: {
      depth,
      branchId: role === 'root-open' ? observed.branchCount : parent.state.branchId,
      seqInBranch: role === 'root-open' ? 0 : parent.state.seqInBranch + 1,
      workspaceSummary: parent.action.summary,
      inheritedContextNote: est.dsl.guidance,
      siblingCountAtDecision: 0,
    },
    action: {
      summary: descriptor.summary,
      mechanism: descriptor.mechanism,
      tags: [...descriptor.tags],
      artifactPaths: [],
    },
    outcome: {
      score: estimate.score,
      evaluated: false,
      valid: false,
      failClass: 'ok',
      error: null,
      deltaVsBaseline: null,
      deltaVsParent: null,
    },
    metrics: { agentCalls: 1, wallMs: null },
    notes: `estimated via RCO (confidence=${estimate.confidence}, sMax=${estimate.sMax.toFixed(4)}, analogues=${estimate.usedAnalogues}${estimate.abstained ? ', abstained' : ''})`,
    lineage: {
      createdAt: '1970-01-01T00:00:00.000Z',
      evaluatedAt: null,
      policyVersion: 'replay-estimate',
      seq: -1,
    },
  }
  return { node, estimated: true, confidence: estimate.confidence }
}

// ---------------------------------------------------------------------------
// Deterministic text similarity (spec §5.3 step 2)
// ---------------------------------------------------------------------------

/**
 * The fixed 33-word English stoplist dropped during text normalization
 * (spec §5.3 step 2 fixes the size; the members are this module's documented
 * choice).
 */
const STOPWORDS: readonly string[] = [
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'then', 'else', 'when',
  'at', 'by', 'for', 'with', 'from', 'to', 'of', 'in', 'on', 'is',
  'are', 'was', 'were', 'be', 'been', 'being', 'it', 'its', 'this', 'that',
  'these', 'those', 'as',
]

const STOPWORD_SET: ReadonlySet<string> = new Set(STOPWORDS)

/** Lowercase, split on non-alphanumerics, drop the stoplist and empties. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0 && !STOPWORD_SET.has(token))
}

/** Character 3-grams of a token; tokens shorter than 3 stay whole. */
function charGrams(token: string): string[] {
  if (token.length < 3) return [token]
  const grams: string[] = []
  for (let i = 0; i <= token.length - 3; i++) {
    const gram = token.slice(i, i + 3)
    if (gram) grams.push(gram)
  }
  return grams
}

/** Term document: word tokens ∪ character 3-grams, with raw term counts. */
export function docTerms(text: string): Map<string, number> {
  const terms = new Map<string, number>()
  const bump = (term: string): void => {
    terms.set(term, (terms.get(term) ?? 0) + 1)
  }
  for (const token of tokenize(text)) {
    bump(token)
    for (const gram of charGrams(token)) {
      if (gram !== token) bump(gram)
    }
  }
  return terms
}

/** The action document text: summary + mechanism (spec §5.3 step 2). */
function actionDoc(summary: string, mechanism: string): string {
  return `${summary} ${mechanism}`
}

/** Build document frequencies over a corpus of action documents. */
export function buildCorpus(docs: readonly string[]): TextCorpus {
  const df = new Map<string, number>()
  for (const doc of docs) {
    const seen = new Set(docTerms(doc).keys())
    for (const term of seen) df.set(term, (df.get(term) ?? 0) + 1)
  }
  return { df, docCount: docs.length }
}

/** Smooth idf: ln((1 + N) / (1 + df)) + 1 — always positive, deterministic. */
function idf(corpus: TextCorpus, term: string): number {
  return Math.log((1 + corpus.docCount) / (1 + (corpus.df.get(term) ?? 0))) + 1
}

/** Sublinear term frequency: 1 + ln(tf) (spec §5.3 step 2). */
function sublinearTf(tf: number): number {
  return tf > 0 ? 1 + Math.log(tf) : 0
}

/** Cosine between two tf-idf vectors over the given corpus. */
export function cosineTf(a: Map<string, number>, b: Map<string, number>, corpus: TextCorpus): number {
  if (a.size === 0 || b.size === 0) return 0
  let dot = 0
  let normA = 0
  let normB = 0
  const tfidf = (tf: number, term: string): number => sublinearTf(tf) * idf(corpus, term)
  for (const [term, tf] of a) {
    const w = tfidf(tf, term)
    normA += w * w
    const other = b.get(term)
    if (other !== undefined) dot += w * tfidf(other, term)
  }
  for (const [term, tf] of b) {
    const w = tfidf(tf, term)
    normB += w * w
  }
  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

/** Jaccard similarity between tag sets; two empty sets count as identical. */
export function jaccard(a: readonly string[], b: readonly string[]): number {
  const setA = new Set(a)
  const setB = new Set(b)
  if (setA.size === 0 && setB.size === 0) return 1
  let intersection = 0
  for (const tag of setA) {
    if (setB.has(tag)) intersection += 1
  }
  const union = setA.size + setB.size - intersection
  return union === 0 ? 1 : intersection / union
}
