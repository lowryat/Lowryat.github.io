# Rep 7 Addendum: Cross-Seed Validation of "Optimized" EMA Params

Rep 7 found that `fast=16, slow=60` ranked #1 on synthetic seed 42. Before
adopting it, the two parameter sets were compared across 15 seeds.

| Seed | default (12/48) | new (16/60) | Delta | Winner |
|---|---|---|---|---|
| 0 | -7.28% | -8.46% | -1.19% | default |
| 1 | +22.61% | +6.79% | -15.82% | default |
| 2 | -7.60% | -1.60% | +6.00% | new |
| 3 | +33.42% | +25.87% | -7.55% | default |
| 4 | +6.13% | +4.71% | -1.42% | default |
| 5 | +15.73% | +14.75% | -0.98% | default |
| 7 | +8.16% | +8.35% | +0.19% | new |
| 10 | +5.36% | +1.48% | -3.87% | default |
| 15 | +31.41% | +24.24% | -7.17% | default |
| 20 | +0.42% | -2.23% | -2.64% | default |
| 30 | +2.20% | +8.29% | +6.09% | new |
| 42 | +7.27% | +10.83% | +3.56% | new |
| 50 | +5.28% | +14.22% | +8.93% | new |
| 99 | +7.93% | +3.58% | -4.34% | default |
| 100 | +19.02% | +9.31% | -9.71% | default |

**Verdict**: Default `fast=12, slow=48` outperforms on 10/15 seeds (67%).
The seed-42 grid-search optimum does **not** generalise. Default parameters
are retained unchanged.
