import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { ResolvedAgentDefinition } from "./agent-definitions.js";
import type { AgentInfo } from "./herdr-types.js";
import { HerdrClient } from "./herdr-client.js";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface AgentOverrides {
	model?: string | string[];
	thinking?: ThinkingLevel;
}

export interface AgentLaunchPlan {
	args: string[];
	model?: string;
	thinking?: ThinkingLevel;
}

const SPAWNED_CONTROL_TOOLS = ["ListAgents", "SendMessage"] as const;

const SPAWNED_SYSTEM_PROMPT = `You are a Spawned Agent managed by pi-herdr in a live Herdr pane. Your Pi session is persistent and may receive many requests while this pane remains live. Every incoming request begins with an opening <from agent="..." reply-to="..."> envelope; all remaining text in that prompt is the request body. When you finish a request, call SendMessage with the envelope's reply-to value and a concise result, validation status, and remaining risks. After replying, remain idle and preserve your session context for follow-up work. You may use ListAgents to refresh live addresses. You cannot create or stop Agents, and you must not emulate those capabilities through terminal input, offline mailboxes, or durable queues.`;

export class AgentRuntime {
	constructor(private readonly extensionPath: string) {}

	resolveLaunchPlan(
		agentName: string,
		definition: ResolvedAgentDefinition,
		bundledDefinition: ResolvedAgentDefinition | undefined,
		overrides: AgentOverrides,
		ctx: ExtensionContext,
	): AgentLaunchPlan {
		const explicitCandidates = overrides.model
			? Array.isArray(overrides.model)
				? overrides.model
				: [overrides.model]
			: undefined;
		const defaultCandidates = definition.model
			? Array.isArray(definition.model)
				? definition.model
				: [definition.model]
			: definition.source !== "bundled" && bundledDefinition?.model
				? Array.isArray(bundledDefinition.model)
					? bundledDefinition.model
					: [bundledDefinition.model]
				: undefined;
		const available = ctx.modelRegistry.getAvailable().filter((model) => {
			if (ctx.scopedModels.length === 0) return true;
			return ctx.scopedModels.some(
				(scoped) => scoped.model.provider === model.provider && scoped.model.id === model.id,
			);
		});
		const candidates = explicitCandidates ?? defaultCandidates ?? [];
		let selected = candidates
			.map((candidate) => {
				const trimmed = candidate.trim();
				const firstSlash = trimmed.indexOf("/");
				const provider = firstSlash > 0 ? trimmed.slice(0, firstSlash) : undefined;
				const requestedId = firstSlash > 0 ? trimmed.slice(firstSlash + 1) : trimmed;
				const normalizedId = requestedId.toLowerCase().replace(/[.-]/g, "");
				const canonical = provider
					? available.find(
							(model) =>
								model.provider.toLowerCase() === provider.toLowerCase() &&
								model.id.toLowerCase().replace(/[.-]/g, "") === normalizedId,
						)
					: undefined;
				return (
					canonical ??
					available.find(
						(model) => model.id.toLowerCase().replace(/[.-]/g, "") === trimmed.toLowerCase().replace(/[.-]/g, ""),
					)
				);
			})
			.find((model) => model !== undefined);
		if (!selected && explicitCandidates) {
			throw new Error(
				`Agent model override did not match an authenticated, enabled model: ${explicitCandidates.join(", ")}`,
			);
		}
		if (!selected && !explicitCandidates && candidates.length > 0) selected = ctx.model;
		if (!selected && candidates.length === 0) selected = ctx.model;
		if (!selected) {
			throw new Error("Cannot launch an Agent because the Primary session has no available model.");
		}

		const args = [
			"--name",
			agentName,
			"--extension",
			this.extensionPath,
			"--pi-herdr-role",
			"spawned",
			"--append-system-prompt",
			SPAWNED_SYSTEM_PROMPT.replace(/[\u0000-\u001f\u007f]+/g, " ")
				.replace(/\s+/g, " ")
				.trim(),
		];
		if (definition.prompt.trim()) {
			args.push(
				"--append-system-prompt",
				`Role-specific instructions: ${definition.prompt}`
					.replace(/[\u0000-\u001f\u007f]+/g, " ")
					.replace(/\s+/g, " ")
					.trim(),
			);
		}
		args.push("--model", `${selected.provider}/${selected.id}`);
		const thinking = overrides.thinking ?? definition.thinking;
		if (thinking) args.push("--thinking", thinking);

		if (definition.tools && !(definition.tools.length === 1 && definition.tools[0] === "all")) {
			const tools = [...new Set([...definition.tools, ...SPAWNED_CONTROL_TOOLS])];
			args.push("--tools", tools.join(","));
		}
		if (definition.disallowed_tools?.length) {
			const denied = definition.disallowed_tools.filter(
				(tool) => !SPAWNED_CONTROL_TOOLS.some((control) => control.toLowerCase() === tool.toLowerCase()),
			);
			if (denied.length) args.push("--exclude-tools", denied.join(","));
		}
		if (definition.extensions === false) args.push("--no-extensions");
		if (Array.isArray(definition.extensions)) {
			args.push("--no-extensions");
			for (const extension of definition.extensions) args.push("--extension", extension);
		}
		if (definition.skills === false) args.push("--no-skills");
		if (Array.isArray(definition.skills)) {
			args.push("--no-skills");
			for (const skill of definition.skills) args.push("--skill", skill);
		}

		return {
			args,
			model: `${selected.provider}/${selected.id}`,
			thinking,
		};
	}

