import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Given, Then, When } from "@cucumber/cucumber";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { AgentDefinitionStore } from "../../../src/agent-definitions.js";
import { AgentRuntime } from "../../../src/agent-runtime.js";
import { AgentSupervisor } from "../../../src/agent-supervisor.js";
import { HerdrClient } from "../../../src/herdr-client.js";
import {
	E2E_STAGE,
	FAUX_MODEL_ID,
	FAUX_PROVIDER,
	FAUX_REPLY,
	HerdrHarness,
	stageTimeout,
} from "../support/herdr-harness.js";
import { PiHerdrWorld } from "../support/world.js";

const AGENT_NAME = "e2e-worker";
const INITIAL_PROMPT = "Build the e2e feature & report <status>.";

type LaunchResult = Awaited<ReturnType<AgentSupervisor["launch"]>>;

Given(
	"a real Herdr server with a caller pane",
	{ timeout: stageTimeout(E2E_STAGE.serverBoot, E2E_STAGE.callerPi) },
	async function (this: PiHerdrWorld) {
		const sandbox = await this.prepareSandbox();
		const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
		const harness = await HerdrHarness.start(join(sandbox, "herdr"), {
			piBinDir: join(repository, "node_modules", ".bin"),
		});
		this.state.set("harness", harness);
		// Register cleanup before any failable operation so orphans are impossible.
		// LIFO: the client (event stream) is disposed before the server stops.
		this.trackCleanup(async () => harness.stop());
		const caller = await harness.createCallerPane(sandbox);
		await harness.startPiAgent(caller.paneId, "e2e-primary", ["--model", `${FAUX_PROVIDER}/${FAUX_MODEL_ID}`]);
		this.state.set("caller", caller);

		const client = new HerdrClient(harness.socketPath);
		this.trackCleanup(async () => client.dispose());
		const supervisor = new AgentSupervisor(
			client,
			new AgentDefinitionStore({ globalDir: join(sandbox, "global") }),
			new AgentRuntime(join(repository, "dist", "index.js")),
			caller.paneId,
			{ PI_CODING_AGENT_DIR: harness.piAgentDir },
		);
		const model = { provider: FAUX_PROVIDER, id: FAUX_MODEL_ID };
		const context = {
			cwd: sandbox,
			signal: new AbortController().signal,
			model,
			modelRegistry: { getAvailable: () => [model] },
			scopedModels: [],
		} as unknown as ExtensionContext;
		this.state.set("supervisor", supervisor);
		this.state.set("context", context);
	},
);

When(
	"the Primary launches a shared Agent named {string}",
	{ timeout: stageTimeout(E2E_STAGE.launch) },
	async function (this: PiHerdrWorld, name: string) {
		const supervisor = this.state.get("supervisor") as AgentSupervisor;
		const context = this.state.get("context") as ExtensionContext;
		const result = await supervisor.launch(
			{
				description: "Exercise the real Herdr launch path",
				prompt: INITIAL_PROMPT,
				definition: "general-purpose",
				name,
			},
			context,
		);
		this.state.set("launchResult", result);
	},
);

Then("the launch returns launched with a real pane identity", function (this: PiHerdrWorld) {
	const result = this.state.get("launchResult") as LaunchResult;
	assert.equal(result.status, "launched");
	assert.equal(result.description, "Exercise the real Herdr launch path");
	assert.equal(result.agent.name, AGENT_NAME);
	assert.match(result.agent.pane_id, /^w\d+:p\d+$/);
	assert.notEqual(result.agent.launch_pending, true);
	assert.equal(result.agent.interactive_ready, true);
});

Then("the real Herdr session shows the Agent tab {string}", async function (this: PiHerdrWorld, label: string) {
	const supervisor = this.state.get("supervisor") as AgentSupervisor;
	const result = this.state.get("launchResult") as LaunchResult;
	const client = (supervisor as unknown as { client: HerdrClient }).client;
	const [agentResult, tabResult] = await Promise.all([
		client.requestRead("agent.get", { target: result.agent.pane_id }),
		client.requestRead("tab.get", { tab_id: result.agent.tab_id }),
	]);
	assert.equal(agentResult.agent.name, label);
	assert.equal(tabResult.tab.label, label);
	assert.equal(agentResult.agent.agent, "pi");
});

Then(
	"the faux provider received the spawned system prompt and the initial request",
	{ timeout: stageTimeout(E2E_STAGE.provider) },
	async function (this: PiHerdrWorld) {
		const harness = this.state.get("harness") as HerdrHarness;
		const request = await harness.provider.waitForRequest(INITIAL_PROMPT);
		assert.equal(request.model, FAUX_MODEL_ID);
		const messages = request.messages as Array<{ role: string; content: unknown }>;
		const system = messages.find((message) => message.role === "system");
		const user = messages.find((message) => message.role === "user");
		assert.equal(typeof system?.content, "string");
		assert.ok((system.content as string).includes("Spawned Agent managed by pi-herdr"));
		assert.ok((system.content as string).includes("长期存活的通用 Agent"));
		const userText = (user?.content as Array<{ type: string; text?: string }>)?.[0]?.text ?? "";
		assert.ok(userText.startsWith('<from agent="e2e-primary" reply-to="e2e-primary" model="faux/faux-1">'), userText);
		assert.ok(userText.includes(INITIAL_PROMPT), userText);
	},
);

Then(
	"the spawned Pi rendered the faux reply in its pane",
	{ timeout: stageTimeout(E2E_STAGE.render) },
	async function (this: PiHerdrWorld) {
		const harness = this.state.get("harness") as HerdrHarness;
		const result = this.state.get("launchResult") as LaunchResult;
		const text = await harness.waitForPaneText(result.agent.pane_id, FAUX_REPLY);
		assert.ok(text.includes(FAUX_REPLY));
	},
);

Then("ListAgents marks the real runtime as owned", async function (this: PiHerdrWorld) {
	const supervisor = this.state.get("supervisor") as AgentSupervisor;
	const result = this.state.get("launchResult") as LaunchResult;
	const listed = await supervisor.list();
	const worker = listed.agents.find((agent) => agent.pane_id === result.agent.pane_id);
	assert.equal(worker?.type, "agent");
	assert.equal(worker?.createdBy, "e2e-primary");
});
