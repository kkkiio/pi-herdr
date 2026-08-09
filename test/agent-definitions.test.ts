import { mkdir, mkdtemp, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AgentDefinitionStore } from "../src/agent-definitions.js";

describe("AgentDefinitionStore", () => {
	let sandbox: string;
	let project: string;
	let globalDir: string;
	let bundledDir: string;

	beforeEach(async () => {
		sandbox = await mkdtemp(join(tmpdir(), "pi-herdr-definitions-"));
		project = join(sandbox, "project");
		globalDir = join(sandbox, "global");
		bundledDir = join(sandbox, "package", "agents");
		await Promise.all([
			mkdir(join(project, ".pi", "agents"), { recursive: true }),
			mkdir(join(project, ".agents", "agents"), { recursive: true }),
			mkdir(globalDir, { recursive: true }),
			mkdir(bundledDir, { recursive: true }),
		]);
	});

	afterEach(async () => {
		await rm(sandbox, { recursive: true, force: true });
	});

	it("loads absolute and explicit relative paths independently from catalog discovery", async () => {
		const definitionPath = join(project, ".pi", "agents", "Builder.md");
		await writeFile(
			definitionPath,
			"---\ndescription: Implements a bounded change\nmodel: [provider/model-a, provider/model-b]\nthinking: max\ntools: [read, bash]\nextensions: true\nskills: false\ndisallowed_tools: [write]\nenabled: true\n---\n\nBuild the requested change.\n",
			"utf8",
		);
		const store = new AgentDefinitionStore({ globalDir, bundledDir });

		await expect(store.load(definitionPath, join(sandbox, "elsewhere"))).resolves.toEqual({
			name: "Builder",
			source: "path",
			path: definitionPath,
			prompt: "Build the requested change.",
			description: "Implements a bounded change",
			model: ["provider/model-a", "provider/model-b"],
			thinking: "max",
			tools: ["read", "bash"],
			extensions: true,
			skills: false,
			disallowed_tools: ["write"],
			enabled: true,
		});
		await expect(store.load("./.pi/agents/Builder.md", project)).resolves.toMatchObject({
			source: "path",
			path: definitionPath,
		});
	});

	it("resolves bare names from global then bundled and rereads selected content", async () => {
		const global = join(globalDir, "worker.md");
		const bundled = join(bundledDir, "worker.md");
		await writeFile(global, "---\ndescription: global\n---\nfirst", "utf8");
		await writeFile(bundled, "---\ndescription: bundled\n---\nfallback", "utf8");
		const store = new AgentDefinitionStore({ globalDir, bundledDir });

		await expect(store.load("WORKER", project)).resolves.toMatchObject({ source: "global", prompt: "first" });
		await writeFile(global, "---\ndescription: changed\n---\nlatest", "utf8");
		await expect(store.load("worker", project)).resolves.toMatchObject({ source: "global", prompt: "latest" });
		await unlink(global);
		await expect(store.load("worker", project)).resolves.toMatchObject({ source: "bundled", prompt: "fallback" });
	});

	it("does not automatically select project definitions by bare name", async () => {
		const projectDefinition = join(project, ".agents", "agents", "reviewer.md");
		await writeFile(projectDefinition, "---\ndescription: project reviewer\n---\nreview", "utf8");
		const store = new AgentDefinitionStore({ globalDir, bundledDir });

		await expect(store.load("reviewer", project)).rejects.toThrow(/was not found/);
		await expect(store.load("./.agents/agents/reviewer.md", project)).resolves.toMatchObject({
			source: "path",
			path: projectDefinition,
		});
	});

	it.each([
		["implicit relative path", "agents/reviewer.md", /catalog name or an absolute\/explicit relative/],
		["ambiguous Markdown name", "reviewer.md", /catalog name or an absolute\/explicit relative/],
		["non-Markdown explicit path", "./reviewer.txt", /must end with \.md/],
		["surrounding whitespace", " reviewer ", /without surrounding whitespace/],
	])("rejects %s selectors", async (_caseName, selector, expected) => {
		const store = new AgentDefinitionStore({ globalDir, bundledDir });
		await expect(store.load(selector, project)).rejects.toThrow(expected as RegExp);
	});

	it("requires explicit paths to reference regular files", async () => {
		await mkdir(join(project, "directory.md"));
		const store = new AgentDefinitionStore({ globalDir, bundledDir });

		await expect(store.load("./directory.md", project)).rejects.toThrow(/not a regular file/);
		await expect(store.load("./missing.md", project)).rejects.toThrow(/Cannot read selected agent definition/);
	});

	it("builds an effective global-first catalog with descriptions", async () => {
		await Promise.all([
			writeFile(join(globalDir, "reviewer.md"), "---\ndescription: Global reviewer\n---\nglobal", "utf8"),
			writeFile(join(globalDir, "builder.md"), "---\ndescription: Builder\n---\nbuild", "utf8"),
			writeFile(join(bundledDir, "Reviewer.md"), "---\ndescription: Bundled reviewer\n---\nbundled", "utf8"),
			writeFile(join(bundledDir, "explorer.md"), "---\ndescription: Explorer\n---\nexplore", "utf8"),
		]);
		const store = new AgentDefinitionStore({ globalDir, bundledDir });

		await expect(store.catalog()).resolves.toEqual({
			entries: [
				{ name: "builder", description: "Builder" },
				{ name: "reviewer", description: "Global reviewer" },
				{ name: "explorer", description: "Explorer" },
			],
			diagnostics: [],
		});
	});

	it("keeps malformed and disabled global names from falling back to bundled", async () => {
		await Promise.all([
			writeFile(join(globalDir, "reviewer.md"), "---\nunknown: true\n---\ninvalid", "utf8"),
			writeFile(join(globalDir, "worker.md"), "---\nenabled: false\n---\ndisabled", "utf8"),
			writeFile(join(bundledDir, "reviewer.md"), "---\ndescription: fallback\n---\nvalid", "utf8"),
			writeFile(join(bundledDir, "worker.md"), "---\ndescription: fallback\n---\nvalid", "utf8"),
		]);
		const store = new AgentDefinitionStore({ globalDir, bundledDir });

		const catalog = await store.catalog();
		expect(catalog.entries).toEqual([]);
		expect(catalog.diagnostics.join("\n")).toMatch(/unknown field "unknown"/);
		expect(catalog.diagnostics.join("\n")).toMatch(/worker is disabled/);
		await expect(store.load("reviewer", project)).rejects.toThrow(/unknown field "unknown"/);
		await expect(store.load("worker", project)).resolves.toMatchObject({ source: "global", enabled: false });
	});

	it("reports same-source case conflicts without consulting bundled fallback", async () => {
		await Promise.all([
			writeFile(join(globalDir, "Explorer.md"), "---\n---\nupper", "utf8"),
			writeFile(join(globalDir, "explorer.md"), "---\n---\nlower", "utf8"),
			writeFile(join(bundledDir, "explorer.md"), "---\n---\nbundled", "utf8"),
		]);
		if ((await readdir(globalDir)).filter((entry) => entry.toLowerCase() === "explorer.md").length < 2) return;
		const store = new AgentDefinitionStore({ globalDir, bundledDir });
		const catalog = await store.catalog();

		expect(catalog.entries).toEqual([]);
		expect(catalog.diagnostics.join("\n")).toMatch(/Conflicting global.*Explorer\.md.*explorer\.md/);
		await expect(store.load("explorer", project)).rejects.toThrow(/Conflicting global/);
	});

	it.each([
		["unknown field", "legacy: true", /unknown field "legacy"/],
		["blank description", 'description: "   "', /description must be a non-empty string/],
		["thinking enum", "thinking: ultra", /thinking must be one of/],
		["tools CSV", "tools: read,bash", /tools must be a string array/],
		["mixed all tool allowlist", "tools: [all, read]", /tools "all" must be the only entry/],
		["extensions array", "extensions: [./local.ts]", /extensions must be a boolean/],
		["skills scalar", "skills: local-skill", /skills must be a boolean/],
		["model number", "model: 42", /model must be a string or string array/],
		["empty model candidates", "model: []", /at least one non-empty entry/],
		["enabled string", "enabled: yes-please", /enabled must be a boolean/],
		["denylist CSV", "disallowed_tools: bash,write", /disallowed_tools must be a string array/],
	])("rejects %s", async (_caseName, field, expectedError) => {
		const definitionPath = join(project, ".pi", "agents", "strict.md");
		await writeFile(definitionPath, `---\n${field}\n---\nprompt`, "utf8");
		const store = new AgentDefinitionStore({ globalDir, bundledDir });

		await expect(store.load(definitionPath, project)).rejects.toThrow(expectedError as RegExp);
	});

	it("strictly loads both definitions shipped by the package", async () => {
		const store = new AgentDefinitionStore({ globalDir });

		await expect(store.load("explorer", project)).resolves.toMatchObject({
			source: "bundled",
			tools: ["read", "bash", "grep", "find", "ls"],
			extensions: false,
			skills: false,
			enabled: true,
		});
		await expect(store.load("general-purpose", project)).resolves.toMatchObject({
			source: "bundled",
			tools: ["all"],
			extensions: true,
			skills: true,
			enabled: true,
		});
	});

	it("reports missing and malformed frontmatter explicitly", async () => {
		const store = new AgentDefinitionStore({ globalDir, bundledDir });
		await expect(store.load("missing", project)).rejects.toThrow(/was not found/);

		await writeFile(join(globalDir, "plain.md"), "No frontmatter here.", "utf8");
		await expect(store.load("plain", project)).rejects.toThrow(/missing YAML frontmatter/);
		await writeFile(join(globalDir, "sequence.md"), "---\n- description\n---\nprompt", "utf8");
		await expect(store.load("sequence", project)).rejects.toThrow(/frontmatter must be a mapping/);
	});

	it("accepts empty frontmatter and resolves relative cwd before explicit paths", async () => {
		const nested = join(project, "packages", "worker");
		await mkdir(nested, { recursive: true });
		await writeFile(join(project, "empty.md"), "---\n---\nprompt only", "utf8");
		const store = new AgentDefinitionStore({ globalDir, bundledDir });

		await expect(store.load("../../empty.md", nested)).resolves.toEqual({
			name: "empty",
			source: "path",
			path: resolve(project, "empty.md"),
			prompt: "prompt only",
		});
	});
});