	buildEnvelope(sender: AgentInfo, message: string): string {
		const senderAddress = sender.name ?? sender.pane_id;
		const escapedSender = senderAddress
			.replaceAll("&", "&amp;")
			.replaceAll('"', "&quot;")
			.replaceAll("<", "&lt;")
			.replaceAll(">", "&gt;")
			.replaceAll("'", "&apos;");
		return `<from agent="${escapedSender}" reply-to="${escapedSender}">\n${message}`;
	}
}

export class SpawnedNameSynchronizer {
	private lastSyncedName: string | undefined;
	private rollbackEventName: string | undefined;
	private queue: Promise<void> = Promise.resolve();

	constructor(
		private readonly pi: ExtensionAPI,
		private readonly client: HerdrClient,
		private readonly callerPaneId: string,
		private readonly notify: (message: string, level: "info" | "warning" | "error") => void,
		private readonly ensureReady: () => Promise<void>,
	) {
		this.lastSyncedName = pi.getSessionName();
	}

	handle(name: string | undefined): Promise<void> {
		this.queue = this.queue
			.then(async () => {
				if (this.rollbackEventName !== undefined && name === this.rollbackEventName) {
					this.rollbackEventName = undefined;
					return;
				}
				if (name === this.lastSyncedName) return;
				const previousSessionName = this.lastSyncedName;
				if (!name || !/^[a-z][a-z0-9_-]{0,31}$/.test(name)) {
					const restoreCurrentChange = previousSessionName && this.pi.getSessionName() === name;
					if (restoreCurrentChange) {
						this.rollbackEventName = previousSessionName;
						this.pi.setSessionName(previousSessionName);
					}
					this.notify(
						`Agent name must match [a-z][a-z0-9_-]{0,31}; ${restoreCurrentChange ? "the previous name was restored" : "a newer name change remains pending"}.`,
						"error",
					);
					return;
				}
				await this.ensureReady();

				const [currentResult, agentsResult] = await Promise.all([
					this.client.requestRead("pane.current", {
						caller_pane_id: this.callerPaneId,
					}),
					this.client.requestRead("agent.list", {}),
				]);
				if (agentsResult.agents.some((agent) => agent.pane_id !== this.callerPaneId && agent.name === name)) {
					const restoreCurrentChange = previousSessionName && this.pi.getSessionName() === name;
					if (restoreCurrentChange) {
						this.rollbackEventName = previousSessionName;
						this.pi.setSessionName(previousSessionName);
					}
					this.notify(
						`Agent name ${name} is already in use; ${restoreCurrentChange ? "the previous name was restored" : "a newer name change remains pending"}.`,
						"error",
					);
					return;
				}
				const [agentResult, tabResult] = await Promise.all([
					this.client.requestRead("agent.get", {
						target: this.callerPaneId,
					}),
					this.client.requestRead("tab.get", {
						tab_id: currentResult.pane.tab_id,
					}),
				]);
				let renameFailure: unknown;
				try {
					await this.client.requestMutation("agent.rename", { target: this.callerPaneId, name });
					await this.client.requestMutation("tab.rename", { tab_id: currentResult.pane.tab_id, label: name });
					this.lastSyncedName = name;
					return;
				} catch (error) {
					renameFailure = error;
				}

				const rollbackFailures: string[] = [];
				try {
					await this.client.requestMutation("tab.rename", {
						tab_id: currentResult.pane.tab_id,
						label: tabResult.tab.label,
					});
				} catch (error) {
					rollbackFailures.push(`tab: ${error instanceof Error ? error.message : String(error)}`);
				}
				try {
					await this.client.requestMutation("agent.rename", {
						target: this.callerPaneId,
						name: agentResult.agent.name ?? null,
					});
				} catch (error) {
					rollbackFailures.push(`agent: ${error instanceof Error ? error.message : String(error)}`);
				}
				if (previousSessionName && this.pi.getSessionName() === name) {
					this.rollbackEventName = previousSessionName;
					this.pi.setSessionName(previousSessionName);
				}
				this.notify(
					`Could not synchronize Agent name ${name}: ${renameFailure instanceof Error ? renameFailure.message : String(renameFailure)}${rollbackFailures.length ? `; rollback failed for ${rollbackFailures.join(", ")}` : ""}`,
					"error",
				);
			})
			.catch((error) => {
				const previousSessionName = this.lastSyncedName;
				if (previousSessionName && this.pi.getSessionName() === name) {
					this.rollbackEventName = previousSessionName;
					this.pi.setSessionName(previousSessionName);
				}
				this.notify(
					`Agent name synchronization failed: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			});
		return this.queue;
	}
}
