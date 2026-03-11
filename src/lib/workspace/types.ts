import type { ModelAttempt } from '@/lib/ai/types';
import type { EvaluatorResult } from '@/lib/evaluator/types';
import type { GeneratedGamePackage } from '@/lib/package/contracts';

export type ActionMode = 'create' | 'modify' | 'debug';

export type ChatMessage = {
  id: string;
  role: 'user' | 'assistant' | 'system';
  mode: ActionMode | 'system';
  text: string;
  createdAt: string;
};

export type SnapshotStatus = 'passed' | 'failed' | 'unknown';

export type ProjectSnapshot = {
  id: string;
  title: string;
  createdAt: string;
  parentSnapshotId: string | null;
  status: SnapshotStatus;
  pkg: GeneratedGamePackage;
  evaluator: EvaluatorResult | null;
};

export type GameProject = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
  currentPackage: GeneratedGamePackage | null;
  currentEvaluator: EvaluatorResult | null;
  snapshots: ProjectSnapshot[];
  selectedSnapshotId: string;
  selectedModifyBaseId: string;
  selectedDebugTargetId: string;
  lastMode: ActionMode;
  attempts: ModelAttempt[];
  lastGreenSnapshotId: string | null;
  lastRouteDecision: RouteDecision | null;
  lastExecutionTrace: ExecutionTrace | null;
};

export type WorkspaceLimits = {
  maxProjects: number;
  maxSnapshotsPerProject: number;
};

export type WorkspaceState = {
  version: '2.0';
  activeProjectId: string;
  projects: GameProject[];
  limits: WorkspaceLimits;
};

export type RouteAgent = 'architect' | 'worker' | 'fixer';

export type RouteReasonCode =
  | 'CREATE_REQUEST'
  | 'DEBUG_REQUEST'
  | 'EDITABLE_SCOPE_MATCH'
  | 'EDITABLE_SCOPE_MISS'
  | 'NO_EDITABLE_SCOPE_DECLARED'
  | 'BEHAVIOR_RULE_CHANGE'
  | 'SYSTEM_MECHANIC_CHANGE'
  | 'LOW_CONFIDENCE';

export type RouteDecision = {
  agent: RouteAgent;
  routeMode: 'design' | 'patch' | 'repair';
  confidence: number;
  primaryReasonCode: RouteReasonCode;
  secondaryReasonCodes: RouteReasonCode[];
  summary: string;
  why: string;
  withinEditableScope: boolean;
  editableScopeSummary: string;
  allowedPaths: string[];
  allowedChangeTypes: string[];
  targetId: string;
  requestText: string;
};

export type ExecutionTrace = {
  requestMode: ActionMode;
  endpoint: string;
  targetId: string;
  roleLabel: string;
  statusMessage: string;
  source: string;
  provider: string;
  model: string;
  repaired: boolean;
  fallbackUsed: boolean;
  staticCode: string;
  sandboxCode?: string;
  testsRun: string[];
  filesProduced: string[];
  attemptSummaries: Array<{
    mode: string;
    outcome: string;
    durationMs: number;
    errorMessage?: string;
    provider: string;
    model: string;
  }>;
};

export type SnapshotDisplayItem = {
  snapshot: ProjectSnapshot;
  depth: number;
  parentTitle: string | null;
};
