# Subagents in Modern Coding Harnesses: Claude Code, Codex CLI, OpenCode

> Research date: 2026-08-11. Versions: Claude Code **v2.1.228** (+ Agent SDK 0.3.228 `.d.ts` inspected), OpenAI Codex CLI **rust-v0.147.0** stable / main @ `ba2fb483`, OpenCode **v1.18.16** / main @ `561afb401a`. Sources: official docs, changelogs, and actual source (Codex and OpenCode are open source; Claude Code studied via docs + SDK type declarations since it ships minified).

## TL;DR comparison

| Dimension | Claude Code | Codex CLI | OpenCode |
|---|---|---|---|
| Term | subagent (`Agent` tool, ex-`Task`) | subagent ("collab" v1 / "collaboration" v2 tools) | agent with `mode: subagent` (`task` tool) |
| Execution | in-process agent loop, own transcript JSONL | in-process thread in same `ThreadManager` | in-process child session (`parentID`) |
| Definition | Markdown + YAML frontmatter | **TOML** (`[agents]` in config.toml + `agents/*.toml` role files) | Markdown frontmatter **or** JSON in `opencode.json` |
| Discovery | managed → `--agents` JSON → `.claude/agents/` → `~/.claude/agents/` → plugins | config layers: packaged < system < user (`~/.codex/agents/`) < project (`.codex/agents/`) | config dirs merged; `{agent,agents}/**/*.md` global + project |
| Context | fresh (system prompt = definition body + env; CLAUDE.md + git snapshot injected); `fork` variant inherits full conversation | inherits parent base instructions; `fork_turns: none/all/N` controls history fork | fresh; provider default system prompt unless agent pins one; AGENTS.md/env still injected |
| Tools | allowlist + denylist frontmatter; different builtin pool fg vs bg | "same tools as you"; role config layer restricts (sandbox_mode etc.) | permission ruleset (allow/ask/deny + globs) doubles as tool filter |
| Model | env var → per-call → frontmatter → inherit | per-call → `default_subagent_model` → inherit | per-agent `provider/model` → inherit invoking message's model |
| Background | **default since v2.1.198** | children always run concurrently; parent coached not to block on `wait_agent` | experimental (`OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS`) |
| Concurrency | 20 running/session (tunable) | v1: 6 open threads; v2: 4 slots incl. parent | none (only depth limit) |
| Nesting | depth 3 default (churned 0→5→1→3) | v1: depth 1; v2: unlimited within slots | `subagent_depth` default 1 (off) |
| Inter-agent msgs | `SendMessage` to named agents; teams w/ mailboxes | v2: full peer mailbox (`send_message`, `followup_task`, path addressing) | none (parent→child `extend` only) |
| Resume | `SendMessage` auto-resumes; agentId in result | v1 `resume_agent`; graph store restores trees | `task_id` = child session id, resumable |
| Result | final text + `agentId`; **output scanned for prompt injection** | `FINAL_ANSWER` envelope into parent mailbox / injected message | last text part wrapped in `<task_result>` XML |

---

## 1. Claude Code (Anthropic)

### Concept
A **subagent** is a specialized agent loop spawned *within a session* via the `Agent` tool (renamed from `Task` at v2.1.63). Own context window, system prompt, tool set, permissions; returns one final text result. Docs position it explicitly as a **context-management device** ("use one when a side task would flood your main conversation"). Everything runs in-process in the single Node process; each subagent persists its own transcript at `~/.claude/projects/{project}/{sessionId}/subagents/agent-{agentId}.jsonl`.

The 2026 architecture separates four scaling tiers:
1. **Subagent** — in-session, fresh context.
2. **Fork** (`/subtask`, `subagent_type: fork`) — in-session, inherits the *full parent conversation*; shares the parent's prompt cache (documented cost rationale).
3. **Agent teams** (experimental, `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`) — multiple full sessions; shared task list (`~/.claude/tasks/{team}/`, file-locked claims) + JSON mailboxes; peer messaging.
4. **Workflows** (`Workflow` tool, SDK ≥0.3.149) — a JS script (`agent()/parallel()/pipeline()/phase()`) orchestrating dozens–hundreds of agents outside conversation context.

