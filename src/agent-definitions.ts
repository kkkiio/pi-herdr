import { execFileSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

export interface AgentDefinition {
	description?: string;
	model?: string | string[];
	thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	tools?: string[];
	extensions?: boolean | string[];
	skills?: boolean | string[];
	disallowed_tools?: string[];
	enabled?: boolean;
}

export interface ResolvedAgentDefinition extends AgentDefinition {
	name: string;
	source: "project-pi" | "project-agents" | "global" | "bundled";
	path: string;
	prompt: string;
}

type DefinitionSource = ResolvedAgentDefinition["source"];

interface DefinitionLocation {
	source: DefinitionSource;
	directory: string;
}

/** Finds and strictly validates agent definitions without caching file contents. */
export class AgentDefinitionStore {
	readonly root: string;

	private readonly globalDir: string;
	private readonly bundledDir: string;

	constructor(
		options: {
			cwd?: string;
			root?: string;
			globalDir?: string;
			bundledDir?: string;
		} = {},
	) {
		const cwd = resolve(options.cwd ?? process.cwd());
		let detectedRoot = cwd;

		if (options.root === undefined) {
			try {
				const topLevel = execFileSync("git", ["rev-parse", "--show-toplevel"], {
					cwd,
					encoding: "utf8",
					stdio: ["ignore", "pipe", "ignore"],
				}).trim();
				if (topLevel.length > 0) {
					detectedRoot = topLevel;
				}
			} catch {
				detectedRoot = cwd;
			}
		}

		this.root = resolve(options.root ?? detectedRoot);
		this.globalDir = resolve(options.globalDir ?? join(homedir(), ".pi", "agent", "agents"));
		this.bundledDir = resolve(options.bundledDir ?? fileURLToPath(new URL("../agents", import.meta.url)));
	}

	async load(name: string): Promise<ResolvedAgentDefinition> {
		const definition = await this.loadFromLocations(
			name,
			[
				{ source: "project-pi", directory: join(this.root, ".pi", "agents") },
				{ source: "project-agents", directory: join(this.root, ".agents", "agents") },
				{ source: "global", directory: this.globalDir },
				{ source: "bundled", directory: this.bundledDir },
			],
			false,
		);

		if (definition === undefined) {
			throw new Error(`Agent definition "${name}" was not found`);
		}
		return definition;
	}

	async loadBundled(name: string): Promise<ResolvedAgentDefinition | undefined> {
		return this.loadFromLocations(name, [{ source: "bundled", directory: this.bundledDir }], true);
	}

	private async loadFromLocations(
		name: string,
		locations: readonly DefinitionLocation[],
		allowMissing: boolean,
	): Promise<ResolvedAgentDefinition | undefined> {
		if (
			name.length === 0 ||
			name.trim() !== name ||
			name.includes("/") ||
			name.includes("\\") ||
			name.toLowerCase().endsWith(".md")
		) {
			throw new Error(`Invalid agent definition name "${name}"`);
		}

		const expectedName = name.toLowerCase();
		for (const location of locations) {
			let entries;
			try {
				entries = await readdir(location.directory, { withFileTypes: true });
			} catch (error) {
				if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
					continue;
				}
				const message = error instanceof Error ? error.message : String(error);
				throw new Error(`Cannot search ${location.source} agent definitions in ${location.directory}: ${message}`);
			}

			const matches = entries
				.filter((entry) => {
					if (entry.isDirectory() || !entry.name.toLowerCase().endsWith(".md")) {
						return false;
					}
					return entry.name.slice(0, -3).toLowerCase() === expectedName;
				})
				.sort((left, right) => left.name.localeCompare(right.name));

			if (matches.length > 1) {
				throw new Error(
					`Conflicting ${location.source} agent definitions for "${name}": ${matches
						.map((entry) => entry.name)
						.join(", ")}`,
				);
			}
			if (matches.length === 0) {
				continue;
			}

			const selected = matches[0];
			if (selected === undefined) {
				throw new Error(`Agent definition discovery failed unexpectedly for "${name}"`);
			}
			return this.readDefinition(join(location.directory, selected.name), selected.name.slice(0, -3), location.source);
		}

		if (allowMissing) {
			return undefined;
		}
		throw new Error(
			`Agent definition "${name}" was not found in ${locations.map((location) => location.directory).join(", ")}`,
		);
	}

	private async readDefinition(
		definitionPath: string,
		name: string,
		source: DefinitionSource,
	): Promise<ResolvedAgentDefinition> {
		let content: string;
		try {
			content = await readFile(definitionPath, "utf8");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`Cannot read selected agent definition ${definitionPath}: ${message}`);
		}

		const frontmatter = /^---\r?\n(?:---(?:\r?\n|$)|([\s\S]*?)\r?\n---(?:\r?\n|$))/.exec(content);
		if (frontmatter === null) {
			throw new Error(`Invalid agent definition ${definitionPath}: missing YAML frontmatter`);
		}

		let parsed: unknown;
		try {
			parsed = parse(frontmatter[1] ?? "", {
				maxAliasCount: 0,
				merge: false,
				prettyErrors: true,
				schema: "core",
				stringKeys: true,
				uniqueKeys: true,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`Invalid YAML in agent definition ${definitionPath}: ${message}`);
		}

		if (parsed === null) {
			parsed = {};
		}
		if (typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error(`Invalid agent definition ${definitionPath}: frontmatter must be a mapping`);
		}

		const definition: AgentDefinition = {};
		const thinkingLevels = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
		for (const [field, value] of Object.entries(parsed as Record<string, unknown>)) {
			switch (field) {
				case "description":
					if (typeof value !== "string" || !value.trim()) {
						throw new Error(`Invalid agent definition ${definitionPath}: description must be a non-empty string`);
					}
					definition.description = value;
					break;
				case "model":
					if (typeof value === "string" && value.trim()) {
						definition.model = value;
						break;
					}
					if (
						!Array.isArray(value) ||
						value.length === 0 ||
						!value.every((candidate) => typeof candidate === "string" && candidate.trim())
					) {
						throw new Error(
							`Invalid agent definition ${definitionPath}: model must be a string or string array with at least one non-empty entry`,
						);
					}
					definition.model = [...value];
					break;
				case "thinking":
					if (typeof value !== "string" || !thinkingLevels.has(value)) {
						throw new Error(
							`Invalid agent definition ${definitionPath}: thinking must be one of off, minimal, low, medium, high, xhigh, max`,
						);
					}
					definition.thinking = value as AgentDefinition["thinking"];
					break;
				case "tools":
				case "disallowed_tools":
					if (!Array.isArray(value) || !value.every((tool) => typeof tool === "string" && tool.trim())) {
						throw new Error(`Invalid agent definition ${definitionPath}: ${field} must be a string array`);
					}
					if (field === "tools") {
						if (value.includes("all") && (value.length !== 1 || value[0] !== "all")) {
							throw new Error(`Invalid agent definition ${definitionPath}: tools "all" must be the only entry`);
						}
						definition.tools = [...value];
					} else {
						definition.disallowed_tools = [...value];
					}
					break;
				case "extensions":
				case "skills": {
					if (typeof value === "boolean") {
						if (field === "extensions") {
							definition.extensions = value;
						} else {
							definition.skills = value;
						}
						break;
					}
					if (!Array.isArray(value) || !value.every((resource) => typeof resource === "string" && resource.trim())) {
						throw new Error(`Invalid agent definition ${definitionPath}: ${field} must be a boolean or string array`);
					}
					const resolvedResources = value.map((resource) =>
						isAbsolute(resource) ? resource : resolve(dirname(definitionPath), resource),
					);
					if (field === "extensions") {
						definition.extensions = resolvedResources;
					} else {
						definition.skills = resolvedResources;
					}
					break;
				}
				case "enabled":
					if (typeof value !== "boolean") {
						throw new Error(`Invalid agent definition ${definitionPath}: enabled must be a boolean`);
					}
					definition.enabled = value;
					break;
				default:
					throw new Error(`Invalid agent definition ${definitionPath}: unknown field "${field}"`);
			}
		}

		return {
			...definition,
			name,
			source,
			path: definitionPath,
			prompt: content.slice(frontmatter[0].length).trim(),
		};
	}
}
