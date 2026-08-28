import { readFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { AgentRuntime, type AgentOverrides } from "./agent-runtime.js";
import { HerdrClient, HerdrRpcError } from "./herdr-client.js";
import type { AgentInfo, HerdrEvent, SessionSnapshot } from "./herdr-types.js";

export interface LaunchAgentRequest extends AgentOverrides {
	description: string;
	prompt: string;
	name: string;
	cwd?: string;
	isolation?: "worktree";
}

export interface ListedAgent extends AgentInfo {
	type: "agent" | "peer";
	createdBy?: string;
}

interface OwnedAgent {
	description: string;
	agent: AgentInfo;
	createdByPaneId: string;
}

function currentModelId(ctx: ExtensionContext): string | undefined {
	return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
}

interface SupervisorConfiguration {
	sessionDirectory: string | undefined;
}

/**
 * Oldest supported Herdr socket protocol (Herdr 0.7.5). Newer protocols are
 * accepted as-is: Herdr's JSON RPC surface evolves additively, while the
 * global protocol constant also covers client transport changes pi-herdr
 * does not consume.
 */
const MIN_HERDR_PROTOCOL = 17;

export class AgentSupervisor {
	private readonly owned = new Map<string, OwnedAgent>();
	private readonly launchReservations = new Set<string>();
	private initialized = false;
	private initialization: Promise<void> | undefined;
	private protocolError: Error | undefined;
	private protocolVerified = false;

	constructor(
		private readonly client: HerdrClient,
		private readonly runtime: AgentRuntime,
		private readonly callerPaneId: string,
		private readonly environment: NodeJS.ProcessEnv = process.env,
	) {}

	initialize(): Promise<void> {
		if (this.initialized) return Promise.resolve();
		if (this.initialization) return this.initialization;

		const attempt = (async () => {
			await this.ensureCompatible();
			const ownedBeforeSnapshot = new Set(this.owned.keys());
			const result = await this.client.requestRead("session.snapshot", {});
			this.reconcile(result.snapshot, ownedBeforeSnapshot);
			this.initialized = true;
		})();
		let wrappedAttempt: Promise<void>;
		wrappedAttempt = attempt.finally(() => {
			if (this.initialization === wrappedAttempt) this.initialization = undefined;
		});
		this.initialization = wrappedAttempt;
		return wrappedAttempt;
	}

	async refresh(): Promise<void> {
		await this.initialize();
		const ownedBeforeSnapshot = new Set(this.owned.keys());
		const result = await this.client.requestRead("session.snapshot", {});
		this.reconcile(result.snapshot, ownedBeforeSnapshot);
	}

	configurationDiagnostic(cwd: string): Promise<string | undefined> {
		return this.readConfiguration(cwd).then(
			() => undefined,
			(error) => (error instanceof Error ? error.message : String(error)),
		);
	}

	async launch(
		request: LaunchAgentRequest,
		ctx: ExtensionContext,
	): Promise<{
		status: "launched";
		description: string;
		agent: AgentInfo;
	}> {
		if (
			typeof request.description !== "string" ||
			typeof request.prompt !== "string" ||
			!request.description.trim() ||
			!request.prompt.trim()
		) {
			throw new Error("description and prompt must contain visible text.");
		}
		if (request.cwd !== undefined && (typeof request.cwd !== "string" || !request.cwd.trim())) {
			throw new Error("cwd must contain visible text when provided.");
		}
		if (typeof request.name !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/.test(request.name)) {
			throw new Error("Agent name must match [a-z][a-z0-9_-]{0,31}.");
		}
		if (ctx.signal?.aborted) throw new Error("Agent launch was cancelled before resources were created.");
		await this.initialize();
		if (ctx.signal?.aborted) throw new Error("Agent launch was cancelled before resources were created.");

		const requestedCwd = resolve(ctx.cwd, request.cwd ?? ctx.cwd);
		const ownedBeforeRead = new Set(this.owned.keys());
		const primaryConfiguration = this.readConfiguration(ctx.cwd);
		const sharedLaunchConfiguration =
			request.isolation !== "worktree" && !this.environment.PI_CODING_AGENT_SESSION_DIR
				? requestedCwd === resolve(ctx.cwd)
					? primaryConfiguration
					: this.readConfiguration(requestedCwd)
				: Promise.resolve(undefined);
		const [configuration, launchConfiguration, callerResult, agentsResult] = await Promise.all([
			primaryConfiguration,
			sharedLaunchConfiguration,
			this.client.requestRead("agent.get", { target: this.callerPaneId }, ctx.signal),
			this.client.requestRead("agent.list", {}, ctx.signal),
		]);
		const livePanes = new Set(agentsResult.agents.map((agent) => agent.pane_id));
		for (const paneId of ownedBeforeRead) {
			if (!livePanes.has(paneId)) this.owned.delete(paneId);
		}
		if (agentsResult.agents.some((agent) => agent.name === request.name)) {
			throw new Error(`A live Agent or peer already uses the name ${request.name}.`);
		}
		if (this.launchReservations.has(request.name)) {
			throw new Error(`An Agent named ${request.name} is already being launched by this session.`);
		}
		this.launchReservations.add(request.name);

		let createdTabId: string | undefined;
		let createdPaneId: string | undefined;
		let createdWorktreeWorkspaceId: string | undefined;
		let createdWorktreePath: string | undefined;
		let launchCwd = requestedCwd;
		let launchSessionDirectory =
			launchConfiguration === undefined ? configuration.sessionDirectory : launchConfiguration.sessionDirectory;
		let startedAgent: AgentInfo | undefined;
		try {
			const plan = this.runtime.resolveLaunchPlan(request, ctx);
			if (ctx.signal?.aborted) throw new Error("Agent launch was cancelled before resources were created.");

			if (request.isolation === "worktree") {
				const created = await this.client.requestMutation("worktree.create", {
					cwd: requestedCwd,
					label: request.name,
					focus: false,
				});
				createdWorktreeWorkspaceId = created.workspace.workspace_id;
				createdWorktreePath = created.worktree.path;
				createdTabId = created.tab.tab_id;
				createdPaneId = created.root_pane.pane_id;
				launchCwd = createdWorktreePath || requestedCwd;
				if (!this.environment.PI_CODING_AGENT_SESSION_DIR) {
					launchSessionDirectory = (await this.readConfiguration(launchCwd)).sessionDirectory;
				}
				await this.client.requestMutation("tab.rename", { tab_id: createdTabId, label: request.name });
			} else {
				const created = await this.client.requestMutation("tab.create", {
					workspace_id: callerResult.agent.workspace_id,
					cwd: requestedCwd,
					label: request.name,
					focus: false,
				});
				createdTabId = created.tab.tab_id;
				createdPaneId = created.root_pane.pane_id;
			}

			const started = await this.client.requestMutation("agent.start", {
				name: request.name,
				kind: "pi",
				pane_id: createdPaneId,
				args: plan.args,
				timeout_ms: 30_000,
			});
			startedAgent = started.agent;
			startedAgent = await this.waitForAgentReady(started.agent.pane_id, 35_000, ctx.signal);
			if (ctx.signal?.aborted) throw new Error("Agent launch was cancelled before its initial prompt.");
			const prompted = await this.client.requestMutation("agent.prompt", {
				target: startedAgent.name ?? startedAgent.pane_id,
				text: this.runtime.buildEnvelope(callerResult.agent, request.prompt, currentModelId(ctx)),
			});
			this.owned.set(prompted.agent.pane_id, {
				description: request.description,
				agent: prompted.agent,
				createdByPaneId: callerResult.agent.pane_id,
			});
			this.client.updateTrackedPanes([...this.owned.keys()]);
			return { status: "launched", description: request.description, agent: prompted.agent };
		} catch (error) {
			const cleanupFailures: string[] = [];
			let runtimeClosed = false;
			if (
				error instanceof HerdrRpcError &&
				error.delivery === "unknown" &&
				((error.method === "tab.create" && !createdTabId) ||
					(error.method === "worktree.create" && !createdWorktreeWorkspaceId))
			) {
				cleanupFailures.push(
					`${error.method} delivery=unknown: Herdr may have created an untracked container before its response was lost`,
				);
			}
			if (createdPaneId && !startedAgent?.agent_session) {
				try {
					const current = await this.client.requestRead("agent.get", {
						target: createdPaneId,
					});
					startedAgent = current.agent;
				} catch (inspectionError) {
					if (!(inspectionError instanceof HerdrRpcError && inspectionError.code === "agent_not_found")) {
						cleanupFailures.push(
							`session inspection for pane ${createdPaneId}: ${inspectionError instanceof Error ? inspectionError.message : String(inspectionError)}`,
						);
					}
				}
			}
			if (createdWorktreeWorkspaceId) {
				try {
					await this.client.requestMutation("worktree.remove", {
						workspace_id: createdWorktreeWorkspaceId,
						force: false,
					});
					runtimeClosed = true;
				} catch (cleanupError) {
					if (cleanupError instanceof HerdrRpcError && cleanupError.code === "workspace_not_found") {
						runtimeClosed = true;
					} else {
						cleanupFailures.push(
							`worktree ${createdWorktreeWorkspaceId}${createdWorktreePath ? ` at ${createdWorktreePath}` : ""}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
						);
					}
					if (createdPaneId && !runtimeClosed) {
						try {
							await this.client.requestMutation("pane.close", { pane_id: createdPaneId });
							runtimeClosed = true;
						} catch (paneError) {
							if (paneError instanceof HerdrRpcError && paneError.code === "pane_not_found") {
								runtimeClosed = true;
							} else {
								cleanupFailures.push(
									`pane ${createdPaneId}: ${paneError instanceof Error ? paneError.message : String(paneError)}`,
								);
							}
						}
					}
				}
			} else if (createdTabId) {
				try {
					await this.client.requestMutation("tab.close", { tab_id: createdTabId });
					runtimeClosed = true;
				} catch (cleanupError) {
					if (cleanupError instanceof HerdrRpcError && cleanupError.code === "tab_not_found") {
						runtimeClosed = true;
					} else {
						cleanupFailures.push(
							`tab ${createdTabId}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
						);
					}
				}
			}

			const session = startedAgent?.agent_session;
			const configuredAgentDirectory = this.environment.PI_CODING_AGENT_DIR;
			const agentHomeRelative = configuredAgentDirectory?.match(/^~[\\/](.*)$/);
			const expandedAgentDirectory = agentHomeRelative
				? join(homedir(), agentHomeRelative[1] ?? "")
				: configuredAgentDirectory === "~"
					? homedir()
					: configuredAgentDirectory;
			const agentDirectory = expandedAgentDirectory
				? resolve(launchCwd, expandedAgentDirectory)
				: join(homedir(), ".pi", "agent");
			const configuredSessionDirectory = this.environment.PI_CODING_AGENT_SESSION_DIR || launchSessionDirectory;
			const sessionHomeRelative = configuredSessionDirectory?.match(/^~[\\/](.*)$/);
			const expandedSessionDirectory = sessionHomeRelative
				? join(homedir(), sessionHomeRelative[1] ?? "")
				: configuredSessionDirectory === "~"
					? homedir()
					: configuredSessionDirectory;
			const sessionRoot = expandedSessionDirectory
				? resolve(launchCwd, expandedSessionDirectory)
				: join(agentDirectory, "sessions");
			const sessionRelativePath = session?.kind === "path" ? relative(sessionRoot, session.value) : undefined;
			const removableSession =
				session?.source === "herdr:pi" &&
				session.agent === "pi" &&
				session.kind === "path" &&
				isAbsolute(session.value) &&
				Boolean(sessionRelativePath) &&
				!isAbsolute(sessionRelativePath ?? "") &&
				sessionRelativePath !== ".." &&
				!sessionRelativePath?.startsWith(`..${sep}`) &&
				basename(session.value).endsWith(".jsonl");
			let sessionPreservationReported = false;
			if (removableSession && runtimeClosed) {
				if (!createdPaneId) {
					runtimeClosed = false;
					cleanupFailures.push(
						`session ${session?.value}: preserved because the launched pane ID is unavailable for closure verification`,
					);
					sessionPreservationReported = true;
				} else {
					try {
						await this.client.requestRead("agent.get", { target: createdPaneId });
						runtimeClosed = false;
						cleanupFailures.push(
							`session ${session?.value}: preserved because Agent pane ${createdPaneId} remained live after container cleanup`,
						);
						sessionPreservationReported = true;
					} catch (verificationError) {
						if (!(verificationError instanceof HerdrRpcError && verificationError.code === "agent_not_found")) {
							runtimeClosed = false;
							cleanupFailures.push(
								`session ${session?.value}: preserved because closure of Agent pane ${createdPaneId} could not be verified: ${verificationError instanceof Error ? verificationError.message : String(verificationError)}`,
							);
							sessionPreservationReported = true;
						}
					}
				}
			}
			if (removableSession && session && runtimeClosed) {
				try {
					await unlink(session.value);
				} catch (cleanupError) {
					if (!(cleanupError instanceof Error && "code" in cleanupError && cleanupError.code === "ENOENT")) {
						cleanupFailures.push(
							`session ${session.value}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
						);
					}
				}
			} else if (removableSession && session && !sessionPreservationReported) {
				cleanupFailures.push(
					`session ${session.value}: preserved because the Agent pane could not be confirmed closed`,
				);
			} else if (session) {
				cleanupFailures.push(
					`session ${session.value}: Herdr returned a session reference outside the new Pi session tree`,
				);
			}
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(
				`Failed to launch Agent ${request.name}: ${message}${cleanupFailures.length ? `; cleanup left residual resources: ${cleanupFailures.join("; ")}` : ""}`,
				{ cause: error },
			);
		} finally {
			this.launchReservations.delete(request.name);
		}
	}

	async list(signal?: AbortSignal): Promise<{ agents: ListedAgent[] }> {
		await this.initialize();
		if (signal?.aborted) throw new Error("Agent discovery was cancelled before it started.");
		const ownedBeforeRead = new Set(this.owned.keys());
		const result = await this.client.requestRead("agent.list", {}, signal);
		const liveByPane = new Map(result.agents.map((agent) => [agent.pane_id, agent]));
		for (const paneId of ownedBeforeRead) {
			const record = this.owned.get(paneId);
			if (!record) continue;
			const current = liveByPane.get(paneId);
			if (!current) this.owned.delete(paneId);
			else record.agent = current;
		}
		this.client.updateTrackedPanes([...this.owned.keys()]);
		return {
			agents: result.agents.map((agent) => {
				const record = this.owned.get(agent.pane_id);
				if (!record) return { ...agent, type: "peer" as const };
				const creator = liveByPane.get(record.createdByPaneId);
				return {
					...agent,
					type: "agent" as const,
					createdBy: creator?.name ?? record.createdByPaneId,
				};
			}),
		};
	}

	async send(
		target: string,
		message: string,
		signal?: AbortSignal,
		senderModel?: string,
	): Promise<{ delivered: true; agent: AgentInfo }> {
		if (typeof target !== "string" || typeof message !== "string" || !target.trim() || !message.trim()) {
			throw new Error("agent and message must contain visible text.");
		}
		await this.initialize();
		if (signal?.aborted) throw new Error("Message delivery was cancelled before target resolution.");
		const [senderResult, targetResult] = await Promise.all([
			this.client.requestRead(
				"agent.get",
				{
					target: this.callerPaneId,
				},
				signal,
			),
			this.client.requestRead("agent.get", { target }, signal),
		]);
		if (signal?.aborted) throw new Error("Message delivery was cancelled before agent.prompt.");
		const result = await this.client.requestMutation("agent.prompt", {
			target: targetResult.agent.name ?? targetResult.agent.pane_id,
			text: this.runtime.buildEnvelope(senderResult.agent, message, senderModel),
		});
		return { delivered: true, agent: result.agent };
	}

	private reconcile(snapshot: SessionSnapshot, ownedBeforeRead: ReadonlySet<string>): void {
		if (!Number.isFinite(snapshot.protocol) || snapshot.protocol < MIN_HERDR_PROTOCOL) {
			this.initialized = false;
			this.protocolVerified = false;
			this.protocolError = new Error(
				`pi-herdr requires Herdr socket protocol ${MIN_HERDR_PROTOCOL} or newer (Herdr 0.7.5+), but the connected server reports ${snapshot.protocol} (${snapshot.version}).`,
			);
			throw this.protocolError;
		}
		const live = new Map(snapshot.agents.map((agent) => [agent.pane_id, agent]));
		for (const paneId of ownedBeforeRead) {
			const record = this.owned.get(paneId);
			if (!record) continue;
			const current = live.get(paneId);
			if (!current) this.owned.delete(paneId);
			else record.agent = current;
		}
		this.client.updateTrackedPanes([...this.owned.keys()]);
	}

	handleEvent(event: HerdrEvent): void {
		const data = event.data as Record<string, unknown>;
		if (event.event === "pane_closed" || event.event === "pane_exited") {
			if (typeof data.pane_id === "string") this.owned.delete(data.pane_id);
		} else if (event.event === "pane_agent_detected") {
			if (
				typeof data.pane_id === "string" &&
				(data.released === true || data.agent === null || data.agent === undefined)
			) {
				this.owned.delete(data.pane_id);
			}
		} else if (event.event === "tab_closed" && typeof data.tab_id === "string") {
			for (const [paneId, record] of this.owned) {
				if (record.agent.tab_id === data.tab_id) this.owned.delete(paneId);
			}
		} else if (
			event.event === "pane.agent_status_changed" &&
			typeof data.pane_id === "string" &&
			typeof data.agent_status === "string"
		) {
			const record = this.owned.get(data.pane_id);
			if (record) record.agent = { ...record.agent, agent_status: data.agent_status as AgentInfo["agent_status"] };
		}
		this.client.updateTrackedPanes([...this.owned.keys()]);
	}

	dispose(): void {
		this.client.dispose();
		this.initialized = false;
		this.initialization = undefined;
		this.owned.clear();
		this.launchReservations.clear();
	}

	private async ensureCompatible(signal?: AbortSignal): Promise<void> {
		if (this.protocolError) throw this.protocolError;
		if (this.protocolVerified) return;
		const result = await this.client.requestRead("ping", {}, signal);
		if (!Number.isFinite(result.protocol) || result.protocol < MIN_HERDR_PROTOCOL) {
			this.protocolError = new Error(
				`pi-herdr requires Herdr socket protocol ${MIN_HERDR_PROTOCOL} or newer (Herdr 0.7.5+), but the connected server reports ${result.protocol} (${result.version}).`,
			);
			throw this.protocolError;
		}
		this.protocolVerified = true;
	}

	private async waitForAgentReady(target: string, timeoutMs: number, signal?: AbortSignal): Promise<AgentInfo> {
		const deadline = Date.now() + timeoutMs;
		let lastAgent: AgentInfo | undefined;
		let lastError: unknown;
		while (Date.now() < deadline) {
			if (signal?.aborted) throw new Error("Agent launch was cancelled while Pi was starting.");
			try {
				const result = await this.client.requestRead(
					"agent.get",
					{
						target,
					},
					signal,
				);
				lastAgent = result.agent;
				if (!lastAgent.launch_pending && lastAgent.interactive_ready) return lastAgent;
			} catch (error) {
				if (signal?.aborted) throw new Error("Agent launch was cancelled while Pi was starting.", { cause: error });
				lastError = error;
			}
			const remaining = deadline - Date.now();
			if (remaining <= 0) break;
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(
					() => {
						signal?.removeEventListener("abort", abort);
						resolve();
					},
					Math.min(250, remaining),
				);
				const abort = () => {
					clearTimeout(timer);
					reject(new Error("Agent launch was cancelled while Pi was starting."));
				};
				signal?.addEventListener("abort", abort, { once: true });
				if (signal?.aborted) abort();
			});
		}
		const state = lastAgent
			? `launch_pending=${lastAgent.launch_pending}, interactive_ready=${lastAgent.interactive_ready}, status=${lastAgent.agent_status}`
			: `last read failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`;
		throw new Error(`Agent ${target} did not become interactive within ${timeoutMs}ms (${state}).`);
	}

	private async readConfiguration(cwd: string): Promise<SupervisorConfiguration> {
		const configuredAgentDirectory = this.environment.PI_CODING_AGENT_DIR;
		const agentHomeRelative = configuredAgentDirectory?.match(/^~[\\/](.*)$/);
		const expandedAgentDirectory = agentHomeRelative
			? join(homedir(), agentHomeRelative[1] ?? "")
			: configuredAgentDirectory === "~"
				? homedir()
				: configuredAgentDirectory;
		const agentDirectory = expandedAgentDirectory
			? resolve(cwd, expandedAgentDirectory)
			: join(homedir(), ".pi", "agent");
		const paths = [join(agentDirectory, "settings.json"), join(cwd, ".pi", "settings.json")];
		let sessionDirectory: string | undefined;
		for (const path of paths) {
			let text: string;
			try {
				text = await readFile(path, "utf8");
			} catch (error) {
				if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
				throw new Error(`Cannot read Pi settings ${path}: ${error instanceof Error ? error.message : String(error)}`);
			}
			let settings: unknown;
			try {
				settings = JSON.parse(text);
			} catch (error) {
				throw new Error(`Cannot parse Pi settings ${path}: ${error instanceof Error ? error.message : String(error)}`);
			}
			if (typeof settings !== "object" || settings === null || Array.isArray(settings)) {
				throw new Error(`Pi settings ${path} must contain a JSON object.`);
			}
			const settingsRecord = settings as Record<string, unknown>;
			if (Object.hasOwn(settingsRecord, "sessionDir")) {
				const value = settingsRecord.sessionDir;
				if (value !== undefined && value !== null && typeof value !== "string") {
					throw new Error(`Pi setting sessionDir in ${path} must be a string.`);
				}
				sessionDirectory = typeof value === "string" && value.length > 0 ? value : undefined;
			}
		}
		return { sessionDirectory };
	}
}
