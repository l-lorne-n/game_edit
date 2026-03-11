export type EvaluatorSource = 'static' | 'sandbox';

export type EvaluatorCode =
  | 'STATIC_OK'
  | 'PACKAGE_SCHEMA_INVALID'
  | 'MANIFEST_JSON_INVALID'
  | 'MANIFEST_SCHEMA_INVALID'
  | 'SYNTAX_ERROR'
  | 'READY'
  | 'READY_TIMEOUT'
  | 'RUNTIME_ERROR'
  | 'UNHANDLED_REJECTION'
  | 'CONSOLE_ERROR'
  | 'TEST_FAILED'
  | 'BRIDGE_PROTOCOL_ERROR';

export type EvaluatorResult = {
  ok: boolean;
  code: EvaluatorCode;
  source: EvaluatorSource;
  summary: string;
  at: string;
  bootMs?: number;
  errors: string[];
  logs: string[];
};

export function makeEvaluatorResult(input: {
  ok: boolean;
  code: EvaluatorCode;
  source: EvaluatorSource;
  summary: string;
  bootMs?: number;
  errors?: string[];
  logs?: string[];
}): EvaluatorResult {
  return {
    ok: input.ok,
    code: input.code,
    source: input.source,
    summary: input.summary,
    at: new Date().toISOString(),
    bootMs: input.bootMs,
    errors: input.errors ?? [],
    logs: input.logs ?? [],
  };
}
