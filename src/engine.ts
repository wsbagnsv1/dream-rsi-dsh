/**
 * Dream-RSI engine facade: orchestrates the store, the replay simulator, and
 * the dreaming loop into the seven model-facing operations (spec §7). This is
 * the layer the tool definitions delegate to; it holds no tool concerns.
 *
 * All operations are local and deterministic apart from timestamps (injected
 * clock) and the caller-supplied decision outcomes.
 *
 * State is PER WORKSPACE: every operation resolves its workspace root from
 * the explicit `workspaceRoot` option (the calling agent's session workspace,
 * supplied per tool call) or falls back to the engine's default root. Each
 * distinct root gets its own {@link DreamStore} — and therefore its own
 * `.dreamrsi/` data directory, rounds, policies, and dream reports — memoized
 * so the same workspace keeps one store instance.
 *
 * @module
 */

import * as path from 'node:path'
import { rm, writeFile } from 'node:fs/promises'
import { BOOTSTRAP_POLICY_SOURCE } from './bootstrap-policy.ts'
import { ADAPTER_PREAMBLE, LISTING2_PROMPT, parseCandidateSources, renderPayload, type Listing2Payload } from './dev-loop.ts'
import { runDream, defaultPolicyDsl, validatePolicyDsl, type CodePolicyRuntime, type DreamCandidate } from './dreaming.ts'
import { buildWorld, computeNormalization, type ReplayWorld } from './replay.ts'
import { DreamStore, StoreError, runnerPathOf, type DreamStoreReport } from './store.ts'
import type { LlmRuntime, SubprocessService } from './policy-runtime.ts'
import type {
  BeginRoundResult,
  DecisionInput,
  DreamReport,
  EndRoundResult,
  HistoryNodeSummary,
  HistoryQuery,
  LogDecisionResult,
  NodeRecord,
  PolicyDsl,
  PolicySetResult,
  PluginConfig,
  RoundRecord,
} from './types.ts'

/**
 * Map one submitted dream candidate onto the v0.2 candidate union: a bare
 * string is a CODE policy source, `{ code }` a named code policy, and an
 * object carrying the DSL shape (`W` + `gridPlan`) a legacy DSL. Unknown
 * shapes surface as invalid DSL candidates through validation.
 */
function toDreamCandidate(raw: unknown): DreamCandidate {
  if (typeof raw === 'string') {
    return { kind: 'code', code: raw, name: 'code-candidate', W: 4, version: null }
  }
  if (typeof raw === 'object' && raw !== null) {
    const record = raw as Record<string, unknown>
    if (typeof record['code'] === 'string') {
      return {
        kind: 'code',
        code: record['code'],
        name: typeof record['name'] === 'string' ? record['name'] : 'code-candidate',
        W: typeof record['W'] === 'number' && Number.isInteger(record['W']) && record['W'] >= 1 ? record['W'] : 4,
        version: null,
      }
    }
  }
  return { kind: 'dsl', dsl: raw as PolicyDsl, version: null }
}

/** Error surfaced to the model as a tool error (invalid input or state). */
export class EngineError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EngineError'
  }
}

/** Per-operation workspace override (the calling agent's session workspace). */
export interface WorkspaceOption {
  /**
   * Workspace root for this operation; defaults to the engine's default root.
   * The final store directory is `dataDir` itself when absolute, else
   * `<workspaceRoot>/<dataDir>` — memoization keys on that directory, so an
   * absolute `dataDir` shares one store across every workspace.
   */
  workspaceRoot?: string
  /**
   * How the workspace root was resolved, supplied by the tool layer:
   * `session` (the calling agent's session workspace) or `process-cwd`
   * (fallback for non-agent callers). Drives the fallback surfacing in
   * results and warnings.
   */
  workspaceSource?: 'session' | 'process-cwd'
}

/** Options for {@link DreamEngine}. */
export interface DreamEngineOptions {
  config: PluginConfig
  /**
   * Default workspace root for operations that carry no explicit
   * `workspaceRoot` (non-agent callers). The plugin wiring passes
   * `process.cwd()` here.
   */
  workspaceRoot?: string
  /** Injectable clock (determinism in tests). */
  clock?: () => Date
  /**
   * The `ctx.subprocess` seam for v0.2 code policies. Optional (fail-soft):
   * without it, code candidates replay as invalid while everything else works.
   */
  subprocess?: SubprocessService
  /**
   * The `ctx.llm` seam for the v0.2 F2 host-llm development loop. Optional
   * (fail-soft `ctx.get('llm')`): without it the loop falls back to
   * `devLoop: 'agent-relay'` regardless of config.
   */
  llm?: LlmRuntime
}

/** Per-workspace engine state, memoized by resolved root. */
interface WorkspaceState {
  root: string
  store: DreamStore
  worlds: Map<string, ReplayWorld>
  /** Bootstrap dedup: one init + default-policy registration per workspace. */
  ready: Promise<void> | null
  /**
   * The most recent dream report in this workspace (v0.2 F2): its incumbent
   * trajectory digests feed the Listing 2 payload on the next cycle.
   */
  lastReport: DreamReport | null
}

