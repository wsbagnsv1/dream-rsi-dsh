/**
 * Model-facing Dream-RSI tool surface (spec §7): seven tools wired through
 * the DSH tool registration DSL (`defineTool` + `ctx.tools.register`).
 *
 * All tools are local, deterministic (apart from injected timestamps), and
 * network-free. `execute` returns one canonical JSON value per the DSH tool
 * contract; `render` projects it to model-facing text.
 *
 * @module
 */

import type { AnyToolDefinition, ToolExecuteContext } from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { EngineError, type DreamEngine } from './engine.ts'
import type { DecisionInput } from './types.ts'

/** The registered tool names, in registration order (spec §7). */
export const DREAMRSI_TOOLS = [
  'dreamrsi_begin_round',
  'dreamrsi_log_decision',
  'dreamrsi_end_round',
  'dreamrsi_history',
  'dreamrsi_dream',
  'dreamrsi_policy_get',
  'dreamrsi_policy_set',
] as const

/**
 * The workspace a tool call resolved to: the calling agent's session
 * workspace when one is resolvable, else the process working directory.
 */
interface ResolvedWorkspace {
  root: string
  source: 'session' | 'process-cwd'
}

/**
 * Resolve the workspace root for THIS call from the execute context — the
 * calling agent's per-session workspace (`exec.agent.session.header.cwd`,
 * the same lookup `dsh-tool-fs` uses), falling back to `process.cwd()` only
 * when no session workspace is resolvable (non-agent callers).
 */
function resolveWorkspace(exec: ToolExecuteContext): ResolvedWorkspace {
  const cwd = exec.agent?.session.header.cwd
  if (typeof cwd === 'string' && cwd.trim() !== '') return { root: cwd, source: 'session' }
  return { root: process.cwd(), source: 'process-cwd' }
}

/** Render a canonical value as compact JSON text for the model. */
function jsonRender(_args: unknown, value: unknown): { type: 'text'; text: string }[] {
  return [{ type: 'text', text: JSON.stringify(value) ?? 'null' }]
}

/** Map schema-validated tool args onto the engine's decision input shape. */
function toDecisionInput(decision: LogDecisionArgs['decisions'][number]): DecisionInput {
  return {
    parentId: decision.parentId,
    action: {
      summary: decision.action.summary,
      mechanism: decision.action.mechanism,
      tags: [...(decision.action.tags ?? [])],
      artifactPaths: [...(decision.action.artifactPaths ?? [])],
      ...(decision.action.evalProgramPath !== undefined ? { evalProgramPath: decision.action.evalProgramPath } : {}),
    },
    outcome: {
      score: decision.outcome.score,
      evaluated: decision.outcome.evaluated,
      valid: decision.outcome.valid,
      failClass: decision.outcome.failClass,
      error: decision.outcome.error ?? null,
      deltaVsBaseline: decision.outcome.deltaVsBaseline ?? null,
      deltaVsParent: decision.outcome.deltaVsParent ?? null,
    },
    metrics: {
      agentCalls: decision.metrics.agentCalls,
      wallMs: decision.metrics.wallMs ?? null,
    },
    notes: decision.notes ?? '',
  }
}

/** Argument type of `dreamrsi_log_decision`, mirrored for the mapper above. */
interface LogDecisionArgs {
  decisions: {
    parentId: string | null
    action: {
      summary: string
      mechanism: string
      tags?: string[]
      artifactPaths?: string[]
      evalProgramPath?: string
    }
    outcome: {
      score: number
      evaluated: boolean
      valid: boolean
      failClass: 'ok' | 'compile' | 'runtime' | 'correctness' | 'timeout' | 'resource' | 'other'
      error?: string | null
      deltaVsBaseline?: number | null
      deltaVsParent?: number | null
    }
    metrics: { agentCalls: number; wallMs?: number | null }
    notes?: string
  }[]
}

