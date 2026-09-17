/**
 * Shared types for the Dream-RSI plugin, mirroring `docs/dream-rsi-spec.md`
 * (§2 data model, §5 replay objective, §6.1 policy DSL, §7 tool surface).
 *
 * @module
 */

/** Evaluator failure classes recorded on nodes (spec §2.1). */
export type FailClass = 'ok' | 'compile' | 'runtime' | 'correctness' | 'timeout' | 'resource' | 'other'

/** The fixed fail classes accepted in tool inputs and DSL pruning lists. */
export const FAIL_CLASSES: readonly FailClass[] = [
  'ok', 'compile', 'runtime', 'correctness', 'timeout', 'resource', 'other',
]

/**
 * Plugin configuration, validated by the Schemastery `Config` schema exported
 * from `index.ts` (spec §2 `config.json`, §5.2 coefficients, §5.3 estimator
 * constants). Every field has a schema default; users override via the
 * `config` block of the plugin row in cordis.yml.
 */
export interface PluginConfig {
  /**
   * Directory holding the whole Dream-RSI store (spec §2 layout). Relative
   * paths resolve per tool call against the calling agent's session workspace
   * (`exec.agent.session.header.cwd`); a call with no resolvable session
   * workspace falls back to `process.cwd()` and discloses it. Absolute paths
   * pin one shared store across all workspaces.
   */
  dataDir: string
  /** K — advisory candidate count: how many PolicyDsl candidates the host should propose per dream. */
  candidateCount: number
  /** K₁ — maximum online decision rounds per round (glossary; round `limits.maxRounds`). */
  maxOnlineRounds: number
  /** K₂ — maximum replay decision rounds per episode (spec §5.2; default 64). */
  maxReplayRounds: number
  /** β₁ — execution-cost penalty per revealed node in Eq. 1 (spec §5.2, default 0.01). */
  beta1: number
  /** β₂ — parallelism bonus coefficient in Eq. 1 (spec §5.2, default 0.05). */
  beta2: number
  /** Min–max normalize recorded scores before Eq. 1 (spec §8.4; default on). */
  normalizeScores: boolean
  /** RCO: maximum analogues blended (top-k, spec §5.3 step 3; default 5). */
  estimatorMaxAnalogues: number
  /** RCO: cross-world analogues are consulted below this reference-set size (default 3). */
  estimatorMinAnalogues: number
  /** RCO: analogue similarity floor τ_min below which an analogue is dropped (default 0.10). */
  similarityFloor: number
  /** RCO: novelty threshold τ_hallucination below which the pessimistic prior is used (default 0.18). */
  hallucinationTau: number
  /** RCO: novelty penalty strength λ_novel (default 0.25). */
  noveltyLambda: number
  /** RCO: similarity at which an estimate counts as medium confidence (default 0.45). */
  confidenceMediumTau: number
  /** RCO: similarity weight exponent γ (default 2). */
  similarityGamma: number
  /**
   * Policy representation engine (v0.2 F1): `'code'` (default) treats code
   * policies — Python modules exposing `solve(view)` — as the primary
   * representation and bootstraps fresh stores with a built-in code policy;
   * `'legacy'` keeps the v0.1 JSON DSL interpreter primary (existing stores
   * keep replaying). Either engine replays records of the other kind via
   * their own runner.
   */
  policyEngine: 'code' | 'legacy'
  /**
   * When the dream loop runs (v0.2 F4). `'every-cycle'` (paper-faithful
   * default) runs dreaming automatically after every `dreamrsi_end_round`;
   * `'on-stagnation'` runs it when a round closes without improving the best
   * score overall; `'off'` keeps dreaming manual.
   */
  autoDream: 'every-cycle' | 'on-stagnation' | 'off'
  /**
   * Maximum recorded steps per candidate × world trajectory digest in dream
   * reports (v0.2 F4; default 20). Steps beyond the cap are summarized.
   */
  trajectoryCap: number
  /**
   * Wall-clock budget for ONE replay episode against a code policy
   * (policy × world), in milliseconds (default 30000). A timed-out episode is
   * terminated (`abort` + `terminate`) and marked invalid.
   */
  policyEpisodeTimeoutMs: number
  /**
   * Policy-development loop (v0.2 F2). `'agent-relay'` (default) keeps the
   * DSH-native adaptation: the dream report carries trajectory digests and
   * the HOST AGENT authors + commits candidates via `dreamrsi_policy_set`.
   * `'host-llm'` is the paper shape: the framework itself calls the
   * configured LLM with the verbatim Listing 2 prompt, parses `poolSize`
   * candidate code policies from the response, and feeds them to the dream.
   */
  devLoop: 'host-llm' | 'agent-relay'
  /** Candidate pool size for the host-llm development loop (default 32). */
  poolSize: number
  /** Maximum LLM calls per dreaming cycle (host-llm loop; default 3). */
  maxLlmCallsPerCycle: number
  /** Explicit LLM route override; unset → first registered provider + its first listed model. */
  llmRoute?: { provider: string; model: string }
  /**
   * Replay estimator mode (v0.2 F3, paper-faithful default `'off'`):
   * `'off'` = strictly on-manifold replay (recorded reveals only; a
   * selection whose recorded continuation is exhausted reveals nothing);
   * `'rco'` = §5.3 similarity-estimated outcomes for novel actions (our
   * superset; calibration caveats documented as extension caveats).
   */
  estimate: 'off' | 'rco'
}

