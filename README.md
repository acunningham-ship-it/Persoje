# Persoje

A token-efficient agentic coding CLI for [OpenRouter](https://openrouter.ai) — run *any* model
(free stealth previews, small open models, frontier) inside a harness that keeps them honest
and keeps your context lean.

**The thesis:** a lean harness makes cheap models punch up. Hermes-style agents send 200k+
tokens per turn; Persoje runs the same models at 1–2k tokens per call.

```
$ persoje "find why the test fails and fix it"
  ⚙ glob {"pattern":"**/*.py"}
  ⚙ read {"path":"calc.py"}
  ⚙ bash {"command":"python3 calc.py"}
  ⚙ edit {"path":"calc.py", ...}
  ⚙ bash {"command":"python3 calc.py"}
Fixed: average() divided by len+1. All tests pass.
  session: 7 calls · 9.4k tok · $0.00000
```

## Install

```bash
bun install
bun run src/cli.ts            # interactive TUI (first run launches setup)
bun run compile               # single binary → dist/persoje
```

Requires [Bun](https://bun.sh) and an `OPENROUTER_API_KEY` (or run the setup wizard).
ripgrep recommended for the grep tool.

## Usage

```bash
persoje                       # Ink TUI, persistent sessions
persoje "one-shot task"       # headless, auto-approve, prints cost
persoje --plain               # bare REPL
persoje --model openrouter/owl-alpha --resume <session-id>
persoje dream                 # offline memory consolidation (free model, $0)
```

TUI commands: `/model [id]` `/router on|off|auto|offer` `/cost` `/sessions` `/resume <id>`
`/compact` `/clear` `/help`. `esc` cancels a turn; `y/n/a` answers permission prompts.

## Why it's cheap

| Layer | Mechanism |
|---|---|
| Tool results | per-tool token caps enforced *before* anything enters history |
| History | compaction at 80% of a self-imposed budget (default 40k, not the model max); mid-turn tool-result elision |
| Project context | ranked repo-map (~800 tok) instead of file dumps |
| Edits | search/replace blocks — no whole-file rewrites |
| Caching | stable prompt prefix, `cache_control` breakpoints, provider pinning |
| Delegation | `task` tool spawns sub-agents in isolated contexts; only a ≤500-tok summary returns |
| Accounting | real cost per call from OpenRouter usage; live in the status bar |

## Why it survives weak models

- **Canary**: 3-prompt smoke test on first use of an unknown model; verdict persists to
  `~/.config/persoje/models.json` and tunes guardrail strictness
- **Rescue**: parses tool calls that models emit as text (`<tool_call>`, fenced JSON)
- **Fuzzy match**: `read_file` → `read` instead of an error loop
- **Loop guard**: identical repeated calls get blocked with a nudge, not executed
- **Post-edit verify**: TS/JS/Python/JSON syntax-checked after every write; failures go
  straight back to the model
- **Router**: guardrail failures accumulate per model → suggests (or auto-switches to) a
  stronger model. Toggle with `/router on|off`.

## Memory (the anti-Hermes design)

Memory is out-of-band and bounded — ≤1.2k tokens at session start, ever:

- `~/.config/persoje/memory/MEMORY.md` — index, one line per fact (facts fetched lazily)
- `lessons.jsonl` — failed turns append; loaded as compact bullets
- `~/.config/persoje/skills/*.md` — BM25-searched, injected per turn only when relevant
- `persoje dream` — a **free** model compresses recent sessions into durable facts, dedups,
  expires stale lessons. Run it from cron; self-improvement at $0.

## Config

`~/.config/persoje/config.json` (global) ← `.persoje/config.json` (per-project):

```jsonc
{
  "model": { "primary": "openrouter/owl-alpha", "fallbacks": [], "compactor": "" },
  "context": { "budgetTokens": 40000, "repoMapTokens": 800 },
  "router": { "enabled": true, "mode": "offer", "canary": true },
  "memory": { "enabled": true, "budgetTokens": 1200, "dreamModel": "" },
  "toolResultCaps": { "bash": 2000 }
}
```

## Development

```bash
bun test          # 86 tests, no API key needed (scripted fake client)
bunx tsc --noEmit
```

Architecture: `src/core` (UI-agnostic event-stream agent loop) · `src/context` (compaction,
repo-map) · `src/guardrails` · `src/router` · `src/memory` · `src/agents` (sub-agents) ·
`src/tui` (Ink subscriber) · `src/session` (bun:sqlite). Design research in `docs/research/`.
