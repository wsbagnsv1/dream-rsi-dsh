/**
 * Shared fixtures and factories for the Dream-RSI test suite.
 *
 * Everything here is deterministic: fixed clock, fixed ids, hand-built trees.
 * Filesystem helpers create fresh temp dirs per test and clean them up in
 * `afterEach` (via {@link cleanupTempRoots}) even on failure.
 *
 * @module
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import type {
  FailClass,
  NodeRecord,
  PluginConfig,
  PolicyDsl,
} from '../src/types.ts'
import { DEFAULT_CONFIG } from '../src/types.ts'
import { defaultPolicyDsl } from '../src/dreaming.ts'
import type { AppendDecision } from '../src/store.ts'

// ---------------------------------------------------------------------------
// Config / clock / temp dirs
// ---------------------------------------------------------------------------

/** Full plugin config with spec defaults, overridden per test. */
export function makeConfig(overrides: Partial<PluginConfig> = {}): PluginConfig {
  return { ...DEFAULT_CONFIG, ...overrides }
}

/** Monotonic deterministic clock: 2026-01-01T00:00:00Z + 1 s per call. */
export function makeClock(): () => Date {
  let tick = 0
  return () => new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + tick++ * 1000)
}

const tempRoots: string[] = []

/** Fresh temp dir for a store (removed by {@link cleanupTempRoots}). */
export async function makeTempRoot(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'dreamrsi-test-'))
  tempRoots.push(dir)
  return dir
}

/** Remove every temp root created since the last cleanup (call in afterEach). */
export async function cleanupTempRoots(): Promise<void> {
  const roots = tempRoots.splice(0)
  // Retry briefly: fire-and-forget async writes (e.g. plugin bootstrap) can
  // still be settling when cleanup runs, and Windows rmdir races ENOTEMPTY.
  for (const root of roots) {
    for (let attempt = 0; ; attempt++) {
      try {
        await rm(root, { recursive: true, force: true })
        break
      } catch (error) {
        if (attempt >= 20) throw error
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
    }
  }
}

// ---------------------------------------------------------------------------
// NodeRecord factories (replay fixtures are built directly, store-free)
// ---------------------------------------------------------------------------

const EPOCH = '2026-01-01T00:00:00.000Z'

export interface AttemptOptions {
  id: string
  roundId: string
  parentId: string
  /** Global creation sequence within the round. */
  seq: number
  depth: number
  branchId: number
  seqInBranch: number
  score?: number
  evaluated?: boolean
  valid?: boolean
  failClass?: FailClass
  error?: string | null
  summary?: string
  mechanism?: string
  tags?: string[]
  notes?: string
}

/** One `kind: 'attempt'` node with sensible defaults (evaluated success). */
export function attemptNode(options: AttemptOptions): NodeRecord {
  const createdAt = new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + options.seq * 1000).toISOString()
  return {
    id: options.id,
    roundId: options.roundId,
    parentId: options.parentId,
    kind: 'attempt',
    state: {
      depth: options.depth,
      branchId: options.branchId,
      seqInBranch: options.seqInBranch,
      workspaceSummary: 'parent workspace',
      inheritedContextNote: '',
      siblingCountAtDecision: 2,
    },
    action: {
      summary: options.summary ?? 'attempt summary',
      mechanism: options.mechanism ?? 'mech',
      tags: options.tags ?? ['tag'],
      artifactPaths: [],
    },
    outcome: {
      score: options.score ?? 0.5,
      evaluated: options.evaluated ?? true,
      valid: options.valid ?? true,
      failClass: options.failClass ?? 'ok',
      error: options.error ?? null,
      deltaVsBaseline: null,
      deltaVsParent: null,
    },
    metrics: { agentCalls: 1, wallMs: 100 },
    notes: options.notes ?? '',
    lineage: { createdAt, evaluatedAt: createdAt, policyVersion: 'v0001', seq: options.seq },
  }
}

/** The root node of a round, as the store creates it. */
export function rootNode(roundId: string): NodeRecord {
  return {
    id: `${roundId}-n000`,
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
    lineage: { createdAt: EPOCH, evaluatedAt: null, policyVersion: 'v0001', seq: 0 },
  }
}

// ---------------------------------------------------------------------------
// World fixtures (hand-built trees)
// ---------------------------------------------------------------------------

/**
 * Two-branch world `r0001`:
 * - branch 0: n001 (anneal, score 0.4, ok) → n002 (anneal-refine, score 0.9, ok)
 * - branch 1: n003 (gpu-kernel, score 0.8, ok)
 *
 * Root children in creation (seq) order: n001 (seq 1), n003 (seq 3) — the
 * nodes are handed to `buildWorld` deliberately out of order to verify the
 * seq sort.
 */
