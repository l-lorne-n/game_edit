import type { PackageExecutionTraceMeta, RecoveryContext, ExecutionOutcome } from '@/lib/ai/execution-trace';
import type { GeneratedGamePackage } from '@/lib/package/contracts';
import type { PackageSolveResult } from '@/lib/ai/generate-package';
import { runAppServerPackageExecutor } from '@/lib/ai/executors/app-server-package-executor';
import { runLegacyPackageExecutor } from '@/lib/ai/executors/legacy-package-executor';
import {
  PackageExecutorFailure,
  type CodexExecutionEngine,
  type CodexExecutionStrategy,
  type PackageExecutorResult,
} from '@/lib/ai/executors/types';
import { getCodexRouteEngine } from '@/lib/config/infra';

export type CodexPackageTaskMode = 'create' | 'modify' | 'debug';
export type RunCodexPackageTaskInput = {
  mode: CodexPackageTaskMode;
  projectId?: string;
  aiSessionId?: string;
  targetId?: string | null;
  prompt?: string;
  instruction?: string;
  errorReport?: string;
  currentPackage?: GeneratedGamePackage;
  lastKnownGoodPackage?: GeneratedGamePackage;
  evaluatorSummary?: string;
  routeMode?: 'design' | 'patch' | 'repair';
  routeReason?: string;
  allowedPaths?: string[];
};

export type CodexTaskEnvelope = {
  mode: CodexPackageTaskMode;
  strategy: CodexExecutionStrategy;
  requestedEngine: CodexExecutionEngine;
  actualEngine: CodexExecutionEngine;
  projectId: string | null;
  targetId: string | null;
  routeMode: 'design' | 'patch' | 'repair' | null;
  routeReason: string | null;
  allowedPaths: string[];
  fallbackReason: string | null;
};

export type RunCodexPackageTaskResult = {
  envelope: CodexTaskEnvelope;
  requiresReplan: boolean;
  solveResult: PackageSolveResult;
  executionTraceMeta: PackageExecutionTraceMeta;
  requiresReinit: boolean;
};

export class CodexPackageTaskError extends Error {
  readonly code: string | null;
  readonly statusHint: 409 | 500 | 502;
  readonly requiresReinit: boolean;
  readonly executionTraceMeta: PackageExecutionTraceMeta;

  constructor(input: {
    message: string;
    code?: string | null;
    statusHint: 409 | 500 | 502;
    requiresReinit: boolean;
    executionTraceMeta: PackageExecutionTraceMeta;
  }) {
    super(input.message);
    this.code = input.code ?? null;
    this.statusHint = input.statusHint;
    this.requiresReinit = input.requiresReinit;
    this.executionTraceMeta = input.executionTraceMeta;
  }
}

function buildExecutionTraceMeta(envelope: CodexTaskEnvelope, input: {
  outcome: ExecutionOutcome;
  recovery: RecoveryContext | null;
  stages: PackageExecutionTraceMeta['stages'];
  failureContext: PackageExecutionTraceMeta['failureContext'];
}): PackageExecutionTraceMeta {
  return {
    requestedEngine: envelope.requestedEngine,
    actualEngine: envelope.actualEngine,
    strategy: envelope.strategy,
    routeReason: envelope.routeReason,
    allowedPaths: envelope.allowedPaths,
    fallbackReason: envelope.fallbackReason,
    outcome: input.outcome,
    recovery: input.recovery,
    stages: input.stages,
    failureContext: input.failureContext,
  };
}

function inferStatusHint(error: PackageExecutorFailure): 409 | 500 | 502 {
  if (error.code === 'codex_transport_not_initialized' || error.code === 'message_transport_not_ready') {
    return 409;
  }
  if (error.code && error.code.startsWith('codex_')) {
    return 502;
  }
  return 500;
}

function getExecutionEngine(): CodexExecutionEngine {
  return getCodexRouteEngine();
}

async function executeTask(requestedEngine: CodexExecutionEngine, input: RunCodexPackageTaskInput): Promise<PackageExecutorResult> {
  if (requestedEngine === 'codex-app-server') {
    return runAppServerPackageExecutor(input);
  }

  return runLegacyPackageExecutor(input);
}

function resolveStrategy(input: RunCodexPackageTaskInput): CodexExecutionStrategy {
  if (input.mode === 'debug') {
    return 'repair_execute';
  }

  return 'plan_then_execute';
}

function resolveAllowedPaths(input: RunCodexPackageTaskInput): string[] {
  return input.allowedPaths ?? ['indexHtml', 'gameJs', 'styleCss', 'manifestJson'];
}

export async function runCodexPackageTask(input: RunCodexPackageTaskInput): Promise<RunCodexPackageTaskResult> {
  const strategy = resolveStrategy(input);
  const envelope: CodexTaskEnvelope = {
    mode: input.mode,
    strategy,
    requestedEngine: getExecutionEngine(),
    actualEngine: 'legacy-model',
    projectId: input.projectId ?? null,
    targetId: input.targetId ?? null,
    routeMode: input.routeMode ?? null,
    routeReason: input.routeReason ?? null,
    allowedPaths: resolveAllowedPaths(input),
    fallbackReason: null,
  };

  let execution: PackageExecutorResult;
  try {
    execution = await executeTask(envelope.requestedEngine, input);
  } catch (error) {
    if (error instanceof PackageExecutorFailure) {
      envelope.actualEngine = error.actualEngine;
      envelope.fallbackReason = error.fallbackReason;
      throw new CodexPackageTaskError({
        message: error.message,
        code: error.code ?? error.failureContext?.code ?? null,
        statusHint: inferStatusHint(error),
        requiresReinit: error.requiresReinit,
        executionTraceMeta: buildExecutionTraceMeta(envelope, {
          outcome: 'hard_failure',
          recovery: null,
          stages: error.executionStages,
          failureContext: error.failureContext,
        }),
      });
    }
    throw error;
  }
  const solveResult: PackageSolveResult = execution.solveResult;
  envelope.actualEngine = execution.actualEngine;
  envelope.fallbackReason = execution.fallbackReason;

  return {
    envelope,
    requiresReplan: false,
    solveResult,
    executionTraceMeta: buildExecutionTraceMeta(envelope, {
      outcome: execution.outcome,
      recovery: execution.recovery,
      stages: execution.executionStages,
      failureContext: execution.failureContext,
    }),
    requiresReinit: execution.requiresReinit,
  };
}