/**
 * The Dream-RSI engine: online rollout bookkeeping (begin/log/end), history
 * queries, offline dreaming, and policy versioning/redeployment — isolated
 * per workspace.
 */
export class DreamEngine {
  /**
   * The durable store of the DEFAULT workspace (also useful for tests and
   * host integrations). Per-workspace stores live in {@link workspaces}.
   */
  readonly store: DreamStore
  private readonly config: PluginConfig
  private readonly defaultRoot: string
  private readonly clock: () => Date
  /** The subprocess seam for code policies and the ncu benchmark tool. */
  readonly subprocess: SubprocessService | undefined
  private readonly llm: LlmRuntime | undefined
  private readonly workspaces = new Map<string, WorkspaceState>()

  constructor(options: DreamEngineOptions) {
    this.config = options.config
    this.clock = options.clock ?? (() => new Date())
    this.subprocess = options.subprocess
    this.llm = options.llm
    this.defaultRoot = path.resolve(options.workspaceRoot ?? process.cwd())
    this.store = this.createStore(this.defaultRoot)
  }

  /** Memo key for a store directory (drive-letter casing is not distinct on Windows). */
  private memoKey(root: string): string {
    const resolved = path.resolve(root)
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved
  }

  /**
   * The final store directory for a workspace root: `config.dataDir` itself
   * when absolute, else `<workspaceRoot>/<dataDir>`.
   */
  private storeRootOf(workspaceRoot: string): string {
    return path.isAbsolute(this.config.dataDir)
      ? path.resolve(this.config.dataDir)
      : path.resolve(workspaceRoot, this.config.dataDir)
  }

  private createStore(storeRoot: string): DreamStore {
    return new DreamStore({
      config: this.config,
      workspaceRoot: storeRoot,
      clock: this.clock,
    })
  }

  /** The (memoized) workspace state for an explicit root, or the default. */
  private workspaceFor(workspaceRoot?: string): WorkspaceState {
    const root = workspaceRoot !== undefined ? path.resolve(workspaceRoot) : this.defaultRoot
    const key = this.memoKey(this.storeRootOf(root))
    const existing = this.workspaces.get(key)
    if (existing) return existing
    const created: WorkspaceState = {
      root,
      store: key === this.memoKey(this.storeRootOf(this.defaultRoot)) ? this.store : this.createStore(root),
      worlds: new Map(),
      ready: null,
      lastReport: null,
    }
    this.workspaces.set(key, created)
    return created
  }

  /** Initialize the workspace's data dir and register the bootstrap policy when empty (idempotent, deduplicated per workspace). */
  private async workspaceReady(workspaceRoot?: string): Promise<WorkspaceState> {
    const ws = this.workspaceFor(workspaceRoot)
    ws.ready ??= this.bootstrapWorkspace(ws)
    return await ws.ready.then(() => ws)
  }

  private async bootstrapWorkspace(ws: WorkspaceState): Promise<void> {
    await ws.store.init()
    const active = await ws.store.getActivePolicyVersion()
    if (active === null) {
      const existing = await ws.store.listPolicyEntries()
      if (existing.length === 0) {
        // v0.2 F1: `policyEngine: 'code'` (the paper-faithful default)
        // bootstraps a CODE policy (solve(view) subprocess contract); the
        // legacy JSON DSL bootstrap remains for `policyEngine: 'legacy'`.
        const record = this.config.policyEngine === 'legacy'
          ? await ws.store.registerPolicy(defaultPolicyDsl(this.config), 'bootstrap policy created by the plugin', null, 'candidate')
          : await ws.store.registerCodePolicy(BOOTSTRAP_POLICY_SOURCE, 'bootstrap-balanced', 'bootstrap code policy created by the plugin (v0.2 paper-faithful default)', null, 'candidate')
        await ws.store.setActivePolicy(record.version, true)
      }
    }
  }

  /**
   * Initialize the data dir and register the bootstrap policy when empty, for
   * the default workspace (or the given one). Idempotent; public for tests
   * and host integrations.
   */
  async bootstrap(workspaceRoot?: string): Promise<void> {
    await this.workspaceReady(workspaceRoot)
  }

  // ------------------------------------------------------------ online phase

