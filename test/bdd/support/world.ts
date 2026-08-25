import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";

import { setWorldConstructor, World } from "@cucumber/cucumber";

import { HerdrClient, type HerdrClientOptions } from "../../../src/herdr-client.js";
import type { AgentInfo } from "../../../src/herdr-types.js";

export interface WireRequest {
	id: string;
	method: string;
	params: Record<string, unknown>;
}

export interface RecordedRequest extends WireRequest {
	connection: number;
	ordinal: number;
}

export type RequestHandler = (
	request: RecordedRequest,
	socket: Socket,
	server: FakeHerdrServer,
) => void | Promise<void>;

export interface FakeHerdrServerOptions {
	bootstrap?: boolean;
	liveAgents?: () => AgentInfo[];
	/** Reported in ping/snapshot replies; defaults to the minimum supported contract. */
	protocol?: number;
	version?: string;
}

interface RequestWaiter {
	method: string;
	count: number;
	resolve: (request: RecordedRequest) => void;
	reject: (error: Error) => void;
}

export class FakeHerdrServer {
	readonly requests: RecordedRequest[] = [];
	readonly sockets = new Set<Socket>();

	private server: Server | undefined;
	private handler: RequestHandler | undefined;
	private waiters: RequestWaiter[] = [];
	private connectionSequence = 0;

	constructor(readonly socketPath: string) {}

	async start(handler: RequestHandler, options: FakeHerdrServerOptions = {}): Promise<void> {
		if (this.server) throw new Error("Fake Herdr server is already running.");
		this.handler = handler;
		this.server = createServer((socket) => {
			const connection = this.connectionSequence++;
			this.sockets.add(socket);
			socket.setEncoding("utf8");
			let buffer = "";
			socket.on("data", (chunk: string | Buffer) => {
				buffer += chunk.toString();
				for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
					const line = buffer.slice(0, newline).trim();
					buffer = buffer.slice(newline + 1);
					if (!line) continue;
					let decoded: unknown;
					try {
						decoded = JSON.parse(line);
					} catch (error) {
						socket.destroy(error instanceof Error ? error : new Error(String(error)));
						continue;
					}
					if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
						socket.destroy(new Error("Fake Herdr received a non-object request."));
						continue;
					}
					const value = decoded as Record<string, unknown>;
					const request: RecordedRequest = {
						id: String(value.id),
						method: String(value.method),
						params: (value.params as Record<string, unknown>) ?? {},
						connection,
						ordinal: this.requests.length,
					};
					this.requests.push(request);
					for (const waiter of [...this.waiters]) {
						const matches = this.requests.filter((candidate) => candidate.method === waiter.method);
						if (matches.length < waiter.count) continue;
						this.waiters.splice(this.waiters.indexOf(waiter), 1);
						waiter.resolve(matches[waiter.count - 1] as RecordedRequest);
					}
					if (options.bootstrap !== false && request.method === "ping") {
						this.reply(socket, request, {
							type: "pong",
							version: options.version ?? "0.7.5",
							protocol: options.protocol ?? 17,
						});
						continue;
					}
					if (options.bootstrap !== false && request.method === "session.snapshot") {
						const agents = options.liveAgents?.().map((agent) => ({ ...agent })) ?? [];
						const panes = agents.map((agent) => ({ ...agent }));
						const tabs = [...new Set(agents.map((agent) => agent.tab_id))].map((tabId, index) => {
							const tabAgents = agents.filter((agent) => agent.tab_id === tabId);
							const representative = tabAgents[0] as AgentInfo;
							return {
								tab_id: tabId,
								workspace_id: representative.workspace_id,
								number: index + 1,
								label: representative.name ?? tabId,
								focused: tabAgents.some((agent) => agent.focused),
								pane_count: tabAgents.length,
								agent_status: representative.agent_status,
							};
						});
						const workspaces = [...new Set(agents.map((agent) => agent.workspace_id))].map((workspaceId, index) => {
							const workspaceAgents = agents.filter((agent) => agent.workspace_id === workspaceId);
							const workspaceTabs = tabs.filter((tab) => tab.workspace_id === workspaceId);
							const representative = workspaceAgents[0] as AgentInfo;
							const activeTab = workspaceTabs.find((tab) => tab.focused) ?? workspaceTabs[0];
							return {
								workspace_id: workspaceId,
								number: index + 1,
								label: workspaceId,
								focused: workspaceAgents.some((agent) => agent.focused),
								pane_count: workspaceAgents.length,
								tab_count: workspaceTabs.length,
								active_tab_id: activeTab?.tab_id ?? representative.tab_id,
								agent_status: representative.agent_status,
							};
						});
						const focused = agents.find((agent) => agent.focused);
						this.reply(socket, request, {
							type: "session_snapshot",
							snapshot: {
								version: options.version ?? "0.7.5",
								protocol: options.protocol ?? 17,
								workspaces,
								tabs,
								panes,
								layouts: [],
								agents,
								focused_workspace_id: focused?.workspace_id ?? null,
								focused_tab_id: focused?.tab_id ?? null,
								focused_pane_id: focused?.pane_id ?? null,
							},
						});
						continue;
					}
					void Promise.resolve(this.handler?.(request, socket, this)).catch((error: unknown) => {
						socket.destroy(error instanceof Error ? error : new Error(String(error)));
					});
				}
			});
		});
		this.server.on("connection", (socket) => socket.on("close", () => this.sockets.delete(socket)));
		await new Promise<void>((resolve, reject) => {
			const server = this.server as Server;
			server.once("error", reject);
			server.listen(this.socketPath, () => {
				server.removeListener("error", reject);
				resolve();
			});
		});
	}

	reply(socket: Socket, request: WireRequest, result: Record<string, unknown>, keepOpen = false): void {
		const line = `${JSON.stringify({ id: request.id, result })}\n`;
		if (keepOpen) socket.write(line);
		else socket.end(line);
	}

	reject(socket: Socket, request: WireRequest, code: string, message: string): void {
		socket.end(`${JSON.stringify({ id: request.id, error: { code, message } })}\n`);
	}

	push(socket: Socket, event: string, data: Record<string, unknown>): void {
		socket.write(`${JSON.stringify({ event, data })}\n`);
	}

	waitFor(method: string, count = 1): Promise<RecordedRequest> {
		const matching = this.requests.filter((request) => request.method === method);
		if (matching.length >= count) return Promise.resolve(matching[count - 1] as RecordedRequest);
		return new Promise<RecordedRequest>((resolve, reject) => {
			this.waiters.push({ method, count, resolve, reject });
		});
	}

	async close(): Promise<void> {
		const error = new Error("Fake Herdr server closed before the awaited request arrived.");
		for (const waiter of this.waiters.splice(0)) waiter.reject(error);
		for (const socket of this.sockets) socket.destroy();
		this.sockets.clear();
		if (!this.server) return;
		const server = this.server;
		this.server = undefined;
		if (!server.listening) return;
		await new Promise<void>((resolve, reject) => {
			server.close((closeError) => (closeError ? reject(closeError) : resolve()));
		});
	}
}

