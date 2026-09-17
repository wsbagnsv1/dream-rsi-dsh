/**
 * v0.2 F2 — the Listing 2 policy-development loop via `ctx.llm`.
 *
 * **LLM surface check (documented per the task):** the harness `llm` service
 * exposes `stream(options: GenerateOptions): AsyncIterable<StreamChunk>` —
 * one model request is a fully-assembled `GenerateOptions` carrying
 * `provider` (a registered adapter route), `model`, `messages: Message[]`
 * (one-shot callers may instead pass `system` text), optional
 * `temperature/maxTokens/stop/signal`, and the call answers with a raw
 * `StreamChunk` stream (`text-delta` chunks carry the visible text;
 * `finish` reports stop/aborted/error). Route resolution: adapters register
 * provider routes; `llm.listProviders()` / `llm.listModels(provider)` are the
 * advisory catalogs — this module uses an explicit `llmRoute` config when
 * given, else the first registered provider and its first listed model (the
 * deployment default route as surfaced by the registry). Stream collection:
 * join `text-delta` texts in arrival order.
 *
 * **Loop shape (ROADMAP-v0.2 F2):** after every `end_round` under the
 * `autoDream` cadence, when `devLoop: 'host-llm'` and an `llm` service is
 * composed (fail-soft `ctx.get('llm')` — never a hard inject), the framework
 * makes ONE budgeted model call with the VERBATIM Listing 2 replay-based
 * policy improvement prompt (spec §9 B.2) plus a payload of trajectory
 * digests (v0.2 F4), score stats, and the incumbent policy's Python source.
 * The response is parsed into candidate code policies (fenced Python blocks);
 * malformed candidates are skipped and logged (never a crashed cycle), each
 * survivor is versioned as `vNNNN.py` with lineage and replayed against ALL
 * worlds. `devLoop: 'agent-relay'` (the default) keeps the DSH-native
 * adaptation: no LLM call — the dream report's trajectory digests let the
 * host agent play the policy-development role via `dreamrsi_policy_set`.
 *
 * LLM nondeterminism is confined to candidate GENERATION; replay scoring
 * stays deterministic for identical store + policy code + pool.
 *
 * @module
 */

/**
 * VERBATIM Listing 2 from the paper (Appendix B, "Prompt used for
 * replay-based improvement of the exploration policy"), reproduced from
 * docs/DREAM-RSI-SPEC.md §9 B.2. `{trajectory_digest}`, `{score_stats}`,
 * and `{incumbent_source}` are this plugin's payload substitutions; the
 * paper's own variables (`{method_file}`, `{history_dir}`, `{trace_pool}`)
 * are kept verbatim and explained in the wrapper prose.
 */
