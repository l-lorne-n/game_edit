import { createExecutionStage } from '@/lib/ai/execution-trace';
import {
  debugPackageFromReport,
  generatePackageFromPrompt,
  modifyPackageFromInstruction,
} from '@/lib/ai/generate-package';
import type { PackageExecutorInput, PackageExecutorResult } from '@/lib/ai/executors/types';

function buildLegacyExecutionStages(result: Awaited<PackageExecutorResult['solveResult']>) {
  const stages = result.attempts.flatMap((attempt, index) => {
    if (index === 0) {
      return [
        createExecutionStage({
          key: 'model_generate',
          status: attempt.outcome === 'success' ? 'completed' : 'failed',
          durationMs: attempt.durationMs,
          detail: attempt.errorMessage ?? attempt.outcome,
        }),
      ];
    }

    if (index === 1) {
      return [
        createExecutionStage({
          key: 'model_repair',
          status: attempt.outcome === 'success' ? 'completed' : 'failed',
          durationMs: attempt.durationMs,
          detail: attempt.errorMessage ?? attempt.outcome,
        }),
      ];
    }

    return [];
  });

  if (result.fallbackUsed) {
    stages.push(
      createExecutionStage({
        key: 'fallback_package',
        status: 'completed',
        durationMs: 0,
        detail: result.statusMessage,
      }),
    );
  }

  return stages;
}

export async function runLegacyPackageExecutor(input: PackageExecutorInput): Promise<PackageExecutorResult> {
  if (input.mode === 'create') {
    if (!input.prompt?.trim()) {
      throw new Error('prompt is required for create mode');
    }
    const solveResult = await generatePackageFromPrompt(input.prompt, input.lastKnownGoodPackage);
    return {
      solveResult,
      actualEngine: 'legacy-model',
      fallbackReason: null,
      outcome: 'direct_success',
      recovery: null,
      requiresReinit: false,
      executionStages: buildLegacyExecutionStages(solveResult),
      failureContext: null,
    };
  }

  if (input.mode === 'modify') {
    if (!input.instruction?.trim()) {
      throw new Error('instruction is required for modify mode');
    }
    if (!input.currentPackage) {
      throw new Error('currentPackage is required for modify mode');
    }
    const solveResult = await modifyPackageFromInstruction({
        instruction: input.instruction,
        currentPackage: input.currentPackage,
        lastKnownGood: input.lastKnownGoodPackage,
      });
    return {
      solveResult,
      actualEngine: 'legacy-model',
      fallbackReason: null,
      outcome: 'direct_success',
      recovery: null,
      requiresReinit: false,
      executionStages: buildLegacyExecutionStages(solveResult),
      failureContext: null,
    };
  }

  if (!input.errorReport?.trim()) {
    throw new Error('errorReport is required for debug mode');
  }
  if (!input.currentPackage) {
    throw new Error('currentPackage is required for debug mode');
  }

  const solveResult = await debugPackageFromReport({
      errorReport: input.errorReport,
      currentPackage: input.currentPackage,
      evaluatorSummary: input.evaluatorSummary,
      lastKnownGood: input.lastKnownGoodPackage,
    });

  return {
    solveResult,
    actualEngine: 'legacy-model',
    fallbackReason: null,
    outcome: 'direct_success',
    recovery: null,
    requiresReinit: false,
    executionStages: buildLegacyExecutionStages(solveResult),
    failureContext: null,
  };
}
