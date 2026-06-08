# Changelog

All notable changes to Persoje. Dates are when the work landed on `main`.

## 0.4.0 — 2026-06-08

The agent can reach the internet, plan multi-step work, and edit more
forgivingly — and you can see every change it makes.

**New**
- **Web access.** `web_search` (keyless, via DuckDuckGo) and `web_fetch`
  (URL → lean markdown, HTML stripped before it ever hits context). The
  agent looks things up instead of guessing at an unfamiliar API. A built-in
  SSRF guard refuses loopback, RFC-1918 private ranges, and the cloud
  metadata endpoint, so a fetched page can't turn the agent into a proxy for
  internal services.
- **Working plan.** `update_todos` keeps a live checklist for multi-step
  tasks, pinned compactly in the prompt and rendered in the TUI (✔/▸/○). The
  model follows its own plan instead of re-deriving "what's left" each turn.
- **Inline edit diffs.** Every edit shows a compact colored diff right under
  the tool row — built from the edit's own old/new strings, at zero token
  cost.
- **`multi_edit`.** Several search/replace edits to one file in a single
  atomic call (all succeed or nothing is written). Fewer round-trips than
  separate `edit` calls, and a mid-sequence failure can't leave a half-edited
  file. Shares the same exact-then-flexible matching as `edit`.
- **`persoje -p` print mode.** Headless one-shot for scripts and pipes:
  prompt from args or stdin, only the final result on stdout, `--json` for a
  structured `{text,tools,tokens,cost}` object.

- **Cost ceiling.** `/budget <usd>` (or `loop.maxCostUsd`) sets a hard
  session spend cap; the turn halts before the next model call once it's hit —
  the safety net autonomous/long runs were missing. `/budget off` to disable.
- **Eval harness** (`evals/`). Runs the real agent on fixture coding tasks and
  scores *completion* — deterministically (command exits 0 / file checks) or via
  an LLM judge (`--judge`) — with tokens/turn reported alongside. On free
  owl-alpha the assert suite passes 3/3 at ~2k tokens/turn, $0.

**Improved**
- **Edits don't loop on near-misses.** When `old_string` isn't an exact
  match, the edit tool falls back to a line-level match that ignores trailing
  whitespace, then indentation — but only when the match is unique, so it
  never edits the wrong place. A genuine miss now returns a near-match hint.
- **Theme & effort persist** across sessions; the status bar shows cache-hit
  % and tools-this-turn.
- System prompt nudges the model to look up unfamiliar libraries/errors
  rather than guess.

## 0.3.0 — 2026-06-06

First public release. Token-efficient agent core for OpenRouter: bounded
context (goal anchor + recent turns + rolling summary + swap-to-disk
transcript), capped tool output, prompt-cache discipline, model router with
first-use canary and escalation, weak-model guardrails (tool-call rescue,
fuzzy names, loop detection, post-edit verification, hardcoded danger guard),
out-of-band self-improvement (facts, lessons, skills, the `dream`
consolidator with an LLM-as-judge curation pass), sub-agents, MCP support,
and an Ink TUI. Single-binary build via `bun build --compile`.