### Definition format
Markdown + YAML frontmatter; **body = the subagent's system prompt** (replaces the default CC prompt — subagents get "only this system prompt plus basic environment details").

```markdown
---
name: code-reviewer
description: Expert code review specialist. Use immediately after writing or modifying code.
tools: Read, Grep, Glob, Bash
model: sonnet
---
You are a senior code reviewer...
```

Only `name` + `description` required. Other fields: `disallowedTools` (denylist, applied before `tools`), `model` (alias, full ID, or `inherit`), `permissionMode`, `maxTurns`, `skills` (preload full content), `mcpServers` (name refs share parent connection; inline defs connect on start — keeps MCP schemas out of parent context), `hooks` (agent-scoped, trust-gated), `memory` (`user`/`project`/`local` → persistent dir, MEMORY.md head injected, 200 lines/25KB cap), `background: true`, `effort`, `isolation: worktree` (temp git worktree, auto-cleaned if unchanged), `color`.

Precedence (high→low): managed settings → `--agents '<JSON>'` → project `.claude/agents/` (walk up from cwd; nearest wins) → `~/.claude/agents/` → plugin agents (with `hooks`/`mcpServers`/`permissionMode` ignored for security). Live file-watching — edits picked up without restart. The `/agents` wizard was removed (v2.1.198); you ask Claude to write the file.

Built-ins: `Explore` (read-only, thoroughness parameter, skips CLAUDE.md/git, one-shot), `Plan` (read-only, plan-mode research), `general-purpose`, `claude` (catch-all), `statusline-setup`, `claude-code-guide`, `fork`.

### Tool schema (from SDK `sdk-tools.d.ts`)
```ts
interface AgentInput {
  description: string;         // 3-5 word task description
  prompt: string;              // the task
  subagent_type?: string;
  model?: "sonnet"|"opus"|"haiku"|"fable";
  run_in_background?: boolean; // background is the DEFAULT
  name?: string;               // addressable via SendMessage({to: name})
  isolation?: "worktree"|"remote";
}
```
Delegation is **description-driven** — the parent model reads agent descriptions and decides; `@agent-name` mention is the deterministic escape hatch. Spawning never prompts for permission; the subagent's own tool calls are permission-checked as they run.

### Context isolation
Fresh context = definition body + environment details + the task prompt (only parent→child channel) + **CLAUDE.md hierarchy** + **git status snapshot** (Explore/Plan skip both) + preloaded skills + sibling roster (if named agents exist). Never inherited: conversation history, parent skills, output style. Extended-thinking config *is* inherited (v2.1.198+).

Tool availability = parent's tools minus always-removed set (`Agent` at depth limit, `AskUserQuestion`, plan-mode tools, `Workflow`, …); **background runs get a different (smaller) builtin pool than foreground** — same definition, different tools depending on where it runs.

### Model/effort
Resolution: `CLAUDE_CODE_SUBAGENT_MODEL` env → per-call `model` → frontmatter → inherit. Checked against org `availableModels`. `effort` per definition. Docs frame it as a cost lever (Haiku for exploration, Opus/Fable for review).

### Parallelism & orchestration
- **Background by default** (v2.1.198) — the biggest recent shift; results arrive as completion notifications in later turns. Ctrl+B backgrounds a foreground task.
- Concurrency: 20 running subagents/session (`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`).
- Nesting depth 3 default (`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`); flip-flopped 0→5→1→3 across a month of releases.
- Resume/messaging: result carries `agentId`; `SendMessage({to})` auto-resumes with history retained; transcripts survive compaction and restarts (30d retention).
- Observer (SDK types, low-visibility): auto-spawned read-only observer receiving activity digests.

