/**
 * Per-workspace dataDir tests: a relative `dataDir` resolves
 * PER TOOL CALL against the calling agent's session workspace
 * (`exec.agent.session.header.cwd`), each workspace gets its own store, the
 * same root reuses one memoized store, the `process.cwd()` fallback for
 * non-agent calls is disclosed in results/warnings, and an absolute `dataDir`
 still pins one shared store.
 *
 * @module
 */

import { existsSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ToolExecuteContext } from '@deepseek-ai/dsh-tools'
import { DreamEngine } from '../src/engine.ts'
import { buildToolDefinitions } from '../src/tools.ts'
import type { DecisionInput, PluginConfig } from '../src/types.ts'
import { cleanupTempRoots, makeClock, makeConfig, makeTempRoot, must } from './fixtures.ts'

// tools.ts imports the bare DSH tool DSL (types-only in this standalone
// package); alias it to the identity, exactly as in tools.spec.ts.
vi.mock('@deepseek-ai/dsh-tools', () => ({
  defineTool: (definition: unknown) => definition,
}))

afterEach(async () => {
  await cleanupTempRoots()
})

const RELATIVE_DATA_DIR = '.dreamrsi'
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Engine with a RELATIVE dataDir (the default wiring shape). */
function makeEngine(workspaceRoot: string, overrides: Partial<PluginConfig> = {}): DreamEngine {
  return new DreamEngine({
    config: makeConfig({ dataDir: RELATIVE_DATA_DIR, ...overrides }),
    workspaceRoot,
    clock: makeClock(),
  })
}

/** One engine-level decision input (the `dreamrsi_log_decision` shape). */
function decisionInput(overrides: Partial<DecisionInput> = {}): DecisionInput {
  return {
    parentId: null,
    action: { summary: 'anneal the schedule', mechanism: 'anneal', tags: ['anneal'], artifactPaths: [] },
    outcome: { score: 0.5, evaluated: true, valid: true, failClass: 'ok', error: null, deltaVsBaseline: null, deltaVsParent: null },
    metrics: { agentCalls: 1, wallMs: null },
    notes: '',
    ...overrides,
  }
}

