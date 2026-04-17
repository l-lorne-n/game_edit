export type ExecutionStageKey =
  | 'session_prepare'
  | 'transport_turn'
  | 'workspace_readback'
  | 'workspace_promote'
  | 'workspace_recovery'
  | 'model_generate'
  | 'model_repair'
  | 'fallback_package'
  | 'sandbox_test'
  | 'final_check';

export type ExecutionStageStatus = 'completed' | 'failed' | 'skipped';

export type ExecutionStage = {
  key: ExecutionStageKey;
  label: string;
  status: ExecutionStageStatus;
  durationMs: number;
  detail?: string;
  startedAt?: string;
  endedAt?: string;
};

export type FailureContext = {
  checkpoint: ExecutionStageKey | 'request_send' | 'request_setup';
  reason: string;
  code: string | null;
  message: string;
  transport:
    | {
        phase: string;
        threadId: string | null;
        requiresReinit: boolean;
        lastErrorCode: string | null;
        lastErrorMessage: string | null;
      }
    | null;
  session:
    | {
        sessionId: string | null;
        projectId: string | null;
        status: string | null;
        lastFailureCode: string | null;
        lastCheckpointId: string | null;
        lastCheckpointVersion: number | null;
      }
    | null;
};

export type ExecutionOutcome = 'pending' | 'direct_success' | 'recovered_success' | 'hard_failure';

export type RecoveryContext = {
  source: 'workspace' | 'agent_text' | 'fallback' | 'unknown';
  reason: string;
  workspaceVersion?: number | null;
  recoveredFromFailureCode?: string | null;
  recoveredFromFailureMessage?: string | null;
};

export type PackageExecutionTraceMeta = {
  requestedEngine: string;
  actualEngine: string;
  strategy: string;
  routeReason: string | null;
  allowedPaths: string[];
  fallbackReason: string | null;
  outcome: ExecutionOutcome;
  recovery: RecoveryContext | null;
  stages: ExecutionStage[];
  failureContext: FailureContext | null;
};

export function executionStageLabel(key: ExecutionStageKey): string {
  switch (key) {
    case 'session_prepare':
      return 'Session prepare';
    case 'transport_turn':
      return 'Codex turn';
    case 'workspace_readback':
      return 'Workspace readback';
    case 'workspace_promote':
      return 'Workspace promote';
    case 'workspace_recovery':
      return 'Workspace recovery';
    case 'model_generate':
      return 'Model generate';
    case 'model_repair':
      return 'Model repair';
    case 'fallback_package':
      return 'Fallback package';
    case 'sandbox_test':
      return 'Sandbox test';
    case 'final_check':
      return 'Final check';
    default:
      return key;
  }
}

export function createExecutionStage(input: {
  key: ExecutionStageKey;
  status: ExecutionStageStatus;
  durationMs: number;
  detail?: string;
  startedAt?: string;
  endedAt?: string;
}): ExecutionStage {
  return {
    key: input.key,
    label: executionStageLabel(input.key),
    status: input.status,
    durationMs: Math.max(0, input.durationMs),
    detail: input.detail,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
  };
}

export function upsertExecutionStage(stages: ExecutionStage[] | null | undefined, stage: ExecutionStage): ExecutionStage[] {
  const safeStages = stages ?? [];
  const index = safeStages.findIndex(item => item.key === stage.key);
  if (index < 0) {
    return [...safeStages, stage];
  }

  return safeStages.map((item, itemIndex) => (itemIndex === index ? stage : item));
}

export function buildClientFailureContext(input: {
  checkpoint: FailureContext['checkpoint'];
  error: string;
  code?: string | null;
  reason?: string;
}): FailureContext {
  return {
    checkpoint: input.checkpoint,
    reason: input.reason ?? 'request_failed',
    code: input.code ?? null,
    message: input.error,
    transport: null,
    session: null,
  };
}

export function summarizeExecutionTraceMode(mode: 'create' | 'modify' | 'debug'): string {
  switch (mode) {
    case 'create':
      return 'Create';
    case 'modify':
      return 'Modify';
    case 'debug':
      return 'Debug';
    default:
      return mode;
  }
}