### Result path & security
Final message → tool result; parent never sees intermediate tool calls. **Output scanning (v2.1.210+)**: neutralizes `<system-reminder>` imitations, escapes `Human:`/`Assistant:` markers, flags instruction-shaped patterns — prompt-injection defense on the child→parent channel. API errors return partial output explicitly marked, never passed off as findings. No structured-output schema (free text + agentId trailer).

### Criticisms
Token/cost heavy (full context + CLAUDE.md reload + separate prompt cache per subagent); churny defaults (depth, Explore model, `/agents` removal); pre-v2.1.186 background subagents silently auto-denied permission prompts; delegation reliability requires prompting; no machine-parseable handoff contract.

---

## 2. Codex CLI (OpenAI)

### Concept
Codex has first-class subagents, shipped and on by default — official term **subagents**, internal name **collab/collaboration tools**. A subagent is a full **Codex thread** spawned in-process inside the same `ThreadManager`, tagged `SessionSource::SubAgent(...)` with parent id, depth, role. Notably, **`/review` and compaction are implemented as internal subagent threads** (`SubAgentSource::Review`, `Compact`, `MemoryConsolidation`).

Two generations coexist:
- **v1 "collab"** (`multi_agent`, stable, default-on): opaque thread-id addressing.
- **v2 "collaboration"** (`multi_agent_v2`, activated per-model via model presets): canonical path addressing (`/root/task1/task_3`), mailbox messaging, actor-model design.

### Definition format — TOML config layers, not prompt files
```toml
# ~/.codex/agents/pr-explorer.toml  (or .codex/agents/ in project)
name = "pr_explorer"
description = "Read-only codebase explorer for gathering evidence."
model = "gpt-5.3-codex"
sandbox_mode = "read-only"
developer_instructions = """Stay in exploration mode. Cite files."""
```
A role file is `name` + `description` + `nickname_candidates` + **any full config.toml keys flattened in** (`#[serde(flatten)]`) — model, reasoning effort, sandbox, MCP servers, tool toggles. At spawn, the role is applied as a high-precedence config layer over the parent's effective config. Roles merge across layers (packaged < MDM < system < enterprise < user < project < session flags). Built-in roles: `default`, `explorer`, `worker` (an `awaiter` exists but is commented out).

Global knobs in `[agents]`: `enabled`, `max_concurrent_threads_per_session`, `max_depth` (v1), `default_subagent_model`, `default_subagent_reasoning_effort`, `interrupt_message`.

### Tool surfaces
**v1** (`multi_agent_v1` namespace): `spawn_agent` (`message|items`, `agent_type`, `fork_context: bool`, `model`, `reasoning_effort`, `service_tier` → returns `{agent_id, nickname}`), `send_input` (`interrupt: bool`), `wait_agent` (targets + timeout 10s–1h, default 30s), `resume_agent`, `close_agent` ("completed agents count toward the concurrency limit until closed" — a footgun).

**v2** (`collaboration` namespace): `spawn_agent` (`task_name`, `message`, `fork_turns: "none"|"all"|"<N>"` default `all`), `send_message` (mailbox, no turn trigger), `followup_task` (triggers turn if idle), `wait_agent` (timeout only — waits for *any* mailbox update, returns only a summary of who has updates), `interrupt_agent`, `list_agents`. Inter-agent payloads can travel **encrypted**. Any agent can message any other by path — real peer messaging, not just parent↔child.

The v1 spawn tool description embeds an explicit **anti-spawn policy**: "Do not spawn sub-agents unless the user or applicable AGENTS.md/skill instructions explicitly ask for sub-agents, delegation, or parallel agent work." Plus delegation guidance (disjoint write sets, "call wait_agent very sparingly").

