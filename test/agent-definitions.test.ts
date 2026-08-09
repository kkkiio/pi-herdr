import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AgentDefinitionStore } from "../src/agent-definitions.js";

describe("AgentDefinitionStore", () => {
	let sandbox: string;
	let root: string;
	let globalDir: string;
	let bundledDir: string;

	beforeEach(async () => {
		sandbox = await mkdtemp(join(tmpdir(), "pi-herdr-definitions-"));
		root = join(sandbox, "project");
		globalDir = join(sandbox, "global");
		bundledDir = join(sandbox, "package", "agents");
		await Promise.all([
			mkdir(join(root, ".pi", "agents"), { recursive: true }),
			mkdir(join(root, ".agents", "agents"), { recursive: true }),
			mkdir(globalDir, { recursive: true }),
			mkdir(bundledDir, { recursive: true }),
		]);
	});

	afterEach(async () => {
		await rm(sandbox, { recursive: true, force: true });
	});

	it("loads the closed schema and resolves relative extension and skill resources", async () => {
		const definitionPath = join(root, ".pi", "agents", "Builder.md");
		const absoluteExtension = join(sandbox, "shared", "extension.ts");
		await writeFile(
			definitionPath,
			`---\n` +
				`description: Implements a bounded change\n` +
				`model: [provider/model-a, provider/model-b]\n` +
				`thinking: max\n` +
				`tools: [read, bash]\n` +
				`extensions: [./extensions/local.ts, ${absoluteExtension}]\n` +
				`skills: [../skills/review]\n` +
				`disallowed_tools: [write]\n` +
				`enabled: false\n` +
				`---\n\nBuild the requested change.\n`,
			"utf8",
		);

		const store = new AgentDefinitionStore({ root, globalDir, bundledDir });
		const definition = await store.load("builder");

		expect(definition).toEqual({
			name: "Builder",
			source: "project-pi",
			path: definitionPath,
			prompt: "Build the requested change.",
			description: "Implements a bounded change",
			model: ["provider/model-a", "provider/model-b"],
			thinking: "max",
			tools: ["read", "bash"],
			extensions: [resolve(join(dirname(definitionPath), "extensions/local.ts")), absoluteExtension],
			skills: [resolve(join(dirname(definitionPath), "../skills/review"))],
			disallowed_tools: ["write"],
			enabled: false,
		});
		expect(isAbsolute((definition.extensions as string[])[0] ?? "")).toBe(true);
	});

	it("uses all four discovery layers in order and reads the filesystem on every load", async () => {
		const projectPi = join(root, ".pi", "agents", "worker.md");
		const projectAgents = join(root, ".agents", "agents", "worker.md");
		const global = join(globalDir, "worker.md");
		const bundled = join(bundledDir, "worker.md");
		await Promise.all([
			writeFile(projectPi, "---\ndescription: project pi\n---\nfirst", "utf8"),
			writeFile(projectAgents, "---\ndescription: project agents\n---\nsecond", "utf8"),
			writeFile(global, "---\ndescription: global\n---\nthird", "utf8"),
			writeFile(bundled, "---\ndescription: bundled\n---\nfourth", "utf8"),
		]);
		const store = new AgentDefinitionStore({ root, globalDir, bundledDir });

		await expect(store.load("WORKER")).resolves.toMatchObject({ source: "project-pi", prompt: "first" });
		await unlink(projectPi);
		await expect(store.load("worker")).resolves.toMatchObject({
			source: "project-agents",
			prompt: "second",
		});
		await unlink(projectAgents);
		await expect(store.load("worker")).resolves.toMatchObject({ source: "global", prompt: "third" });
		await unlink(global);
		await expect(store.load("worker")).resolves.toMatchObject({ source: "bundled", prompt: "fourth" });
		await writeFile(bundled, "---\ndescription: changed\n---\nlatest", "utf8");
		await expect(store.load("worker")).resolves.toMatchObject({ prompt: "latest" });
	});

	it("detects the Git root from the active Pi session cwd", async () => {
		const sessionCwd = join(root, "packages", "worker");
		await mkdir(sessionCwd, { recursive: true });
		execFileSync("git", ["init", "--quiet", root], { stdio: "ignore" });

		const store = new AgentDefinitionStore({ cwd: sessionCwd, globalDir, bundledDir });

		expect(store.root).toBe(
			execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: sessionCwd, encoding: "utf8" }).trim(),
		);
	});

	it("reports same-layer case conflicts without consulting lower layers", async () => {
		const highDirectory = join(root, ".pi", "agents");
		await writeFile(join(highDirectory, "Explorer.md"), "---\n---\nupper", "utf8");
		await writeFile(join(highDirectory, "explorer.md"), "---\n---\nlower", "utf8");
		await writeFile(join(bundledDir, "explorer.md"), "---\n---\nbundled", "utf8");

		const entries = (await readdir(highDirectory)).filter((entry) => entry.toLowerCase() === "explorer.md");
		if (entries.length < 2) {
			return;
		}

		const store = new AgentDefinitionStore({ root, globalDir, bundledDir });
		await expect(store.load("explorer")).rejects.toThrow(/Conflicting project-pi.*Explorer\.md.*explorer\.md/);
	});

	it("does not fall back when the selected higher-priority definition is malformed", async () => {
		await writeFile(
			join(root, ".pi", "agents", "reviewer.md"),
			"---\ndescription: selected\nworktree: true\n---\ninvalid",
			"utf8",
		);
		await writeFile(join(bundledDir, "reviewer.md"), "---\ndescription: fallback\n---\nvalid", "utf8");
		const store = new AgentDefinitionStore({ root, globalDir, bundledDir });

		await expect(store.load("reviewer")).rejects.toThrow(/unknown field "worktree"/);
	});

	it.each([
		["unknown field", "legacy: true", /unknown field "legacy"/],
		["blank description", 'description: "   "', /description must be a non-empty string/],
		["thinking enum", "thinking: ultra", /thinking must be one of/],
		["tools CSV", "tools: read,bash", /tools must be a string array/],
		["blank tool entry", 'tools: [read, "   "]', /tools must be a string array/],
		["mixed all tool allowlist", "tools: [all, read]", /tools "all" must be the only entry/],
		["extensions object", "extensions: { path: local.ts }", /extensions must be a boolean or string array/],
		["blank extension resource", 'extensions: ["   "]', /extensions must be a boolean or string array/],
		["skills scalar", "skills: local-skill", /skills must be a boolean or string array/],
		["blank skill resource", 'skills: ["   "]', /skills must be a boolean or string array/],
		["model number", "model: 42", /model must be a string or string array/],
		["blank scalar model", 'model: "   "', /model must be a string or string array with at least one non-empty entry/],
		["blank model candidate", 'model: [provider/model, "   "]', /model must be a string or string array/],
		["empty model candidates", "model: []", /model must be a string or string array with at least one non-empty entry/],
		["enabled string", "enabled: yes-please", /enabled must be a boolean/],
		["denylist CSV", "disallowed_tools: bash,write", /disallowed_tools must be a string array/],
		["blank denylist tool entry", 'disallowed_tools: [bash, "   "]', /disallowed_tools must be a string array/],
	])("rejects %s", async (_caseName, field, expectedError) => {
		await writeFile(join(root, ".pi", "agents", "strict.md"), `---\n${field}\n---\nprompt`, "utf8");
		const store = new AgentDefinitionStore({ root, globalDir, bundledDir });

		await expect(store.load("strict")).rejects.toThrow(expectedError as RegExp);
	});

	it("preserves empty tools, extensions, and skills arrays", async () => {
		const definitionPath = join(root, ".pi", "agents", "empty-collections.md");
		await writeFile(
			definitionPath,
			"---\ntools: []\nextensions: []\nskills: []\n---\nUse no configured tools or resources.",
			"utf8",
		);
		const store = new AgentDefinitionStore({ root, globalDir, bundledDir });

		await expect(store.load("empty-collections")).resolves.toEqual({
			name: "empty-collections",
			source: "project-pi",
			path: definitionPath,
			prompt: "Use no configured tools or resources.",
			tools: [],
			extensions: [],
			skills: [],
		});
	});

	it.each(["off", "minimal", "low", "medium", "high", "xhigh", "max"])(
		"accepts the %s thinking level and a scalar model",
		async (thinking) => {
			await writeFile(
				join(root, ".pi", "agents", "thinker.md"),
				`---\nmodel: provider/model\nthinking: ${thinking}\n---\nprompt`,
				"utf8",
			);
			const store = new AgentDefinitionStore({ root, globalDir, bundledDir });

			await expect(store.load("thinker")).resolves.toMatchObject({
				model: "provider/model",
				thinking,
			});
		},
	);

	it("loads bundled defaults directly, bypasses overrides, and returns undefined when absent", async () => {
		await writeFile(
			join(root, ".pi", "agents", "general-purpose.md"),
			"---\ndescription: project\n---\nproject prompt",
			"utf8",
		);
		await writeFile(join(bundledDir, "general-purpose.md"), "---\nmodel: [bundled/model]\n---\nbundled prompt", "utf8");
		const store = new AgentDefinitionStore({ root, globalDir, bundledDir });

		await expect(store.load("general-purpose")).resolves.toMatchObject({ source: "project-pi" });
		await expect(store.loadBundled("GENERAL-PURPOSE")).resolves.toMatchObject({
			source: "bundled",
			model: ["bundled/model"],
			prompt: "bundled prompt",
		});
		await expect(store.loadBundled("missing")).resolves.toBeUndefined();
	});

	it("strictly loads both definitions shipped by the package", async () => {
		const store = new AgentDefinitionStore({ root, globalDir });

		await expect(store.loadBundled("explorer")).resolves.toMatchObject({
			source: "bundled",
			tools: ["read", "bash", "grep", "find", "ls"],
			extensions: false,
			skills: false,
			enabled: true,
		});
		await expect(store.loadBundled("general-purpose")).resolves.toMatchObject({
			source: "bundled",
			tools: ["all"],
			extensions: true,
			skills: true,
			enabled: true,
		});
	});

	it("reports malformed bundled definitions through loadBundled", async () => {
		await writeFile(join(bundledDir, "broken.md"), "---\nenabled: definitely\n---\nbroken", "utf8");
		const store = new AgentDefinitionStore({ root, globalDir, bundledDir });

		await expect(store.loadBundled("broken")).rejects.toThrow(/enabled must be a boolean/);
	});

	it("reports missing definitions and malformed frontmatter explicitly", async () => {
		const store = new AgentDefinitionStore({ root, globalDir, bundledDir });
		await expect(store.load("missing")).rejects.toThrow(/Agent definition "missing" was not found/);

		await writeFile(join(globalDir, "plain.md"), "No frontmatter here.", "utf8");
		await expect(store.load("plain")).rejects.toThrow(/missing YAML frontmatter/);

		await writeFile(join(globalDir, "sequence.md"), "---\n- description\n---\nprompt", "utf8");
		await expect(store.load("sequence")).rejects.toThrow(/frontmatter must be a mapping/);
	});

	it("accepts an empty frontmatter mapping", async () => {
		await writeFile(join(bundledDir, "empty.md"), "---\n---\nprompt only", "utf8");
		const store = new AgentDefinitionStore({ root, globalDir, bundledDir });

		await expect(store.load("empty")).resolves.toEqual({
			name: "empty",
			source: "bundled",
			path: join(bundledDir, "empty.md"),
			prompt: "prompt only",
		});
	});
});