/** Schema defaults, kept in one place so `index.ts` and docs stay in sync. */
export const DEFAULT_CONFIG: Omit<PluginConfig, 'dataDir'> & { dataDir: string } = {
  dataDir: '.dreamrsi',
  candidateCount: 3,
  maxOnlineRounds: 16,
  maxReplayRounds: 64,
  beta1: 0.01,
  beta2: 0.05,
  normalizeScores: true,
  estimatorMaxAnalogues: 5,
  estimatorMinAnalogues: 3,
  similarityFloor: 0.1,
  hallucinationTau: 0.18,
  noveltyLambda: 0.25,
  confidenceMediumTau: 0.45,
  similarityGamma: 2,
  policyEngine: 'code',
  autoDream: 'every-cycle',
  trajectoryCap: 20,
  policyEpisodeTimeoutMs: 30000,
  devLoop: 'agent-relay',
  poolSize: 32,
  maxLlmCallsPerCycle: 3,
  estimate: 'off',
}

// ---------------------------------------------------------------------------
// Discovery tree (spec §2.1, §2.2)
// ---------------------------------------------------------------------------

/** Attempt-proposal action recorded on a node (what was attempted). */
export interface NodeAction {
  /** One-line description of the attempt/proposal. */
  summary: string
  /** Short mechanism label, e.g. "coordinate-descent", "cuda-shared-mem". */
  mechanism: string
  /** Free-form mechanism tags (used by replay similarity). */
  tags: string[]
  /** References to generated artifacts (proposal.md, solver files). */
  artifactPaths: string[]
  /** Path to the evaluated program, if applicable. */
  evalProgramPath?: string
}

/** Evaluator outcome recorded on a node (what was observed). */
export interface NodeOutcome {
  /** s_v; task-scoring protocol, larger = better; 0 on hard failure. */
  score: number
  /** Did an evaluation actually run? */
  evaluated: boolean
  /** Did the artifact pass correctness checks? */
  valid: boolean
  failClass: FailClass
  /** Error text when failed. */
  error: string | null
  /** score − best baseline score at that time. */
  deltaVsBaseline: number | null
  /** score − parent's score (refinement gain/loss). */
  deltaVsParent: number | null
}

/** Cost metrics recorded on a node. */
export interface NodeMetrics {
  /** Discovery-agent calls consumed by this node (usually 1). */
  agentCalls: number
  /** Evaluation wall time if known. */
  wallMs: number | null
}

/** Lineage / bookkeeping recorded on a node. */
export interface NodeLineage {
  /** ISO-8601 UTC creation time. */
  createdAt: string
  /** ISO-8601 UTC evaluation time, if evaluated. */
  evaluatedAt: string | null
  /** Policy version active when this node was created. */
  policyVersion: string
  /** Global creation sequence within the round (replay tie-breaker for root children). */
  seq: number
}

/** Observed state before the attempt (spec §2.1 `state`). */
export interface NodeStateContext {
  /** 0 for root; depth = parent.depth + 1 otherwise. */
  depth: number
  /** root = -1; the first child of the root opens branch b; children keep b. */
  branchId: number
  /** 0 for a branch start; increments along the chain. */
  seqInBranch: number
  /** Short description of the inherited workspace state. */
  workspaceSummary: string
  /** What the agent was told going in (guidance, hints). */
  inheritedContextNote: string
  /** How many selectable nodes existed when this node's attempt was chosen. */
  siblingCountAtDecision: number
}

