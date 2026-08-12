# Subagents in pi: Extension Ecosystem & Comparison with Claude Code / Codex / OpenCode

> Research date: 2026-08-11. pi (badlogic/pi-mono → `earendil-works`, `@earendil-works/pi-coding-agent`) **v0.84.1**. Local clone at `~/devel/oss/pi-mono`; ecosystem repos cloned under `~/devel/oss/`. Companion doc: `01-subagents-in-claude-code-codex-opencode.md`.

## 1. pi's philosophy: no built-in subagents

pi deliberately ships **no subagent support in core**. README Philosophy: *"No sub-agents. There's many ways to do this. Spawn pi instances via tmux, or build your own with extensions, or install a package that does it your way."* Mario Zechner's rationale (blog, 2025-11-30): existing subagent implementations are *"a black box within a black box"* with zero visibility; he recommends spawning pi instances via tmux for observability, or gathering context in separate sessions and handing off artifacts.

The consequence: subagents live entirely in **user-land extensions**, and an ecosystem of 30+ repos / 20+ npm packages has grown around the gap. An official reference implementation ships in-repo at `packages/coding-agent/examples/extensions/subagent/` (not an installed feature — you symlink it yourself).

## 2. What pi gives extension authors

Three sanctioned backbones for spawning children:

| Backbone | How | Trade-offs |
|---|---|---|
| **JSON-mode subprocess** | `spawn("pi", ["--mode","json","-p","--no-session", ...])`, parse JSONL events from stdout | Simplest, battle-tested (official example); full isolation; survives parent crash; per-child process startup cost |
| **In-process SDK** | `createAgentSession()` from `@earendil-works/pi-coding-agent` | No process cost, steerable session objects in memory, richer live UI; dies with parent |
| **RPC subprocess** | `pi --mode rpc`, LF-JSONL command protocol | Bidirectional: steer/follow_up/abort mid-run, session control |

Key extension API surface used by subagent extensions:
- `pi.registerTool({name, description, promptSnippet, promptGuidelines, parameters: TypeBox, execute(id, params, signal, onUpdate, ctx), renderCall, renderResult})` — custom tool with streaming progress (`onUpdate`) and full TUI rendering control (`@earendil-works/pi-tui` components).
- `ctx.model` / `ctx.thinkingLevel` — capture parent model to forward as dispatch defaults.
- `ctx.ui.confirm/notify/setWidget/setStatus` — gating + fleet widgets (guard with `ctx.hasUI`; JSON/print modes have no UI).
- `ctx.isProjectTrusted()` — trust gate for repo-controlled agent definitions.
- Exported helpers: `parseFrontmatter`, `getAgentDir`, `CONFIG_DIR_NAME`, `truncateHead/Tail` (+ `DEFAULT_MAX_BYTES` 50KB / 2000 lines — "tools MUST truncate"), `withFileMutationQueue`.
- Result contract: `{content}` goes to the LLM, `details` is render/session-only, `usage` rolls nested LLM usage into session totals, throw to set `isError`.
- Child-relevant CLI flags: `--mode json -p --no-session`, `--model provider/id[:thinking]`, `--thinking <level>`, `--tools a,b,c`, `--append-system-prompt <text-or-file>`, `--system-prompt`, `-ne/-ns/-np/-nc` (disable extensions/skills/templates/context files), `--session*`/`--fork` (resumable children if wanted), `--approve/--no-approve`.

## 3. The official example (`examples/extensions/subagent/`, ~1160 LOC)

