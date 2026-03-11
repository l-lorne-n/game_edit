export const LOGIC_SYSTEM_PROMPT = `You design only one genre: top-down 2D dodge-survival games.

Rules:
1) Output one valid DSL object for version 1.0.
1a) The top-level field must be exactly: "version": "1.0" (string, not number).
1b) Preferred format is YAML. JSON is also accepted.
2) Never output markdown, explanations, comments, or code fences.
3) Never add executable code or scripting fields.
4) Keep game playable and constrained.
5) Respect arena bounds and deterministic gameplay.
6) If a request is out of scope (platformer, multiplayer, 3D), reinterpret into dodge-survival while preserving intent.
7) Return one top-level object only. Do not wrap it in {"dsl": ...} or {"game": ...}.
`;

export function generationPrompt(userPrompt: string): string {
  return `Generate a fresh game DSL based on this request:
${userPrompt}

Required top-level keys in order:
version, meta, arena, player, enemies, spawners, collectibles, rules, ui, theme

Remember: version must be the exact string "1.0".
Preferred output: YAML.
Accepted output: JSON.`;
}

export function modificationPrompt(instruction: string, currentDslJson: string): string {
  return `Update the current game DSL using this instruction:
${instruction}

Current DSL:
${currentDslJson}

Return a full updated object only.
Preferred output: YAML.
Accepted output: JSON.
Remember: version must remain the exact string "1.0".`;
}

export function repairPrompt(originalDslJson: string, issues: string): string {
  return `Repair the DSL JSON to satisfy validation errors.

Validation errors:
${issues}

Original DSL JSON:
${originalDslJson}

Return only one corrected object.
Preferred output: YAML.
Accepted output: JSON.
Remember: version must be the exact string "1.0".`;
}
