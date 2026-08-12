# pi-subagents: Design

> Simple yet fully functional subagents extension for pi (≥0.84). Informed by `01-subagents-in-claude-code-codex-opencode.md` and `02-pi-subagent-extensions.md`.

## Goals / non-goals

**Goals** — the converged baseline every harness and most pi extensions landed on:
- One `subagent` tool: single delegation `{agent, task}` + explicit parallel fan-out `{tasks: [...]}`.
- Agent definitions: markdown + YAML frontmatter (`name`, `description`, `tools`, `model`, `thinking`) in `~/.pi/agent/agents/` (user) and `.pi/agents/` (project).
- Project agents gated on **pi's project trust** (`ctx.isProjectTrusted()`) — cleaner than the official example's per-call confirm parameter, and it works headless.
- Dynamic agent roster in the tool description + self-contained-prompt guidance (all three major harnesses do this).
- Fresh, isolated child context via subprocess `pi --mode json -p --no-session`.
- Model/thinking inheritance from the dispatching session when the agent doesn't pin one.
- Live streaming progress (child tool activity + usage) via `onUpdate`; collapsed/expanded TUI rendering.
- Recursion guard via the ecosystem-standard `PI_SUBAGENT_DEPTH` env (children don't get the tool by default).
- Concurrency semaphore (4) shared process-wide (covers sibling tool calls too), 8 tasks/call cap.
- 50KB output truncation (pi's `truncateHead`), full transcript in `details`.
- Child usage returned as `usage` → parent session totals include child spend (the official example omits this).
- Abort: SIGTERM → SIGKILL after 5s.
- `/subagents` command listing discovered agents + source.

**Non-goals** (the maximalist tarpit; see doc 02 §6): background execution/notifications, steering, chains (prompt templates can orchestrate sequential calls), missions/budgets/watchdogs, worktrees, inter-agent messaging, scheduling.

## Decisions & rationale

| Decision | Rationale |
|---|---|
| Subprocess (JSON mode) over in-process SDK | Battle-tested (official example), full isolation, survives parent quirks, zero coupling to runtime internals; startup cost acceptable |
| Trust-gated project agents, no confirm param | pi already has a trust store; the example's `confirmProjectAgents` is model-controllable (the model could pass `false`) and silently skipped headless |
| No chain mode | Sequential = the model calls the tool again with the previous result in the prompt; `{previous}` string substitution added complexity without engine value |
| Depth guard at extension load | If `PI_SUBAGENT_DEPTH` ≥ `PI_SUBAGENT_MAX_DEPTH` (default 1), the tool isn't registered at all — the child model can't even see it (amos-style: restriction before schema, not advisory) |
| `usage` on the tool result | pi rolls it into footer//session/RPC totals — real cost visibility for delegated work |
| Roster embedded at register + rediscovered at execute | Description gives the model the roster upfront; fresh discovery per call allows editing agents mid-session |

## Tool schema

```ts
subagent({
  agent?: string,   // single mode
  task?: string,    // single mode
  cwd?: string,     // single mode, optional working dir
  tasks?: [{ agent, task, cwd? }],  // parallel mode (max 8)
})
// exactly one of (agent+task) | tasks
```

## Child invocation

```
pi --mode json -p --no-session \
   [--model <frontmatter | parent provider/id>] \
   [--thinking <frontmatter | parent level (only when model inherited)>] \
   [--tools <frontmatter allowlist>] \
   --append-system-prompt <tmpfile 0600 with agent body> \
   "Task: <task>"
env: PI_SUBAGENT_DEPTH=<parent depth + 1>
```

Parsed events: `message_end` (accumulate messages, usage, stopReason, errorMessage), `tool_result_end`. Binary resolution: current script under `process.execPath` when real file (Bun virtual-FS guarded), else compiled binary, else `pi` on PATH — same logic as the official example.

## Agent definition format

```markdown
---
name: scout
description: Fast read-only codebase recon; returns compressed findings
tools: read, grep, find, ls
model: anthropic/claude-haiku-4-5
thinking: low
---
System prompt appended to pi's default prompt...
```

`name` + `description` required (file skipped otherwise). `thinking` honored both with pinned and inherited model (fixes the example's asymmetry where a pinned model dropped the thinking flag).

## Layout

```
src/index.ts     extension entry: depth guard, registerTool, /subagents command
src/agents.ts    discovery + frontmatter parsing (trust-aware)
src/runner.ts    subprocess spawn, JSONL streaming, abort, usage accumulation
src/render.ts    renderCall/renderResult (collapsed/expanded, single + parallel)
agents/          sample agents: scout, worker, reviewer
```

Install: `~/.pi/agent/extensions/` symlink, `pi -e`, or `pi install git:...` (package.json `pi.extensions` entry).