/**
 * One recorded discovery-tree node: the (state, action, outcome) tuple plus
 * lineage. Immutable once written (store invariant); stored one JSON object
 * per line in `trees/<roundId>/nodes.jsonl`.
 */
export interface NodeRecord {
  /** Unique within the store, e.g. "r0001-n003". */
  id: string
  roundId: string
  /** `null` only for the root; every other node has exactly one parent. */
  parentId: string | null
  kind: 'root' | 'attempt'
  state: NodeStateContext
  action: NodeAction
  outcome: NodeOutcome
  metrics: NodeMetrics
  notes: string
  lineage: NodeLineage
}

/** Batch-composition counters derived at round close (spec §2.2). */
export interface RoundComposition {
  exploitation: number
  exploration: number
  recovery: number
}

/** Per-round statistics (spec §2.2, §8.2). */
export interface RoundStats {
  /** Total nodes incl. root. */
  nodes: number
  /** Non-root nodes = discovery-agent calls this round. */
  attempts: number
  /** Max score among evaluated attempts in this tree. */
  bestScore: number | null
  /** How many batches the policy actually took. */
  decisionRounds: number
  /** Size of each batch in order. */
  batchSizes: number[]
  composition: RoundComposition
  /** attempts / max(1, decisionRounds) — the paper's parallelism statistic. */
  avgBatchSize: number
}

/** One outer iteration = one round = one discovery tree (spec §2.2). */
export interface RoundRecord {
  roundId: string
  status: 'open' | 'closed'
  /** Policy version that guided this round. */
  policyVersion: string
  startedAt: string
  endedAt: string | null
  /** K₁ and W for this round. */
  limits: { maxRounds: number; maxParallelism: number }
  stats: RoundStats
  /** Free-form closing summary supplied to `dreamrsi_end_round`. */
  summary?: string
  /**
   * batchSeq → index into `stats.batchSizes` (plugin addition supporting the
   * incremental `dreamrsi_log_decision` calls of spec §7.2).
   */
  batchSeqIndex?: Record<string, number>
}

// ---------------------------------------------------------------------------
// Policy DSL (spec §6.1) and policy records (spec §2.3)
// ---------------------------------------------------------------------------

/** Grid plan mirroring the paper's `plan_grid(branch_count, refine_count)`. */
export interface PolicyGridPlan {
  /** How many root-branches to make available. */
  branchCount: number
  /** Refinements allowed per branch chain. */
  refineCount: number
  /** Factual reason string (paper requires one). */
  reason: string
}

/** Batch-composition quotas (the paper's "dynamic portfolio"). */
export interface PolicyPortfolio {
  /** Fraction of batch slots for strong normal refinements (0..1). */
  exploitationShare: number
  /** Fraction of batch slots for new roots / underexplored branches (0..1). */
  explorationShare: number
  /** ≤ 1: at most one repairable-failure recovery per batch. */
  recoverySlots: number
}

/** Frontier-priority ranking weights (all ≥ 0, deterministic). */
export interface PolicyRanking {
  anchorScore: number
  parentChildGain: number
  trend: number
  recoverability: number
  remainingDepth: number
  recency: number
}

/** Pruning rules (failClass names; defaults favor repairability, spec §11.10). */
export interface PolicyPruning {
  /** Fail classes considered repairable (stay eligible for recovery). */
  repairableClasses: string[]
  /** Fail classes eligible for unconditional closure. */
  hardFailClasses: string[]
  /** Close a branch after this many consecutive failures (beta-scaled). */
  closeAfterConsecutiveFailures: number
  /** Don't close on less evidence than this many attempts. */
  minEvidenceForClosure: number
}

/** Stopping rules. */
export interface PolicyStopping {
  /** Stop a branch after this many rounds without improvement (beta-scaled). */
  stagnationRounds: number
  /** Per-episode decision-round cap for replay. */
  maxRoundsK2: number
}

/**
 * Optional descriptor for novel (off-manifold) actions, used by the replay
 * estimator when the policy extends beyond recorded history (spec §5.3 step 1
 * takes the action descriptor "from the policy DSL"). Keep it generic and
 * honest — the estimate will be similarity-scored against recorded attempts.
 */
export interface PolicyNovelAction {
  /** Mechanism label for novel branch opens / refinements. */
  mechanism: string
  /** Mechanism tags for novel actions. */
  tags: string[]
  /** Short summary text for novel actions. */
  summary: string
}

