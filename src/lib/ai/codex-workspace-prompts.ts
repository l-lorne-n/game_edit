import type { GeneratedGamePackage } from '@/lib/package/contracts';
import {
  WORKSPACE_CONTRACT_JSON_PATH,
  WORKSPACE_CONTRACT_MARKDOWN_PATH,
} from '@/lib/package/workspace-contract';

type CodexWorkspaceMode = 'create' | 'modify' | 'debug';

type BuildCodexWorkspacePromptInput = {
  mode: CodexWorkspaceMode;
  prompt?: string;
  instruction?: string;
  errorReport?: string;
  currentPackage?: GeneratedGamePackage;
  evaluatorSummary?: string;
  routeMode?: 'design' | 'patch' | 'repair' | null;
  routeReason?: string | null;
  allowedPaths?: string[];
};

const FILE_FIELD_TO_WORKSPACE_PATH: Record<string, string> = {
  indexHtml: 'index.html',
  gameJs: 'game.js',
  styleCss: 'style.css',
  manifestJson: 'manifest.json',
};

function toWorkspacePaths(paths: string[] | undefined): string[] {
  if (!paths || paths.length === 0) {
    return ['index.html', 'game.js', 'style.css', 'manifest.json'];
  }

  return paths.map(path => FILE_FIELD_TO_WORKSPACE_PATH[path] ?? path);
}

function sharedRules(allowedPaths: string[]): string {
  return [
    'You are operating inside a browser mini-game workspace.',
    `Before making changes, read ./${WORKSPACE_CONTRACT_MARKDOWN_PATH} and ./${WORKSPACE_CONTRACT_JSON_PATH} and follow them exactly.`,
    'The deliverable is the WORKSPACE FILES themselves, not a chat explanation.',
    'You MUST directly edit the workspace files and leave them on disk.',
    'Hard constraints:',
    '1) All four files must exist and be non-empty when you finish.',
    '2) Do not use external scripts, npm packages, network requests, or imports.',
    '3) The game must run in a sandboxed browser iframe.',
    '4) Do not answer with prose instead of editing files.',
    '5) If you describe anything in chat, keep it minimal; the files are the real output.',
    '6) For manifest.json, do NOT invent your own schema. Use the exact schema and enum values from the contract files.',
        `7) In this turn you may modify ONLY these files: ${allowedPaths.join(', ')}.`,
    '8) Before finishing, ensure manifest.json is valid JSON and that every required file contains real content, not placeholders.',
  ].join('\n');
}

export function buildCodexWorkspacePrompt(input: BuildCodexWorkspacePromptInput): string {
  const allowedPaths = toWorkspacePaths(input.allowedPaths);
  const rules = sharedRules(allowedPaths);

  if (input.mode === 'create') {
    return `${rules}

Task: create a playable browser mini-game by directly writing the four workspace files.

User request:
${input.prompt ?? 'Create a new mini-game.'}

Execution requirements:
- Build a complete, playable game, not a scaffold description.
- Use the workspace contract files as the source of truth for file responsibilities and manifest rules.
- When done, the workspace should contain a valid 4-file package that can be read back immediately.`;
  }

  if (input.mode === 'modify') {
    return `${rules}

Task: modify the existing browser mini-game by editing the workspace files in place.

User instruction:
${input.instruction ?? 'Apply the requested modification.'}

Routing context:
- routeMode: ${input.routeMode ?? 'unknown'}
- routeReason: ${input.routeReason ?? 'unknown'}

Execution requirements:
- Read the current workspace files directly instead of relying on stale memory.
- Apply the requested change directly to the package, even if it touches gameplay rules, layout, visuals, or structure.
- Only edit the allowed files listed above.
- Keep the final package valid and fully non-empty in all four required files.
- Update manifest.json if the title, summary, notes, or capabilities meaningfully change.`;
  }

  return `${rules}

Task: debug and repair the existing browser mini-game by editing the workspace files in place.

User-reported problem:
${input.errorReport ?? 'No error report provided.'}

Evaluator summary:
${input.evaluatorSummary ?? 'No evaluator summary provided.'}

Execution requirements:
- Read the current workspace files directly before repairing them.
- Fix the actual bug, not just symptoms.
- Leave all four required files valid and non-empty.
- If manifest.json is wrong or invalid, repair it too.
- Do not stop at explanation; the files must be updated on disk.`;
}
