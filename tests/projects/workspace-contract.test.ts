import { describe, expect, it } from 'vitest';

import {
  WORKSPACE_CONTRACT_JSON_PATH,
  WORKSPACE_CONTRACT_MARKDOWN_PATH,
  createWorkspaceContractFiles,
} from '@/lib/package/workspace-contract';

describe('workspace contract files', () => {
  it('creates markdown and json contract files in the workspace root', () => {
    const files = createWorkspaceContractFiles('sessions/sess-1');

    expect(files.map(file => file.path)).toEqual([
      `sessions/sess-1/${WORKSPACE_CONTRACT_MARKDOWN_PATH}`,
      `sessions/sess-1/${WORKSPACE_CONTRACT_JSON_PATH}`,
    ]);
    expect(files[0]?.content).toContain('editable: string[] may appear in older manifests');
    expect(files[1]?.content).toContain('"requiredFiles"');
    expect(files[1]?.content).toContain('"legacyOnly": true');
    expect(files[1]?.content).toContain('"audio"');
  });
});