### Context isolation
Child inherits the parent's base instructions verbatim; role layer may replace `developer_instructions`. History fork controlled by caller (`fork_context`/`fork_turns`; full forks preserve the prompt-cache prefix; full forks must keep parent model). Tools: "same tools as you", restricted only via role config (e.g. `sandbox_mode = "read-only"`). All agents share one filesystem/cwd — **no worktree isolation**; coordination is by prompt convention. v2 injects a usage-hint prompt telling each agent its path identity and the message envelope format (`Message Type: NEW_TASK|MESSAGE|FINAL_ANSWER`).

### Parallelism
`AgentExecutionLimiter` atomic counter: v1 max 6 open threads, v2 **4 concurrency slots including the parent** (limit counts running turns). v1 depth 1 (collab tools not registered past the limit); v2 unbounded nesting within slots. Parent/child topology persisted in `agent-graph-store`; agent trees restored on session resume.

### Result path
Child's final assistant message → `AgentStatus::Completed` → formatted as `FINAL_ANSWER` envelope → delivered to parent mailbox (v2) or injected as user message (v1). Errors truncated to ~900 tokens. No summarization; raw text passes through. Telemetry: per-spawn counters + OTEL event stream for every send/receive.

### UX
`/agents` (aka `/subagents`) thread picker; nicknames per agent (roles supply candidates); approvals from inactive threads surface in the main view; users can switch into a child thread and steer directly. IDE background-agent panel; ChatGPT Work read-only subagents panel.

### Criticisms/design notes
Prompt-gated model-owned orchestration (anti-token-burn); config-layer roles reuse the whole config system but there's no per-role tool-allowlist primitive; hidden spawn metadata broke role/model selection for some hosted models (issue #31814); CSV batch fan-out feature removed; in-repo docs lag (moved to developers.openai.com).

---

## 3. OpenCode (SST)

### Concept
Single concept: **agents** with `mode: "primary" | "subagent" | "all"`. Primary agents are user-facing (Tab-switched: `build`, `plan`); subagents are invoked by primaries via the **`task` tool** or by users via `@mention`. A subagent invocation = **child session** (`Session.create({parentID})`) running the same in-process prompt loop with the agent's config. Sessions form a persisted tree (SQLite) — inspectable, resumable, navigable in the TUI.

