/**
 * TUI rendering for the subagent tool: collapsed/expanded views for
 * single and parallel runs, builtin-style tool call trails, usage lines.
 */

import * as os from "node:os";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { finalText, isFailed, type RunResult } from "./runner.ts";

export interface SubagentDetails {
	mode: "single" | "parallel";
	results: RunResult[];
}

type ThemeLike = {
	fg(color: any, text: string): string;
	bold(text: string): string;
};

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

export function usageLine(result: RunResult): string {
	const parts: string[] = [];
	if (result.turns) parts.push(`${result.turns} turn${result.turns > 1 ? "s" : ""}`);
	if (result.usage.input) parts.push(`↑${formatTokens(result.usage.input)}`);
	if (result.usage.output) parts.push(`↓${formatTokens(result.usage.output)}`);
	if (result.usage.cost.total) parts.push(`$${result.usage.cost.total.toFixed(4)}`);
	if (result.startedAt) {
		const elapsed = Math.max(0, (result.completedAt ?? Date.now()) - result.startedAt);
		parts.push(elapsed < 1000 ? `${elapsed}ms` : `${Math.round(elapsed / 1000)}s`);
	}
	if (result.contextTokens) parts.push(`ctx:${formatTokens(result.contextTokens)}`);
	if (result.model) parts.push(result.model);
	return parts.join(" · ");
}

type TrailItem = { type: "text"; text: string } | { type: "tool"; name: string; args: Record<string, any> };

function trail(result: RunResult): TrailItem[] {
	const items: TrailItem[] = [];
	for (const msg of result.messages) {
		if (msg.role !== "assistant") continue;
		for (const part of msg.content) {
			if (part.type === "text" && part.text.trim()) items.push({ type: "text", text: part.text });
			else if (part.type === "toolCall") items.push({ type: "tool", name: part.name, args: part.arguments });
		}
	}
	return items;
}

function shortenPath(p: string): string {
	const home = os.homedir();
	return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

function formatToolCall(name: string, args: Record<string, unknown>, theme: ThemeLike): string {
	const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}...` : s);
	switch (name) {
		case "bash":
			return theme.fg("muted", "$ ") + theme.fg("toolOutput", clip((args.command as string) || "...", 60));
		case "read":
			return theme.fg("muted", "read ") + theme.fg("accent", shortenPath((args.path || args.file_path || "...") as string));
		case "write":
			return theme.fg("muted", "write ") + theme.fg("accent", shortenPath((args.path || args.file_path || "...") as string));
		case "edit":
			return theme.fg("muted", "edit ") + theme.fg("accent", shortenPath((args.path || args.file_path || "...") as string));
		case "grep":
			return theme.fg("muted", "grep ") + theme.fg("accent", `/${(args.pattern as string) || ""}/`);
		case "find":
			return theme.fg("muted", "find ") + theme.fg("accent", (args.pattern as string) || "*");
		case "ls":
			return theme.fg("muted", "ls ") + theme.fg("accent", shortenPath((args.path as string) || "."));
		default: {
			const argsStr = JSON.stringify(args ?? {});
			return theme.fg("accent", name) + theme.fg("dim", ` ${clip(argsStr, 50)}`);
		}
	}
}

function statusIcon(result: RunResult, theme: ThemeLike): string {
	if (result.exitCode === -1) return result.startedAt ? theme.fg("accent", "●") : theme.fg("muted", "○");
	return isFailed(result) ? theme.fg("error", "✗") : theme.fg("success", "✓");
}

function compactTask(task: string, max = 64): string {
	const oneLine = task.replace(/\s+/g, " ").trim();
	return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

function activityLine(result: RunResult, theme: ThemeLike): string | undefined {
	const item = trail(result).at(-1);
	if (!item) return undefined;
	if (item.type === "tool") return formatToolCall(item.name, item.args, theme);
	const preview = compactTask(item.text, 70);
	return preview ? theme.fg("toolOutput", preview) : undefined;
}

export function renderCallView(args: any, theme: ThemeLike): Text {
	const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}...` : s);
	if (args.tasks && args.tasks.length > 0) {
		let text = theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("accent", `parallel (${args.tasks.length} tasks)`);
		for (const t of args.tasks.slice(0, 4)) {
			text += `\n  ${theme.fg("accent", t.agent ?? "?")}${theme.fg("dim", ` ${clip(t.task ?? "", 50)}`)}`;
		}
		if (args.tasks.length > 4) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 4} more`)}`;
		return new Text(text, 0, 0);
	}
	let text = theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("accent", args.agent || "...");
	if (args.task) text += `\n  ${theme.fg("dim", clip(args.task, 70))}`;
	return new Text(text, 0, 0);
}

