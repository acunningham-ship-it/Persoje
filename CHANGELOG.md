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
- **`persoje -p` print mode.** Headless one-shot for scripts and pipes:
  prompt from args or stdin, only the final result on stdout, `--json` for a
  structured `{text,tools,tokens,cost}` object.

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
