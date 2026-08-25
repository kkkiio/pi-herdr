import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { AgentDefinitionStore } from "./agent-definitions.js";
import { AgentRuntime } from "./agent-runtime.js";
import { AgentSupervisor } from "./agent-supervisor.js";
import { HerdrClient } from "./herdr-client.js";
import { registerAgentTools } from "./tools.js";
import { registerAgentsUi } from "./ui.js";

type HerdrConnectionState = "connecting" | "connected" | "reconnecting" | "down";

function describeError(error: unknown): string {
	const messages: string[] = [];
	let current: unknown = error;
	while (current instanceof Error && !messages.includes(current.message)) {
		messages.push(current.message);
		current = current.cause;
	}
	return messages.length > 0 ? messages.join(" — ") : String(error);
}

export default function piHerdrExtension(pi: ExtensionAPI): void {
	let supervisor: AgentSupervisor | undefined;
	let controlPlaneRegistered = false;
	pi.on("session_start", async (_event, ctx) => {
		if (process.env.HERDR_ENV !== "1" || controlPlaneRegistered) return;
		const socketPath = process.env.HERDR_SOCKET_PATH;
		const callerPaneId = process.env.HERDR_PANE_ID;
		if (!socketPath || !callerPaneId) {
			ctx.ui.notify("pi-herdr is running inside Herdr, but HERDR_SOCKET_PATH or HERDR_PANE_ID is missing.", "error");
			return;
		}

		controlPlaneRegistered = true;
		let connectionState: HerdrConnectionState = "connecting";
		const setConnectionState = (state: HerdrConnectionState): void => {
			connectionState = state;
			const theme = ctx.ui.theme;
			const text =
				state === "connected"
					? theme.fg("success", "herdr ●")
					: state === "connecting"
						? theme.fg("dim", "herdr …")
						: state === "reconnecting"
							? theme.fg("warning", "herdr ↻ reconnecting")
							: theme.fg("error", "herdr ✕ disconnected");
			ctx.ui.setStatus("pi-herdr", text);
		};
		setConnectionState("connecting");
		const client = new HerdrClient(socketPath, {
			onEventError: (error) => {
				if (connectionState === "reconnecting" || connectionState === "down") return;
				setConnectionState("reconnecting");
				ctx.ui.notify(
					`pi-herdr event stream: ${describeError(error)} Reconnecting in the background; further failures appear in the status line.`,
					"warning",
				);
			},
			onEventReady: async (reconnected) => {
				if (supervisor) {
					await supervisor.initialize();
					if (reconnected) await supervisor.refresh();
				}
				if (connectionState === "reconnecting" || connectionState === "down") {
					ctx.ui.notify("pi-herdr reconnected to the Herdr event stream.", "info");
				}
				setConnectionState("connected");
			},
		});
		const definitions = new AgentDefinitionStore();
		const runtime = new AgentRuntime(fileURLToPath(import.meta.url));
		supervisor = new AgentSupervisor(client, definitions, runtime, callerPaneId);
		const catalog = await definitions.catalog();
		const availableModelIds = ctx.modelRegistry.getAvailable().map((model) => model.id);
		registerAgentTools(pi, supervisor, catalog.entries, availableModelIds);
		registerAgentsUi(pi, supervisor);
		for (const diagnostic of catalog.diagnostics) ctx.ui.notify(diagnostic, "error");
		const diagnostic = await supervisor.configurationDiagnostic(ctx.cwd);
		if (diagnostic) ctx.ui.notify(diagnostic, "error");

		try {
			await supervisor.initialize();
		} catch (error) {
			ctx.ui.notify(
				`pi-herdr could not initialize the Herdr control plane: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
		}
		void client
			.startEvents((event) => supervisor?.handleEvent(event))
			.catch((error) => {
				setConnectionState("down");
				ctx.ui.notify(`pi-herdr could not subscribe to Herdr events: ${describeError(error)}`, "warning");
			});
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		ctx.ui.setStatus("pi-herdr", undefined);
		supervisor?.dispose();
		supervisor = undefined;
	});
}

export { AgentDefinitionStore } from "./agent-definitions.js";
export type {
	AgentDefinition,
	AgentDefinitionCatalog,
	AgentDefinitionCatalogEntry,
	ResolvedAgentDefinition,
} from "./agent-definitions.js";
export { AgentRuntime } from "./agent-runtime.js";
export type { AgentLaunchPlan, AgentOverrides, ThinkingLevel } from "./agent-runtime.js";
export { AgentSupervisor } from "./agent-supervisor.js";
export type { LaunchAgentRequest, ListedAgent } from "./agent-supervisor.js";
export { HerdrClient, HerdrRpcError } from "./herdr-client.js";
export type {
	HerdrClientOptions,
	HerdrDeliveryState,
	HerdrRpcErrorKind,
	HerdrRpcErrorOptions,
} from "./herdr-client.js";
export type * from "./herdr-types.js";