/**
 * The versioned JSON exploration policy interpreted deterministically by the
 * plugin (spec §6.1 — policy-as-data replacing the paper's policy-as-code).
 * `guidance` must stay short/weak/empty: strong directional guidance hurts
 * long-horizon discovery (paper §5.1, spec §6.1 warning).
 */
export interface PolicyDsl {
  /** Display name, e.g. "portfolio-beta-0.6". */
  name: string
  /** Max parallelism (batch size cap), integer ≥ 1. */
  W: number
  gridPlan: PolicyGridPlan
  /**
   * The single scalar knob from the paper (0..1): high = more width, deeper
   * patience, weaker pruning; low = fewer probes, earlier stops, stronger pruning.
   */
  beta: number
  portfolio: PolicyPortfolio
  ranking: PolicyRanking
  pruning: PolicyPruning
  stopping: PolicyStopping
  /** Short semantic direction hint for the discovery agent — keep weak or empty. */
  guidance: string
  /** Optional descriptor used when replay estimates novel (unrecorded) actions. */
  novel?: PolicyNovelAction
}

/** Replay-evaluation results attached to a policy version by `dreamrsi_dream`. */
export interface PolicyEvaluation {
  /** V^m = (1/t) Σ_i V_i^m over the history at scoring time. */
  meanReplayScore: number | null
  perWorldScores: { worldId: string; score: number }[] | null
  /** Optional sweep frontier (spec §6.4). */
  betaSweep: { beta: number; reward: number }[] | null
}

/**
 * An immutable, versioned policy (spec §2.3). The `params` payload is never
 * modified in place; only `status` and `evaluation` bookkeeping change.
 *
 * v0.2 F1: `kind` discriminates the representation. `'dsl'` records (the
 * v0.1 shape, also the default for records written before the field existed)
 * carry `params: PolicyDsl`. `'code'` records carry a Python module exposing
 * `solve(view)`, persisted as `vNNNN.py` beside the index; `code` holds the
 * source (hydrated from disk by the store when reading a record).
 */
export interface PolicyRecord {
  /** e.g. "v0007". */
  version: string
  createdAt: string
  status: 'candidate' | 'active' | 'retired' | 'rejected'
  /** Policy lineage: which prior version this was derived from. */
  parentId: string | null
  kind?: 'dsl' | 'code'
  /** Display name (code records carry it directly; DSL records use params.name). */
  name?: string
  /** Max parallelism declared by a code policy (defaults to the bootstrap's 4). */
  W?: number
  /** DSL payload (`kind: 'dsl'`, or records predating `kind`). */
  params?: PolicyDsl
  /** Code-policy source (`kind: 'code'`), hydrated from `vNNNN.py` on read. */
  code?: string
  /** The proposing agent's rationale. */
  notes: string
  evaluation: PolicyEvaluation
}

/** Light index entry persisted in `policies/policy-index.json`. */
export interface PolicyIndexEntry {
  version: string
  status: PolicyRecord['status']
  createdAt: string
  parentId: string | null
  name: string
  /** Policy representation; absent on records written before v0.2 (`'dsl'`). */
  kind?: 'dsl' | 'code'
}

/** Persisted `policies/policy-index.json`. */
export interface PolicyIndex {
  activeVersion: string | null
  versions: PolicyIndexEntry[]
}

// ---------------------------------------------------------------------------
// Replay (spec §4, §5) and dreaming (spec §6)
// ---------------------------------------------------------------------------

/** Confidence of an RCO-estimated outcome (spec §5.3 step 4). */
export type EstimateConfidence = 'none' | 'low' | 'medium'

/** One node revealed during replay — recorded or estimated. */
export interface Reveal {
  node: NodeRecord
  /** True when the outcome came from the RCO estimator, not from history. */
  estimated: boolean
  /** Estimate confidence; `null` for recorded reveals. */
  confidence: EstimateConfidence | null
}

/** Stop reasons for a replay episode (spec §8.4). */
export type ReplayStopReason = 'empty-batch' | 'round-cap' | 'exhausted' | 'invalid'

/** Per-world replay result for one candidate (spec §7.5 `perWorld`). */
export interface WorldReplayResult {
  worldId: string
  /** V_i^m (Eq. 1 with §5.3 step 5 batch diversity). */
  score: number
  rounds: number
  reveals: number
  stopReason: ReplayStopReason
  /** Quality / cost / parallelism terms, logged separately for tuning. */
  terms: { quality: number; cost: number; parallelism: number }
  /** Share of revealed nodes whose outcome was estimated. */
  estOutcomeFraction: number
  batchSizes: number[]
  /** Set when the candidate produced an illegal batch on this world. */
  invalid?: string
  /** Compact capped step log (v0.2 F4 trajectory digest). */
  trajectory: WorldTrajectory
}

