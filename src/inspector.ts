import type { Message, Usage } from "@earendil-works/pi-ai";
import { getMarkdownTheme, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import {
	Key,
	Markdown,
	matchesKey,
	truncateToWidth,
	type Component,
	type TUI,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { isFailed, type RunResult } from "./runner.ts";
import { usageLine } from "./render.ts";

type DispatchMode = "single" | "parallel";

type InspectedRun = {
	result: RunResult;
	mode: DispatchMode;
	dispatch: number;
	position: number;
	exitCodeKnown: boolean;
};

type UnknownRecord = Record<string, unknown>;

const EMPTY_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function isRecord(value: unknown): value is UnknownRecord {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function numberOr(value: unknown, fallback = 0): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function safeDisplayText(value: string): string {
	let safe = "";
	for (const character of value.replace(/\r\n/g, "\n")) {
		const code = character.codePointAt(0) ?? 0;
		const control = (code < 0x20 && code !== 0x09 && code !== 0x0a) || (code >= 0x7f && code <= 0x9f);
		const bidi = code === 0x061c || code === 0x200e || code === 0x200f || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
		safe += control || bidi ? `‹U+${code.toString(16).toUpperCase().padStart(4, "0")}›` : character;
	}
	return safe;
}

function stringOr(value: unknown, fallback: string): string {
	return typeof value === "string" && value.trim() ? safeDisplayText(value) : fallback;
}

function normalizeUsage(value: unknown): Usage {
	const usage = isRecord(value) ? value : {};
	const cost = isRecord(usage.cost) ? usage.cost : {};
	return {
		...EMPTY_USAGE,
		input: numberOr(usage.input),
		output: numberOr(usage.output),
		cacheRead: numberOr(usage.cacheRead),
		cacheWrite: numberOr(usage.cacheWrite),
		totalTokens: numberOr(usage.totalTokens),
		cost: {
			input: numberOr(cost.input),
			output: numberOr(cost.output),
			cacheRead: numberOr(cost.cacheRead),
			cacheWrite: numberOr(cost.cacheWrite),
			total: numberOr(cost.total),
		},
	};
}

function normalizeMessages(value: unknown): Message[] {
	if (!Array.isArray(value)) return [];
	return value.filter((message): message is Message => {
		if (!isRecord(message) || !["user", "assistant", "toolResult"].includes(String(message.role))) return false;
		return typeof message.content === "string" || Array.isArray(message.content);
	});
}

function normalizeRun(value: unknown): { result: RunResult; exitCodeKnown: boolean } | undefined {
	if (!isRecord(value)) return undefined;
	const messages = normalizeMessages(value.messages ?? value.transcript);
	const hasIdentity = typeof value.agent === "string" || typeof value.task === "string" || messages.length > 0;
	if (!hasIdentity) return undefined;

	const numericExitCode = typeof value.exitCode === "number" && Number.isFinite(value.exitCode);
	const stopReason = typeof value.stopReason === "string" ? value.stopReason : undefined;
	const legacyStatus = typeof value.status === "string" ? value.status.toLowerCase() : "";
	const legacyDone = ["done", "completed", "success", "succeeded"].includes(legacyStatus);
	const legacyFailed = ["failed", "error", "aborted"].includes(legacyStatus);
	const exitCodeKnown = numericExitCode || legacyDone || legacyFailed;
	let exitCode = numericExitCode ? (value.exitCode as number) : 0;
	if (!numericExitCode && ["running", "pending"].includes(legacyStatus)) exitCode = -1;
	else if (!numericExitCode && (legacyFailed || stopReason === "error" || stopReason === "aborted")) exitCode = 1;

	const source = value.source === "user" || value.source === "project" ? value.source : "unknown";
	return {
		exitCodeKnown,
		result: {
			id: stringOr(value.id, `legacy-${Math.random().toString(36).slice(2)}`),
			agent: stringOr(value.agent, "unknown agent"),
			source,
			task: stringOr(value.task, "(task unavailable)"),
			cwd: stringOr(value.cwd, "(working directory unavailable)"),
			exitCode,
			startedAt: typeof value.startedAt === "number" ? value.startedAt : undefined,
			completedAt: typeof value.completedAt === "number" ? value.completedAt : undefined,
			messages,
			stderr: typeof value.stderr === "string" ? safeDisplayText(value.stderr) : "",
			usage: normalizeUsage(value.usage),
			turns: numberOr(value.turns),
			contextTokens: numberOr(value.contextTokens),
			model: typeof value.model === "string" ? safeDisplayText(value.model) : undefined,
			stopReason: stopReason ? safeDisplayText(stopReason) : undefined,
			errorMessage: typeof value.errorMessage === "string" ? safeDisplayText(value.errorMessage) : undefined,
		},
	};
}

function runsFromDetails(details: unknown, dispatch: number): InspectedRun[] {
	if (!isRecord(details)) return [];

	// `result` and a bare run are accepted for old sessions. Current sessions use `results`.
	let rawResults: unknown[];
	if (Array.isArray(details.results)) rawResults = details.results;
	else if (isRecord(details.result)) rawResults = [details.result];
	else if ("agent" in details || "task" in details || "messages" in details || "transcript" in details) rawResults = [details];
	else return [];

	const mode: DispatchMode = details.mode === "parallel" || rawResults.length > 1 ? "parallel" : "single";
	const runs: InspectedRun[] = [];
	for (let position = 0; position < rawResults.length; position++) {
		const normalized = normalizeRun(rawResults[position]);
		if (normalized) runs.push({ ...normalized, mode, dispatch, position });
	}
	return runs;
}

function collectRuns(ctx: ExtensionContext): InspectedRun[] {
	const runs: InspectedRun[] = [];
	let dispatch = 0;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role !== "toolResult" || message.toolName !== "subagent") continue;
		dispatch++;
		runs.push(...runsFromDetails(message.details, dispatch));
	}
	return runs;
}

function status(run: InspectedRun): "running" | "failed" | "done" | "unknown" {
	if (run.result.exitCode === -1) return "running";
	if (isFailed(run.result)) return "failed";
	return run.exitCodeKnown ? "done" : "unknown";
}

function statusText(run: InspectedRun, theme: Theme): string {
	switch (status(run)) {
		case "running":
			return theme.fg("warning", "● running");
		case "failed":
			return theme.fg("error", "✗ failed");
		case "done":
			return theme.fg("success", "✓ done");
		default:
			return theme.fg("muted", "? unknown");
	}
}

function statusIcon(run: InspectedRun, theme: Theme): string {
	switch (status(run)) {
		case "running":
			return theme.fg("warning", "●");
		case "failed":
			return theme.fg("error", "✗");
		case "done":
			return theme.fg("success", "✓");
		default:
			return theme.fg("muted", "?");
	}
}

function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value ?? {});
	} catch {
		return "{…}";
	}
}

