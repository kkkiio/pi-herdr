/**
 * Delegation heuristics for specific models, surfaced in the Agent tool
 * guidelines only when the model is currently authenticated and available.
 *
 * These are experience notes, not benchmarks: keep them hedged, keep the
 * list short, and revisit entries when models change.
 */
export const MODEL_NOTES: Record<string, string> = {
	"deepseek-v4-flash": "fast, but verify its conclusions before acting on them",
	"kimi-3": "strong at frontend and visual tasks, but slow",
	"gpt-5.6-sol": "rigorous, but tends to add self-justifying docs and tests that pollute project context",
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
	return `Available model notes for Agent({model}): ${notes.map(([id, note]) => `${id} — ${note}`).join("; ")}.`;
}

/** Calibration note for a model ("provider/id" or bare id), if one exists. */
export function modelNoteFor(model: string): string | undefined {
	const normalized = normalizeModelId(model.split("/").pop() ?? model);
	return Object.entries(MODEL_NOTES).find(([id]) => normalizeModelId(id) === normalized)?.[1];
}
