/** Fixed comparison axes; "unknown" must be explicit, never guessed. */
export type ModelSize = "small" | "medium" | "big";
export type ModelPrice = "cheapest" | "cheap" | "moderate" | "expensive" | "unknown";
export type ModelSpeed = "fast" | "moderate" | "slow" | "unknown";

export interface ModelNote {
	size: ModelSize;
	price: ModelPrice;
	speed: ModelSpeed;
	/** Free-form differentiators beyond the fixed axes: capability ceiling, working style, best use. */
	traits: string;
	/** For the receiver: how much to trust its conclusions. Omitted when there is nothing actionable. */
	soundness?: string;
}

/**
 * Delegation heuristics for specific models. The fixed axes plus `traits`
 * are surfaced in the Agent tool guidelines when the model is available;
 * `soundness` travels in message envelopes so receivers can calibrate trust.
 *
 * These are experience notes, not benchmarks: keep them hedged, keep the
 * list short, and revisit entries when models change.
 */
export const MODEL_NOTES: Record<string, ModelNote> = {
	"deepseek-v4-flash": {
		size: "small",
		price: "cheap",
		speed: "fast",
		traits: "often reaches wrong conclusions too quickly",
		soundness: "verify its conclusions before acting on them",
	},
	"gpt-5.6-luna": {
		size: "small",
		price: "cheapest",
		speed: "slow",
		traits:
			"stays cheap even at max thinking, where it handles medium problems better than deepseek-v4-flash; fan out well-specified, easily verified tasks in parallel",
	},
	"gpt-5.6-terra": {
		size: "medium",
		price: "moderate",
		speed: "slow",
		traits: "capable and rigorous, but may not solve hard problems",
	},
	"kimi-3": {
		size: "big",
		price: "moderate",
		speed: "slow",
		traits: "very smart and strong at frontend and visual tasks",
	},
	"gpt-5.6-sol": {
		size: "big",
		price: "expensive",
		speed: "slow",
		traits: "very smart and rigorous; tends to add self-justifying docs and tests that pollute project context",
	},
};

// Same normalization as AgentRuntime model matching: case-insensitive,
// "." and "-" are equivalent.
function normalizeModelId(id: string): string {
	return id.toLowerCase().replace(/[.-]/g, "");
}

/** Renders the fixed axes that have known values, e.g. "small · cheap · slow". */
function axisLine(note: ModelNote): string {
	return [note.size, note.price, note.speed].filter((axis) => axis !== "unknown").join(" · ");
}

/**
 * One-line Agent-tool guideline covering noted models that are currently
 * available, or undefined when none match (no noise for other users).
 */
export function availableModelNotes(availableModelIds: readonly string[]): string | undefined {
	const available = new Set(availableModelIds.map(normalizeModelId));
	const notes = Object.entries(MODEL_NOTES).filter(([id]) => available.has(normalizeModelId(id)));
	if (!notes.length) return undefined;
	return `Available model notes for Agent({model}): ${notes.map(([id, note]) => `${id} — ${axisLine(note)}; ${note.traits}`).join("; ")}.`;
}

/** Calibration hint for a model ("provider/id" or bare id), if one exists. */
export function modelSoundnessNote(model: string): string | undefined {
	const normalized = normalizeModelId(model.split("/").pop() ?? model);
	return Object.entries(MODEL_NOTES).find(([id]) => normalizeModelId(id) === normalized)?.[1].soundness;
}
