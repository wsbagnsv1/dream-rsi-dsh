# Campaign 5 Report — n=26 Circle Packing, Global-Principles Campaign (round r0021)

**Outcome: TARGET EXCEEDED — AlphaEvolve BEATEN in 1 of 12 rounds.** New champion
sum_radii **2.6358715336359766** (combined_score **1.0003307528030272**,
target_ratio 1.000331, evaluator-verified, valid, 0.50 s) vs AlphaEvolve's
2.635 and the campaign-4 champion 2.6216913346020494. Improvement over the
inherited champion: **+0.0141802 (+0.541%)**; over AlphaEvolve: **+0.000872
(+0.033%)**. Stop condition (combined_score > 1.0) triggered immediately;
campaign closed after 1 round with no padding.

## The winning mechanism chain (r0021-n003 → n006)

1. **Fleet-of-priors seed**: concentric rings (1,7,9,9) structural prior
   (seed 30) → corrected-gradient L-BFGS-B climb = **2.597851** (below the
   old champion — the basin itself looked unremarkable).
2. **Gravity/compaction re-settle** of that basin: circles as soft disks with
   RADII AS VARIABLES; energy
   `E = K·Σ_pairs max(0, ri+rj−d_ij)² + WRAD·K·Σ_i max(0, ri−wall_i)² − LAM·Σ ri`
   with analytic gradients (finite-difference verified to 5.8e-9); stiffness
   annealed K = 1e2 × 5.0 over 14 L-BFGS-B stages, LAM = 0.8, WRAD = 2.0 →
   **2.635859** (+0.038 over the basin's own climb, +0.014 over the champion).
3. **Champion-grade deep polish**: corrected-gradient L-BFGS-B (rounds 2,
   maxiter 500) + fine annealed hops (σ 2e-3/1e-3/5e-4) + greedy pattern
   search with tangent-pair slides + tangency least-squares snap + exact LP
   radii + validator-tolerance harvest → **2.6358715336359766**. Packaged as
   `variants/variantC5_ring1799-lam8-deep-r21.py`, evaluator-verified
   (sum_radii 2.6358715336359766, combined 1.0003307528030272, valid,
   0.50 s), promoted to `best_program.py`/`program.py`.

**Why it worked**: the re-settle is a *basin transform*, not a local move.
The old champion basin is a universal attractor for the same operator — all
6 schedules from the champion return to exactly 2.621691 — so the +0.0133
gap was unreachable from the champion by ANY local method (consistent with
campaigns 2–4). The gain required settling a *different* basin: soft-sphere
compaction with growing radii from the ring basin crossed a structural
transition no LP-gradient climb from that basin could make.

## Round progression (all scores evaluator-replica verified; champion evaluator-run)

| Node | Mechanism (family) | sum_radii | combined |
|------|--------------------|-----------|----------|
| start | inherited champion (campaign 4) | 2.621691335 | 0.994949 |
| n001 | cross-n library n=22..28 (2.319/2.378/2.458/2.514/2.594/2.693) + 7 migrations, 4 deep-polished | 2.590647 | 0.983172 |
| n002 | backward design v1: champion analysis + 23 heterogeneous radius-profile templates | 2.547302 | 0.966619 |
| n003 | gravity/compaction v1: 15 soft-sphere runs, 5 inits × 3 schedules | 2.605375 (champion-init = exact attractor 2.621691) | 0.988686 |
| n004 | fleet-of-priors v1: 29 structural priors, deep-polish top-4 | 2.607882 (rings 1,7,9,9) | 0.989707 |
| n005 | fleet v2: 41 priors (ring combos, big-corner rc≤0.22, grids) | 2.610089 | 0.990515 |
| n006 | **gravity re-settle of the rings(1,7,9,9) basin + deep polish — PROMOTED** | **2.635871534** | **1.000331** |
| n007 | chain migration (grow n20-22→26, shrink n30/32→26) | 2.591307 | 0.983384 |
| n008 | backward v2: 22 extreme profiles (corner-dominant, many-small-walls, asymmetric) | 2.582784 | 0.980107 |

## Mechanism families ranked (campaign 5 eval counts)

| Family | Evals / constructions | Best | Verdict |
|--------|----------------------|------|---------|
| **Gravity re-settle + deep polish** | 4 basins × 3 schedules + deep | **2.6358715** | **WON** |
| Fleet-of-priors v1/v2 (70 priors) | 70 climbs + 7 deep | 2.610089 | negative alone; supplied the winning basin |
| Gravity v1 (champion/ring/rand inits) | 15 runs | 2.621691 (attractor) | neutral; proved attractor |
| Cross-n seeding + migration | 66 builds + 7 migrations | 2.590647 | decisive negative |
| Chain migration | 5 chains × 4-6 steps | 2.591307 | decisive negative |
| Backward design v1+v2 (45 templates) | 45 solves + climbs | 2.582784 | decisive negative |

## Saturation state after campaign 5

Respects and extends campaigns 2–4: all position-space and graph-space local
families remain exhausted. Campaign-5 additions (do not re-run): cross-n
migration, chain migration, backward radius-profile sweeps, fleet expansion
priors. Still unsampled (for any future campaign): gravity re-settle applied
to the other ~40 basins above 2.55, re-settle schedules LAM 0.8–1.2 / WRAD
5–8 on ring basins, double re-settle chains.

## Dream-RSI v0.2 state

- Round r0021 closed: 9 nodes, 4 branches, 2 decision batches (W=4), 21
  valid replay worlds. Dream d0020 over 21 worlds: no regression, incumbent
  retained on replay (replay scores cannot see the campaign-5 breakthrough).
- Policy lineage: v0005 graph-saturated → **v0006 gravity-resettle-winner
  (active)** — replay solve() byte-identical to v0005 (no regression
  possible); online strategy records the winning chain, the decisive
  negatives, and the unsampled extensions.

## Files

- **Champion**: `best_program.py` = `program.py` =
  `variants/variantC5_ring1799-lam8-deep-r21.py` (embedded re-settled ring
  centers + exact-LP radii + tolerance harvest, 0.50 s, deterministic,
  evaluator-verified).
- Campaign-5 library: `scratch/c5_lib.py` (generic-n LP/climb/validator/
  harvest, pattern polish, bounded tangency solver, deep polish, insertion
  scan, structural seeds).
- Batteries: `scratch/c5_crossn.py`, `c5_backward.py`, `c5_gravity.py`,
  `c5_fleet.py`, `c5_fleet2.py`, `c5_gravity2.py`, `c5_chains.py`,
  `c5_backward2.py`; promotion tool `c5_promote.py`; smoke test `c5_smoke.py`.
- Winning candidate data: `scratch/c5_RING_LAM8.npz`.
- Policy source: `variants/policy_v0006_gravity_resettle_winner.py`.
- `evaluator.py` untouched.

## Reproducibility

All programs fixed-seed/deterministic (numpy default_rng with fixed
constants; scipy options pinned; linprog highs; least_squares trf).
`python run_eval.py` reproduces the final row exactly
(sum_radii=2.6358715336359766, combined=1.0003307528030272, valid).
