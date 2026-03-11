import type { GeneratedGamePackage } from '@/lib/package/contracts';
import type { ActionMode, RouteDecision, RouteReasonCode } from '@/lib/workspace/types';

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ');
}

function tokenize(text: string): string[] {
  return normalize(text)
    .split(/\s+/)
    .map(token => token.trim())
    .filter(Boolean);
}

function parseEditable(pkg: GeneratedGamePackage | null): string[] {
  if (!pkg) {
    return [];
  }
  try {
    const parsed = JSON.parse(pkg.manifestJson) as { editable?: unknown };
    return Array.isArray(parsed.editable)
      ? parsed.editable.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

function editableMatchCount(editable: string[], request: string): number {
  const requestTokens = new Set(tokenize(request));
  let matches = 0;
  for (const item of editable) {
    const itemTokens = tokenize(item);
    if (itemTokens.some(token => requestTokens.has(token))) {
      matches += 1;
    }
  }
  return matches;
}

function containsAny(text: string, words: string[]): boolean {
  return words.some(word => text.includes(word));
}

export function decideRoute(input: {
  mode: ActionMode;
  requestText: string;
  targetId: string;
  targetPackage: GeneratedGamePackage | null;
}): RouteDecision {
  if (input.mode === 'create') {
    return {
      agent: 'architect',
      routeMode: 'design',
      confidence: 0.98,
      primaryReasonCode: 'CREATE_REQUEST',
      secondaryReasonCodes: [],
      summary: 'New project creation always routes to architect.',
      why: 'This is the first-generation path, so the architect owns full package design.',
      withinEditableScope: false,
      editableScopeSummary: 'No existing editable scope applies to a new project.',
      allowedPaths: ['indexHtml', 'gameJs', 'styleCss', 'manifestJson'],
      allowedChangeTypes: ['new gameplay', 'layout', 'visual design', 'game rules'],
      targetId: input.targetId,
      requestText: input.requestText,
    };
  }

  if (input.mode === 'debug') {
    return {
      agent: 'fixer',
      routeMode: 'repair',
      confidence: 0.99,
      primaryReasonCode: 'DEBUG_REQUEST',
      secondaryReasonCodes: [],
      summary: 'Debug mode explicitly routes to fixer.',
      why: 'The user selected error-repair mode, so the request is handled as a targeted repair workflow.',
      withinEditableScope: true,
      editableScopeSummary: 'Debug mode bypasses editable scope and focuses on the selected target version.',
      allowedPaths: ['indexHtml', 'gameJs', 'styleCss', 'manifestJson'],
      allowedChangeTypes: ['error repair', 'runtime fix', 'stability fix'],
      targetId: input.targetId,
      requestText: input.requestText,
    };
  }

  const request = normalize(input.requestText);
  const editable = parseEditable(input.targetPackage);
  const matchCount = editableMatchCount(editable, request);

  const behaviorChange = containsAny(request, [
    'collision',
    'wall',
    'rule',
    'wrap',
    'teleport',
    'physics',
    'spawn',
    'win condition',
    'lose condition',
    'maze',
    'pathfinding',
    'mechanic',
    '规则',
    '撞墙',
    '穿墙',
    '胜利条件',
    '失败条件',
    '生成规则',
    '机制',
  ]);

  const reasons: RouteReasonCode[] = [];
  let primaryReasonCode: RouteReasonCode = 'LOW_CONFIDENCE';
  let confidence = 0.6;
  let withinEditableScope = false;
  let summary = 'Modify request required routing review.';
  let why = 'The request was inspected against editable scope and mechanic-change heuristics.';

  if (editable.length === 0) {
    reasons.push('NO_EDITABLE_SCOPE_DECLARED');
    primaryReasonCode = 'NO_EDITABLE_SCOPE_DECLARED';
    confidence = 0.82;
    summary = 'No editable scope was declared, so the request routes to architect by default.';
    why = 'Without explicit editable scope metadata, the system cannot safely assume a patch-only change.';
  } else if (behaviorChange) {
    reasons.push('BEHAVIOR_RULE_CHANGE', 'EDITABLE_SCOPE_MISS');
    primaryReasonCode = 'BEHAVIOR_RULE_CHANGE';
    confidence = 0.92;
    summary = 'The request looks like a gameplay-rule or system-mechanic change.';
    why = 'Changing wall/collision/wrap or other core rules is treated as architecture-level work unless explicitly whitelisted.';
  } else if (matchCount > 0) {
    reasons.push('EDITABLE_SCOPE_MATCH');
    primaryReasonCode = 'EDITABLE_SCOPE_MATCH';
    confidence = 0.86;
    withinEditableScope = true;
    summary = 'The request matched the declared editable scope and routes to worker.';
    why = 'The change request overlaps with fields already marked editable in the manifest, so patch routing is allowed.';
  } else {
    reasons.push('EDITABLE_SCOPE_MISS', 'LOW_CONFIDENCE');
    primaryReasonCode = 'EDITABLE_SCOPE_MISS';
    confidence = 0.76;
    summary = 'The request did not match the declared editable scope, so it routes to architect.';
    why = 'The request appears to expand beyond declared editable fields, so the safer default is design-level routing.';
  }

  return {
    agent: withinEditableScope ? 'worker' : 'architect',
    routeMode: withinEditableScope ? 'patch' : 'design',
    confidence,
    primaryReasonCode,
    secondaryReasonCodes: reasons.filter(reason => reason !== primaryReasonCode),
    summary,
    why,
    withinEditableScope,
    editableScopeSummary:
      editable.length > 0
        ? `Declared editable scope: ${editable.join(', ')}`
        : 'No editable scope declared in manifest.',
    allowedPaths: withinEditableScope ? ['gameJs', 'styleCss', 'manifestJson'] : ['indexHtml', 'gameJs', 'styleCss', 'manifestJson'],
    allowedChangeTypes: withinEditableScope
      ? ['patch existing behavior', 'copy/style updates', 'parameter tweaks']
      : ['behavior redesign', 'new mechanic wiring', 'system rule changes'],
    targetId: input.targetId,
    requestText: input.requestText,
  };
}