describe('per-workspace dataDir — engine level', () => {
  it('W1: resolves a relative dataDir per call against the given workspace root', async () => {
    const rootA = await makeTempRoot()
    const rootB = await makeTempRoot()
    const engine = makeEngine(rootA)

    const beginA = await engine.beginRound({ workspaceRoot: rootA, workspaceSource: 'session' })
    expect(beginA.workspace).toEqual({ root: path.resolve(rootA, RELATIVE_DATA_DIR), source: 'session' })
    expect(existsSync(path.join(rootA, RELATIVE_DATA_DIR, 'trees'))).toBe(true)
    expect(existsSync(path.join(rootB, RELATIVE_DATA_DIR))).toBe(false)

    const beginB = await engine.beginRound({ workspaceRoot: rootB, workspaceSource: 'session' })
    expect(beginB.workspace?.root).toBe(path.resolve(rootB, RELATIVE_DATA_DIR))
    expect(existsSync(path.join(rootB, RELATIVE_DATA_DIR, 'trees'))).toBe(true)
  })

  it('W2: two workspaces are isolated — state written under A is invisible from B', async () => {
    const rootA = await makeTempRoot()
    const rootB = await makeTempRoot()
    const engine = makeEngine(rootA)

    const beginA = await engine.beginRound({ workspaceRoot: rootA, workspaceSource: 'session' })
    await engine.logDecision({
      roundId: beginA.roundId,
      batchSeq: 1,
      decisions: [decisionInput()],
    }, { workspaceRoot: rootA })
    await engine.endRound({ roundId: beginA.roundId }, { workspaceRoot: rootA })

    const historyA = await engine.history({ view: 'rounds' }, { workspaceRoot: rootA })
    expect((historyA.rounds as unknown[])).toHaveLength(1)
    const historyB = await engine.history({ view: 'rounds' }, { workspaceRoot: rootB })
    expect((historyB.rounds as unknown[])).toHaveLength(0)

    // The policy registries are per workspace as well: each bootstraps its own v0001.
    const policyA = await engine.policyGet({}, { workspaceRoot: rootA })
    const policyB = await engine.policyGet({}, { workspaceRoot: rootB })
    expect(policyA.activeVersion).toBe('v0001')
    expect(policyB.activeVersion).toBe('v0001')
  })

  it('W3: repeated calls with the same root reuse one store (sequence continues, no duplicate dirs)', async () => {
    const root = await makeTempRoot()
    const engine = makeEngine(root)

    const first = await engine.beginRound({ workspaceRoot: root, workspaceSource: 'session' })
    await engine.endRound({ roundId: first.roundId }, { workspaceRoot: root })
    const second = await engine.beginRound({ workspaceRoot: root, workspaceSource: 'session' })

    expect(second.roundId).toBe('r0002')
    expect(second.historyDigest.rounds).toBe(1) // the closed first round is context here
    expect(existsSync(path.join(root, RELATIVE_DATA_DIR, 'trees', 'r0001'))).toBe(true)
    expect(existsSync(path.join(root, RELATIVE_DATA_DIR, 'trees', 'r0002'))).toBe(true)
  })

  it('W4: falls back to the default root when no workspace is given, and discloses the fallback', async () => {
    const root = await makeTempRoot()
    const engine = makeEngine(root)

    // Disclosure 1: begin_round reports the resolved workspace and its source.
    const begin = await engine.beginRound({ workspaceSource: 'process-cwd' })
    expect(begin.workspace).toEqual({ root: path.resolve(root, RELATIVE_DATA_DIR), source: 'process-cwd' })

    // Disclosure 2: log_decision appends the fallback warning to its warnings.
    const logged = await engine.logDecision({
      roundId: begin.roundId,
      batchSeq: 1,
      decisions: [decisionInput()],
    }, { workspaceSource: 'process-cwd' })
    expect(logged.warnings.some((warning) => warning.includes('no session workspace resolvable'))).toBe(true)

    // The empty-decisions early return carries the disclosure too.
    const empty = await engine.logDecision({
      roundId: begin.roundId,
      batchSeq: 2,
      decisions: [],
    }, { workspaceSource: 'process-cwd' })
    expect(empty.warnings.some((warning) => warning.includes('no session workspace resolvable'))).toBe(true)

    // A session-sourced call on the same store produces no such warning.
    const sessionLogged = await engine.logDecision({
      roundId: begin.roundId,
      batchSeq: 3,
      decisions: [decisionInput()],
    }, { workspaceRoot: root, workspaceSource: 'session' })
    expect(sessionLogged.warnings.some((warning) => warning.includes('no session workspace resolvable'))).toBe(false)
  })

  it('W5: an absolute dataDir pins one shared store regardless of workspace root', async () => {
    const storeDir = await makeTempRoot()
    const rootA = await makeTempRoot()
    const rootB = await makeTempRoot()
    const engine = makeEngine(rootA, { dataDir: storeDir })

    const beginA = await engine.beginRound({ workspaceRoot: rootA, workspaceSource: 'session' })
    expect(beginA.workspace?.root).toBe(path.resolve(storeDir))
    // Same store from the other workspace: A's open round blocks a second begin.
    await expect(engine.beginRound({ workspaceRoot: rootB, workspaceSource: 'session' }))
      .rejects.toThrow(/still open/)
    const rounds = await engine.history({ view: 'rounds' }, { workspaceRoot: rootB })
    expect((rounds.rounds as unknown[])).toHaveLength(1)
  })
})

