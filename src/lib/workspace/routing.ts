import type { GeneratedGamePackage } from '@/lib/package/contracts';
import type { ActionMode, RouteDecision } from '@/lib/workspace/types';

export function decideRoute(input: {
  mode: ActionMode;
  requestText: string;
  targetId: string;
  targetPackage: GeneratedGamePackage | null;
}): RouteDecision {
  if (input.mode === 'debug') {
    return {
      agent: 'fixer',
      routeMode: 'repair',
      confidence: 0.99,
      primaryReasonCode: 'DEBUG_REQUEST',
      secondaryReasonCodes: [],
      summary: 'Debug mode stays on the repair path.',
      why: 'The user explicitly asked for error repair, so the targeted repair workflow remains in place.',
      withinEditableScope: true,
      editableScopeSummary: 'Editable-scope gating is disabled; debug still uses the dedicated repair path.',
      allowedPaths: ['indexHtml', 'gameJs', 'styleCss', 'manifestJson'],
      allowedChangeTypes: ['error repair', 'runtime fix', 'stability fix'],
      targetId: input.targetId,
      requestText: input.requestText,
    };
  }

  if (input.mode === 'create') {
    return {
      agent: 'architect',
      routeMode: 'design',
      confidence: 0.98,
      primaryReasonCode: 'CREATE_REQUEST',
      secondaryReasonCodes: [],
      summary: 'Create requests use the full-package generation path.',
      why: 'Game creation is always handled as a full package build.',
      withinEditableScope: true,
      editableScopeSummary: 'Editable-scope gating is disabled. Full package edits are allowed.',
      allowedPaths: ['indexHtml', 'gameJs', 'styleCss', 'manifestJson'],
      allowedChangeTypes: ['new gameplay', 'layout', 'visual design', 'game rules'],
      targetId: input.targetId,
      requestText: input.requestText,
    };
  }

  return {
    agent: 'architect',
    routeMode: 'design',
    confidence: 0.98,
    primaryReasonCode: 'MODIFY_REQUEST',
    secondaryReasonCodes: [],
    summary: 'Modify requests use the same full-package path as create.',
    why: 'Editable-scope gating is disabled, so any game file can be modified through the unified package workflow.',
    withinEditableScope: true,
    editableScopeSummary: 'Editable-scope gating is disabled. Full package edits are allowed.',
    allowedPaths: ['indexHtml', 'gameJs', 'styleCss', 'manifestJson'],
    allowedChangeTypes: ['gameplay changes', 'layout changes', 'visual changes', 'rule changes'],
    targetId: input.targetId,
    requestText: input.requestText,
  };
}