export function fixtureNodesTwoBranches(roundId = 'r0001'): NodeRecord[] {
  return [
    rootNode(roundId),
    attemptNode({
      id: `${roundId}-n001`, roundId, parentId: `${roundId}-n000`,
      seq: 1, depth: 1, branchId: 0, seqInBranch: 0,
      score: 0.4, summary: 'anneal the schedule', mechanism: 'anneal', tags: ['anneal'],
    }),
    attemptNode({
      id: `${roundId}-n002`, roundId, parentId: `${roundId}-n001`,
      seq: 2, depth: 2, branchId: 0, seqInBranch: 1,
      score: 0.9, summary: 'anneal with better cooling', mechanism: 'anneal', tags: ['anneal'],
    }),
    attemptNode({
      id: `${roundId}-n003`, roundId, parentId: `${roundId}-n000`,
      seq: 3, depth: 1, branchId: 1, seqInBranch: 0,
      score: 0.8, summary: 'tune gpu kernel blocks', mechanism: 'gpu-kernel', tags: ['cuda'],
    }),
  ]
}

/** Single-chain world `r0002`: root → n001 (0.6, ok) → n002 (1.0, ok). */
export function fixtureNodesSingleChain(roundId = 'r0002'): NodeRecord[] {
  return [
    rootNode(roundId),
    attemptNode({
      id: `${roundId}-n001`, roundId, parentId: `${roundId}-n000`,
      seq: 1, depth: 1, branchId: 0, seqInBranch: 0,
      score: 0.6, summary: 'gradient descent baseline', mechanism: 'gradient', tags: ['gd'],
    }),
    attemptNode({
      id: `${roundId}-n002`, roundId, parentId: `${roundId}-n001`,
      seq: 2, depth: 2, branchId: 0, seqInBranch: 1,
      score: 1.0, summary: 'gradient with momentum', mechanism: 'gradient', tags: ['gd'],
    }),
  ]
}

/**
 * The live-campaign r0009 shape (V2-5 regression fixture): a single root with
 * TWO unary chains — both best scores at DEPTH 1 (the branch starts) — plus a
 * weaker depth-2 continuation on one chain. In campaign 2 this exact shape
 * made the old single-plan interpreter compose [root, best-depth-1-leaf] — a
 * parent+child pair → illegal → every candidate floored at −1e12.
 */
export function fixtureNodesDepth1BestBranch(roundId = 'r0009'): NodeRecord[] {
  return [
    rootNode(roundId),
    // Branch 0 (weak branch start, depth 1): score 0.3.
    attemptNode({
      id: `${roundId}-n001`, roundId, parentId: `${roundId}-n000`,
      seq: 1, depth: 1, branchId: 0, seqInBranch: 0,
      score: 0.3, summary: 'random restart sampler', mechanism: 'random-restart', tags: ['sampler'],
    }),
    // Branch 1 (THE BEST branch, also depth 1): score 0.95 — the live
    // finding's "best branch at depth 1". No continuation beyond it.
    attemptNode({
      id: `${roundId}-n003`, roundId, parentId: `${roundId}-n000`,
      seq: 3, depth: 1, branchId: 1, seqInBranch: 0,
      score: 0.95, summary: 'circle packing iteration 1', mechanism: 'circle-packing', tags: ['geometry'],
    }),
    // Branch 0's depth-2 continuation (weaker than its parent): score 0.45.
    attemptNode({
      id: `${roundId}-n002`, roundId, parentId: `${roundId}-n001`,
      seq: 2, depth: 2, branchId: 0, seqInBranch: 1,
      score: 0.45, summary: 'random restart with local refine', mechanism: 'random-restart', tags: ['sampler'],
    }),
  ]
}

// ---------------------------------------------------------------------------
// AppendDecision / PolicyDsl factories (store + dreaming tests)
// ---------------------------------------------------------------------------

/** One decision for `DreamStore.appendNodes` with sensible defaults. */
export function makeDecision(overrides: Partial<AppendDecision> & { parentId: string | null }): AppendDecision {
  return {
    action: { summary: 'attempt summary', mechanism: 'mech', tags: ['tag'], artifactPaths: [] },
    score: 0.5,
    evaluated: true,
    valid: true,
    failClass: 'ok',
    error: null,
    deltaVsBaseline: null,
    deltaVsParent: null,
    agentCalls: 1,
    wallMs: null,
    notes: '',
    ...overrides,
  }
}

/** A valid PolicyDsl: the bootstrap default with shallow overrides. */
export function makeDsl(overrides: Partial<PolicyDsl> = {}): PolicyDsl {
  return { ...defaultPolicyDsl(makeConfig()), ...overrides }
}

// ---------------------------------------------------------------------------
// Assertions helpers
// ---------------------------------------------------------------------------

/** Unwrap an optional value or fail the test. */
export function must<T>(value: T | null | undefined, message = 'expected a value'): T {
  if (value === null || value === undefined) throw new Error(message)
  return value
}
