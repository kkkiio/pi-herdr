import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { AgentDefinitionCatalogEntry } from "./agent-definitions.js";
import { AGENT_READ_SOURCES } from "./herdr-types.js";
import { THINKING_LEVELS } from "./agent-runtime.js";
import type { AgentSupervisor } from "./agent-supervisor.js";
import { availableModelNotes } from "./model-notes.js";

export function registerAgentTools(
	pi: ExtensionAPI,
	supervisor: AgentSupervisor,
	catalog: readonly AgentDefinitionCatalogEntry[] = [],
	availableModelIds: readonly string[] = [],
): void {
	const thinkingSchema = Type.Union(THINKING_LEVELS.map((level) => Type.Literal(level)));
	const modelNotes = availableModelNotes(availableModelIds);
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
			"When a project-specific role would help, prefer checking the task-relevant repository's .agents/agents directories and pass the selected Markdown path explicitly. Use a catalog definition only when one of the listed roles fits the task; otherwise omit `definition` to use the Pi default agent.",
			...(modelNotes ? [modelNotes] : []),
		],
		parameters: Type.Object(
			{
				description: Type.String({ minLength: 1, description: "Short human-readable purpose." }),
				prompt: Type.String({ minLength: 1, description: "The first concrete request for the Agent." }),
				definition: Type.Optional(
					Type.String({
						minLength: 1,
						description: `Catalog name or absolute/explicit relative .md path. Omit to launch with Pi defaults. Available catalog: ${catalogDescription}`,
					}),
				),
				name: Type.String({
					pattern: "^[a-z][a-z0-9_-]{0,31}$",
					description: "Unique live Agent name; must match [a-z][a-z0-9_-]{0,31}.",
				}),
				model: Type.Optional(
					Type.Union([Type.String({ minLength: 1 }), Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })]),
				),
				thinking: Type.Optional(thinkingSchema),
				cwd: Type.Optional(
					Type.String({ minLength: 1, description: "Agent cwd, resolved independently from definition." }),
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

	pi.registerTool({
		name: "ListAgents",
		label: "List Agents",
		description:
			"List every live Agent and Pi peer visible through the current Herdr session, preserving Herdr AgentInfo fields and statuses.",
		promptSnippet: "List live Agents and peers in the current Herdr session.",
		promptGuidelines: ["Use ListAgents to refresh live Agent addresses."],
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
		name: "ReadAgent",
		label: "Read Agent",
		description:
			"Read a live Agent's terminal screen text through Herdr agent.read. The text is the Agent's own TUI, including its input queue, approval prompts, and working indicator. Passive observation: does not change the Agent or mark anything seen. Use it to inspect what a background Agent is currently showing before deciding whether to wait for it or message it.",
		promptSnippet: "Read a live Agent's current terminal text.",
		promptGuidelines: [
			"Use ReadAgent to inspect a live Agent's screen instead of messaging it to ask what it is doing.",
			'While an Agent is working or blocked, long "recent" reads may fail with agent_not_idle; use source "visible" or retry when the Agent is idle.',
		],
		parameters: Type.Object(
			{
				agent: Type.String({ minLength: 1, description: "Live Agent name or pane ID." }),
				source: Type.Optional(
					Type.Union(
						AGENT_READ_SOURCES.map((source) => Type.Literal(source)),
						{
							description:
								'"recent" (default): last rendered rows plus scrollback; "visible": current screen only, also works while the Agent is working; "recent_unwrapped": recent rows with wrapped lines joined; "detection": the snapshot Herdr uses for status detection.',
						},
					),
				),
				lines: Type.Optional(
					Type.Integer({ minimum: 1, description: "Number of trailing rows for recent sources (default 80)." }),
				),
			},
			{ additionalProperties: false },
		),
		execute: async (_toolCallId, params, signal) => {
			const result = await supervisor.readScreen(params.agent, { source: params.source, lines: params.lines }, signal);
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
			'Deliver a text request or result to a live Agent or peer through Herdr agent.prompt. Every request you receive begins with an opening <from agent="..." reply-to="..."> envelope; all remaining text in that prompt is the request body. Delivery requires a currently reachable target and is not durably queued.',
		promptSnippet: "Send a message to a live Agent or peer.",
		promptGuidelines: [
			"When replying to an Agent request, use the live reply-to address from its opening envelope.",
			"When you finish a request, call SendMessage with the envelope's reply-to value and a concise result, validation status, and remaining risks.",
			"Do not sleep or poll for a reply; end your turn, and the reply arrives as a new steering message.",
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
