export type ModelSize = "small" | "medium" | "big";

export interface ModelNote {
	/** Rough capability and cost tier, for quick elimination. */
	size: ModelSize;
	/** What to delegate to it, including scope limits and relative cost when relevant. */
	strengths: string;
	/**
	 * How much to trust its conclusions, and why. Shown to the chooser and
	 * sent in message envelopes so receivers can calibrate trust. Omitted
	 * when there is nothing actionable.
	 */
	soundness?: string;
}

/**
 * Delegation heuristics for specific models, surfaced in the Agent tool
 * guidelines when the model is available.
 *
 * These are experience notes, not benchmarks: keep them hedged, keep the
 * list short, and revisit entries when models change.
 */
export const MODEL_NOTES: Record<string, ModelNote> = {
	"deepseek-v4-flash": {
		size: "small",
		strengths: "fast; fine for simple mechanical tasks",
		soundness: "often reaches wrong conclusions too quickly — verify before acting on them",
	},
	"gpt-5.6-luna": {
		size: "small",
		strengths:
			"cheap, where it handles medium problems better than deepseek-v4-flash; fan out well-specified, easily verified tasks in parallel",
	},
	"gpt-5.6-terra": {
		size: "medium",
		strengths: "capable and rigorous up to medium-hard problems",
	},
	"kimi-3": {
		size: "big",
		strengths: "very smart, strong at frontend and visual tasks, cheaper than other big models",
	},
	"gpt-5.6-sol": {
		size: "big",
		strengths:
			"very smart and rigorous, for the hardest problems; tends to add self-justifying docs and tests that pollute project context",
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
	return `Available model notes for Agent({model}): ${notes
		.map(
			([id, note]) =>
				`${id} — ${note.size}; ${note.strengths}${note.soundness ? `; soundness: ${note.soundness}` : ""}`,
		)
		.join("; ")}.`;
}

/** Calibration hint for a model ("provider/id" or bare id), if one exists. */
export function modelSoundnessNote(model: string): string | undefined {
	const normalized = normalizeModelId(model.split("/").pop() ?? model);
	return Object.entries(MODEL_NOTES).find(([id]) => normalizeModelId(id) === normalized)?.[1].soundness;
}
