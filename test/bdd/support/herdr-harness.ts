import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import http from "node:http";
import { createConnection, type Socket } from "node:net";
import { join } from "node:path";

const HERDR_PROTOCOL = 17;
const HERDR_VERSION = "0.7.5";

/** Single source of truth for e2e stage budgets; step timeouts derive from these. */
export const E2E_STAGE = {
	serverBoot: 15_000,
	callerPi: 60_000,
	rpc: 10_000,
	launch: 90_000,
	provider: 30_000,
	render: 30_000,
	stop: 10_000,
} as const;

/** Adds ~20% headroom over the summed stage budgets of a step. */
export function stageTimeout(...stages: number[]): number {
	return Math.ceil(stages.reduce((sum, stage) => sum + stage, 0) * 1.2);
}

export const FAUX_PROVIDER = "faux";
export const FAUX_MODEL_ID = "faux-1";
export const FAUX_REPLY = "faux reply: request received";

interface RecordedCompletionRequest {
	model?: string;
	messages?: unknown;
	raw: string;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Minimal OpenAI-compatible chat completions endpoint for real Pi processes.
 * Mirrors the SSE sequence used by pi-ai's own transport tests.
 */
export class FauxProvider {
	private readonly requests: RecordedCompletionRequest[];
	private readonly server: http.Server;
	private readonly port: number;

	private constructor(server: http.Server, port: number, requests: RecordedCompletionRequest[]) {
		this.server = server;
		this.port = port;
		this.requests = requests;
	}

	static async start(): Promise<FauxProvider> {
		const requests: RecordedCompletionRequest[] = [];
		const server = http.createServer((req, res) => {
			if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
				res.writeHead(404).end();
				return;
			}
			let body = "";
			req.on("data", (chunk: Buffer | string) => {
				body += chunk.toString();
			});
			req.on("end", () => {
				let decoded: Record<string, unknown> = {};
				try {
					decoded = JSON.parse(body) as Record<string, unknown>;
				} catch {
					// Keep the raw body for diagnostics even when it is not JSON.
				}
				requests.push({ model: decoded.model as string | undefined, messages: decoded.messages, raw: body });
				const chunk = (delta: Record<string, unknown>, finishReason: string | null, usage?: unknown) =>
					`data: ${JSON.stringify({
						id: "chatcmpl-faux",
						object: "chat.completion.chunk",
						created: 0,
						model: FAUX_MODEL_ID,
						choices: [{ index: 0, delta, finish_reason: finishReason }],
						...(usage ? { usage } : {}),
					})}\n\n`;
				res.writeHead(200, {
					"content-type": "text/event-stream",
					"cache-control": "no-cache",
					connection: "keep-alive",
				});
				res.write(chunk({ role: "assistant", content: FAUX_REPLY }, null));
				res.write(chunk({}, "stop", { prompt_tokens: 1, completion_tokens: 1 }));
				res.write("data: [DONE]\n\n");
				res.end();
			});
		});
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Faux provider failed to bind a port.");
		return new FauxProvider(server, address.port, requests);
	}

	get baseUrl(): string {
		return `http://127.0.0.1:${this.port}/v1`;
	}

	async waitForRequest(containing: string, timeoutMs = E2E_STAGE.provider): Promise<RecordedCompletionRequest> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const match = this.requests.find((request) => request.raw.includes(containing));
			if (match) return match;
			if (Date.now() > deadline) {
				throw new Error(
					`[stage:provider] Faux provider received no request containing ${JSON.stringify(containing)} within ${timeoutMs}ms; saw ${this.requests.length} request(s).`,
				);
			}
			await sleep(100);
		}
	}

	stop(): Promise<void> {
		return new Promise((resolvePromise, rejectPromise) => {
			this.server.close((error) => (error ? rejectPromise(error) : resolvePromise()));
		});
	}
}

/**
 * Runs a real `herdr server` with an isolated config/runtime tree, an isolated
 * Pi agent directory carrying a faux provider and Herdr's Pi integration, and
 * the real `pi` binary on PATH. Only the model endpoint is doubled.
 */
export class HerdrHarness {
	readonly socketPath: string;
	readonly piAgentDir: string;
	readonly provider: FauxProvider;
	private server: ChildProcessWithoutNullStreams | undefined;
	private env: NodeJS.ProcessEnv = {};
	private serverExit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
	private stderr = "";
	private requestSequence = 0;

	private constructor(
		readonly root: string,
		private readonly herdrBin: string,
		provider: FauxProvider,
	) {
		this.socketPath = join(root, "runtime", "herdr.sock");
		this.piAgentDir = join(root, "pi-agent");
		this.provider = provider;
	}