export const LISTING2_PROMPT = `You are improving one **prefix-only exploration policy**. Edit only
\`\`{method_file}\`\` and implement \`\`OptimalPolicy.solve(self, question, budget=None)\`\`.
Do not solve the scientific task and do not edit any other program.

## Objective: quality, work, and parallelism

The environment is a frozen, irregular branch×attempt grid. A policy opens a root
or refines the next cell of an already-open branch. Each revealed cell costs one
probe. The policy sees only the cells it has revealed so far; unrevealed scores are
unknown.

The evaluator sweeps your single \`\`beta\`\` knob and ranks the resulting curve by:

    pareto.reward = pareto.auc - lambda * parallel_penalty

\`\`pareto.auc\`\` rewards reaching high per-trace attainment with few **total probes**.
\`\`parallel_penalty\`\` is the mean of
\`\`effective_sequential_rounds / total_probes\`\` over the sweep. For a batch of size
\`\`k\`\` with \`\`W = question.max_parallelism\`\` workers, it costs one decision round and
\`\`ceil(k / W)\`\` effective sequential rounds. A serial policy has penalty near 1;
useful full batches approach \`\`1/W\`\`. Therefore choose only promising probes, but
batch independent promising probes whenever possible.

A local implementation failure does not by itself prove that its parent direction
is poor. Weigh recovery value against new roots and ordinary refinements while
keeping batches parallel.

## API

    question.reset()
    question.observed() -> dict[str, Observation]   # revealed prefix only
    question.legal_actions() -> list[str]           # roots + opened-branch frontiers
    question.legal_roots() -> list[str]             # unopened roots only
    question.opened_branches() -> list[int]
    question.meta(cell_id) -> CellMeta              # .branch .attempt .parent_id .seq .tags
    question.probe_batch(cells, on_reveal=...) -> list[Observation]
    question.baseline_score
    question.max_parallelism

\`\`Observation\`\` supplies \`\`branch\`\`, \`\`attempt\`\`, \`\`score\`\`, \`\`evaluated\`\`, \`\`valid\`\`,
\`\`fail_class\`\`, \`\`error\`\`, \`\`delta_vs_baseline\`\`, \`\`delta_vs_parent\`\`, \`\`n_valid\`\`, and
\`\`n_total\`\`.
Use the helpers in \`\`see.policy.observation_signal\`\` when useful:
\`\`branch_promising\`\`, \`\`branch_failed_hard\`\`, \`\`probe_improved_vs_parent\`\`, and
\`\`probe_improved_vs_baseline\`\`.

**Success semantics:** an evaluated observation with \`\`error is None\`\` and
\`\`fail_class == "ok"\`\` is a successful evaluation, even when \`\`valid == False\`\` or
\`\`n_valid\`\`/\`\`n_total\`\` are unavailable. Never label it repairable solely because
\`\`valid\`\` is false. A *successful anchor* below means the best historical score
from such a successful evaluation.

Do **not** use \`\`question.best_so_far\`\` or \`\`question.budget_spent\`\` to decide what
to explore; they are bookkeeping only. Derive any decision statistic from
\`\`question.observed()\`\` instead.

## Required branch trajectory and failure interpretation

For each opened branch, reconstruct its ordered prefix trajectory, not only its
latest observation or best score: successful anchor, score trend, regressions,
failure/repair sequence, and explored versus remaining depth.

Before closing or deprioritizing a failed frontier, classify it as
hard-unrecoverable, repairable implementation failure, weak-but-underexplored, or
repeatedly unpromising after sufficient valid evidence. Output/correctness mismatch,
shared-memory/resource limits, and variable/code, mask/layout/shape errors are
normally repairable. Do not infer algorithmic failure from one such error.
\`\`n_valid == 0\`\` and \`\`branch_failed_hard(obs)\`\` are signals, not unconditional
closure: use \`\`fail_class\`\` and \`\`error\`\` to distinguish a repairable zero-valid
failure from an environment/dependency failure. \`\`compile_other\`\` alone is not
permanently hard. Classify the current failure episode: a later successful result
reopens the branch and cancels closure based only on an earlier failure.

## Required batch decision loop

At each decision round:

1. Read the prefix, reconstruct trajectories, and close only branches with
   cumulative evidence of being hard-unrecoverable or repeatedly unpromising.
2. Rank legal roots and legal branch frontiers using only prefix-derived signals:
   successful anchor, parent→child gain, complete branch trajectory, actual success
   versus failure evidence,
   failure recoverability, prior repair outcomes, remaining depth, and cross-branch
   comparison.
3. Rank actual repairable failures and underexplored frontiers in deterministic
   queues using trajectory, recoverability, remaining depth, repeated failures, and
   beta. A repairable failure retains eligibility unless cumulative evidence lowers
   its relative priority.
4. Build one **dynamic portfolio** batch of independent candidates, up to
   \`\`question.max_parallelism\`\`: exploitation (strong normal refinements),
   exploration (new roots or underexplored branches), and at most one recovery
   (an actual repairable failure). When multiple roles are eligible, give
   exploration and justified recovery representation before filling remaining slots
   by priority; adapt this to prefix evidence rather than fixed quotas. Recovery
   must not displace normal successful refinements or leave workers idle. Never
   sample randomly, and do not default to a singleton merely because its top
   candidate is clear.
5. Stop only after considering the whole revealed portfolio: active, underexplored,
   recoverable, unopened, and remaining legal candidates. Do not stop while an
   eligible high-priority recovery or underexplored candidate remains; every
   remaining action needs an evidence-based decision to continue, reserve, or close.

A batch must contain distinct cells that are all legal *before* the call. It may
contain several roots and/or one frontier from each opened branch. It must never
contain a parent and its child together. Do not use a fixed widen-all / deepen-all
wave schedule: adapt batch composition after every revealed prefix.

Minimal structure:

    from see.policy.api import (
        LLMDesignedMethod, SimResult, _budget_done, _record_curve, finalize_result,
    )

    def solve(self, question, budget=None):
        question.reset()
        res, closed = SimResult(), set()
        while not _budget_done(question, budget):
            prefix = question.observed()
            update_closed(closed, prefix, question)
            batch = select_batch(prefix, question, closed)
            if not batch:
                break
            question.probe_batch(
                batch,
                on_reveal=lambda _: _record_curve(res, question),
            )
        return finalize_result(question, res)

## Hard constraints

- Keep \`\`NAME = "OptimalPolicy"\`\` and implement
  \`\`class OptimalPolicy(LLMDesignedMethod)\`\` in \`\`{method_file}\`\` only.
- **Prefix-only:** decisions may use revealed observations, \`\`baseline_score\`\`, legal
  sets, structural \`\`meta\`\`, and helper signals. Never use unrevealed scores, a true
  optimum, hardcoded winning cell ids, absolute score targets, or internal trace data.
- Every prune, widen, deepen, batch, and stop decision must be explainable from the
  current prefix. Shallow weak scores are not enough to discard a branch: deeper
  attempts can recover. A repairable latest failure must not erase its historical
  successful anchor or by itself cause permanent starvation.
- Replay calls with \`\`budget=None\`\`. Always terminate when no batch is selected; do
  not assume a budget cap exists.
- A selected batch must be legal, have no duplicate ids, and contain at most
  \`\`question.max_parallelism\`\` cells.

## Beta: fixed per run, adaptive across cycles

Read exactly one scalar in \`\`__init__\`\`:

    beta = float(self.config.get("beta", <sensible_default>))

Beta has three distinct roles. Do not conflate them:

1. **Within one replay or live episode:** beta is fixed. Route every behavioral
   threshold through one \`\`_schedule(beta) -> dict\`\`. High beta means more width,
   deeper patience, and weaker pruning. Low beta means fewer probes, earlier
   stagnation stops, and stronger pruning. Never change beta from observations inside
   \`\`solve()\`\`. Route recovery eligibility, reserve threshold, and waiting through
   the same schedule: high beta is more patient; low beta remains selective without
   treating one repairable failure as automatic closure.
2. **During offline evaluation:** eval sweeps a fixed beta grid. This measures whether
   the policy exposes a real attainment/work/parallelism trade-off; it is not online
   beta adaptation.
3. **When proposing the next policy version:** choose the baked-in default beta once,
   using evidence from earlier *live* cycles and their beta sweeps. That default will
   remain fixed throughout the next live exploration episode.

Keep all thresholds relative to the prefix; never use absolute score cutoffs.

Use the following cross-cycle default-beta rule. Read the most recent 2–3
**live** \`\`trace_pool/iter*/live_cycle_manifest.json\`\` sidecars (and \`\`_current\`\`
when present) for each iteration's final best score and actual baked-in beta. Read
the matching archived \`\`beta_sweep.json\`\` values (\`\`pareto.reward\`\`, AUC, parallel
penalty, and the per-beta frontier). Scores alone do not establish that beta caused a
change, so always use both sources:

- live best is still improving: keep the prior default beta unless its sweep clearly
  shows a better nearby beta;
- live best has plateaued, and higher beta reaches higher attainment for a reasonable
  work/parallelism cost in the sweep: raise the default by a small step (about
  0.1–0.2, clamped to [0, 1]);
- a high default beta has already been tried through a plateau, and high-beta sweep
  points add work without higher attainment: lower it by a small step;
- history is insufficient or evidence conflicts: use a moderately exploratory default
  (about 0.6), rather than pretending the replay ceiling is a live stopping signal.

The beta sweep is non-degenerate only if beta changes the attainment/work trade-off.
It also reveals whether the policy batches. Do not select the default simply as the
smallest beta that reaches a frozen trace's known ceiling.

## Required next-cycle grid planning

Every proposed policy **must** implement this deterministic method:

    from see.policy.api import GridPlan, GridPlanningContext

    def plan_grid(self, context: GridPlanningContext) -> GridPlan:
        ...

This method runs **before** a new live grid is created. It does not make a
within-episode decision and must never inspect a current episode's outcomes.
It must always return a non-\`\`None\`\` \`\`GridPlan\`\`: do not inherit the template
stub and do not delegate grid choice to the runner's fallback. When history is
empty or insufficient, still return an explicit conservative bootstrap plan
derived from the context's fallback/hard-cap fields, with a factual reason.

\`\`GridPlan(branch_count=W, refine_count=R)\`\` accepts arbitrary integers, not a
fixed set of presets. It creates branches \`\`0..W-1\`\` and attempts \`\`0..R\`\`; \`\`R\`\` is
the number of refinements allowed after each root. The runner validates
\`\`1 <= W <= context.hard_max_branch_count\`\` and
\`\`0 <= R <= context.hard_max_refine_count\`\`. In replay, a requested plan beyond the
frozen trace's \`\`context.trace_branch_count\`\` or \`\`context.trace_refine_count\`\` is
out of support and cannot earn replay reward.

Use only the prefix-safe facts in \`\`context\`\`:

- \`\`history\`\`: completed earlier live manifests, including prior planned/effective
  grids, actual opened width/depth, probe work, decision rounds, scores, and beta;
- fallback/hard caps and worker cap;
- replay structural support fields. Do not read raw trace outcomes or a current
  cycle result inside \`\`plan_grid\`\`.

Choose width versus depth from evidence, not a default preference:

- many semantically distinct roots improve early while deeper refinements stall:
  increase width and reduce/hold depth;
- high gains arrive late on a small, repeatable set of directions: reduce/hold width
  and increase depth;
- all explored directions plateau after sufficient depth while meaningful direction
  classes remain uncovered: increase width;
- repeated hard, unrecoverable failures or strongly redundant directions: reduce
  width and depth conservatively;
- conflicting or insufficient history: return an explicit conservative bootstrap
  plan derived from the context, and state that evidence is insufficient.

Include a short, factual \`\`reason\`\` in every plan. \`\`plan_grid\`\` answers
how many directions to make available; the direction provider assigns those new
roots their directions, and \`\`solve\`\` still decides which legal roots/frontiers to
open, refine, prune, or stop. Do not choose roots merely because their branch id is
small. The runtime grid is the hard bound: controller thresholds may use less, but
can never create branches or attempts beyond the effective plan. Before finishing,
verify that the edited \`\`method.py\`\` contains an override of \`\`plan_grid\`\` that
returns \`\`GridPlan(branch_count=..., refine_count=..., reason=...)\`\` on every path.

## Learn from history without leaking outcomes

Earlier rounds are in \`\`{history_dir}/r####_*/\`\`. Read their policy code and
\`\`proposal_results/beta_sweep.json\`\`. Start from a strong recent policy, retain
mechanisms that raised \`\`pareto.reward\`\`, and make a concrete change when progress
stalls. A legacy AUC-only sweep is useful code history but is not numerically
comparable to the current reward. The baseline under \`\`{history_dir}/baseline/\`\` is
a parallel-refine floor to beat.

Each current-objective round also archives
\`\`proposal_results/policy_execution_traces.jsonl\`\`: one replay episode per
\`\`(frozen trace, beta)\`\`. Use it to diagnose general behavior — serial batches,
premature stops, over-pruning, or wasted probes — from the prefix state, selected
batch, and revealed outcomes at each decision round. It is **between-round feedback
only**: never read it inside \`\`solve()\`\`, and never copy a trace-specific branch,
cell id, score, or target into policy logic.

\`\`{trace_pool}\`\`, if present, may be read only outside \`\`solve()\`\`. Prefer the
\`\`live_cycle_manifest.json\`\` sidecars over raw replay outcomes for the per-iteration
live trend. Never copy trace scores, targets, or cell ids into policy logic.

## Deliverable

Write a complete adaptive policy in \`\`{method_file}\`\`. Include a short module
docstring describing its prefix signals, batch rule, beta schedule, default-beta
rationale, grid-planning rule (if implemented), and safeguards against
over-pruning, over-stopping, permanent starvation after repairable failures, and
serial probes. Before finishing, verify trajectory-based ranking, the stated
success semantics, non-automatic zero-valid closure, deterministic recovery
competition, and portfolio-level stop.`

