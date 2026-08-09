import { createConnection, type Socket } from "node:net";

import type {
	HerdrErrorResponse,
	HerdrEvent,
	HerdrEventListener,
	HerdrMethodParams,
	HerdrMethodResults,
	HerdrMutationMethod,
	HerdrReadMethod,
	HerdrSubscription,
} from "./herdr-types.js";

export const HERDR_MAX_LINE_BYTES = 1024 * 1024;
export const HERDR_REQUEST_TIMEOUT_MS = 5_000;

const BASE_EVENT_SUBSCRIPTIONS = [
	{ type: "pane.agent_detected" },
	{ type: "pane.closed" },
	{ type: "pane.exited" },
	{ type: "tab.closed" },
	{ type: "tab.renamed" },
] as const satisfies readonly HerdrSubscription[];

export type HerdrRpcErrorKind = "remote" | "transport" | "protocol" | "aborted";
export type HerdrDeliveryState = "not_sent" | "unknown" | "rejected";

export interface HerdrRpcErrorOptions {
	code: string;
	kind: HerdrRpcErrorKind;
	method: string;
	requestId?: string;
	delivery: HerdrDeliveryState;
	cause?: unknown;
}

export class HerdrRpcError extends Error {
	readonly code: string;
	readonly kind: HerdrRpcErrorKind;
	readonly method: string;
	readonly requestId: string | undefined;
	readonly delivery: HerdrDeliveryState;

	constructor(message: string, options: HerdrRpcErrorOptions) {
		super(message, options.cause === undefined ? undefined : { cause: options.cause });
		this.name = "HerdrRpcError";
		this.code = options.code;
		this.kind = options.kind;
		this.method = options.method;
		this.requestId = options.requestId;
		this.delivery = options.delivery;
	}
}

export interface HerdrClientOptions {
	requestTimeoutMs?: number;
	maxLineBytes?: number;
	eventReconnectDelaysMs?: readonly number[];
	platform?: NodeJS.Platform;
	connect?: (address: string) => Socket;
	onEventError?: (error: HerdrRpcError) => void;
	onEventReady?: (reconnected: boolean) => void | Promise<void>;
}

interface PendingEventStart {
	resolve: () => void;
	reject: (error: HerdrRpcError) => void;
}

export class HerdrClient {
	readonly socketPath: string;
	readonly socketAddress: string;

	private readonly requestTimeoutMs: number;
	private readonly maxLineBytes: number;
	private readonly eventReconnectDelaysMs: readonly number[];
	private readonly connect: (address: string) => Socket;
	private readonly onEventError: ((error: HerdrRpcError) => void) | undefined;
	private readonly onEventReady: ((reconnected: boolean) => void | Promise<void>) | undefined;
	private requestSequence = 0;
	private eventGeneration = 0;
	private eventReconnectAttempts = 0;
	private eventEverAcknowledged = false;
	private eventSocket: Socket | undefined;
	private eventReconnectTimer: ReturnType<typeof setTimeout> | undefined;
	private eventListener: HerdrEventListener | undefined;
	private eventReady: PendingEventStart | undefined;
	private trackedPaneIds = new Set<string>();

	constructor(socketPath: string, options: HerdrClientOptions = {}) {
		if (!socketPath.trim()) throw new TypeError("Herdr socket path must not be empty.");
		const timeout = options.requestTimeoutMs ?? HERDR_REQUEST_TIMEOUT_MS;
		const lineLimit = options.maxLineBytes ?? HERDR_MAX_LINE_BYTES;
		const reconnectDelays = options.eventReconnectDelaysMs ?? [100, 250, 500, 1_000, 2_000];
		if (!Number.isFinite(timeout) || timeout <= 0) {
			throw new TypeError("Herdr request timeout must be a positive number.");
		}
		if (!Number.isSafeInteger(lineLimit) || lineLimit <= 0 || lineLimit > HERDR_MAX_LINE_BYTES) {
			throw new TypeError(`Herdr line limit must be an integer from 1 through ${HERDR_MAX_LINE_BYTES}.`);
		}
		if (reconnectDelays.some((delay) => !Number.isFinite(delay) || delay < 0)) {
			throw new TypeError("Herdr event reconnect delays must be non-negative numbers.");
		}

		const platform = options.platform ?? process.platform;
		const alreadyNamedPipe =
			socketPath.startsWith("\\\\.\\pipe\\") ||
			socketPath.startsWith("\\\\?\\pipe\\") ||
			socketPath.startsWith("//./pipe/") ||
			socketPath.startsWith("//?/pipe/");
		this.socketPath = socketPath;
		this.socketAddress = platform === "win32" && !alreadyNamedPipe ? `\\\\.\\pipe\\${socketPath}` : socketPath;
		this.requestTimeoutMs = timeout;
		this.maxLineBytes = lineLimit;
		this.eventReconnectDelaysMs = [...reconnectDelays];
		this.connect = options.connect ?? ((address) => createConnection(address));
		this.onEventError = options.onEventError;
		this.onEventReady = options.onEventReady;
	}

