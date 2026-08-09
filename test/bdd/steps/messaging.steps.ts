import assert from "node:assert/strict";

import { Given, Then, When } from "@cucumber/cucumber";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { AgentDefinitionStore } from "../../../src/agent-definitions.js";
import { AgentRuntime } from "../../../src/agent-runtime.js";
import { AgentSupervisor } from "../../../src/agent-supervisor.js";
import type { AgentInfo } from "../../../src/herdr-types.js";
import { PiHerdrWorld, primaryAgent, spawnedAgent, type RequestHandler } from "../support/world.js";

async function installSupervisor(
	thisWorld: PiHerdrWorld,
	handler: RequestHandler,
	liveAgents: () => AgentInfo[],
): Promise<AgentSupervisor> {
	await thisWorld.prepareServer(handler, { liveAgents });
	const sandbox = await thisWorld.prepareSandbox();
	const client = thisWorld.createClient();
	const supervisor = new AgentSupervisor(
		client,
		new AgentDefinitionStore({ root: sandbox, globalDir: `${sandbox}/global` }),
		new AgentRuntime("/package/dist/index.js"),
		primaryAgent.pane_id,
		{ PI_CODING_AGENT_DIR: `${sandbox}/pi-home` },
	);
	const model = { provider: "acme", id: "model-1" };
	thisWorld.state.set("supervisor", supervisor);
	thisWorld.state.set("context", {
		cwd: sandbox,
		signal: new AbortController().signal,
		model,
		modelRegistry: { getAvailable: () => [model] },
		scopedModels: [],
	} as unknown as ExtensionContext);
	return supervisor;
}

Given("a Primary that has launched one Agent beside a live peer", async function (this: PiHerdrWorld) {
	let launched = false;
	const owned: AgentInfo = {
		...spawnedAgent,
		agent_status: "done",
		state_labels: { phase: "complete" },
		vendor_payload: { untouched: true },
	};
	const peer: AgentInfo = {
		...spawnedAgent,
		terminal_id: "term-peer",
		pane_id: "w1:p3",
		tab_id: "t-peer",
		name: "reviewer",
		agent_status: "blocked",
		revision: 41,
	};
	const pending: AgentInfo = {
		...owned,
		agent_status: "unknown",
		launch_pending: true,
		interactive_ready: false,
	};
	const handler: RequestHandler = (request, socket, server) => {
		switch (request.method) {
			case "agent.list":
				server.reply(socket, request, {
					type: "agent_list",
					agents: launched ? [primaryAgent, owned, peer] : [primaryAgent, peer],
				});
				return;
			case "agent.get":
				server.reply(socket, request, {
					type: "agent_info",
					agent: request.params.target === primaryAgent.pane_id ? primaryAgent : owned,
				});
				return;
			case "tab.create":
				server.reply(socket, request, {
					type: "tab_created",
					tab: { tab_id: owned.tab_id },
					root_pane: { pane_id: owned.pane_id },
				});
				return;
			case "agent.start":
				server.reply(socket, request, { type: "agent_started", agent: pending, argv: [] });
				return;
			case "agent.prompt":
				launched = true;
				server.reply(socket, request, { type: "agent_prompted", agent: owned });
				return;
			default:
				server.reject(socket, request, "unsupported", `Unexpected BDD method ${request.method}`);
		}
	};
	const supervisor = await installSupervisor(this, handler, () =>
		launched ? [primaryAgent, owned, peer] : [primaryAgent, peer],
	);
	await supervisor.launch(
		{
			description: "Background implementation",
			prompt: "Implement and report.",
			agent_type: "general-purpose",
			name: "worker",
		},
		this.state.get("context") as ExtensionContext,
	);
});

When("it lists the live Herdr Agents", async function (this: PiHerdrWorld) {
	const supervisor = this.state.get("supervisor") as AgentSupervisor;
	this.state.set("listed", await supervisor.list());
});

Then("the owned Agent keeps its done status and Herdr fields", function (this: PiHerdrWorld) {
	const listed = this.state.get("listed") as Awaited<ReturnType<AgentSupervisor["list"]>>;
	const worker = listed.agents.find((agent) => agent.name === "worker");
	assert.equal(worker?.type, "agent");
	assert.equal(worker?.createdBy, "primary");
	assert.equal(worker?.agent_status, "done");
	assert.deepEqual(worker?.state_labels, { phase: "complete" });
	assert.deepEqual(worker?.vendor_payload, { untouched: true });
});

