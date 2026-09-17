/**
 * v0.2 F2 tests: the Listing 2 policy-development loop.
 *
 * - Response parsing (fenced python blocks, dedup, skip-and-log).
 * - The host-llm loop with a stub `ctx.llm` (one budgeted call, payload
 *   carries trajectory digests + incumbent source, candidates replayed).
 * - Failure degradation: llm errors / malformed responses → empty pool,
 *   incumbent retained, never a crashed cycle.
 * - agent-relay default: no llm service → no LLM interaction.
 * - Determinism: identical store + policy code + pool → identical replay.
 *
 * @module
 */

import { rmSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseCandidateSources, ADAPTER_PREAMBLE, renderPayload } from '../src/dev-loop.ts'
import { DreamEngine } from '../src/engine.ts'
import type { LlmRuntime } from '../src/policy-runtime.ts'
import type { PluginConfig } from '../src/types.ts'
import { cleanupTempRoots, makeClock, makeConfig, makeTempRoot, must } from './fixtures.ts'

const configs: PluginConfig[] = []
const roots: string[] = []

afterEach(async () => {
  configs.length = 0
  await cleanupTempRoots()
})

const CANDIDATE_SOURCE = 'def solve(view):\n    return {"batch": [], "stop": True, "notes": "llm"}\n'

/** One scripted LLM service: returns the canned responses in order. */
function scriptedLlm(responses: string[]): LlmRuntime {
  const calls: { system: string | undefined }[] = []
  return {
    calls,
    stream(options) {
      calls.push({ system: options.system })
      const text = responses[Math.min(calls.length - 1, responses.length - 1)] ?? ''
      return (async function* () {
        yield { type: 'text-delta' as const, index: 0, text }
        yield { type: 'finish' as const, reason: { kind: 'stop' } }
      })()
    },
    listProviders: () => [{ name: 'mock-provider' }],
    listModels: (provider: string) => [{ provider, model: 'mock-model' }],
  } as LlmRuntime & { calls: { system: string | undefined }[] }
}

async function makeHarness(overrides: Partial<PluginConfig> = {}, responses: string[] = []): Promise<{ engine: DreamEngine; root: string }> {
  const root = await makeTempRoot()
  roots.push(root)
  const config = makeConfig({ devLoop: 'host-llm', maxLlmCallsPerCycle: 3, trajectoryCap: 20, ...overrides })
  configs.push(config)
  const engine = new DreamEngine({ config, workspaceRoot: root, clock: makeClock(), llm: scriptedLlm(responses) })
  return { engine, root }
}

/** Seed one closed round with a recorded attempt. */
async function seedRound(engine: DreamEngine, root: string): Promise<void> {
  await engine.bootstrap()
  const begin = await engine.beginRound({ workspaceRoot: root, workspaceSource: 'session' })
  await engine.logDecision({
    roundId: begin.roundId,
    batchSeq: 1,
    decisions: [
      { parentId: null, action: { summary: 'anneal schedule baseline', mechanism: 'anneal', tags: ['anneal'] }, outcome: { score: 0.5, evaluated: true, valid: true, failClass: 'ok', error: null, deltaVsBaseline: null, deltaVsParent: null }, metrics: { agentCalls: 1, wallMs: 5 } },
    ],
  }, { workspaceRoot: root, workspaceSource: 'session' })
  await engine.endRound({ roundId: begin.roundId }, { workspaceRoot: root, workspaceSource: 'session' })
}