/** Degenerate-behavior flags over the whole dream run (spec §6.3.4). */
export interface CandidateDiagnostics {
  batchSizes: number[]
  estOutcomeFraction: number
  neverBatched: boolean
  singleBranch: boolean
  stopsImmediately: boolean
}

/**
 * One recorded step of a candidate's replay trajectory through one world
 * (v0.2 F4): the compact evidence the Listing 2 policy-development payload
 * (F2) and the dream report carry. Steps are capped per world at
 * `config.trajectoryCap`, oldest first.
 */
export interface TrajectoryStep {
  /** 1-based decision round within the episode. */
  decisionRound: number
  /** The selected node ids, in batch order. */
  batch: string[]
  /** How many of the batch elements opened a new branch (selected the root). */
  batchRootOpens: number
  /** How many batch elements refined an existing branch frontier. */
  batchRefinements: number
  /** Newly revealed nodes this step (recorded + estimated). */
  revealCount: number
  /** Per-step Eq. 1 term values after the reveal. */
  terms: { quality: number; cost: number; parallelism: number }
  /** True when every reveal this step came from the estimator. */
  estimatedOnly: boolean
}

/** Per-world trajectory digest attached to a replay result. */
export interface WorldTrajectory {
  worldId: string
  /** Steps, oldest first, capped at `config.trajectoryCap`. */
  steps: TrajectoryStep[]
  /** True when steps were dropped by the cap (they are summarized, not lost). */
  truncated: boolean
  /** Total steps the episode actually ran (≥ steps.length when truncated). */
  totalSteps: number
}

/** One ranked candidate in the dream report (spec §6.2, §7.5). */
export interface DreamRankingEntry {
  /** Candidate index in the submitted list (0 = incumbent). */
  candidate: number
  /** Display name from the DSL or the code-policy registration. */
  name: string
  /** Policy representation of this candidate. */
  kind: 'dsl' | 'code'
  /** Policy version if this candidate is a registered version, else null. */
  version: string | null
  /** V^m = mean over worlds; {@link INVALID_SCORE} stand-in when invalid. */
  meanScore: number
  perWorld: WorldReplayResult[]
  invalid: string | null
  diagnostics: CandidateDiagnostics
  /** Optional deterministic beta-sweep frontier (spec §6.4), when requested. */
  betaSweep?: { beta: number; reward: number }[]
}

/** Full dreaming report (spec §7.5 output). */
export interface DreamReport {
  runId: string
  createdAt: string
  selectedCandidate: number
  selectedName: string
  /** Policy representation of the selected candidate. */
  selectedKind: 'dsl' | 'code'
  /** Policy version of the selected candidate, or null when unregistered. */
  selectedVersion: string | null
  /** The selected DSL candidate's payload (dsl candidates only). */
  selectedParams?: PolicyDsl
  /** The selected code candidate's Python source (code candidates only). */
  selectedCode?: string
  ranking: DreamRankingEntry[]
  guards: { noRegression: boolean; incumbentScore: number }
  /** Number of worlds (closed trees) scored. */
  historySize: number
  /** Score normalization bounds used for Eq. 1 (nulls when normalization off/empty). */
  normalization: { min: number; max: number; enabled: boolean } | null
}

// ---------------------------------------------------------------------------
// Code policies (v0.2 F1): the solve(view) decision contract
// ---------------------------------------------------------------------------

/** One selectable node summary in a code policy's decision view. */
export interface PolicyViewNode {
  id: string
  /** Node id of the parent (the root for branch starts); null for the root. */
  parentId: string | null
  kind: 'root' | 'attempt'
  /** 0 for the root; parent.depth + 1 otherwise. */
  depth: number
  /** -1 for the root; the branch id of the node's chain otherwise. */
  branchId: number
  /** 0 for a branch start; increments along the chain. */
  seqInBranch: number
  /** Global creation sequence within the round (recency ordering). */
  seq: number
  /** Recorded score (0 and unevaluated for the root). */
  score: number
  evaluated: boolean
  valid: boolean
  failClass: FailClass
  deltaVsParent: number | null
  deltaVsBaseline: number | null
  /** Selectable-node count at this node's own decision time. */
  siblingCountAtDecision: number
  /** What the attempt at this node did (root: workspace summary). */
  actionSummary: string
  mechanism: string
  tags: string[]
  /** Free-form notes from the logging agent. */
  notes: string
}