	static async start(root: string, options: { piBinDir: string; shell?: string }): Promise<HerdrHarness> {
		const configured = process.env.HERDR_BIN ?? "herdr";
		const version = spawnSync(configured, ["--version"], { encoding: "utf8" });
		if (version.error) {
			throw new Error(
				`Real Herdr e2e requires the herdr binary (${HERDR_VERSION}); install it or set HERDR_BIN. Cause: ${version.error.message}`,
			);
		}
		const lookup = spawnSync("/bin/sh", ["-c", `command -v -- "${configured}"`], { encoding: "utf8" });
		const provider = await FauxProvider.start();
		const harness = new HerdrHarness(root, lookup.stdout?.toString().trim() || configured, provider);
		await harness.prepareTree(options.piBinDir, options.shell);
		harness.spawnServer(options.piBinDir, options.shell);
		await harness.waitForSocket(E2E_STAGE.serverBoot);
		const pong = await harness.rpc("ping", {});
		if (pong.protocol !== HERDR_PROTOCOL) {
			throw new Error(
				`Real Herdr at ${harness.herdrBin} spoke protocol ${String(pong.protocol)} (version ${String(pong.version)}); pi-herdr targets protocol ${HERDR_PROTOCOL}.`,
			);
		}
		return harness;
	}

	private async prepareTree(piBinDir: string, shell?: string): Promise<void> {
		await mkdir(join(this.root, "config", "herdr"), { recursive: true });
		await mkdir(join(this.root, "runtime"), { recursive: true });
		await mkdir(join(this.root, "home"), { recursive: true });
		await mkdir(this.piAgentDir, { recursive: true });
		await writeFile(join(this.root, "config", "herdr", "config.toml"), "onboarding = false\n");
		await writeFile(
			join(this.piAgentDir, "models.json"),
			`${JSON.stringify({
				providers: {
					[FAUX_PROVIDER]: {
						baseUrl: this.provider.baseUrl,
						api: "openai-completions",
						apiKey: "faux",
						models: [{ id: FAUX_MODEL_ID }],
					},
				},
			})}\n`,
		);
		const install = spawnSync(this.herdrBin, ["integration", "install", "pi"], {
			env: this.baseEnv(piBinDir, shell),
			encoding: "utf8",
		});
		if (install.error || install.status !== 0) {
			throw new Error(`herdr integration install pi failed: ${install.error?.message ?? ""}\n${install.stderr ?? ""}`);
		}
	}

	private baseEnv(piBinDir: string, shell?: string): NodeJS.ProcessEnv {
		const env: NodeJS.ProcessEnv = {
			PATH: `${piBinDir}:${process.env.PATH ?? ""}`,
			HOME: join(this.root, "home"),
			XDG_CONFIG_HOME: join(this.root, "config"),
			XDG_RUNTIME_DIR: join(this.root, "runtime"),
			HERDR_SOCKET_PATH: this.socketPath,
			PI_CODING_AGENT_DIR: this.piAgentDir,
			PI_OFFLINE: "1",
			PI_TELEMETRY: "0",
			SHELL: shell ?? "/bin/sh",
			TERM: "xterm-256color",
			NO_COLOR: "1",
		};
		if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR;
		return env;
	}

	private spawnServer(piBinDir: string, shell?: string): void {
		this.env = this.baseEnv(piBinDir, shell);
		this.server = spawn(this.herdrBin, ["server"], {
			env: this.env,
			stdio: ["ignore", "ignore", "pipe"],
		});
		this.server.stderr.on("data", (chunk: Buffer | string) => {
			this.stderr += chunk.toString();
		});
		this.server.once("exit", (code, signal) => {
			this.serverExit = { code, signal };
		});
	}

