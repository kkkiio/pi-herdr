export interface ModelNote {
	/** For the chooser: what the model is good at, speed, working style. */
	capacity: string;
	/** For the receiver: how much to trust its conclusions. Omitted when there is nothing actionable. */
	soundness?: string;
}

/**
 * Delegation heuristics for specific models. `capacity` is surfaced in the
 * Agent tool guidelines when the model is available; `soundness` travels in
 * message envelopes so receivers can calibrate trust.
 *
 * These are experience notes, not benchmarks: keep them hedged, keep the
 * list short, and revisit entries when models change.
 */
export const MODEL_NOTES: Record<string, ModelNote> = {
	"deepseek-v4-flash": {
		capacity: "small model. fast, but often reaches wrong conclusions too quickly",
		soundness: "verify its conclusions before acting on them",
	},
	"gpt-5.6-luna": {
		capacity: "small model. extremely cheap even at max thinking; good for parallel fan-out of simple tasks, but slow",
	},
	"gpt-5.6-terra": {
		capacity: "medium model. capable and rigorous, but slow and may not solve hard problems",
	},
	"kimi-3": {
		capacity: "big model. very smart and strong at frontend and visual tasks, but slow",
	},
	"gpt-5.6-sol": {
		capacity:
			"big model. very smart and rigorous, but expensive and tends to add self-justifying docs and tests that pollute project context",
	},
};

// Same normalization as AgentRuntime model matching: case-insensitive,
// "." and "-" are equivalent.
function normalizeModelId(id: string): string {
	return id.toLowerCase().replace(/[.-]/g, "");
}

/**
 * One-line Agent-tool guideline covering noted models that are currently
 * available, or undefined when none match (no noise for other users).
 */
export function availableModelNotes(availableModelIds: readonly string[]): string | undefined {
	const available = new Set(availableModelIds.map(normalizeModelId));
	const notes = Object.entries(MODEL_NOTES).filter(([id]) => available.has(normalizeModelId(id)));
	if (!notes.length) return undefined;
	return `Available model notes for Agent({model}): ${notes.map(([id, note]) => `${id} — ${note.capacity}`).join("; ")}.`;
}

/** Calibration hint for a model ("provider/id" or bare id), if one exists. */
export function modelSoundnessNote(model: string): string | undefined {
	const normalized = normalizeModelId(model.split("/").pop() ?? model);
	return Object.entries(MODEL_NOTES).find(([id]) => normalizeModelId(id) === normalized)?.[1].soundness;
}
