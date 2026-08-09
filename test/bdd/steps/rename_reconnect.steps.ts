import assert from "node:assert/strict";

import { Given, Then, When } from "@cucumber/cucumber";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { SpawnedNameSynchronizer } from "../../../src/agent-runtime.js";
import { HerdrClient } from "../../../src/herdr-client.js";
import type { HerdrEvent } from "../../../src/herdr-types.js";
import { PiHerdrWorld, primaryAgent, type RequestHandler } from "../support/world.js";

async function installRenameRuntime(thisWorld: PiHerdrWorld, rejectNewTabLabel: boolean): Promise<void> {
	const handler: RequestHandler = (request, socket, server) => {
		switch (request.method) {
			case "pane.current":
				server.reply(socket, request, {
					type: "pane_current",
					pane: { pane_id: primaryAgent.pane_id, tab_id: primaryAgent.tab_id },
				});
				return;
			case "agent.list":
				server.reply(socket, request, {
					type: "agent_list",
					agents: [{ ...primaryAgent, name: "old-name" }],
				});
				return;
			case "agent.get":
				server.reply(socket, request, {
					type: "agent_info",
					agent: { ...primaryAgent, name: "old-name" },
				});
				return;
			case "tab.get":
				server.reply(socket, request, {
					type: "tab_info",
					tab: {
						tab_id: primaryAgent.tab_id,
						workspace_id: primaryAgent.workspace_id,
						number: 1,
						label: "old-name",
						focused: true,
						pane_count: 1,
						agent_status: "idle",
					},
				});
				return;
			case "agent.rename":
				server.reply(socket, request, { type: "agent_info", agent: { ...primaryAgent, name: request.params.name } });
				return;
			case "tab.rename":
				if (rejectNewTabLabel && request.params.label === "new-name") {
					server.reject(socket, request, "invalid_label", "tab rename was rejected");
					return;
				}
				server.reply(socket, request, { type: "ok" });
				return;
			default:
				server.reject(socket, request, "unsupported", `Unexpected BDD method ${request.method}`);
		}
	};
	await thisWorld.prepareServer(handler);
	const client = thisWorld.createClient();
	const sessionRollbacks: Array<string | undefined> = [];
	const notifications: Array<{ message: string; level: string }> = [];
	let sessionName: string | undefined = "old-name";
	const pi = {
		getSessionName: () => sessionName,
		setSessionName: (name: string | undefined) => {
			sessionName = name;
			sessionRollbacks.push(name);
		},
	} as unknown as ExtensionAPI;
	const synchronizer = new SpawnedNameSynchronizer(
		pi,
		client,
		primaryAgent.pane_id,
		(message, level) => notifications.push({ message, level }),
		async () => undefined,
	);
	thisWorld.state.set("synchronizer", synchronizer);
	thisWorld.state.set("sessionRollbacks", sessionRollbacks);
	thisWorld.state.set("renameNotifications", notifications);
	thisWorld.state.set("setCurrentSessionName", (name: string | undefined) => {
		sessionName = name;
	});
}

Given("a Spawned runtime named old-name", async function (this: PiHerdrWorld) {
	await installRenameRuntime(this, false);
});

Given("a Spawned runtime whose new tab label is rejected", async function (this: PiHerdrWorld) {
	await installRenameRuntime(this, true);
});

When("its Pi session name changes to new-name", async function (this: PiHerdrWorld) {
	const synchronizer = this.state.get("synchronizer") as SpawnedNameSynchronizer;
	const setCurrentSessionName = this.state.get("setCurrentSessionName") as (name: string | undefined) => void;
	setCurrentSessionName("new-name");
	await synchronizer.handle("new-name");
});

Then("Herdr renames the Agent route before the tab label", function (this: PiHerdrWorld) {
	const mutations = (this.server?.requests ?? [])
		.filter((request) => request.method === "agent.rename" || request.method === "tab.rename")
		.map((request) => ({ method: request.method, params: request.params }));
	assert.deepEqual(mutations, [
		{ method: "agent.rename", params: { target: primaryAgent.pane_id, name: "new-name" } },
		{ method: "tab.rename", params: { tab_id: primaryAgent.tab_id, label: "new-name" } },
	]);
});

Then("no Pi name rollback or error notification occurs", function (this: PiHerdrWorld) {
	assert.deepEqual(this.state.get("sessionRollbacks"), []);
	assert.deepEqual(this.state.get("renameNotifications"), []);
});

Then("Herdr restores the prior tab label and Agent route", function (this: PiHerdrWorld) {
	const mutations = (this.server?.requests ?? [])
		.filter((request) => request.method === "agent.rename" || request.method === "tab.rename")
		.map((request) => ({ method: request.method, params: request.params }));
	assert.deepEqual(mutations, [
		{ method: "agent.rename", params: { target: primaryAgent.pane_id, name: "new-name" } },
		{ method: "tab.rename", params: { tab_id: primaryAgent.tab_id, label: "new-name" } },
		{ method: "tab.rename", params: { tab_id: primaryAgent.tab_id, label: "old-name" } },
		{ method: "agent.rename", params: { target: primaryAgent.pane_id, name: "old-name" } },
	]);
});

