import { describe, expect, it } from 'vitest';

import { buildCodexWorkspacePrompt } from '@/lib/ai/codex-workspace-prompts';
import { createTemplatePackage } from '@/lib/package/template';

describe('buildCodexWorkspacePrompt', () => {
  it('forces create prompts to write all required files', () => {
    const prompt = buildCodexWorkspacePrompt({
      mode: 'create',
      prompt: '生成贪吃蛇游戏',
    });

    expect(prompt).toContain('You MUST directly edit the workspace files');
    expect(prompt).toContain('WORKSPACE_CONTRACT.md');
    expect(prompt).toContain('.game-edit-contract.json');
    expect(prompt).toContain('All four files must exist and be non-empty');
  });

  it('treats modify prompts as full-package changes while still honoring allowed files', () => {
    const pkg = createTemplatePackage('demo');
    const prompt = buildCodexWorkspacePrompt({
      mode: 'modify',
      instruction: 'change player color',
      currentPackage: pkg,
      routeMode: 'design',
      routeReason: 'MODIFY_REQUEST',
      allowedPaths: ['gameJs', 'styleCss'],
    });

    expect(prompt).toContain('In this turn you may modify ONLY these files: game.js, style.css.');
    expect(prompt).toContain('Read the current workspace files directly');
    expect(prompt).toContain('change player color');
    expect(prompt).toContain('Apply the requested change directly to the package');
    expect(prompt).not.toContain('editable controls');
  });
});