/** Build the seven Dream-RSI tool definitions against an engine instance. */
export function buildToolDefinitions(engine: DreamEngine): AnyToolDefinition[] {
  return [
    defineTool({
      name: 'dreamrsi_begin_round',
      description: 'Start one Dream-RSI online rollout (outer iteration). Creates the round and returns the active exploration policy (a JSON DSL you must follow), the round limits (maxRounds K1, maxParallelism W), and a digest of prior discovery history. Then repeatedly inspect the growing tree, pick a batch of at most W selectable nodes (the root opens a NEW branch; a current leaf refines that branch), execute the attempts, and log them with dreamrsi_log_decision.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            roundId: { type: 'string', required: true },
            policyVersion: { type: 'string', required: true },
            policy: { type: 'object', additionalProperties: true, description: 'active PolicyDsl' },
            limits: { type: 'object', additionalProperties: true, description: '{ maxRounds, maxParallelism }' },
            historyDigest: { type: 'object', additionalProperties: true, description: 'history summary: rounds, totalNodes, bestScoreOverall, bestMechanisms, knownDeadEnds' },
            workspace: {
              type: 'object',
              additionalProperties: false,
              required: true,
              description: 'Resolved Dream-RSI store location for this session',
              properties: {
                root: { type: 'string', required: true, description: 'Absolute store directory' },
                source: { type: 'string', required: true, enum: ['session', 'process-cwd'], description: 'session = resolved from the calling agent workspace; process-cwd = fallback (disclosed)' },
              },
            },
          },
        },
        render: jsonRender,
      },
      async execute(_args, exec) {
        const workspace = resolveWorkspace(exec)
        const result = await engine.beginRound({
          workspaceRoot: workspace.root,
          workspaceSource: workspace.source,
        })
        return { ...result, workspace: { root: result.workspace?.root ?? workspace.root, source: workspace.source } }
      },
    }),

    defineTool({
      name: 'dreamrsi_log_decision',
      description: 'Log one Dream-RSI decision round: the batch of selected nodes and, for each, the attempt description and the observed outcome. Call once per batch (preferred) with every child, or incrementally per node while a batch is in flight using the same batchSeq. parentId: null selects the root (open a NEW branch); otherwise it must be the id of a PRE-EXISTING current leaf (refine that branch) — a parent created inside the same batch is rejected. Fails if the round is closed or a non-root parent would get a second child.',
      parameters: {
        roundId: { type: 'string', required: true, description: 'Open round id from dreamrsi_begin_round' },
        batchSeq: { type: 'integer', required: true, description: '1-based decision-round number; reuse it for incremental calls of the same batch' },
        decisions: {
          type: 'array',
          required: true,
          description: 'One entry per selected node (batch order)',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              parentId: {
                oneOf: [{ type: 'string' }, { type: 'null' }],
                required: true,
                description: 'Node to extend; null = root (new branch)',
              },
              action: {
                type: 'object',
                additionalProperties: false,
                required: true,
                properties: {
                  summary: { type: 'string', required: true, description: 'One-line description of the attempt' },
                  mechanism: { type: 'string', required: true, description: 'Short mechanism label, e.g. "coordinate-descent"' },
                  tags: { type: 'array', items: { type: 'string' }, description: 'Free-form mechanism tags (used by replay similarity)' },
                  artifactPaths: { type: 'array', items: { type: 'string' }, description: 'Generated artifact paths' },
                  evalProgramPath: { type: 'string' },
                },
              },
              outcome: {
                type: 'object',
                additionalProperties: false,
                required: true,
                properties: {
                  score: { type: 'number', required: true, description: 's_v; larger = better; 0 on hard failure' },
                  evaluated: { type: 'boolean', required: true },
                  valid: { type: 'boolean', required: true, description: 'passed correctness checks' },
                  failClass: { type: 'string', required: true, enum: ['ok', 'compile', 'runtime', 'correctness', 'timeout', 'resource', 'other'] },
                  error: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                  deltaVsBaseline: { oneOf: [{ type: 'number' }, { type: 'null' }] },
                  deltaVsParent: { oneOf: [{ type: 'number' }, { type: 'null' }], description: 'computed from the parent score when omitted' },
                },
              },
              metrics: {
                type: 'object',
                additionalProperties: false,
                required: true,
                properties: {
                  agentCalls: { type: 'integer', required: true, description: 'discovery-agent calls consumed (usually 1)' },
                  wallMs: { oneOf: [{ type: 'number' }, { type: 'null' }] },
                },
              },
              notes: { type: 'string' },
            },
          },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            accepted: { type: 'array', items: { type: 'string' }, required: true, description: 'ids of the appended nodes' },
            treeStats: {
              type: 'object',
              additionalProperties: false,
              required: true,
              properties: {
                nodes: { type: 'integer', required: true },
                bestScore: { oneOf: [{ type: 'number' }, { type: 'null' }], required: true },
                decisionRounds: { type: 'integer', required: true },
              },
            },
            warnings: { type: 'array', items: { type: 'string' }, required: true },
          },
        },
        render: jsonRender,
      },
      async execute(args, exec) {
        const workspace = resolveWorkspace(exec)
        return engine.logDecision({
          roundId: args.roundId,
          batchSeq: args.batchSeq,
          decisions: args.decisions.map(toDecisionInput),
        }, { workspaceRoot: workspace.root, workspaceSource: workspace.source })
      },
    }),

    defineTool({
      name: 'dreamrsi_end_round',
      description: 'Close a Dream-RSI round and build the replay world for its finished discovery tree. The tree then becomes one more simulator world for offline dreaming. Returns the final round stats and the simulator shape.',
      parameters: {
        roundId: { type: 'string', required: true },
        summary: { type: 'string', description: 'Short free-form closing summary of the round' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            roundStats: { type: 'object', additionalProperties: true, description: 'final RoundRecord stats: nodes, attempts, bestScore, decisionRounds, batchSizes, composition, avgBatchSize' },
            worldId: { type: 'string', required: true },
            simulator: { type: 'object', additionalProperties: true, description: '{ nodes, branches, maxDepth }' },
            activePolicyVersion: { type: 'string', required: true },
          },
        },
        render: jsonRender,
      },
      async execute(args, exec) {
        return engine.endRound(
          { roundId: args.roundId, ...(args.summary !== undefined ? { summary: args.summary } : {}) },
          { workspaceRoot: resolveWorkspace(exec).root },
        )
      },
    }),

    defineTool({
      name: 'dreamrsi_history',
      description: 'Read-only query over accumulated Dream-RSI discovery history (the simulator pool). Views: "tree" (per-round node lists), "best-paths" (top chains by cumulative score), "failures" (grouped by mechanism + error digest), "rounds" (round records), "summary" (compact stats digest). Read the complete history before proposing a new policy or a new attempt.',
      parameters: {
        roundId: { type: 'string', description: 'Restrict to one round' },
        nodeId: { type: 'string', description: 'Return this node plus its subtree' },
        view: { type: 'string', enum: ['tree', 'best-paths', 'failures', 'rounds', 'summary'] },
        limit: { type: 'integer', description: 'Max entries for best-paths/failures (default 20)' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true, description: 'Shape depends on the requested view' },
        render: jsonRender,
      },
      async execute(args, exec) {
        return engine.history({
          ...(args.roundId !== undefined ? { roundId: args.roundId } : {}),
          ...(args.nodeId !== undefined ? { nodeId: args.nodeId } : {}),
          ...(args.view !== undefined ? { view: args.view } : {}),
          ...(args.limit !== undefined ? { limit: args.limit } : {}),
        }, { workspaceRoot: resolveWorkspace(exec).root })
      },
    }),

    defineTool({
      name: 'dreamrsi_dream',
      description: 'Offline dreaming: replay-score candidate exploration policies (PolicyDsl JSON objects you propose) against every recorded discovery tree, and get a ranked report with per-world diagnostics and selection guards. The currently active policy is ALWAYS evaluated as candidate 0, so selection can never regress on the replay history. Does NOT change the active policy — commit the winner with dreamrsi_policy_set. No LLM calls or network happen inside this tool.',
      parameters: {
        candidates: {
          type: 'array',
          required: true,
          description: 'Candidate PolicyDsl objects (do not include the incumbent; it is added automatically)',
          items: { type: 'object', additionalProperties: true, description: 'PolicyDsl: name, W, gridPlan{branchCount,refineCount,reason}, beta, portfolio, ranking, pruning, stopping, guidance (keep short/weak/empty), novel?' },
        },
        sweepBetas: { type: 'array', items: { type: 'number' }, description: 'Optional deterministic beta sweep (spec §6.4)' },
        strictGuards: { type: 'boolean', description: 'Also disqualify degenerate policies (never batches / single branch / stops immediately)' },
      },
        output: {
          schema: { type: 'object', additionalProperties: true, description: 'DreamReport: runId, selectedCandidate/Name/Version/Params, ranking[] with perWorld diagnostics, guards, historySize, normalization' },
          render: jsonRender,
        },
      async execute(args, exec) {
        return engine.dream({
          candidates: args.candidates,
          ...(args.sweepBetas !== undefined ? { sweepBetas: args.sweepBetas } : {}),
          ...(args.strictGuards !== undefined ? { strictGuards: args.strictGuards } : {}),
        }, { workspaceRoot: resolveWorkspace(exec).root })
      },
    }),

    defineTool({
      name: 'dreamrsi_policy_get',
      description: 'Read the active exploration policy (or a specific version) with the full version history. Use this to inspect the PolicyDsl you must follow online, or prior versions and their replay scores.',
      parameters: {
        version: { type: 'string', description: 'Policy version id (e.g. "v0003"); omit for the active policy' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true, description: '{ activeVersion, policy: PolicyRecord, history: version list }' },
        render: jsonRender,
      },
      async execute(args, exec) {
        return engine.policyGet(
          args.version !== undefined ? { version: args.version } : {},
          { workspaceRoot: resolveWorkspace(exec).root },
        )
      },
    }),

    defineTool({
      name: 'dreamrsi_policy_set',
      description: 'Commit an exploration policy version as active for the next online round. Either activate a previously registered version ({ version }) or register a new immutable version from a raw PolicyDsl ({ policy, notes } — parent = incumbent). The no-regression guard rejects strictly worse evaluated versions unless force: true.',
      parameters: {
        version: { type: 'string', description: 'Existing version id to activate' },
        policy: { type: 'object', additionalProperties: true, description: 'Raw PolicyDsl to register as a new version, then activate' },
        notes: { type: 'string', description: 'Rationale recorded with a newly registered policy' },
        force: { type: 'boolean', description: 'Override the no-regression guard' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            accepted: { type: 'boolean', required: true },
            activeVersion: { type: 'string', required: true },
            previousVersion: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
            guardCheck: {
              type: 'object',
              additionalProperties: false,
              required: true,
              properties: {
                meanReplayScore: { oneOf: [{ type: 'number' }, { type: 'null' }], required: true },
                incumbentScore: { oneOf: [{ type: 'number' }, { type: 'null' }], required: true },
                noRegression: { type: 'boolean', required: true },
                forced: { type: 'boolean', required: true },
              },
            },
          },
        },
        render: jsonRender,
      },
      async execute(args, exec) {
        if (args.version !== undefined && args.policy !== undefined) {
          throw new EngineError('pass either `version` or `policy`, not both')
        }
        return engine.policySet({
          ...(args.version !== undefined ? { version: args.version } : {}),
          ...(args.policy !== undefined ? { policy: args.policy } : {}),
          ...(args.notes !== undefined ? { notes: args.notes } : {}),
          ...(args.force !== undefined ? { force: args.force } : {}),
        }, { workspaceRoot: resolveWorkspace(exec).root })
      },
    }),
  ]
}
