import type { ExecutionOutcome, ExecutionStage, FailureContext, RecoveryContext } from '@/lib/ai/execution-trace';
import type { PackageSolveResult } from '@/lib/ai/generate-package';
import type { GeneratedGamePackage } from '@/lib/package/contracts';

export type CodexExecutionStrategy = 'plan_then_execute' | 'repair_execute';
export type CodexExecutionEngine = 'legacy-model' | 'codex-app-server';

export type PackageExecutorInput = {
  mode: 'create' | 'modify' | 'debug';
  projectId?: string;
  aiSessionId?: string;
  targetId?: string | null;
  routeMode?: 'design' | 'patch' | 'repair' | null;
  routeReason?: string | null;
  allowedPaths?: string[];
  prompt?: string;
  instruction?: string;
  errorReport?: string;
  currentPackage?: GeneratedGamePackage;
  lastKnownGoodPackage?: GeneratedGamePackage;
  evaluatorSummary?: string;
};

export type PackageExecutorResult = {
  solveResult: PackageSolveResult;
  actualEngine: CodexExecutionEngine;
  fallbackReason: string | null;
  outcome: ExecutionOutcome;
  recovery: RecoveryContext | null;
  requiresReinit: boolean;
  executionStages: ExecutionStage[];
  failureContext: FailureContext | null;
};

export class PackageExecutorFailure extends Error {
  readonly code: string | null;
  readonly actualEngine: CodexExecutionEngine;
  readonly fallbackReason: string | null;
  readonly requiresReinit: boolean;
  readonly executionStages: ExecutionStage[];
  readonly failureContext: FailureContext | null;

  constructor(input: {
    message: string;
    code?: string | null;
    actualEngine: CodexExecutionEngine;
    fallbackReason?: string | null;
    requiresReinit: boolean;
    executionStages?: ExecutionStage[];
    failureContext?: FailureContext | null;
  }) {
    super(input.message);
    this.code = input.code ?? null;
    this.actualEngine = input.actualEngine;
    this.fallbackReason = input.fallbackReason ?? null;
    this.requiresReinit = input.requiresReinit;
    this.executionStages = input.executionStages ?? [];
    this.failureContext = input.failureContext ?? null;
  }
}
