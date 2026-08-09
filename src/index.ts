import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { AgentDefinitionStore } from "./agent-definitions.js";
import { AgentRuntime, SpawnedNameSynchronizer } from "./agent-runtime.js";
import { AgentSupervisor } from "./agent-supervisor.js";
import { HerdrClient } from "./herdr-client.js";
import { registerAgentTools, type RuntimeRole } from "./tools.js";
import { registerAgentsUi } from "./ui.js";

export default function piHerdrExtension(pi: ExtensionAPI): void {
	pi.registerFlag("pi-herdr-role", {
		description: "Select the pi-herdr runtime role for a Herdr-managed Pi process.",
		type: "string",
		default: "primary",
	});

	let supervisor: AgentSupervisor | undefined;
	let nameSynchronizer: SpawnedNameSynchronizer | undefined;
	let controlPlaneRegistered = false;
	pi.on("session_start", async (_event, ctx) => {
		if (process.env.HERDR_ENV !== "1" || controlPlaneRegistered) return;
		const socketPath = process.env.HERDR_SOCKET_PATH;
		const callerPaneId = process.env.HERDR_PANE_ID;
		if (!socketPath || !callerPaneId) {
			ctx.ui.notify("pi-herdr is running inside Herdr, but HERDR_SOCKET_PATH or HERDR_PANE_ID is missing.", "error");
			return;
		}
		const roleFlag = pi.getFlag("pi-herdr-role");
		if (roleFlag !== "primary" && roleFlag !== "spawned") {
			ctx.ui.notify(`Invalid --pi-herdr-role value: ${String(roleFlag)}.`, "error");
			return;
		}

		controlPlaneRegistered = true;
		const role: RuntimeRole = roleFlag;
		const client = new HerdrClient(socketPath, {
			onEventError: (error) => ctx.ui.notify(`pi-herdr event stream: ${error.message}`, "warning"),
			onEventReady: async (reconnected) => {
				if (!supervisor) return;
				await supervisor.initialize();
				if (!reconnected) return;
				await supervisor.refresh();
			},
		});
		const definitions = new AgentDefinitionStore({ cwd: ctx.cwd });
		const runtime = new AgentRuntime(fileURLToPath(import.meta.url));
		supervisor = new AgentSupervisor(client, definitions, runtime, callerPaneId);
		registerAgentTools(pi, supervisor, role);
		if (role === "primary") {
			registerAgentsUi(pi, supervisor);
			const diagnostic = await supervisor.configurationDiagnostic(ctx.cwd);
			if (diagnostic) ctx.ui.notify(diagnostic, "error");
		} else {
			nameSynchronizer = new SpawnedNameSynchronizer(
				pi,
				client,
				callerPaneId,
				(message, level) => ctx.ui.notify(message, level),
				() => supervisor!.initialize(),
			);
		}

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
				ctx.ui.notify(
					`pi-herdr could not subscribe to Herdr events: ${error instanceof Error ? error.message : String(error)}`,
					"warning",
				);
			});
	});

	pi.on("session_info_changed", async (event) => {
		await nameSynchronizer?.handle(event.name);
	});

	pi.on("session_shutdown", async () => {
		supervisor?.dispose();
		supervisor = undefined;
		nameSynchronizer = undefined;
	});
}

export { AgentDefinitionStore } from "./agent-definitions.js";
export type { AgentDefinition, ResolvedAgentDefinition } from "./agent-definitions.js";
export { AgentRuntime, SpawnedNameSynchronizer } from "./agent-runtime.js";
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
