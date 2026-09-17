/**
 * Dream-RSI discovery-tree store: durable persistence under a configurable
 * data directory (spec §2) with append-only history, strict structural
 * invariants, read-only queries, and the policy-registry file layout.
 *
 * Layout (spec §2):
 * ```
 * <dataDir>/
 *   config.json                 resolved plugin config snapshot (write-once)
 *   trees/<roundId>/nodes.jsonl one JSON object per node (append-only)
 *   trees/<roundId>/round.json  round record (status, policy version, stats)
 *   policies/policy-index.json  version list + active pointer
 *   policies/v00NN.json         immutable policy payloads (PolicyRecord)
 *   dreams/d00NN.json           one dreaming report per run
 *   events.jsonl                global append-only audit log
 * ```
 *
 * Determinism: all timestamps come from an injectable `clock` (default real
 * time). History nodes are immutable once written; corrections append new
 * records, never edit existing ones — the recorded trees ARE the replay
 * simulator and mutating them would corrupt replay (spec §2.1 invariant 4).
 *
 * @module
 */

import { appendFile, mkdir, readFile, rename, readdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import * as path from 'node:path'
import type {
  NodeRecord,
  PolicyEvaluation,
  PolicyIndex,
  PolicyIndexEntry,
  PolicyRecord,
  PluginConfig,
  RoundRecord,
  RoundStats,
} from './types.ts'

/** Options for constructing a {@link DreamStore}. */
export interface DreamStoreOptions {
  /** Resolved plugin config (defaults already applied). */
  config: PluginConfig
  /** Directory a relative `config.dataDir` resolves against. */
  workspaceRoot: string
  /** Injectable clock (determinism in tests). Defaults to wall time. */
  clock?: () => Date
}

/** Error thrown for store invariant violations and missing records. */
export class StoreError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StoreError'
  }
}

/** Audit-log entry (spec §8.5). */
export interface StoreEvent {
  ts: string
  call: string
  /** Compact JSON of the call arguments (reproducibility digest). */
  argsDigest: string
  /** Compact JSON of the outcome digest. */
  resultDigest: string
  policyVersion: string
}

/** A decision shape accepted by {@link DreamStore.appendNodes}. */
export interface AppendDecision {
  /** `null` ⇒ child of the root: open a new branch (spec §7.2). */
  parentId: string | null
  action: NodeRecord['action']
  score: number
  evaluated: boolean
  valid: boolean
  failClass: NodeRecord['outcome']['failClass']
  error: string | null
  deltaVsBaseline: number | null
  /** Caller-provided refinement delta; `null` ⇒ derived from the parent's score. */
  deltaVsParent: number | null
  agentCalls: number
  wallMs: number | null
  notes: string
}

/** Result of {@link DreamStore.appendNodes}. */
export interface AppendOutcome {
  accepted: NodeRecord[]
  warnings: string[]
}

/**
 * Durable Dream-RSI store. All mutating methods validate the spec §2.1
 * invariants and append an audit event. Nodes and rounds are cached in memory
 * after first read (nodes are append-only, so caches stay coherent through
 * the store's own writes).
 */
export class DreamStore {
  /** Absolute store root directory. */
  readonly root: string
  private readonly clock: () => Date
  private readonly config: PluginConfig
  private readonly roundCache = new Map<string, RoundRecord>()
  private readonly nodesCache = new Map<string, NodeRecord[]>()
  private policyIndex: PolicyIndex | null = null
  private initialized = false

  constructor(options: DreamStoreOptions) {
    this.config = options.config
    this.root = path.isAbsolute(options.config.dataDir)
      ? options.config.dataDir
      : path.join(options.workspaceRoot, options.config.dataDir)
    this.clock = options.clock ?? (() => new Date())
  }

  // ------------------------------------------------------------------ setup