	async requestRead<M extends HerdrReadMethod>(
		method: M,
		params: HerdrMethodParams[M],
		signal?: AbortSignal,
	): Promise<HerdrMethodResults[M]> {
		for (let attempt = 0; attempt < 2; attempt += 1) {
			try {
				return await this.requestOnce<HerdrMethodResults[M]>(method, params, signal);
			} catch (error) {
				const retry = attempt === 0 && error instanceof HerdrRpcError && error.kind === "transport" && !signal?.aborted;
				if (!retry) throw error;
			}
		}
		throw new Error("unreachable Herdr read retry state");
	}

	requestMutation<M extends HerdrMutationMethod>(
		method: M,
		params: HerdrMethodParams[M],
	): Promise<HerdrMethodResults[M]> {
		return this.requestOnce<HerdrMethodResults[M]>(method, params);
	}

	startEvents(listener: HerdrEventListener, trackedPaneIds: Iterable<string> = []): Promise<void> {
		if (typeof listener !== "function") throw new TypeError("Herdr event listener must be a function.");
		this.stopEvents();
		const panes = new Set<string>();
		for (const paneId of trackedPaneIds) {
			if (typeof paneId !== "string" || !paneId.trim()) {
				throw new TypeError("Tracked Herdr pane IDs must be non-empty strings.");
			}
			panes.add(paneId);
		}

		this.eventListener = listener;
		this.trackedPaneIds = panes;
		this.eventReconnectAttempts = 0;
		this.eventEverAcknowledged = false;
		const generation = ++this.eventGeneration;
		return new Promise<void>((resolve, reject) => {
			this.eventReady = { resolve, reject };
			this.openEventStream(generation);
		});
	}

	updateTrackedPanes(trackedPaneIds: Iterable<string>): void {
		const panes = new Set<string>();
		for (const paneId of trackedPaneIds) {
			if (typeof paneId !== "string" || !paneId.trim()) {
				throw new TypeError("Tracked Herdr pane IDs must be non-empty strings.");
			}
			panes.add(paneId);
		}
		const unchanged =
			panes.size === this.trackedPaneIds.size && [...panes].every((paneId) => this.trackedPaneIds.has(paneId));
		if (unchanged) return;

		this.trackedPaneIds = panes;
		if (!this.eventListener) return;
		const generation = ++this.eventGeneration;
		this.eventReconnectAttempts = 0;
		if (this.eventReconnectTimer) clearTimeout(this.eventReconnectTimer);
		this.eventReconnectTimer = undefined;
		this.eventSocket?.destroy();
		this.eventSocket = undefined;
		this.openEventStream(generation);
	}

	stopEvents(): void {
		const pending = this.eventReady;
		const hadEventState = Boolean(this.eventListener || pending || this.eventSocket || this.eventReconnectTimer);
		if (!hadEventState) return;

		++this.eventGeneration;
		if (this.eventReconnectTimer) clearTimeout(this.eventReconnectTimer);
		this.eventReconnectTimer = undefined;
		this.eventSocket?.destroy();
		this.eventSocket = undefined;
		this.eventListener = undefined;
		this.eventReady = undefined;
		this.eventReconnectAttempts = 0;
		this.eventEverAcknowledged = false;
		this.trackedPaneIds = new Set();
		pending?.reject(
			new HerdrRpcError("Herdr event subscription was stopped.", {
				code: "aborted",
				kind: "aborted",
				method: "events.subscribe",
				delivery: "unknown",
			}),
		);
	}

	dispose(): void {
		this.stopEvents();
	}

