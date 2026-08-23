import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

export interface AgentDefinition {
	description?: string;
	model?: string | string[];
	thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	tools?: string[];
	extensions?: boolean;
	skills?: boolean;
	disallowed_tools?: string[];
	enabled?: boolean;
}

export interface ResolvedAgentDefinition extends AgentDefinition {
	name: string;
	source: "path" | "global" | "bundled" | "default";
	path: string;
	prompt: string;
}

// No definition selected: plain Pi defaults — no prompt file, no tool
// allowlist, model and thinking inherited from the caller.
const DEFAULT_DEFINITION: ResolvedAgentDefinition = {
	name: "default",
	source: "default",
	path: "",
	prompt: "",
};

type DefinitionSource = ResolvedAgentDefinition["source"];

interface DefinitionLocation {
	source: DefinitionSource;
	directory: string;
}

export interface AgentDefinitionCatalogEntry {
	name: string;
	description?: string;
}

export interface AgentDefinitionCatalog {
	entries: AgentDefinitionCatalogEntry[];
	diagnostics: string[];
}

/** Finds and strictly validates agent definitions without caching file contents. */
export class AgentDefinitionStore {
	private readonly globalDir: string;
	private readonly bundledDir: string;

	constructor(
		options: {
			globalDir?: string;
			bundledDir?: string;
		} = {},
	) {
		this.globalDir = resolve(options.globalDir ?? join(homedir(), ".pi", "agent", "agents"));
		this.bundledDir = resolve(options.bundledDir ?? fileURLToPath(new URL("../agents", import.meta.url)));
	}

	async load(selector: string | undefined, cwd: string): Promise<ResolvedAgentDefinition> {
		if (selector === undefined) return DEFAULT_DEFINITION;
		if (typeof selector !== "string" || !selector.trim() || selector.trim() !== selector) {
			throw new Error("Agent definition selector must contain visible text without surrounding whitespace.");
		}
		const explicitPath = isAbsolute(selector) || /^(?:\.\/|\.\.\/)/.test(selector);
		if (explicitPath) {
			if (!selector.toLowerCase().endsWith(".md")) {
				throw new Error(`Explicit Agent definition path must end with .md: ${selector}`);
			}
			const definitionPath = isAbsolute(selector) ? resolve(selector) : resolve(cwd, selector);
			const filename = basename(definitionPath);
			return this.readDefinition(definitionPath, filename.slice(0, -3), "path");
		}
		if (selector.includes("/") || selector.includes("\\") || selector.toLowerCase().endsWith(".md")) {
			throw new Error(
				`Invalid Agent definition selector "${selector}"; use a catalog name or an absolute/explicit relative .md path.`,
			);
		}

		const definition = await this.loadFromLocations(selector, [
			{ source: "global", directory: this.globalDir },
			{ source: "bundled", directory: this.bundledDir },
		]);
		if (definition === undefined) throw new Error(`Agent definition "${selector}" was not found`);
		return definition;
	}

	async catalog(): Promise<AgentDefinitionCatalog> {
		const entries: AgentDefinitionCatalogEntry[] = [];
		const diagnostics: string[] = [];
		const claimed = new Set<string>();
		for (const location of [
			{ source: "global" as const, directory: this.globalDir },
			{ source: "bundled" as const, directory: this.bundledDir },
		]) {
			let directoryEntries;
			try {
				directoryEntries = await readdir(location.directory, { withFileTypes: true });
			} catch (error) {
				if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
					continue;
				}
				diagnostics.push(
					`Cannot catalog ${location.source} Agent definitions in ${location.directory}: ${error instanceof Error ? error.message : String(error)}`,
				);
				continue;
			}
			const grouped = Map.groupBy(
				directoryEntries
					.filter((entry) => !entry.isDirectory() && entry.name.toLowerCase().endsWith(".md"))
					.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0)),
				(entry) => entry.name.slice(0, -3).toLowerCase(),
			);
			for (const [normalizedName, matches] of [...grouped.entries()].sort(([left], [right]) =>
				left < right ? -1 : left > right ? 1 : 0,
			)) {
				if (claimed.has(normalizedName)) continue;
				claimed.add(normalizedName);
				if (!normalizedName || matches.length > 1) {
					diagnostics.push(
						matches.length > 1
							? `Conflicting ${location.source} Agent definitions for "${normalizedName}": ${matches.map((entry) => entry.name).join(", ")}`
							: `Invalid ${location.source} Agent definition filename: ${matches[0]?.name ?? ".md"}`,
					);
					continue;
				}
				const selected = matches[0];
				if (!selected) continue;
				const selectedName = selected.name.slice(0, -3);
				if (
					selectedName.trim() !== selectedName ||
					selectedName.includes("\\") ||
					selectedName.toLowerCase().endsWith(".md")
				) {
					diagnostics.push(`Invalid ${location.source} Agent definition name: ${selected.name}`);
					continue;
				}
				try {
					const definition = await this.readDefinition(
						join(location.directory, selected.name),
						selectedName,
						location.source,
					);
					if (definition.enabled === false) {
						diagnostics.push(`Agent definition ${definition.name} is disabled: ${definition.path}`);
						continue;
					}
					entries.push({ name: definition.name, description: definition.description });
				} catch (error) {
					diagnostics.push(error instanceof Error ? error.message : String(error));
				}
			}
		}
		return { entries, diagnostics };
	}

	private async loadFromLocations(
		name: string,
		locations: readonly DefinitionLocation[],
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
				.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));

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

		return undefined;
	}

	private async readDefinition(
		definitionPath: string,
		name: string,
		source: DefinitionSource,
	): Promise<ResolvedAgentDefinition> {
		let content: string;
		try {
			const metadata = await stat(definitionPath);
			if (!metadata.isFile()) throw new Error("path is not a regular file");
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
					if (typeof value !== "boolean") {
						throw new Error(`Invalid agent definition ${definitionPath}: ${field} must be a boolean`);
					}
					if (field === "extensions") {
						definition.extensions = value;
					} else {
						definition.skills = value;
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
