/**
 * Dream-RSI recursive self-improvement loop for DSH (Cordis).
 *
 * Function plugin per docs/user/develop/basic/index.md: export `name`,
 * `inject`, and `apply(ctx, config)`. `apply` wires the DreamEngine (store +
 * replay simulator + dreaming loop) and registers the seven model-facing
 * tools from the spec's §7 tool surface. Tool registration is effect-based —
 * disposing the plugin fiber unregisters everything.
 *
 * v0.2 (paper-faithful core): policies are CODE by default — Python modules
 * exposing `solve(view)`, executed through `ctx.subprocess` (`python -I`,
 * JSON-lines decision protocol, per-episode timeout with abort + terminate).
 * The v0.1 JSON DSL interpreter is retained behind `policyEngine: 'legacy'`,
 * and dreaming runs as a mandatory cycle stage (`autoDream: 'every-cycle'`).
 *
 * @module @dreamrsi/plugin-dream-rsi
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { DreamEngine } from './engine.ts'
import { buildToolDefinitions, DREAMRSI_TOOLS } from './tools.ts'
import { DEFAULT_CONFIG, type PluginConfig } from './types.ts'

export type * from './types.ts'
export { DreamEngine, EngineError } from './engine.ts'
export { DreamStore, StoreError, runnerPathOf, policySourcePathOf, RUNNER_FILE_NAME } from './store.ts'
export { buildToolDefinitions, DREAMRSI_TOOLS } from './tools.ts'
export { defaultPolicyDsl, INVALID_SCORE, runDream, validatePolicyDsl, buildPolicyView } from './dreaming.ts'
export { BOOTSTRAP_POLICY_SOURCE, PYTHON_RUNNER_SOURCE } from './bootstrap-policy.ts'
export { startPolicyProcess } from './policy-runtime.ts'
export {
  batchDiversity,
  buildCorpus,
  buildWorld,
  checkBatch,
  checkBatchRecords,
  commitReveals,
  computeNormalization,
  estimateOutcome,
  initObserved,
  isExhausted,
  normalizeScore,
  pessimisticPrior,
  step,
} from './replay.ts'

/** Cordis function-plugin name. */
export const name = 'dream-rsi'

/**
 * Services required before `apply` runs: the tool registry, and — v0.2 F1 —
 * the subprocess seam that executes code policies (`python -I` JSON-lines
 * decision protocol). Both are host-plane services; preset rows resolve them
 * without a realm.
 */
export const inject = ['tools', 'subprocess']

/**
 * Schemastery schema validating the plugin's `config` block in cordis.yml.
 * Defaults live on the schema fields; every key is optional for the user.
 * See README.md for the field reference.
 */
export const Config: Schema<PluginConfig> = Schema.object({
  dataDir: Schema.string().default(DEFAULT_CONFIG.dataDir),
  candidateCount: Schema.number().default(DEFAULT_CONFIG.candidateCount),
  maxOnlineRounds: Schema.number().default(DEFAULT_CONFIG.maxOnlineRounds),
  maxReplayRounds: Schema.number().default(DEFAULT_CONFIG.maxReplayRounds),
  beta1: Schema.number().default(DEFAULT_CONFIG.beta1),
  beta2: Schema.number().default(DEFAULT_CONFIG.beta2),
  normalizeScores: Schema.boolean().default(DEFAULT_CONFIG.normalizeScores),
  estimatorMaxAnalogues: Schema.number().default(DEFAULT_CONFIG.estimatorMaxAnalogues),
  estimatorMinAnalogues: Schema.number().default(DEFAULT_CONFIG.estimatorMinAnalogues),
  similarityFloor: Schema.number().default(DEFAULT_CONFIG.similarityFloor),
  hallucinationTau: Schema.number().default(DEFAULT_CONFIG.hallucinationTau),
  noveltyLambda: Schema.number().default(DEFAULT_CONFIG.noveltyLambda),
  confidenceMediumTau: Schema.number().default(DEFAULT_CONFIG.confidenceMediumTau),
  similarityGamma: Schema.number().default(DEFAULT_CONFIG.similarityGamma),
  policyEngine: Schema.union(['code', 'legacy'] as const).default(DEFAULT_CONFIG.policyEngine),
  autoDream: Schema.union(['every-cycle', 'on-stagnation', 'off'] as const).default(DEFAULT_CONFIG.autoDream),
  trajectoryCap: Schema.number().default(DEFAULT_CONFIG.trajectoryCap),
  policyEpisodeTimeoutMs: Schema.number().default(DEFAULT_CONFIG.policyEpisodeTimeoutMs),
  devLoop: Schema.union(['host-llm', 'agent-relay'] as const).default(DEFAULT_CONFIG.devLoop),
  poolSize: Schema.number().default(DEFAULT_CONFIG.poolSize),
  maxLlmCallsPerCycle: Schema.number().default(DEFAULT_CONFIG.maxLlmCallsPerCycle),
  llmRoute: Schema.object({
    provider: Schema.string(),
    model: Schema.string(),
  }).default(undefined as unknown as { provider: string; model: string }),
  estimate: Schema.union(['off', 'rco'] as const).default(DEFAULT_CONFIG.estimate),
})

/** Default workspace root when a tool call carries no session workspace. */
const FALLBACK_WORKSPACE_ROOT = process.cwd()

/**
 * Plugin entry point. Called by Cordis with the validated config once every
 * injected service (here: `tools` and `subprocess`) is ready.
 */
export function apply(ctx: Context, config: PluginConfig): void {
  const logger = ctx.logger('dream-rsi')
  const engine = new DreamEngine({
    config,
    workspaceRoot: FALLBACK_WORKSPACE_ROOT,
    subprocess: ctx.subprocess,
  })

  // Effect-based registration: disposing the plugin fiber unregisters the tools.
  for (const definition of buildToolDefinitions(engine)) {
    ctx.tools.register(definition)
  }

  ctx.effect(() => {
    logger.info('dream-rsi loaded', {
      dataDir: config.dataDir,
      // Per-workspace state: a relative dataDir resolves against the calling
      // agent's session workspace per tool call (process.cwd() only when a
      // call carries no session workspace). Nothing is created at mount.
      workspaceIsolation: 'per-session-workspace',
      policyEngine: config.policyEngine,
      autoDream: config.autoDream,
      trajectoryCap: config.trajectoryCap,
      candidateCount: config.candidateCount,
      beta1: config.beta1,
      beta2: config.beta2,
      tools: DREAMRSI_TOOLS.length,
    })
    return () => {
      logger.info('dream-rsi disposed')
    }
  }, 'dream-rsi.lifecycle()')
}
