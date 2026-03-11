import type { GeneratedGamePackage } from '@/lib/package/contracts';

export const PACKAGE_SYSTEM_PROMPT = `You generate browser mini-game packages.

Hard constraints:
1) Return exactly one JSON object with exactly 4 string fields:
   - indexHtml
   - gameJs
   - styleCss
   - manifestJson
2) Do NOT return markdown, explanations, comments, or code fences.
3) manifestJson must itself be valid JSON string with keys:
   - title (string)
   - summary (string)
   - editable (string[])
   - capabilities (array of: audio | fullscreen | pointerLock)
   - notes (optional string)
4) Do not use external scripts or network requests.
5) Game must run in a browser sandbox iframe with no same-origin access.
6) Keep game code concise and deterministic.
`;

export function packageGenerationPrompt(userPrompt: string): string {
  return `Create a new mini-game package for this request:
${userPrompt}

The package must be playable in a single HTML page with inline CSS and JS files represented as strings.
Include keyboard support where relevant.
Ensure gameJs can execute without bundlers or imports.
Return only the JSON package object.`;
}

function stringifyPackage(pkg: GeneratedGamePackage): string {
  return JSON.stringify(pkg, null, 2);
}

export function packageModificationPrompt(input: {
  instruction: string;
  currentPackage: GeneratedGamePackage;
}): string {
  return `Modify the current mini-game package according to this instruction:
${input.instruction}

Current package:
${stringifyPackage(input.currentPackage)}

Keep the same 4-file package shape.
Return the full updated package object only.`;
}

export function packageDebugPrompt(input: {
  errorReport: string;
  currentPackage: GeneratedGamePackage;
  evaluatorSummary?: string;
}): string {
  return `Repair the current mini-game package using this debug report.

User debug report:
${input.errorReport}

Evaluator summary:
${input.evaluatorSummary ?? 'No evaluator summary provided.'}

Current package:
${stringifyPackage(input.currentPackage)}

Return a full repaired package object with the same 4-file shape.`;
}

export function packageRepairPrompt(input: {
  candidateText: string;
  validationIssues: string;
}): string {
  return `Repair this package output so it satisfies schema and syntax checks.

Validation issues:
${input.validationIssues}

Original candidate:
${input.candidateText}

Return only one corrected package JSON object with fields:
indexHtml, gameJs, styleCss, manifestJson.`;
}
