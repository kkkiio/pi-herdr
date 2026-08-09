import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import type { AgentSupervisor } from "../src/agent-supervisor.js";
import { registerAgentTools } from "../src/tools.js";

interface RegisteredTool {
	name: string;
	promptGuidelines?: string[];
	parameters: Record<string, any>;
	execute: (...args: any[]) => Promise<{ content: Array<{ type: string; text: string }>; details: unknown }>;
}

function setup(role: "primary" | "spawned", catalog: Array<{ name: string; description?: string }> = []) {
	const tools: RegisteredTool[] = [];
	const pi = {
		registerTool: vi.fn((tool) => tools.push(tool)),
	} as unknown as ExtensionAPI;
	const supervisor = {
		launch: vi.fn(async () => ({ status: "launched", description: "task", agent: { pane_id: "w1:p2" } })),
		stop: vi.fn(async () => ({ stopped: true, agent: { pane_id: "w1:p2" } })),
		list: vi.fn(async () => ({ agents: [{ pane_id: "w1:p2", type: "agent" }] })),
		send: vi.fn(async () => ({ delivered: true, agent: { pane_id: "w1:p2" } })),
	} as unknown as AgentSupervisor;
	registerAgentTools(pi, supervisor, role, catalog);
	return { tools, supervisor: supervisor as any };
}

function schema(tool: RegisteredTool) {
	return tool.parameters as {
		type: string;
		additionalProperties: boolean;
		required?: string[];
		properties: Record<string, Record<string, any>>;
	};
}

describe("registerAgentTools schemas", () => {
	it("registers the closed Primary surface with definition catalog, cwd, and launch constraints", () => {
		const { tools } = setup("primary", [
			{ name: "explorer", description: "Read-only search" },
			{ name: "general-purpose", description: "Implementation" },
		]);

		expect(tools.map((tool) => tool.name)).toEqual(["Agent", "StopAgent", "ListAgents", "SendMessage"]);
		for (const tool of tools) {
			expect(schema(tool)).toMatchObject({ type: "object", additionalProperties: false });
		}
		const agent = schema(tools.find((tool) => tool.name === "Agent")!);
		expect(agent.required).toEqual(["description", "prompt", "definition", "name"]);
		expect(agent.properties.definition.description).toContain("explorer — Read-only search");
		expect(agent.properties.definition.description).toContain("general-purpose — Implementation");
		expect(agent.properties.cwd).toBeDefined();
		expect(agent.properties.name.pattern).toBe("^[a-z][a-z0-9_-]{0,31}$");
		expect(agent.properties.model.anyOf).toHaveLength(2);
		expect(agent.properties.thinking.anyOf.map((choice: { const: string }) => choice.const)).toEqual([
			"off",
			"minimal",
			"low",
			"medium",
			"high",
			"xhigh",
			"max",
		]);
		expect(agent.properties.isolation).toMatchObject({ const: "worktree" });
		expect(tools.find((tool) => tool.name === "Agent")?.promptGuidelines?.join("\n")).toMatch(
			/\.pi\/agents.*\.agents\/agents/,
		);
		expect(tools.find((tool) => tool.name === "Agent")?.promptGuidelines?.join("\n")).not.toMatch(/AGENTS\.md/);
		expect(schema(tools.find((tool) => tool.name === "StopAgent")!).required).toEqual(["agent"]);
		expect(schema(tools.find((tool) => tool.name === "ListAgents")!).properties).toEqual({});
		expect(schema(tools.find((tool) => tool.name === "SendMessage")!).required).toEqual(["agent", "message"]);
	});

	it("registers only discovery and messaging in Spawned mode", () => {
		const { tools } = setup("spawned");

		expect(tools.map((tool) => tool.name)).toEqual(["ListAgents", "SendMessage"]);
		expect(tools.some((tool) => tool.name === "Agent" || tool.name === "StopAgent")).toBe(false);
	});
});

describe("registerAgentTools execution bridge", () => {
	it("passes Agent parameters, signal, and context through and returns JSON details", async () => {
		const { tools, supervisor } = setup("primary");
		const tool = tools.find((candidate) => candidate.name === "Agent")!;
		const signal = new AbortController().signal;
		const ctx = { cwd: "/project", signal } as unknown as ExtensionContext;
		const params = {
			description: "task",
			prompt: "implement",
			definition: "explorer",
			name: "worker",
			cwd: "../target",
			model: ["first", "second"],
			thinking: "high",
			isolation: "worktree",
		};

		const result = await tool.execute("call-1", params, signal, undefined, ctx);

		expect(supervisor.launch).toHaveBeenCalledWith(params, ctx);
		expect(result.details).toEqual({ status: "launched", description: "task", agent: { pane_id: "w1:p2" } });
		expect(JSON.parse(result.content[0]!.text)).toEqual(result.details);
	});

	it("honors a pre-aborted Agent call before entering the supervisor", async () => {
		const { tools, supervisor } = setup("primary");
		const tool = tools.find((candidate) => candidate.name === "Agent")!;
		const controller = new AbortController();
		controller.abort();

		await expect(
			tool.execute(
				"call-1",
				{ description: "task", prompt: "implement", definition: "explorer", name: "worker" },
				controller.signal,
				undefined,
				{ cwd: "/project" },
			),
		).rejects.toThrow(/cancelled before it started/);
		expect(supervisor.launch).not.toHaveBeenCalled();
	});

	it("bridges StopAgent, ListAgents, and SendMessage without reshaping supervisor details", async () => {
		const { tools, supervisor } = setup("primary");
		const signal = new AbortController().signal;
		const stop = tools.find((candidate) => candidate.name === "StopAgent")!;
		const list = tools.find((candidate) => candidate.name === "ListAgents")!;
		const send = tools.find((candidate) => candidate.name === "SendMessage")!;

		const stopResult = await stop.execute("stop", { agent: "worker" }, signal);
		const listResult = await list.execute("list", {}, signal);
		const sendResult = await send.execute("send", { agent: "worker", message: "result" }, signal);

		expect(supervisor.stop).toHaveBeenCalledWith("worker", signal);
		expect(supervisor.list).toHaveBeenCalledWith(signal);
		expect(supervisor.send).toHaveBeenCalledWith("worker", "result", signal);
		for (const result of [stopResult, listResult, sendResult]) {
			expect(JSON.parse(result.content[0]!.text)).toEqual(result.details);
		}
	});
});
