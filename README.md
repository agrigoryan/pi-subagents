# pi-subagents

Simple, fully functional subagents extension for the [pi coding agent](https://github.com/badlogic/pi-mono). One `subagent` tool, markdown agent definitions, isolated child processes, live streaming progress.

Design rationale and the research behind it: [`_docs/`](./_docs/) (subagent implementations in Claude Code / Codex / OpenCode, the pi extension ecosystem, and the design derived from both).

## What it does

- **`subagent` tool** with two modes:
  - single: `{ agent, task, cwd? }`
  - parallel: `{ tasks: [{ agent, task, cwd? }, ...] }` — max 8 tasks, 4 concurrent (process-wide semaphore, also bounds sibling tool calls)
- Each subagent runs as a separate `pi --mode json -p --no-session` process: fresh context, full isolation, only the task text crosses the boundary.
- **Minimal live UI**: one compact row per child shows queued/running/completed state, current activity, duration, tokens, and cost. Ctrl+O expands the tool result.
- **Navigable transcript inspector**: `/subagents` opens a two-pane session browser; ↑/↓ selects a child and PgUp/PgDn scrolls its task, tool calls/results, and assistant messages. `/subagents agents` lists definitions and sources.
- **Usage roll-up**: child token/cost usage is returned as tool `usage`, so pi's session totals include delegated spend.
- Output to the parent model is capped at 50KB across the whole tool result (full transcripts remain in tool details); failed runs preserve their transcript and usage.
- Abort propagates: Esc/Ctrl+C → SIGTERM → SIGKILL after 5s.

## Agent definitions

Markdown + YAML frontmatter. `name` and `description` required; body = system prompt appended to pi's default prompt.

```markdown
---
name: scout
description: Fast read-only codebase recon; returns compressed findings
tools: read, grep, find, ls
model: anthropic/claude-haiku-4-5
thinking: low
---
You are a scout agent...
```

| Field | Behavior |
|---|---|
| `tools` | comma-separated allowlist → child `--tools` |
| `model` | any pi model pattern; omitted → inherits the dispatching session's model **and** thinking level |
| `thinking` | `off\|minimal\|low\|medium\|high\|xhigh\|max`; honored with pinned or inherited model |

**Discovery** (re-run fresh on every call, so you can edit agents mid-session):
- `~/.pi/agent/agents/*.md` — user agents, always loaded
- `.pi/agents/*.md` — nearest project dir walking up from cwd; loaded **only when the project is trusted** (pi's trust store / `-a`); overrides user agents by name

Project agents are repo-controlled prompts — the trust gate is the defense against repo-supplied prompt injection, and unlike a confirm dialog it also holds in headless (`-p`) runs.

## Recursion guard

Children are spawned with `PI_SUBAGENT_DEPTH=<parent+1>`. At load, the extension doesn't register the tool at all once `PI_SUBAGENT_DEPTH >= PI_SUBAGENT_MAX_DEPTH` (default 1) — a subagent can't even see the tool, so there's no advisory-only restriction to bypass. Raise `PI_SUBAGENT_MAX_DEPTH` to allow nesting.

## Install

```bash
# Global: symlink into pi's extension dir
mkdir -p ~/.pi/agent/extensions
ln -s "$(pwd)" ~/.pi/agent/extensions/pi-subagents

# Sample agents
mkdir -p ~/.pi/agent/agents
cp agents/*.md ~/.pi/agent/agents/

# Or ad-hoc for one session
pi -e ./src/index.ts
```

Sample agents: `scout` (read-only recon), `worker` (full-capability implementation), `reviewer` (read-only code review).

## Layout

```
src/index.ts    extension entry: depth guard, tool + /subagents command
src/agents.ts   agent discovery (user + trust-gated project)
src/runner.ts   pi subprocess spawn, JSONL streaming, semaphore, abort
src/render.ts   minimal collapsed + expanded tool rendering
src/inspector.ts keyboard-navigable transcript browser (`/subagents`)
agents/         sample agent definitions
_docs/          research + design docs
```

## Development

```bash
npm install
npm run check   # tsc --noEmit
```

Verified end-to-end against pi 0.84.1: single delegation, parallel fan-out, depth guard (tool absent at depth ≥ 1), trust gate (project agents invisible without approval).
