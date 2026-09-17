/**
 * Built-in v0.2 bootstrap CODE policy and the subprocess runner.
 *
 * `BOOTSTRAP_POLICY_SOURCE` ports the v0.1 `bootstrap-balanced` DSL semantics
 * (W=4, grid 3 branches × 3 refinements, beta 0.6, portfolio 0.5/0.5 + 1
 * recovery slot, stagnation stop 4 / K₂ 64, defaults favoring repairability)
 * onto the paper's `solve(view)` decision contract (ROADMAP-v0.2 F1). Fresh
 * stores under `policyEngine: 'code'` write it as `policies/v0001.py`.
 *
 * `PYTHON_RUNNER_SOURCE` is the engine-side driver written to
 * `policies/.runner.py`: it loads a policy module, reads one JSON view per
 * stdin line, answers one JSON decision per stdout line, and reports a
 * per-decision failure as an error line instead of dying silently (the
 * engine classifies any response it cannot parse as an invalid episode).
 *
 * Both run under `python -I` (isolated mode) with stdlib only.
 *
 * @module
 */

export const PYTHON_RUNNER_SOURCE = `"""Dream-RSI policy runner: JSON-lines stdin/stdout bridge for one policy module.

Usage: python -I .runner.py <policy-path>
Reads one JSON view per stdin line, calls the policy's solve(view), and writes
one JSON decision per stdout line (flushed). A solve() failure is reported as
{"__error": ...} so the engine can classify the episode instead of hanging.
"""
import importlib.util
import json
import sys


def _load(policy_path):
    spec = importlib.util.spec_from_file_location("dreamrsi_policy", policy_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main():
    if len(sys.argv) < 2:
        sys.stderr.write("runner: missing policy path\\n")
        return 2
    try:
        module = _load(sys.argv[1])
    except Exception as error:  # noqa: BLE001 - reported to the engine, never hidden
        sys.stderr.write("runner: policy load failed: %r\\n" % (error,))
        return 2
    solve = getattr(module, "solve", None)
    if not callable(solve):
        sys.stderr.write("runner: policy module exposes no callable solve(view)\\n")
        return 2
    while True:
        line = sys.stdin.readline()
        if not line:
            return 0
        line = line.strip()
        if not line:
            continue
        try:
            view = json.loads(line)
        except ValueError as error:
            sys.stderr.write("runner: malformed view line: %r\\n" % (error,))
            continue
        try:
            decision = solve(view)
            sys.stdout.write(json.dumps(decision) + "\\n")
        except Exception as error:  # noqa: BLE001 - surfaced to the engine
            sys.stdout.write(json.dumps({"__error": repr(error)}) + "\\n")
        sys.stdout.flush()


if __name__ == "__main__":
    sys.exit(main())
`