/**
 * The plugin's adapter prose for Listing 2: maps the paper's Python-class
 * contract onto this plugin's stateless `solve(view)` JSON-lines contract and
 * frames the payload substitutions. Prepended to the verbatim prompt.
 */
export const ADAPTER_PREAMBLE = `You are developing a replacement exploration policy for the Dream-RSI loop.

In THIS deployment the policy contract is stateless, not a class: implement

    def solve(view: dict) -> dict

where view = { roundId, decisionRound, limits: {maxRounds (K1 decision rounds),
maxParallelism (W workers)}, selectable: [node summaries — the root plus the
current leaves of the observed tree, each with id, parentId, kind, depth,
branchId, seqInBranch, seq, score, evaluated, valid, failClass, deltaVsParent,
deltaVsBaseline, siblingCountAtDecision, actionSummary, mechanism, tags, notes],
history: { rounds, totalNodes, bestScoreOverall, bestMechanisms, knownDeadEnds,
scoreMin, scoreMax } }.
Return { batch: [nodeId, ...], stop: bool, notes: str } — batch ids must be taken
from view.selectable, at most limits.maxParallelism of them, never a parent together
with its child; stop=true ends the episode after this batch. Keep the paper's
required decision loop (below) but read the prefix from view.selectable and keep
all state in locals across the calls — the engine calls solve once per decision
round and reveals recorded children itself.

The paper's OptimalPolicy class, question API, and plan_grid are the reference
shape; your deliverable here is the stateless solve(view) module, optionally with
module-level helpers and a _schedule(beta) port of the beta rules.`

