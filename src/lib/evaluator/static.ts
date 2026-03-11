import { makeEvaluatorResult, type EvaluatorResult } from '@/lib/evaluator/types';
import { parseGeneratedGamePackage } from '@/lib/package/contracts';

export function evaluatePackageStatic(input: unknown): EvaluatorResult {
  const parsed = parseGeneratedGamePackage(input);
  if (!parsed.ok) {
    return makeEvaluatorResult({
      ok: false,
      source: 'static',
      code: parsed.code,
      summary: parsed.message,
      errors: parsed.issues ?? [parsed.message],
    });
  }

  try {
    // Syntax check only; does not execute code.
    new Function(parsed.pkg.gameJs);
  } catch (error) {
    return makeEvaluatorResult({
      ok: false,
      source: 'static',
      code: 'SYNTAX_ERROR',
      summary: 'gameJs contains invalid JavaScript syntax.',
      errors: [error instanceof Error ? error.message : String(error)],
    });
  }

  return makeEvaluatorResult({
    ok: true,
    source: 'static',
    code: 'STATIC_OK',
    summary: 'Package schema, manifest, and JavaScript syntax checks passed.',
  });
}