function toolCallSummary(name: string, args: unknown): string {
	const values = isRecord(args) ? args : {};
	let summary: string;
	switch (name) {
		case "bash":
			summary = stringOr(values.command, "(no command)");
			break;
		case "read":
		case "write":
		case "edit":
		case "ls":
			summary = stringOr(values.path ?? values.file_path, safeJson(values));
			break;
		case "grep":
			summary = stringOr(values.pattern, safeJson(values));
			break;
		default:
			summary = safeJson(values);
	}
	const oneLine = safeDisplayText(summary).replace(/\s+/g, " ").trim();
	return oneLine.length > 300 ? `${oneLine.slice(0, 297)}...` : oneLine;
}

function resultText(message: UnknownRecord): string {
	const content = message.content;
	const text = typeof content === "string"
		? content
		: Array.isArray(content)
			? content
					.filter((part) => isRecord(part) && part.type === "text" && typeof part.text === "string")
					.map((part) => String(part.text))
					.join("\n")
			: "";
	return safeDisplayText(text).trim();
}

function fit(text: string, width: number, pad = true): string {
	if (width <= 0) return "";
	const clipped = visibleWidth(text) > width ? truncateToWidth(text, width, "") : text;
	return pad ? truncateToWidth(clipped, width, "", true) : clipped;
}

function wrapped(text: string, width: number): string[] {
	if (width <= 0) return [];
	return wrapTextWithAnsi(text.replace(/\t/g, "   "), width).map((line) => fit(line, width, false));
}