  /** Create the directory layout and write-once config snapshot. Idempotent. */
  async init(): Promise<void> {
    if (this.initialized) return
    await mkdir(path.join(this.root, 'trees'), { recursive: true })
    await mkdir(path.join(this.root, 'policies'), { recursive: true })
    await mkdir(path.join(this.root, 'dreams'), { recursive: true })
    const configPath = path.join(this.root, 'config.json')
    if (!existsSync(configPath)) {
      await writeJsonAtomic(configPath, {
        writtenAt: this.now(),
        config: {
          dataDir: this.root,
          candidateCount: this.config.candidateCount,
          maxOnlineRounds: this.config.maxOnlineRounds,
          maxReplayRounds: this.config.maxReplayRounds,
          beta1: this.config.beta1,
          beta2: this.config.beta2,
          normalizeScores: this.config.normalizeScores,
        },
      })
    }
    this.initialized = true
  }

  /** Current UTC timestamp from the injectable clock. */
  now(): string {
    return this.clock().toISOString()
  }

  // ------------------------------------------------------------------ events

  /** Append one audit event to `events.jsonl` (spec §8.5). */
  async logEvent(call: string, args: unknown, result: unknown, policyVersion: string): Promise<void> {
    const event: StoreEvent = {
      ts: this.now(),
      call,
      argsDigest: compactJson(args),
      resultDigest: compactJson(result),
      policyVersion,
    }
    await appendFile(path.join(this.root, 'events.jsonl'), `${JSON.stringify(event)}\n`, 'utf8')
  }

  /** Read the whole audit log (oldest first). */
  async readEvents(): Promise<StoreEvent[]> {
    const file = path.join(this.root, 'events.jsonl')
    if (!existsSync(file)) return []
    const text = await readFile(file, 'utf8')
    return text.split('\n').filter((line) => line.trim().length > 0).map((line) => JSON.parse(line) as StoreEvent)
  }

  // ------------------------------------------------------------------ rounds

  /** List existing round ids by scanning `trees/` (sorted ascending). */
  async listRoundIds(): Promise<string[]> {
    const dir = path.join(this.root, 'trees')
    if (!existsSync(dir)) return []
    const entries = await readdir(dir)
    return entries.sort()
  }

  /** Allocate the next round id (`r0001`, `r0002`, ...). */
  async nextRoundId(): Promise<string> {
    const existing = await this.listRoundIds()
    return `r${String(existing.length + 1).padStart(4, '0')}`
  }

  /**
   * Create a new open round with its root node. The root is created here so
   * the tree always has exactly one root (spec §2.1 invariant 1) and replay
   * can start from the observed subtree `𝒪 = {root}`.
   */
  async createRound(policyVersion: string, limits: { maxRounds: number; maxParallelism: number }): Promise<RoundRecord> {
    await this.init()
    const roundId = await this.nextRoundId()
    const dir = this.roundDir(roundId)
    await mkdir(dir, { recursive: true })
    const startedAt = this.now()
    const round: RoundRecord = {
      roundId,
      status: 'open',
      policyVersion,
      startedAt,
      endedAt: null,
      limits: { ...limits },
      stats: emptyStats(),
    }
    const root: NodeRecord = {
      id: rootIdOf(roundId),
      roundId,
      parentId: null,
      kind: 'root',
      state: {
        depth: 0,
        branchId: -1,
        seqInBranch: 0,
        workspaceSummary: '',
        inheritedContextNote: '',
        siblingCountAtDecision: 1,
      },
      action: { summary: 'initial workspace', mechanism: 'root', tags: [], artifactPaths: [] },
      outcome: {
        score: 0,
        evaluated: false,
        valid: false,
        failClass: 'ok',
        error: null,
        deltaVsBaseline: null,
        deltaVsParent: null,
      },
      metrics: { agentCalls: 0, wallMs: null },
      notes: 'root created by dreamrsi_begin_round',
      lineage: { createdAt: startedAt, evaluatedAt: null, policyVersion, seq: 0 },
    }
    await this.appendNodeLines(roundId, [root])
    await writeJsonAtomic(path.join(dir, 'round.json'), round)
    this.roundCache.set(roundId, round)
    this.nodesCache.set(roundId, [root])
    return round
  }

