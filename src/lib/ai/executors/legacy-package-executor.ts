import {
  debugPackageFromReport,
  generatePackageFromPrompt,
  modifyPackageFromInstruction,
} from '@/lib/ai/generate-package';
import type { PackageExecutorInput, PackageExecutorResult } from '@/lib/ai/executors/types';

export async function runLegacyPackageExecutor(input: PackageExecutorInput): Promise<PackageExecutorResult> {
  if (input.mode === 'create') {
    if (!input.prompt?.trim()) {
      throw new Error('prompt is required for create mode');
    }
    return {
      solveResult: await generatePackageFromPrompt(input.prompt, input.lastKnownGoodPackage),
      actualEngine: 'legacy-model',
      fallbackReason: null,
    };
  }

  if (input.mode === 'modify') {
    if (!input.instruction?.trim()) {
      throw new Error('instruction is required for modify mode');
    }
    if (!input.currentPackage) {
      throw new Error('currentPackage is required for modify mode');
    }
    return {
      solveResult: await modifyPackageFromInstruction({
        instruction: input.instruction,
        currentPackage: input.currentPackage,
        lastKnownGood: input.lastKnownGoodPackage,
      }),
      actualEngine: 'legacy-model',
      fallbackReason: null,
    };
  }

  if (!input.errorReport?.trim()) {
    throw new Error('errorReport is required for debug mode');
  }
  if (!input.currentPackage) {
    throw new Error('currentPackage is required for debug mode');
  }

  return {
    solveResult: await debugPackageFromReport({
      errorReport: input.errorReport,
      currentPackage: input.currentPackage,
      evaluatorSummary: input.evaluatorSummary,
      lastKnownGood: input.lastKnownGoodPackage,
    }),
    actualEngine: 'legacy-model',
    fallbackReason: null,
  };
}