function detailLines(run: InspectedRun, width: number, theme: Theme): string[] {
	if (width <= 0) return [];
	const contentWidth = Math.max(1, width - 2);
	const lines: string[] = [];
	const add = (text = "") => lines.push(fit(` ${text}`, width));
	const addWrapped = (text: string) => {
		for (const line of wrapped(text, contentWidth)) add(line);
	};

	add(`${statusText(run, theme)}  ${theme.fg("accent", theme.bold(run.result.agent))}`);
	addWrapped(
		theme.fg(
			"dim",
			`dispatch ${run.dispatch}${run.mode === "parallel" ? ` · parallel ${run.position + 1}` : " · single"} · ${run.result.source} · ${run.result.cwd}`,
		),
	);
	const usage = usageLine(run.result);
	if (usage) addWrapped(theme.fg("dim", usage));
	if (run.result.stopReason) addWrapped(theme.fg(status(run) === "failed" ? "error" : "muted", `stop: ${run.result.stopReason}`));
	if (run.result.errorMessage) addWrapped(theme.fg("error", `error: ${run.result.errorMessage}`));

	add();
	add(theme.fg("muted", theme.bold("Task")));
	addWrapped(run.result.task);
	add();
	add(theme.fg("muted", theme.bold("Transcript")));

	let transcriptItems = 0;
	for (const rawMessage of run.result.messages as unknown[]) {
		if (!isRecord(rawMessage)) continue;
		if (rawMessage.role === "assistant" && typeof rawMessage.content === "string" && rawMessage.content.trim()) {
			transcriptItems++;
			add(theme.fg("muted", "Assistant"));
			const markdown = new Markdown(safeDisplayText(rawMessage.content.trim()), 0, 0, getMarkdownTheme());
			for (const line of markdown.render(contentWidth)) add(fit(line, contentWidth, false));
		} else if (rawMessage.role === "assistant" && Array.isArray(rawMessage.content)) {
			for (const part of rawMessage.content) {
				if (!isRecord(part)) continue;
				if (part.type === "toolCall") {
					transcriptItems++;
					const name = stringOr(part.name, "tool");
					addWrapped(`${theme.fg("accent", "→")} ${theme.fg("toolTitle", theme.bold(name))} ${theme.fg("dim", toolCallSummary(name, part.arguments ?? part.args))}`);
				} else if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
					transcriptItems++;
					add(theme.fg("muted", "Assistant"));
					const markdown = new Markdown(safeDisplayText(part.text.trim()), 0, 0, getMarkdownTheme());
					for (const line of markdown.render(contentWidth)) add(fit(line, contentWidth, false));
				}
			}
		} else if (rawMessage.role === "toolResult") {
			transcriptItems++;
			const toolName = stringOr(rawMessage.toolName, "tool");
			const failed = rawMessage.isError === true;
			add(`${theme.fg(failed ? "error" : "success", "←")} ${theme.fg("toolTitle", toolName)}${failed ? theme.fg("error", " (error)") : ""}`);
			const output = resultText(rawMessage);
			if (!output) add(theme.fg("dim", "  (no text result)"));
			else {
				for (const outputLine of output.split("\n")) addWrapped(theme.fg("toolOutput", `  ${outputLine}`));
			}
		}
	}

	if (transcriptItems === 0) add(theme.fg("dim", "(no stored transcript)"));
	return lines.map((line) => fit(line, width));
}

