/**
 * Agent discovery: markdown + YAML frontmatter definitions.
 *
 * User agents:    ~/.pi/agent/agents/*.md  (always loaded)
 * Project agents: nearest .pi/agents/*.md walking up from cwd
 *                 (loaded only when the project is trusted; overrides user agents by name)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	thinking?: string;
	systemPrompt: string;
	source: "user" | "project";
	filePath: string;
}

export interface DiscoveryResult {
	agents: AgentConfig[];
	userDir: string;
	projectDir: string | null;
	projectTrusted: boolean;
}

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function loadAgentsFromDir(dir: string, source: "user" | "project"): AgentConfig[] {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}

	const agents: AgentConfig[] = [];
	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		try {
			const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(content);
			const name = typeof frontmatter.name === "string" ? frontmatter.name.trim() : "";
			const description = typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";
			if (!name || !description) continue;

			const rawTools = frontmatter.tools;
			const tools = (Array.isArray(rawTools)
				? rawTools.filter((tool): tool is string => typeof tool === "string")
				: typeof rawTools === "string"
					? rawTools.split(",")
					: [])
				.map((tool) => tool.trim())
				.filter(Boolean);
			const rawThinking = typeof frontmatter.thinking === "string" ? frontmatter.thinking.trim() : "";
			const thinking = THINKING_LEVELS.has(rawThinking) ? rawThinking : undefined;
			const model = typeof frontmatter.model === "string" ? frontmatter.model.trim() || undefined : undefined;

			agents.push({
				name,
				description,
				tools: tools.length > 0 ? tools : undefined,
				model,
				thinking,
				systemPrompt: body,
				source,
				filePath,
			});
		} catch {
			// A malformed definition must not prevent discovery of the other agents.
			continue;
		}
	}
	return agents;
}

function findProjectAgentsDir(cwd: string): string | null {
	let dir = path.resolve(cwd);
	while (true) {
		const candidate = path.join(dir, CONFIG_DIR_NAME, "agents");
		try {
			if (fs.statSync(candidate).isDirectory()) return candidate;
		} catch {
			/* keep walking */
		}
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

export function discoverAgents(cwd: string, projectTrusted: boolean): DiscoveryResult {
	const userDir = path.join(getAgentDir(), "agents");
	const projectDir = findProjectAgentsDir(cwd);

	const byName = new Map<string, AgentConfig>();
	for (const agent of loadAgentsFromDir(userDir, "user")) byName.set(agent.name, agent);
	if (projectDir && projectTrusted) {
		for (const agent of loadAgentsFromDir(projectDir, "project")) byName.set(agent.name, agent);
	}

	return { agents: Array.from(byName.values()), userDir, projectDir, projectTrusted };
}

export function formatRoster(discovery: DiscoveryResult): string {
	if (discovery.agents.length === 0) return "(none found)";
	return discovery.agents.map((a) => `- ${a.name} (${a.source}): ${a.description}`).join("\n");
}
