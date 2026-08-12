/**
 * pi-subagents — delegate tasks to isolated subagents.
 *
 * One `subagent` tool with two modes:
 *   single:   { agent, task, cwd? }
 *   parallel: { tasks: [{ agent, task, cwd? }, ...] }   (max 8, 4 concurrent)
 *
 * Each subagent runs as a separate `pi --mode json -p --no-session` process with
 * a fresh context. Agent definitions are markdown files with YAML frontmatter in
 * ~/.pi/agent/agents/ (user) and .pi/agents/ (project, requires project trust).
 *
 * Recursion guard: children get PI_SUBAGENT_DEPTH=parent+1; at or beyond
 * PI_SUBAGENT_MAX_DEPTH (default 1) the tool is not registered at all.
 */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import { DEFAULT_MAX_BYTES, truncateHead, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type AgentConfig, discoverAgents, formatRoster } from "./agents.ts";
import { openSubagentInspector } from "./inspector.ts";
import { renderCallView, renderResultView, type SubagentDetails } from "./render.ts";
import {
	addUsage,
	DEPTH_ENV,
	emptyUsage,
	finalText,
	isFailed,
	MAX_DEPTH_ENV,
	MAX_PARALLEL_TASKS,
	runAgent,
	type RunResult,
	withSlot,
} from "./runner.ts";

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to run" }),
	task: Type.String({ description: "Task for the agent. Must be fully self-contained." }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent (defaults to current)" })),
});

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Agent name (single mode)" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (single mode)" })),
	cwd: Type.Optional(Type.String({ description: "Working directory (single mode)" })),
	tasks: Type.Optional(
		Type.Array(TaskItem, {
			description: `Independent tasks to run in parallel (parallel mode, max ${MAX_PARALLEL_TASKS})`,
		}),
	),
});

function truncateForModel(text: string): string {
	const truncation = truncateHead(text, { maxBytes: DEFAULT_MAX_BYTES, maxLines: 2000 });
	if (!truncation.truncated) return text;
	return `${truncation.content}\n\n[Output truncated to ${Math.round(truncation.outputBytes / 1024)}KB. Full output preserved in tool details.]`;
}

function resultOutput(result: RunResult): string {
	if (isFailed(result)) {
		return result.errorMessage || result.stderr.trim() || finalText(result.messages) || "(no output)";
	}
	return finalText(result.messages) || "(no output)";
}