function renderSingleExpanded(result: RunResult, theme: ThemeLike): Container {
	const container = new Container();
	let header = `${statusIcon(result, theme)} ${theme.fg("toolTitle", theme.bold(result.agent))}${theme.fg("muted", ` (${result.source})`)}`;
	if (isFailed(result) && result.stopReason) header += ` ${theme.fg("error", `[${result.stopReason}]`)}`;
	container.addChild(new Text(header, 0, 0));
	if (isFailed(result) && result.errorMessage) {
		container.addChild(new Text(theme.fg("error", `Error: ${result.errorMessage}`), 0, 0));
	}
	container.addChild(new Spacer(1));
	container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
	container.addChild(new Text(theme.fg("dim", result.task), 0, 0));
	container.addChild(new Spacer(1));
	container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
	for (const item of trail(result)) {
		if (item.type === "tool") {
			container.addChild(new Text(theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme), 0, 0));
		}
	}
	const output = finalText(result.messages);
	if (output) {
		container.addChild(new Spacer(1));
		container.addChild(new Markdown(output.trim(), 0, 0, getMarkdownTheme()));
	} else {
		container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
	}
	const usage = usageLine(result);
	if (usage) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("dim", usage), 0, 0));
	}
	return container;
}

export function renderResultView(
	resultContent: { type: string; text?: string }[],
	details: SubagentDetails | undefined,
	expanded: boolean,
	theme: ThemeLike,
): Container | Text {
	if (!details || details.results.length === 0) {
		const first = resultContent[0];
		return new Text(first?.type === "text" ? (first.text ?? "") : "(no output)", 0, 0);
	}

	if (details.mode === "single") {
		const result = details.results[0];
		if (expanded) return renderSingleExpanded(result, theme);
		const state = result.exitCode === -1 ? (result.startedAt ? "running" : "queued") : isFailed(result) ? "failed" : "completed";
		let text = `${statusIcon(result, theme)} ${theme.fg("toolTitle", theme.bold(result.agent))} ${theme.fg("muted", state)}`;
		if (isFailed(result) && result.stopReason) text += ` ${theme.fg("error", `(${result.stopReason})`)}`;
		if (result.exitCode === -1) {
			const activity = activityLine(result, theme);
			if (activity) text += `\n  ${theme.fg("muted", "↳ ")}${activity}`;
		} else if (isFailed(result) && result.errorMessage) {
			text += `\n  ${theme.fg("error", compactTask(result.errorMessage, 100))}`;
		}
		const usage = usageLine(result);
		if (usage) text += `\n  ${theme.fg("dim", usage)}`;
		if (result.exitCode !== -1) text += `\n  ${theme.fg("dim", "/subagents to inspect transcript")}`;
		return new Text(text, 0, 0);
	}

	// parallel
	const results = details.results;
	const runningCount = results.filter((r) => r.exitCode === -1).length;
	const okCount = results.filter((r) => r.exitCode !== -1 && !isFailed(r)).length;
	const failCount = results.filter((r) => r.exitCode !== -1 && isFailed(r)).length;
	const icon = runningCount > 0 ? theme.fg("accent", "●") : failCount > 0 ? theme.fg("warning", "◐") : theme.fg("success", "✓");
	const status =
		runningCount > 0
			? `${okCount + failCount}/${results.length} done · ${runningCount} active`
			: `${okCount}/${results.length} completed`;

	if (expanded && runningCount === 0) {
		const container = new Container();
		container.addChild(new Text(`${icon} ${theme.fg("toolTitle", theme.bold("subagents "))}${theme.fg("accent", status)}`, 0, 0));
		for (const result of results) {
			container.addChild(new Spacer(1));
			container.addChild(new Text(`${theme.fg("muted", "─── ")}${theme.fg("accent", result.agent)} ${statusIcon(result, theme)}`, 0, 0));
			container.addChild(renderSingleExpanded(result, theme));
		}
		return container;
	}

	let text = `${icon} ${theme.fg("toolTitle", theme.bold("subagents "))}${theme.fg("accent", status)}`;
	for (const result of results) {
		const usage = usageLine(result);
		const activity = result.exitCode === -1 ? activityLine(result, theme) : undefined;
		const suffix = activity ?? (usage ? theme.fg("dim", usage) : theme.fg("dim", compactTask(result.task, 48)));
		text += `\n  ${statusIcon(result, theme)} ${theme.fg("accent", result.agent)}${suffix ? ` ${theme.fg("muted", "·")} ${suffix}` : ""}`;
	}
	if (runningCount === 0) text += `\n  ${theme.fg("dim", "/subagents to inspect transcripts")}`;
	return new Text(text, 0, 0);
}