  /**
   * Start one online rollout (spec §7.1). Fails when another round is still
   * open — one round at a time, mirroring the paper's outer iteration.
   */
  async beginRound(opts: WorkspaceOption = {}): Promise<BeginRoundResult> {
    const ws = await this.workspaceReady(opts.workspaceRoot)
    const open = await ws.store.getOpenRound()
    if (open) throw new EngineError(`round ${open.roundId} is still open; call dreamrsi_end_round first`)
    const active = await ws.store.getActivePolicy()
    if (!active) throw new EngineError('no active policy; register one with dreamrsi_policy_set')
    const kind = active.kind ?? 'dsl'
    const parallelism = kind === 'code' ? active.W ?? 4 : active.params?.W ?? 4
    const round = await ws.store.createRound(active.version, {
      maxRounds: this.config.maxOnlineRounds,
      maxParallelism: parallelism,
    })
    const digest = await this.historyDigest(ws)
    await ws.store.logEvent('dreamrsi_begin_round', {}, { roundId: round.roundId, policyVersion: active.version }, active.version)
    return {
      roundId: round.roundId,
      policyVersion: active.version,
      policyKind: kind,
      ...(kind === 'code'
        ? { policySource: active.code ?? '' }
        : active.params !== undefined
          ? { policy: active.params }
          : {}),
      limits: { maxRounds: round.limits.maxRounds, maxParallelism: round.limits.maxParallelism },
      historyDigest: digest,
      // Where this round's state lives: the resolved store directory, and how
      // the workspace was determined (session workspace vs process-cwd
      // fallback — the same value for an absolute dataDir).
      workspace: { root: ws.store.root, source: opts.workspaceSource ?? 'process-cwd' },
    }
  }

  /**
   * Log one decision round: the batch and each attempt's outcome (spec §7.2).
   * `batchSeq` groups incremental per-node calls into one decision round.
   */
  async logDecision(input: { roundId: string; batchSeq: number; decisions: readonly DecisionInput[] }, opts: WorkspaceOption = {}): Promise<LogDecisionResult> {
    const ws = await this.workspaceReady(opts.workspaceRoot)
    const round = await ws.store.getRound(input.roundId)
    if (!round) throw new EngineError(`unknown round ${input.roundId}`)
    if (round.status !== 'open') throw new EngineError(`round ${input.roundId} is closed`)
    if (!Number.isInteger(input.batchSeq) || input.batchSeq < 1) {
      throw new EngineError('batchSeq must be an integer ≥ 1')
    }
    // Surface the process-cwd fallback early (also on the empty-decisions
    // return) and only when it actually moves the store: an absolute dataDir
    // ignores the workspace, so the fallback is invisible there.
    const fallbackWarning = opts.workspaceSource === 'process-cwd' && !path.isAbsolute(this.config.dataDir)
      ? 'no session workspace resolvable for this call; Dream-RSI state resolved against the process working directory'
      : null
    if (input.decisions.length === 0) {
      return {
        accepted: [],
        treeStats: await this.treeStats(ws, input.roundId),
        warnings: [...(fallbackWarning !== null ? [fallbackWarning] : []), 'empty decisions array ignored (stop by closing the round)'],
      }
    }
    for (const decision of input.decisions) {
      if (typeof decision.action?.summary !== 'string' || decision.action.summary.trim().length === 0) {
        throw new EngineError('each decision needs a non-empty action.summary')
      }
      if (typeof decision.action.mechanism !== 'string' || decision.action.mechanism.trim().length === 0) {
        throw new EngineError('each decision needs a non-empty action.mechanism')
      }
      if (!Number.isInteger(decision.metrics?.agentCalls) || decision.metrics.agentCalls < 0) {
        throw new EngineError('metrics.agentCalls must be an integer ≥ 0')
      }
    }
    const { accepted, warnings } = await ws.store.appendNodes(input.roundId, input.decisions.map((decision) => ({
      parentId: decision.parentId,
      action: {
        summary: decision.action.summary,
        mechanism: decision.action.mechanism,
        tags: [...(decision.action.tags ?? [])],
        artifactPaths: [...(decision.action.artifactPaths ?? [])],
        ...(decision.action.evalProgramPath !== undefined ? { evalProgramPath: decision.action.evalProgramPath } : {}),
      },
      score: decision.outcome.score,
      evaluated: decision.outcome.evaluated,
      valid: decision.outcome.valid,
      failClass: decision.outcome.failClass,
      error: decision.outcome.error ?? null,
      deltaVsBaseline: decision.outcome.deltaVsBaseline ?? null,
      deltaVsParent: decision.outcome.deltaVsParent ?? null,
      agentCalls: decision.metrics.agentCalls,
      wallMs: decision.metrics.wallMs ?? null,
      notes: decision.notes ?? '',
    })))
    await ws.store.recordBatch(input.roundId, input.batchSeq, accepted.length)
    await ws.store.logEvent('dreamrsi_log_decision', { roundId: input.roundId, batchSeq: input.batchSeq }, { accepted: accepted.length }, round.policyVersion)
    if (fallbackWarning !== null) warnings.push(fallbackWarning)
    return { accepted: accepted.map((node) => node.id), treeStats: await this.treeStats(ws, input.roundId), warnings }
  }

