import type { GeneratedGamePackage } from '@/lib/package/contracts';
import type { PackageSolveResult } from '@/lib/ai/generate-package';
import { runAppServerPackageExecutor } from '@/lib/ai/executors/app-server-package-executor';
import { runLegacyPackageExecutor } from '@/lib/ai/executors/legacy-package-executor';
import type { CodexExecutionEngine, CodexExecutionStrategy, PackageExecutorResult } from '@/lib/ai/executors/types';
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
  executionTraceMeta: {
    requestedEngine: CodexExecutionEngine;
    actualEngine: CodexExecutionEngine;
    strategy: CodexExecutionStrategy;
    routeReason: string | null;
    allowedPaths: string[];
    fallbackReason: string | null;
  };
  requiresReinit: boolean;
};

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

  const execution = await executeTask(envelope.requestedEngine, input);
  const solveResult: PackageSolveResult = execution.solveResult;
  envelope.actualEngine = execution.actualEngine;
  envelope.fallbackReason = execution.fallbackReason;

  return {
    envelope,
    requiresReplan: false,
    solveResult,
    executionTraceMeta: {
      requestedEngine: envelope.requestedEngine,
      actualEngine: envelope.actualEngine,
      strategy,
      routeReason: envelope.routeReason,
      allowedPaths: envelope.allowedPaths,
      fallbackReason: envelope.fallbackReason,
    },
    requiresReinit: execution.requiresReinit,
  };
}
