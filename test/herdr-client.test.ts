import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HERDR_MAX_LINE_BYTES, HERDR_REQUEST_TIMEOUT_MS, HerdrClient, HerdrRpcError } from "../src/herdr-client.js";
import type { HerdrEvent } from "../src/herdr-types.js";

interface WireRequest {
	id: string;
	method: string;
	params: Record<string, unknown>;
}

interface FakeApi {
	server: Server;
	connections: number;
	requests: WireRequest[];
	sockets: Set<Socket>;
}

describe.skipIf(process.platform === "win32")("HerdrClient Unix socket transport", () => {
	let directory: string;
	let socketPath: string;
	const apis: FakeApi[] = [];

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "pi-herdr-client-"));
		socketPath = join(directory, "herdr.sock");
	});

	afterEach(async () => {
		for (const api of apis) {
			for (const socket of api.sockets) socket.destroy();
			if (api.server.listening) {
				await new Promise<void>((resolve) => api.server.close(() => resolve()));
			}
		}
		apis.length = 0;
		await rm(directory, { recursive: true, force: true });
	});

	async function startApi(
		handler: (request: WireRequest, connection: number, socket: Socket) => void,
	): Promise<FakeApi> {
		const api: FakeApi = {
			server: createServer(),
			connections: 0,
			requests: [],
			sockets: new Set(),
		};
		api.server.on("connection", (socket) => {
			const connection = api.connections;
			api.connections += 1;
			api.sockets.add(socket);
			socket.setEncoding("utf8");
			let buffer = "";
			socket.on("data", (chunk: string | Buffer) => {
				buffer += chunk.toString();
				const newline = buffer.indexOf("\n");
				if (newline < 0) return;
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				const request = JSON.parse(line) as WireRequest;
				api.requests.push(request);
				handler(request, connection, socket);
			});
			socket.on("close", () => api.sockets.delete(socket));
		});
		await new Promise<void>((resolve, reject) => {
			api.server.once("error", reject);
			api.server.listen(socketPath, () => {
				api.server.removeListener("error", reject);
				resolve();
			});
		});
		apis.push(api);
		return api;
	}

	it("uses one connection per request and reconstructs a split response line", async () => {
		const api = await startApi((request, _connection, socket) => {
			const response = `${JSON.stringify({
				id: request.id,
				result: { type: "pong", version: "0.7.5", protocol: 17 },
			})}\n`;
			socket.write(response.slice(0, 13));
			setImmediate(() => socket.end(response.slice(13)));
		});
		const client = new HerdrClient(socketPath);

		const first = await client.requestRead("ping", {});
		const second = await client.requestRead("ping", {});

		expect(first).toEqual({ type: "pong", version: "0.7.5", protocol: 17 });
		expect(second).toEqual(first);
		expect(api.connections).toBe(2);
		expect(api.requests).toHaveLength(2);
		expect(api.requests[0]?.id).not.toBe(api.requests[1]?.id);
		expect(api.requests.every((request) => request.method === "ping")).toBe(true);
	});

	it("surfaces a matching Herdr error envelope without retrying", async () => {
		const api = await startApi((request, _connection, socket) => {
			socket.end(
				`${JSON.stringify({
					id: request.id,
					error: { code: "not_found", message: "pane not found" },
				})}\n`,
			);
		});
		const client = new HerdrClient(socketPath);

		const call = client.requestRead("agent.get", { target: "missing" });

		await expect(call).rejects.toMatchObject<Partial<HerdrRpcError>>({
			name: "HerdrRpcError",
			code: "not_found",
			kind: "remote",
			delivery: "rejected",
		});
		expect(api.connections).toBe(1);
	});

	it("rejects a mismatched response id as a protocol error without retrying", async () => {
		const api = await startApi((_request, _connection, socket) => {
			socket.end(`${JSON.stringify({ id: "wrong", result: { type: "pong" } })}\n`);
		});
		const client = new HerdrClient(socketPath);

		await expect(client.requestRead("ping", {})).rejects.toMatchObject({
			code: "response_id_mismatch",
			kind: "protocol",
		});
		expect(api.connections).toBe(1);
	});

	it("rejects multiple ordinary response lines as a protocol error", async () => {
		const api = await startApi((request, _connection, socket) => {
			socket.write(`${JSON.stringify({ id: request.id, result: { type: "pong" } })}\n`);
			setImmediate(() => {
				socket.end(`${JSON.stringify({ id: request.id, result: { type: "pong" } })}\n`);
			});
		});
		const client = new HerdrClient(socketPath);

		await expect(client.requestRead("ping", {})).rejects.toMatchObject({
			code: "multiple_responses",
			kind: "protocol",
		});
		expect(api.connections).toBe(1);
	});

	it("retries a read transport failure once with a fresh connection", async () => {
		const api = await startApi((request, connection, socket) => {
			if (connection === 0) {
				socket.destroy();
				return;
			}
			socket.end(`${JSON.stringify({ id: request.id, result: { type: "pong", version: "0.7.5", protocol: 17 } })}\n`);
		});
		const client = new HerdrClient(socketPath);

		const result = await client.requestRead("ping", {});

		expect(result.type).toBe("pong");
		expect(api.connections).toBe(2);
		expect(api.requests[0]?.id).not.toBe(api.requests[1]?.id);
	});

	it("never replays a mutation after a transport failure", async () => {
		const api = await startApi((_request, _connection, socket) => socket.destroy());
		const client = new HerdrClient(socketPath);

		await expect(client.requestMutation("pane.close", { pane_id: "w1:p2" })).rejects.toMatchObject({
			kind: "transport",
			delivery: "unknown",
		});
		await new Promise((resolve) => setImmediate(resolve));
		expect(api.connections).toBe(1);
		expect(api.requests).toHaveLength(1);
	});

	it("aborts an ordinary read without retrying it", async () => {
		let received!: () => void;
		const requestReceived = new Promise<void>((resolve) => {
			received = resolve;
		});
		const api = await startApi(() => received());
		const client = new HerdrClient(socketPath);
		const controller = new AbortController();
		const call = client.requestRead("agent.list", {}, controller.signal);
		await requestReceived;

		controller.abort("test stop");

		await expect(call).rejects.toMatchObject({ code: "aborted", kind: "aborted" });
		expect(api.connections).toBe(1);
	});

	it("enforces an absolute ordinary-request deadline despite trickled bytes", async () => {
		const api = await startApi((_request, _connection, socket) => {
			const trickle = setInterval(() => socket.write(" "), 5);
			const eventualClose = setTimeout(() => socket.end(), 150);
			socket.once("close", () => {
				clearInterval(trickle);
				clearTimeout(eventualClose);
			});
		});
		const client = new HerdrClient(socketPath, { requestTimeoutMs: 30 });

		await expect(client.requestMutation("pane.close", { pane_id: "w1:p2" })).rejects.toMatchObject({
			code: "timeout",
			kind: "transport",
			delivery: "unknown",
		});
		expect(api.connections).toBe(1);
	});

	it("enforces an absolute subscription-ack deadline despite trickled bytes", async () => {
		const api = await startApi((_request, _connection, socket) => {
			const trickle = setInterval(() => socket.write(" "), 5);
			const eventualClose = setTimeout(() => socket.end(), 150);
			socket.once("close", () => {
				clearInterval(trickle);
				clearTimeout(eventualClose);
			});
		});
		const client = new HerdrClient(socketPath, {
			requestTimeoutMs: 30,
			eventReconnectDelaysMs: [],
		});

		await expect(client.startEvents(() => undefined)).rejects.toMatchObject({
			code: "timeout",
			kind: "transport",
		});
		expect(api.connections).toBe(1);
	});

	it("rejects an oversized request before opening a connection", async () => {
		const api = await startApi(() => {
			throw new Error("oversized request must not reach the server");
		});
		const client = new HerdrClient(socketPath, { maxLineBytes: 128 });

		await expect(client.requestRead("agent.get", { target: "x".repeat(200) })).rejects.toMatchObject({
			code: "request_too_large",
			kind: "protocol",
			delivery: "not_sent",
		});
		expect(api.connections).toBe(0);
	});

	it("subscribes with dotted names and delivers generic and special event envelopes", async () => {
		const api = await startApi((request, _connection, socket) => {
			const acknowledgement = `${JSON.stringify({
				id: request.id,
				result: { type: "subscription_started" },
			})}\n`;
			const generic = `${JSON.stringify({
				event: "pane_agent_detected",
				data: {
					type: "pane_agent_detected",
					pane_id: "w1:p2",
					workspace_id: "w1",
					agent: "pi",
				},
			})}\n`;
			const special = `${JSON.stringify({
				event: "pane.agent_status_changed",
				data: {
					pane_id: "w1:p2",
					workspace_id: "w1",
					agent_status: "working",
				},
			})}\n`;
			socket.write(acknowledgement.slice(0, 11));
			setImmediate(() => socket.write(`${acknowledgement.slice(11)}${generic}${special}`));
		});
		const events: HerdrEvent[] = [];
		const client = new HerdrClient(socketPath);

		await client.startEvents((event) => events.push(event), ["w1:p2"]);
		await vi.waitFor(() => expect(events).toHaveLength(2));

		const subscriptions = (api.requests[0]?.params.subscriptions ?? []) as Array<Record<string, unknown>>;
		expect(subscriptions).toContainEqual({ type: "pane.agent_detected" });
		expect(subscriptions).toContainEqual({ type: "pane.closed" });
		expect(subscriptions).toContainEqual({ type: "pane.agent_status_changed", pane_id: "w1:p2" });
		expect(events.map((event) => event.event)).toEqual(["pane_agent_detected", "pane.agent_status_changed"]);
		client.stopEvents();
	});

	it("contains event-listener failures without tearing down the stream", async () => {
		const api = await startApi((request, _connection, socket) => {
			const acknowledgement = `${JSON.stringify({
				id: request.id,
				result: { type: "subscription_started" },
			})}\n`;
			const first = `${JSON.stringify({
				event: "pane_closed",
				data: { type: "pane_closed", pane_id: "w1:p1", workspace_id: "w1" },
			})}\n`;
			const second = `${JSON.stringify({
				event: "pane_exited",
				data: { type: "pane_exited", pane_id: "w1:p2", workspace_id: "w1" },
			})}\n`;
			socket.write(`${acknowledgement}${first}${second}`);
		});
		const reported: HerdrRpcError[] = [];
		let listenerCalls = 0;
		const client = new HerdrClient(socketPath, {
			onEventError: (error) => reported.push(error),
		});

		await client.startEvents(() => {
			listenerCalls += 1;
			if (listenerCalls === 1) throw new Error("listener failed");
		});
		await vi.waitFor(() => expect(listenerCalls).toBe(2));

		expect(reported).toHaveLength(1);
		expect(reported[0]).toMatchObject({ code: "listener_error", kind: "protocol" });
		expect(api.connections).toBe(1);
		client.stopEvents();
	});

	it("reconnects a dropped event stream on a new dedicated connection", async () => {
		const readiness: boolean[] = [];
		const api = await startApi((request, connection, socket) => {
			const acknowledgement = `${JSON.stringify({
				id: request.id,
				result: { type: "subscription_started" },
			})}\n`;
			if (connection === 0) {
				socket.end(acknowledgement);
				return;
			}
			socket.write(acknowledgement);
			socket.write(
				`${JSON.stringify({
					event: "pane_closed",
					data: { type: "pane_closed", pane_id: "w1:p2", workspace_id: "w1" },
				})}\n`,
			);
		});
		const events: HerdrEvent[] = [];
		const client = new HerdrClient(socketPath, {
			eventReconnectDelaysMs: [0],
			onEventReady: (reconnected) => readiness.push(reconnected),
		});

		await client.startEvents((event) => events.push(event));
		await vi.waitFor(() => expect(events).toHaveLength(1));

		expect(api.connections).toBe(2);
		expect(api.requests.every((request) => request.method === "events.subscribe")).toBe(true);
		expect(readiness).toEqual([false, true]);
		client.stopEvents();
	});

	it("rebuilds event subscriptions when tracked panes change", async () => {
		const api = await startApi((request, _connection, socket) => {
			socket.write(`${JSON.stringify({ id: request.id, result: { type: "subscription_started" } })}\n`);
		});
		const client = new HerdrClient(socketPath, { eventReconnectDelaysMs: [0] });
		await client.startEvents(() => undefined, ["w1:p1"]);

		client.updateTrackedPanes(["w1:p3", "w1:p2"]);
		await vi.waitFor(() => expect(api.requests).toHaveLength(2));

		const first = api.requests[0]?.params.subscriptions as Array<Record<string, unknown>>;
		const rebuilt = api.requests[1]?.params.subscriptions as Array<Record<string, unknown>>;
		expect(first).toContainEqual({ type: "pane.agent_status_changed", pane_id: "w1:p1" });
		expect(rebuilt.filter((subscription) => subscription.type === "pane.agent_status_changed")).toEqual([
			{ type: "pane.agent_status_changed", pane_id: "w1:p2" },
			{ type: "pane.agent_status_changed", pane_id: "w1:p3" },
		]);
		client.stopEvents();
	});

	it("bounds initial event connection attempts before any acknowledgement", async () => {
		const api = await startApi((_request, _connection, socket) => socket.destroy());
		const client = new HerdrClient(socketPath, {
			eventReconnectDelaysMs: [0, 0],
		});

		await expect(client.startEvents(() => undefined)).rejects.toMatchObject({
			code: "connection_closed",
			kind: "transport",
		});
		await vi.waitFor(() => expect(api.connections).toBe(3));
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(api.connections).toBe(3);
		client.stopEvents();
	});

	it("keeps restoring an acknowledged event subscription after repeated transport failures", async () => {
		const api = await startApi((request, connection, socket) => {
			if (connection === 0) {
				socket.end(`${JSON.stringify({ id: request.id, result: { type: "subscription_started" } })}\n`);
				return;
			}
			if (connection < 3) {
				socket.destroy();
				return;
			}
			socket.write(
				`${JSON.stringify({ id: request.id, result: { type: "subscription_started" } })}\n${JSON.stringify({
					event: "pane_exited",
					data: { type: "pane_exited", pane_id: "w1:p2", workspace_id: "w1" },
				})}\n`,
			);
		});
		const events: HerdrEvent[] = [];
		const client = new HerdrClient(socketPath, { eventReconnectDelaysMs: [0] });

		await client.startEvents((event) => events.push(event));
		await vi.waitFor(() => expect(events).toHaveLength(1));

		expect(api.connections).toBe(4);
		client.stopEvents();
	});
});

describe("HerdrClient platform mapping", () => {
	it("uses Herdr's protocol limits by default", () => {
		expect(HERDR_MAX_LINE_BYTES).toBe(1024 * 1024);
		expect(HERDR_REQUEST_TIMEOUT_MS).toBe(5_000);
	});

	it("maps a Windows marker path to the GenericNamespaced named pipe", () => {
		const markerPath = String.raw`C:\Users\me\AppData\Roaming\herdr\herdr.sock`;
		const client = new HerdrClient(markerPath, { platform: "win32" });

		expect(client.socketAddress).toBe(String.raw`\\.\pipe\C:\Users\me\AppData\Roaming\herdr\herdr.sock`);
	});
});