  /** Get one round record, or null when absent. */
  async getRound(roundId: string): Promise<RoundRecord | null> {
    const cached = this.roundCache.get(roundId)
    if (cached) return cached
    const file = path.join(this.roundDir(roundId), 'round.json')
    if (!existsSync(file)) return null
    const round = JSON.parse(await readFile(file, 'utf8')) as RoundRecord
    this.roundCache.set(roundId, round)
    return round
  }

  /** The currently open round, or null. At most one round is open at a time. */
  async getOpenRound(): Promise<RoundRecord | null> {
    for (const roundId of await this.listRoundIds()) {
      const round = await this.getRound(roundId)
      if (round?.status === 'open') return round
    }
    return null
  }

  /** All round records (any status), oldest first. */
  async listRounds(): Promise<RoundRecord[]> {
    const rounds: RoundRecord[] = []
    for (const roundId of await this.listRoundIds()) {
      const round = await this.getRound(roundId)
      if (round) rounds.push(round)
    }
    return rounds
  }

  /**
   * Append decision nodes to an open round (spec §7.2 semantics):
   *
   * - every batch parent must be a PRE-EXISTING selectable node; a parent
   *   reference that does not resolve (including a node created earlier in
   *   the same batch — a parent+child pair, which parallel batches cannot
   *   contain) rejects that individual decision with a warning;
   * - a second child for a non-root parent violates the chain invariant and
   *   throws (spec §2.1 invariant 3 — history would become unreplayable);
   * - a batch exceeding the round's parallelism W produces a warning;
   * - accepted nodes are immutable and appended in `seq` order.
   */
  async appendNodes(roundId: string, decisions: readonly AppendDecision[]): Promise<AppendOutcome> {
    const round = await this.getRound(roundId)
    if (!round) throw new StoreError(`unknown round ${roundId}`)
    if (round.status !== 'open') throw new StoreError(`round ${roundId} is closed; nodes are immutable`)
    const nodes = await this.getNodes(roundId)
    const byId = new Map(nodes.map((node) => [node.id, node]))
    const rootNode = nodes.find((node) => node.kind === 'root')
    if (!rootNode) throw new StoreError(`round ${roundId} has no root node`)
    const childCount = new Map<string, number>()
    for (const node of nodes) {
      if (node.parentId !== null) childCount.set(node.parentId, (childCount.get(node.parentId) ?? 0) + 1)
    }
    const recordedRootChildren = nodes.filter((node) => node.parentId === rootNode.id).length
    const selectableBefore = 1 + countLeaves(nodes)

    const accepted: NodeRecord[] = []
    const warnings: string[] = []
    let seq = nodes.length > 0 ? Math.max(...nodes.map((node) => node.lineage.seq)) : 0

    if (decisions.length > round.limits.maxParallelism) {
      warnings.push(`batch size ${decisions.length} exceeds round parallelism W=${round.limits.maxParallelism}`)
    }

    for (const decision of decisions) {
      const parent: NodeRecord | null = decision.parentId === null ? rootNode : byId.get(decision.parentId) ?? null
      if (decision.parentId !== null && parent === null) {
        warnings.push(`rejected decision: unknown parentId ${decision.parentId}`)
        continue
      }
      if (parent && parent.kind !== 'root' && (childCount.get(parent.id) ?? 0) > 0) {
        throw new StoreError(
          `chain invariant violated: node ${parent.id} already has a child; non-root nodes have at most one child`,
        )
      }

      seq += 1
      const score = decision.score
      const deltaVsParent = decision.deltaVsParent
        ?? (parent && parent.outcome.evaluated ? score - parent.outcome.score : null)
      const now = this.now()
      const record: NodeRecord = {
        id: nodeIdOf(roundId, seq),
        roundId,
        parentId: parent ? parent.id : null,
        kind: 'attempt',
        state: {
          depth: parent ? parent.state.depth + 1 : 0,
          branchId: parent && parent.kind !== 'root'
            ? parent.state.branchId
            : recordedRootChildren + accepted.filter((node) => node.parentId === rootNode.id).length,
          seqInBranch: parent && parent.kind !== 'root' ? parent.state.seqInBranch + 1 : 0,
          workspaceSummary: parent ? parent.action.summary : '',
          inheritedContextNote: '',
          siblingCountAtDecision: selectableBefore,
        },
        action: decision.action,
        outcome: {
          score,
          evaluated: decision.evaluated,
          valid: decision.valid,
          failClass: decision.failClass,
          error: decision.error,
          deltaVsBaseline: decision.deltaVsBaseline,
          deltaVsParent,
        },
        metrics: { agentCalls: decision.agentCalls, wallMs: decision.wallMs },
        notes: decision.notes,
        lineage: { createdAt: now, evaluatedAt: decision.evaluated ? now : null, policyVersion: round.policyVersion, seq },
      }
      accepted.push(record)
      if (parent) childCount.set(parent.id, (childCount.get(parent.id) ?? 0) + 1)
    }

    if (accepted.length > 0) {
      await this.appendNodeLines(roundId, accepted)
      nodes.push(...accepted)
      await this.recomputeRoundStats(roundId)
    }
    return { accepted, warnings }
  }