  /**
   * Close the round, construct the replay world for the finished tree
   * (spec §7.3), and — per `config.autoDream` (v0.2 F4, default
   * `'every-cycle'`) — run the dreaming stage automatically. Dreaming is a
   * mandatory stage of every outer iteration in the paper; 'on-stagnation'
   * runs it only when the round did not improve the best score overall, and
   * 'off' keeps the v0.1 agent-driven shape.
   */
  async endRound(input: { roundId: string; summary?: string }, opts: WorkspaceOption = {}): Promise<EndRoundResult> {
    const ws = await this.workspaceReady(opts.workspaceRoot)
    const round = await ws.store.getRound(input.roundId)
    if (!round) throw new EngineError(`unknown round ${input.roundId}`)
    if (round.status === 'closed') throw new EngineError(`round ${input.roundId} is already closed`)
    const previousBest = (await this.historyDigest(ws)).bestScoreOverall
    const closed = await ws.store.closeRound(input.roundId, input.summary)
    const world = await this.worldFor(ws, closed.roundId)
    await ws.store.logEvent('dreamrsi_end_round', { roundId: input.roundId }, { worldId: closed.roundId }, closed.policyVersion)
    const result: EndRoundResult = {
      roundStats: closed.stats,
      worldId: closed.roundId,
      simulator: {
        nodes: world.nodes.length,
        branches: world.rootChildren.length,
        maxDepth: Math.max(0, ...world.nodes.map((node) => node.state.depth)),
      },
      activePolicyVersion: closed.policyVersion,
    }
    // --- v0.2 F4: the mandatory dreaming stage ---
    const roundBest = closed.stats.bestScore
    const stagnating = roundBest === null || previousBest === null || roundBest <= previousBest
    if (this.config.autoDream === 'every-cycle' || (this.config.autoDream === 'on-stagnation' && stagnating)) {
      try {
        // --- v0.2 F2: the Listing 2 policy-development loop ---
        const report = await this.dream({}, opts)
        result.autoDream = { report }
      } catch (error) {
        // A failed improvement stage never fails the round: the incumbent
        // stays active and the failure is surfaced in the result.
        result.autoDream = { report: null, skippedReason: `autoDream failed: ${error instanceof Error ? error.message : String(error)}` }
      }
    } else {
      result.autoDream = {
        report: null,
        skippedReason: this.config.autoDream === 'off'
          ? 'autoDream is off'
          : 'on-stagnation: the round improved the best score overall',
      }
    }
    return result
  }

  /**
   * The v0.2 F2 policy-development loop (runs inside autoDream only).
   *
   * `devLoop: 'host-llm'` + a composed `ctx.llm` service: ONE budgeted model
   * call per cycle with the VERBATIM Listing 2 prompt (plus the adapter
   * preamble mapping the paper's OptimalPolicy class onto this plugin's
   * stateless `solve(view)` contract) and a payload of trajectory digests,
   * score stats, and the incumbent's Python source. The response is parsed
   * into fenced candidate sources; malformed ones are skipped and logged —
   * generation failures degrade to an empty pool (incumbent retained), never
   * a crashed cycle. LLM nondeterminism is confined to this step.
   *
   * `devLoop: 'agent-relay'` (default) or a missing llm service returns []
   * — the host agent authors candidates from the dream report's trajectory
   * digests and commits them via `dreamrsi_policy_set`.
   */
  private async developCandidates(ws: WorkspaceState, opts: WorkspaceOption): Promise<DreamCandidate[]> {
    if (this.config.devLoop !== 'host-llm' || this.llm === undefined) return []
    const active = await ws.store.getActivePolicy()
    if (active === null || active.kind !== 'code') return []
    const historyDigest = await this.historyDigest(ws)
    const closedWorlds = await this.closedWorlds(ws)
    const normalization = computeNormalization(closedWorlds, this.config.normalizeScores)
    // The incumbent's trajectory digests come from the LAST dream report
    // (candidate 0 = incumbent, v0.2 F4 digests) — between-round feedback.
    const trajectories = ws.lastReport?.ranking
      .find((entry) => entry.candidate === 0)?.perWorld.map((result) => ({
        worldId: result.worldId,
        steps: result.trajectory.steps,
        truncated: result.trajectory.truncated,
        totalSteps: result.trajectory.totalSteps,
      })) ?? []
    const payload: Listing2Payload = {
      incumbentSource: active.code ?? null,
      trajectories,
      scoreStats: {
        rounds: historyDigest.rounds,
        totalNodes: historyDigest.totalNodes,
        bestScoreOverall: historyDigest.bestScoreOverall,
        bestMechanisms: historyDigest.bestMechanisms,
        knownDeadEnds: historyDigest.knownDeadEnds,
        scoreMin: normalization.min,
        scoreMax: normalization.max,
      },
      poolSize: this.config.poolSize,
    }
    const prompt = ADAPTER_PREAMBLE + '\n\n' + renderPayload(payload) + '\n\n' + LISTING2_PROMPT
    const route = this.config.llmRoute ?? this.defaultLlmRoute()
    if (route === null) return []
    const budget = Math.max(1, this.config.maxLlmCallsPerCycle)
    const sources: string[] = []
    const skipped: string[] = []
    for (let attempt = 0; attempt < budget && sources.length < this.config.poolSize; attempt++) {
      try {
        const text = await this.collectStreamText(route, prompt)
        const parsed = parseCandidateSources(text, this.config.poolSize - sources.length)
        sources.push(...parsed.sources)
        skipped.push(...parsed.skipped)
        if (parsed.sources.length === 0) break
      } catch (error) {
        // Generation failure degrades to keeping the incumbent (never a crash).
        skipped.push(`llm call failed: ${error instanceof Error ? error.message : String(error)}`)
        break
      }
    }
    await ws.store.logEvent('dev.loop', { devLoop: 'host-llm', attempts: budget, sources: sources.length, skipped: skipped.length }, { sources: sources.length }, active.version)
    void opts
    return sources.map((code) => ({ kind: 'code' as const, code, name: 'llm-candidate', W: 4, version: null }))
  }