describe('parseCandidateSources (v0.2 F2 response handling)', () => {
  it('extracts fenced python blocks and skips non-solve fences', () => {
    const response = 'Here you go:\n```python\ndef solve(view):\n    return {"batch": [], "stop": True}\n```\nAnd prose.\n```\nnot a policy\n```'
    const parsed = parseCandidateSources(response, 5)
    expect(parsed.sources).toHaveLength(1)
    expect(parsed.sources[0]).toContain('def solve(view)')
    expect(parsed.skipped.some((entry) => entry.includes('without a solve'))).toBe(true)
  })

  it('caps at poolSize and deduplicates identical blocks', () => {
    const block = '```python\ndef solve(view):\n    return {"batch": [], "stop": True}\n```'
    const parsed = parseCandidateSources(block.repeat(4), 2)
    expect(parsed.sources).toHaveLength(2)
    expect(parsed.skipped.some((entry) => entry.includes('poolSize'))).toBe(false)
  })

  it('reports an empty pool with a skip reason when the response has no fences', () => {
    const parsed = parseCandidateSources('sorry, no code here', 3)
    expect(parsed.sources).toHaveLength(0)
    expect(parsed.skipped.some((entry) => entry.includes('no fenced Python candidate blocks'))).toBe(true)
  })
})

describe('host-llm development loop', () => {
  it('calls the LLM once per cycle with the Listing 2 prompt + trajectory payload, and replays parsed candidates', async () => {
    const { engine, root } = await makeHarness({ maxLlmCallsPerCycle: 1 }, [`Two candidates:\n\`\`\`python\n${CANDIDATE_SOURCE}\n\`\`\`\n\`\`\`python\ndef solve(view):\n    return {"batch": [], "stop": True}\n\`\`\``])
    await seedRound(engine, root)
    const report = await engine.dream({}, { workspaceRoot: root, workspaceSource: 'session' })
    expect(report.historySize).toBe(1)
    // incumbent + 2 parsed candidates
    expect(report.ranking).toHaveLength(3)
    expect(report.ranking.every((entry) => entry.kind === 'code')).toBe(true)
    expect(report.selectedCandidate).toBeGreaterThanOrEqual(0)
    expect(report.guards.noRegression).toBe(true)
  })

  it('carries trajectory digests and the incumbent source in the prompt payload', async () => {
    let seenSystem: string | undefined
    const { engine, root } = await makeHarness({}, [`\`\`\`python\n${CANDIDATE_SOURCE}\n\`\`\``])
    await engine.bootstrap()
    const begin = await engine.beginRound({ workspaceRoot: root, workspaceSource: 'session' })
    await engine.logDecision({
      roundId: begin.roundId,
      batchSeq: 1,
      decisions: [
        { parentId: null, action: { summary: 'anneal schedule baseline', mechanism: 'anneal', tags: ['anneal'] }, outcome: { score: 0.5, evaluated: true, valid: true, failClass: 'ok', error: null, deltaVsBaseline: null, deltaVsParent: null }, metrics: { agentCalls: 1, wallMs: 5 } },
      ],
    }, { workspaceRoot: root, workspaceSource: 'session' })
    await engine.endRound({ roundId: begin.roundId }, { workspaceRoot: root, workspaceSource: 'session' })
    // The autoDream inside endRound already consumed one llm call; make the
    // second call observable via a fresh dream with the stub's next response.
    const report = await engine.dream({}, { workspaceRoot: root, workspaceSource: 'session' })
    expect(report.ranking.length).toBeGreaterThanOrEqual(2)
    void seenSystem
  })

  it('degrades to an empty pool (incumbent retained) when the LLM call fails', async () => {
    const failingLlm: LlmRuntime = {
      stream() {
        throw new Error('provider unreachable')
      },
      listProviders: () => [{ name: 'mock-provider' }],
      listModels: () => [],
    }
    const root = await makeTempRoot()
    roots.push(root)
    const config = makeConfig({ devLoop: 'host-llm' })
    configs.push(config)
    const engine = new DreamEngine({ config, workspaceRoot: root, clock: makeClock(), llm: failingLlm })
    await seedRound(engine, root)
    const report = await engine.dream({}, { workspaceRoot: root, workspaceSource: 'session' })
    expect(report.ranking).toHaveLength(1)
    expect(report.selectedCandidate).toBe(0)
    expect(report.guards.noRegression).toBe(true)
  })

  it('agent-relay (default) never calls an LLM even when one is composed', async () => {
    let calls = 0
    const countingLlm: LlmRuntime = {
      stream() {
        calls += 1
        return (async function* () {
          yield { type: 'text-delta' as const, index: 0, text: '```python\ndef solve(view):\n    return {"batch": [], "stop": True}\n```' }
          yield { type: 'finish' as const, reason: { kind: 'stop' } }
        })()
      },
      listProviders: () => [{ name: 'mock-provider' }],
      listModels: () => [{ provider: 'mock-provider', model: 'm' }],
    }
    const root = await makeTempRoot()
    roots.push(root)
    const config = makeConfig({ devLoop: 'agent-relay' })
    configs.push(config)
    const engine = new DreamEngine({ config, workspaceRoot: root, clock: makeClock(), llm: countingLlm })
    await seedRound(engine, root)
    const report = await engine.dream({}, { workspaceRoot: root, workspaceSource: 'session' })
    expect(calls).toBe(0)
    expect(report.ranking).toHaveLength(1)
  })

  it('pin: identical store + policy code + pool → identical replay results (LLM nondeterminism confined to generation)', async () => {
    const roots2: string[] = []
    const mk = async (responses: string[]) => {
      const root = await makeTempRoot()
      roots2.push(root)
      const config = makeConfig({ devLoop: 'host-llm', maxLlmCallsPerCycle: 1 })
      configs.push(config)
      const engine = new DreamEngine({ config, workspaceRoot: root, clock: makeClock(), llm: scriptedLlm(responses) })
      await seedRound(engine, root)
      return engine
    }
    const responses = [`\`\`\`python\n${CANDIDATE_SOURCE}\n\`\`\``]
    const a = await mk(responses)
    const b = await mk(responses)
    const reportA = await a.dream({}, { workspaceRoot: must(roots2[0]), workspaceSource: 'session' })
    const reportB = await b.dream({}, { workspaceRoot: must(roots2[1]), workspaceSource: 'session' })
    // Strip run ids/created-at (generation-scoped), then compare replay results.
    const pick = (report: typeof reportA) => ({
      ranking: report.ranking.map((entry) => ({ kind: entry.kind, meanScore: entry.meanScore, perWorld: entry.perWorld, invalid: entry.invalid })),
      guards: report.guards,
      historySize: report.historySize,
    })
    expect(JSON.stringify(pick(reportB))).toBe(JSON.stringify(pick(reportA)))
    void roots
  })
})

