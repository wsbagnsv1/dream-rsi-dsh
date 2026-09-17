/**
 * Regression tests for the bug found in the live subagent
 * test: `dreamrsi_begin_round` returned an undeclared `workspace` field and
 * the REAL harness validator rejected it ("value.workspace is not a declared
 * property") under `additionalProperties: false`. The standalone suite missed
 * it because the tool-facing specs stub dsh-tools with an identity `defineTool`
 * — this spec imports the REAL `@deepseek-ai/dsh-tools` through the runtime
 * dep junctions created during live debugging
 * (`node_modules/@deepseek-ai/dsh-tools → harness packages/core/tools`) and
 * validates representative engine results and args for all 7 tools against
 * their DECLARED schemas through the real validator path.
 *
 * Environment note: the junctions exist only where they were set up (this
 * machine). Without them the suite skips — the ambient-mirror specs cover the
 * logic; only this class covers the real schema enforcement.
 *
 * @module
 */

import { existsSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { DreamEngine } from '../src/engine.ts'
import type { PluginConfig } from '../src/types.ts'
import { cleanupTempRoots, makeClock, makeConfig, makeDsl, makeTempRoot, must } from './fixtures.ts'

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
/** The runtime-dep junction that makes the REAL harness dsh-tools importable. */
const DSH_TOOLS_JUNCTION = path.join(PACKAGE_ROOT, 'node_modules', '@deepseek-ai', 'dsh-tools')
const hasRealDshTools = existsSync(DSH_TOOLS_JUNCTION)

interface DshToolsModule {
  /** The registry's canonical-value validator (json-schema.ts). */
  validateJsonSchemaValue: (schema: unknown, value: unknown, path?: string) => string[]
  /** Thrown by a real definition's execute wrapper on invalid args. */
  ToolArgsError: new (violations: string[]) => Error
}

interface ToolsModule {
  buildToolDefinitions: (engine: DreamEngine) => Array<{
    name: string
    parameters: unknown
    output: { schema: unknown }
    execute: (args: Record<string, unknown>, exec: unknown) => Promise<unknown>
  }>
  DREAMRSI_TOOLS: readonly string[]
}

let dsh: DshToolsModule | undefined
let tools: ToolsModule | undefined

afterEach(async () => {
  await cleanupTempRoots()
})

describe.skipIf(!hasRealDshTools)('real dsh-tools schema validation (live-incident regression)', () => {
  /** Real validator over a definition's compiled output schema. */
  function outputViolations(def: { output: { schema: unknown } }, value: unknown): string[] {
    return must(dsh).validateJsonSchemaValue(def.output.schema, value)
  }

  /** Real validator over a definition's compiled parameter schema. */
  function argViolations(def: { parameters: unknown }, args: unknown): string[] {
    return must(dsh).validateJsonSchemaValue(def.parameters, args, 'arguments')
  }

  beforeAll(async () => {
    // Real imports — NO vi.mock anywhere in this file. Both load through the
    // junction into the harness's built @deepseek-ai/dsh-tools (directly, and
    // transitively via src/tools.ts, whose static bare import is why this
    // whole module must stay behind the skipIf guard).
    // Specifiers are assembled at runtime (+ @vite-ignore) so environments
    // WITHOUT the junction fail the skipIf guard instead of Vite's static
    // import analysis, which would reject the whole module at transform time.
    const dshSpecifier = '@deepseek-ai/' + 'dsh-tools'
    dsh = (await import(/* @vite-ignore */ dshSpecifier)) as unknown as DshToolsModule
    tools = (await import(/* @vite-ignore */ '../src/tools.ts')) as unknown as ToolsModule
  })

  /** Engine + the 7 REAL tool definitions on a temp workspace. */
  async function makeHarness() {
    const root = await makeTempRoot()
    const config: PluginConfig = makeConfig({ dataDir: root })
    const engine = new DreamEngine({ config, workspaceRoot: root, clock: makeClock() })
    const byName = new Map(must(tools).buildToolDefinitions(engine).map((def) => [def.name, def]))
    // Real ToolRunContext-compatible stub: identity + an agent whose session
    // cwd points at the temp workspace (state then lives under the temp dir).
    const exec = (name: string) => ({
      signal: new AbortController().signal,
      callId: `dsh-schema-${name}`,
      name,
      arguments: {},
      token: null,
      agent: {
        inject: () => {},
        session: { header: { cwd: root } },
      },
    })
    const call = async (name: string, args: unknown = {}): Promise<any> =>
      must(byName.get(name), `tool ${name} not registered`).execute(args as Record<string, unknown>, exec(name) as never)
    return { byName, call }
  }

  /** A minimal ToolRunContext-compatible exec without an agent. */
  function bareExec(name: string): unknown {
    return {
      signal: new AbortController().signal,
      callId: `dsh-schema-${name}`,
      name,
      arguments: {},
      token: null,
    }
  }

  function representativeDecision(): unknown {
    return {
      parentId: null,
      action: { summary: 'anneal the schedule', mechanism: 'anneal', tags: ['anneal'], artifactPaths: [] },
      outcome: { score: 0.5, evaluated: true, valid: true, failClass: 'ok', error: null, deltaVsBaseline: null, deltaVsParent: null },
      metrics: { agentCalls: 1, wallMs: null },
      notes: '',
    }
  }

  it('uses the REAL defineTool: parameter schemas arrive compiled, not as raw literals', async () => {
    const { byName } = await makeHarness()
    const begin = must(byName.get('dreamrsi_begin_round'))
    // The identity stub used by the standalone specs would leave the raw
    // literal ({}); the real defineTool compiles it to an object schema node.
    expect(begin.parameters).toMatchObject({ type: 'object' })
    expect(typeof must(dsh).validateJsonSchemaValue).toBe('function')
  })

  it('all 7 tools compile their declared schemas through the real defineTool', async () => {
    const { byName } = await makeHarness()
    expect([...byName.keys()]).toEqual([...must(tools).DREAMRSI_TOOLS])
    for (const name of must(tools).DREAMRSI_TOOLS) {
      const def = must(byName.get(name))
      expect(def.parameters, name).toMatchObject({ type: 'object' })
      expect(def.output.schema, name).toMatchObject({ type: 'object' })
    }
  })

  it('REGRESSION: begin_round declares the workspace field in its output schema and passes the real validator', async () => {
    const { byName, call } = await makeHarness()
    const begin = must(byName.get('dreamrsi_begin_round'))

    // The fix under test: the schema must declare workspace.
    const schemaText = JSON.stringify(begin.output.schema)
    expect(schemaText, 'output schema must declare workspace').toContain('"workspace"')

    // The live bug: the field was present but undeclared. Now it must both
    // be returned and validate clean through the real validator.
    const result = await call('dreamrsi_begin_round') as { workspace?: { root: string; source: string } }
    expect(result.workspace).toBeDefined()
    expect(result.workspace?.source).toBe('session')
    const violations = outputViolations(begin, result)
    expect(violations, violations.join('; ')).toEqual([])
  })

  it('the real validator is strict here: an undeclared field on a strict output schema is rejected', async () => {
    const { byName, call } = await makeHarness()
    const begin = must(byName.get('dreamrsi_begin_round'))
    const result = await call('dreamrsi_begin_round')
    // Negative control for the test class itself: a doctored value must fail
    // with exactly the error text from the live incident — proving this suite
    // would have caught the original bug.
    const violations = outputViolations(begin, { ...result, bogus: 1 })
    expect(violations.some((v) => v.includes('not a declared property'))).toBe(true)
  })

  it('log_decision: rich input passes the real arg validator; its result passes the output validator', async () => {
    const { byName, call } = await makeHarness()
    const begin = await call('dreamrsi_begin_round') as { roundId: string }
    const log = must(byName.get('dreamrsi_log_decision'))
    const args = {
      roundId: begin.roundId,
      batchSeq: 1,
      decisions: [representativeDecision()],
    }
    expect(argViolations(log, args)).toEqual([])
    const result = await log.execute(args as never, bareExec('dreamrsi_log_decision') as never)
    expect(outputViolations(log, result)).toEqual([])
    expect((result as { accepted: string[] }).accepted).toHaveLength(1)
  })

  it('log_decision input validation bites: missing roundId and a wrong-typed batchSeq are rejected by the real path', async () => {
    const { byName } = await makeHarness()
    const log = must(byName.get('dreamrsi_log_decision'))
    const base = { batchSeq: 1, decisions: [] }
    expect(argViolations(log, base).length).toBeGreaterThan(0) // missing roundId
    // Schema-level negative: batchSeq must be an integer. (batchSeq: 0 is
    // schema-VALID — the ≥ 1 rule lives in engine validation, not the schema.)
    expect(argViolations(log, { ...base, roundId: 'r0001', batchSeq: 'zero' }).length).toBeGreaterThan(0)
    // And through the definition's own execute wrapper: ToolArgsError.
    await expect(log.execute({ ...base, roundId: 'r0001', batchSeq: 'zero' } as never, bareExec('dreamrsi_log_decision') as never))
      .rejects.toThrow(must(dsh).ToolArgsError)
  })

  it('end_round result passes the real output validator', async () => {
    const { byName, call } = await makeHarness()
    const begin = await call('dreamrsi_begin_round') as { roundId: string }
    await call('dreamrsi_log_decision', { roundId: begin.roundId, batchSeq: 1, decisions: [representativeDecision()] })
    const end = await call('dreamrsi_end_round', { roundId: begin.roundId, summary: 'done' })
    expect(outputViolations(must(byName.get('dreamrsi_end_round')), end)).toEqual([])
    expect((end as { worldId: string }).worldId).toBe(begin.roundId)
  })

  it('history (tree view), dream, policy_get, and policy_set results pass the real output validator', async () => {
    const { byName, call } = await makeHarness()
    // Seed one closed round so dream has a world.
    const begin = await call('dreamrsi_begin_round') as { roundId: string }
    await call('dreamrsi_log_decision', { roundId: begin.roundId, batchSeq: 1, decisions: [representativeDecision()] })
    await call('dreamrsi_end_round', { roundId: begin.roundId })

    const history = await call('dreamrsi_history', { view: 'tree' })
    expect(outputViolations(must(byName.get('dreamrsi_history')), history)).toEqual([])

    const dream = await call('dreamrsi_dream', { candidates: [makeDsl({ name: 'challenger', W: 2 })] })
    expect(outputViolations(must(byName.get('dreamrsi_dream')), dream)).toEqual([])
    expect((dream as { guards: { noRegression: boolean } }).guards.noRegression).toBe(true)

    const policyGet = await call('dreamrsi_policy_get', {})
    expect(outputViolations(must(byName.get('dreamrsi_policy_get')), policyGet)).toEqual([])

    const policySet = await call('dreamrsi_policy_set', { policy: makeDsl({ name: 'variant' }), notes: 'variant' })
    expect(outputViolations(must(byName.get('dreamrsi_policy_set')), policySet)).toEqual([])
    expect((policySet as { accepted: boolean }).accepted).toBe(true)
  })

  it('representative args for the remaining tools pass their real compiled parameter schemas', async () => {
    const { byName } = await makeHarness()
    expect(argViolations(must(byName.get('dreamrsi_begin_round')), {})).toEqual([])
    expect(argViolations(must(byName.get('dreamrsi_end_round')), { roundId: 'r0001' })).toEqual([])
    expect(argViolations(must(byName.get('dreamrsi_end_round')), { roundId: 'r0001', summary: 's' })).toEqual([])
    expect(argViolations(must(byName.get('dreamrsi_history')), { view: 'tree' })).toEqual([])
    expect(argViolations(must(byName.get('dreamrsi_history')), { nodeId: 'r0001-n001' })).toEqual([])
    expect(argViolations(must(byName.get('dreamrsi_dream')), { candidates: [makeDsl({ name: 'x' })], sweepBetas: [0, 1], strictGuards: true })).toEqual([])
    expect(argViolations(must(byName.get('dreamrsi_policy_get')), {})).toEqual([])
    expect(argViolations(must(byName.get('dreamrsi_policy_get')), { version: 'v0001' })).toEqual([])
    expect(argViolations(must(byName.get('dreamrsi_policy_set')), { version: 'v0001', force: true })).toEqual([])
    expect(argViolations(must(byName.get('dreamrsi_policy_set')), { policy: makeDsl({ name: 'x' }), notes: 'n' })).toEqual([])
  })
})
