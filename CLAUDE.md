# CLAUDE.md — working on Persoje

Guidance for AI agents / contributors editing this repo. (User docs are in [README.md](README.md); the token benchmark is in [bench/](bench/).)

## What this is

A token-efficient agentic coding CLI for OpenRouter. The thesis: a lean harness makes a cheap/weak model behave like a stronger one — via bounded context (goal anchor + recent turns + summary + swap-to-disk transcript), capped tool output, weak-model guardrails, and model routing. See the README for the full feature map.

## Runtime: Bun (not Node)

- `bun <file>`, `bun test`, `bun install`, `bun run <script>`, `bunx <pkg>` — never the npm/node equivalents.
- `bun:sqlite` for the session store (not better-sqlite3). `Bun.spawn` for shell, `Bun.file`/`Bun.write` for I/O, `Bun.Glob` for globbing.
- Bun auto-loads `.env`; don't add dotenv.

## Commands

```bash
bun test                 # ~150 tests; uses a scripted fake client — no API key needed
bunx tsc --noEmit        # typecheck (keep src clean; a few test-file strict-null warnings are known)
bun run start            # run from source
bun run compile          # → dist/persoje (standalone binary)
bun run bench/run.ts --model <id>   # reproducible lean-vs-naive token benchmark
```

## Architecture

UI-agnostic core emits a typed `AgentEvent` stream; the Ink TUI and the plain REPL are thin subscribers — nothing in `src/core` imports Ink. Layout:

```
core/       agent loop, events, prompt, tokens, personality, autonomous, updater
context/    ContextManager (compaction/elision), repo-map, transcript
models/     OpenRouter client (raw fetch + SSE, usage, retry, model catalog)
router/     model profiles, escalation, first-use canary
guardrails/ fuzzy names, text-rescue, loop detection, post-edit verify, danger guard
tools/      read/write/edit/bash/grep/glob/ls, web_fetch/web_search, set_goal, transcript, task, skills
memory/     facts, lessons, skills (BM25), dream consolidator
agents/     sub-agent spawner + pool   ·   mcp/  MCP client   ·   session/  sqlite store
tui/        Ink app, components, theme, commands, markdown   ·   setup/  first-run wizard
```

## Conventions & guardrails

- **Match the surrounding style** — `.ts` import extensions, comments that explain *why*, lean code.
- **Add a test for new behavior** (`tests/`, against the fake client) and run `bun test` before committing.
- The **danger guard** (`guardrails/danger.ts`) is a hard floor: never weaken or bypass it to make a feature pass — it's what keeps autonomous/yolo modes safe.
- **Never commit secrets.** API keys come from `OPENROUTER_API_KEY` / config at runtime; nothing key-bearing is tracked. `.gitignore` covers `.env`, `dist/`, the binary, `.persoje/`, `*.db`.
- Keep tool descriptions and the system prompt **token-lean** — they ride on every model call.
- A running `persoje` auto-updates from `origin/main`; commit + push deliberately.