Built-in subagents: `general` (full tools minus todowrite), `explore` (read-only file-search specialist with thoroughness parameter — clearly Claude Code's Explore homage). A `scout` built-in was added May 2026 and removed (#30435); docs still list it (stale).

### Definition format
Two merged formats. JSON (`agent` key in `opencode.json`) or Markdown (`{agent,agents}/**/*.md` under `~/.config/opencode/` and `.opencode/`; filename = name; body = prompt):

```markdown
---
description: Reviews code for quality
mode: subagent
model: anthropic/claude-sonnet-4-20250514
temperature: 0.1
permission:
  edit: deny
  bash: deny
---
You are in code review mode...
```

Fields: `description` (required for task routing), `mode`, `model` (`provider/model`), `variant`, `temperature`/`top_p`, `prompt` (replaces provider-default system prompt), `steps` (max iterations), `hidden`, `color`, `disable`, `options` (provider params), `permission` (allow/ask/deny + glob patterns — **doubles as tool visibility filter**: `*: deny` tools are removed from the list entirely). User config can restyle or disable built-ins. `opencode agent create` LLM-generates definitions.

### The `task` tool
```ts
{
  description: string    // 3-5 words
  prompt: string
  subagent_type: string
  task_id?: string       // resume previous child session
  command?: string
  background?: boolean   // only under OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS
}
```
Tool description dynamically appends the roster of non-primary agents as `- name: description` lines. Execution: depth check (`subagent_depth` default 1) → permission ask (`task` permission with per-agent-name glob patterns) → create child session → inherit parent's current model unless pinned → run standard prompt loop → return last text part.

**@-mention is indirect**: `@name` expands to a synthetic instruction telling the primary LLM to compose a task call with that agent (with permission bypass flag) — the LLM still authors the delegation prompt. Slash commands can target subagents directly (`subtask` parts).

### Context isolation
Child session starts fresh; only the prompt string transfers. System prompt = agent's `prompt` **or the provider-default coding prompt**, plus the same shared context the parent gets: environment block, AGENTS.md instruction files, MCP instructions, skills listing. Child permissions = its own agent ruleset + parent's **deny** rules only (changed in #31696: "let subagents use their own permissions"). Defaults injected: `todowrite: deny`, `task: deny` (no recursion, no todo noise).

### Parallelism & background
Parallel fan-out = multiple `task` calls in one assistant message (AI SDK runs them concurrently); **no concurrency cap in source** — only depth limit. Background (experimental): returns immediately; on completion the result is **injected as a synthetic user message** into the parent (auto-notification, consumes a parent turn); re-calling with same `task_id` while running = "extend" (sends additional context to the running job); foreground tasks promotable to background mid-flight.

### Result path
```xml
<task id="ses_..." state="completed">
<task_result>...final text...</task_result>
</task>
```
`task_id` = child session id, reusable for resume. No structured output contract; parent instructed to relay a concise summary (result invisible to user).

### UX
Live rendering of the child's current tool activity in the parent transcript ("AgentName · description", duration, cost, retry status). Keybind navigation into child sessions (Leader+Down, cycle Left/Right, Up to parent); `SubagentFooter` shows child tokens/context%/cost. Permission asks from all child sessions **bubble up** into the parent view. Agent `color` tints the name; `hidden` removes from @ autocomplete.

---

## 4. Cross-harness synthesis

**Convergent design (all three):**
- One generic spawn tool taking `(description, prompt, agent_type)` — not one tool per agent; roster injected into the tool description or prompt.
- Declarative agent definitions with `description` as the delegation trigger; the parent model routes by reading descriptions (no separate router).
- Fresh child context by default; the delegation prompt is the primary parent→child channel; opt-in history forking (CC `fork`, Codex `fork_turns`, OpenCode none).
- In-process execution with per-child persisted transcripts/sessions.
- Model inheritance by default with per-agent/per-call override; cheap-model routing framed as the main cost lever.
- Depth limits as anti-runaway defaults (CC 3, Codex v1 1, OpenCode 1) and recursion denied by default.
- Final-text-only result return; no structured output contract anywhere — all three punt on machine-parseable handoffs.

**Key divergences:**
- **Config carrier**: CC/OpenCode use markdown-frontmatter prompt files; Codex reuses its entire TOML config-layer system (roles can reconfigure *anything*, but there's no simple tool allowlist).
- **Orchestration model**: CC = background-by-default + notifications + SendMessage resume; Codex v2 = actor model with mailboxes and peer messaging; OpenCode = simplest (foreground, parallel via multiple tool calls, background still experimental).
- **Isolation depth**: CC offers worktree isolation and prompt-injection scanning of child output — unique among the three. Codex explicitly shares the workspace and coordinates by prompt convention.
- **Spawn gating**: Codex hard-gates spawning in the tool prompt ("don't spawn unless explicitly asked"); CC encourages proactive delegation ("use proactively" in descriptions); OpenCode permission-gates per agent name.
- **UX observability**: OpenCode and Codex let the user navigate into live child sessions and steer them; CC has a subagent panel with drill-in; observability of children is the active frontier in all three.

**Lessons for building a subagent system:**
1. Markdown + frontmatter with `name`/`description`/`tools`/`model` is the de facto standard definition format.
2. Fresh context + self-contained delegation prompt is the reliability baseline; the tool description must tell the parent to write detailed, self-contained prompts and specify expected return format.
3. Depth/recursion must be limited by default; concurrency caps matter (Codex's "completed agents hold slots" and CC's churn show this is easy to get wrong).
4. Return the child's final text verbatim, capped; never let error text masquerade as findings; treat child output as untrusted (CC's scanning).
5. Live progress streaming (current tool activity) is the difference between "black box" and usable.
