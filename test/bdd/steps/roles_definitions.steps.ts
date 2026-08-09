import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Given, Then, When } from "@cucumber/cucumber";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import piHerdrExtension from "../../../src/index.js";
import { AgentDefinitionStore, type ResolvedAgentDefinition } from "../../../src/agent-definitions.js";
import { AgentRuntime } from "../../../src/agent-runtime.js";
import type { AgentSupervisor } from "../../../src/agent-supervisor.js";
import { registerAgentTools } from "../../../src/tools.js";
import { RpcPiSmoke, type PiSurfaceObservation } from "../support/rpc-pi-smoke.js";
import { PiHerdrWorld } from "../support/world.js";

Given("a Pi tool registration recorder", function (this: PiHerdrWorld) {
	this.state.set("toolRecorderReady", true);
});

When("pi-herdr registers Primary and Spawned control tools", function (this: PiHerdrWorld) {
	assert.equal(this.state.get("toolRecorderReady"), true);
	const primary: string[] = [];
	const spawned: string[] = [];
	const primaryPi = {
		registerTool: (tool: { name: string }) => primary.push(tool.name),
	} as unknown as ExtensionAPI;
	const spawnedPi = {
		registerTool: (tool: { name: string }) => spawned.push(tool.name),
	} as unknown as ExtensionAPI;
	const inertSupervisor = {} as AgentSupervisor;
	registerAgentTools(primaryPi, inertSupervisor, "primary");
	registerAgentTools(spawnedPi, inertSupervisor, "spawned");
	this.state.set("primaryTools", primary);
	this.state.set("spawnedTools", spawned);
});

Then("Primary has Agent, StopAgent, ListAgents, and SendMessage", function (this: PiHerdrWorld) {
	assert.deepEqual(this.state.get("primaryTools"), ["Agent", "StopAgent", "ListAgents", "SendMessage"]);
});

Then("Spawned has only ListAgents and SendMessage", function (this: PiHerdrWorld) {
	assert.deepEqual(this.state.get("spawnedTools"), ["ListAgents", "SendMessage"]);
});

Given("HERDR_ENV is not 1", function (this: PiHerdrWorld) {
	this.state.set("herdrEnv", "disabled-for-bdd");
});

When("the pi-herdr extension receives session_start", async function (this: PiHerdrWorld) {
	const original = {
		herdrEnv: process.env.HERDR_ENV,
		socketPath: process.env.HERDR_SOCKET_PATH,
		paneId: process.env.HERDR_PANE_ID,
	};
	const tools: string[] = [];
	const commands: string[] = [];
	const notifications: string[] = [];
	const events = new Map<string, (...args: unknown[]) => unknown>();
	const pi = {
		registerFlag: () => undefined,
		registerTool: (tool: { name: string }) => tools.push(tool.name),
		registerCommand: (name: string) => commands.push(name),
		on: (event: string, handler: (...args: unknown[]) => unknown) => events.set(event, handler),
	} as unknown as ExtensionAPI;
	try {
		process.env.HERDR_ENV = String(this.state.get("herdrEnv"));
		process.env.HERDR_SOCKET_PATH = "/not-used/herdr.sock";
		process.env.HERDR_PANE_ID = "w1:p1";
		piHerdrExtension(pi);
		const sessionStart = events.get("session_start");
		assert.ok(sessionStart);
		await sessionStart(
			{},
			{
				cwd: "/project",
				ui: { notify: (message: string) => notifications.push(message) },
			},
		);
	} finally {
		if (original.herdrEnv === undefined) delete process.env.HERDR_ENV;
		else process.env.HERDR_ENV = original.herdrEnv;
		if (original.socketPath === undefined) delete process.env.HERDR_SOCKET_PATH;
		else process.env.HERDR_SOCKET_PATH = original.socketPath;
		if (original.paneId === undefined) delete process.env.HERDR_PANE_ID;
		else process.env.HERDR_PANE_ID = original.paneId;
	}
	this.state.set("silentSurface", { tools, commands, notifications });
});

Then("it registers no control tools or user command and emits no notification", function (this: PiHerdrWorld) {
	assert.deepEqual(this.state.get("silentSurface"), { tools: [], commands: [], notifications: [] });
});

Given("a fake protocol 17 Herdr for real Pi RPC sessions", async function (this: PiHerdrWorld) {
	await this.prepareServer((request, socket, server) => {
		if (request.method === "events.subscribe") {
			server.reply(socket, request, { type: "subscription_started" }, true);
			return;
		}
		server.reject(socket, request, "unsupported", `Unexpected real Pi RPC method ${request.method}`);
	});
});

When("real Pi RPC starts once as Primary and once as Spawned", async function (this: PiHerdrWorld) {
	const sandbox = await this.prepareSandbox();
	const server = this.server;
	assert.ok(server);
	const primary = await RpcPiSmoke.start({
		root: sandbox,
		socketPath: server.socketPath,
		paneId: "w1:p1",
		role: "primary",
	});
	this.trackCleanup(() => primary.dispose());
	const spawned = await RpcPiSmoke.start({
		root: sandbox,
		socketPath: server.socketPath,
		paneId: "w1:p2",
		role: "spawned",
	});
	this.trackCleanup(() => spawned.dispose());
	this.state.set("primaryRpcSurface", primary.observation);
	this.state.set("spawnedRpcSurface", spawned.observation);
});

