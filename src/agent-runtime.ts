import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { ResolvedAgentDefinition } from "./agent-definitions.js";
import type { AgentInfo } from "./herdr-types.js";
import { modelSoundnessNote } from "./model-notes.js";

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

const CONTROL_TOOLS = ["Agent", "ListAgents", "SendMessage"] as const;

// tty input queues silently truncate typed commands around 1024 bytes
// (herdrdev/herdr#2862); keep the final launch argv well below that.
const MAX_LAUNCH_ARGV_BYTES = 960;

export class AgentRuntime {
	constructor(private readonly extensionPath: string) {}

	resolveLaunchPlan(
		definition: ResolvedAgentDefinition,
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
			throw new Error("Cannot launch an Agent because the current session has no available model.");
		}

		const args = ["--extension", this.extensionPath];
		// Long text must stay out of argv: Herdr delivers agent.start by typing the
		// command into the pane shell, and tty input queues silently truncate around
		// 1024 bytes (herdrdev/herdr#2862). Pi reads file paths for prompt flags, so
		// the definition body reaches the new Agent through its Markdown file.
		if (definition.prompt.trim()) {
			args.push("--append-system-prompt", definition.path);
		}
		args.push("--model", `${selected.provider}/${selected.id}`);
		const thinking = overrides.thinking ?? definition.thinking;
		if (thinking) args.push("--thinking", thinking);

		if (definition.tools && !(definition.tools.length === 1 && definition.tools[0] === "all")) {
			const tools = [...new Set([...definition.tools, ...CONTROL_TOOLS])];
			args.push("--tools", tools.join(","));
		}
		if (definition.disallowed_tools?.length) {
			const denied = definition.disallowed_tools.filter(
				(tool) => !CONTROL_TOOLS.some((control) => control.toLowerCase() === tool.toLowerCase()),
			);
			if (denied.length) args.push("--exclude-tools", denied.join(","));
		}
		if (definition.extensions === false) args.push("--no-extensions");
		if (definition.skills === false) args.push("--no-skills");

		// definition.path and extensionPath lengths vary with user layout (and
		// multi-byte characters cost up to 3 UTF-8 bytes each), so the tty cap
		// above cannot be guaranteed by construction. Fail fast on the final argv
		// instead of letting a deep path reintroduce silent truncation; the
		// 4-byte per-arg allowance covers Herdr's quoting and separators.
		const serializedBytes = args.reduce((total, arg) => total + Buffer.byteLength(arg, "utf8") + 4, 0);
		if (serializedBytes > MAX_LAUNCH_ARGV_BYTES) {
			throw new Error(
				`Agent launch command would be ${serializedBytes} bytes, exceeding the ${MAX_LAUNCH_ARGV_BYTES}-byte tty safety budget ` +
					`(Herdr silently truncates longer typed commands, herdrdev/herdr#2862). ` +
					`Move the definition file to a shorter path or select it by catalog name.`,
			);
		}

		return {
			args,
			model: `${selected.provider}/${selected.id}`,
			thinking,
		};
	}

	buildEnvelope(sender: AgentInfo, message: string, senderModel?: string): string {
		const senderAddress = sender.name ?? sender.pane_id;
		const modelAttribute = senderModel ? ` model="${senderModel}"` : "";
		const note = senderModel ? modelSoundnessNote(senderModel) : undefined;
		// Angle brackets mark pi-herdr-inserted metadata, plain text is the
		// sender's verbatim body; receivers cannot look traits up themselves,
		// so the soundness hint must travel inside the envelope.
		const noteLine = note ? `<sender-model-note>${note}</sender-model-note>\n\n` : "";
		return `<from agent="${senderAddress}" reply-to="${senderAddress}"${modelAttribute}>\n${noteLine}${message}`;
	}
}