/** Score stats + trajectory payload blocks for the prompt. */
export interface Listing2Payload {
  /** The incumbent policy's Python source (code incumbents only). */
  incumbentSource: string | null
  /** Per-world trajectory digests of the incumbent's last dream run (F4). */
  trajectories: {
    worldId: string
    steps: { decisionRound: number; batch: string[]; batchRootOpens: number; batchRefinements: number; revealCount: number; terms: { quality: number; cost: number; parallelism: number }; estimatedOnly: boolean }[]
    truncated: boolean
    totalSteps: number
  }[]
  /** Score scale + headline stats across the pool. */
  scoreStats: {
    rounds: number
    totalNodes: number
    bestScoreOverall: number | null
    bestMechanisms: string[]
    knownDeadEnds: string[]
    scoreMin: number
    scoreMax: number
  }
  /** How many candidate policies to return (config poolSize). */
  poolSize: number
}

/** Render the payload as the fenced blocks the model reads after the prompt. */
export function renderPayload(payload: Listing2Payload): string {
  const parts: string[] = []
  parts.push('## Deployment payload (this engine, not the paper\'s grid runner)\n')
  parts.push('- Deliver poolSize = ' + String(payload.poolSize) + ' candidate policies as fenced ```python blocks; each block is ONE complete module defining def solve(view).')
  parts.push('- Score scale in this store: [' + String(payload.scoreStats.scoreMin) + ', ' + String(payload.scoreStats.scoreMax) + '] (normalize thresholds against it).')
  parts.push('- History: ' + String(payload.scoreStats.rounds) + ' closed rounds, ' + String(payload.scoreStats.totalNodes) + ' recorded attempts, best score overall: ' + String(payload.scoreStats.bestScoreOverall) + '.')
  if (payload.scoreStats.bestMechanisms.length > 0) parts.push('- Best mechanisms so far: ' + payload.scoreStats.bestMechanisms.join(', ') + '.')
  if (payload.scoreStats.knownDeadEnds.length > 0) parts.push('- Known dead ends: ' + payload.scoreStats.knownDeadEnds.join(', ') + '.')
  if (payload.incumbentSource !== null) {
    parts.push('\n## Incumbent policy source (candidate 0 — improve on it, do not copy it)\n\n```python\n' + payload.incumbentSource + '\n```')
  }
  if (payload.trajectories.length > 0) {
    parts.push('\n## Incumbent replay trajectory digests (per world, capped)\n')
    for (const trajectory of payload.trajectories) {
      parts.push('### world ' + trajectory.worldId + ' — ' + String(trajectory.totalSteps) + ' steps' + (trajectory.truncated ? ' (first ' + String(trajectory.steps.length) + ' shown)' : ''))
      for (const step of trajectory.steps) {
        parts.push(
          '- round ' + String(step.decisionRound)
          + ': batch [' + step.batch.join(', ') + ']'
          + ' (roots ' + String(step.batchRootOpens) + ', refinements ' + String(step.batchRefinements) + ')'
          + ', revealed ' + String(step.revealCount)
          + ', terms {quality ' + step.terms.quality.toFixed(4) + ', cost ' + step.terms.cost.toFixed(4) + ', parallelism ' + step.terms.parallelism.toFixed(4) + '}'
          + (step.estimatedOnly ? ' [estimated-only]' : ''),
        )
      }
    }
  }
  parts.push('\nBelow is the VERBATIM paper prompt for the decision-loop requirements it specifies (its OptimalPolicy class maps onto the stateless solve(view) contract above; its {method_file}, {history_dir}, and {trace_pool} variables are replaced by this payload and the store conventions):\n')
  return parts.join('\n')
}

/**
 * Parse candidate Python policy sources out of a model response: fenced
 * ```python blocks first, then any fence whose body defines solve(view).
 * Duplicates and bodies without a callable solve are dropped (skip-and-log
 * happens at the caller).
 */
export function parseCandidateSources(response: string, poolSize: number): { sources: string[]; skipped: string[] } {
  const sources: string[] = []
  const skipped: string[] = []
  const fencePattern = /```(?:python|py)?\s*\n([\s\S]*?)```/g
  let match: RegExpExecArray | null
  while ((match = fencePattern.exec(response)) !== null) {
    const body = (match[1] ?? '').trim()
    if (body.length === 0) continue
    if (!/def\s+solve\s*\(/.test(body)) {
      skipped.push('fenced block without a solve(view) definition')
      continue
    }
    sources.push(body)
    if (sources.length >= poolSize) break
  }
  if (sources.length === 0) {
    skipped.push('no fenced Python candidate blocks found in the response')
  }
  return { sources, skipped }
}