export const BOOTSTRAP_POLICY_SOURCE = `"""Dream-RSI bootstrap-balanced code policy (v0.2 paper-faithful port).

Deterministic port of the v0.1 bootstrap-balanced DSL (W=4, grid 3x3,
beta 0.6, portfolio 0.5/0.5 + 1 recovery, stagnation stop 4, K2 64):
rank legal roots and branch frontiers from the prefix, close branches only on
cumulative evidence (a later success reopens), and compose a portfolio batch
that never selects a parent together with its child.
"""

BETA = 0.6
GRID_BRANCHES = 3
GRID_REFINE = 3
PORTFOLIO = {"exploitation": 0.5, "exploration": 0.5, "recovery": 1}
RANKING = {"anchor": 1.0, "gain": 1.0, "trend": 1.0, "recover": 1.0, "remaining": 1.0, "recency": 0.5}
REPAIRABLE = ("compile", "runtime", "correctness", "resource")
HARD = ()
CLOSE_AFTER = 3
MIN_EVIDENCE = 2
STAGNATION = 4


def _squash(x):
    if x <= -30.0:
        return 0.0
    if x >= 30.0:
        return 1.0
    return 1.0 / (1.0 + pow(2.718281828459045, -2.0 * x))


def _schedule(beta):
    patience = 0.5 + min(1.0, max(0.0, beta))
    return max(1, round(CLOSE_AFTER * patience)), max(1, round(STAGNATION * patience))


def _branches(view):
    """Reconstruct the revealed branch chains from the selectable prefix."""
    by_branch = {}
    root = None
    for node in view["selectable"]:
        if node["kind"] == "root":
            root = node
            continue
        by_branch.setdefault(node["branchId"], []).append(node)
    chains = []
    for branch_id, nodes in sorted(by_branch.items()):
        nodes = sorted(nodes, key=lambda n: n["seqInBranch"])
        frontier = nodes[-1]
        evaluated = [n for n in nodes if n["evaluated"]]
        successful = [n for n in nodes if n["evaluated"] and n["failClass"] == "ok"]
        best_anchor = max((n["score"] for n in successful), default=None)
        last = frontier
        consecutive_failures = 0
        for node in reversed(nodes):
            if (not node["evaluated"]) or node["failClass"] != "ok":
                consecutive_failures += 1
            else:
                break
        anchor_index = None
        if best_anchor is not None:
            for index, node in enumerate(nodes):
                if node["evaluated"] and node["failClass"] == "ok" and node["score"] == best_anchor:
                    anchor_index = index
        rounds_since_improvement = len(nodes) - 1 - anchor_index if anchor_index is not None else len(nodes)
        last_score = last["score"] if last["evaluated"] else None
        first_score = evaluated[0]["score"] if evaluated else None
        trend = 0.0
        if len(evaluated) >= 2 and first_score is not None and last_score is not None:
            trend = (last_score - first_score) / (len(evaluated) - 1)
        last_failure = last["failClass"] if (last["evaluated"] is False or last["failClass"] != "ok") else None
        chains.append({
            "branchId": branch_id,
            "frontier": last,
            "bestAnchor": best_anchor,
            "lastScore": last_score,
            "lastDelta": last["deltaVsParent"],
            "trend": trend,
            "consecutiveFailures": consecutive_failures,
            "attempts": len(nodes),
            "roundsSinceImprovement": rounds_since_improvement,
            "lastFailure": last_failure,
            "openedAtSeq": nodes[0]["seq"],
        })
    return root, chains


def solve(view):
    """Choose one legal batch (<= W) from the observable prefix, or stop."""
    limits = view["limits"]
    width = limits["maxParallelism"]
    root, chains = _branches(view)
    close_after, stagnation = _schedule(BETA)

    # --- pruning closures (prefix-derived; a later success reopens) ---
    open_branches = []
    for chain in chains:
        enough = chain["attempts"] >= MIN_EVIDENCE
        hard_failure = (
            chain["lastFailure"] in HARD
            and chain["consecutiveFailures"] >= close_after
        )
        stagnant = chain["roundsSinceImprovement"] >= stagnation
        if not (enough and (hard_failure or stagnant)):
            open_branches.append(chain)

    candidates = []
    max_anchor = max((c["bestAnchor"] for c in open_branches if c["bestAnchor"] is not None), default=None)
    max_seq = max((c["openedAtSeq"] for c in open_branches), default=1) or 1
    branch_count = len(chains)
    opened_branches = len(chains)

    # Root: legal while recorded/unrecorded grid branches remain.
    if opened_branches < GRID_BRANCHES:
        candidates.append({"node": root, "role": "root", "score": 0.4 + 0.6 * BETA, "chain": None})

    for chain in open_branches:
        frontier = chain["frontier"]
        if frontier["seqInBranch"] >= GRID_REFINE:
            continue
        anchor_norm = 0.0
        if chain["bestAnchor"] is not None:
            anchor_norm = (chain["bestAnchor"] / max_anchor) if max_anchor and max_anchor > 0 else 0.0
        remaining_norm = (GRID_REFINE - frontier["seqInBranch"]) / max(1, GRID_REFINE)
        recency_norm = frontier["seq"] / max(1, max_seq)
        repairable = chain["lastFailure"] in REPAIRABLE if chain["lastFailure"] is not None else False
        score = (
            RANKING["anchor"] * anchor_norm
            + RANKING["gain"] * _squash(chain["lastDelta"] or 0.0)
            + RANKING["trend"] * _squash(chain["trend"])
            + RANKING["recover"] * (1.0 if repairable else 0.0)
            + RANKING["remaining"] * remaining_norm
            + RANKING["recency"] * recency_norm
        )
        candidates.append({"node": frontier, "role": "frontier", "score": score, "chain": chain})

    if not candidates:
        return {"batch": [], "stop": True, "notes": "no legal candidates"}

    candidates.sort(key=lambda c: (-c["score"], c["node"]["id"]))
    capacity = min(width, len(candidates))

    def compose(with_root):
        plan = []
        if with_root:
            for candidate in candidates:
                if candidate["role"] == "root":
                    plan.append(candidate)
                    break
        for candidate in candidates:
            if len(plan) >= capacity:
                break
            if candidate["role"] != "frontier":
                continue
            if with_root and candidate["node"]["parentId"] == root["id"]:
                continue  # parent+child legality: root and its direct children never batch
            plan.append(candidate)
        return plan

    plan_with_root = compose(True) if any(c["role"] == "root" for c in candidates) else []
    plan_without_root = compose(False)
    prefer_root = (
        len(plan_with_root) > len(plan_without_root)
        or (len(plan_with_root) == len(plan_without_root) and PORTFOLIO["exploration"] > 0)
    )
    plan = plan_with_root if (prefer_root and plan_with_root) else plan_without_root

    # Justified recovery fills an idle slot and never displaces refinements.
    repairable_top = next(
        (
            c
            for c in candidates
            if c["role"] == "frontier"
            and c["chain"] is not None
            and c["chain"]["lastFailure"] in REPAIRABLE
        ),
        None,
    )
    if repairable_top is not None and len(plan) < capacity:
        if all(c["node"]["id"] != repairable_top["node"]["id"] for c in plan):
            plan.append(repairable_top)

    batch = [c["node"]["id"] for c in plan]
    return {
        "batch": batch,
        "stop": len(batch) == 0,
        "notes": "bootstrap-balanced: portfolio %d" % len(batch),
    }
`
