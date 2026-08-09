import { writeFileSync } from "node:fs";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function observePiHerdrSurface(pi: ExtensionAPI): void {
	pi.on("session_start", () => {
		const outputPath = process.env.PI_HERDR_BDD_OBSERVATION_PATH;
		if (!outputPath) throw new Error("PI_HERDR_BDD_OBSERVATION_PATH is required by the BDD observer.");
		const observation = {
			allTools: pi.getAllTools().map((tool) => tool.name),
			activeTools: pi.getActiveTools(),
			commands: pi.getCommands().map((command) => ({ name: command.name, source: command.source })),
		};
		writeFileSync(outputPath, `${JSON.stringify(observation)}\n`, "utf8");
	});
}