Then("the other runtime keeps its blocked status and is a peer", function (this: PiHerdrWorld) {
	const listed = this.state.get("listed") as Awaited<ReturnType<AgentSupervisor["list"]>>;
	const reviewer = listed.agents.find((agent) => agent.name === "reviewer");
	assert.equal(reviewer?.type, "peer");
	assert.equal(reviewer?.createdBy, undefined);
	assert.equal(reviewer?.agent_status, "blocked");
	assert.equal(reviewer?.revision, 41);
});

Given("a protocol 17 Herdr with one named and one unnamed target", async function (this: PiHerdrWorld) {
	const sender: AgentInfo = { ...primaryAgent, name: `primary&"<>'` };
	const named: AgentInfo = { ...spawnedAgent, name: "worker" };
	const unnamed: AgentInfo = {
		...spawnedAgent,
		terminal_id: "term-unnamed",
		pane_id: "w1:p3",
		tab_id: "t-unnamed",
		name: null,
	};
	const handler: RequestHandler = (request, socket, server) => {
		if (request.method === "agent.get") {
			const target = request.params.target;
			const agent = target === primaryAgent.pane_id ? sender : target === "worker" ? named : unnamed;
			server.reply(socket, request, { type: "agent_info", agent });
			return;
		}
		if (request.method === "agent.prompt") {
			const target = request.params.target;
			server.reply(socket, request, { type: "agent_prompted", agent: target === "worker" ? named : unnamed });
			return;
		}
		server.reject(socket, request, "unsupported", `Unexpected BDD method ${request.method}`);
	};
	await installSupervisor(this, handler, () => [sender, named, unnamed]);
});

When("the Primary sends messages by name and by pane ID", async function (this: PiHerdrWorld) {
	const supervisor = this.state.get("supervisor") as AgentSupervisor;
	await supervisor.send("worker", "Review <raw> & reply.");
	await supervisor.send("w1:p3", "Pane-addressed follow-up.");
});

Then("Herdr resolves both supplied routes", function (this: PiHerdrWorld) {
	const lookups = (this.server?.requests ?? [])
		.filter((request) => request.method === "agent.get")
		.map((request) => request.params.target);
	assert.deepEqual(lookups, [primaryAgent.pane_id, "worker", primaryAgent.pane_id, "w1:p3"]);
});

Then("each prompt prefers the target name and preserves an escaped reply envelope", function (this: PiHerdrWorld) {
	const prompts = (this.server?.requests ?? []).filter((request) => request.method === "agent.prompt");
	assert.deepEqual(
		prompts.map((request) => request.params.target),
		["worker", "w1:p3"],
	);
	const opening = `<from agent="primary&amp;&quot;&lt;&gt;&apos;" reply-to="primary&amp;&quot;&lt;&gt;&apos;">`;
	assert.equal(prompts[0]?.params.text, `${opening}\nReview <raw> & reply.`);
	assert.equal(prompts[1]?.params.text, `${opening}\nPane-addressed follow-up.`);
});

Given("a protocol 17 Herdr whose requested stop target is the caller", async function (this: PiHerdrWorld) {
	const handler: RequestHandler = (request, socket, server) => {
		if (request.method === "pane.current") {
			server.reply(socket, request, { type: "pane_current", pane: { pane_id: primaryAgent.pane_id } });
			return;
		}
		if (request.method === "agent.get") {
			server.reply(socket, request, { type: "agent_info", agent: primaryAgent });
			return;
		}
		server.reject(socket, request, "unexpected_mutation", `Unexpected BDD method ${request.method}`);
	};
	await installSupervisor(this, handler, () => [primaryAgent]);
});

When("the Primary tries to stop itself", async function (this: PiHerdrWorld) {
	const supervisor = this.state.get("supervisor") as AgentSupervisor;
	try {
		await supervisor.stop("primary");
		assert.fail("Expected self stop to fail.");
	} catch (error) {
		this.state.set("stopError", error);
	}
});

Then("StopAgent rejects the self stop without closing a pane", function (this: PiHerdrWorld) {
	const error = this.state.get("stopError");
	assert.ok(error instanceof Error);
	assert.match(error.message, /cannot close the calling Agent's own pane/);
	assert.equal(this.server?.requests.filter((request) => request.method === "pane.close").length, 0);
});