	private async waitForSocket(timeoutMs: number): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			if (this.serverExit) {
				throw new Error(
					`herdr server exited before creating its socket (code ${this.serverExit.code}, signal ${this.serverExit.signal}).\n${this.stderr}`,
				);
			}
			const connected = await new Promise<boolean>((resolve) => {
				const socket = createConnection({ path: this.socketPath });
				socket.once("connect", () => {
					socket.end();
					resolve(true);
				});
				socket.once("error", () => resolve(false));
			});
			if (connected) return;
			if (Date.now() > deadline) {
				throw new Error(`herdr server did not create ${this.socketPath} within ${timeoutMs}ms.\n${this.stderr}`);
			}
			await sleep(50);
		}
	}

	/** Raw single-request JSON RPC against the real Herdr socket. */
	rpc(method: string, params: Record<string, unknown>, timeoutMs = E2E_STAGE.rpc): Promise<Record<string, unknown>> {
		const id = `harness-${(this.requestSequence += 1)}`;
		return new Promise((resolvePromise, rejectPromise) => {
			const socket: Socket = createConnection({ path: this.socketPath });
			const timer = setTimeout(() => {
				socket.destroy();
				rejectPromise(new Error(`[stage:rpc] herdr ${method} did not respond within ${timeoutMs}ms.`));
			}, timeoutMs);
			let buffer = "";
			socket.setEncoding("utf8");
			socket.once("error", (error) => {
				clearTimeout(timer);
				rejectPromise(error);
			});
			socket.on("data", (chunk: string) => {
				buffer += chunk;
				const newline = buffer.indexOf("\n");
				if (newline < 0) return;
				clearTimeout(timer);
				socket.end();
				let decoded: { error?: { code?: string; message?: string }; result?: Record<string, unknown> };
				try {
					decoded = JSON.parse(buffer.slice(0, newline));
				} catch (error) {
					rejectPromise(error);
					return;
				}
				if (decoded.error) {
					rejectPromise(
						new Error(`${method} failed: ${decoded.error.code ?? "unknown"}: ${decoded.error.message ?? ""}`),
					);
					return;
				}
				resolvePromise(decoded.result ?? {});
			});
			socket.write(`${JSON.stringify({ id, method, params })}\n`);
		});
	}

	/** Creates a real workspace whose root shell pane acts as the Primary caller. */
	async createCallerPane(cwd: string): Promise<{ workspaceId: string; paneId: string }> {
		const result = await this.rpc("workspace.create", { cwd, label: "pi-herdr-e2e-caller" });
		const workspace = result.workspace as { workspace_id?: string } | undefined;
		const rootPane = result.root_pane as { pane_id?: string } | undefined;
		if (!workspace?.workspace_id || !rootPane?.pane_id) {
			throw new Error(`workspace.create returned no caller pane: ${JSON.stringify(result)}`);
		}
		return { workspaceId: workspace.workspace_id, paneId: rootPane.pane_id };
	}

	/** Starts a real Pi in the given pane and waits until Herdr reports it interactive. */
	async startPiAgent(paneId: string, name: string, args: string[] = [], timeoutMs = E2E_STAGE.callerPi): Promise<void> {
		await this.rpc("agent.start", { name, kind: "pi", pane_id: paneId, args, timeout_ms: 30_000 });
		const deadline = Date.now() + timeoutMs;
		let last = "";
		for (;;) {
			const result = await this.rpc("agent.get", { target: paneId });
			const agent = result.agent as
				{ launch_pending?: boolean; interactive_ready?: boolean; agent_status?: string } | undefined;
			if (agent && agent.launch_pending !== true && agent.interactive_ready === true) return;
			last = JSON.stringify(result);
			if (Date.now() > deadline) {
				const paneText = await this.readPane(paneId).catch(() => "<pane unreadable>");
				throw new Error(
					`[stage:pi-ready] Pi in pane ${paneId} did not become interactive within ${timeoutMs}ms: ${last}\npane text:\n${paneText}`,
				);
			}
			await sleep(250);
		}
	}

	/** Reads the recent terminal text of a real pane through Herdr's pane.read. */
	async readPane(paneId: string): Promise<string> {
		const result = await this.rpc("pane.read", { pane_id: paneId, source: "recent" });
		const read = result.read as { text?: string } | undefined;
		return read?.text ?? "";
	}

	/** Polls a pane's terminal until it shows the expected text. */
	async waitForPaneText(paneId: string, containing: string, timeoutMs = E2E_STAGE.render): Promise<string> {
		const deadline = Date.now() + timeoutMs;
		let lastText = "";
		for (;;) {
			lastText = await this.readPane(paneId);
			if (lastText.includes(containing)) return lastText;
			if (Date.now() > deadline) {
				throw new Error(
					`[stage:render] Pane ${paneId} did not show ${JSON.stringify(containing)} within ${timeoutMs}ms.\n${lastText}`,
				);
			}
			await sleep(250);
		}
	}

	async stop(): Promise<void> {
		const server = this.server;
		this.server = undefined;
		if (server && server.exitCode === null) {
			spawnSync(this.herdrBin, ["server", "stop"], { env: this.env, timeout: E2E_STAGE.stop });
			const exited = await Promise.race([
				once(server, "exit").then(() => true),
				sleep(E2E_STAGE.stop).then(() => false),
			]);
			if (!exited) {
				server.kill("SIGKILL");
				await once(server, "exit").catch(() => undefined);
			}
		}
		await this.provider.stop();
	}
}