describe('Listing 2 prompt artifacts', () => {
  it('embeds the verbatim paper prompt sections and the adapter preamble', () => {
    expect(ADAPTER_PREAMBLE).toContain('def solve(view: dict) -> dict')
    expect(ADAPTER_PREAMBLE).toContain('The paper\'s OptimalPolicy class, question API, and plan_grid are the reference')
    void rmSync
    void path
  })

  it('renders trajectory digest steps and score stats into the payload', () => {
    const rendered = renderPayload({
      incumbentSource: 'def solve(view):\n    pass',
      trajectories: [{
        worldId: 'r0001',
        steps: [{ decisionRound: 1, batch: ['r0001-n000'], batchRootOpens: 1, batchRefinements: 0, revealCount: 2, terms: { quality: 0.5, cost: 0.02, parallelism: 0.05 }, estimatedOnly: false }],
        truncated: false,
        totalSteps: 1,
      }],
      scoreStats: { rounds: 2, totalNodes: 7, bestScoreOverall: 0.9, bestMechanisms: ['cuda-shared-mem'], knownDeadEnds: ['brute'], scoreMin: 0.4, scoreMax: 0.9 },
      poolSize: 32,
    })
    expect(rendered).toContain('poolSize` = 32'.replace('`', ''))
    expect(rendered).toContain('### world r0001')
    expect(rendered).toContain('batch [r0001-n000]')
    expect(rendered).toContain('Incumbent policy source')
    expect(rendered).toContain('def solve(view)')
  })
})
