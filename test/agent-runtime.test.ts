import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import type { ResolvedAgentDefinition } from "../src/agent-definitions.js";
import { AgentRuntime, SpawnedNameSynchronizer } from "../src/agent-runtime.js";
import type { HerdrClient } from "../src/herdr-client.js";
import type { AgentInfo } from "../src/herdr-types.js";

interface TestModel {
	provider: string;
	id: string;
}

function definition(overrides: Partial<ResolvedAgentDefinition> = {}): ResolvedAgentDefinition {
	return {
		name: "worker",
		source: "path",
		path: "/project/.pi/agents/worker.md",
		prompt: "Implement the request.",
		...overrides,
	};
}

function context(available: TestModel[], primary: TestModel | undefined, scoped: TestModel[] = []): ExtensionContext {
	return {
		modelRegistry: { getAvailable: () => available },
		model: primary,
		scopedModels: scoped.map((model) => ({ model })),
	} as unknown as ExtensionContext;
}

function agent(overrides: Partial<AgentInfo> = {}): AgentInfo {
	return {
		terminal_id: "term-1",
		agent_status: "idle",
		workspace_id: "w1",
		tab_id: "w1:t1",
		pane_id: "w1:p1",
		focused: true,
		revision: 1,
		...overrides,
	};
}

describe("AgentRuntime model selection", () => {
	it("gives an explicit override priority over definition and Primary models", () => {
		const runtime = new AgentRuntime("/package/dist/index.js");
		const primary = { provider: "primary", id: "primary-model" };
		const ctx = context(
			[primary, { provider: "definition", id: "definition-model" }, { provider: "override", id: "target-model" }],
			primary,
		);

		const plan = runtime.resolveLaunchPlan(
			"researcher",
			definition({ model: "definition-model" }),
			{ model: ["missing-model", "target.model"] },
			ctx,
		);

		expect(plan.model).toBe("override/target-model");
		expect(plan.args).toContain("override/target-model");
	});

	it("uses the selected definition before the Primary model", () => {
		const runtime = new AgentRuntime("/package/dist/index.js");
		const primary = { provider: "primary", id: "primary-model" };
		const definitionModel = { provider: "models", id: "definition-model" };
		const ctx = context([primary, definitionModel], primary);

		const selectedDefinition = runtime.resolveLaunchPlan("first", definition({ model: "definition-model" }), {}, ctx);
		const selectedPrimary = runtime.resolveLaunchPlan("second", definition({ model: undefined }), {}, ctx);

		expect(selectedDefinition.model).toBe("models/definition-model");
		expect(selectedPrimary.model).toBe("primary/primary-model");
	});

	it("falls back from an unavailable definition model but rejects an unavailable explicit model", () => {
		const runtime = new AgentRuntime("/package/dist/index.js");
		const primary = { provider: "primary", id: "primary-model" };
		const ctx = context([primary], primary);

		const fallback = runtime.resolveLaunchPlan(
			"fallback",
			definition({ model: ["not-authenticated", "also-missing"] }),
			{},
			ctx,
		);

		expect(fallback.model).toBe("primary/primary-model");
		expect(() =>
			runtime.resolveLaunchPlan("strict", definition({ model: "primary-model" }), { model: "not-authenticated" }, ctx),
		).toThrow(/did not match an authenticated, enabled model/);
	});

	it("filters authenticated models through the session scope", () => {
		const runtime = new AgentRuntime("/package/dist/index.js");
		const primary = { provider: "primary", id: "primary-model" };
		const outOfScope = { provider: "models", id: "special-model" };
		const ctx = context([outOfScope, primary], primary, [primary]);

		const fallback = runtime.resolveLaunchPlan("fallback", definition({ model: "special-model" }), {}, ctx);

		expect(fallback.model).toBe("primary/primary-model");
		expect(() => runtime.resolveLaunchPlan("strict", definition(), { model: "special-model" }, ctx)).toThrow(
			/did not match an authenticated, enabled model/,
		);
	});

	it("normalizes dots and hyphens and preserves provider registry order", () => {
		const runtime = new AgentRuntime("/package/dist/index.js");
		const first = { provider: "zeta", id: "gpt-5.4-mini" };
		const second = { provider: "alpha", id: "gpt-5-4-mini" };
		const ctx = context([first, second], first);

		const registryChoice = runtime.resolveLaunchPlan("registry", definition({ model: "gpt.5-4.mini" }), {}, ctx);
		const providerChoice = runtime.resolveLaunchPlan("provider", definition({ model: "ALPHA/gpt.5.4.mini" }), {}, ctx);

		expect(registryChoice.model).toBe("zeta/gpt-5.4-mini");
		expect(providerChoice.model).toBe("alpha/gpt-5-4-mini");
	});
});

