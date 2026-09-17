# v0.2 Upgrade Proposal — Autonomous Dreaming & Policy Expressiveness

**Status:** PROPOSAL · **Target:** v0.2.0 · **Evidence base:** two live campaigns (circle-packing, 14 rounds, 2 policy redeployments, 33+ discovery nodes)

## Why these four features (evidence, not vibes)

1. **Dreaming fired only at round boundaries, on K=3–4 candidates.** The paper's offline phase iterates revisions against the simulator over a *massive* candidate pool (thousands of evaluations). Our RSI layer was ~idle during campaign 2's breakthrough — all learning happened within-round, where the plugin is deliberately hands-off.
2. **The policy layer cannot hold what the agent learns.** Campaign 2's champion technique (RNG stream-state replication) lived in `program.py` — inexpressible in the DSL. The agent's ideas die at the policy boundary.
3. **The RCO extension is load-bearing but uncalibrated.** In the historic `d0004` redeployment, RCO estimates made up 40–50% of some worlds' reveals and the winning margin was **0.00114**. Estimates already decide policy changes; their trustworthiness should be measured, not assumed.
4. **Context wipes lose the interpretive layer.** A fresh agent gets records + digest; the distilled "why" survives only if the digest is rich enough. Campaign 2 started from a cold context and still broke the plateau — richer digest makes that the default, not the exception.

All features are **opt-in with byte-identical defaults**: `autoDream: off`, `dreamJudge: off`, pool generator only on request. v0.1.1 behavior is preserved exactly unless configured.

---

## Feature 1 — Autonomous dreaming at scale

**1.1 Auto-dream triggers.** `autoDream: 'off' | 'on-stagnation' | 'every-round'` (default `off`). The engine already tracks best-score progression per round; when `on-stagnation` and N consecutive decision rounds produce no improvement, `end_round` runs the dream loop automatically and the result rides on the `end_round` response. `every-round` dreams after every closed round. `log_decision`/`end_round` responses also carry `suggestDream: true` + reason (passive signal, even when `off`).

**1.2 Candidate-pool generator (no LLM).** `dreamPoolSize` (default 24, cap 200): a deterministic perturbation generator expands the incumbent (plus optional seed DSLs) across a bounded grid — W ∈ {1..maxBatch}, β ∈ {0.2..0.8}, portfolio shares, `closeAfterConsecutiveFailures`, `stagnationRounds` — diversity-gated through the existing similarity machinery so near-duplicates are dropped. This is how we reach the paper's "thousands of replay evaluations per cycle": the DSL's bounded vocabulary makes systematic coverage *possible without an LLM*.

**1.3 Refine mode.** `dreamrsi_dream({ refine: { baseVersion, focus: 'explore' | 'exploit' | 'repair' } })` — perturb around a named base version with a focus bias, instead of always the incumbent.

**1.4 Trajectory-level reports.** Per candidate, per world: a compact step digest (batch compositions, reveal ids, per-step term values, stop reason) — capped at the first 20 steps per world so reports stay model-readable. This gives the host agent what the paper's Listing 2 policy-development agent sees.

## Feature 2 — DSL v2 (expressiveness, still declarative)

**2.1 `strategies[]`.** Named direction descriptors `{ id, mechanism, tags, prior }` with weights: a policy can *inject novel directions* ("open a branch targeting mechanism X") even when X has no recorded nodes. Off-manifold strategies flow to the estimator path (RCO, or judgment when Feature 3 is on) instead of silently zeroing out.

**2.2 `branchBudgets`.** Per-branch decision-round allocation — campaign 2's winning policy wanted exactly this ("deep chains on the champion, starve the rest").

**2.3 Conditional rules.** An enumerable `condition → action` list (`onStagnation: 'shake' | 'prune' | 'reopen'`, `onNewBest: 'exploit' | 'continue'`). Still declarative, validated, deterministic.

**2.4 Explicit non-goal for v0.2:** script policies. Sandboxed arbitrary code is a v0.3 decision (sandbox surface, security review); declarative coverage comes first.

## Feature 3 — Judgment mode (LLM-judged RCO)

