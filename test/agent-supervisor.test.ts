import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";

const filesystem = vi.hoisted(() => ({
	readFile: vi.fn(),
	unlink: vi.fn(),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
	const original = await importOriginal<typeof import("node:fs/promises")>();
	return { ...original, readFile: filesystem.readFile, unlink: filesystem.unlink };
});

import type { ResolvedAgentDefinition } from "../src/agent-definitions.js";
import type { AgentRuntime } from "../src/agent-runtime.js";
import { AgentSupervisor } from "../src/agent-supervisor.js";
import { type HerdrClient, HerdrRpcError } from "../src/herdr-client.js";
import type { AgentInfo, HerdrEvent, SessionSnapshot } from "../src/herdr-types.js";

interface Operation {
	kind: "read" | "mutation" | "tracked" | "dispose";
	method: string;
	params: unknown;
}

interface ClientState {
	caller: AgentInfo;
	spawned: AgentInfo;
	agents: AgentInfo[];
	readOverrides: Record<string, ((params: Record<string, unknown>) => unknown) | undefined>;
	mutationOverrides: Record<string, ((params: Record<string, unknown>) => unknown) | undefined>;
}

function agent(overrides: Partial<AgentInfo> = {}): AgentInfo {
	return {
		terminal_id: "term-primary",
		agent_status: "idle",
		workspace_id: "w1",
		tab_id: "w1:t1",
		pane_id: "w1:p1",
		focused: true,
		revision: 1,
		interactive_ready: true,
		launch_pending: false,
		name: "primary",
		agent: "pi",
		...overrides,
	};
}

function definition(overrides: Partial<ResolvedAgentDefinition> = {}): ResolvedAgentDefinition {
	return {
		name: "explorer",
		source: "bundled",
		path: "/package/agents/explorer.md",
		prompt: "Explore read-only.",
		...overrides,
	};
}

function snapshot(agents: AgentInfo[]): SessionSnapshot {
	return {
		version: "0.7.5",
		protocol: 17,
		workspaces: [],
		tabs: [],
		panes: [],
		layouts: [],
		agents,
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function createClient() {
	const operations: Operation[] = [];
	const caller = agent();
	const spawned = agent({
		terminal_id: "term-worker",
		tab_id: "w1:t2",
		pane_id: "w1:p2",
		focused: false,
		name: "worker",
		revision: 2,
	});
	const state: ClientState = {
		caller,
		spawned,
		agents: [caller],
		readOverrides: {},
		mutationOverrides: {},
	};
	const requestRead = vi.fn(async (method: string, params: Record<string, unknown>) => {
		operations.push({ kind: "read", method, params });
		const override = state.readOverrides[method];
		if (override) return await override(params);
		if (method === "ping") return { type: "pong", version: "0.7.5", protocol: 17 };
		if (method === "session.snapshot") return { type: "session_snapshot", snapshot: snapshot(state.agents) };
		if (method === "agent.list") return { type: "agent_list", agents: state.agents };
		if (method === "agent.get") {
			const target = params.target;
			const found = state.agents.find((candidate) => candidate.pane_id === target || candidate.name === target);
			if (!found) {
				throw new HerdrRpcError(`missing fake Agent ${String(target)}`, {
					code: "agent_not_found",
					kind: "remote",
					method: "agent.get",
					delivery: "rejected",
				});
			}
			return { type: "agent_info", agent: found };
		}
		if (method === "pane.current") return { type: "pane_current", pane: { pane_id: state.caller.pane_id } };
		throw new Error(`unexpected read ${method}`);
	});
	const requestMutation = vi.fn(async (method: string, params: Record<string, unknown>) => {
		operations.push({ kind: "mutation", method, params });
		const override = state.mutationOverrides[method];
		if (override) return await override(params);
		if (method === "tab.create") {
			return { type: "tab_created", tab: { tab_id: "w1:t2" }, root_pane: { pane_id: "w1:p2" } };
		}
		if (method === "worktree.create") {
			state.spawned = { ...state.spawned, workspace_id: "w2", tab_id: "w2:t1", pane_id: "w2:p1" };
			return {
				type: "worktree_created",
				workspace: { workspace_id: "w2" },
				tab: { tab_id: "w2:t1" },
				root_pane: { pane_id: "w2:p1" },
				worktree: { path: "/workspace-worker" },
			};
		}
		if (method === "tab.rename") return { type: "tab_info", tab: { tab_id: params.tab_id } };
		if (method === "agent.start") {
			state.spawned = { ...state.spawned, pane_id: String(params.pane_id), name: String(params.name) };
			state.agents = [
				...state.agents.filter((candidate) => candidate.pane_id !== state.spawned.pane_id),
				state.spawned,
			];
			return { type: "agent_started", agent: state.spawned };
		}
		if (method === "agent.prompt") return { type: "agent_prompted", agent: state.spawned };
		if (method === "tab.close" || method === "worktree.remove" || method === "pane.close") {
			state.agents = state.agents.filter((candidate) => candidate.pane_id === state.caller.pane_id);
			return { type: "ok" };
		}
		throw new Error(`unexpected mutation ${method}`);
	});
	const updateTrackedPanes = vi.fn((ids: string[]) => {
		operations.push({ kind: "tracked", method: "updateTrackedPanes", params: [...ids] });
	});
	const dispose = vi.fn(() => operations.push({ kind: "dispose", method: "dispose", params: {} }));
	const client = { requestRead, requestMutation, updateTrackedPanes, dispose } as unknown as HerdrClient;
	return { client, state, operations, requestRead, requestMutation, updateTrackedPanes, dispose };
}

function createSupervisor(options: { definition?: ResolvedAgentDefinition; environment?: NodeJS.ProcessEnv } = {}) {
	const fake = createClient();
	const selectedDefinition = options.definition ?? definition();
	const definitions = {
		load: vi.fn(async () => selectedDefinition),
	};
	const runtime = {
		resolveLaunchPlan: vi.fn(() => ({ args: ["--name", "worker"], model: "models/coder" })),
		buildEnvelope: vi.fn((sender: AgentInfo, message: string) => `<from ${sender.name ?? sender.pane_id}>\n${message}`),
	};
	const supervisor = new AgentSupervisor(
		fake.client,
		definitions as never,
		runtime as unknown as AgentRuntime,
		fake.state.caller.pane_id,
		{ PI_CODING_AGENT_DIR: "/virtual/pi", ...options.environment },
	);
	return { ...fake, supervisor, definitions, runtime };
}

function launchContext(): ExtensionContext {
	return {
		cwd: "/workspace",
		signal: new AbortController().signal,
	} as unknown as ExtensionContext;
}

const request = {
	description: "Investigate the implementation",
	prompt: "Inspect the relevant modules.",
	definition: "explorer",
	name: "worker",
} as const;

beforeEach(() => {
	filesystem.readFile.mockReset();
	filesystem.unlink.mockReset();
	filesystem.readFile.mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }));
	filesystem.unlink.mockResolvedValue(undefined);
});

