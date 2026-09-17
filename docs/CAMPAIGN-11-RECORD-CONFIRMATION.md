# CAMPAIGN 11 — THE NEW-METHOD HUNT (round r0037, policy v0010→v0011)

Goal: find an **entirely new optimization method** for the n=26 unit-square
max-sum-of-radii problem and push the **strict sum_radii past 2.636** (champion
2.6359830849, certified strict local max). Verdict up front: **two entirely new
mechanism classes were implemented and saturated in round 1; neither beat the
champion; 2.636 was not reached; the champion survived its 11th independent
method class AND was independently confirmed as the published world record.**

---

## PHASE 0 — LITERATURE RESEARCH (record + methods, with sources)

**The record is established: our strict champion IS the published world record.**

| Source | N=26 value | Notes |
|---|---|---|
| [Packomania csqv (variable radii in square)](https://www.packomania.com/csqv/csqv.html) | **2.635983084919** | contacts 78, boundary 16, core 10; ref [8] Haowei Lin |
| [Packomania csqv26 page](https://www.packomania.com/csqv/csqv.html) + [coordinates](https://www.packomania.com/csqv/txt/csqv26.txt) | 2.635983084919 | container [−0.5,0.5]²; radii 0.0692–0.1370 (2× spread) |
| HELIX, ICLR 2026 ([arXiv:2603.07642](https://arxiv.org/abs/2603.07642)) | 2.63598308 | "state-of-the-art result with a sum of radii of 2.63598308 using only a 14B model" (Tencent Hunyuan; Haowei Lin et al.) |
| AlphaEvolve → OpenEvolve ([issue #156](https://github.com/algorithmicsuperintelligence/openevolve/issues/156)) | 2.635977394754 | Yiping Wang, Jul 2025 (previous record) |
| Specht csqv program update log ([csqv.html#Updates](https://www.packomania.com/csqv/csqv.html)) | 2.635983084918 | 27-Jul-2026 entry, then recredited to Haowei Lin (01-Aug-2026) |

Our strict-verified champion **2.6359830848916066** matches Packomania's
2.635983084919 to 11 significant digits (their value is the coordinate-rounded
sum). The record history: AlphaEvolve (2025) → Wang/OpenEvolve 2.635977 →
Haowei Lin (HELIX) 2.6359830849, July–Aug 2026.

**Methods actually used in the csqv literature** (from the Packomania update
log + arXiv): LLM program evolution ([AlphaEvolve](https://arxiv.org/pdf/2506.13131),
OpenEvolve, [Discovery Loop, arXiv:2609.05093](https://arxiv.org/abs/2609.05093)
— penalty L-BFGS-B + basin hopping + contact-graph SLSQP polish), evolutionary
RL (HELIX), flow-matching generative + reward-guided policy ([FlowBoost,
arXiv:2601.18005](https://arxiv.org/abs/2601.18005)), policy-based RL
([Viquerat pbo](https://github.com/jviquerat/pbo/)), and commercial exact/MIQP
craft (Everett Dutton, Gurobi). **No dynamics/billiard method exists in the
csqv literature.** The billiard algorithm is standard only for EQUAL-circle
packing (Szabó, Markót, Csendes, Specht, Casado, García, *New Approaches to
Circle Packing in a Square*, Springer 2007) — for the max-sum-of-radii
objective it was an open method class. Monotonic optimization / reduced
problems for unequal-circle placement: Stoyan & Yaskov (EJOR 156 (2004)),
Szabó et al. 2007 — also never applied to csqv26 records.

## PHASE 1 — BILLIARD ALGORITHM (headline new method)

`circle-packing/scratch/c11_billiard.py` — numpy, deterministic (fixed seeds),
small-timestep (dt 1e-3 fluid / 2.5e-4 dense) event-resolved integration:
N=26 hard disks, elastic equal-mass collisions (normal velocity swap), wall
reflections, radii inflating at heterogeneous rates q_i.

**Physics design (the three discoveries that make it work):**
1. **Budget-driven growth**: γ₁·T₁ + γ₂·T₂ ≈ 0.08–0.11 (final r ≈ 0.1). Naive
   γ=0.4 schedules over-press the system 7× past jam → coalescence → LP
   degenerate. Growth rate must stay ≪ v₀ so disks separate between collisions.
2. **Gap-stalled growth**: growth freezes when the mean free gap over the 60
   closest pairs < gap_stop (2.5e-3 / 1.5e-3) — the growth NEVER over-presses;
   jamming is reached asymptotically, like the real LR algorithm.
3. **LP-hybrid thermal cycles** (new variant, ours): at each shrink-reheat-
   regrow cycle, radii are re-proportioned to the **exact-LP optimum at the
   current centers** (× shrink) before regrowing. The dynamics stay pure
   (no gradient on centers, no objective NLP) but the size distribution is
   re-aimed each cycle. This strictly beats the uniform-shrink control:
   ALL top-14 chain endpoints are lp_hybrid=True.

**Fleet: 378 dynamics runs (346 strict-OK) over 5 waves, all ≤10-min shards.**

| Seed family | runs | best RAW strict |
|---|---|---|
| uniform | 56 | 2.4992039 |
| champj (champion+σ0.03 jitter) | 62 | 2.4977800 |
| poisson | 59 | 2.4873726 |
| rings(1,7,9,9) | 27 | 2.4588777 |
| jgrid | 24 | 2.4653353 |
| hexrows | 24 | 2.4454243 |

Growth-spectrum signal: hetero (big1.9, fewbig-3-1.7, ln0.2) > eq by
+0.03–0.05 — matching the record's 2× radius spread (equal-rate billiards cap
at the equal-packing tier ~2.45–2.50). Thermal cycles: 4–6 ≫ 0–2 (+0.06 raw).

**Deep treatment (c6 deep_polish, the proven champion-grade climb — standard
post-processing, not the new method):** raw 2.45 → treated 2.56–2.62.

| Pipeline stage | best strict |
|---|---|
| raw billiard (wave 0) | 2.4832836 |
| raw billiard (wave 1, cycles=4–6) | 2.4992039 |
| LP-hybrid chains (wave 2, raw) | 2.5491925 |
| treated billiard (44 endpoints) | 2.6038521 |
| treated chains (wave 2) | **2.6189548** |
| recursive chains + polish (wave 3) | 2.6118995 |
| mass-seed + champion-proximal anneal (wave 4) | 2.6092364 |

Best new-method configuration: uniform + big1.9 + sched (0.06, 0.002, 1.2, 14)
+ v0 0.45 + gap_stop 1.5e-3 + LP-hybrid chains (seed 7084) + deep_polish →
**2.6189548 (−0.0170 from champion)**.

## PHASE 2 — MONOTONIC REDUCED-PROBLEM (Stoyan–Yaskov style)

`circle-packing/scratch/c11_mono.py` (+ iterated `c11_mono2.py`): progressive
anchoring of the largest-LP-radii disks (positions AND radii fixed), exact
reduced NLP (vectorized SLSQP, analytic obj-grad) over the free remainder,
ladder k = 0…25, **7 anchor orderings** (radius / degree / wall / reverse /
deg-wall / 2 random), ~6 s for 49 ladders. ~330 ladders total.

- **From the champion: all 7 orderings reproduce EXACTLY
  2.6359830848916066** — an independent, mechanism-class-new confirmation of
  the strict-local-max certificate (no monotone reduced-problem escape).
- From billiard basins: monotone lifts 2.549 → **2.629964** (raw chains) and
  2.592 → **2.630564** (treated basins), then saturates — the fully-anchored
  endpoint is ordering-independent. −0.0054 from champion.
- From the champion tier via mono2: stays AT the champion (mean matched
  distance 0.0) — no new basin crosses.

## Did anything beat 2.6359831? Was 2.636 reached?

**No.** Best new-method result: **2.630564** (mono from treated billiard
basin), −0.0054. Every escalation operator — deeper thermal cycles, LP-hybrid
re-proportioning, chains, recursive chains, mass seeds, monotone ladders —
**converges toward the champion from below**. The value landscape funnels to
2.6359831: raw tiers 2.34–2.55 → treated 2.56–2.619 → mono 2.6299–2.6306 →
champion 2.6359831 (untouched; best_program.py unchanged, strict_verify.py
PASS state preserved).

## Honest verdict: does the new method class have legs?

**As a basin-discovery engine: yes, clearly.** The billiard produced 346 new
jammed layouts across 6 structurally distinct seed families, explored contact
graphs that gradient/SA/DE/Lloyd machinery had not reached, and its pipelines
climb +0.17 (raw→treated→mono) with every operator still paying. The
LP-hybrid variant is a genuinely new dynamics+exact-LP coupling that strictly
dominates plain billiard annealing.

**As a record-breaker at n=26: no, on this evidence.** One campaign (~400
runs + ~330 ladders, all deterministic, ≤10-min shards) saturates the class
at −0.0054. Combined with 10 prior campaigns (~60 families, ~2.5M evals), the
surrogate data analysis of campaign 10, and now the world-record confirmation,
the evidence that **2.6359830849 is the global optimum reachable by every
sampled mechanism class is about as strong as it gets without a proof**.

## Files
- `circle-packing/scratch/c11_billiard.py` — billiard engine + waves 0/1
- `circle-packing/scratch/c11_chain.py` — LP-hybrid chains (wave 2)
- `circle-packing/scratch/c11_w3.py`, `c11_w4.py` — recursive chains, mass seeds
- `circle-packing/scratch/c11_mono.py`, `c11_mono2.py` — monotonic reduced problems
- `circle-packing/scratch/c11_treat.py` — deep treatment driver
- `circle-packing/scratch/c11_results_p*.jsonl` — full journals (740+ records)
- `.dreamrsi/policies/v0011.py` — committed policy (billiard schedule of record)
- Dream-RSI: round r0037 closed (5 nodes, 4 decision batches), autoDream d0037

## Sources
- https://www.packomania.com/csqv/csqv.html (N=26 record table + update history)
- https://www.packomania.com/csqv/txt/csqv26.txt (record coordinates)
- https://arxiv.org/abs/2603.07642 (HELIX, ICLR 2026 — SOTA 2.63598308)
- https://arxiv.org/abs/2601.18005 (FlowBoost)
- https://arxiv.org/abs/2609.05093 (Discovery Loop)
- https://arxiv.org/pdf/2506.13131 (AlphaEvolve)
- https://github.com/jviquerat/pbo/ (policy-based optimization)
- Szabó, Markót, Csendes, Specht, Casado, García, *New Approaches to Circle
  Packing in a Square*, Springer 2007 (billiard algorithm for equal circles;
  reduced-problem methods)
- Stoyan & Yaskov, EJOR 156 (2004) (monotonic/reduced-problem unequal-circle
  placement)
