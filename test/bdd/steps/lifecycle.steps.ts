import assert from "node:assert/strict";

import { Given, Then, When } from "@cucumber/cucumber";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { AgentDefinitionStore } from "../../../src/agent-definitions.js";
import { AgentRuntime } from "../../../src/agent-runtime.js";
import { AgentSupervisor } from "../../../src/agent-supervisor.js";
import type { AgentInfo } from "../../../src/herdr-types.js";
import { PiHerdrWorld, primaryAgent, spawnedAgent, type RequestHandler } from "../support/world.js";

type LifecycleMode = "shared-held" | "worktree-success" | "worktree-failure";

async function installLifecycle(
	thisWorld: PiHerdrWorld,
	mode: LifecycleMode,
	serverOptions: { protocol?: number; version?: string } = {},
): Promise<void> {
	let promptSocket: import("node:net").Socket | undefined;
	let promptRequest: import("../support/world.js").RecordedRequest | undefined;
	let promptAccepted = false;
	let promptRejected = false;
	const worktree = mode !== "shared-held";
	const launched: AgentInfo = {
		...spawnedAgent,
		workspace_id: worktree ? "w2" : "w1",
		tab_id: worktree ? "t-worktree" : "t-worker",
		pane_id: worktree ? "w2:p1" : "w1:p2",
		launch_pending: true,
		interactive_ready: false,
		agent_status: "unknown",
	};
	const ready: AgentInfo = {
		...launched,
		launch_pending: false,
		interactive_ready: true,
		agent_status: "idle",
	};
	const handler: RequestHandler = (request, socket, server) => {
		switch (request.method) {
			case "agent.list":
				server.reply(socket, request, {
					type: "agent_list",
					agents: promptAccepted || promptRejected ? [primaryAgent, ready] : [primaryAgent],
				});
				return;
			case "agent.get":
				server.reply(socket, request, {
					type: "agent_info",
					agent: request.params.target === primaryAgent.pane_id ? primaryAgent : ready,
				});
				return;
			case "tab.create":
				server.reply(socket, request, {
					type: "tab_created",
					tab: { tab_id: "t-worker" },
					root_pane: { pane_id: "w1:p2" },
				});
				return;
			case "worktree.create":
				server.reply(socket, request, {
					type: "worktree_created",
					workspace: { workspace_id: "w2" },
					tab: { tab_id: "t-worktree" },
					root_pane: { pane_id: "w2:p1" },
					worktree: { path: "/project-worker" },
				});
				return;
			case "tab.rename":
			case "pane.close":
				server.reply(socket, request, { type: "ok" });
				return;
			case "agent.start":
				server.reply(socket, request, { type: "agent_started", agent: launched, argv: [] });
				return;
			case "agent.prompt":
				if (mode === "shared-held") {
					promptSocket = socket;
					promptRequest = request;
					thisWorld.state.set("releasePrompt", () => {
						promptAccepted = true;
						server.reply(promptSocket as import("node:net").Socket, promptRequest as typeof request, {
							type: "agent_prompted",
							agent: ready,
						});
					});
					return;
				}
				if (mode === "worktree-failure") {
					promptRejected = true;
					server.reject(socket, request, "prompt_rejected", "initial prompt was rejected");
					return;
				}
				promptAccepted = true;
				server.reply(socket, request, { type: "agent_prompted", agent: ready });
				return;
			case "worktree.remove":
				if (mode === "worktree-failure") {
					server.reject(socket, request, "worktree_dirty", "worktree contains changes");
					return;
				}
				server.reply(socket, request, { type: "worktree_removed", workspace_id: "w2", path: "/project-worker" });
				return;
			default:
				server.reject(socket, request, "unsupported", `Unexpected BDD method ${request.method}`);
		}
	};
	await thisWorld.prepareServer(handler, {
		liveAgents: () => (promptAccepted || promptRejected ? [primaryAgent, ready] : [primaryAgent]),
		...serverOptions,
	});
	const client = thisWorld.createClient();
	const sandbox = await thisWorld.prepareSandbox();
	const supervisor = new AgentSupervisor(
		client,
		new AgentDefinitionStore({ globalDir: `${sandbox}/global` }),
		new AgentRuntime("/package/dist/index.js"),
		primaryAgent.pane_id,
		{ PI_CODING_AGENT_DIR: `${sandbox}/pi-home` },
	);
	const model = { provider: "acme", id: "model-1" };
	const context = {
		cwd: sandbox,
		signal: new AbortController().signal,
		model,
		modelRegistry: { getAvailable: () => [model] },
		scopedModels: [],
	} as unknown as ExtensionContext;
	thisWorld.state.set("supervisor", supervisor);
	thisWorld.state.set("context", context);
}

Given("a protocol 17 Herdr that holds the shared Agent initial prompt", async function (this: PiHerdrWorld) {
	await installLifecycle(this, "shared-held");
});

Given("a newer Herdr that holds the shared Agent initial prompt", async function (this: PiHerdrWorld) {
	await installLifecycle(this, "shared-held", { protocol: 20, version: "0.8.2" });
});

Given("a protocol 17 Herdr that accepts a worktree Agent launch", async function (this: PiHerdrWorld) {
	await installLifecycle(this, "worktree-success");
});