describe("AgentRuntime launch arguments and envelopes", () => {
	it("builds Spawned arguments with protected control tools and native resource discovery", () => {
		const runtime = new AgentRuntime("/package/dist/index.js");
		const model = { provider: "models", id: "coder" };
		const plan = runtime.resolveLaunchPlan(
			"live-worker",
			definition({
				prompt: "Role\n\u0000 prompt",
				model: "coder",
				thinking: "low",
				tools: ["Read", "SendMessage"],
				disallowed_tools: ["sendmessage", "LISTAGENTS", "Bash", "Write"],
				extensions: true,
				skills: true,
			}),
			{ thinking: "high" },
			context([model], model),
		);

		expect(plan.model).toBe("models/coder");
		expect(plan.thinking).toBe("high");
		expect(plan.args.slice(0, 8)).toEqual([
			"--name",
			"live-worker",
			"--extension",
			"/package/dist/index.js",
			"--pi-herdr-role",
			"spawned",
			"--append-system-prompt",
			expect.stringContaining("Spawned Agent"),
		]);
		expect(plan.args).toContain("Read,SendMessage,ListAgents");
		expect(plan.args).toContain("Bash,Write");
		expect(plan.args).toContain("high");
		expect(plan.args).not.toContain("sendmessage,LISTAGENTS,Bash,Write");
		expect(plan.args).not.toContain("--no-extensions");
		expect(plan.args).not.toContain("--no-skills");
		expect(plan.args).not.toContain("--skill");
		expect(plan.args).not.toContain("--approve");
		expect(plan.args).not.toContain("--no-approve");
		const prompts = plan.args.flatMap((argument, index) =>
			argument === "--append-system-prompt" ? [plan.args[index + 1]] : [],
		);
		expect(prompts).toHaveLength(2);
		expect(prompts[1]).toBe("Role-specific instructions: Role prompt");
		expect(prompts[1]?.startsWith("Role-specific instructions: ")).toBe(true);
	});

	it("prefixes a role prompt that otherwise looks exactly like a filesystem path", () => {
		const runtime = new AgentRuntime("/package/dist/index.js");
		const model = { provider: "models", id: "coder" };
		const plan = runtime.resolveLaunchPlan(
			"path-role",
			definition({ model: "coder", prompt: "/project/role-instructions.md" }),
			{},
			context([model], model),
		);
		const prompts = plan.args.flatMap((argument, index) =>
			argument === "--append-system-prompt" ? [plan.args[index + 1]] : [],
		);

		expect(prompts[1]).toBe("Role-specific instructions: /project/role-instructions.md");
		expect(prompts[1]).not.toBe("/project/role-instructions.md");
	});

	it("uses Pi defaults for all tools while allowing extensions and skills to be disabled", () => {
		const runtime = new AgentRuntime("/package/dist/index.js");
		const model = { provider: "models", id: "coder" };
		const plan = runtime.resolveLaunchPlan(
			"minimal",
			definition({ model: "coder", tools: ["all"], extensions: false, skills: false }),
			{},
			context([model], model),
		);

		expect(plan.args).not.toContain("--tools");
		expect(plan.args).toContain("--no-extensions");
		expect(plan.args).toContain("--no-skills");
	});

	it("XML-escapes both address attributes while preserving the message body verbatim", () => {
		const runtime = new AgentRuntime("/package/dist/index.js");
		const message = 'Keep <body> & quotes "raw".\nSecond line.';

		const named = runtime.buildEnvelope(agent({ name: `a&\"<>'` }), message);
		const unnamed = runtime.buildEnvelope(agent({ name: null, pane_id: "w1:p9" }), message);

		expect(named).toBe(`<from agent="a&amp;&quot;&lt;&gt;&apos;" reply-to="a&amp;&quot;&lt;&gt;&apos;">\n${message}`);
		expect(named).not.toContain("</from>");
		expect(unnamed).toBe(`<from agent="w1:p9" reply-to="w1:p9">\n${message}`);
	});
});

describe("SpawnedNameSynchronizer bootstrap", () => {
	it("restores a cleared session name before contacting Herdr", async () => {
		let currentName: string | undefined = "old-name";
		const setSessionName = vi.fn((name: string | undefined) => {
			currentName = name;
		});
		const pi = {
			getSessionName: () => currentName,
			setSessionName,
		} as unknown as ExtensionAPI;
		const ensureReady = vi.fn(async () => undefined);
		const notify = vi.fn();
		const synchronizer = new SpawnedNameSynchronizer(pi, {} as HerdrClient, "w1:p2", notify, ensureReady);

		currentName = undefined;
		await synchronizer.handle(undefined);

		expect(ensureReady).not.toHaveBeenCalled();
		expect(setSessionName).toHaveBeenCalledOnce();
		expect(setSessionName).toHaveBeenCalledWith("old-name");
		expect(notify.mock.calls[0]?.[0]).toMatch(/must match/);
	});

	it("consumes the rollback event before retrying a failed control-plane bootstrap", async () => {
		let currentName: string | undefined = "old-name";
		let rollbackEvent: Promise<void> | undefined;
		let synchronizer!: SpawnedNameSynchronizer;
		const setSessionName = vi.fn((name: string | undefined) => {
			currentName = name;
			if (!rollbackEvent) rollbackEvent = synchronizer.handle(name);
		});
		const pi = {
			getSessionName: () => currentName,
			setSessionName,
		} as unknown as ExtensionAPI;
		const ensureReady = vi.fn(async () => {
			throw new Error("protocol mismatch");
		});
		const notify = vi.fn();
		synchronizer = new SpawnedNameSynchronizer(pi, {} as HerdrClient, "w1:p2", notify, ensureReady);

		currentName = "new-name";
		await synchronizer.handle("new-name");
		await rollbackEvent;

		expect(ensureReady).toHaveBeenCalledOnce();
		expect(setSessionName).toHaveBeenCalledOnce();
		expect(setSessionName).toHaveBeenCalledWith("old-name");
		expect(notify).toHaveBeenCalledOnce();
		expect(notify.mock.calls[0]?.[0]).toMatch(/protocol mismatch/);
	});
});