Then("Pi restores old-name and reports the synchronization failure", function (this: PiHerdrWorld) {
	assert.deepEqual(this.state.get("sessionRollbacks"), ["old-name"]);
	const notifications = this.state.get("renameNotifications") as Array<{ message: string; level: string }>;
	assert.equal(notifications.length, 1);
	assert.equal(notifications[0]?.level, "error");
	assert.match(notifications[0]?.message ?? "", /tab rename was rejected/);
});

Given("a Herdr transport that drops the first read and every close mutation", async function (this: PiHerdrWorld) {
	let pingAttempts = 0;
	const handler: RequestHandler = (request, socket, server) => {
		if (request.method === "ping") {
			pingAttempts += 1;
			if (pingAttempts === 1) {
				socket.destroy();
				return;
			}
			server.reply(socket, request, { type: "pong", version: "0.7.5", protocol: 17 });
			return;
		}
		if (request.method === "pane.close") {
			socket.destroy();
			return;
		}
		server.reject(socket, request, "unsupported", `Unexpected BDD method ${request.method}`);
	};
	await this.prepareServer(handler, { bootstrap: false });
	this.state.set("transportClient", this.createClient());
});

When("the client reads and then attempts a close mutation", async function (this: PiHerdrWorld) {
	const client = this.state.get("transportClient") as HerdrClient;
	this.state.set("readResult", await client.requestRead("ping", {}));
	try {
		await client.requestMutation("pane.close", { pane_id: "w1:p2" });
		assert.fail("Expected the transport-dropped mutation to fail.");
	} catch (error) {
		this.state.set("mutationError", error);
	}
});

Then("the read succeeds on its second independent connection", function (this: PiHerdrWorld) {
	assert.deepEqual(this.state.get("readResult"), { type: "pong", version: "0.7.5", protocol: 17 });
	const reads = (this.server?.requests ?? []).filter((request) => request.method === "ping");
	assert.equal(reads.length, 2);
	assert.notEqual(reads[0]?.connection, reads[1]?.connection);
	assert.notEqual(reads[0]?.id, reads[1]?.id);
});

Then("the close mutation fails after exactly one request", function (this: PiHerdrWorld) {
	const error = this.state.get("mutationError");
	assert.ok(error instanceof Error);
	assert.match(error.message, /pane\.close/);
	assert.equal(this.server?.requests.filter((request) => request.method === "pane.close").length, 1);
});

Given("an acknowledged event stream that drops once", async function (this: PiHerdrWorld) {
	let subscriptions = 0;
	const handler: RequestHandler = (request, socket, server) => {
		if (request.method !== "events.subscribe") {
			server.reject(socket, request, "unsupported", `Unexpected BDD method ${request.method}`);
			return;
		}
		subscriptions += 1;
		if (subscriptions === 1) {
			server.reply(socket, request, { type: "subscription_started" }, true);
			socket.end();
			return;
		}
		server.reply(socket, request, { type: "subscription_started" }, true);
		server.push(socket, "pane_closed", {
			type: "pane_closed",
			pane_id: "w1:p2",
			workspace_id: "w1",
		});
	};
	await this.prepareServer(handler);
	const readiness: boolean[] = [];
	this.state.set("eventReadiness", readiness);
	this.state.set(
		"eventClient",
		this.createClient({
			eventReconnectDelaysMs: [0],
			onEventReady: (reconnected) => readiness.push(reconnected),
		}),
	);
});

When("the client receives an event from the replacement stream", async function (this: PiHerdrWorld) {
	const client = this.state.get("eventClient") as HerdrClient;
	let resolveEvent!: (event: HerdrEvent) => void;
	const eventReceived = new Promise<HerdrEvent>((resolve) => {
		resolveEvent = resolve;
	});
	await client.startEvents((event) => resolveEvent(event), ["w1:p2"]);
	this.state.set("receivedEvent", await eventReceived);
});

Then("both subscriptions use independent connections and dotted event types", function (this: PiHerdrWorld) {
	const subscriptions = (this.server?.requests ?? []).filter((request) => request.method === "events.subscribe");
	assert.equal(subscriptions.length, 2);
	assert.notEqual(subscriptions[0]?.connection, subscriptions[1]?.connection);
	for (const request of subscriptions) {
		const values = request.params.subscriptions as Array<Record<string, unknown>>;
		assert.ok(values.some((subscription) => subscription.type === "pane.agent_detected"));
		assert.ok(values.some((subscription) => subscription.type === "pane.closed"));
		assert.ok(
			values.some(
				(subscription) => subscription.type === "pane.agent_status_changed" && subscription.pane_id === "w1:p2",
			),
		);
	}
});

Then("reconnect readiness is reported without losing the pushed event", function (this: PiHerdrWorld) {
	assert.deepEqual(this.state.get("eventReadiness"), [false, true]);
	assert.deepEqual(this.state.get("receivedEvent"), {
		event: "pane_closed",
		data: { type: "pane_closed", pane_id: "w1:p2", workspace_id: "w1" },
	});
});
