export type ModelAttemptMode = 'structured-chat' | 'structured-auto' | 'text-json';

export type ModelAttemptOutcome =
  | 'success'
  | 'error'
  | 'timeout'
  | 'invalid-json'
  | 'invalid-schema'
  | 'no-api-key';

export type ModelAttempt = {
  provider: string;
  model: string;
  mode: ModelAttemptMode;
  outcome: ModelAttemptOutcome;
  durationMs: number;
  errorMessage?: string;
  extractedFormat?: 'json' | 'yaml';
  rawText?: string;
  extractedJson?: string;
  normalizedJson?: string;
  schemaIssues?: Array<{
    path: string;
    message: string;
  }>;
};