  /** All nodes of a round (including the root), in creation order. */
  async getNodes(roundId: string): Promise<NodeRecord[]> {
    const cached = this.nodesCache.get(roundId)
    if (cached) return cached
    const file = path.join(this.roundDir(roundId), 'nodes.jsonl')
    if (!existsSync(file)) return []
    const text = await readFile(file, 'utf8')
    const nodes = text
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as NodeRecord)
    this.nodesCache.set(roundId, nodes)
    return nodes
  }

  /** One node by id (round id is derived from the node id when possible). */
  async getNode(nodeId: string): Promise<NodeRecord | null> {
    const roundId = nodeId.split('-n')[0]
    if (roundId) {
      const nodes = await this.getNodes(roundId)
      const found = nodes.find((node) => node.id === nodeId)
      if (found) return found
    }
    for (const rid of await this.listRoundIds()) {
      const nodes = await this.getNodes(rid)
      const found = nodes.find((node) => node.id === nodeId)
      if (found) return found
    }
    return null
  }

  /** Subtree of `nodeId` within its round: the node plus all descendants. */
  async getSubtree(roundId: string, nodeId: string): Promise<NodeRecord[]> {
    const nodes = await this.getNodes(roundId)
    const byId = new Map(nodes.map((node) => [node.id, node]))
    const byParent = new Map<string, NodeRecord[]>()
    for (const node of nodes) {
      if (node.parentId === null) continue
      const list = byParent.get(node.parentId) ?? []
      list.push(node)
      byParent.set(node.parentId, list)
    }
    const out: NodeRecord[] = []
    const walk = (id: string): void => {
      const node = byId.get(id)
      if (!node) return
      out.push(node)
      for (const child of byParent.get(id) ?? []) walk(child.id)
    }
    walk(nodeId)
    return out
  }

  /**
   * Record one completed decision round (batch) on the round. `batchSeq`
   * groups incremental log calls (spec §7.2): the first call with a new seq
   * opens a new batchSizes entry; later calls with the same seq grow it.
   * Stats are recomputed afterwards so `avgBatchSize` stays fresh.
   */
  async recordBatch(roundId: string, batchSeq: number, batchSize: number): Promise<void> {
    const round = await this.getRound(roundId)
    if (!round) throw new StoreError(`unknown round ${roundId}`)
    const withLog = round as RoundRecord & { batchSeqIndex?: Record<string, number> }
    const batchSeqIndex = { ...(withLog.batchSeqIndex ?? {}) }
    const key = String(batchSeq)
    const existingIndex = batchSeqIndex[key]
    const batchSizes = [...round.stats.batchSizes]
    let decisionRounds = round.stats.decisionRounds
    if (existingIndex === undefined) {
      batchSeqIndex[key] = batchSizes.length
      batchSizes.push(batchSize)
      decisionRounds += 1
    } else {
      const idx = batchSizes[existingIndex]
      batchSizes[existingIndex] = (idx ?? 0) + batchSize
    }
    this.roundCache.set(roundId, {
      ...round,
      batchSeqIndex,
      stats: { ...round.stats, decisionRounds, batchSizes },
    })
    await this.recomputeRoundStats(roundId)
  }

  /**
   * Close a round: freeze stats, mark it `closed`. Closing builds the replay
   * world on the engine side (spec §7.3); the store only persists state.
   */
  async closeRound(roundId: string, summary?: string): Promise<RoundRecord> {
    const round = await this.getRound(roundId)
    if (!round) throw new StoreError(`unknown round ${roundId}`)
    if (round.status === 'closed') throw new StoreError(`round ${roundId} is already closed`)
    await this.recomputeRoundStats(roundId)
    const fresh = await this.getRound(roundId)
    if (!fresh) throw new StoreError(`round ${roundId} disappeared`)
    const closed: RoundRecord = {
      ...fresh,
      status: 'closed',
      endedAt: this.now(),
      ...(summary !== undefined && summary !== '' ? { summary } : {}),
    }
    await writeJsonAtomic(path.join(this.roundDir(roundId), 'round.json'), closed)
    this.roundCache.set(roundId, closed)
    return closed
  }

  /** Persist an updated round record (stats bookkeeping; status fields aside). */
  async patchRound(roundId: string, record: RoundRecord): Promise<void> {
    await writeJsonAtomic(path.join(this.roundDir(roundId), 'round.json'), record)
    this.roundCache.set(roundId, record)
  }

  /** Recompute and persist round stats (spec §8.2). */
  private async recomputeRoundStats(roundId: string): Promise<void> {
    const round = await this.getRound(roundId)
    if (!round) throw new StoreError(`unknown round ${roundId}`)
    const nodes = await this.getNodes(roundId)
    const attempts = nodes.filter((node) => node.kind === 'attempt')
    const evaluated = attempts.filter((node) => node.outcome.evaluated)
    const stats: RoundStats = {
      nodes: nodes.length,
      attempts: attempts.length,
      bestScore: evaluated.length > 0 ? Math.max(...evaluated.map((node) => node.outcome.score)) : null,
      decisionRounds: round.stats.decisionRounds,
      batchSizes: [...round.stats.batchSizes],
      composition: deriveComposition(nodes),
      avgBatchSize: round.stats.decisionRounds > 0
        ? attempts.length / Math.max(1, round.stats.decisionRounds)
        : 0,
    }
    const updated: RoundRecord = { ...round, stats }
    await writeJsonAtomic(path.join(this.roundDir(roundId), 'round.json'), updated)
    this.roundCache.set(roundId, updated)
  }

  // ---------------------------------------------------------------- policies

  private policyIndexPath(): string {
    return path.join(this.root, 'policies', 'policy-index.json')
  }

  /** Load (and cache) the policy index; empty when absent. */
  async getPolicyIndex(): Promise<PolicyIndex> {
    if (this.policyIndex) return this.policyIndex
    const file = this.policyIndexPath()
    if (!existsSync(file)) {
      this.policyIndex = { activeVersion: null, versions: [] }
      return this.policyIndex
    }
    this.policyIndex = JSON.parse(await readFile(file, 'utf8')) as PolicyIndex
    return this.policyIndex
  }

  private async savePolicyIndex(index: PolicyIndex): Promise<void> {
    this.policyIndex = index
    await writeJsonAtomic(this.policyIndexPath(), index)
  }

  /** Allocate the next policy version id (`v0001`, `v0002`, ...). */
  async nextPolicyVersion(): Promise<string> {
    const index = await this.getPolicyIndex()
    return `v${String(index.versions.length + 1).padStart(4, '0')}`
  }

  /**
   * Register a NEW immutable policy version. `params` payloads are never
   * modified in place afterwards; only `status` transitions and the
   * `evaluation` bookkeeping block ever change on an existing record.
   */
  async registerPolicy(
    params: PolicyRecord['params'],
    notes: string,
    parentId: string | null,
    status: PolicyRecord['status'] = 'candidate',
  ): Promise<PolicyRecord> {
    await this.init()
    const version = await this.nextPolicyVersion()
    const record: PolicyRecord = {
      version,
      createdAt: this.now(),
      status,
      parentId,
      params,
      notes,
      evaluation: { meanReplayScore: null, perWorldScores: null, betaSweep: null },
    }
    await writeJsonAtomic(path.join(this.root, 'policies', `${version}.json`), record)
    const index = await this.getPolicyIndex()
    const entry: PolicyIndexEntry = {
      version,
      status,
      createdAt: record.createdAt,
      parentId,
      name: params.name,
    }
    await this.savePolicyIndex({ ...index, versions: [...index.versions, entry] })
    await this.logEvent('policy.register', { version, parentId, name: params.name }, { version }, version)
    return record
  }

  /** Read one full policy payload, or null when absent. */
  async getPolicy(version: string): Promise<PolicyRecord | null> {
    const file = path.join(this.root, 'policies', `${version}.json`)
    if (!existsSync(file)) return null
    return JSON.parse(await readFile(file, 'utf8')) as PolicyRecord
  }

  /** The active policy version id, or null when none. */
  async getActivePolicyVersion(): Promise<string | null> {
    const index = await this.getPolicyIndex()
    return index.activeVersion
  }

  /** The active policy payload, or null when none. */
  async getActivePolicy(): Promise<PolicyRecord | null> {
    const active = await this.getActivePolicyVersion()
    return active ? this.getPolicy(active) : null
  }

  /** Light version list for `dreamrsi_policy_get` history. */
  async listPolicyEntries(): Promise<PolicyIndexEntry[]> {
    const index = await this.getPolicyIndex()
    return [...index.versions]
  }

  /**
   * Flip the active-policy pointer with the no-regression guard (spec §7.7):
   * when both the target and the incumbent carry replay evaluations and the
   * target scores strictly worse, activation is rejected unless `force`.
   * Returns the guard report either way; callers surface rejections.
   */
  async setActivePolicy(version: string, force: boolean): Promise<{
    accepted: boolean
    previous: string | null
    guard: { meanReplayScore: number | null; incumbentScore: number | null; noRegression: boolean; forced: boolean }
  }> {
    const index = await this.getPolicyIndex()
    const target = await this.getPolicy(version)
    if (!target) throw new StoreError(`unknown policy version ${version}`)
    const previous = index.activeVersion
    const incumbent = previous ? await this.getPolicy(previous) : null
    const meanReplayScore = target.evaluation.meanReplayScore
    const incumbentScore = incumbent?.evaluation.meanReplayScore ?? null
    let noRegression = true
    if (meanReplayScore !== null && incumbentScore !== null && meanReplayScore < incumbentScore) {
      noRegression = false
      if (!force) {
        return { accepted: false, previous, guard: { meanReplayScore, incumbentScore, noRegression, forced: false } }
      }
    }
    const versions = index.versions.map((entry) => {
      if (entry.version === version) return { ...entry, status: 'active' as const }
      if (entry.version === previous && entry.status === 'active') return { ...entry, status: 'retired' as const }
      return entry
    })
    await this.savePolicyIndex({ activeVersion: version, versions })
    await writeJsonAtomic(path.join(this.root, 'policies', `${version}.json`), { ...target, status: 'active' as const })
    await this.logEvent('policy.set', { version, force }, { activeVersion: version }, version)
    return { accepted: true, previous, guard: { meanReplayScore, incumbentScore, noRegression, forced: force } }
  }

  /** Transition a version's status (e.g. `rejected` after guard failure). */
  async markPolicyStatus(version: string, status: PolicyRecord['status']): Promise<void> {
    const index = await this.getPolicyIndex()
    const versions = index.versions.map((entry) => (entry.version === version ? { ...entry, status } : entry))
    await this.savePolicyIndex({ ...index, versions })
    const record = await this.getPolicy(version)
    if (record) {
      await writeJsonAtomic(path.join(this.root, 'policies', `${version}.json`), { ...record, status })
    }
  }

  /** Attach dream-evaluation bookkeeping to a version (params stay immutable). */
  async attachEvaluation(version: string, evaluation: PolicyEvaluation): Promise<void> {
    const record = await this.getPolicy(version)
    if (!record) throw new StoreError(`unknown policy version ${version}`)
    await writeJsonAtomic(path.join(this.root, 'policies', `${version}.json`), { ...record, evaluation })
  }

  // ------------------------------------------------------------------ dreams

  /** Allocate the next dream run id (`d0001`, ...). */
  async nextDreamRunId(): Promise<string> {
    await this.init()
    const dir = path.join(this.root, 'dreams')
    const entries = existsSync(dir) ? await readdir(dir) : []
    return `d${String(entries.length + 1).padStart(4, '0')}`
  }

  /** Persist one dreaming report to `dreams/<runId>.json`. */
  async saveDreamReport(report: DreamStoreReport): Promise<void> {
    await this.init()
    await writeJsonAtomic(path.join(this.root, 'dreams', `${report.runId}.json`), report)
  }

  /** Read one dreaming report, or null. */
  async getDreamReport(runId: string): Promise<DreamStoreReport | null> {
    const file = path.join(this.root, 'dreams', `${runId}.json`)
    if (!existsSync(file)) return null
    return JSON.parse(await readFile(file, 'utf8')) as DreamStoreReport
  }

  // ------------------------------------------------------------------ helpers

  private roundDir(roundId: string): string {
    return path.join(this.root, 'trees', roundId)
  }

  private async appendNodeLines(roundId: string, records: readonly NodeRecord[]): Promise<void> {
    const dir = this.roundDir(roundId)
    await mkdir(dir, { recursive: true })
    const lines = records.map((record) => JSON.stringify(record)).join('\n')
    await appendFile(path.join(dir, 'nodes.jsonl'), `${lines}\n`, 'utf8')
  }
}

