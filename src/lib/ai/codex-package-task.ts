import type { EvaluatorResult } from '@/lib/evaluator/types';
import { makeEvaluatorResult } from '@/lib/evaluator/types';
import type { GeneratedGamePackage } from '@/lib/package/contracts';
import { parseGeneratedGamePackage } from '@/lib/package/contracts';
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
  checkpointOnSuccess?: boolean;
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
  checkpointOnSuccess: boolean;
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
  if (input.mode === 'create') {
    return 'plan_then_execute';
  }

  if (input.mode === 'debug') {
    return 'repair_execute';
  }

  if (input.routeMode === 'design') {
    return 'replan_required';
  }

  return 'patch_execute';
}

function resolveAllowedPaths(input: RunCodexPackageTaskInput): string[] {
  return input.allowedPaths ?? ['indexHtml', 'gameJs', 'styleCss', 'manifestJson'];
}

function toReplanFallbackResult(input: RunCodexPackageTaskInput): PackageSolveResult {
  const pkg = input.currentPackage ?? input.lastKnownGoodPackage;
  if (!pkg) {
    throw new Error('A baseline package is required when modify escalates to re-plan.');
  }
  const parsed = parseGeneratedGamePackage(pkg);
  if (!parsed.ok) {
    throw new Error('Current package is invalid and cannot be used for a re-plan fallback result.');
  }

  const staticEvaluation: EvaluatorResult = makeEvaluatorResult({
    ok: false,
    code: 'TEST_FAILED',
    source: 'static',
    summary: 'Modify request exceeds the declared editable scope and needs a re-plan/create flow.',
    errors: ['This modify request exceeded the editable scope and was not executed.'],
    logs: ['route-engine: modify escalated to replan_required'],
  });

  return {
    pkg,
    manifest: parsed.manifest,
    staticEvaluation,
    repaired: false,
    fallbackUsed: false,
    source: 'template',
    statusMessage: 'Route escalation required: modify request exceeded editable scope.',
    provider: 'route-engine',
    model: 'none',
    attempts: [],
  };
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
    checkpointOnSuccess: Boolean(input.checkpointOnSuccess),
    fallbackReason: null,
  };

  let solveResult: PackageSolveResult;
  if (strategy === 'replan_required') {
    solveResult = toReplanFallbackResult(input);
  } else {
    const execution = await executeTask(envelope.requestedEngine, input);
    solveResult = execution.solveResult;
    envelope.actualEngine = execution.actualEngine;
    envelope.fallbackReason = execution.fallbackReason;
  }

  if (strategy === 'replan_required') {
    envelope.actualEngine = 'legacy-model';
  } else {
    envelope.actualEngine = envelope.actualEngine;
  }

  return {
    envelope,
    requiresReplan: strategy === 'replan_required',
    solveResult,
    executionTraceMeta: {
      requestedEngine: envelope.requestedEngine,
      actualEngine: envelope.actualEngine,
      strategy,
      routeReason: envelope.routeReason,
      allowedPaths: envelope.allowedPaths,
      fallbackReason: envelope.fallbackReason,
    },
  };
}
