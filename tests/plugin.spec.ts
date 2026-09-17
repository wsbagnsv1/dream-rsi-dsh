/**
 * Plugin-composition tests for the Cordis entry point (`src/index.ts`):
 * Loader-safe export shape, `apply()` mounting with a stub ctx, tool
 * registration, and effect-based cleanup.
 *
 * Both bare DSH specifiers are aliased to minimal runtime stubs (the package
 * is standalone; the real modules exist only inside the DSH host):
 * - `@deepseek-ai/dsh-tools`: `defineTool` is the identity — registration
 *   borrows the definition, per docs/cookbook/adding-a-tool.md.
 * - `@deepseek-ai/schemastery`: chainable no-op schema builders (the plugin
 *   never calls the schema; Cordis validates config at load time).
 *
 * @module
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { AnyToolDefinition } from '@deepseek-ai/dsh-tools'

vi.mock('@deepseek-ai/dsh-tools', () => ({
  defineTool: (definition: unknown) => definition,
}))

vi.mock('@deepseek-ai/schemastery', () => {
  const chainable = (): Record<string, unknown> => {
    const node: Record<string, unknown> = {}
    node.default = () => node
    node.required = () => node
    node.description = () => node
    return node
  }
  return {
    default: Object.assign(function schema() {}, {
      object: () => chainable(),
      string: () => chainable(),
      number: () => chainable(),
      boolean: () => chainable(),
      array: () => chainable(),
      dict: () => chainable(),
      union: () => chainable(),
      const: () => chainable(),
    }),
  }
})

import * as plugin from '../src/index.ts'
import { DREAMRSI_TOOLS } from '../src/tools.ts'
import type { PluginConfig } from '../src/types.ts'
import { cleanupTempRoots, makeConfig, makeTempRoot, must } from './fixtures.ts'

afterEach(async () => {
  await cleanupTempRoots()
})

interface StubCtx {
  ctx: Context
  registered: AnyToolDefinition[]
  disposers: Array<void | (() => void | Promise<void>)>
}

/** Stub Cordis context: collects tool registrations and effect disposers. */
function stubCtx(): StubCtx {
  const registered: AnyToolDefinition[] = []
  const disposers: Array<void | (() => void | Promise<void>)> = []
  const ctx = {
    root: null,
    tools: {
      register: (definition: AnyToolDefinition) => {
        registered.push(definition)
      },
    },
    effect: (body: () => void | (() => void | Promise<void>)) => {
      disposers.push(body())
      return () => {
        /* early disposal */
      }
    },
    on: () => () => {},
    emit: () => {},
    get: () => undefined,
    logger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
  }
  return { ctx: ctx as unknown as Context, registered, disposers }
}

async function mounted(): Promise<StubCtx & { config: PluginConfig; root: string }> {
  const root = await makeTempRoot()
  const config = makeConfig({ dataDir: root })
  const stub = stubCtx()
  plugin.apply(stub.ctx, config)
  return { ...stub, config, root }
}

describe('plugin export shape (Loader-safe, mirrors the schedule package convention)', () => {
  it('exports name / inject / apply / Config and no default export', () => {
    expect('default' in plugin).toBe(false)
    expect(plugin.name).toBe('dream-rsi')
    expect(plugin.inject).toEqual(['tools'])
    expect(typeof plugin.apply).toBe('function')
    expect(plugin.Config).toBeTypeOf('object')
    expect(plugin.DREAMRSI_TOOLS).toEqual([...DREAMRSI_TOOLS])
  })
})

describe('apply() with a stub ctx', () => {
  it('registers exactly the seven Dream-RSI tools synchronously', async () => {
    const { registered } = await mounted()
    expect(registered.map((def) => def.name)).toEqual([...DREAMRSI_TOOLS])
    for (const def of registered) {
      expect(def.description.length).toBeGreaterThan(20)
      expect(def.parameters).toBeTypeOf('object')
      expect(typeof def.execute).toBe('function')
    }
  })

  it('wires tools to a working engine: the registered surface executes end-to-end', async () => {
    const { registered, root } = await mounted()
    const byName = new Map(registered.map((def) => [def.name, def]))
    const policyGet = must(byName.get('dreamrsi_policy_get'))
    const result = await policyGet.execute({}, {
      signal: new AbortController().signal,
      callId: 'test-policy-get',
      name: 'dreamrsi_policy_get',
      arguments: {},
      token: null,
    }) as { activeVersion: string; policy: { params: { name: string } } }
    // bootstrap() ran during apply and registered the default policy.
    expect(result.activeVersion).toBe('v0001')
    expect(result.policy.params.name).toBe('bootstrap-balanced')
    void root
  })

  it('runs the online loop through the mounted tools', async () => {
    const { registered } = await mounted()
    const byName = new Map(registered.map((def) => [def.name, def]))
    const exec = (name: string, args: unknown) => must(byName.get(name)).execute(args as Record<string, unknown>, {
      signal: new AbortController().signal,
      callId: `test-${name}`,
      name,
      arguments: args,
      token: null,
    })
    const begin = await exec('dreamrsi_begin_round', {}) as { roundId: string; policyVersion: string }
    expect(begin.roundId).toBe('r0001')
    const logged = await exec('dreamrsi_log_decision', {
      roundId: begin.roundId,
      batchSeq: 1,
      decisions: [{
        parentId: null,
        action: { summary: 'anneal the schedule', mechanism: 'anneal', tags: ['anneal'], artifactPaths: [] },
        outcome: { score: 0.5, evaluated: true, valid: true, failClass: 'ok', error: null, deltaVsBaseline: null, deltaVsParent: null },
        metrics: { agentCalls: 1, wallMs: null },
        notes: '',
      }],
    }) as { accepted: string[] }
    expect(logged.accepted).toEqual(['r0001-n001'])
    const ended = await exec('dreamrsi_end_round', { roundId: begin.roundId }) as { worldId: string }
    expect(ended.worldId).toBe('r0001')
  })

  it('the lifecycle effect disposer runs cleanly (effect-based cleanup)', async () => {
    const { disposers } = await mounted()
    expect(disposers.length).toBeGreaterThanOrEqual(1)
    for (const disposer of disposers) {
      if (typeof disposer === 'function') {
        // The disposer may be sync or async; both must settle without throwing.
        await expect(Promise.resolve(disposer())).resolves.toBeUndefined()
      }
    }
  })
})