describe("AgentSupervisor launch transactions", () => {
	it("launches a shared Agent in exact RPC order and commits only after prompt delivery", async () => {
		const harness = createSupervisor();
		const result = await harness.supervisor.launch(request, launchContext());

		expect(result).toEqual({
			status: "launched",
			description: request.description,
			agent: harness.state.spawned,
		});
		expect(harness.operations.map((operation) => `${operation.kind}:${operation.method}`)).toEqual([
			"read:ping",
			"read:session.snapshot",
			"tracked:updateTrackedPanes",
			"read:agent.get",
			"read:agent.list",
			"mutation:tab.create",
			"mutation:agent.start",
			"read:agent.get",
			"mutation:agent.prompt",
			"tracked:updateTrackedPanes",
		]);
		expect(harness.requestMutation).toHaveBeenNthCalledWith(1, "tab.create", {
			workspace_id: "w1",
			cwd: "/workspace",
			label: "worker",
			focus: false,
		});
		expect(harness.requestMutation).toHaveBeenNthCalledWith(2, "agent.start", {
			name: "worker",
			kind: "pi",
			pane_id: "w1:p2",
			args: ["--name", "worker"],
			timeout_ms: 30_000,
		});
		expect(harness.requestMutation).toHaveBeenNthCalledWith(3, "agent.prompt", {
			target: "worker",
			text: "<from primary>\nInspect the relevant modules.",
		});
	});

	it("uses worktree.create's returned root pane and renames its returned tab before starting Pi", async () => {
		const harness = createSupervisor();

		await harness.supervisor.launch({ ...request, cwd: "packages/api", isolation: "worktree" }, launchContext());

		expect(harness.operations.map((operation) => `${operation.kind}:${operation.method}`)).toEqual([
			"read:ping",
			"read:session.snapshot",
			"tracked:updateTrackedPanes",
			"read:agent.get",
			"read:agent.list",
			"mutation:worktree.create",
			"mutation:tab.rename",
			"mutation:agent.start",
			"read:agent.get",
			"mutation:agent.prompt",
			"tracked:updateTrackedPanes",
		]);
		expect(harness.requestMutation).toHaveBeenNthCalledWith(1, "worktree.create", {
			cwd: "/workspace/packages/api",
			label: "worker",
			focus: false,
		});
		expect(harness.requestMutation).toHaveBeenNthCalledWith(2, "tab.rename", {
			tab_id: "w2:t1",
			label: "worker",
		});
		expect(harness.requestMutation).toHaveBeenNthCalledWith(
			3,
			"agent.start",
			expect.objectContaining({ pane_id: "w2:p1" }),
		);
	});

	it("resolves definition and cwd independently from the Primary call cwd", async () => {
		const harness = createSupervisor({ definition: definition({ source: "path", path: "/roles/reviewer.md" }) });

		await harness.supervisor.launch(
			{ ...request, definition: "../roles/reviewer.md", cwd: "../target" },
			launchContext(),
		);

		expect(harness.definitions.load).toHaveBeenCalledWith("../roles/reviewer.md", "/workspace");
		expect(harness.requestMutation).toHaveBeenNthCalledWith(1, "tab.create", {
			workspace_id: "w1",
			cwd: "/target",
			label: "worker",
			focus: false,
		});
		expect(harness.runtime.resolveLaunchPlan).toHaveBeenCalledWith(
			"worker",
			expect.objectContaining({ path: "/roles/reviewer.md" }),
			expect.objectContaining({ cwd: "../target", definition: "../roles/reviewer.md" }),
			expect.objectContaining({ cwd: "/workspace" }),
		);
	});

	it("keeps a live pane classified as a peer until agent.prompt succeeds", async () => {
		const harness = createSupervisor();
		const prompt = deferred<{ type: "agent_prompted"; agent: AgentInfo }>();
		const promptReached = deferred<void>();
		harness.state.mutationOverrides["agent.prompt"] = () => {
			promptReached.resolve();
			return prompt.promise;
		};

		const launching = harness.supervisor.launch(request, launchContext());
		await promptReached.promise;
		const beforeDelivery = await harness.supervisor.list();
		prompt.resolve({ type: "agent_prompted", agent: harness.state.spawned });
		await launching;
		const afterDelivery = await harness.supervisor.list();

		expect(beforeDelivery.agents.find((candidate) => candidate.pane_id === "w1:p2")?.type).toBe("peer");
		expect(afterDelivery.agents.find((candidate) => candidate.pane_id === "w1:p2")?.type).toBe("agent");
	});

	it("rejects disabled definitions before creating resources", async () => {
		const harness = createSupervisor({ definition: definition({ enabled: false }) });

		await expect(harness.supervisor.launch(request, launchContext())).rejects.toThrow(
			/definition explorer is disabled/,
		);

		expect(harness.requestMutation).not.toHaveBeenCalled();
	});

	it("counts a concurrent launch reservation against maxMembers", async () => {
		filesystem.readFile.mockImplementation(async (path) => {
			if (String(path) === "/virtual/pi/settings.json") return JSON.stringify({ piHerdr: { maxMembers: 1 } });
			throw Object.assign(new Error("missing"), { code: "ENOENT" });
		});
		const harness = createSupervisor();
		const prompt = deferred<{ type: "agent_prompted"; agent: AgentInfo }>();
		const promptReached = deferred<void>();
		harness.state.mutationOverrides["agent.prompt"] = () => {
			promptReached.resolve();
			return prompt.promise;
		};

		const first = harness.supervisor.launch(request, launchContext());
		await promptReached.promise;
		const second = harness.supervisor.launch({ ...request, name: "second" }, launchContext());

		await expect(second).rejects.toThrow(/maxMembers is 1.*owns or is launching 1 live Agents/);
		prompt.resolve({ type: "agent_prompted", agent: harness.state.spawned });
		await first;
	});

	it("does not let a stale concurrent launch preflight release maxMembers ownership", async () => {
		filesystem.readFile.mockImplementation(async (path) => {
			if (String(path) === "/virtual/pi/settings.json") return JSON.stringify({ piHerdr: { maxMembers: 1 } });
			throw Object.assign(new Error("missing"), { code: "ENOENT" });
		});
		const harness = createSupervisor();
		await harness.supervisor.initialize();
		const staleList = deferred<{ type: "agent_list"; agents: AgentInfo[] }>();
		const listStarted = deferred<void>();
		let listCalls = 0;
		harness.state.readOverrides["agent.list"] = () => {
			listCalls += 1;
			if (listCalls === 1) {
				listStarted.resolve();
				return staleList.promise;
			}
			return { type: "agent_list", agents: harness.state.agents };
		};

		const delayed = harness.supervisor.launch({ ...request, name: "second" }, launchContext());
		await listStarted.promise;
		await harness.supervisor.launch(request, launchContext());
		staleList.resolve({ type: "agent_list", agents: [harness.state.caller] });

		await expect(delayed).rejects.toThrow(/maxMembers is 1.*owns or is launching 1 live Agents/);
		expect(harness.operations.filter((operation) => operation.method === "tab.create")).toHaveLength(1);
		const listed = await harness.supervisor.list();
		expect(listed.agents.find((candidate) => candidate.pane_id === "w1:p2")?.type).toBe("agent");
	});

	it("uses Pi's configured sessionDir when an empty session env override is ignored", async () => {
		filesystem.readFile.mockImplementation(async (path) => {
			if (String(path) === "/workspace/.pi/settings.json") {
				return JSON.stringify({ sessionDir: "/virtual/custom-sessions" });
			}
			throw Object.assign(new Error("missing"), { code: "ENOENT" });
		});
		const harness = createSupervisor({ environment: { PI_CODING_AGENT_SESSION_DIR: "" } });
		harness.state.spawned = agent({
			terminal_id: "term-worker",
			tab_id: "w1:t2",
			pane_id: "w1:p2",
			name: "worker",
			agent_session: {
				source: "herdr:pi",
				agent: "pi",
				kind: "path",
				value: "/virtual/custom-sessions/fresh-worker.jsonl",
			},
		});
		harness.state.mutationOverrides["agent.prompt"] = () => {
			throw new Error("prompt rejected");
		};

		await expect(harness.supervisor.launch(request, launchContext())).rejects.toThrow(
			/Failed to launch Agent worker: prompt rejected/,
		);

		expect(harness.operations.map((operation) => `${operation.kind}:${operation.method}`)).toContain(
			"mutation:tab.close",
		);
		expect(filesystem.unlink).toHaveBeenCalledOnce();
		expect(filesystem.unlink).toHaveBeenCalledWith("/virtual/custom-sessions/fresh-worker.jsonl");
		expect(harness.updateTrackedPanes).toHaveBeenCalledOnce();
		expect(harness.updateTrackedPanes).toHaveBeenCalledWith([]);
	});

	it("uses the Spawned cwd sessionDir when cleaning up a failed shared launch", async () => {
		filesystem.readFile.mockImplementation(async (path) => {
			if (String(path) === "/workspace/.pi/settings.json") {
				return JSON.stringify({ sessionDir: "/primary/session-store" });
			}
			if (String(path) === "/target/.pi/settings.json") {
				return JSON.stringify({ sessionDir: "/target/session-store" });
			}
			throw Object.assign(new Error("missing"), { code: "ENOENT" });
		});
		const harness = createSupervisor();
		harness.state.spawned = agent({
			terminal_id: "term-worker",
			tab_id: "w1:t2",
			pane_id: "w1:p2",
			name: "worker",
			agent_session: {
				source: "herdr:pi",
				agent: "pi",
				kind: "path",
				value: "/target/session-store/fresh-worker.jsonl",
			},
		});
		harness.state.mutationOverrides["agent.prompt"] = () => {
			throw new Error("prompt rejected");
		};

		await expect(harness.supervisor.launch({ ...request, cwd: "../target" }, launchContext())).rejects.toThrow(
			/Failed to launch Agent worker: prompt rejected/,
		);

		expect(filesystem.readFile).toHaveBeenCalledWith("/target/.pi/settings.json", "utf8");
		expect(filesystem.unlink).toHaveBeenCalledOnce();
		expect(filesystem.unlink).toHaveBeenCalledWith("/target/session-store/fresh-worker.jsonl");
	});

	it("preserves the Pi session when its Agent pane cannot be confirmed closed", async () => {
		const harness = createSupervisor();
		harness.state.spawned = agent({
			terminal_id: "term-worker",
			tab_id: "w1:t2",
			pane_id: "w1:p2",
			name: "worker",
			agent_session: {
				source: "herdr:pi",
				agent: "pi",
				kind: "path",
				value: "/virtual/pi/sessions/fresh-worker.jsonl",
			},
		});
		harness.state.mutationOverrides["agent.prompt"] = () => {
			throw new Error("prompt rejected");
		};
		harness.state.mutationOverrides["tab.close"] = () => {
			throw new Error("tab still live");
		};

		await expect(harness.supervisor.launch(request, launchContext())).rejects.toThrow(
			/cleanup left residual resources: tab w1:t2: tab still live; session \/virtual\/pi\/sessions\/fresh-worker\.jsonl: preserved because the Agent pane could not be confirmed closed/,
		);
		expect(filesystem.unlink).not.toHaveBeenCalled();
	});

	it("preserves the Pi session when its pane remains live after the created tab closes", async () => {
		const harness = createSupervisor();
		harness.state.spawned = agent({
			terminal_id: "term-worker",
			tab_id: "w1:t2",
			pane_id: "w1:p2",
			name: "worker",
			agent_session: {
				source: "herdr:pi",
				agent: "pi",
				kind: "path",
				value: "/virtual/pi/sessions/fresh-worker.jsonl",
			},
		});
		harness.state.mutationOverrides["agent.prompt"] = () => {
			throw new Error("prompt rejected");
		};
		harness.state.mutationOverrides["tab.close"] = () => ({ type: "ok" });

		await expect(harness.supervisor.launch(request, launchContext())).rejects.toThrow(
			/session \/virtual\/pi\/sessions\/fresh-worker\.jsonl: preserved because Agent pane w1:p2 remained live after container cleanup/,
		);
		expect(filesystem.unlink).not.toHaveBeenCalled();
	});

	it("reports a possibly created untracked container when a create response is lost", async () => {
		const harness = createSupervisor();
		harness.state.mutationOverrides["tab.create"] = () => {
			throw new HerdrRpcError("connection closed before the response", {
				code: "connection_closed",
				kind: "transport",
				method: "tab.create",
				delivery: "unknown",
			});
		};

		await expect(harness.supervisor.launch(request, launchContext())).rejects.toThrow(
			/cleanup left residual resources: tab\.create delivery=unknown: Herdr may have created an untracked container before its response was lost/,
		);
		expect(harness.operations.some((operation) => operation.method === "tab.close")).toBe(false);
	});

	it("falls back to pane.close when a failed worktree cannot be removed cleanly", async () => {
		const harness = createSupervisor();
		harness.state.mutationOverrides["agent.prompt"] = () => {
			throw new Error("prompt rejected");
		};
		harness.state.mutationOverrides["worktree.remove"] = () => {
			throw new Error("dirty worktree");
		};

		await expect(harness.supervisor.launch({ ...request, isolation: "worktree" }, launchContext())).rejects.toThrow(
			/cleanup left residual resources: worktree w2 at \/workspace-worker: dirty worktree/,
		);

		const cleanup = harness.operations
			.filter((operation) => operation.method === "worktree.remove" || operation.method === "pane.close")
			.map((operation) => [operation.method, operation.params]);
		expect(cleanup).toEqual([
			["worktree.remove", { workspace_id: "w2", force: false }],
			["pane.close", { pane_id: "w2:p1" }],
		]);
	});
});

