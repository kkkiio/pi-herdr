import assert from "node:assert/strict";

import { Given, Then, When } from "@cucumber/cucumber";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import piHerdrExtension from "../../../src/index.js";
import { AgentRuntime } from "../../../src/agent-runtime.js";
import { availableModelNotes } from "../../../src/model-notes.js";
import type { AgentSupervisor } from "../../../src/agent-supervisor.js";
import { registerAgentTools } from "../../../src/tools.js";
import { RpcPiSmoke, type PiSurfaceObservation } from "../support/rpc-pi-smoke.js";
import { PiHerdrWorld } from "../support/world.js";

Given("a Pi tool registration recorder", function (this: PiHerdrWorld) {
	this.state.set("toolRecorderReady", true);
});

When("pi-herdr registers its control tools", function (this: PiHerdrWorld) {
	assert.equal(this.state.get("toolRecorderReady"), true);
	const registered: string[] = [];
	const recorder = {
		registerTool: (tool: { name: string }) => registered.push(tool.name),
	} as unknown as ExtensionAPI;
	const inertSupervisor = {} as AgentSupervisor;
	registerAgentTools(recorder, inertSupervisor);
	this.state.set("registeredTools", registered);
});

Then("the surface has Agent, ListAgents, and SendMessage", function (this: PiHerdrWorld) {
	assert.deepEqual(this.state.get("registeredTools"), ["Agent", "ListAgents", "SendMessage"]);
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

When("a real Pi RPC session starts inside Herdr", async function (this: PiHerdrWorld) {
	const sandbox = await this.prepareSandbox();
	const server = this.server;
	assert.ok(server);
	const session = await RpcPiSmoke.start({
		root: sandbox,
		socketPath: server.socketPath,
		paneId: "w1:p1",
	});
	this.trackCleanup(() => session.dispose());
	this.state.set("rpcSurface", session.observation);
});

Then("the RPC session exposes exactly four pi-herdr tools and the agents command", function (this: PiHerdrWorld) {
	const observation = this.state.get("rpcSurface") as PiSurfaceObservation;
	assert.deepEqual(observation.activeTools, ["Agent", "ListAgents", "SendMessage"]);
	assert.deepEqual(
		observation.allTools.filter((name) => ["Agent", "ListAgents", "SendMessage"].includes(name)),
		["Agent", "ListAgents", "SendMessage"],
	);
	assert.ok(observation.commands.some((command) => command.name === "agents" && command.source === "extension"));
	assert.ok(observation.rpcCommands.some((command) => command.name === "agents" && command.source === "extension"));
});

Given("authenticated Primary models", function (this: PiHerdrWorld) {
	const primary = { provider: "acme", id: "primary-model" };
	const matched = { provider: "acme", id: "gpt-5-mini" };
	const context = {
		model: primary,
		modelRegistry: { getAvailable: () => [primary, matched] },
		scopedModels: [],
	} as unknown as ExtensionContext;
	this.state.set("modelContext", context);
});

When("launch plans are resolved from explicit model preferences", function (this: PiHerdrWorld) {
	const runtime = new AgentRuntime("/package/dist/index.js");
	const context = this.state.get("modelContext") as ExtensionContext;
	this.state.set(
		"matchingPlan",
		runtime.resolveLaunchPlan({ model: ["acme/not-authenticated", "ACME/gpt.5.mini"] }, context),
	);
	this.state.set("fallbackPlan", runtime.resolveLaunchPlan({}, context));
	try {
		runtime.resolveLaunchPlan({ model: "acme/not-authenticated" }, context);
		assert.fail("Expected an unavailable explicit model override to fail.");
	} catch (error) {
		this.state.set("explicitModelError", error);
	}
});

Then("the first matching normalized override model is selected", function (this: PiHerdrWorld) {
	const plan = this.state.get("matchingPlan") as ReturnType<AgentRuntime["resolveLaunchPlan"]>;
	assert.equal(plan.model, "acme/gpt-5-mini");
	const modelIndex = plan.args.indexOf("--model");
	assert.equal(plan.args[modelIndex + 1], "acme/gpt-5-mini");
});

Then("a missing model override inherits the Primary model", function (this: PiHerdrWorld) {
	const plan = this.state.get("fallbackPlan") as ReturnType<AgentRuntime["resolveLaunchPlan"]>;
	assert.equal(plan.model, "acme/primary-model");
});

Then("an unavailable explicit model override is rejected", function (this: PiHerdrWorld) {
	const error = this.state.get("explicitModelError");
	assert.ok(error instanceof Error);
	assert.match(error.message, /override did not match an authenticated, enabled model/);
});

When("model awareness notes are computed for available model ids {string}", function (this: PiHerdrWorld, ids: string) {
	const availableIds = ids.split(",").map((id) => id.trim().split("/").pop() ?? "");
	this.state.set("modelNotes", availableModelNotes(availableIds));
});

Then(
	"the notes mention {string} and {string} but not {string}",
	function (this: PiHerdrWorld, first: string, second: string, excluded: string) {
		const notes = this.state.get("modelNotes");
		assert.equal(typeof notes, "string");
		assert.ok((notes as string).includes(first), String(notes));
		assert.ok((notes as string).includes(second), String(notes));
		assert.ok(!(notes as string).includes(excluded), String(notes));
	},
);

Then("no model awareness notes are produced", function (this: PiHerdrWorld) {
	assert.equal(this.state.get("modelNotes"), undefined);
});
