import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const indexState = vi.hoisted(() => ({
	clients: [] as Array<Record<string, any>>,
	supervisors: [] as Array<Record<string, any>>,
	synchronizers: [] as Array<Record<string, any>>,
	definitions: [] as Array<Record<string, any>>,
	runtimes: [] as Array<Record<string, any>>,
}));

vi.mock("../src/herdr-client.js", () => {
	class HerdrClient {
		readonly requestRead = vi.fn(async () => ({
			type: "session_snapshot",
			snapshot: {
				version: "0.7.5",
				protocol: 17,
				workspaces: [],
				tabs: [],
				panes: [],
				layouts: [],
				agents: [],
			},
		}));
		readonly startEvents = vi.fn(async (listener: unknown) => {
			this.listener = listener;
		});
		readonly stopEvents = vi.fn();
		listener: unknown;

		constructor(
			readonly socketPath: string,
			readonly options: Record<string, any>,
		) {
			indexState.clients.push(this);
		}
	}
	class HerdrRpcError extends Error {}
	return { HerdrClient, HerdrRpcError };
});

vi.mock("../src/agent-definitions.js", () => {
	class AgentDefinitionStore {
		readonly catalog = vi.fn(async () => ({
			entries: [{ name: "explorer", description: "Read-only search" }],
			diagnostics: ["broken global definition"],
		}));

		constructor(readonly options?: Record<string, unknown>) {
			indexState.definitions.push(this);
		}
	}
	return { AgentDefinitionStore };
});

vi.mock("../src/agent-runtime.js", () => {
	class AgentRuntime {
		constructor(readonly extensionPath: string) {
			indexState.runtimes.push(this);
		}
	}
	class SpawnedNameSynchronizer {
		readonly handle = vi.fn(async () => this.ensureReady());

		constructor(
			readonly pi: unknown,
			readonly client: unknown,
			readonly paneId: string,
			readonly notify: (message: string, level: string) => void,
			readonly ensureReady: () => Promise<void>,
		) {
			indexState.synchronizers.push(this);
		}
	}
	return {
		AgentRuntime,
		SpawnedNameSynchronizer,
		THINKING_LEVELS: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
	};
});

vi.mock("../src/agent-supervisor.js", () => {
	class AgentSupervisor {
		readonly initialize = vi.fn(async () => undefined);
		readonly configurationDiagnostic = vi.fn(async () => undefined);
		readonly refresh = vi.fn(async () => undefined);
		readonly handleEvent = vi.fn();
		readonly dispose = vi.fn();
		readonly launch = vi.fn(async () => ({ status: "launched" }));
		readonly list = vi.fn(async () => ({ agents: [] }));
		readonly send = vi.fn(async () => ({ delivered: true }));
		readonly stop = vi.fn(async () => ({ stopped: true }));

		constructor(
			readonly client: unknown,
			readonly definitions: unknown,
			readonly runtime: unknown,
			readonly paneId: string,
		) {
			indexState.supervisors.push(this);
		}
	}
	return { AgentSupervisor };
});

interface TestPi {
	pi: ExtensionAPI;
	tools: Array<Record<string, any>>;
	commands: Array<{ name: string; definition: Record<string, any> }>;
	handlers: Map<string, Array<(...args: any[]) => unknown>>;
	emit: (event: string, ...args: any[]) => Promise<void>;
	registerFlag: ReturnType<typeof vi.fn>;
}

function createPi(role: "primary" | "spawned" | string = "primary"): TestPi {
	const tools: Array<Record<string, any>> = [];
	const commands: Array<{ name: string; definition: Record<string, any> }> = [];
	const handlers = new Map<string, Array<(...args: any[]) => unknown>>();
	const registerFlag = vi.fn();
	const pi = {
		registerFlag,
		getFlag: vi.fn(() => role),
		registerTool: vi.fn((tool) => tools.push(tool)),
		registerCommand: vi.fn((name, definition) => commands.push({ name, definition })),
		on: vi.fn((event, handler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		}),
		getSessionName: vi.fn(() => "spawned"),
		setSessionName: vi.fn(),
	} as unknown as ExtensionAPI;
	return {
		pi,
		tools,
		commands,
		handlers,
		registerFlag,
		emit: async (event, ...args) => {
			for (const handler of handlers.get(event) ?? []) await handler(...args);
		},
	};
}

function context() {
	const notify = vi.fn();
	return {
		ctx: {
			cwd: "/project",
			signal: new AbortController().signal,
			ui: { notify },
		} as unknown as ExtensionContext,
		notify,
	};
}

const originalEnvironment = {
	HERDR_ENV: process.env.HERDR_ENV,
	HERDR_SOCKET_PATH: process.env.HERDR_SOCKET_PATH,
	HERDR_PANE_ID: process.env.HERDR_PANE_ID,
};

let extension: (pi: ExtensionAPI) => void;

beforeAll(async () => {
	extension = (await import("../src/index.js")).default;
});

beforeEach(() => {
	indexState.clients.length = 0;
	indexState.supervisors.length = 0;
	indexState.synchronizers.length = 0;
	indexState.definitions.length = 0;
	indexState.runtimes.length = 0;
	delete process.env.HERDR_ENV;
	delete process.env.HERDR_SOCKET_PATH;
	delete process.env.HERDR_PANE_ID;
});

