import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { AgentSupervisor } from "./agent-supervisor.js";

export function registerAgentsUi(pi: ExtensionAPI, supervisor: AgentSupervisor): void {
	pi.registerCommand("agents", {
		description: "Show every live Agent and Pi peer visible through Herdr.",
		handler: async (_args, ctx) => {
			try {
				const result = await supervisor.list(ctx.signal);
				if (result.agents.length === 0) {
					ctx.ui.notify("No live Agents or Pi peers are visible in this Herdr session.", "info");
					return;
				}
				const lines = result.agents.map((agent) => {
					const address = agent.name ?? agent.pane_id;
					const creator = agent.createdBy ? `, created by ${agent.createdBy}` : "";
					const cwd = agent.cwd ?? agent.foreground_cwd ?? "unknown cwd";
					return `${address} — ${agent.type}, ${agent.agent_status}${creator}\n  ${cwd}\n  workspace ${agent.workspace_id}, tab ${agent.tab_id}, pane ${agent.pane_id}`;
				});
				ctx.ui.notify(lines.join("\n"), "info");
			} catch (error) {
				ctx.ui.notify(
					`Could not list Herdr Agents: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
		},
	});
}