	private requestOnce<T>(method: string, params: object, signal?: AbortSignal): Promise<T> {
		const requestId = this.nextRequestId();
		let requestLine: string;
		try {
			requestLine = `${JSON.stringify({ id: requestId, method, params })}\n`;
		} catch (cause) {
			return Promise.reject(
				new HerdrRpcError(`Could not encode Herdr ${method} request as JSON.`, {
					code: "invalid_request",
					kind: "protocol",
					method,
					requestId,
					delivery: "not_sent",
					cause,
				}),
			);
		}
		if (Buffer.byteLength(requestLine) > this.maxLineBytes) {
			return Promise.reject(
				new HerdrRpcError(`Herdr ${method} request exceeds the ${this.maxLineBytes}-byte line limit.`, {
					code: "request_too_large",
					kind: "protocol",
					method,
					requestId,
					delivery: "not_sent",
				}),
			);
		}
		if (signal?.aborted) {
			return Promise.reject(
				new HerdrRpcError(`Herdr ${method} request was aborted.`, {
					code: "aborted",
					kind: "aborted",
					method,
					requestId,
					delivery: "not_sent",
					cause: signal.reason,
				}),
			);
		}

		return new Promise<T>((resolve, reject) => {
			let socket: Socket | undefined;
			let settled = false;
			let connected = false;
			let requestWritten = false;
			let responseBuffer = "";
			let responseReceived = false;
			let responseValue: T | undefined;
			let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
			const finish = (error: HerdrRpcError | undefined, value?: T) => {
				if (settled) return;
				settled = true;
				if (deadlineTimer) clearTimeout(deadlineTimer);
				if (signal) signal.removeEventListener("abort", abort);
				socket?.removeAllListeners();
				socket?.destroy();
				if (error) reject(error);
				else resolve(value as T);
			};
			const abort = () => {
				finish(
					new HerdrRpcError(`Herdr ${method} request was aborted.`, {
						code: "aborted",
						kind: "aborted",
						method,
						requestId,
						delivery: requestWritten ? "unknown" : "not_sent",
						cause: signal?.reason,
					}),
				);
			};
			deadlineTimer = setTimeout(() => {
				finish(
					new HerdrRpcError(`Timed out waiting for Herdr ${method} after ${this.requestTimeoutMs} ms.`, {
						code: "timeout",
						kind: "transport",
						method,
						requestId,
						delivery: requestWritten ? "unknown" : "not_sent",
					}),
				);
			}, this.requestTimeoutMs);
			deadlineTimer.unref?.();

			try {
				socket = this.connect(this.socketAddress);
			} catch (cause) {
				finish(
					new HerdrRpcError(`Could not connect to Herdr for ${method}.`, {
						code: "transport_error",
						kind: "transport",
						method,
						requestId,
						delivery: "not_sent",
						cause,
					}),
				);
				return;
			}

			signal?.addEventListener("abort", abort, { once: true });
			socket.setEncoding("utf8");
			socket.once("connect", () => {
				connected = true;
				requestWritten = true;
				socket?.write(requestLine);
			});
			socket.once("error", (cause) => {
				finish(
					new HerdrRpcError(`Herdr ${method} transport failed: ${cause.message}`, {
						code: "transport_error",
						kind: "transport",
						method,
						requestId,
						delivery: requestWritten ? "unknown" : "not_sent",
						cause,
					}),
				);
			});
			socket.on("data", (chunk: string | Buffer) => {
				if (responseReceived) {
					responseBuffer += chunk.toString();
					if (!responseBuffer.trim()) return;
					finish(
						new HerdrRpcError(`Herdr ${method} returned more than one response line.`, {
							code: "multiple_responses",
							kind: "protocol",
							method,
							requestId,
							delivery: "unknown",
						}),
					);
					return;
				}
				responseBuffer += chunk.toString();
				const newline = responseBuffer.indexOf("\n");
				if (newline < 0) {
					if (Buffer.byteLength(responseBuffer) <= this.maxLineBytes) return;
					finish(
						new HerdrRpcError(`Herdr ${method} response exceeds the ${this.maxLineBytes}-byte line limit.`, {
							code: "response_too_large",
							kind: "protocol",
							method,
							requestId,
							delivery: "unknown",
						}),
					);
					return;
				}

				const line = responseBuffer.slice(0, newline).trim();
				const trailing = responseBuffer.slice(newline + 1).trim();
				responseBuffer = "";
				if (Buffer.byteLength(line) > this.maxLineBytes || trailing) {
					finish(
						new HerdrRpcError(`Herdr ${method} returned an invalid one-line response.`, {
							code: trailing ? "multiple_responses" : "response_too_large",
							kind: "protocol",
							method,
							requestId,
							delivery: "unknown",
						}),
					);
					return;
				}

				let decoded: unknown;
				try {
					decoded = JSON.parse(line);
				} catch (cause) {
					finish(
						new HerdrRpcError(`Herdr ${method} returned malformed JSON.`, {
							code: "invalid_json",
							kind: "protocol",
							method,
							requestId,
							delivery: "unknown",
							cause,
						}),
					);
					return;
				}
				if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
					finish(
						new HerdrRpcError(`Herdr ${method} returned a non-object response.`, {
							code: "invalid_response",
							kind: "protocol",
							method,
							requestId,
							delivery: "unknown",
						}),
					);
					return;
				}

				const response = decoded as Record<string, unknown>;
				if (response.id !== requestId) {
					finish(
						new HerdrRpcError(`Herdr ${method} response ID did not match its request.`, {
							code: "response_id_mismatch",
							kind: "protocol",
							method,
							requestId,
							delivery: "unknown",
						}),
					);
					return;
				}
				const hasResult = Object.hasOwn(response, "result");
				const hasError = Object.hasOwn(response, "error");
				if (hasError && !hasResult) {
					const body = response.error as HerdrErrorResponse["error"] | undefined;
					if (typeof body?.code === "string" && typeof body.message === "string") {
						finish(
							new HerdrRpcError(body.message, {
								code: body.code,
								kind: "remote",
								method,
								requestId,
								delivery: "rejected",
							}),
						);
						return;
					}
				}
				const result = response.result;
				if (
					!hasResult ||
					hasError ||
					typeof result !== "object" ||
					result === null ||
					Array.isArray(result) ||
					typeof (result as Record<string, unknown>).type !== "string"
				) {
					finish(
						new HerdrRpcError(`Herdr ${method} returned an invalid response envelope.`, {
							code: "invalid_response",
							kind: "protocol",
							method,
							requestId,
							delivery: "unknown",
						}),
					);
					return;
				}
				responseReceived = true;
				responseValue = result as T;
			});
			const closed = () => {
				if (responseReceived) {
					finish(undefined, responseValue);
					return;
				}
				finish(
					new HerdrRpcError(`Herdr closed the ${method} connection before a complete response.`, {
						code: "connection_closed",
						kind: "transport",
						method,
						requestId,
						delivery: requestWritten ? "unknown" : "not_sent",
					}),
				);
			};
			socket.once("end", closed);
			socket.once("close", closed);
			if (signal?.aborted) abort();
			if (!connected && socket.destroyed && !settled) closed();
		});
	}

	private openEventStream(generation: number): void {
		if (generation !== this.eventGeneration || !this.eventListener) return;
		const requestId = this.nextRequestId();
		const subscriptions: HerdrSubscription[] = [
			...BASE_EVENT_SUBSCRIPTIONS,
			...[...this.trackedPaneIds]
				.sort()
				.map((paneId) => ({ type: "pane.agent_status_changed" as const, pane_id: paneId })),
		];
		const requestLine = `${JSON.stringify({
			id: requestId,
			method: "events.subscribe",
			params: { subscriptions },
		})}\n`;
		if (Buffer.byteLength(requestLine) > this.maxLineBytes) {
			const error = new HerdrRpcError(`Herdr event subscription exceeds the ${this.maxLineBytes}-byte line limit.`, {
				code: "request_too_large",
				kind: "protocol",
				method: "events.subscribe",
				requestId,
				delivery: "not_sent",
			});
			this.failEventStream(generation, error, false);
			return;
		}

		let socket: Socket;
		try {
			socket = this.connect(this.socketAddress);
		} catch (cause) {
			this.failEventStream(
				generation,
				new HerdrRpcError("Could not connect to Herdr for events.subscribe.", {
					code: "transport_error",
					kind: "transport",
					method: "events.subscribe",
					requestId,
					delivery: "not_sent",
					cause,
				}),
				true,
			);
			return;
		}

		this.eventSocket = socket;
		let acknowledged = false;
		let handledFailure = false;
		let responseBuffer = "";
		let acknowledgementTimer: ReturnType<typeof setTimeout> | undefined;
		const fail = (error: HerdrRpcError, retry: boolean) => {
			if (handledFailure) return;
			handledFailure = true;
			if (acknowledgementTimer) clearTimeout(acknowledgementTimer);
			socket.removeAllListeners();
			socket.destroy();
			if (this.eventSocket === socket) this.eventSocket = undefined;
			this.failEventStream(generation, error, retry);
		};
		acknowledgementTimer = setTimeout(() => {
			fail(
				new HerdrRpcError(`Timed out waiting for Herdr events.subscribe after ${this.requestTimeoutMs} ms.`, {
					code: "timeout",
					kind: "transport",
					method: "events.subscribe",
					requestId,
					delivery: "unknown",
				}),
				true,
			);
		}, this.requestTimeoutMs);
		acknowledgementTimer.unref?.();

		socket.setEncoding("utf8");
		socket.once("connect", () => socket.write(requestLine));
		socket.once("error", (cause) => {
			fail(
				new HerdrRpcError(`Herdr event transport failed: ${cause.message}`, {
					code: "transport_error",
					kind: "transport",
					method: "events.subscribe",
					requestId,
					delivery: acknowledged ? "unknown" : "not_sent",
					cause,
				}),
				true,
			);
		});
		socket.on("data", (chunk: string | Buffer) => {
			if (generation !== this.eventGeneration || !this.eventListener) {
				socket.destroy();
				return;
			}
			responseBuffer += chunk.toString();
			if (Buffer.byteLength(responseBuffer) > this.maxLineBytes && !responseBuffer.includes("\n")) {
				fail(
					new HerdrRpcError("Herdr event stream returned an oversized line.", {
						code: "response_too_large",
						kind: "protocol",
						method: "events.subscribe",
						requestId,
						delivery: "unknown",
					}),
					false,
				);
				return;
			}

			for (let newline = responseBuffer.indexOf("\n"); newline >= 0; newline = responseBuffer.indexOf("\n")) {
				const line = responseBuffer.slice(0, newline).trim();
				responseBuffer = responseBuffer.slice(newline + 1);
				if (!line) continue;
				if (Buffer.byteLength(line) > this.maxLineBytes) {
					fail(
						new HerdrRpcError("Herdr event stream returned an oversized line.", {
							code: "response_too_large",
							kind: "protocol",
							method: "events.subscribe",
							requestId,
							delivery: "unknown",
						}),
						false,
					);
					return;
				}

				let decoded: unknown;
				try {
					decoded = JSON.parse(line);
				} catch (cause) {
					fail(
						new HerdrRpcError("Herdr event stream returned malformed JSON.", {
							code: "invalid_json",
							kind: "protocol",
							method: "events.subscribe",
							requestId,
							delivery: "unknown",
							cause,
						}),
						false,
					);
					return;
				}
				if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
					fail(
						new HerdrRpcError("Herdr event stream returned a non-object line.", {
							code: "invalid_response",
							kind: "protocol",
							method: "events.subscribe",
							requestId,
							delivery: "unknown",
						}),
						false,
					);
					return;
				}

				const value = decoded as Record<string, unknown>;
				if (!acknowledged) {
					if (value.id !== requestId) {
						fail(
							new HerdrRpcError("Herdr event subscription response ID did not match its request.", {
								code: "response_id_mismatch",
								kind: "protocol",
								method: "events.subscribe",
								requestId,
								delivery: "unknown",
							}),
							false,
						);
						return;
					}
					const error = value.error as HerdrErrorResponse["error"] | undefined;
					if (typeof error?.code === "string" && typeof error.message === "string") {
						fail(
							new HerdrRpcError(error.message, {
								code: error.code,
								kind: "remote",
								method: "events.subscribe",
								requestId,
								delivery: "rejected",
							}),
							false,
						);
						return;
					}
					const result = value.result;
					if (
						typeof result !== "object" ||
						result === null ||
						Array.isArray(result) ||
						(result as Record<string, unknown>).type !== "subscription_started"
					) {
						fail(
							new HerdrRpcError("Herdr returned an invalid events.subscribe acknowledgement.", {
								code: "invalid_response",
								kind: "protocol",
								method: "events.subscribe",
								requestId,
								delivery: "unknown",
							}),
							false,
						);
						return;
					}

					acknowledged = true;
					if (acknowledgementTimer) clearTimeout(acknowledgementTimer);
					acknowledgementTimer = undefined;
					const reconnected = this.eventEverAcknowledged;
					this.eventEverAcknowledged = true;
					this.eventReconnectAttempts = 0;
					const ready = this.eventReady;
					this.eventReady = undefined;
					ready?.resolve();
					try {
						const callback = this.onEventReady?.(reconnected);
						if (callback && typeof (callback as Promise<void>).then === "function") {
							void Promise.resolve(callback).catch((cause) => {
								this.reportEventError(
									new HerdrRpcError("Herdr event-ready callback rejected.", {
										code: "ready_callback_error",
										kind: "protocol",
										method: "events.subscribe",
										requestId,
										delivery: "unknown",
										cause,
									}),
								);
							});
						}
					} catch (cause) {
						this.reportEventError(
							new HerdrRpcError("Herdr event-ready callback threw.", {
								code: "ready_callback_error",
								kind: "protocol",
								method: "events.subscribe",
								requestId,
								delivery: "unknown",
								cause,
							}),
						);
					}
					continue;
				}

				const eventName = value.event;
				const eventData = value.data;
				if (
					typeof eventName !== "string" ||
					typeof eventData !== "object" ||
					eventData === null ||
					Array.isArray(eventData)
				) {
					fail(
						new HerdrRpcError("Herdr event stream returned an invalid event envelope.", {
							code: "invalid_event",
							kind: "protocol",
							method: "events.subscribe",
							requestId,
							delivery: "unknown",
						}),
						false,
					);
					return;
				}
				const genericNames = ["pane_agent_detected", "pane_closed", "pane_exited", "tab_closed", "tab_renamed"];
				if (genericNames.includes(eventName)) {
					if ((eventData as Record<string, unknown>).type !== eventName) {
						fail(
							new HerdrRpcError("Herdr generic event type did not match its envelope.", {
								code: "invalid_event",
								kind: "protocol",
								method: "events.subscribe",
								requestId,
								delivery: "unknown",
							}),
							false,
						);
						return;
					}
				} else if (eventName !== "pane.agent_status_changed") {
					continue;
				}

				try {
					const delivered = this.eventListener?.(value as unknown as HerdrEvent);
					if (delivered && typeof (delivered as Promise<void>).then === "function") {
						void Promise.resolve(delivered).catch((cause) => {
							this.reportEventError(
								new HerdrRpcError("Herdr event listener rejected an event.", {
									code: "listener_error",
									kind: "protocol",
									method: "events.subscribe",
									requestId,
									delivery: "unknown",
									cause,
								}),
							);
						});
					}
				} catch (cause) {
					this.reportEventError(
						new HerdrRpcError("Herdr event listener threw while handling an event.", {
							code: "listener_error",
							kind: "protocol",
							method: "events.subscribe",
							requestId,
							delivery: "unknown",
							cause,
						}),
					);
				}
			}
		});
		const disconnected = () => {
			fail(
				new HerdrRpcError("Herdr event stream disconnected.", {
					code: "connection_closed",
					kind: "transport",
					method: "events.subscribe",
					requestId,
					delivery: acknowledged ? "unknown" : "not_sent",
				}),
				true,
			);
		};
		socket.once("end", disconnected);
		socket.once("close", disconnected);
	}

	private failEventStream(generation: number, error: HerdrRpcError, retry: boolean): void {
		if (generation !== this.eventGeneration || !this.eventListener) return;
		const exhaustedInitialConnect =
			!this.eventEverAcknowledged && this.eventReconnectAttempts >= this.eventReconnectDelaysMs.length;
		if (!retry || this.eventReconnectDelaysMs.length === 0 || exhaustedInitialConnect) {
			const ready = this.eventReady;
			this.eventReady = undefined;
			this.eventListener = undefined;
			this.eventSocket = undefined;
			if (ready) ready.reject(error);
			else this.reportEventError(error);
			return;
		}

		if (!this.eventReady) this.reportEventError(error);
		const delayIndex = Math.min(this.eventReconnectAttempts, this.eventReconnectDelaysMs.length - 1);
		const delay = this.eventReconnectDelaysMs[delayIndex] ?? 0;
		this.eventReconnectAttempts += 1;
		this.eventReconnectTimer = setTimeout(() => {
			this.eventReconnectTimer = undefined;
			if (generation === this.eventGeneration && this.eventListener) this.openEventStream(generation);
		}, delay);
		this.eventReconnectTimer.unref?.();
	}

	private reportEventError(error: HerdrRpcError): void {
		try {
			this.onEventError?.(error);
		} catch {
			// Diagnostics must not tear down the event transport.
		}
	}

	private nextRequestId(): string {
		this.requestSequence += 1;
		return `pi-herdr:${process.pid}:${Date.now().toString(36)}:${this.requestSequence.toString(36)}`;
	}
}

export type {
	AgentInfo,
	PaneInfo,
	SessionSnapshot,
	TabInfo,
	WorktreeInfo,
	HerdrEvent,
	HerdrResult,
} from "./herdr-types.js";