Then(
	"the Primary RPC session exposes exactly four pi-herdr tools and the agents command",
	function (this: PiHerdrWorld) {
		const observation = this.state.get("primaryRpcSurface") as PiSurfaceObservation;
		assert.deepEqual(observation.activeTools, ["Agent", "StopAgent", "ListAgents", "SendMessage"]);
		assert.deepEqual(
			observation.allTools.filter((name) => ["Agent", "StopAgent", "ListAgents", "SendMessage"].includes(name)),
			["Agent", "StopAgent", "ListAgents", "SendMessage"],
		);
		assert.ok(observation.commands.some((command) => command.name === "agents" && command.source === "extension"));
		assert.ok(observation.rpcCommands.some((command) => command.name === "agents" && command.source === "extension"));
	},
);

Then("the Spawned RPC session exposes exactly two pi-herdr tools and no agents command", function (this: PiHerdrWorld) {
	const observation = this.state.get("spawnedRpcSurface") as PiSurfaceObservation;
	assert.deepEqual(observation.activeTools, ["ListAgents", "SendMessage"]);
	assert.deepEqual(
		observation.allTools.filter((name) => ["Agent", "StopAgent", "ListAgents", "SendMessage"].includes(name)),
		["ListAgents", "SendMessage"],
	);
	assert.equal(
		observation.commands.some((command) => command.name === "agents"),
		false,
	);
	assert.equal(
		observation.rpcCommands.some((command) => command.name === "agents"),
		false,
	);
});

Given("a malformed project definition shadows a valid bundled definition", async function (this: PiHerdrWorld) {
	const sandbox = await this.prepareSandbox();
	const root = join(sandbox, "project");
	const bundledDir = join(sandbox, "package", "agents");
	await Promise.all([
		mkdir(join(root, ".pi", "agents"), { recursive: true }),
		mkdir(join(root, ".agents", "agents"), { recursive: true }),
		mkdir(join(sandbox, "global"), { recursive: true }),
		mkdir(bundledDir, { recursive: true }),
	]);
	await Promise.all([
		writeFile(
			join(root, ".pi", "agents", "reviewer.md"),
			"---\ndescription: selected\nlegacy_worktree: true\n---\ninvalid",
			"utf8",
		),
		writeFile(join(bundledDir, "reviewer.md"), "---\ndescription: bundled\n---\nvalid", "utf8"),
	]);
	this.state.set("definitionStore", new AgentDefinitionStore({ root, globalDir: join(sandbox, "global"), bundledDir }));
});

When("the selected definition is loaded", async function (this: PiHerdrWorld) {
	const store = this.state.get("definitionStore") as AgentDefinitionStore;
	try {
		await store.load("reviewer");
		assert.fail("Expected the selected project definition to fail strict validation.");
	} catch (error) {
		this.state.set("definitionError", error);
	}
});

Then("definition loading reports the project schema error", function (this: PiHerdrWorld) {
	const error = this.state.get("definitionError");
	assert.ok(error instanceof Error);
	assert.match(error.message, /project.*\.pi.*reviewer\.md|reviewer\.md/);
	assert.match(error.message, /unknown field "legacy_worktree"/);
	assert.doesNotMatch(error.message, /bundled/);
});

Given("a custom definition without a model and authenticated Primary models", function (this: PiHerdrWorld) {
	const primary = { provider: "acme", id: "primary-model" };
	const matched = { provider: "acme", id: "gpt-5-mini" };
	const context = {
		model: primary,
		modelRegistry: { getAvailable: () => [primary, matched] },
		scopedModels: [],
	} as unknown as ExtensionContext;
	const definition: ResolvedAgentDefinition = {
		name: "worker",
		source: "project-pi",
		path: "/project/.pi/agents/worker.md",
		prompt: "Implement the request.",
	};
	this.state.set("modelContext", context);
	this.state.set("customDefinition", definition);
});

When("launch plans are resolved from bundled model preferences", function (this: PiHerdrWorld) {
	const runtime = new AgentRuntime("/package/dist/index.js");
	const context = this.state.get("modelContext") as ExtensionContext;
	const definition = this.state.get("customDefinition") as ResolvedAgentDefinition;
	const matchingBundled: ResolvedAgentDefinition = {
		...definition,
		source: "bundled",
		model: ["acme/not-authenticated", "ACME/gpt.5.mini"],
	};
	const unavailableBundled: ResolvedAgentDefinition = {
		...definition,
		source: "bundled",
		model: ["acme/not-authenticated"],
	};
	this.state.set("matchingPlan", runtime.resolveLaunchPlan("worker", definition, matchingBundled, {}, context));
	this.state.set("fallbackPlan", runtime.resolveLaunchPlan("worker", definition, unavailableBundled, {}, context));
	try {
		runtime.resolveLaunchPlan("worker", definition, matchingBundled, { model: "acme/not-authenticated" }, context);
		assert.fail("Expected an unavailable explicit model override to fail.");
	} catch (error) {
		this.state.set("explicitModelError", error);
	}
});

Then("the first matching normalized bundled model is selected", function (this: PiHerdrWorld) {
	const plan = this.state.get("matchingPlan") as ReturnType<AgentRuntime["resolveLaunchPlan"]>;
	assert.equal(plan.model, "acme/gpt-5-mini");
	const modelIndex = plan.args.indexOf("--model");
	assert.equal(plan.args[modelIndex + 1], "acme/gpt-5-mini");
});

Then("unavailable bundled models inherit the Primary model", function (this: PiHerdrWorld) {
	const plan = this.state.get("fallbackPlan") as ReturnType<AgentRuntime["resolveLaunchPlan"]>;
	assert.equal(plan.model, "acme/primary-model");
});

Then("an unavailable explicit model override is rejected", function (this: PiHerdrWorld) {
	const error = this.state.get("explicitModelError");
	assert.ok(error instanceof Error);
	assert.match(error.message, /override did not match an authenticated, enabled model/);
});
