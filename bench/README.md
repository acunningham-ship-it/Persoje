# Token benchmark

A reproducible, apples-to-apples measurement of what Persoje's token discipline actually saves — **same harness, same model, same tasks**, with the discipline **on (lean)** vs **off (naive)**. Nothing else varies, so there are no cross-tool or cross-model confounds and the comparison can't be accused of cherry-picking a weaker competitor.

- **naive** = tool-result caps off (untruncated output) + compaction off (full-history replay) — i.e. what a conventional agent does
- **lean** = Persoje defaults (capped tool output, bounded/compacted context)

## Run it

```bash
OPENROUTER_API_KEY=... bun run bench/run.ts --model <any-openrouter-model>
```

Each task runs in a fresh temp dir; verifiable tasks assert via a shell command (exit 0 = ✓). The script prints a markdown table of input tokens per turn per mode.

## Results

`model: openrouter/owl-alpha` (a free model; results are directional, not a leaderboard):

| task | mode | turns | input tok | avg/turn | peak turn | success |
|---|---|--:|--:|--:|--:|:--:|
| bugfix | naive | 4 | 6,173 | 1,543 | 1,668 | ✓ |
| bugfix | lean | 4 | 6,608 | 1,652 | 1,829 | ✓ |
| feature | naive | 4 | 6,126 | 1,532 | 1,675 | ✓ |
| feature | lean | 4 | 6,121 | 1,530 | 1,672 | ✓ |
| **search-large** | naive | 2 | 39,019 | 19,510 | **37,657** | — |
| **search-large** | lean | 3 | 24,233 | 8,078 | **11,517** | — |

**Overall: 35% fewer input tokens per turn** (naive avg 5,132/turn → lean 3,360/turn). Both modes complete the verifiable tasks.

## What this honestly shows

- **On small tasks the harness is roughly a wash** — bugfix/feature are ~1.5k tok/turn either way, and the repo-map can even add a hair. With only a few turns and small tool output, there's nothing to truncate or compact.
- **The savings appear exactly where they should: large tool output and long sessions.** On `search-large` (reading a 1,600-line file + a verbose command), lean is **~2.4× leaner per turn** and its **peak turn is 69% smaller** (37.6k → 11.5k) because the big read is capped instead of dumped whole into context.
- **The effect compounds with session length.** This suite is short (2–4 turns/task). In real multi-turn sessions the naive curve keeps climbing as full history replays every turn, while lean stays flat — which is what the [README chart](../docs/token-comparison.svg) shows from real-world logs (median ~143k vs ~12k per turn).

In other words: the harness earns its keep on real coding work — verbose tool output and long debugging sessions — not on three-turn toys. The numbers above are the floor, not the ceiling.

## Caveats

- Free models are slow and rate-limited; turn counts vary run to run as the model chooses its own path.
- `search-large` has no strict success assertion (it's a reporting task) — it's there to measure tokens under large tool output.
- Add tasks in `run.ts` (`TASKS`) and re-run against any model to extend the suite.