describe('per-workspace dataDir — through the tools (exec.agent.session.header.cwd)', () => {
  /** Stub exec context carrying (or omitting) the calling agent's session cwd. */
  function stubExec(name: string, args: unknown, cwd?: string): ToolExecuteContext {
    return {
      signal: new AbortController().signal,
      callId: `test-${name}`,
      name,
      arguments: args,
      token: null,
      ...(cwd !== undefined
        ? { agent: { inject: () => {}, session: { header: { cwd } } } }
        : {}),
    }
  }

  /** Tool harness with a RELATIVE dataDir; the default root is a temp dir
   *  (standing in for the wiring's process.cwd()) so tests never write into
   *  the repository. Workspace behavior is observable per call. */
  async function makeToolHarness() {
    const defaultRoot = await makeTempRoot()
    const engine = makeEngine(defaultRoot)
    const byName = new Map(buildToolDefinitions(engine).map((def) => [def.name, def]))
    const call = async (name: string, args: unknown = {}, cwd?: string): Promise<any> =>
      must(byName.get(name), `tool ${name} not registered`).execute(args as Record<string, unknown>, stubExec(name, args, cwd))
    return { call }
  }

  it('two sessions with different cwds get two stores; decisions land in the right one', async () => {
    const rootA = await makeTempRoot()
    const rootB = await makeTempRoot()
    const { call } = await makeToolHarness()

    const beginA = await call('dreamrsi_begin_round', {}, rootA) as { roundId: string; workspace: { root: string; source: string } }
    expect(beginA.workspace).toEqual({ root: path.resolve(rootA, RELATIVE_DATA_DIR), source: 'session' })
    const beginB = await call('dreamrsi_begin_round', {}, rootB) as { roundId: string; workspace: { root: string; source: string } }
    expect(beginB.workspace.root).toBe(path.resolve(rootB, RELATIVE_DATA_DIR))

    const logged = await call('dreamrsi_log_decision', {
      roundId: beginA.roundId,
      batchSeq: 1,
      decisions: [decisionInput()],
    }, rootA) as { accepted: string[]; warnings: string[] }
    expect(logged.warnings.some((warning) => warning.includes('no session workspace resolvable'))).toBe(false)
    expect(existsSync(path.join(rootA, RELATIVE_DATA_DIR, 'trees', beginA.roundId, 'nodes.jsonl'))).toBe(true)

    // Isolation with distinct ids per store: both workspaces independently
    // number their rounds r0001, but B's tree holds only its own root while
    // A's tree carries the logged attempt.
    const treeA = await call('dreamrsi_history', { view: 'tree', roundId: beginA.roundId }, rootA) as { rounds: { nodes: unknown[] }[] }
    expect(must(treeA.rounds[0]).nodes).toHaveLength(2)
    const treeB = await call('dreamrsi_history', { view: 'tree', roundId: beginB.roundId }, rootB) as { rounds: { nodes: unknown[] }[] }
    expect(must(treeB.rounds[0]).nodes).toHaveLength(1)
  })

  it('a call with no agent falls back to process.cwd() and discloses it in tool results', async () => {
    // The no-agent fallback IS process.cwd(), so this test chdirs into a temp
    // root (vitest's forks pool isolates it per worker) and restores after —
    // the store then lands in the temp dir instead of the package dir.
    const root = await makeTempRoot()
    const previousCwd = process.cwd()
    process.chdir(root)
    try {
      const { call } = await makeToolHarness()

      const begin = await call('dreamrsi_begin_round') as { roundId: string; workspace: { root: string; source: string } }
      expect(begin.workspace.source).toBe('process-cwd')
      expect(begin.workspace.root).toBe(path.resolve(root, RELATIVE_DATA_DIR))

      const logged = await call('dreamrsi_log_decision', {
        roundId: begin.roundId,
        batchSeq: 1,
        decisions: [decisionInput()],
      }) as { warnings: string[] }
      expect(logged.warnings.some((warning) => warning.includes('no session workspace resolvable'))).toBe(true)
      expect(existsSync(path.join(root, RELATIVE_DATA_DIR, 'trees', begin.roundId, 'nodes.jsonl'))).toBe(true)
    } finally {
      process.chdir(previousCwd)
    }
  })
})

describe('docs follow the per-workspace behavior', () => {
  it('R1: README documents per-workspace isolation and drops the process.cwd() caveat', async () => {
    const { readFile } = await import('node:fs/promises')
    const readme = await readFile(path.join(PACKAGE_ROOT, 'README.md'), 'utf8')
    expect(readme).toContain('per-workspace')
    // Public README phrasing: resolution happens per call against the calling
    // agent's session workspace (the implementation detail — the exec-context
    // lookup — lives in the source, not the docs).
    expect(readme).toContain('per call')
    expect(readme).toContain('session workspace')
    // The old caveat is gone in every phrasing it used.
    expect(readme).not.toContain('process.cwd()')
    expect(readme).not.toContain('at load time')
    expect(readme).not.toContain('at mount time')
  })

  it('R2: the preset composition comment documents per-call workspace resolution', async () => {
    const { readFile } = await import('node:fs/promises')
    const text = await readFile(path.join(PACKAGE_ROOT, 'preset', 'dream-rsi', 'agent.cordis.yml'), 'utf8')
    // The explanatory comment block sits ABOVE the dream-rsi row.
    const dreamSection = text.slice(text.indexOf('# The Dream-RSI loop'))
    expect(dreamSection).toContain('session workspace')
    expect(dreamSection).toContain('every tool call')
    expect(dreamSection).not.toContain('at mount time')
    expect(dreamSection).not.toContain('process working directory')
  })
})
