/**
 * Child process runner: spawns `pi --mode json -p --no-session` per task,
 * streams JSONL events, accumulates messages + usage, handles abort.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message, Usage } from "@earendil-works/pi-ai";

export const MAX_PARALLEL_TASKS = 8;
export const MAX_CONCURRENCY = 4;
export const DEPTH_ENV = "PI_SUBAGENT_DEPTH";
export const MAX_DEPTH_ENV = "PI_SUBAGENT_MAX_DEPTH";

export interface RunResult {
	id: string;
	agent: string;
	source: "user" | "project" | "unknown";
	task: string;
	cwd: string;
	/** -1 while queued/running, process exit code once finished */
	exitCode: number;
	startedAt?: number;
	completedAt?: number;
	messages: Message[];
	stderr: string;
	usage: Usage;
	turns: number;
	contextTokens: number;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
}

export interface RunOptions {
	id: string;
	agentName: string;
	source: "user" | "project";
	task: string;
	systemPrompt: string;
	cwd: string;
	model?: string;
	thinking?: string;
	tools?: string[];
	signal?: AbortSignal;
	onEvent?: (result: RunResult) => void;
}

export function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

export function addUsage(total: Usage, delta: Usage): void {
	total.input += delta.input || 0;
	total.output += delta.output || 0;
	total.cacheRead += delta.cacheRead || 0;
	total.cacheWrite += delta.cacheWrite || 0;
	total.totalTokens += delta.totalTokens || 0;
	total.cost.input += delta.cost?.input || 0;
	total.cost.output += delta.cost?.output || 0;
	total.cost.cacheRead += delta.cost?.cacheRead || 0;
	total.cost.cacheWrite += delta.cost?.cacheWrite || 0;
	total.cost.total += delta.cost?.total || 0;
}

export function isFailed(result: RunResult): boolean {
	return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

export function finalText(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "assistant") continue;
		const text = msg.content
			.filter((part) => part.type === "text" && part.text.trim())
			.map((part) => (part as { type: "text"; text: string }).text)
			.join("\n");
		if (text) return text;
	}
	return "";
}

/** Resolve how to invoke pi, mirroring how the current process was started. */
function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = path.basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(execName)) {
		return { command: process.execPath, args };
	}
	return { command: "pi", args };
}

export async function runAgent(options: RunOptions): Promise<RunResult> {
	const result: RunResult = {
		id: options.id,
		agent: options.agentName,
		source: options.source,
		task: options.task,
		cwd: options.cwd,
		exitCode: -1,
		startedAt: Date.now(),
		messages: [],
		stderr: "",
		usage: emptyUsage(),
		turns: 0,
		contextTokens: 0,
		model: options.model,
	};
	options.onEvent?.(result);

	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	if (options.model) args.push("--model", options.model);
	if (options.thinking) args.push("--thinking", options.thinking);
	if (options.tools && options.tools.length > 0) args.push("--tools", options.tools.join(","));

	let tmpDir: string | null = null;
	if (options.systemPrompt.trim()) {
		tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
		const promptPath = path.join(tmpDir, "system-prompt.md");
		await fs.promises.writeFile(promptPath, options.systemPrompt, { encoding: "utf-8", mode: 0o600 });
		args.push("--append-system-prompt", promptPath);
	}
	args.push(`Task: ${options.task}`);

	const depth = Number.parseInt(process.env[DEPTH_ENV] ?? "0", 10) || 0;

	try {
		let wasAborted = false;
		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: options.cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env, [DEPTH_ENV]: String(depth + 1) },
			});

			let buffer = "";
			const seenToolResults = new Set<string>();
			let closed = false;
			let killTimer: NodeJS.Timeout | undefined;
			let abortHandler: (() => void) | undefined;
			const settle = (code: number) => {
				if (closed) return;
				closed = true;
				if (killTimer) clearTimeout(killTimer);
				if (options.signal && abortHandler) options.signal.removeEventListener("abort", abortHandler);
				resolve(code);
			};
			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}
				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					if (msg.role === "toolResult") {
						if (seenToolResults.has(msg.toolCallId)) return;
						seenToolResults.add(msg.toolCallId);
						if (msg.usage) addUsage(result.usage, msg.usage);
					}
					result.messages.push(msg);
					if (msg.role === "assistant") {
						result.turns++;
						if (msg.usage) {
							addUsage(result.usage, msg.usage);
							result.contextTokens = msg.usage.totalTokens || result.contextTokens;
						}
						if (!result.model && msg.model) result.model = msg.model;
						if (msg.stopReason) result.stopReason = msg.stopReason;
						if (msg.errorMessage) result.errorMessage = msg.errorMessage;
					}
					options.onEvent?.(result);
				} else if (event.type === "tool_result_end" && event.message) {
					const msg = event.message as Message;
					if (msg.role === "toolResult") {
						if (seenToolResults.has(msg.toolCallId)) return;
						seenToolResults.add(msg.toolCallId);
						if (msg.usage) addUsage(result.usage, msg.usage);
					}
					result.messages.push(msg);
					options.onEvent?.(result);
				}
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});
			proc.stderr.on("data", (data) => {
				result.stderr += data.toString();
			});
			proc.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				settle(code ?? 1);
			});
			proc.on("error", (err) => {
				result.stderr += `${result.stderr ? "\n" : ""}spawn failed: ${err.message}`;
				settle(1);
			});

			if (options.signal) {
				abortHandler = () => {
					if (closed) return;
					wasAborted = true;
					proc.kill("SIGTERM");
					killTimer = setTimeout(() => {
						if (!closed && proc.exitCode === null) proc.kill("SIGKILL");
					}, 5000);
					killTimer.unref();
				};
				if (options.signal.aborted) abortHandler();
				else options.signal.addEventListener("abort", abortHandler, { once: true });
			}
		});

		result.exitCode = exitCode;
		result.completedAt = Date.now();
		if (wasAborted) {
			result.stopReason = "aborted";
			result.errorMessage ??= "Subagent was aborted";
		}
		options.onEvent?.(result);
		return result;
	} finally {
		if (tmpDir) fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
	}
}

/**
 * Process-wide semaphore so concurrent subagent children stay bounded even when
 * pi executes several `subagent` tool calls from one assistant message in parallel.
 */
let running = 0;
const waiters: (() => void)[] = [];

export async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
	if (running < MAX_CONCURRENCY) {
		running++;
	} else {
		// The releasing task hands its slot over without decrementing `running`.
		await new Promise<void>((resolve) => waiters.push(resolve));
	}
	try {
		return await fn();
	} finally {
		const next = waiters.shift();
		if (next) next();
		else running--;
	}
}
