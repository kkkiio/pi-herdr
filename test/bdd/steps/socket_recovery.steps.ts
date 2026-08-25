import assert from "node:assert/strict";

import { Given, Then, When } from "@cucumber/cucumber";

import { HerdrClient } from "../../../src/herdr-client.js";
import type { HerdrEvent } from "../../../src/herdr-types.js";
import { PiHerdrWorld, type RequestHandler } from "../support/world.js";

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