  /** The deployment default route: first registered provider + its first listed model. */
  private defaultLlmRoute(): { provider: string; model: string } | null {
    try {
      const provider = this.llm?.listProviders()[0]?.name
      if (provider === undefined) return null
      const model = this.llm?.listModels(provider)[0]?.model
      return model === undefined ? null : { provider, model }
    } catch {
      return null
    }
  }

  /** One budgeted streaming call, collected to text (text-delta join). */
  private async collectStreamText(route: { provider: string; model: string }, prompt: string): Promise<string> {
    const stream = this.llm!.stream({
      provider: route.provider,
      model: route.model,
      system: prompt,
      messages: [{ role: 'user', content: 'Produce the candidate policy pool now, per the deliverable section.' }],
      temperature: 0.8,
    })
    let text = ''
    for await (const chunk of stream) {
      if (chunk.type === 'text-delta') text += chunk.text
      if (chunk.type === 'finish' && chunk.reason !== undefined && chunk.reason.kind === 'error') {
        throw new Error(chunk.reason.failure?.message ?? 'llm finish error')
      }
    }
    return text
  }

  /** All closed worlds of the workspace, in round order. */
  private async closedWorlds(ws: WorkspaceState): Promise<ReplayWorld[]> {
    const closed = (await ws.store.listRounds()).filter((round) => round.status === 'closed')
    const worlds: ReplayWorld[] = []
    for (const round of closed) worlds.push(await this.worldFor(ws, round.roundId))
    return worlds
  }

  // ------------------------------------------------------------ history read

  /**
   * Read-only query over accumulated history (spec §7.4): `tree`,
   * `best-paths`, `failures`, `rounds`, or `summary` views; a `nodeId` returns
   * the node plus its subtree.
   */
  async history(query: HistoryQuery, opts: WorkspaceOption = {}): Promise<Record<string, unknown>> {
    const ws = await this.workspaceReady(opts.workspaceRoot)
    const view = query.view ?? 'tree'
    const limit = query.limit ?? 20
    if (query.nodeId !== undefined) {
      const node = await ws.store.getNode(query.nodeId)
      if (!node) throw new EngineError(`unknown node ${query.nodeId}`)
      const subtree = await ws.store.getSubtree(node.roundId, node.id)
      return { node: summarizeNode(node), subtree: subtree.map(summarizeNode) }
    }
    const rounds = await ws.store.listRounds()
    const scoped = query.roundId !== undefined ? rounds.filter((round) => round.roundId === query.roundId) : rounds
    if (query.roundId !== undefined && scoped.length === 0) throw new EngineError(`unknown round ${query.roundId}`)

    if (view === 'rounds') {
      return { rounds: scoped }
    }
    if (view === 'summary') {
      return this.historySummary(ws, scoped)
    }
    if (view === 'best-paths') {
      return this.bestPaths(ws, scoped, limit)
    }
    if (view === 'failures') {
      return this.failuresView(ws, scoped, limit)
    }
    const trees = []
    for (const round of scoped) {
      const nodes = await ws.store.getNodes(round.roundId)
      trees.push({
        roundId: round.roundId,
        policyVersion: round.policyVersion,
        status: round.status,
        nodes: nodes.map(summarizeNode),
      })
    }
    return { rounds: trees }
  }

  /** Compact stats digest (spec §8.3). */
  private async historySummary(ws: WorkspaceState, rounds: readonly RoundRecord[]): Promise<Record<string, unknown>> {
    let cumulativeAgentCalls = 0
    let bestOverall: number | null = null
    const perRound: Record<string, unknown>[] = []
    const mechanismHistogram = new Map<string, number>()
    const repairCounts = new Map<string, number>()
    for (const round of rounds) {
      const nodes = await ws.store.getNodes(round.roundId)
      const attempts = nodes.filter((node) => node.kind === 'attempt')
      cumulativeAgentCalls += attempts.reduce((sum, node) => sum + node.metrics.agentCalls, 0)
      const evaluated = attempts.filter((node) => node.outcome.evaluated)
      const best = evaluated.length > 0 ? Math.max(...evaluated.map((node) => node.outcome.score)) : null
      if (best !== null && (bestOverall === null || best > bestOverall)) bestOverall = best
      for (const node of attempts) {
        mechanismHistogram.set(node.action.mechanism, (mechanismHistogram.get(node.action.mechanism) ?? 0) + 1)
        if (node.outcome.failClass !== 'ok') {
          repairCounts.set(node.action.mechanism, (repairCounts.get(node.action.mechanism) ?? 0) + 1)
        }
      }
      perRound.push({
        roundId: round.roundId,
        status: round.status,
        policyVersion: round.policyVersion,
        cumulativeAgentCalls,
        bestScore: best,
        bestScoreOverall: bestOverall,
        explorationEffort: evaluated.length,
        decisionRounds: round.stats.decisionRounds,
        avgBatchSize: round.stats.avgBatchSize,
        composition: round.stats.composition,
      })
    }
    return {
      rounds: perRound,
      mechanisms: [...mechanismHistogram.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([mechanism, count]) => ({ mechanism, count })),
      repairs: [...repairCounts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([mechanism, count]) => ({ mechanism, count })),
      bestScoreOverall: bestOverall,
    }
  }

