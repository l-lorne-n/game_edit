import { PACKAGE_CAPABILITY_VALUES } from '@/lib/package/contracts';
import type { SandboxWorkspaceFile } from '@/lib/sandbox/types';

export const WORKSPACE_CONTRACT_MARKDOWN_PATH = 'WORKSPACE_CONTRACT.md';
export const WORKSPACE_CONTRACT_JSON_PATH = '.game-edit-contract.json';

export function buildWorkspaceContractMarkdown(): string {
  return `# Game Edit Workspace Contract

## Required workspace files
- index.html
- game.js
- style.css
- manifest.json

These four files are the real deliverable. They must all exist and be non-empty when you finish.

## File responsibilities
- index.html: HTML markup only
- game.js: plain browser JavaScript only, no imports, no bundler assumptions
- style.css: CSS only
- manifest.json: valid JSON matching the manifest contract below

## Manifest contract
- title: string, 1-80 chars
- summary: string, 1-280 chars
- editable: string[] (NOT boolean)
- capabilities: array with at most 3 items, each item must be one of: ${PACKAGE_CAPABILITY_VALUES.join(', ')}
- notes: optional string, max 600 chars

### Valid manifest example
${JSON.stringify(
    {
      title: 'Snake',
      summary: 'A browser snake game with keyboard controls.',
      editable: ['snake speed', 'board size', 'color theme'],
      capabilities: [],
      notes: 'No external dependencies.',
    },
    null,
    2,
  )}

### Invalid manifest examples
- editable: true
- capabilities: ["html5-canvas", "touch-controls"]
- capabilities with more than 3 items

## Hard constraints
1. Do not use external scripts, npm packages, imports, or network requests.
2. The game must run in a sandboxed browser iframe.
3. Do not reply with prose instead of editing files.
4. If a prompt mentions modify/debug restrictions, obey the allowed file list from the prompt.
`;
}

export function buildWorkspaceContractJson(): string {
  return JSON.stringify(
    {
      requiredFiles: ['index.html', 'game.js', 'style.css', 'manifest.json'],
      manifest: {
        title: { type: 'string', min: 1, max: 80 },
        summary: { type: 'string', min: 1, max: 280 },
        editable: { type: 'string[]', minItems: 0, maxItems: 32 },
        capabilities: {
          type: 'enum[]',
          allowed: PACKAGE_CAPABILITY_VALUES,
          maxItems: 3,
        },
        notes: { type: 'string', optional: true, max: 600 },
      },
      invalidExamples: {
        editable: true,
        capabilities: ['html5-canvas', 'touch-controls'],
      },
    },
    null,
    2,
  );
}

export function createWorkspaceContractFiles(rootPath: string): SandboxWorkspaceFile[] {
  const prefix = rootPath.endsWith('/') ? rootPath.slice(0, -1) : rootPath;
  return [
    {
      path: `${prefix}/${WORKSPACE_CONTRACT_MARKDOWN_PATH}`,
      content: buildWorkspaceContractMarkdown(),
    },
    {
      path: `${prefix}/${WORKSPACE_CONTRACT_JSON_PATH}`,
      content: buildWorkspaceContractJson(),
    },
  ];
}
