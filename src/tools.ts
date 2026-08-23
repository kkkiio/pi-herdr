import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { AgentDefinitionCatalogEntry } from "./agent-definitions.js";
import { THINKING_LEVELS } from "./agent-runtime.js";
import type { AgentSupervisor } from "./agent-supervisor.js";
import { availableModelNotes } from "./model-notes.js";

export type RuntimeRole = "primary" | "spawned";

export function registerAgentTools(
	pi: ExtensionAPI,
	supervisor: AgentSupervisor,
	role: RuntimeRole,
	catalog: readonly AgentDefinitionCatalogEntry[] = [],
	availableModelIds: readonly string[] = [],
): void {
	const thinkingSchema = Type.Union(THINKING_LEVELS.map((level) => Type.Literal(level)));
	const modelNotes = availableModelNotes(availableModelIds);
	if (role === "primary") {
		const catalogDescription = catalog.length
			? catalog.map((entry) => `${entry.name}${entry.description ? ` — ${entry.description}` : ""}`).join("; ")
			: "none";
		pi.registerTool({
			name: "Agent",
			label: "Agent",
			description:
				"Launch a persistent background Agent in a new Herdr tab. Returns after startup and initial prompt delivery, not after the work finishes. Use ListAgents and SendMessage for later interaction.",
			promptSnippet: "Launch a persistent background Agent in Herdr.",
			promptGuidelines: [
				"When a project-specific role would help, prefer checking the task-relevant repository's .agents/agents directories and pass the selected Markdown path explicitly; otherwise use a catalog definition.",
				...(modelNotes ? [modelNotes] : []),
			],
			parameters: Type.Object(
				{
					description: Type.String({ minLength: 1, description: "Short human-readable purpose." }),
					prompt: Type.String({ minLength: 1, description: "The first concrete request for the Agent." }),
					definition: Type.String({
						minLength: 1,
						description: `Catalog name or absolute/explicit relative .md path. Available catalog: ${catalogDescription}`,
					}),
					name: Type.String({
						pattern: "^[a-z][a-z0-9_-]{0,31}$",
						description: "Unique live Agent, session, and tab name.",
					}),
					model: Type.Optional(
						Type.Union([Type.String({ minLength: 1 }), Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })]),
					),
					thinking: Type.Optional(thinkingSchema),
					cwd: Type.Optional(
						Type.String({ minLength: 1, description: "Spawned Agent cwd, resolved independently from definition." }),
					),
					isolation: Type.Optional(Type.Literal("worktree")),
				},
				{ additionalProperties: false },
			),
			execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
				if (signal?.aborted) throw new Error("Agent launch was cancelled before it started.");
				const result = await supervisor.launch(params, ctx);
				return {
					content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
					details: result,
				};
			},
		});
	}

	pi.registerTool({
		name: "ListAgents",
		label: "List Agents",
		description:
			"List every live Agent and Pi peer visible through the current Herdr session, preserving Herdr AgentInfo fields and statuses.",
		promptSnippet: "List live Agents and peers in the current Herdr session.",
		promptGuidelines: role === "spawned" ? ["Use ListAgents to refresh live Agent addresses."] : undefined,
		parameters: Type.Object({}, { additionalProperties: false }),
		execute: async (_toolCallId, _params, signal) => {
			const result = await supervisor.list(signal);
			return {
				content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
				details: result,
			};
		},
	});

	pi.registerTool({
		name: "SendMessage",
		label: "Send Message",
		description:
			role === "spawned"
				? 'Deliver a text request or result to a live Agent or peer through Herdr agent.prompt. Every request you receive begins with an opening <from agent="..." reply-to="..."> envelope; all remaining text in that prompt is the request body. Delivery requires a currently reachable target and is not durably queued.'
				: "Deliver a text request or result to a live Agent or peer through Herdr agent.prompt. Delivery requires a currently reachable target and is not durably queued.",
		promptSnippet: "Send a message to a live Agent or peer.",
		promptGuidelines: [
			"When replying to an Agent request, use the live reply-to address from its opening envelope.",
			...(role === "spawned"
				? [
						"You are a Spawned Agent managed by pi-herdr in a live Herdr pane; your Pi session is persistent and may receive many requests while this pane remains live.",
						"When you finish a request, call SendMessage with the envelope's reply-to value and a concise result, validation status, and remaining risks.",
						"After replying, remain idle and preserve your session context for follow-up work.",
					]
				: ["Do not sleep or poll for a reply; end your turn, and the reply arrives as a new steering message."]),
		],
		parameters: Type.Object(
			{
				agent: Type.String({ minLength: 1, description: "Live Agent name or pane ID." }),
				message: Type.String({ minLength: 1, description: "Message body to deliver." }),
			},
			{ additionalProperties: false },
		),
		execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
			const senderModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
			const result = await supervisor.send(params.agent, params.message, signal, senderModel);
			return {
				content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
				details: result,
			};
		},
	});
}