  /** Top-k chains by cumulative evaluated score (spec §7.4 best-paths). */
  private async bestPaths(ws: WorkspaceState, rounds: readonly RoundRecord[], limit: number): Promise<Record<string, unknown>> {
    const paths: { roundId: string; branchId: number; cumulativeScore: number; length: number; chain: HistoryNodeSummary[] }[] = []
    for (const round of rounds) {
      const nodes = await ws.store.getNodes(round.roundId)
      const root = nodes.find((node) => node.kind === 'root')
      if (!root) continue
      const byBranch = new Map<number, NodeRecord[]>()
      for (const node of nodes) {
        if (node.kind !== 'attempt') continue
        const list = byBranch.get(node.state.branchId) ?? []
        list.push(node)
        byBranch.set(node.state.branchId, list)
      }
      for (const [branchId, chainNodes] of byBranch) {
        // Order the chain by seqInBranch (linear chains, spec §0).
        const ordered = [...chainNodes].sort((a, b) => a.state.seqInBranch - b.state.seqInBranch)
        const cumulativeScore = ordered.reduce((sum, node) => sum + (node.outcome.evaluated ? node.outcome.score : 0), 0)
        paths.push({
          roundId: round.roundId,
          branchId,
          cumulativeScore,
          length: ordered.length,
          chain: ordered.map(summarizeNode),
        })
      }
    }
    paths.sort((a, b) => b.cumulativeScore - a.cumulativeScore || a.roundId.localeCompare(b.roundId) || a.branchId - b.branchId)
    return { bestPaths: paths.slice(0, Math.max(1, limit)) }
  }

  /** Failed attempts grouped by mechanism + error digest (spec §7.4 failures). */
  private async failuresView(ws: WorkspaceState, rounds: readonly RoundRecord[], limit: number): Promise<Record<string, unknown>> {
    const groups = new Map<string, { mechanism: string; errorDigest: string; count: number; sample: HistoryNodeSummary }>()
    for (const round of rounds) {
      const nodes = await ws.store.getNodes(round.roundId)
      for (const node of nodes) {
        if (node.kind !== 'attempt') continue
        if (node.outcome.failClass === 'ok' && node.outcome.evaluated) continue
        const digest = (node.outcome.error ?? 'no error text').slice(0, 120)
        const key = `${node.action.mechanism}::${digest}`
        const existing = groups.get(key)
        if (existing) {
          existing.count += 1
        } else {
          groups.set(key, { mechanism: node.action.mechanism, errorDigest: digest, count: 1, sample: summarizeNode(node) })
        }
      }
    }
    const failures = [...groups.values()]
      .sort((a, b) => b.count - a.count || a.mechanism.localeCompare(b.mechanism))
      .slice(0, Math.max(1, limit))
    return { failures }
  }

