# Dream-RSI — Implementation Spec for a DSH Plugin

**Status:** Implementation-grade spec distilled from the paper *"Dream-RSI: Recursive Self-Improvement through Evolving Worlds"* (from the paper's arXiv LaTeXML HTML edition).
**Audience:** An engineer who has **not** read the paper. Everything needed to implement the Dream-RSI exploration plugin for DSH is in this document.
**Scope of this spec:** concept model, data model, loop semantics, the replay objective (formal + a deterministic LLM-free estimator), policy generation/selection, the model-facing tool surface, metrics/logging, verbatim paper prompts, and honest simplifications vs. the paper.

---

## 0. Orientation: what Dream-RSI is, in one page

Dream-RSI addresses a specific failure mode of long-running autonomous discovery (an agent iterating propose → evaluate → refine for hours or thousands of cycles): **the strategy that orchestrates the exploration is usually fixed**, even though the agent accumulates a rich history of what worked and what failed. Improving the *orchestration strategy* ("exploration policy") online is hard because feedback at that meta level is **delayed** (you only see a policy's quality after a full rollout) and **expensive** (trying a bad policy wastes a whole rollout).

The paper's key insight: the discovery history the agent already produced — a tree of attempts, each with its observed outcome — can be repurposed as a **replay simulator** ("world"). An alternative exploration policy can be *replayed* against this recorded tree: at each decision point it chooses which recorded branches to open/refine/batch/stop, and the simulator *reveals the already-recorded outcomes* instead of executing anything. Evaluating one candidate policy over the whole history costs only tree reads — effectively zero execution cost. The paper reports "thousands of rapid, zero-execution-cost off-policy evaluations" from a single online run.

The resulting **recursive self-improvement (RSI) loop** alternates:

1. **Online Explore** — the current policy guides a coding agent that expands a discovery tree and logs traces.
2. **Construct Replay Simulator** — the finished tree becomes one more replay world in a pool.
3. **Dreaming-based Policy Improvement** — candidate policies are generated and replay-scored against the whole simulator pool; the best (never worse than the incumbent) is redeployed online. Go to 1.

### Glossary (paper terms → plugin terms)

| Paper term | Meaning | Plugin artifact |
|---|---|---|
| Discovery tree `𝒯` | Tree of attempts; root = initial workspace; each non-root node = one generation–evaluation attempt refining its parent's workspace | `.dreamrsi/trees/<roundId>/*.json` node records |
| Exploration policy `π` | Executable logic that decides, at each decision round, *which nodes to continue from, in what parallel batch, and when to stop* | Versioned **policy object** (structured JSON DSL interpreted by the plugin; see §6.1) |
| Discovery agent | The fixed coding agent that produces a candidate solution in a workspace | The DSH session model itself (outside the plugin) |
| Evaluator | Fixed scorer of candidate artifacts, produces score `s_v` (higher = better) | Whatever scoring the host task provides; recorded on nodes as `outcome.score` |
| Decision round | One policy decision: select a batch `C` of ≤ W selectable nodes; each executes in parallel, producing one child per selected node | One `dreamrsi_log_decision` batch online; one interpreter step in replay |
| Replay world | One recorded tree used as a simulator | A finished round's tree |
| Dreaming | Offline evaluation of many candidate policies over the replay worlds | `dreamrsi_dream` |
| History `ℋ_t = (𝒯_1 … 𝒯_t)` | Accumulated trees across outer iterations t | All trees in the data dir |
| W | Number of parallel workers (batch size cap) | Policy DSL field `W` / round config |
| K₁ / K₂ | Max decision rounds online / per replay episode | Config `maxOnlineRounds` / `maxReplayRounds` |

### A crucial structural fact about the discovery tree

Every non-root node has exactly **one primary parent** and produces **at most one child** (its next refinement). Therefore the recorded tree is: a single **root** with many children (**branch starts**), and each branch is a **linear chain** of refinement attempts. The policy's decisions are correspondingly simple: *open a new root (new branch)*, *refine the current frontier (deepest revealed node) of an opened branch*, *batch several of those together (≤ W)*, or *stop*. The paper's replay transition (`Child`, §3) formalizes exactly this.

---

## 1. Concept map of the RSI loop

```
                    ┌──────────────────────────────────────────────────────────┐
                    │                     (outer iteration t)                  │
                    │                                                          │
                    │   ┌──────────────────────── ONLINE PHASE ────────────┐   │
                    │   │  ① Online Explore                                │   │
                    │   │     active policy π_t guides the discovery agent │   │
                    │   │     for ≤ K₁ decision rounds                     │   │
                    │   │     each round: pick batch C (|C| ≤ W) of        │   │
                    │   │       selectable nodes {root} ∪ {leaves}         │   │
                    │   │     each node → one worker → one child attempt   │   │
                    │   │     log every (state, action, outcome) node      │   │
                    │   └───────────────────────┬──────────────────────────┘   │
                    │                           │ finished tree 𝒯_t            │
                    │   ┌───────────────────────▼──────────────────────────┐   │
                    │   │  ② Construct Replay Simulator                    │   │
                    │   │     𝒯_t indexed into the simulator pool ℋ_t      │   │
                    │   │     decision points + recorded state/action/     │   │
                    │   │     outcome tuples become replayable             │   │
                    │   └───────────────────────┬──────────────────────────┘   │
                    │                           │                              │
                    │   ┌───────────────────────▼──────────────────────────┐   │
                    │   │  ③ Dreaming-based Policy Improvement (offline)   │   │
                    │   │     M candidate policies π_t⁰..π_t^{M-1}         │   │
                    │   │     (π_t⁰ = current π_t, generated by the        │   │
                    │   │      calling LLM OUTSIDE the plugin)             │   │
                    │   │     each candidate replayed on every 𝒯_i:        │   │
                    │   │       reveal recorded children, never execute    │   │
                    │   │     replay score  V_i^m  (Eq. 1, §5)             │   │
                    │   │     select π_{t+1} = argmax_m mean_i V_i^m       │   │
                    │   └───────────────────────┬──────────────────────────┘   │
                    │                           │  π_{t+1} (V^{m*} ≥ V⁰, so    │
                    │                           │  never a regression)         │
                    │                           └────► redeploy, t ← t+1 ──────┘
```

Properties that matter for implementation:

- **Only the policy changes.** The discovery agent, evaluator, models, and execution interfaces stay fixed. In our plugin: the plugin never touches the model or the task; it only stores, simulates, scores, and versions policies.
- **Same decision interface online and offline.** The policy always observes a tree (initially just the root), and its action is always a batch of ≤ W selectable nodes. Online, executing a batch *generates* children; offline (replay), executing a batch *reveals* recorded children.
- **Offline evaluation is strictly read-only** with respect to history: "no outcomes beyond 𝒯_i are generated" and "each branch is traversed in its recorded parent–child order."

---

## 2. Data model

All state lives under a configurable data directory, default `.dreamrsi/` relative to the workspace. Layout:

```
.dreamrsi/
  config.json                 # plugin config: coefficients, limits, paths
  trees/
    r0001/nodes.jsonl         # one JSON object per node (append-only)
    r0001/round.json          # round record (status, policy version used, stats)
    ...
  policies/
    policy-index.json         # list of policy versions + active pointer
    v0001.json ... v00NN.json # immutable policy objects (DSL payloads)
  dreams/
    d0001.json                # one dreaming run: candidates, per-world scores, selection
  events.jsonl                # global append-only audit log (every mutation)
```

### 2.1 Discovery-tree node schema (`NodeRecord`)

Stored one JSON object per line in `trees/<roundId>/nodes.jsonl`. This is the (state, action, outcome) tuple plus lineage.

```ts
interface NodeRecord {
  id: string;                 // unique within the store, e.g. "r0001-n003"
  roundId: string;            // outer iteration id this node belongs to, e.g. "r0001"
  parentId: string | null;    // null only for the root; every other node has exactly one
  kind: "root" | "attempt";   // root = workspace start (no attempt of its own)

  // --- state / context: what the policy & agent observed BEFORE this attempt ---
  state: {
    depth: number;            // 0 for root; depth = parent.depth + 1 otherwise
    branchId: number;         // root = -1; first child of root opens branch b; children keep b
    seqInBranch: number;      // 0 for a branch start; increments along the chain
    workspaceSummary: string; // short description of inherited workspace state
    inheritedContextNote: string;   // what the agent was told going in (guidance, hints)
    siblingCountAtDecision: number; // how many selectable nodes existed when this was chosen
  };

  // --- action: what was attempted ---
  action: {
    summary: string;          // one-line description of the attempt/proposal
    mechanism: string;        // short mechanism label, e.g. "coordinate-descent", "cuda-shared-mem"
    tags: string[];           // free-form mechanism tags (used by similarity)
    artifactPaths: string[];  // references to generated artifacts (proposal.md, solver files)
    evalProgramPath?: string; // path to the evaluated program, if applicable
  };

  // --- outcome: what the evaluator observed AFTER this attempt ---
  outcome: {
    score: number;            // s_v; task-scoring protocol, larger = better; 0 on hard failure
    evaluated: boolean;       // did an evaluation actually run?
    valid: boolean;           // did the artifact pass correctness checks?
    failClass: "ok" | "compile" | "runtime" | "correctness" | "timeout" | "resource" | "other";
    error: string | null;     // error text when failed
    deltaVsBaseline: number | null;  // score − best baseline score at that time
    deltaVsParent: number | null;    // score − parent's score (refinement gain/loss)
  };

  // --- cost / metrics ---
  metrics: {
    agentCalls: number;       // discovery-agent calls consumed by this node (usually 1)
    wallMs: number | null;    // evaluation wall time if known
  };

  notes: string;              // free text from the logging agent

  // --- lineage / bookkeeping ---
  lineage: {
    createdAt: string;        // ISO-8601 UTC
    evaluatedAt: string | null;
    policyVersion: string;    // policy version active when this node was created
    seq: number;              // global creation sequence within the round (tie-breaker for
                              // "earliest-created child of root" in replay)
  };
}
```

**Invariants** (enforced by the store; violations are hard errors):

1. Exactly one root per tree (`kind: "root"`, `parentId: null`).
2. Every non-root node's `parentId` references an existing node in the same tree.
3. A non-root node has **at most one child** (chains); the root may have many children.
4. Nodes are **immutable once written**; corrections happen by appending a new node or an event, never by editing history (history is the simulator — mutating it corrupts replay).
5. `seq` ordering defines "earliest-created child of root" (needed by replay's `Child` rule for the root).

### 2.2 Round record (`RoundRecord`) — `trees/<roundId>/round.json`

```ts
interface RoundRecord {
  roundId: string;            // "r0001"
  status: "open" | "closed";  // closed after dreamrsi_end_round
  policyVersion: string;      // policy that guided this round
  startedAt: string; endedAt: string | null;
  limits: { maxRounds: number; maxParallelism: number };   // K₁ and W for this round
  stats: {
    nodes: number;            // total nodes incl. root
    attempts: number;         // non-root nodes = discovery-agent calls
    bestScore: number | null; // max s_v in this tree
    decisionRounds: number;   // how many batches the policy actually took
    batchSizes: number[];     // size of each batch in order
    composition: { exploitation: number; exploration: number; recovery: number };
  };
}
```

### 2.3 Policy record (`PolicyRecord`) — `policies/v00NN.json` + index

Policies are **immutable, versioned objects**. See §6.1 for the DSL payload.

```ts
interface PolicyRecord {
  version: string;            // "v0007"
  createdAt: string;
  status: "candidate" | "active" | "retired" | "rejected";
  parentId: string | null;    // policy lineage: which prior version it was derived from
  params: PolicyDsl;          // the JSON payload (§6.1)
  notes: string;              // the proposing agent's rationale
  evaluation: {               // filled by dreamrsi_dream
    meanReplayScore: number | null;      // V^m = (1/t) Σ_i V_i^m
    perWorldScores: { worldId: string; score: number }[] | null;
    betaSweep: { beta: number; reward: number }[] | null;  // optional sweep (§5.3)
  };
}
```

The active policy pointer is a single mutable field in `policy-index.json`; policy payloads are never modified in place.

---

## 3. Online rollout loop semantics (what one round looks like)

One **outer iteration** `t` = one round = one discovery tree. Pseudocode with the tool-call boundaries annotated:

```
ONLINE ROLLOUT (round t):
  agent → dreamrsi_begin_round {}
      plugin: creates round r00XX (status open), loads active policy π_t (version v),
              returns { roundId, policyVersion, policy summary/params, history digest,
                        limits { maxRounds K₁, maxParallelism W } }

  loop k = 1 .. K₁:
      agent (policy π_t logic, running in the model) inspects the current tree
      and selects a batch C ⊆ {root} ∪ {current leaves of the round's tree}, |C| ≤ W
        - selecting root          = open a NEW branch (new attempt with no parent refinement)
        - selecting a leaf v      = refine v (child attempt starts from v's workspace)
        - batching                = schedule |C| parallel workers, one attempt each
      for each selected node v ∈ C (parallel, one worker each):
        discovery agent generates a candidate from v's saved workspace + context
        evaluator scores it → outcome (score s, failClass, …)
      agent → dreamrsi_log_decision { parentId(s), action(s), outcome(s), notes }
      plugin: appends one child NodeRecord per selected node (immutable, seq-ordered);
              returns updated tree digest + current best score

      if C = ∅ (agent decides to stop)  → break
      if no legal nodes remain          → break

  agent → dreamrsi_end_round { roundId, summary }
      plugin: closes round (status closed, stats filled), runs replay-simulator
              construction for the new tree (§4), returns { treeStats, simulatorStats }
```

Semantics to honor, from the paper's §3:

- **Selectable set:** `A(𝒯) = {root} ∪ {v ∈ 𝒯 : v is a leaf}` where leaves are determined from the *currently observed* tree. After a round-k batch, each newly created child becomes the selectable leaf of its extended branch, and the root remains selectable for opening further branches. (Interior nodes are never selectable — refinements always continue from the frontier.)
- **Batch = where + how much parallelism.** Each selected node specifies the starting point of one attempt; the batch determines both what is explored next and how many workers are used. Empty batch ⇒ rollout ends.
- **The transition is stochastic online** (the agent may generate different outcomes from the same starting workspace) but the policy code stays fixed during the rollout.
- **History is context, not the tree.** The new round's tree starts from just the root; the accumulated history ℋ_{t−1} is available to the agent as *context* (via `dreamrsi_history`) but remains separate from the tree being constructed.
- **Budget bookkeeping:** the paper's experiments give each round a fixed per-round budget of discovery-agent calls (e.g., 10 parallel workspaces × 11 refinement steps = 110 calls for their small model; 32 × 20 = 640 for the larger one). Our plugin tracks `metrics.agentCalls` per node and round so equivalent budgets can be enforced by the host.

---

## 4. Replay simulator construction

### 4.1 What a "decision point" is

A **decision point** is the full observable state of the policy at one decision round within one tree: the tuple

```
DecisionPoint := ( treeId, observedSubtree 𝒪 ⊆ 𝒯,  selectable set A(𝒪) = {root} ∪ leaves(𝒪),  W )
```

The simulator's job: given a decision point and a selected batch `C ∈ A(𝒪; W)` (any subset of the selectable set with |C| ≤ W), return the **recorded children** deterministically — this is the paper's replay transition:

```
𝒪' = 𝒪 ∪ ⋃_{v ∈ C} Child(v; 𝒯, 𝒪)

Child(v; 𝒯, 𝒪):
  v ≠ root: the unique recorded child of v in 𝒯, if it exists and is not yet in 𝒪; else ∅
            (since v is a leaf of 𝒪, its recorded child is necessarily unrevealed)
  v = root: the earliest-created (smallest lineage.seq) recorded child of the root
            that is not yet in 𝒪 — i.e., replay opens ONE previously unrevealed branch
  (both cases: ∅ when no recorded continuation remains)
```

Revealed nodes "expose their stored observations" — the policy sees their scores, fail classes, deltas, etc. — before making its next decision.

### 4.2 Where state/action/outcome tuples come from

Each recorded node *is* one tuple, straight from the log (§2.1):

- **state** — the parent's node plus the observed-subtree context at decision time (depth, branch, sibling count, inherited context note);
- **action** — the attempt (mechanism, tags, artifacts);
- **outcome** — the recorded evaluation (score, failClass, error, deltas).

Because non-root nodes form linear chains, replay state is compact: `observedDepth[branch]` per branch + `openedRoots` set + per-branch chain of recorded outcomes. The simulator is therefore a pair of pure functions over an immutable tree index:

```ts
interface ReplaySimulator {
  // Build (or fetch a cached) immutable index of a closed round's tree.
  buildWorld(roundId: string): ReplayWorld;

  // Execute ONE decision: return newly revealed nodes (recorded children) per paper §3.
  step(world: ReplayWorld, batch: NodeId[], maxParallelism: number): { revealed: NodeRecord[] };

  // Termination check: empty batch | round limit K₂ | full tree revealed (𝒪 = 𝒯).
  isExhausted(world: ReplayWorld, observed: ObservedState): boolean;
}
```

**Important nuance for unrecorded actions:** the paper's replay only ever reveals recorded nodes — a policy cannot invent a new kind of attempt inside replay. Our plugin additionally supports *novel actions* (a candidate policy proposes a direction not present in the recorded sibling set, e.g. at a root decision). These get a **similarity-based estimated outcome** (§5.3) rather than a recorded one, clearly flagged as estimated. This is the plugin's main extension beyond the paper and is deliberately conservative.

### 4.3 Decision-point extraction summary

For each closed tree, the set of all decision points reachable in replay is implicit: start at 𝒪 = {root}; every batch choice induces a new 𝒪. There is no need to pre-enumerate them; the simulator computes them on the fly from the immutable index (root children sorted by `lineage.seq`; each non-root node stores its unique child id or null). Building a world is O(N) tree indexing; each step is O(|C|).

---

## 5. The replay objective

### 5.1 Formal statement (paper Eq. 1, verbatim semantics)

Replay of policy version `m` on world (recorded tree) `i` runs at most `K₂` decision rounds and stops at `k_i^{m,★}` completed rounds with final observed subtree `𝒯_i^{m,k★} ⊆ 𝒯_i`. Let `N_i^m = |𝒯_i^{m,k★}| − 1` be the number of revealed non-root nodes — although replay executes nothing, `N_i^m` counts the generation–evaluation requests the trajectory *represents*. For fixed coefficients `β₁, β₂ ≥ 0`:

```
V_i^m  =   max_{v ∈ 𝒯_i^{m,k★}} s_v            (discovery quality)
         − β₁ · N_i^m                          (execution cost penalty)
         + β₂ · N_i^m / max{1, k_i^{m,★}}      (parallelism bonus)
```

- **Quality:** the best solution score attained anywhere in the revealed subtree. Bigger = better.
- **Cost:** each revealed node = one would-be discovery-agent call; penalize per attempt.
- **Parallelism:** rewards attempts-per-decision-round, favoring policies that batch useful continuations instead of running them serially. (A policy that reveals all N nodes in one mega-batch gets the max bonus; a purely serial policy gets β₂·1.)

The **evaluation score of policy version m** is its average replay score across the whole fixed history:

```
V^m = (1/t) · Σ_{i=1..t} V_i^m
```

### 5.2 Implementation notes for Eq. 1

- `max score` is over **all revealed nodes** (not just best-at-stop), which is what the formula says — a policy that peeks at a branch, sees a great recorded score, and stops still banks that quality.
- Default coefficients (configurable): `β₁ = 0.01`, `β₂ = 0.05` with scores normalized to [0, 1] first (see §8.4 normalization). Rationale: quality dominates; cost is a mild per-attempt tax; parallelism is a smaller shaping term. Make them config fields `beta1`, `beta2`.
- Termination: empty batch, `k = K₂`, or `𝒪 = 𝒯` (full tree revealed). `K₂` default: ≥ the tree's maximum chain depth + number of root children + slack (config `maxReplayRounds`, default 64).

### 5.3 Deterministic off-policy outcome estimation for novel actions (no LLM in the plugin)

The paper's replay is **exact** for actions that correspond to recorded continuations. Our plugin must additionally score candidate policies that make decisions not exactly present in history (different branching choices, new directions). We use a deterministic, pure heuristic — **RCO (Recorded-Outcome Comparator)** — no model calls, no randomness:

**Inputs.** A decision context `c` (world id, observed subtree, the parent node `p` the action extends, the selectable set) and a candidate action `a` (mechanism label, tags, summary text from the policy DSL).

**Step 1 — Candidate reference set.** From the immutable world index, collect recorded attempts that are *decision-analogous* to `a`:

- `R_parent`: recorded children of the same parent `p` (siblings) — strongest analogues;
- `R_depth`: recorded attempts at the same `depth` and `seqInBranch` position in **other** branches of the same world;
- `R_cross`: recorded attempts in **other worlds** (other rounds' trees) at matching depth, when `R_parent ∪ R_depth` has fewer than `minAnalogues = 3` members.

**Step 2 — Deterministic similarity.** For each recorded analogue `r`, compute

```
sim(a, r) = 0.55 · cosTf(A, R)            # token + char-3-gram TF cosine between a.summary+mechanism
            + 0.25 · jaccard(tags(a), tags(r))
            + 0.20 · structural(a, r)      # see below
```

where `structural(a, r) = 0.5·exp(−|depth_a − depth_r|/2) + 0.3·[same parent] + 0.2·[same failClass-agnostic branch role (root-open vs refine)]`. Text normalization is fixed: lowercase, split on non-alphanumerics, drop a fixed 33-word English stoplist, then bag-of-words ∪ character 3-grams; TF counts are sublinear (`1 + ln tf`); idf is computed over the *world's* recorded action corpus (deterministic given the history). All arithmetic is plain IEEE-754; identical inputs always yield identical outputs.

**Step 3 — Weighted outcome blend.** Take the top `k = 5` analogues by `sim` (ties broken by node id, for determinism). With `w_j = sim_j^γ` (γ = 2) and a floor `sim_j ≥ τ_min = 0.10`:

```
estimatedScore(a | c) = Σ_j w_j · s_{r_j} / Σ_j w_j          (s recorded outcomes)
```

**Step 4 — Novelty penalty and abstention.** Let `s_max = max_j sim_j`.

```
if s_max < τ_hallucination (0.18):
      # the action resembles nothing on record — no evidence to reuse
      estimatedScore := pessimisticPrior(c)            # 25th percentile of all recorded
                                                       # scores in this world (interpolated,
                                                       # deterministic)
      confidence := "none"
else:
      estimatedScore := estimatedScore − λ_novel · (1 − s_max) · scale(c)   # λ_novel = 0.25
      confidence := s_max ≥ 0.45 ? "medium" : "low"
```

`scale(c)` is the world's score spread (max − min of recorded scores, fallback 1.0), so the penalty is on the task's own units. The penalty shrinks the blended score toward pessimism the more novel the action is — implementing "don't reward the policy for inventing directions history can't vouch for."

**Step 5 — Batch-level diversity adjustment.** For a batch `C` selected at one decision point, penalize mutual near-duplication (a parallel batch of near-identical probes wastes parallelism, which Eq. 1's bonus would otherwise reward):

```
diversity(C) = 1 − ( Σ_{a≠a' ∈ C} sim(a,a') ) / ( |C|·(|C|−1)/2 )      (0..1)
effectiveBatchBonus = β₂ · |C| · diversity(C)^0.5 / max{1, k}            replaces the
                                                                        parallelism term
```

Duplicate probes (sim = 1) contribute nothing to the bonus; genuinely independent probes get full credit.

**Estimated vs. recorded bookkeeping.** Every revealed node produced by estimation is returned with `estimated: true` and its confidence, and is **excluded from the quality term** `max_v s_v` unless `confidence = "medium"` — a candidate policy cannot claim discovery quality from hallucinated analogues; it can only avoid the cost/parallelism terms being distorted. (Recorded reveals always count for quality.)

This estimator is intentionally simple, fully testable, and monotone: `dreamrsi_dream` on identical inputs (same worlds, same candidate DSLs, same config) returns byte-identical reports.

### 5.4 What the estimator is and is not

- It **is** the plugin-side approximation of "simulate the environment" for actions off the recorded manifold — the analog of a world model's imagined transition.
- It is **not** a substitute for online execution: estimated outcomes never enter the discovery history, never change a tree, and never influence node records. Only real online rounds write history.

---

## 6. Policy improvement & selection

### 6.1 Policy representation: a structured DSL (key simplification)

The paper's exploration policy is **arbitrary executable Python** (an `OptimalPolicy.solve(question, budget)` class; see Appendix B, Listing 2). Arbitrary code cannot be safely replayed inside a deterministic plugin without an interpreter sandbox. **We replace policy-as-code with policy-as-data**: a versioned JSON DSL that the plugin's built-in interpreter executes deterministically over the replay simulator (and which the host serializes into model-facing guidance online).

```ts
interface PolicyDsl {
  name: string;                    // e.g. "portfolio-beta-0.6"
  W: number;                       // max parallelism (batch size cap), ≥ 1
  gridPlan: {                      // mirrors the paper's plan_grid(branch_count, refine_count)
    branchCount: number;           // how many root-branches to make available
    refineCount: number;           // refinements allowed per branch chain
    reason: string;                // factual reason string (paper requires one)
  };
  beta: number;                    // the single scalar knob from the paper (0..1):
                                   // high = more width, deeper patience, weaker pruning;
                                   // low = fewer probes, earlier stops, stronger pruning
  portfolio: {                     // batch composition quotas (paper's "dynamic portfolio")
    exploitationShare: number;     // fraction of batch slots for strong normal refinements
    explorationShare: number;      // fraction for new roots / underexplored branches
    recoverySlots: number;         // ≤ 1: at most one repairable-failure recovery per batch
  };
  ranking: {                       // frontier priority scoring weights (deterministic)
    anchorScore: number;           // weight on branch's best successful anchor
    parentChildGain: number;       // weight on recent delta vs parent
    trend: number;                 // weight on score trend slope
    recoverability: number;        // weight on failure recoverability class
    remainingDepth: number;        // weight on remaining refinement budget
    recency: number;               // weight on recency of last improvement
  };
  pruning: {
    repairableClasses: string[];   // failClasses considered repairable
    hardFailClasses: string[];     // failClasses eligible for unconditional closure
    closeAfterConsecutiveFailures: number;
    minEvidenceForClosure: number; // don't close on a single shallow weak score
  };
  stopping: {
    stagnationRounds: number;      // stop branch after N rounds without improvement
    maxRoundsK2: number;           // per-episode decision-round cap
  };
  guidance: string;                // short semantic direction hint for the discovery agent
                                   // (WARNING: §5.1 of the paper found strong directional
                                   // guidance harmful — keep short and weak, or empty)
}
```

The interpreter implements, at each replay decision round: reconstruct branch trajectories from observed nodes → rank legal roots/frontiers by the `ranking` weights → apply `pruning` closures → build a portfolio batch (exploitation/exploration/recovery, ≤ W, never parent+child together, no duplicates) → stop rule. This mirrors the required decision loop in the paper's improvement prompt (§9, Listing 2, "Required batch decision loop").

### 6.2 How K candidates are generated, scored, and selected

The **policy-development agent is the calling LLM**, not the plugin (paper has a fixed "policy-development agent"; we outsource that role to the host session). The plugin's `dreamrsi_dream` orchestrates the offline phase:

```
DREAMING (offline phase of outer iteration t):
  input: candidates π_t⁰ .. π_t^{K−1}   (π_t⁰ MUST be the currently active policy —
                                         the plugin prepends it automatically)
  for m = 0 .. K−1:
      for each world i = 1 .. t (every closed tree in history):
          reset interpreter state; 𝒪 = {root}
          k = 0
          while k < K₂ and 𝒪 ≠ 𝒯_i:
              C = interpret(π_t^m, 𝒪, W)          # pure, deterministic (§6.1)
              if C = ∅: break
              𝒪 = 𝒪 ∪ ⋃_{v ∈ C} Child(v; 𝒯_i, 𝒪)   # recorded reveals (§4.1)
                                                   # (+ estimated outcomes for novel
                                                   #    actions, per §5.3)
              k += 1
          V_i^m = maxScore(𝒪) − β₁·N_i^m + β₂·parallelTerm   # Eq. 1 + §5.3 step 5
      V^m = mean_i V_i^m
  m★ = argmax_m V^m          # ties → lowest version index (earliest candidate wins)
  selected: π_t^{m★}, guaranteed V^{m★} ≥ V⁰ because π_t⁰ = current policy is in the set
  output: ranked report { candidates[{version, V^m, per-world breakdown, diagnostics}],
                          selectedVersion, guardChecks }
```

**Pseudocode (dreaming loop, plugin-side):**

```
function dream(candidates[], worlds[], cfg):
    # worlds = all closed trees; candidates[0] forced = active policy
    for m, π in enumerate(candidates):
        validateDsl(π)                          # schema + invariants (W ≥ 1, quotas sum ≤ 1, …)
        for i, T in enumerate(worlds):
            obs   := initObserved(T)            # {root}
            k     := 0
            best  := −∞ ; N := 0 ; bonusNum := 0
            while k < cfg.K2 and not fullyRevealed(obs, T):
                C := interpret(π, obs, T)       # deterministic policy interpreter
                if C = ∅: break
                if hasParentAndChildTogether(C) or hasDuplicates(C): mark_invalid(π, i, k); break
                for v in C:
                    nodes := child(v, T, obs)   # recorded reveal (§4.1)
                    if nodes = ∅ and isNovelAction(v):
                        nodes := estimate(v, obs, T)   # §5.3, flagged estimated
                    for n in nodes:
                        obs := obs ∪ {n}; N += 1
                        if not n.estimated or n.confidence = "medium":
                            best := max(best, n.outcome.score)
                bonusNum += |C| · diversity(C)^0.5      # §5.3 step 5
                k += 1
            V[i][m] := best − cfg.beta1·N + cfg.beta2 · bonusNum / max(1, k)
            record diagnostics(π, i): rounds=k, reveals=N, batchSizes, estFraction, stopReason
    V[m] := mean_i V[i][m]
    m★ := argmax_m V[m]   (ties → smallest m)
    return { ranked: sort_desc(V), selected: candidates[m★],
             guards: { noRegression: V[m★] ≥ V[0], invalidCandidates: [...] } }
```

### 6.3 Selection criteria and avoid-regression guards

1. **Incumbent always participates.** `dreamrsi_dream` automatically evaluates the currently active policy as candidate 0 (the paper: `π_t⁰ = π_t`), so selection satisfies `V^{m★} ≥ V⁰` **on the fixed history** — the deployed policy is never worse than its predecessor by construction.
2. **Argmax with deterministic tie-breaking:** highest mean replay score; tie → earlier candidate index; if still tied, keep the incumbent.
3. **Validity gate:** a candidate that produced an illegal batch during any replay (duplicate ids, parent+child together, |C| > W, or DSL violation) is scored `−∞` and reported as invalid, never selected.
4. **Degenerate-behavior flags** (reported, and by default also disqualifying when `strictGuards = true`): a policy that never opens more than one branch, never batches (>1 per round throughout), or stops immediately on every world — these mirror failure modes the paper's prompt explicitly guards against (serial batches, premature stops, over-pruning).
5. **Versioning:** selected policy is committed via `dreamrsi_policy_set` as a **new immutable version** whose `parentId` is the incumbent; the old version is marked `retired` (never deleted, never mutated). Every node records the policy version that produced it, so any historical result is attributable.
6. **Scope of the guarantee:** like the paper, "no worse" holds *on the replay history* — it is off-policy, not a live guarantee. The online round still generates fresh (stochastic) outcomes.

### 6.4 Optional beta sweep

The paper's evaluator sweeps the policy's single `beta` knob and ranks by `pareto.reward = pareto.auc − λ·parallel_penalty`, and its improvement prompt requires cross-cycle default-beta adaptation (raise on plateau if high beta buys attainment, lower when high beta adds work without attainment, bootstrap ≈ 0.6 when history is insufficient). A plugin-side approximation: `dreamrsi_dream` accepts `sweepBetas?: number[]`; for each candidate it re-scores the **same** candidate at each beta (deterministic re-runs, cheap because replay is pure) and stores the frontier in `evaluation.betaSweep`. The proposing LLM uses this exactly like the paper's rule when writing the next candidate's baked-in `beta`.

---

## 7. Model-facing DSH tool surface

Seven tools, registered by the plugin. Naming keeps the suggested `dreamrsi_` prefix. JSON Schema (abridged, draft-07 style) given for each; all outputs are JSON objects; all calls are local, deterministic (except where the host injects timestamps), and network-free.

### 7.1 `dreamrsi_begin_round`
Starts one online rollout (outer iteration). Returns everything the agent needs to act as the exploration policy.
- **Input:** `{ }` (all parameters come from config)
- **Output:** `{ roundId: string, policyVersion: string, policy: PolicyDsl, limits: { maxRounds, maxParallelism }, historyDigest: { rounds: number, totalNodes: number, bestScoreOverall: number|null, bestMechanisms: string[], knownDeadEnds: string[] } }`
- **Effects:** creates `trees/<roundId>/` + open `RoundRecord`; loads active policy.

### 7.2 `dreamrsi_log_decision`
Logs one decision round: the batch and, for each selected node, the attempt + observed outcome. May be called once per batch (all children together) — preferred — or incrementally per node while a batch is in flight (`batchSeq` groups them).
- **Input:**
```json
{
  "roundId": "string",
  "batchSeq": "integer ≥ 1",
  "decisions": [{
      "parentId": "string | null (null ⇒ child of root: new branch)",
      "action": { "summary": "string", "mechanism": "string", "tags": ["string"],
                  "artifactPaths": ["string"], "evalProgramPath": "string?" },
      "outcome": { "score": "number", "evaluated": "boolean", "valid": "boolean",
                   "failClass": "ok|compile|runtime|correctness|timeout|resource|other",
                   "error": "string?", "deltaVsBaseline": "number?", "deltaVsParent": "number?" },
      "metrics": { "agentCalls": "integer", "wallMs": "number?" },
      "notes": "string?"
  }]
}
```
- **Output:** `{ accepted: NodeRecord["id"][], treeStats: { nodes, bestScore, decisionRounds }, warnings: string[] }` (warnings for e.g. batching parent+child, exceeding W, unknown parentId)
- **Effects:** appends immutable nodes; updates round stats.

### 7.3 `dreamrsi_end_round`
Finalizes the round and builds the replay world for the finished tree.
- **Input:** `{ roundId: string, summary?: string }`
- **Output:** `{ roundStats: RoundRecord["stats"], worldId: string, simulator: { nodes: number, branches: number, maxDepth: number }, activePolicyVersion: string }`
- **Effects:** closes the round; builds + caches the immutable `ReplayWorld` index.

### 7.4 `dreamrsi_history`
Read-only query over accumulated discovery history (the agent's "read the complete history first" workflow, and the context source for the next round).
- **Input:** `{ roundId?: string, nodeId?: string, view?: "tree"|"best-paths"|"failures"|"rounds"|"summary", limit?: integer }`
- **Output (tree view):** `{ rounds: [{ roundId, policyVersion, nodes: [{ id, parentId, depth, branchId, action.summary, mechanism, tags, outcome.score, outcome.failClass, outcome.deltaVsParent }] }] }`
  (best-paths: top-k chains by cumulative score; failures: nodes with `failClass ≠ ok` grouped by mechanism + error digest; rounds: RoundRecords; summary: compact stats digest)
- **Effects:** none (pure read).

### 7.5 `dreamrsi_dream`
Runs the offline dreaming phase: replay-scores candidate policies over the whole simulator pool, applies selection, returns the ranked report. Does **not** change the active policy (that is `dreamrsi_policy_set`'s job).
- **Input:** `{ candidates: PolicyDsl[], sweepBetas?: number[], strictGuards?: boolean }`
- **Output:** `{ runId, selectedVersion, selectedParams: PolicyDsl, ranking: [{ version, meanScore, perWorld: [{ worldId, score, rounds, reveals, stopReason, invalid?: string }], invalid?: string, diagnostics: { batchSizes, estOutcomeFraction, neverBatched, singleBranch } }], guards: { noRegression: boolean, incumbentScore: number }, historySize: number }`
- **Effects:** writes `dreams/<runId>.json`; nothing else.

### 7.6 `dreamrsi_policy_get`
- **Input:** `{ version?: string }` (omit ⇒ active policy)
- **Output:** `{ activeVersion: string, policy: PolicyRecord, history: [{ version, status, meanReplayScore, createdAt, notes }] }`
- **Effects:** none.

### 7.7 `dreamrsi_policy_set`
Commits a policy version as active for the next online round. Rejects regression unless explicitly overridden.
- **Input:** `{ version: string, force?: boolean }` (a version created by a prior `dreamrsi_dream`+ registration, or a raw `PolicyDsl` via `{ policy: PolicyDsl, notes }` variant which registers the version first)
- **Output:** `{ activeVersion: string, previousVersion: string, guardCheck: { meanReplayScore, incumbentScore, noRegression, forced } }`
- **Effects:** flips the active pointer in `policy-index.json`; marks old version `retired`. If `meanReplayScore < incumbentScore` and `force ≠ true`, rejects with the guard report.

**Mapping check (acceptance criterion):** these seven tools map 1:1 onto the loop — ① `begin_round`/`log_decision`/`end_round` are the online rollout; ② world construction is inside `end_round`; ③ `dream`/`policy_get`/`policy_set` are the offline improvement + redeploy; `history` serves the paper's "history as context" requirement.

---

## 8. Metrics & logging fields

Mirror what §4 of the paper measures (discovery cost, downstream quality, round-over-round dynamics) plus replay internals.

### 8.1 Per-node (written at `log_decision`)
`agentCalls`, `wallMs`, `score`, `valid`, `failClass`, `deltaVsBaseline`, `deltaVsParent`, `policyVersion`, `depth`, `branchId`.

### 8.2 Per-round (written at `end_round`)
`attempts` (nodes−1 = discovery-agent calls this round), `bestScore` (round best — the paper's "round-best performance", Fig. 6a), `decisionRounds`, `batchSizes[]`, `composition { exploitation, exploration, recovery }`, `avgBatchSize = attempts / max(1, decisionRounds)` (the paper's parallelism statistic), `policyVersion`.

### 8.3 Cumulative (queryable via `dreamrsi_history { view: "summary" }`)
`cumulativeAgentCalls` per round index (the x-axis of Figs. 3b/4), `bestScoreOverall` per round (y-axis), `explorationEffort[]` = evaluated attempts per round (Fig. 6b), distinct `mechanism` histogram (diversity), repair-recovery counts.

### 8.4 Per-dream (written by `dreamrsi_dream`)
Per candidate × world: `score V_i^m`, `reveals N_i^m`, `rounds k_i^{m,★}`, `stopReason` (empty-batch | K₂ | exhausted | invalid), `qualityTerm`, `costTerm`, `parallelismTerm`, `estOutcomeFraction` (share of revealed nodes that were estimated), batch-size histogram, `invalid` reason if any. Per candidate: `meanScore V^m`, optional `betaSweep`. Score **normalization**: all scores are min–max normalized against the union of recorded scores in the scored worlds before Eq. 1 is applied (config flag; default on) so β₁/β₂ keep consistent units across tasks.

### 8.5 Audit log
`events.jsonl` records every mutating call with `{ ts, call, args-digest, result-digest, policyVersion }` — enough to reproduce any state from a fresh data dir by replaying events (the store may also be rebuilt from `nodes.jsonl` alone).

---

## 9. Appendix B prompts — VERBATIM

Reproduced byte-exact from the paper's Listing 1 and Listing 2 (decoded from the HTML's embedded base64 payloads). "Variables enclosed by dollar signs or braces are instantiated by the runtime system before execution" (paper, Appendix B preamble).

### B.1 Exploration Prompt (Listing 1: "Prompt used for online exploration.")

```
You must read every historical proposal before proposing or implementing a new solution.

$direction_guidance

Variables (`$node_dir`, `$history_dir`, `$baseline_dir`, `$eval_program`, `$problem_file`) are filled in by the calling system. `$node_dir` is your own attempt directory — exclude it when scanning sibling `attempt_*/` dirs.

## 1. Read the complete history first

Before proposing anything, read every `proposal.md` under sibling `attempt_*/` dirs, `$history_dir`, and `$baseline_dir` in full — not a sample, not just recent cycles or the current branch. For each, read its matching `eval/score.json` (and `error.txt` if it failed). Trust the measured result over what the proposal claims about itself.

## 2. Learn from both successes and failures

For every past attempt, note the mechanism and how it did. For failures, figure out *why*: a flawed core idea, or a good idea let down by a bug, bad parameters, or an implementation slip? Don't repeat the former. The latter is worth retrying — but only once you've actually located the bug in the code (not just guessed from the proposal), and only with a specific fix in hand.

## 3. Don't converge into a local optimum

Look at the shape of what's been tried. If most attempts cluster around small variations of one mechanism with flattening returns, that's a local optimum - resist proposing another small tweak there. Deliberately favor a structurally different mechanism or an untried combination over a safer marginal refinement. Exploration diversity matters as much as the next incremental gain.

## 4. Propose and implement

The new idea must be a genuinely new mechanism, a new combination of previously-successful pieces, or a targeted fix to a specific bug found in step 2 - never a repeat or rename of something already tried. Implement it in `$eval_program`. Don't claim it compiles, is correct, or beats SOTA until it's actually evaluated.

## Files

Write only `$node_dir/proposal.md` (mechanism, evidence from history, why it's not a repeat, expected benefit/risk) and `$node_dir/$eval_program`. Everything else is read-only.

## Note:
    Never execute pkill, kill, killall, or terminate unrelated processes.
```

### B.2 Replay-Based Policy Improvement Prompt (Listing 2: "Prompt used for replay-based improvement of the exploration policy.")

```
You are improving one **prefix-only exploration policy**. Edit only
``{method_file}`` and implement ``OptimalPolicy.solve(self, question, budget=None)``.
Do not solve the scientific task and do not edit any other program.

## Objective: quality, work, and parallelism

The environment is a frozen, irregular branch×attempt grid. A policy opens a root
or refines the next cell of an already-open branch. Each revealed cell costs one
probe. The policy sees only the cells it has revealed so far; unrevealed scores are
unknown.

The evaluator sweeps your single ``beta`` knob and ranks the resulting curve by:

    pareto.reward = pareto.auc - lambda * parallel_penalty

``pareto.auc`` rewards reaching high per-trace attainment with few **total probes**.
``parallel_penalty`` is the mean of
``effective_sequential_rounds / total_probes`` over the sweep. For a batch of size
``k`` with ``W = question.max_parallelism`` workers, it costs one decision round and
``ceil(k / W)`` effective sequential rounds. A serial policy has penalty near 1;
useful full batches approach ``1/W``. Therefore choose only promising probes, but
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

``Observation`` supplies ``branch``, ``attempt``, ``score``, ``evaluated``, ``valid``,
``fail_class``, ``error``, ``delta_vs_baseline``, ``delta_vs_parent``, ``n_valid``, and
``n_total``.
Use the helpers in ``see.policy.observation_signal`` when useful:
``branch_promising``, ``branch_failed_hard``, ``probe_improved_vs_parent``, and
``probe_improved_vs_baseline``.

**Success semantics:** an evaluated observation with ``error is None`` and
``fail_class == "ok"`` is a successful evaluation, even when ``valid == False`` or
``n_valid``/``n_total`` are unavailable. Never label it repairable solely because
``valid`` is false. A *successful anchor* below means the best historical score
from such a successful evaluation.

Do **not** use ``question.best_so_far`` or ``question.budget_spent`` to decide what
to explore; they are bookkeeping only. Derive any decision statistic from
``question.observed()`` instead.

## Required branch trajectory and failure interpretation

For each opened branch, reconstruct its ordered prefix trajectory, not only its
latest observation or best score: successful anchor, score trend, regressions,
failure/repair sequence, and explored versus remaining depth.

Before closing or deprioritizing a failed frontier, classify it as
hard-unrecoverable, repairable implementation failure, weak-but-underexplored, or
repeatedly unpromising after sufficient valid evidence. Output/correctness mismatch,
shared-memory/resource limits, and variable/code, mask/layout/shape errors are
normally repairable. Do not infer algorithmic failure from one such error.
``n_valid == 0`` and ``branch_failed_hard(obs)`` are signals, not unconditional
closure: use ``fail_class`` and ``error`` to distinguish a repairable zero-valid
failure from an environment/dependency failure. ``compile_other`` alone is not
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
   ``question.max_parallelism``: exploitation (strong normal refinements),
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

- Keep ``NAME = "OptimalPolicy"`` and implement
  ``class OptimalPolicy(LLMDesignedMethod)`` in ``{method_file}`` only.
- **Prefix-only:** decisions may use revealed observations, ``baseline_score``, legal
  sets, structural ``meta``, and helper signals. Never use unrevealed scores, a true
  optimum, hardcoded winning cell ids, absolute score targets, or internal trace data.
- Every prune, widen, deepen, batch, and stop decision must be explainable from the
  current prefix. Shallow weak scores are not enough to discard a branch: deeper
  attempts can recover. A repairable latest failure must not erase its historical
  successful anchor or by itself cause permanent starvation.
- Replay calls with ``budget=None``. Always terminate when no batch is selected; do
  not assume a budget cap exists.
- A selected batch must be legal, have no duplicate ids, and contain at most
  ``question.max_parallelism`` cells.

## Beta: fixed per run, adaptive across cycles

Read exactly one scalar in ``__init__``:

    beta = float(self.config.get("beta", <sensible_default>))

Beta has three distinct roles. Do not conflate them:

1. **Within one replay or live episode:** beta is fixed. Route every behavioral
   threshold through one ``_schedule(beta) -> dict``. High beta means more width,
   deeper patience, and weaker pruning. Low beta means fewer probes, earlier
   stagnation stops, and stronger pruning. Never change beta from observations inside
   ``solve()``. Route recovery eligibility, reserve threshold, and waiting through
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
**live** ``trace_pool/iter*/live_cycle_manifest.json`` sidecars (and ``_current``
when present) for each iteration's final best score and actual baked-in beta. Read
the matching archived ``beta_sweep.json`` values (``pareto.reward``, AUC, parallel
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
It must always return a non-``None`` ``GridPlan``: do not inherit the template
stub and do not delegate grid choice to the runner's fallback. When history is
empty or insufficient, still return an explicit conservative bootstrap plan
derived from the context's fallback/hard-cap fields, with a factual reason.

``GridPlan(branch_count=W, refine_count=R)`` accepts arbitrary integers, not a
fixed set of presets. It creates branches ``0..W-1`` and attempts ``0..R``; ``R`` is
the number of refinements allowed after each root. The runner validates
``1 <= W <= context.hard_max_branch_count`` and
``0 <= R <= context.hard_max_refine_count``. In replay, a requested plan beyond the
frozen trace's ``context.trace_branch_count`` or ``context.trace_refine_count`` is
out of support and cannot earn replay reward.

Use only the prefix-safe facts in ``context``:

- ``history``: completed earlier live manifests, including prior planned/effective
  grids, actual opened width/depth, probe work, decision rounds, scores, and beta;
- fallback/hard caps and worker cap;
- replay structural support fields. Do not read raw trace outcomes or a current
  cycle result inside ``plan_grid``.

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

Include a short, factual ``reason`` in every plan. ``plan_grid`` answers
how many directions to make available; the direction provider assigns those new
roots their directions, and ``solve`` still decides which legal roots/frontiers to
open, refine, prune, or stop. Do not choose roots merely because their branch id is
small. The runtime grid is the hard bound: controller thresholds may use less, but
can never create branches or attempts beyond the effective plan. Before finishing,
verify that the edited ``method.py`` contains an override of ``plan_grid`` that
returns ``GridPlan(branch_count=..., refine_count=..., reason=...)`` on every path.

## Learn from history without leaking outcomes

Earlier rounds are in ``{history_dir}/r####_*/``. Read their policy code and
``proposal_results/beta_sweep.json``. Start from a strong recent policy, retain
mechanisms that raised ``pareto.reward``, and make a concrete change when progress
stalls. A legacy AUC-only sweep is useful code history but is not numerically
comparable to the current reward. The baseline under ``{history_dir}/baseline/`` is
a parallel-refine floor to beat.

Each current-objective round also archives
``proposal_results/policy_execution_traces.jsonl``: one replay episode per
``(frozen trace, beta)``. Use it to diagnose general behavior — serial batches,
premature stops, over-pruning, or wasted probes — from the prefix state, selected
batch, and revealed outcomes at each decision round. It is **between-round feedback
only**: never read it inside ``solve()``, and never copy a trace-specific branch,
cell id, score, or target into policy logic.

``{trace_pool}``, if present, may be read only outside ``solve()``. Prefer the
``live_cycle_manifest.json`` sidecars over raw replay outcomes for the per-iteration
live trend. Never copy trace scores, targets, or cell ids into policy logic.

## Deliverable

Write a complete adaptive policy in ``{method_file}``. Include a short module
docstring describing its prefix signals, batch rule, beta schedule, default-beta
rationale, grid-planning rule (if implemented), and safeguards against
over-pruning, over-stopping, permanent starvation after repairable failures, and
serial probes. Before finishing, verify trajectory-based ranking, the stated
success semantics, non-automatic zero-valid closure, deterministic recovery
competition, and portfolio-level stop.
```

---

## 10. Evidence base from the paper (what §4 measures, for metrics design)

Numbers the plugin's metrics are designed to reproduce (per §4 of the paper):

- **Algorithm engineering (Lasso regularization path):** 5 recursive rounds; per-round budgets 110 discovery-agent calls (10 workspaces × 11 refinement steps) or 640 (32 × 20). Metrics: average downstream runtime on 6 held-out datasets (lower better) vs. cumulative discovery-agent calls (compute). Baselines: sklearn, glmnet, SimpleTES (51,200 generations), Recursive Fixed Exploration. Dream-RSI (their large model): 2931.0 ms @ 317 calls vs. fixed 3587.1 ms @ 550 calls.
- **Mathematics optimization (Sum–Difference ↑, Autocorrelation ↓, Circle Packing ↑):** 10 rounds; compared against AlphaEvolve/OpenEvolve/ShinkaEvolve/ThetaEvolve/EvoX/SimpleTES etc.; < 1,000 generations used.
- **Kernel engineering (KernelBench: VGG16, LayerNorm, ConvDiv, ConvMax):** performance = inverse runtime (1/ms) with correctness gating; trajectories of performance vs. number of generations; 2.43×/1.79× compute reductions at equal performance, 2.09×/1.44× score gains at equal budget.
- **Further analysis:** (i) explicit prompt-level directional guidance *underperforms* unguided exploration (Fig. 5) — hence the spec's warning to keep `PolicyDsl.guidance` short/weak/empty; (ii) the learned policy adaptively conserves compute when improving (110 → 50 attempts) and re-increases effort at plateaus (Fig. 6) — the `stopping.stagnationRounds` + beta-schedule fields exist to let that behavior emerge.

---

## 11. Simplifications & risks vs. the paper

| # | Paper | Our plugin | Consequence / mitigation |
|---|---|---|---|
| 1 | Exploration policy is **arbitrary executable Python** developed by a fixed LLM policy-development agent (`OptimalPolicy.solve`, Listing 2) | Policy is a **versioned JSON DSL** interpreted by a deterministic plugin-side interpreter (§6.1); the *calling agent* plays the policy-development role | Big expressiveness loss; guarantees determinism, safety, and testability. Mitigation: keep DSL fields close to the prompt's required mechanisms (portfolio, beta, grid plan, pruning, stopping); iterate on DSL fields as experience accumulates |
| 2 | Policy-development agent reads replay trajectories + feedback between revisions (LLM in the offline loop) | **No LLM inside the plugin.** `dreamrsi_dream` returns a structured ranked report; the host LLM reads it and proposes the next K candidates | The plugin cannot self-improve without the host agent driving it. Mitigation: make the dream report rich (per-world diagnostics, failure classes, stop reasons) so the proposing LLM has everything Listing 2's agent would see |
| 3 | Replay reveals **recorded outcomes only** (strictly on-manifold) | Same for recorded actions, **plus** a similarity-based estimator (§5.3) for novel actions, excluded from the quality term unless high-confidence | Off-manifold estimates are biased; mitigated by novelty penalty, pessimistic abstention prior, and bookkeeping (`estOutcomeFraction`) |
| 4 | Evaluator is a fixed external scorer with real execution | Plugin trusts agent-reported `outcome.score/failClass` | Score noise/hacks propagate into selection. Mitigation: record deltas, validity, failClass; treat unevaluated nodes as score 0; host is responsible for honest evaluation |
| 5 | Each node stores a full **filesystem snapshot** of the workspace | We store **references + summaries** (artifact paths, workspace summary), not snapshots | Replay cannot re-execute anything anyway (by design), so only summaries are needed for decisions; but "resume from workspace" fidelity online depends on the host actually keeping workspaces |
| 6 | Paper's replay rewards include `pareto.auc` over a **beta sweep**; deployment uses a baked-in default beta | Optional deterministic `sweepBetas` re-scoring (§6.4); single-beta scoring by default | Without sweeps, β-sensitivity of a candidate is invisible. Mitigation: encourage sweep on plateau; default-beta rule from Listing 2 is the proposing LLM's responsibility |
| 7 | Coefficients β₁, β₂ unspecified in the paper | Defaults `β₁ = 0.01`, `β₂ = 0.05` on min–max-normalized scores (§5.2) | Arbitrary; wrong scale could dominate quality. Mitigation: config-exposed, normalization on by default, logged per-term so tuning is data-driven |
| 8 | Paper runs one tree per task per round, thousands of replay evaluations | Same structure, but scale bounded by local history size; K₂ default 64 | Fine at plugin scale; watch O(t·K·N) growth — world indexing is cached and steps are O(|C|) |
| 9 | Online transition is stochastic; history grows across rounds | Identical, but nothing in the plugin enforces *budget* equivalence across rounds (the paper pins per-round compute) | Host must enforce per-round budgets via `limits` + `metrics.agentCalls`; plugin only measures |
| 10 | The paper's prompt history includes failure-taxonomy conventions (repairable vs. hard) | DSL carries `repairableClasses`/`hardFailClasses` defaults derived from Listing 2 | Misclassified closures starve recoverable branches. Mitigation: "a later successful result reopens the branch" rule is built into the interpreter; defaults favor repairability |

**Non-goals:** no live LLM calls, no network, no task execution, no weights/fine-tuning (the paper likewise never fine-tunes weights — improvement is entirely at the policy-code level).

---

## Appendix: paper ↔ plugin traceability

| Spec section | Paper source |
|---|---|
| §0 orientation, glossary | §1 Introduction, Fig. 1/2 captions |
| §1 concept map | §1, §3 overview; Fig. 1 |
| §2 data model | §3 "Discovery trees and the shared decision interface"; Appendix B file conventions |
| §3 online rollout | §3 "Online rollout" |
| §4 replay simulator + `Child` rules | §3 "Offline evaluation" |
| §5 replay objective Eq. 1 | §3 "Replay objective" |
| §5.3 estimator | Plugin extension (paper analog: world-model imagination; Listing 2's prefix-derived signals) |
| §6 improvement & selection | §3 "Policy improvement and selection"; Appendix B Listing 2 |
| §6.4 beta sweep | Appendix B Listing 2 "Beta: fixed per run, adaptive across cycles" |
| §7 tool surface | Plugin design (maps 1:1 onto the loop stages) |
| §8 metrics | §4 Experiments (all subsections); §5.2 Fig. 6 |
| §9 prompts | Appendix B, Listings 1–2 (verbatim, base64-decoded) |
| §11 risks | §5.1 (guidance harm), §4 (budgets), plus plugin-specific gaps |