Reliability engineering for the load-bearing estimator — *not* paper fidelity (the paper's replay is strictly on-manifold; RCO is our extension).

**3.1 Modes.** `dreamJudge: 'off' | 'agent-relay' | 'host-llm'` (default `off`).

**3.2 Trigger discipline.** Judge only when: RCO confidence < medium **and** `sMax < similarityFloor` (genuinely off-manifold) **and** the decision point is top-M by replay impact **and** the per-run budget (`dreamJudgeMaxCalls`) has headroom **and** the judgment cache misses.

**3.3 Anti-hallucination.** Anchored prompt (decision context + action descriptor + K similar recorded outcomes with their scores + the context's score scale); conservative instruction; **hard cap: a judged score may not exceed the max recorded outcome in that context**; `medium`+ confidence enters the Eq. 1 quality term, `low` falls back to the abstention prior; `judgedFraction` logged beside `estOutcomeFraction`.

**3.4 Cache + calibration.** Judgments persist to `.dreamrsi/judgments.jsonl`, keyed by context+action hash. Online rounds grade the judge for free (predicted vs. realized on redeployed actions); drift auto-falls the mode back to RCO. Determinism: same inputs + same cache state → same report; the cache is store-versioned and auditable.

**3.5 New tools.** `dreamrsi_judgment_submit` + `dreamrsi_judgment_list` (the `agent-relay` two-phase flow: dream returns `judgmentRequests[]`, the agent submits verdicts, subsequent dreams consume the cache). `host-llm` mode resolves the harness `llm` service via `ctx.get('llm')`, fail-soft to RCO.

## Feature 4 — Distilled memory (context-wipe insurance)

**4.1 `historyDigest` v2.** Adds per-mechanism score stats, failClass distribution, stagnation diagnostics, and (when Feature 3 is on) judgment calibration summary — handed to every fresh agent on `begin_round`.

**4.2 Note-discipline warning.** `dreamrsi_log_decision` warns when `notes` are thin, mirroring the workspace-fallback warning — the notes/tags fields are the persistence layer for *why*, and thin notes are how lessons die at context wipes.

---

## Compatibility, risks, mitigations

| Risk | Mitigation |
|---|---|
| Pool generator dilutes selection with near-duplicates | Diversity gate reuses the existing similarity machinery; min-distance threshold config-exposed |
| Auto-dream cadence burns cycles | `on-stagnation` default-off; stagnation window config; dreams are deterministic + cached, so re-runs are cheap |
| DSL v2 grows validation surface | Fence tests extended to every new field; invalid combinations rejected at validation time (proven pattern) |
| Judgment optimism flips a selection | Context-max cap + strict-win margin + `judgedFraction` visibility + calibration auto-fallback |
| Byte-determinism regression | Hard invariant: with all new features at defaults, dream outputs are identical to v0.1.1 — pinned by test |

## Test plan highlights

- Byte-determinism: v0.2 defaults vs v0.1.1 outputs on the live circle-packing store fixtures
- Pool generator: coverage + diversity-gate assertions; replay determinism across pool sizes
- Auto-dream: stagnation trigger fires exactly once per condition; `off` never fires
- DSL v2: per-field validation fences; `strategies[]` → estimator path integration
- Judgment: cache round-trip, budget enforcement, context-max cap, relay two-phase flow, calibration query, `off`-mode identity

## Live validation bench

The circle-packing store (8–10 worlds by then) contains a **known novel action with a known true online outcome** (corrected-gradient L-BFGS-B on centers, realized 0.9857). Before enabling `host-llm` anywhere, we measure: does agent-judged dreaming *predict* that outcome? Calibration report first, enablement second.

## Implementation split

- **F1 + F4** (engine-side): auto-dream triggers, pool generator, trajectory reports, digest v2 — one engineer
- **F2** (DSL v2): types, validation fence, interpreter extensions — same or second engineer
- **F3** (judgment): store cache, tools, relay flow, host-llm probe — after the F1 cache lands (shared `judgments.jsonl`)
- **QA**: byte-determinism fence first, then per-feature fences; live-store calibration report as the acceptance gate for F3 enablement
