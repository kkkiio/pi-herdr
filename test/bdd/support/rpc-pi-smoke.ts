import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";

export interface PiSurfaceObservation {
	allTools: string[];
	activeTools: string[];
	commands: Array<{ name: string; source: string }>;
	rpcCommands: Array<{ name: string; source: string }>;
}

interface PendingRpc {
	resolve: (response: Record<string, unknown>) => void;
	reject: (error: Error) => void;
	abort: AbortController;
}

export class RpcPiSmoke {
	private readonly process: ChildProcessWithoutNullStreams;
	private readonly pending = new Map<string, PendingRpc>();
	private requestSequence = 0;
	private stderr = "";

	static async start(options: { root: string; socketPath: string; paneId: string }): Promise<RpcPiSmoke> {
		const here = dirname(fileURLToPath(import.meta.url));
		const repository = resolve(here, "../../..");
		const project = join(options.root, "rpc-project");
		const agentDirectory = join(options.root, "rpc-agent");
		const home = join(options.root, "rpc-home");
		const observationPath = join(options.root, "rpc-surface.json");
		await Promise.all([
			mkdir(project, { recursive: true }),
			mkdir(agentDirectory, { recursive: true }),
			mkdir(home, { recursive: true }),
		]);
		const cliPath = join(repository, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
		const args = [
			cliPath,
			"--mode",
			"rpc",
			"--extension",
			join(repository, "src", "index.ts"),
			"--extension",
			join(repository, "test", "bdd", "fixtures", "tool-observer.ts"),
			"--no-session",
			"--no-builtin-tools",
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--no-themes",
			"--no-context-files",
			"--no-approve",
			"--offline",
		];
		const child = spawn(process.execPath, args, {
			cwd: project,
			env: {
				PATH: process.env.PATH,
				HOME: home,
				NO_COLOR: "1",
				CI: "1",
				PI_OFFLINE: "1",
				PI_TELEMETRY: "0",
				PI_CODING_AGENT_DIR: agentDirectory,
				HERDR_ENV: "1",
				HERDR_SOCKET_PATH: options.socketPath,
				HERDR_PANE_ID: options.paneId,
				PI_HERDR_BDD_OBSERVATION_PATH: observationPath,
			},
			stdio: ["pipe", "pipe", "pipe"],
		});
		const rpc = new RpcPiSmoke(child);
		rpc.attachReaders();
		try {
			await rpc.request("get_state");
			const commandResponse = await rpc.request("get_commands");
			const decoded = JSON.parse(await readFile(observationPath, "utf8")) as Omit<PiSurfaceObservation, "rpcCommands">;
			const data = commandResponse.data as { commands?: Array<{ name: string; source: string }> } | undefined;
			if (!Array.isArray(data?.commands)) throw new Error("Pi RPC get_commands returned no command array.");
			rpc.observation = { ...decoded, rpcCommands: data.commands };
			return rpc;
		} catch (error) {
			await rpc.dispose();
			throw error;
		}
	}

	observation: PiSurfaceObservation | undefined;

	private constructor(process: ChildProcessWithoutNullStreams) {
		this.process = process;
	}

	async dispose(): Promise<void> {
		for (const pending of this.pending.values()) {
			pending.abort.abort();
			pending.reject(new Error("Pi RPC smoke process was disposed."));
		}
		this.pending.clear();
		if (this.process.exitCode !== null || this.process.signalCode !== null) return;
		this.process.kill("SIGTERM");
		try {
			await once(this.process, "exit", { signal: AbortSignal.timeout(5_000) });
		} catch {
			if (this.process.exitCode === null && this.process.signalCode === null) {
				this.process.kill("SIGKILL");
				try {
					await once(this.process, "exit", { signal: AbortSignal.timeout(5_000) });
				} catch {
					throw new Error(`Pi RPC process did not exit after SIGKILL.\n${this.stderr}`);
				}
			}
		}
	}

	private request(command: string): Promise<Record<string, unknown>> {
		const id = `bdd_${++this.requestSequence}`;
		const abort = new AbortController();
		const timeout = AbortSignal.timeout(15_000);
		const onTimeout = () => abort.abort(new Error(`Timed out waiting for Pi RPC ${command}.\n${this.stderr}`));
		timeout.addEventListener("abort", onTimeout, { once: true });
		return new Promise<Record<string, unknown>>((resolve, reject) => {
			abort.signal.addEventListener(
				"abort",
				() => {
					this.pending.delete(id);
					timeout.removeEventListener("abort", onTimeout);
					reject(abort.signal.reason instanceof Error ? abort.signal.reason : new Error(String(abort.signal.reason)));
				},
				{ once: true },
			);
			this.pending.set(id, {
				abort,
				resolve: (response) => {
					timeout.removeEventListener("abort", onTimeout);
					if (response.success !== true) {
						reject(new Error(`Pi RPC ${command} failed: ${String(response.error)}\n${this.stderr}`));
						return;
					}
					resolve(response);
				},
				reject,
			});
			this.process.stdin.write(`${JSON.stringify({ id, type: command })}\n`);
		});
	}

	private attachReaders(): void {
		const decoder = new StringDecoder("utf8");
		let buffer = "";
		this.process.stdout.on("data", (chunk: Buffer) => {
			buffer += decoder.write(chunk);
			for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
				const line = buffer.slice(0, newline).trim();
				buffer = buffer.slice(newline + 1);
				if (!line) continue;
				let decoded: unknown;
				try {
					decoded = JSON.parse(line);
				} catch {
					continue;
				}
				if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) continue;
				const response = decoded as Record<string, unknown>;
				if (response.type !== "response" || typeof response.id !== "string") continue;
				const pending = this.pending.get(response.id);
				if (!pending) continue;
				this.pending.delete(response.id);
				pending.resolve(response);
			}
		});
		this.process.stderr.on("data", (chunk: Buffer) => {
			this.stderr += chunk.toString();
		});
		this.process.once("error", (error) => {
			for (const [id, pending] of this.pending) {
				pending.reject(new Error(`Pi RPC process failed to start: ${error.message}`));
				this.pending.delete(id);
			}
		});
		this.process.once("exit", (code, signal) => {
			for (const [id, pending] of this.pending) {
				pending.reject(new Error(`Pi RPC exited (${code ?? signal}).\n${this.stderr}`));
				this.pending.delete(id);
			}
		});
	}
}
