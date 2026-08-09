import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { AgentSupervisor } from "./agent-supervisor.js";
import { THINKING_LEVELS } from "./agent-runtime.js";

export type RuntimeRole = "primary" | "spawned";

export function registerAgentTools(pi: ExtensionAPI, supervisor: AgentSupervisor, role: RuntimeRole): void {
	const thinkingSchema = Type.Union(THINKING_LEVELS.map((level) => Type.Literal(level)));
	if (role === "primary") {
		pi.registerTool({
			name: "Agent",
			label: "Agent",
			description:
				"Launch a persistent background Pi Agent in a new Herdr tab. Returns after startup and initial prompt delivery, not after the work finishes. Use ListAgents and SendMessage for later interaction.",
			promptSnippet: "Launch a persistent background Agent in Herdr.",
			promptGuidelines: [
				"Give every Agent a unique lowercase name matching [a-z][a-z0-9_-]{0,31}.",
				"Use isolation=worktree only when the Agent needs an independent Git checkout.",
			],
			parameters: Type.Object(
				{
					description: Type.String({ minLength: 1, description: "Short human-readable purpose." }),
					prompt: Type.String({ minLength: 1, description: "The first concrete request for the Agent." }),
					agent_type: Type.String({ minLength: 1, description: "Agent definition name, such as explorer." }),
					name: Type.String({
						pattern: "^[a-z][a-z0-9_-]{0,31}$",
						description: "Unique live Agent, session, and tab name.",
					}),
					model: Type.Optional(
						Type.Union([Type.String({ minLength: 1 }), Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })]),
					),
					thinking: Type.Optional(thinkingSchema),
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

		pi.registerTool({
			name: "StopAgent",
			label: "Stop Agent",
			description:
				"Stop another live Agent or peer by closing only its managed Herdr pane. This preserves its Pi session and worktree and refuses to stop the caller.",
			promptSnippet: "Stop another live Agent or peer without deleting its session.",
			parameters: Type.Object(
				{
					agent: Type.String({ minLength: 1, description: "Live Agent name or pane ID." }),
				},
				{ additionalProperties: false },
			),
			execute: async (_toolCallId, params, signal) => {
				const result = await supervisor.stop(params.agent, signal);
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
			"Deliver a text request or result to a live Agent or peer through Herdr agent.prompt. Delivery requires a currently reachable target and is not durably queued.",
		promptSnippet: "Send a message to a live Agent or peer.",
		promptGuidelines: ["When replying to an Agent request, use the live reply-to address from its opening envelope."],
		parameters: Type.Object(
			{
				agent: Type.String({ minLength: 1, description: "Live Agent name or pane ID." }),
				message: Type.String({ minLength: 1, description: "Message body to deliver." }),
			},
			{ additionalProperties: false },
		),
		execute: async (_toolCallId, params, signal) => {
			const result = await supervisor.send(params.agent, params.message, signal);
			return {
				content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
				details: result,
			};
		},
	});
}