- **Tool**: single `subagent` tool, exactly one mode per call — single `{agent, task, cwd?}`, parallel `{tasks:[...]}` (max 8 tasks, 4 concurrent), chain `{chain:[...]}` with `{previous}` string substitution of the prior step's final text.
- **Agent defs**: markdown + frontmatter `name`/`description`/`tools` (comma-sep → `--tools`)/`model`; body appended to pi's default system prompt via `--append-system-prompt` (0600 temp file). Ships `scout` (haiku) / `planner` / `reviewer` / `worker` + workflow prompt templates (`/implement` = scout→planner→worker) — chaining is *prompted*, not engine-enforced.
- **Discovery**: user `~/.pi/agent/agents/*.md` always; project `.pi/agents/*.md` only with `agentScope: "both"|"project"` + interactive confirm ("Project agents are repo-controlled"). Re-discovered fresh each invocation.
- **Inheritance**: no `model` in frontmatter ⇒ child gets parent's `provider/model` **and** thinking level; pinned model ⇒ thinking not forwarded (asymmetry).
- **Streaming**: consumes child `message_end`/`tool_result_end` JSONL events → `onUpdate` re-renders live (per-task ⏳/✓/✗, "2/3 done, 1 running"); collapsed view shows last 10 items with builtin-style tool formatting + usage line; expanded renders markdown.
- **Results**: final assistant text; parallel digest capped 50KB/task (issue #4710 raised it from 100-char previews); failures return stderr/error diagnostics with `isError`; full messages/usage preserved in `details` (survives session resume/fork).
- **Abort**: parent signal → SIGTERM, SIGKILL after 5s.
- **Gaps** (deliberate — it's an example): no background mode, no resume of children, no nesting guard (children load the same global extension → unguarded recursion possible), no inter-agent messaging, headless parent skips the project-agent confirm, usage not returned as `usage` (only in details).

## 4. Ecosystem survey

The market split into **maximalist frameworks** and **deliberately minimal delegation tools** — several READMEs explicitly position against the big ones ("There are many subagent extensions for Pi; this one is mine").

### Major players

| Extension | ★ | Spawn | One-liner |
|---|---|---|---|
| `nicobailon/pi-subagents` (npm `pi-subagents`) v0.46 | ~3.1k | subprocess | Dominant maximalist: everything is a `workflowScript` (model-written JS in a `node:vm` worker sandbox: `runs.run/all`, mission `state`); missions, intercom (child↔parent messaging), watchdog reviewer, acceptance gates (host-run verification before result accepted), fallback models, turn/tool/usage budgets, worktrees, FleetView inspector, `context: fresh\|fork`, async by default, retained children (last 10 revivable) |
| `tintinweb/pi-subagents` v0.15 | 847 | **in-process SDK** | Claude Code parity: `Agent`/`get_subagent_result`/`steer_subagent` tools; ~20 frontmatter fields (authoritative, lock out per-call overrides); background queue (maxConcurrent 4), smart group-join notifications, mid-run steering, session resume, cron/interval scheduling, nesting via `allowed_subagents` allowlist (documented as a privilege boundary), `prompt_mode: replace\|append`, `inherit_context` fork, hermetic `isolated` mode, worktrees, FleetView with inline steer/kill, event bus + cross-extension RPC |
| `HazAT/pi-interactive-subagents` v3.7 | 614 | tmux/zellij/cmux/WezTerm pane | Subagents as **visible terminal panes** running full interactive pi (packaged answer to Mario's black-box critique); async-only, result steered back into parent (`deliverAs: "steer"`, no polling); bundled planner/scout/worker/reviewer/visual-tester |
| `QuintinShaw/pi-dynamic-workflows` v3.5 | 398 | in-process SDK | Workflow-first: model writes JS orchestration script (`phase()/agent()/parallel()/pipeline()`); 16 concurrent / 1000 total; journaled resume (edited script replays unchanged calls from cache); model tiers small/medium/big; token budgets; worktree isolation per agent |
| `amosblomqvist/pi-subagents` | 184 | subprocess | "Minimal": one call = one agent `{agent, task}`; fan-out via pi's native parallel tool calls; semaphore 4; depth control via `PI_SUBAGENT_ALLOWED` env filtering the child's registry *before the tool description is built* (child LLM can't name out-of-list agents) |
| `edxeth/pi-subagents` v2.7 | 107 | mux pane + headless subprocess | HazAT fork: `interactive\|background` × `async\|sync` axes; orchestrator mode (`PI_ORCHESTRATOR_MODE=1` strips all tools except subagent ops + replaces system prompt with decompose/delegate/synthesize role) |
| `mjakl/pi-subagent` v3.0 | 77 | subprocess | Lightweight+careful: named persistent subagent sessions (continue a specialist across turns), fresh vs parent-snapshot context, project agents gated on **pi's project trust store**, depth guard via `PI_SUBAGENT_DEPTH` env (documented as ecosystem convention) + cycle guard |

### Notable specialists
`melihmucuk/pi-crew` (non-blocking crew, results queued up to 24h); `kky42/pi-flow` (children run on pi, **Codex CLI, or Claude Code**); `shift-labs-ai/pi-rlm` (one persistent TS evaluator; subagents = `rlm.run()` calls in a call stack); `dnouri/pi-submarine` (deliberately narrow, foreground-only, fresh-or-forked); `ross-jill-ws/pi-teammate` (peer network, no orchestrator); `alexei-led/pi-subagents-bridge` (adapter between the two big ecosystems); npm `pi-subagent-model-selection` (shared model-selection policy across extensions — conventions are consolidating). Index: `BubblePtr/awesome-pi`.

### Converged ecosystem conventions
- md + YAML frontmatter agents; core fields `name`/`description`/`tools`/`model`(/`thinking`).
- Discovery `~/.pi/agent/agents/` (user) + `.pi/agents/` (project), project wins **but is trust-gated** (repo-controlled prompt injection vector — confirm dialog, or pi trust store).
- Concurrency default **4**; output caps 50–200KB; collapsed/expanded TUI with a usage stats line.
- `PI_SUBAGENT_DEPTH` env as the "am I a subagent?" convention; nesting off by default or allowlist-gated as a privilege boundary.
- Tool allowlists enforced by spawning flags; acknowledged as advisory once `bash` is granted.

## 5. Comparison: pi ecosystem vs built-in harness subagents

| Dimension | CC / Codex / OpenCode (built-in) | pi (extensions) |
|---|---|---|
| Execution | all in-process | split: subprocess family (official, nicobailon, mjakl, amos, HazAT) vs in-process SDK family (tintinweb, QuintinShaw) — pi is the only harness where **subprocess isolation** is the mainstream choice |
| Definition | harness-defined (md+YAML or TOML) | ecosystem re-invented md+YAML independently and converged on the same core fields as Claude Code |
| Trust model | CC: plugin field stripping, output scanning; OpenCode: permission rulesets | project-agent trust gating (confirm / trust store); no one does child-output injection scanning like CC |
| Background | CC default; Codex always-concurrent; OpenCode experimental | fragmentided: sync-only (official) → async-by-default (nicobailon) → pane-based always-async (HazAT) |
| Observability | drill-in panels (all three) | pi's killer variants: **real terminal panes** (HazAT) and FleetViews with inline steering — direct responses to the "black box" critique that made Mario reject built-in subagents |
| Orchestration | CC Workflows (SDK-level scripts); Codex v2 mailbox actor model | model-written JS scripts sandboxed in `node:vm` (nicobailon, QuintinShaw) — pushes intermediate results out of chat context; arguably ahead of the harnesses |
| Resume/steering | CC SendMessage resume; Codex resume_agent; OpenCode task_id | present in the bigger extensions (steer tools, named persistent sessions, journaled replay) |
| Standardization | one blessed way per harness | none — 30+ implementations, incompatible tool names (`subagent` vs `Agent` vs workflow), bridges appearing between ecosystems |

**What the pi ecosystem validates over the harness designs:**
1. The harness vendors' converged shape (generic tool + md-frontmatter roster + fresh context + final-text return) is also what most pi extensions independently landed on — it's the local optimum.
2. pi-land explores frontiers the harnesses haven't shipped: acceptance/evidence gates, model fallback chains, per-agent memory, cron scheduling, cross-CLI children, pane-level observability.
3. The cost of no-core-support: fragmentation, no shared security baseline (each extension re-solves project-agent trust), recursion guards by fragile env-var convention, and every extension pays the tool-description context tax its own way (nicobailon's description alone is enormous).

## 6. Takeaways for building a new pi subagent extension

- **Definition format is settled**: md + YAML `name`/`description`/`tools`/`model`/`thinking` in `~/.pi/agent/agents/` + `.pi/agents/`, project trust-gated via `ctx.isProjectTrusted()` (cleaner than the example's per-call confirm).
- **Subprocess JSON-mode is the right simple backbone**: isolation, crash-independence, zero coupling to parent runtime internals; accept the startup cost.
- **One tool, single + parallel modes** covers the real use; chain can be prompted (templates) rather than engine-built. pi executes sibling tool calls concurrently anyway, so even parallel arrays are partially redundant — but an explicit `tasks` array gives a single streaming progress row.
- **Must-haves from the research**: dynamic roster in the tool description; self-contained-prompt guidance (all three harnesses do this in the tool prompt); depth guard (`PI_SUBAGENT_DEPTH`); concurrency cap (4); 50KB output truncation via pi's exported helpers; stream child tool activity via `onUpdate`; return `usage` so parent session totals include child spend; SIGTERM→SIGKILL abort; error text clearly marked as error (`isError`, never as findings).
- **Worth skipping for "simple but functional"**: background execution + notifications, steering, missions/budgets/watchdogs, worktree isolation, inter-agent messaging — these are the maximalist tarpit; the minimal cluster (amos/mjakl/dnouri) proves a tight tool is useful without them.
