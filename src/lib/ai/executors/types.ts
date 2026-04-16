import type { PackageSolveResult } from '@/lib/ai/generate-package';
import type { GeneratedGamePackage } from '@/lib/package/contracts';

export type CodexExecutionStrategy = 'plan_then_execute' | 'patch_execute' | 'repair_execute' | 'replan_required';
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
};