describe("AgentSupervisor discovery, messaging, stopping, and reconciliation", () => {
	it("retries the snapshot baseline after a transient bootstrap failure", async () => {
		const harness = createSupervisor();
		let snapshotAttempts = 0;
		harness.state.readOverrides["session.snapshot"] = () => {
			snapshotAttempts += 1;
			if (snapshotAttempts === 1) throw new Error("snapshot transport failed");
			return { type: "session_snapshot", snapshot: snapshot(harness.state.agents) };
		};

		await expect(harness.supervisor.initialize()).rejects.toThrow(/snapshot transport failed/);
		await expect(harness.supervisor.list()).resolves.toMatchObject({ agents: [{ type: "peer" }] });

		expect(snapshotAttempts).toBe(2);
		expect(harness.operations.filter((operation) => operation.method === "ping")).toHaveLength(1);
		expect(harness.operations.filter((operation) => operation.method === "agent.list")).toHaveLength(1);
	});

	it("does not let a stale reconnect snapshot delete ownership created while it was in flight", async () => {
		const harness = createSupervisor();
		await harness.supervisor.initialize();
		const staleSnapshot = deferred<{ type: "session_snapshot"; snapshot: SessionSnapshot }>();
		const snapshotStarted = deferred<void>();
		harness.state.readOverrides["session.snapshot"] = () => {
			snapshotStarted.resolve();
			return staleSnapshot.promise;
		};

		const refreshing = harness.supervisor.refresh();
		await snapshotStarted.promise;
		await harness.supervisor.launch(request, launchContext());
		staleSnapshot.resolve({
			type: "session_snapshot",
			snapshot: snapshot([harness.state.caller]),
		});
		await refreshing;

		const listed = await harness.supervisor.list();
		expect(listed.agents.find((candidate) => candidate.pane_id === "w1:p2")?.type).toBe("agent");
	});

	it("does not let a stale agent.list response delete ownership created while it was in flight", async () => {
		const harness = createSupervisor();
		await harness.supervisor.initialize();
		const staleList = deferred<{ type: "agent_list"; agents: AgentInfo[] }>();
		const listStarted = deferred<void>();
		let listCalls = 0;
		harness.state.readOverrides["agent.list"] = () => {
			listCalls += 1;
			if (listCalls === 1) {
				listStarted.resolve();
				return staleList.promise;
			}
			return { type: "agent_list", agents: harness.state.agents };
		};

		const listing = harness.supervisor.list();
		await listStarted.promise;
		await harness.supervisor.launch(request, launchContext());
		staleList.resolve({ type: "agent_list", agents: [harness.state.caller] });
		await listing;

		const listed = await harness.supervisor.list();
		expect(listed.agents.find((candidate) => candidate.pane_id === "w1:p2")?.type).toBe("agent");
	});

	it("preserves raw AgentInfo fields and annotates only owned Agents", async () => {
		const harness = createSupervisor();
		await harness.supervisor.launch(request, launchContext());
		harness.state.caller = { ...harness.state.caller, name: "primary-renamed" };
		harness.state.spawned = {
			...harness.state.spawned,
			agent_status: "done",
			title: "finished",
			tokens: { model: "coder", summary: "complete" },
		};
		const peer = agent({
			terminal_id: "term-peer",
			pane_id: "w1:p9",
			tab_id: "w1:t9",
			name: "peer-nine",
			agent_status: "blocked",
			revision: 99,
			tokens: { custom: "raw" },
		});
		harness.state.agents = [harness.state.caller, harness.state.spawned, peer];

		const result = await harness.supervisor.list();

		expect(result.agents).toEqual([
			{ ...harness.state.caller, type: "peer" },
			{ ...harness.state.spawned, type: "agent", createdBy: "primary-renamed" },
			{ ...peer, type: "peer" },
		]);
	});

	it("routes SendMessage through live agent.prompt and StopAgent through pane.close only", async () => {
		const harness = createSupervisor();
		const peer = agent({
			terminal_id: "term-peer",
			pane_id: "w1:p9",
			tab_id: "w1:t9",
			name: "peer-nine",
			focused: false,
		});
		harness.state.agents = [harness.state.caller, peer];
		harness.state.mutationOverrides["agent.prompt"] = () => ({ type: "agent_prompted", agent: peer });

		const delivered = await harness.supervisor.send("w1:p9", "Please inspect this.");
		const stopped = await harness.supervisor.stop("peer-nine");

		expect(delivered).toEqual({ delivered: true, agent: peer });
		expect(stopped).toEqual({ stopped: true, agent: peer });
		expect(harness.requestMutation).toHaveBeenNthCalledWith(1, "agent.prompt", {
			target: "peer-nine",
			text: "<from primary>\nPlease inspect this.",
		});
		expect(harness.requestMutation).toHaveBeenNthCalledWith(2, "pane.close", { pane_id: "w1:p9" });
		expect(harness.operations.some((operation) => operation.method === "tab.close")).toBe(false);
		expect(harness.operations.some((operation) => operation.method === "worktree.remove")).toBe(false);
	});

	it("does not send or close after cancellation during target resolution", async () => {
		const peer = agent({
			terminal_id: "term-peer",
			pane_id: "w1:p9",
			tab_id: "w1:t9",
			name: "peer-nine",
		});
		const sendHarness = createSupervisor();
		await sendHarness.supervisor.initialize();
		sendHarness.state.agents = [sendHarness.state.caller, peer];
		const sendAbort = new AbortController();
		sendHarness.state.readOverrides["agent.get"] = (params) => {
			const found = sendHarness.state.agents.find(
				(candidate) => candidate.pane_id === params.target || candidate.name === params.target,
			);
			if (!found) throw new Error(`missing fake Agent ${String(params.target)}`);
			if (params.target === "peer-nine") sendAbort.abort("cancel send");
			return { type: "agent_info", agent: found };
		};

		await expect(sendHarness.supervisor.send("peer-nine", "hello", sendAbort.signal)).rejects.toThrow(
			/Message delivery was cancelled before agent.prompt/,
		);
		expect(sendHarness.requestMutation).not.toHaveBeenCalled();

		const stopHarness = createSupervisor();
		await stopHarness.supervisor.initialize();
		stopHarness.state.agents = [stopHarness.state.caller, peer];
		const stopAbort = new AbortController();
		stopHarness.state.readOverrides["agent.get"] = (params) => {
			stopAbort.abort("cancel stop");
			return { type: "agent_info", agent: peer };
		};
		await expect(stopHarness.supervisor.stop("peer-nine", stopAbort.signal)).rejects.toThrow(
			/Agent stop was cancelled before pane.close/,
		);
		expect(stopHarness.requestMutation).not.toHaveBeenCalled();
	});

	it("rejects self-stop before issuing pane.close", async () => {
		const harness = createSupervisor();

		await expect(harness.supervisor.stop("primary")).rejects.toThrow(/cannot close the calling Agent's own pane/);

		expect(harness.requestMutation).not.toHaveBeenCalled();
	});

	it("updates and removes ownership from events and fresh snapshots without synthesizing records", async () => {
		const harness = createSupervisor();
		await harness.supervisor.launch(request, launchContext());
		const owned = (
			harness.supervisor as unknown as {
				owned: Map<string, { agent: AgentInfo }>;
			}
		).owned;
		const record = owned.get("w1:p2");
		expect(record).toBeDefined();

		harness.supervisor.handleEvent({
			event: "pane.agent_status_changed",
			data: { pane_id: "w1:p2", workspace_id: "w1", agent_status: "blocked" },
		} as HerdrEvent);
		expect(owned.get("w1:p2")?.agent.agent_status).toBe("blocked");

		const refreshed = { ...harness.state.spawned, name: "worker-renamed", agent_status: "done" as const };
		harness.state.readOverrides["session.snapshot"] = () => ({
			type: "session_snapshot",
			snapshot: snapshot([harness.state.caller, refreshed]),
		});
		await harness.supervisor.refresh();
		expect(owned.get("w1:p2")?.agent).toBe(refreshed);

		harness.supervisor.handleEvent({
			event: "pane_agent_detected",
			data: {
				type: "pane_agent_detected",
				pane_id: "w1:p2",
				workspace_id: "w1",
				released: true,
			},
		} as HerdrEvent);
		expect(owned.has("w1:p2")).toBe(false);

		if (record) owned.set("w1:p2", record);
		harness.supervisor.handleEvent({
			event: "tab_closed",
			data: { type: "tab_closed", tab_id: "w1:t2", workspace_id: "w1" },
		} as HerdrEvent);
		expect(owned.has("w1:p2")).toBe(false);

		if (record) owned.set("w1:p2", record);
		harness.state.readOverrides["session.snapshot"] = () => ({
			type: "session_snapshot",
			snapshot: snapshot([harness.state.caller]),
		});
		await harness.supervisor.refresh();
		expect(owned.has("w1:p2")).toBe(false);
		expect(harness.updateTrackedPanes).toHaveBeenLastCalledWith([]);
	});
});