afterEach(() => {
	for (const [key, value] of Object.entries(originalEnvironment)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

describe("pi-herdr extension role registration", () => {
	it("stays silent outside a Herdr-managed process", async () => {
		const testPi = createPi("primary");
		const { ctx, notify } = context();
		extension(testPi.pi);

		await testPi.emit("session_start", {}, ctx);

		expect(testPi.registerFlag).toHaveBeenCalledWith(
			"pi-herdr-role",
			expect.objectContaining({ type: "string", default: "primary" }),
		);
		expect(notify).not.toHaveBeenCalled();
		expect(indexState.clients).toHaveLength(0);
		expect(testPi.tools).toHaveLength(0);
		expect(testPi.commands).toHaveLength(0);
	});

	it("diagnoses missing Herdr socket or pane identity without registering the control plane", async () => {
		process.env.HERDR_ENV = "1";
		process.env.HERDR_SOCKET_PATH = "/tmp/herdr.sock";
		const testPi = createPi("primary");
		const { ctx, notify } = context();
		extension(testPi.pi);

		await testPi.emit("session_start", {}, ctx);

		expect(notify).toHaveBeenCalledWith(
			"pi-herdr is running inside Herdr, but HERDR_SOCKET_PATH or HERDR_PANE_ID is missing.",
			"error",
		);
		expect(indexState.clients).toHaveLength(0);
		expect(testPi.tools).toHaveLength(0);
	});

	it("registers exactly four Primary tools, the agents command, reconciliation, and shutdown", async () => {
		process.env.HERDR_ENV = "1";
		process.env.HERDR_SOCKET_PATH = "/tmp/herdr.sock";
		process.env.HERDR_PANE_ID = "w1:p1";
		const testPi = createPi("primary");
		const { ctx, notify } = context();
		extension(testPi.pi);

		await testPi.emit("session_start", {}, ctx);

		expect(testPi.tools.map((tool) => tool.name)).toEqual(["Agent", "StopAgent", "ListAgents", "SendMessage"]);
		expect(testPi.commands.map((command) => command.name)).toEqual(["agents"]);
		expect(indexState.clients).toHaveLength(1);
		expect(indexState.supervisors).toHaveLength(1);
		expect(indexState.synchronizers).toHaveLength(0);
		const client = indexState.clients[0]!;
		const supervisor = indexState.supervisors[0]!;
		expect(client.socketPath).toBe("/tmp/herdr.sock");
		expect(indexState.definitions[0]?.options).toBeUndefined();
		expect(indexState.definitions[0]?.catalog).toHaveBeenCalledOnce();
		expect(testPi.tools.find((tool) => tool.name === "Agent")?.parameters.properties.definition.description).toContain(
			"explorer — Read-only search",
		);
		expect(notify).toHaveBeenCalledWith("broken global definition", "error");
		expect(supervisor.paneId).toBe("w1:p1");
		expect(supervisor.configurationDiagnostic).toHaveBeenCalledWith("/project");
		expect(supervisor.initialize).toHaveBeenCalledOnce();
		expect(client.startEvents).toHaveBeenCalledOnce();

		await client.options.onEventReady(false);
		expect(supervisor.initialize).toHaveBeenCalledTimes(2);
		expect(client.requestRead).not.toHaveBeenCalled();
		await client.options.onEventReady(true);
		expect(supervisor.initialize).toHaveBeenCalledTimes(3);
		expect(client.requestRead).not.toHaveBeenCalled();
		expect(supervisor.refresh).toHaveBeenCalledOnce();
		const event = {
			event: "pane_closed",
			data: { type: "pane_closed", pane_id: "w1:p2", workspace_id: "w1" },
		};
		await client.listener(event);
		expect(supervisor.handleEvent).toHaveBeenCalledWith(event);

		await testPi.emit("session_start", {}, ctx);
		expect(indexState.clients).toHaveLength(1);
		expect(testPi.tools).toHaveLength(4);
		await testPi.emit("session_shutdown");
		expect(supervisor.dispose).toHaveBeenCalledOnce();
		expect(notify).toHaveBeenCalledTimes(1);
	});

	it("registers exactly two Spawned tools and routes name events until shutdown", async () => {
		process.env.HERDR_ENV = "1";
		process.env.HERDR_SOCKET_PATH = "/tmp/herdr.sock";
		process.env.HERDR_PANE_ID = "w1:p2";
		const testPi = createPi("spawned");
		const { ctx } = context();
		extension(testPi.pi);

		await testPi.emit("session_start", {}, ctx);

		expect(testPi.tools.map((tool) => tool.name)).toEqual(["ListAgents", "SendMessage"]);
		expect(testPi.commands).toHaveLength(0);
		expect(indexState.synchronizers).toHaveLength(1);
		const synchronizer = indexState.synchronizers[0]!;
		const supervisor = indexState.supervisors[0]!;
		expect(supervisor.configurationDiagnostic).not.toHaveBeenCalled();

		await testPi.emit("session_info_changed", { name: "renamed-worker" });
		expect(synchronizer.handle).toHaveBeenCalledWith("renamed-worker");
		expect(supervisor.initialize).toHaveBeenCalledTimes(2);
		await testPi.emit("session_shutdown");
		expect(supervisor.dispose).toHaveBeenCalledOnce();
		await testPi.emit("session_info_changed", { name: "ignored-after-shutdown" });
		expect(synchronizer.handle).toHaveBeenCalledOnce();
	});
});
