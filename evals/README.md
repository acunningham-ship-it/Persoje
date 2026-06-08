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