export default function (pi: ExtensionAPI) {
	const depth = Number.parseInt(process.env[DEPTH_ENV] ?? "0", 10) || 0;
	const maxDepth = Number.parseInt(process.env[MAX_DEPTH_ENV] ?? "1", 10) || 1;
	if (depth >= maxDepth) return; // running inside a subagent: no further delegation

	type FailurePatch = { details: SubagentDetails; usage: Usage };
	const failurePatches = new Map<string, FailurePatch>();

	// Throwing is required for pi to mark a tool call as failed. Restore the
	// transcript and nested usage that pi's generic thrown-error result omits.
	pi.on("tool_result", (event) => {
		if (event.toolName !== "subagent") return;
		const patch = failurePatches.get(event.toolCallId);
		if (!patch) return;
		failurePatches.delete(event.toolCallId);
		return patch;
	});

	pi.registerCommand("subagents", {
		description: "Browse subagent sessions (/subagents agents lists definitions)",
		getArgumentCompletions: (prefix) => {
			const options = [
				{ value: "agents", label: "agents", description: "List available agent definitions" },
			];
			const matches = options.filter((option) => option.value.startsWith(prefix.trim()));
			return matches.length > 0 ? matches : null;
		},
		handler: async (args, ctx) => {
			if (args.trim() !== "agents") {
				await openSubagentInspector(ctx);
				return;
			}
			const discovery = discoverAgents(ctx.cwd, ctx.isProjectTrusted());
			const lines = [
				`User agents dir: ${discovery.userDir}`,
				`Project agents dir: ${discovery.projectDir ?? "(none found)"}${
					discovery.projectDir && !discovery.projectTrusted ? " [ignored: project not trusted]" : ""
				}`,
				"",
				formatRoster(discovery),
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate a task to a specialized subagent with its own isolated context window.",
			"Use it when a side task (broad codebase search, research, review, an independent implementation step) would flood your context with output you won't reference again.",
			"Modes: single ({agent, task}) or parallel ({tasks: [{agent, task}, ...]}) for independent tasks.",
			"The subagent only receives your task text — no conversation history. Write self-contained tasks: include relevant file paths, prior findings, constraints, and state exactly what the agent should return.",
			"Do not delegate trivial lookups you can do with one or two direct tool calls.",
			"Available agents:\n" + rosterSnapshot(pi),
		].join("\n"),
		parameters: SubagentParams,

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const discovery = discoverAgents(ctx.cwd, ctx.isProjectTrusted());
			const agents = discovery.agents;

			const hasSingle = Boolean(params.agent && params.task);
			const hasParallel = (params.tasks?.length ?? 0) > 0;
			if (Number(hasSingle) + Number(hasParallel) !== 1) {
				throw new Error(
					`Provide either {agent, task} or {tasks: [...]}, not both/neither.\nAvailable agents:\n${formatRoster(discovery)}`,
				);
			}

			const requested = hasSingle ? [{ agent: params.agent!, task: params.task!, cwd: params.cwd }] : params.tasks!;
			if (requested.length > MAX_PARALLEL_TASKS) {
				throw new Error(`Too many parallel tasks (${requested.length}). Max is ${MAX_PARALLEL_TASKS}.`);
			}
			for (const item of requested) {
				if (!agents.some((a) => a.name === item.agent)) {
					throw new Error(`Unknown agent "${item.agent}".\nAvailable agents:\n${formatRoster(discovery)}`);
				}
			}

			const mode: SubagentDetails["mode"] = hasSingle ? "single" : "parallel";
			const dispatchModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
			const dispatchThinking = ctx.thinkingLevel;

			const results: RunResult[] = requested.map((item, index) => ({
				id: `${toolCallId}:${index + 1}`,
				agent: item.agent,
				source: agents.find((a) => a.name === item.agent)?.source ?? "unknown",
				task: item.task,
				cwd: item.cwd ?? ctx.cwd,
				exitCode: -1,
				messages: [],
				stderr: "",
				usage: emptyUsage(),
				turns: 0,
				contextTokens: 0,
			}));

			const emitUpdate = () => {
				if (!onUpdate) return;
				const done = results.filter((r) => r.exitCode !== -1).length;
				const summary =
					mode === "single"
						? finalText(results[0].messages) || "(running...)"
						: `Parallel: ${done}/${results.length} done`;
				onUpdate({
					content: [{ type: "text", text: summary }],
					details: { mode, results: [...results] } satisfies SubagentDetails,
				});
			};

			await Promise.all(
				requested.map((item, index) =>
					withSlot(async () => {
						try {
							const agent = agents.find((a) => a.name === item.agent) as AgentConfig;
							const inheritsModel = !agent.model;
							results[index] = await runAgent({
								id: results[index].id,
								agentName: agent.name,
								source: agent.source,
								task: item.task,
								systemPrompt: agent.systemPrompt,
								cwd: item.cwd ?? ctx.cwd,
								model: agent.model ?? dispatchModel,
								thinking: agent.thinking ?? (inheritsModel ? dispatchThinking : undefined),
								tools: agent.tools,
								signal,
								onEvent: (current) => {
									results[index] = current;
									emitUpdate();
								},
							});
						} catch (error) {
							const failed = results[index];
							failed.exitCode = 1;
							failed.completedAt = Date.now();
							failed.stopReason = signal?.aborted ? "aborted" : "error";
							failed.errorMessage = error instanceof Error ? error.message : String(error);
							failed.stderr ||= failed.errorMessage;
						}
						emitUpdate();
					}),
				),
			);

			const usage: Usage = emptyUsage();
			for (const result of results) addUsage(usage, result.usage);
			const details: SubagentDetails = { mode, results };

			const fail = (message: string): never => {
				failurePatches.set(toolCallId, { details, usage });
				throw new Error(message);
			};

			if (signal?.aborted) fail("Subagent run was aborted");

			if (mode === "single") {
				const result = results[0];
				if (isFailed(result)) {
					fail(`Agent ${result.stopReason || "failed"}: ${truncateForModel(resultOutput(result))}`);
				}
				return {
					content: [{ type: "text", text: truncateForModel(resultOutput(result)) }],
					details,
					usage,
				} satisfies AgentToolResult<SubagentDetails>;
			}

			const okCount = results.filter((r) => !isFailed(r)).length;
			const sections = results.map((result) => {
				const status = isFailed(result) ? `failed${result.stopReason ? ` (${result.stopReason})` : ""}` : "completed";
				return `### [${result.agent}] ${status}\n\n${resultOutput(result)}`;
			});
			const output = truncateForModel(
				`Parallel: ${okCount}/${results.length} succeeded\n\n${sections.join("\n\n---\n\n")}`,
			);
			if (okCount === 0) fail(output);
			return {
				content: [{ type: "text", text: output }],
				details,
				usage,
			} satisfies AgentToolResult<SubagentDetails>;
		},

		renderCall(args, theme) {
			return renderCallView(args, theme);
		},

		renderResult(result, { expanded }, theme) {
			return renderResultView(
				result.content as { type: string; text?: string }[],
				result.details as SubagentDetails | undefined,
				expanded,
				theme,
			);
		},
	});
}

/** Roster embedded in the tool description at registration; discovery re-runs fresh on each call. */
function rosterSnapshot(pi: ExtensionAPI): string {
	try {
		// Registration happens before any session context exists; use cwd and treat the
		// project as untrusted for the description (execute() re-checks with real trust).
		const discovery = discoverAgents(process.cwd(), false);
		return formatRoster(discovery);
	} catch {
		return "(discovery failed — call the tool to list agents)";
	}
}