Given(
	"a protocol 17 Herdr that rejects the worktree Agent prompt and safe removal",
	async function (this: PiHerdrWorld) {
		await installLifecycle(this, "worktree-failure");
	},
);

When("the Primary begins launching the shared Agent", async function (this: PiHerdrWorld) {
	const supervisor = this.state.get("supervisor") as AgentSupervisor;
	const context = this.state.get("context") as ExtensionContext;
	let settled = false;
	const launch = supervisor
		.launch(
			{
				description: "Implement the feature",
				prompt: "Build it & report <tests>.",
				name: "worker",
			},
			context,
		)
		.then((result) => {
			settled = true;
			return result;
		});
	this.state.set("launch", launch);
	this.state.set("launchSettled", () => settled);
	await this.server?.waitFor("agent.prompt");
});

Then("Herdr observes tab creation, Pi startup, readiness, and prompt in order", function (this: PiHerdrWorld) {
	const requests = this.server?.requests ?? [];
	const tabCreate = requests.findIndex((request) => request.method === "tab.create");
	const start = requests.findIndex((request) => request.method === "agent.start");
	const ready = requests.findIndex(
		(request) => request.method === "agent.get" && request.params.target === spawnedAgent.pane_id,
	);
	const prompt = requests.findIndex((request) => request.method === "agent.prompt");
	assert.ok(tabCreate >= 0 && tabCreate < start && start < ready && ready < prompt);
});

Then("the Agent launch result is still pending", function (this: PiHerdrWorld) {
	const settled = this.state.get("launchSettled") as () => boolean;
	assert.equal(settled(), false);
});

When("Herdr acknowledges the initial prompt", async function (this: PiHerdrWorld) {
	const release = this.state.get("releasePrompt") as () => void;
	release();
	this.state.set("launchResult", await (this.state.get("launch") as Promise<unknown>));
});

Then("the Agent launch returns launched", function (this: PiHerdrWorld) {
	assert.deepEqual(this.state.get("launchResult"), {
		status: "launched",
		description: "Implement the feature",
		agent: spawnedAgent,
	});
});

Then("ListAgents marks the launched runtime as owned", async function (this: PiHerdrWorld) {
	const supervisor = this.state.get("supervisor") as AgentSupervisor;
	const listed = await supervisor.list();
	const worker = listed.agents.find((agent) => agent.pane_id === spawnedAgent.pane_id);
	assert.equal(worker?.type, "agent");
	assert.equal(worker?.createdBy, "primary");
});

When("the Primary launches the worktree Agent", async function (this: PiHerdrWorld) {
	const supervisor = this.state.get("supervisor") as AgentSupervisor;
	const context = this.state.get("context") as ExtensionContext;
	this.state.set(
		"launchResult",
		await supervisor.launch(
			{
				description: "Isolated implementation",
				prompt: "Implement in an isolated checkout.",
				name: "worker",
				isolation: "worktree",
			},
			context,
		),
	);
});

Then("worktree creation and tab rename happen before Pi startup", function (this: PiHerdrWorld) {
	const methods = this.server?.requests.map((request) => request.method) ?? [];
	assert.ok(methods.indexOf("worktree.create") < methods.indexOf("tab.rename"));
	assert.ok(methods.indexOf("tab.rename") < methods.indexOf("agent.start"));
	const rename = this.server?.requests.find((request) => request.method === "tab.rename");
	assert.deepEqual(rename?.params, { tab_id: "t-worktree", label: "worker" });
});

Then("Pi startup loads the pi-herdr extension in the returned pane", function (this: PiHerdrWorld) {
	const start = this.server?.requests.find((request) => request.method === "agent.start");
	assert.equal(start?.params.pane_id, "w2:p1");
	const args = start?.params.args as string[];
	assert.ok(args.includes("--extension"), args.join(" "));
	assert.ok(!args.includes("--pi-herdr-role"), args.join(" "));
});

When("the Primary attempts to launch the worktree Agent", async function (this: PiHerdrWorld) {
	const supervisor = this.state.get("supervisor") as AgentSupervisor;
	const context = this.state.get("context") as ExtensionContext;
	try {
		await supervisor.launch(
			{
				description: "Risky isolated implementation",
				prompt: "This prompt will be rejected.",
				name: "worker",
				isolation: "worktree",
			},
			context,
		);
		assert.fail("Expected worktree launch to fail.");
	} catch (error) {
		this.state.set("launchError", error);
	}
});

Then("the launch reports its cleanup residual", function (this: PiHerdrWorld) {
	const error = this.state.get("launchError");
	assert.ok(error instanceof Error);
	assert.match(error.message, /initial prompt was rejected/);
	assert.match(error.message, /cleanup left residual resources: worktree w2/);
});

Then("safe worktree removal is attempted before closing the managed pane", function (this: PiHerdrWorld) {
	const methods = this.server?.requests.map((request) => request.method) ?? [];
	assert.ok(methods.indexOf("worktree.remove") >= 0);
	assert.ok(methods.indexOf("worktree.remove") < methods.indexOf("pane.close"));
});

Then("the failed runtime is listed only as a peer", async function (this: PiHerdrWorld) {
	const supervisor = this.state.get("supervisor") as AgentSupervisor;
	const listed = await supervisor.list();
	const residual = listed.agents.find((agent) => agent.name === "worker");
	assert.equal(residual?.type, "peer");
	assert.equal(residual?.createdBy, undefined);
});
