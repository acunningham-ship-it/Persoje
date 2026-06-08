# Persoje evals — does the agent finish the task?

`bench/` measures how *lean* Persoje is. This measures how *capable* it is: each
task runs the real agent headlessly in a throwaway workspace, then scores
whether the task was actually completed — and reports tokens/turn and cost
alongside, so capability and efficiency show up in one table.

Two scoring modes:

- **assert** — deterministic. A shell command must exit 0 (`python3 calc.py`,
  `node test.js`) and/or a JS check over the resulting files passes. Free,
  reproducible, CI-friendly.
- **judge** — an LLM grades the agent's answer against a rubric. For open-ended
  tasks (explain this code, find the install command) that no assertion can
  capture. Opt-in with `--judge` because it spends tokens on the judge model.

## Run it

```bash
# assert tasks only (free if you point at a free model), default = your primary
OPENROUTER_API_KEY=... bun run evals/run.ts

# pin a model
OPENROUTER_API_KEY=... bun run evals/run.ts --model openrouter/owl-alpha

# include the LLM-judged (open-ended) tasks — uses config model.judge
OPENROUTER_API_KEY=... bun run evals/run.ts --judge

# one task by name
OPENROUTER_API_KEY=... bun run evals/run.ts --only bugfix
```

Exit code is non-zero if any scored task failed, so it drops into CI.

## Reference run

A full `--judge` run on the free `openrouter/owl-alpha` model:

| task | kind | result | turns | tok/turn | cost |
|---|---|:--:|--:|--:|--:|
| bugfix | assert | ✅ | 4 | ~2,085 | $0 |
| feature-add | assert | ❌ | 1 | ~1,854 | $0 |
| multi-edit-rename | assert | ✅ | 4 | ~2,013 | $0 |
| explain-code | judge | ✅ | 2 | ~1,846 | $0 |
| web-lookup | judge | ✅ | 3 | ~3,096 | $0 |

**4/5**, at ~2k tokens/turn, $0. A free model fixes a bug end to end, renames
across a file, explains code, and looks a fact up on the web with the tools.
It's a flaky free tier, so it's not a clean sweep every run — `feature-add`
(write + run your own test) is the one that wobbles; across two runs it went
1/2 while the other four held. That's the whole point of an eval harness: it
reports exactly what passed instead of hand-waving. Rerun with your own model:
`bun run evals/run.ts --model <id> --judge`.

## Tasks

| name | kind | exercises |
|---|---|---|
| `bugfix` | assert | run → diagnose → fix → verify |
| `feature-add` | assert | add a function + write & run a test |
| `multi-edit-rename` | assert | rename an identifier everywhere (multi_edit) |
| `explain-code` | judge | read + explain (Fibonacci) |
| `web-lookup` | judge | web_search/web_fetch to find a fact |

Add a task by appending to `TASKS` in `run.ts`: give it files, a prompt, and
either a `verify` command / `check(dir)` function (assert) or a `rubric`
(judge).