class SubagentInspector implements Component {
	private selected = 0;
	private detailScroll = 0;
	private bodyHeight = 1;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly runs: InspectedRun[],
		private readonly done: () => void,
	) {}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, "q")) {
			this.done();
			return;
		}
		if (matchesKey(data, Key.up) && this.selected > 0) {
			this.selected--;
			this.detailScroll = 0;
			this.tui.requestRender();
		} else if (matchesKey(data, Key.down) && this.selected < this.runs.length - 1) {
			this.selected++;
			this.detailScroll = 0;
			this.tui.requestRender();
		} else if (matchesKey(data, Key.pageUp)) {
			this.detailScroll = Math.max(0, this.detailScroll - Math.max(1, this.bodyHeight - 2));
			this.tui.requestRender();
		} else if (matchesKey(data, Key.pageDown)) {
			this.detailScroll += Math.max(1, this.bodyHeight - 2);
			this.tui.requestRender();
		}
	}

	render(width: number): string[] {
		const height = Math.max(1, Math.min(34, Math.floor(this.tui.terminal.rows * 0.85)));
		if (width < 8 || height < 7) return this.renderSmall(width, height);

		const innerWidth = width - 2;
		const leftWidth = Math.min(34, Math.max(18, Math.floor(innerWidth * 0.3)), innerWidth - 2);
		const rightWidth = Math.max(1, innerWidth - leftWidth - 1);
		this.bodyHeight = Math.max(1, height - 6);

		const border = (text: string) => this.theme.fg("border", text);
		const paneLine = (left: string, right: string): string =>
			this.safeLine(border("│") + fit(left, leftWidth) + border("│") + fit(right, rightWidth) + border("│"), width);
		const separator = this.safeLine(
			border(`├${"─".repeat(leftWidth)}┼${"─".repeat(rightWidth)}┤`),
			width,
		);

		const title = ` ${this.theme.fg("accent", this.theme.bold("Subagent Inspector"))} `;
		const top = this.safeLine(
			border("╭") + fit(title, innerWidth, false) + border(`${"─".repeat(Math.max(0, innerWidth - visibleWidth(title)))}╮`),
			width,
		);
		const selectedRun = this.runs[this.selected]!;
		const details = detailLines(selectedRun, rightWidth, this.theme);
		const maxScroll = Math.max(0, details.length - this.bodyHeight);
		this.detailScroll = Math.min(this.detailScroll, maxScroll);
		const scrollEnd = Math.min(details.length, this.detailScroll + this.bodyHeight);

		const lines: string[] = [top];
		lines.push(
			paneLine(
				` ${this.theme.fg("muted", `Runs ${this.selected + 1}/${this.runs.length}`)}`,
				` ${this.theme.fg("muted", `Transcript ${details.length === 0 ? "0/0" : `${this.detailScroll + 1}-${scrollEnd}/${details.length}`}`)}`,
			),
		);
		lines.push(separator);

		const leftRows = this.renderRunList(leftWidth, this.bodyHeight);
		for (let row = 0; row < this.bodyHeight; row++) {
			lines.push(paneLine(leftRows[row] ?? "", details[this.detailScroll + row] ?? ""));
		}

		lines.push(separator);
		const footer = ` ${this.theme.fg("dim", "↑/↓ select  ·  PgUp/PgDn scroll  ·  Esc/q close")}`;
		lines.push(this.safeLine(border("│") + fit(footer, innerWidth) + border("│"), width));
		lines.push(this.safeLine(border(`╰${"─".repeat(innerWidth)}╯`), width));
		return lines;
	}

	private renderRunList(width: number, height: number): string[] {
		const rows = Array.from({ length: height }, () => " ".repeat(width));
		const slots = Math.max(1, Math.floor(height / 2));
		const start = Math.max(0, Math.min(this.selected - Math.floor(slots / 2), this.runs.length - slots));
		const end = Math.min(this.runs.length, start + slots);

		for (let index = start; index < end; index++) {
			const run = this.runs[index]!;
			const row = (index - start) * 2;
			const selected = index === this.selected;
			const first = fit(` ${selected ? "›" : " "} ${statusIcon(run, this.theme)} ${this.theme.fg(selected ? "accent" : "text", run.result.agent)}`, width);
			const task = fit(`    ${this.theme.fg("dim", run.result.task.replace(/\s+/g, " "))}`, width);
			rows[row] = selected ? this.theme.bg("selectedBg", first) : first;
			if (row + 1 < rows.length) rows[row + 1] = selected ? this.theme.bg("selectedBg", task) : task;
		}
		return rows.map((line) => fit(line, width));
	}

	private renderSmall(width: number, height: number): string[] {
		const run = this.runs[this.selected]!;
		const candidates = [
			this.theme.fg("accent", "Subagent Inspector"),
			`${statusIcon(run, this.theme)} ${run.result.agent}`,
			run.result.task,
			this.theme.fg("dim", "↑/↓ select · Esc/q close"),
		];
		return candidates.slice(0, height).map((line) => this.safeLine(line, width));
	}

	private safeLine(line: string, width: number): string {
		if (width <= 0) return "";
		const clipped = visibleWidth(line) > width ? truncateToWidth(line, width, "") : line;
		return truncateToWidth(clipped, width, "", true);
	}

	invalidate(): void {
		// Rendering is computed from the current theme on every frame.
	}
}

/** Open a browser for subagent runs stored on the current parent-session branch. */
export async function openSubagentInspector(ctx: ExtensionContext): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("The subagent inspector is only available in TUI mode.", "warning");
		return;
	}

	const runs = collectRuns(ctx);
	if (runs.length === 0) {
		ctx.ui.notify("No stored subagent runs were found on the current session branch.", "info");
		return;
	}

	await ctx.ui.custom<void>(
		(tui, theme, _keybindings, done) => new SubagentInspector(tui, theme, runs, done),
		{
			overlay: true,
			overlayOptions: {
				anchor: "center",
				width: "88%",
				maxHeight: "85%",
				margin: 1,
			},
		},
	);
}