export class PiHerdrWorld extends World {
	sandbox: string | undefined;
	server: FakeHerdrServer | undefined;
	clients: HerdrClient[] = [];
	state = new Map<string, unknown>();
	cleanupTasks: Array<() => Promise<void>> = [];

	async prepareServer(handler: RequestHandler, options: FakeHerdrServerOptions = {}): Promise<FakeHerdrServer> {
		if (!this.sandbox) this.sandbox = await mkdtemp("/tmp/pi-herdr-bdd-");
		if (this.server) throw new Error("This scenario already has a fake Herdr server.");
		const socketPath = join(this.sandbox, `herdr-${randomUUID()}.sock`);
		this.server = new FakeHerdrServer(socketPath);
		await this.server.start(handler, options);
		return this.server;
	}

	async prepareSandbox(): Promise<string> {
		if (!this.sandbox) this.sandbox = await mkdtemp("/tmp/pi-herdr-bdd-");
		return this.sandbox;
	}

	createClient(options: HerdrClientOptions = {}): HerdrClient {
		if (!this.server) throw new Error("Start the fake Herdr server before creating its client.");
		const client = new HerdrClient(this.server.socketPath, options);
		this.clients.push(client);
		return client;
	}

	trackCleanup(task: () => Promise<void>): void {
		this.cleanupTasks.push(task);
	}

	async cleanup(): Promise<void> {
		for (const task of this.cleanupTasks.splice(0).reverse()) await task();
		for (const client of this.clients.splice(0)) client.dispose();
		await this.server?.close();
		this.server = undefined;
		if (this.sandbox) await rm(this.sandbox, { recursive: true, force: true });
		this.sandbox = undefined;
		this.state.clear();
	}
}

export const primaryAgent: AgentInfo = {
	terminal_id: "term-primary",
	agent_status: "idle",
	workspace_id: "w1",
	tab_id: "t-primary",
	pane_id: "w1:p1",
	focused: true,
	revision: 1,
	agent: "pi",
	name: "primary",
	cwd: "/project",
	interactive_ready: true,
	launch_pending: false,
};

export const spawnedAgent: AgentInfo = {
	terminal_id: "term-worker",
	agent_status: "idle",
	workspace_id: "w1",
	tab_id: "t-worker",
	pane_id: "w1:p2",
	focused: false,
	revision: 2,
	agent: "pi",
	name: "worker",
	cwd: "/project",
	interactive_ready: true,
	launch_pending: false,
};

setWorldConstructor(PiHerdrWorld);