/**
 * The decision view a code policy's `solve(view)` receives once per replay
 * decision round (v0.2 F1 contract). Stateless: every call describes the
 * full observable prefix.
 */
export interface PolicyView {
  roundId: string
  /** 1-based decision round within this episode. */
  decisionRound: number
  limits: { maxRounds: number; maxParallelism: number }
  /** Root + current leaves of the observed subtree, with their summaries. */
  selectable: PolicyViewNode[]
  history: {
    rounds: number
    totalNodes: number
    bestScoreOverall: number | null
    bestMechanisms: string[]
    knownDeadEnds: string[]
    /** Recorded score scale across the pool (normalization bounds). */
    scoreMin: number
    scoreMax: number
  }
}

/** What `solve(view)` must return: one legal batch selection. */
export interface PolicyDecision {
  /** Node ids chosen from `view.selectable`; ≤ limits.maxParallelism. */
  batch: string[]
  /** True ends the episode after this batch (batch still executes). */
  stop: boolean
  notes?: string
}

// ---------------------------------------------------------------------------
// Tool-facing result payloads (spec §7)
// ---------------------------------------------------------------------------

/** `dreamrsi_begin_round` result (spec §7.1). */
export interface BeginRoundResult {
  roundId: string
  policyVersion: string
  /** Policy representation of the active version. */
  policyKind: 'dsl' | 'code'
  /** The active DSL policy (dsl incumbents; code incumbents use policySource). */
  policy?: PolicyDsl
  /** The active code policy's Python source (code incumbents). */
  policySource?: string
  limits: { maxRounds: number; maxParallelism: number }
  historyDigest: {
    rounds: number
    totalNodes: number
    bestScoreOverall: number | null
    bestMechanisms: string[]
    knownDeadEnds: string[]
  }
  /**
   * Where this session's Dream-RSI state lives: the resolved store directory
   * (`dataDir` itself when absolute, else `<workspace>/dataDir`) and whether
   * the workspace came from the calling agent's session workspace (`session`)
   * or from the process working directory because no session workspace was
   * resolvable (`process-cwd`).
   */
  workspace?: { root: string; source: 'session' | 'process-cwd' }
}

/** One decision inside a `dreamrsi_log_decision` batch (spec §7.2 input). */
export interface DecisionInput {
  /** `null` ⇒ child of root: new branch. */
  parentId: string | null
  action: { summary: string; mechanism: string; tags: string[]; artifactPaths?: string[]; evalProgramPath?: string }
  outcome: {
    score: number
    evaluated: boolean
    valid: boolean
    failClass: FailClass
    error?: string | null
    deltaVsBaseline?: number | null
    deltaVsParent?: number | null
  }
  metrics: { agentCalls: number; wallMs?: number | null }
  notes?: string
}

/** `dreamrsi_log_decision` result (spec §7.2). */
export interface LogDecisionResult {
  accepted: string[]
  treeStats: { nodes: number; bestScore: number | null; decisionRounds: number }
  warnings: string[]
}

/** `dreamrsi_end_round` result (spec §7.3). */
export interface EndRoundResult {
  roundStats: RoundStats
  worldId: string
  simulator: { nodes: number; branches: number; maxDepth: number }
  activePolicyVersion: string
  /**
   * The dream report when `autoDream` ran the improvement stage after this
   * round closed (v0.2 F4); `null` with a reason when it was skipped.
   */
  autoDream?: { report: DreamReport | null; skippedReason?: string }
}

/** `dreamrsi_history` query (spec §7.4 input). */
export interface HistoryQuery {
  roundId?: string
  nodeId?: string
  view?: 'tree' | 'best-paths' | 'failures' | 'rounds' | 'summary'
  limit?: number
}

/** Ablridged node projection used by the history `tree` view (spec §7.4). */
export interface HistoryNodeSummary {
  id: string
  parentId: string | null
  depth: number
  branchId: number
  actionSummary: string
  mechanism: string
  tags: string[]
  score: number
  failClass: FailClass
  deltaVsParent: number | null
  estimated: boolean
}

/** `dreamrsi_policy_set` result (spec §7.7). */
export interface PolicySetResult {
  /** False when the no-regression guard rejected the activation. */
  accepted: boolean
  activeVersion: string
  previousVersion: string | null
  guardCheck: {
    meanReplayScore: number | null
    incumbentScore: number | null
    noRegression: boolean
    forced: boolean
  }
}