/** A persisted dreaming report: the DreamReport shape plus its run id. */
export type DreamStoreReport = { runId: string } & Record<string, unknown>

// -------------------------------------------------------------------- helpers

/** Root node id of a round (`r0001-n000`). */
export function rootIdOf(roundId: string): string {
  return `${roundId}-n000`
}

/** Node id for a per-round creation sequence (`r0001-n003`). */
export function nodeIdOf(roundId: string, seq: number): string {
  return `${roundId}-n${String(seq).padStart(3, '0')}`
}

/** Write JSON atomically: temp file + rename, so readers never see a torn file. */
async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const tmp = `${file}.tmp-${process.pid}-${Math.floor(Math.random() * 1e9)}`
  await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8')
  await rename(tmp, file)
}

/** Compact single-line JSON for digests. */
function compactJson(value: unknown): string {
  return JSON.stringify(value) ?? 'null'
}

function emptyStats(): RoundStats {
  return {
    nodes: 1,
    attempts: 0,
    bestScore: null,
    decisionRounds: 0,
    batchSizes: [],
    composition: { exploitation: 0, exploration: 0, recovery: 0 },
    avgBatchSize: 0,
  }
}

/** Count nodes that currently have no child (the selectable leaves). */
function countLeaves(nodes: readonly NodeRecord[]): number {
  const parents = new Set(nodes.filter((node) => node.parentId !== null).map((node) => node.parentId as string))
  return nodes.filter((node) => node.kind === 'attempt' && !parents.has(node.id)).length
}

/**
 * Derive batch-composition counters from the recorded tree (deterministic):
 * a child of the root opened exploration; an attempt whose parent's outcome
 * was a failure (failClass ≠ ok) counts as recovery; everything else is
 * exploitation.
 */
function deriveComposition(nodes: readonly NodeRecord[]): RoundStats['composition'] {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const root = nodes.find((node) => node.kind === 'root')
  const composition = { exploitation: 0, exploration: 0, recovery: 0 }
  for (const node of nodes) {
    if (node.kind !== 'attempt') continue
    if (root !== undefined && node.parentId === root.id) {
      composition.exploration += 1
      continue
    }
    const parent = node.parentId !== null ? byId.get(node.parentId) : undefined
    if (parent && parent.outcome.failClass !== 'ok') composition.recovery += 1
    else composition.exploitation += 1
  }
  return composition
}