  /** Digest returned by `dreamrsi_begin_round` (spec §7.1). */
  private async historyDigest(ws: WorkspaceState): Promise<BeginRoundResult['historyDigest']> {
    const rounds = (await ws.store.listRounds()).filter((round) => round.status === 'closed')
    let totalNodes = 0
    let bestScoreOverall: number | null = null
    const mechanismBest = new Map<string, number>()
    const mechanismAttempts = new Map<string, { count: number; anySuccess: boolean }>()
    for (const round of rounds) {
      const nodes = await ws.store.getNodes(round.roundId)
      totalNodes += nodes.length
      for (const node of nodes) {
        if (node.kind !== 'attempt') continue
        const stats = mechanismAttempts.get(node.action.mechanism) ?? { count: 0, anySuccess: false }
        stats.count += 1
        if (node.outcome.evaluated && node.outcome.failClass === 'ok') stats.anySuccess = true
        mechanismAttempts.set(node.action.mechanism, stats)
        if (node.outcome.evaluated) {
          mechanismBest.set(node.action.mechanism, Math.max(mechanismBest.get(node.action.mechanism) ?? Number.NEGATIVE_INFINITY, node.outcome.score))
          if (bestScoreOverall === null || node.outcome.score > bestScoreOverall) bestScoreOverall = node.outcome.score
        }
      }
    }
    const bestMechanisms = [...mechanismBest.entries()]
      .filter(([mechanism]) => mechanismAttempts.get(mechanism)?.anySuccess === true)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 5)
      .map(([mechanism]) => mechanism)
    const knownDeadEnds = [...mechanismAttempts.entries()]
      .filter(([, stats]) => !stats.anySuccess)
      .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
      .slice(0, 5)
      .map(([mechanism]) => mechanism)
    return { rounds: rounds.length, totalNodes, bestScoreOverall, bestMechanisms, knownDeadEnds }
  }

  private async treeStats(ws: WorkspaceState, roundId: string): Promise<LogDecisionResult['treeStats']> {
    const round = await ws.store.getRound(roundId)
    const nodes = await ws.store.getNodes(roundId)
    const evaluated = nodes.filter((node) => node.kind === 'attempt' && node.outcome.evaluated)
    return {
      nodes: nodes.length,
      bestScore: evaluated.length > 0 ? Math.max(...evaluated.map((node) => node.outcome.score)) : null,
      decisionRounds: round?.stats.decisionRounds ?? 0,
    }
  }

  // ----------------------------------------------------------- offline phase

  /**
   * Run the dreaming phase (spec §7.5): the incumbent is prepended as
   * candidate 0 automatically, every candidate is replay-scored over all
   * closed trees, and the ranked report is persisted. The active policy is
   * NOT changed — that is `dreamrsi_policy_set`'s job.
   *
   * v0.2 F1: candidates may be CODE policies (a Python `solve(view)` source —
   * a bare string or `{ code, name?, W? }`) or legacy DSL objects; each is
   * replayed by its own representation. Code candidates run in ONE subprocess
   * per candidate (all worlds inside it); without a subprocess seam they
   * replay as invalid while the rest of the run proceeds.
   */
  async dream(input: { candidates?: readonly unknown[]; sweepBetas?: readonly number[]; strictGuards?: boolean }, opts: WorkspaceOption = {}): Promise<DreamReport> {
    const ws = await this.workspaceReady(opts.workspaceRoot)
    const active = await ws.store.getActivePolicy()
    if (!active) throw new EngineError('no active policy to seed candidate 0')
    const closed = (await ws.store.listRounds()).filter((round) => round.status === 'closed')
    const worlds: ReplayWorld[] = []
    for (const round of closed) worlds.push(await this.worldFor(ws, round.roundId))
    const historyDigest = await this.historyDigest(ws)
    const normalization = computeNormalization(worlds, this.config.normalizeScores)

    // Candidate 0: the incumbent, replayed by its own representation.
    const candidates: DreamCandidate[] = [active.kind === 'code'
      ? { kind: 'code', code: active.code ?? '', name: active.name ?? active.version, W: active.W ?? 4, version: active.version }
      : { kind: 'dsl', dsl: active.params as PolicyDsl, version: active.version },
    ]
    const submitted = [...(input.candidates ?? [])]
    if (submitted.length === 0) {
      // No candidates submitted (autoDream or a bare dreamrsi_dream call):
      // the host-llm development loop fills the pool (v0.2 F2). agent-relay
      // leaves the pool at the incumbent — the dream report's trajectory
      // digests are the relay payload for the host agent.
      candidates.push(...await this.developCandidates(ws, opts))
    }
    for (const raw of submitted) {
      candidates.push(toDreamCandidate(raw))
    }

    // Code candidates need their source on disk for the runner; temp files
    // live beside the policies as dot-files and are removed after the run.
    const runId = await ws.store.nextDreamRunId()
    const runtime: CodePolicyRuntime | undefined = this.subprocess === undefined
      ? undefined
      : {
        subprocess: this.subprocess,
        runnerPath: runnerPathOf(ws.store.root),
        policyDir: path.join(ws.store.root, 'policies'),
        policyPathFor: (index: number) => path.join(ws.store.root, 'policies', `.dream-candidate-${runId}-${String(index).padStart(3, '0')}.py`),
        episodeTimeoutMs: this.config.policyEpisodeTimeoutMs,
        historyDigest,
        scoreScale: { min: normalization.min, max: normalization.max },
      }
    const candidateFiles: string[] = []
    if (runtime !== undefined) {
      for (const [index, candidate] of candidates.entries()) {
        if (candidate.kind !== 'code') continue
        const file = runtime.policyPathFor(index)
        await writeFile(file, candidate.code, 'utf8')
        candidateFiles.push(file)
      }
    }

    try {
      const report = await runDream({
        candidates,
        worlds,
        config: this.config,
        runId,
        createdAt: ws.store.now(),
        sweepBetas: [...(input.sweepBetas ?? [])],
        strictGuards: input.strictGuards ?? false,
        ...(runtime !== undefined ? { runtime } : {}),
        historyDigest,
      })
      await ws.store.saveDreamReport(report as unknown as DreamStoreReport)
      ws.lastReport = report
      await ws.store.logEvent('dreamrsi_dream', { candidateCount: candidates.length, sweepBetas: input.sweepBetas ?? [] }, { runId, selected: report.selectedCandidate, selectedKind: report.selectedKind }, active.version)
      return report
    } finally {
      for (const file of candidateFiles) {
        await rm(file, { force: true })
      }
    }
  }

  // ---------------------------------------------------------------- policies

  /** Read the active (or a named) policy version with its history (spec §7.6). */
  async policyGet(input: { version?: string }, opts: WorkspaceOption = {}): Promise<Record<string, unknown>> {
    const ws = await this.workspaceReady(opts.workspaceRoot)
    const activeVersion = await ws.store.getActivePolicyVersion()
    const version = input.version ?? activeVersion
    if (!version) throw new EngineError('no policy versions exist yet')
    const policy = await ws.store.getPolicy(version)
    if (!policy) throw new EngineError(`unknown policy version ${version}`)
    const history = (await ws.store.listPolicyEntries()).map((entry) => ({
      version: entry.version,
      status: entry.status,
      name: entry.name,
      createdAt: entry.createdAt,
      parentId: entry.parentId,
    }))
    return { activeVersion, policy, history }
  }

  /**
   * Commit a policy version as active (spec §7.7). Input variants:
   * `{ version }` activates an existing version; `{ policy, notes }` registers
   * a new immutable DSL version (parent = incumbent) first; `{ code, name?,
   * notes }` (v0.2 F1) registers a new immutable CODE policy. The
   * no-regression guard rejects strictly worse evaluated versions unless
   * `force`.
   */
  async policySet(input: { version?: string; policy?: unknown; code?: string; name?: string; notes?: string; force?: boolean }, opts: WorkspaceOption = {}): Promise<PolicySetResult> {
    const ws = await this.workspaceReady(opts.workspaceRoot)
    const force = input.force ?? false
    const previous = await ws.store.getActivePolicyVersion()
    let version = input.version
    let registeredKind: 'dsl' | 'code' | null = null
    if (input.code !== undefined) {
      if (input.version !== undefined || input.policy !== undefined) {
        throw new EngineError('pass only one of `version`, `policy`, or `code`')
      }
      if (typeof input.code !== 'string' || input.code.trim().length === 0) {
        throw new EngineError('`code` must be a non-empty Python policy source string')
      }
      if (!input.code.includes('def solve')) {
        throw new EngineError('`code` must define a callable solve(view) (missing `def solve`)')
      }
      const record = await ws.store.registerCodePolicy(
        input.code,
        typeof input.name === 'string' && input.name.trim() !== '' ? input.name : 'code-policy',
        input.notes ?? '',
        previous,
        'candidate',
      )
      version = record.version
      registeredKind = 'code'
    } else if (input.policy !== undefined) {
      if (input.version !== undefined) throw new EngineError('pass either `version` or `policy`, not both')
      const validation = validatePolicyDsl(input.policy)
      if (!validation.ok) throw new EngineError(`invalid PolicyDsl: ${validation.errors.join('; ')}`)
      const record = await ws.store.registerPolicy(input.policy as PolicyDsl, input.notes ?? '', previous, 'candidate')
      version = record.version
      registeredKind = 'dsl'
    }
    if (!version) throw new EngineError('provide a `version` to activate, a `policy` to register and activate, or a `code` policy to register and activate')
    const result = await ws.store.setActivePolicy(version, force)
    if (!result.accepted) {
      // Guard rejection: surface the report without changing the active
      // pointer; a freshly-registered candidate is marked `rejected` so it
      // stays auditable (spec §7.7 "rejects with the guard report").
      if (registeredKind === 'code') await ws.store.markPolicyStatus(version, 'rejected')
      if (input.policy !== undefined) await ws.store.markPolicyStatus(version, 'rejected')
      return {
        accepted: false,
        activeVersion: result.previous ?? version,
        previousVersion: result.previous,
        guardCheck: result.guard,
      }
    }
    return {
      accepted: true,
      activeVersion: version,
      previousVersion: result.previous,
      guardCheck: result.guard,
    }
  }

  // ------------------------------------------------------------------ worlds

  /** Build (or fetch from the workspace's cache) the immutable world index of a closed tree. */
  async getWorld(roundId: string, workspaceRoot?: string): Promise<ReplayWorld> {
    const ws = this.workspaceFor(workspaceRoot)
    return this.worldFor(ws, roundId)
  }

  private async worldFor(ws: WorkspaceState, roundId: string): Promise<ReplayWorld> {
    const cached = ws.worlds.get(roundId)
    if (cached) return cached
    const round = await ws.store.getRound(roundId)
    if (!round) throw new EngineError(`unknown round ${roundId}`)
    const nodes = await ws.store.getNodes(roundId)
    const world = buildWorld(roundId, nodes)
    ws.worlds.set(roundId, world)
    return world
  }
}

/** Abridged node projection for history views (spec §7.4). */
function summarizeNode(node: NodeRecord): HistoryNodeSummary {
  return {
    id: node.id,
    parentId: node.parentId,
    depth: node.state.depth,
    branchId: node.state.branchId,
    actionSummary: node.action.summary,
    mechanism: node.action.mechanism,
    tags: [...node.action.tags],
    score: node.outcome.score,
    failClass: node.outcome.failClass,
    deltaVsParent: node.outcome.deltaVsParent,
    estimated: node.lineage.policyVersion === 'replay-estimate',
  }
}

/** Re-export for tool-layer error handling. */
export { StoreError }
