import { NoObjectGeneratedError, Output, generateText } from 'ai';
import type { ZodIssue } from 'zod';
import { parse as parseYaml } from 'yaml';

import {
  createProviderClient,
  getActiveProvider,
  getProviderConfig,
  type LlmProvider,
} from '@/lib/ai/config';
import {
  LOGIC_SYSTEM_PROMPT,
  generationPrompt,
  modificationPrompt,
  repairPrompt,
} from '@/lib/ai/prompts';
import type { ModelAttempt, ModelAttemptMode, ModelAttemptOutcome } from '@/lib/ai/types';
import type { GameDsl } from '@/lib/game/dsl';
import { gameDslSchema } from '@/lib/game/dsl';
import { createTemplateFromPrompt, getDefaultLastKnownGood } from '@/lib/game/templates';
import { type CombinedValidationResult, normalizeDslCandidate, validateDsl } from '@/lib/game/validate';

export type SolveResult = {
  dsl: GameDsl;
  validation: CombinedValidationResult;
  repaired: boolean;
  fallbackUsed: boolean;
  source: 'model' | 'template' | 'repair' | 'last-known-good';
  statusMessage: string;
  provider: string;
  model: string;
  attempts: ModelAttempt[];
};

function envInt(name: string, fallback: number, min = 1): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  if (!Number.isFinite(parsed) || parsed < min) {
    return fallback;
  }
  return parsed;
}

const DEFAULT_SMOKE_TICKS = envInt('SMOKE_SIM_TICKS', 600, 60);
const MAX_REPAIR_ATTEMPTS = envInt('MAX_REPAIR_ATTEMPTS', 1, 1);
const MODEL_CALL_TIMEOUT_MS = envInt('MODEL_CALL_TIMEOUT_MS', 60000, 1000);

function nowMs(): number {
  return Date.now();
}

function elapsedMs(startMs: number): number {
  return Math.max(0, Date.now() - startMs);
}

function classifyError(error: unknown): { outcome: ModelAttemptOutcome; errorMessage: string } {
  const message = error instanceof Error ? error.message : String(error);
  const normalizedMessage = message.trim().length > 0 ? message : 'Unknown provider error';
  if (/timeout/i.test(message)) {
    return { outcome: 'timeout', errorMessage: normalizedMessage };
  }
  return { outcome: 'error', errorMessage: normalizedMessage };
}

function pushAttempt(
  attempts: ModelAttempt[],
  attempt: Omit<ModelAttempt, 'durationMs'> & { durationMs?: number },
): void {
  attempts.push({
    durationMs: attempt.durationMs ?? 0,
    ...attempt,
  });
}

function clipText(value: string | undefined, max = 3000): string | undefined {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed.length <= max) {
    return trimmed;
  }

  return `${trimmed.slice(0, max)}\n...[truncated]`;
}

function serializeUnknown(value: unknown): string | undefined {
  if (value == null) {
    return undefined;
  }

  try {
    return clipText(JSON.stringify(value, null, 2));
  } catch {
    return undefined;
  }
}

function mapSchemaIssues(issues: ZodIssue[]): Array<{ path: string; message: string }> {
  return issues.map(issue => ({
    path: issue.path.join('.') || 'root',
    message: issue.message,
  }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJsonPayload(text: string): unknown | null {
  try {
    const parsed = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseYamlPayload(text: string): unknown | null {
  try {
    const parsed = parseYaml(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function extractStructuredCandidate(text: string): {
  value: unknown | null;
  format: 'json' | 'yaml' | null;
} {
  const trimmed = text.trim();
  const wholeJson = parseJsonPayload(trimmed);
  if (wholeJson) {
    return { value: wholeJson, format: 'json' };
  }

  const fenceRegex = /```(json|yaml|yml)?\s*([\s\S]*?)```/gi;
  let fenceMatch: RegExpExecArray | null = null;
  while ((fenceMatch = fenceRegex.exec(trimmed)) !== null) {
    const lang = (fenceMatch[1] ?? '').toLowerCase();
    const body = fenceMatch[2].trim();

    const preferYaml = lang === 'yaml' || lang === 'yml';
    if (!preferYaml) {
      const jsonBody = parseJsonPayload(body);
      if (jsonBody) {
        return { value: jsonBody, format: 'json' };
      }
    }

    const yamlBody = parseYamlPayload(body);
    if (yamlBody) {
      return { value: yamlBody, format: 'yaml' };
    }

    if (preferYaml) {
      const jsonBody = parseJsonPayload(body);
      if (jsonBody) {
        return { value: jsonBody, format: 'json' };
      }
    }
  }

  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) {
    const maybeJson = parseJsonPayload(trimmed.slice(start, end + 1));
    if (maybeJson) {
      return { value: maybeJson, format: 'json' };
    }
  }

  const wholeYaml = parseYamlPayload(trimmed);
  if (wholeYaml) {
    return { value: wholeYaml, format: 'yaml' };
  }

  return { value: null, format: null };
}

function inspectCandidate(
  input: unknown,
  format?: 'json' | 'yaml' | null,
): {
  extractedFormat?: 'json' | 'yaml';
  extractedJson?: string;
  normalizedJson?: string;
  schemaIssues?: Array<{ path: string; message: string }>;
  dsl: GameDsl | null;
} {
  const normalized = normalizeDslCandidate(input);
  const parsed = gameDslSchema.safeParse(normalized);

  if (parsed.success) {
    return {
      extractedJson: serializeUnknown(input),
      extractedFormat: format ?? undefined,
      normalizedJson: serializeUnknown(normalized),
      dsl: parsed.data,
    };
  }

  return {
    extractedJson: serializeUnknown(input),
    extractedFormat: format ?? undefined,
    normalizedJson: serializeUnknown(normalized),
    schemaIssues: mapSchemaIssues(parsed.error.issues),
    dsl: null,
  };
}

function formatValidationIssues(validation: CombinedValidationResult): string {
  const issueLines: string[] = [];
  for (const issue of validation.schema.issues) {
    issueLines.push(`[schema] ${issue.path}: ${issue.message}`);
  }
  for (const issue of validation.rules.issues) {
    issueLines.push(`[rules] ${issue.path}: ${issue.message}`);
  }
  for (const issue of validation.smoke.issues) {
    issueLines.push(`[smoke] ${issue}`);
  }
  return issueLines.join('\n');
}

function providerOrder(): LlmProvider[] {
  const active = getActiveProvider();
  return active === 'apiyi' ? ['apiyi', 'openrouter'] : ['openrouter', 'apiyi'];
}

async function tryStructuredCall(
  mode: ModelAttemptMode,
  provider: string,
  model: string,
  call: () => Promise<GameDsl>,
  attempts: ModelAttempt[],
): Promise<GameDsl | null> {
  const start = nowMs();
  try {
    const dsl = await call();
    pushAttempt(attempts, {
      provider,
      model,
      mode,
      outcome: 'success',
      durationMs: elapsedMs(start),
    });
    return dsl;
  } catch (error) {
    if (NoObjectGeneratedError.isInstance(error)) {
      const extracted = error.text
        ? extractStructuredCandidate(error.text)
        : { value: null as unknown, format: null as 'json' | 'yaml' | null };
      const inspected = extracted.value
        ? inspectCandidate(extracted.value, extracted.format)
        : { dsl: null as GameDsl | null };
      if (inspected.dsl) {
        pushAttempt(attempts, {
          provider,
          model,
          mode,
          outcome: 'success',
          durationMs: elapsedMs(start),
          errorMessage: 'Recovered from NoObjectGeneratedError using extracted structured payload.',
          extractedFormat: extracted.format ?? undefined,
          rawText: clipText(error.text),
          extractedJson: inspected.extractedJson,
          normalizedJson: inspected.normalizedJson,
        });
        return inspected.dsl;
      }

      pushAttempt(attempts, {
        provider,
        model,
        mode,
        outcome: 'error',
        durationMs: elapsedMs(start),
        errorMessage: error.message,
        extractedFormat: extracted.format ?? undefined,
        rawText: clipText(error.text),
        extractedJson: inspected.extractedJson,
        normalizedJson: inspected.normalizedJson,
        schemaIssues: inspected.schemaIssues,
      });
      return null;
    }

    const classified = classifyError(error);
    pushAttempt(attempts, {
      provider,
      model,
      mode,
      outcome: classified.outcome,
      durationMs: elapsedMs(start),
      errorMessage: classified.errorMessage,
    });
    return null;
  }
}

async function generateDslWithModel(
  prompt: string,
): Promise<{ dsl: GameDsl | null; provider: string; model: string; attempts: ModelAttempt[] }> {
  const attempts: ModelAttempt[] = [];
  let lastProvider = getActiveProvider();
  let lastModel = getProviderConfig(lastProvider).models.logic;

  for (const provider of providerOrder()) {
    const { config, client } = createProviderClient(provider);
    lastProvider = config.provider;
    lastModel = config.models.logic;

    if (!config.apiKey) {
      pushAttempt(attempts, {
        provider: config.provider,
        model: config.models.logic,
        mode: 'structured-chat',
        outcome: 'no-api-key',
      });
      continue;
    }

    const structuredChat = await tryStructuredCall(
      'structured-chat',
      config.provider,
      config.models.logic,
      async () => {
        const result = await generateText({
          model: client.chat(config.models.logic),
          system: LOGIC_SYSTEM_PROMPT,
          output: Output.object({
            name: 'GameDsl',
            description: 'A valid browser-playable dodge survival game DSL object.',
            schema: gameDslSchema,
          }),
          prompt,
          temperature: 0.2,
          timeout: MODEL_CALL_TIMEOUT_MS,
        });
        return result.output;
      },
      attempts,
    );

    if (structuredChat) {
      return {
        dsl: structuredChat,
        provider: config.provider,
        model: config.models.logic,
        attempts,
      };
    }

    const structuredAuto = await tryStructuredCall(
      'structured-auto',
      config.provider,
      config.models.logic,
      async () => {
        const result = await generateText({
          model: client(config.models.logic),
          system: LOGIC_SYSTEM_PROMPT,
          output: Output.object({
            name: 'GameDsl',
            description: 'A valid browser-playable dodge survival game DSL object.',
            schema: gameDslSchema,
          }),
          prompt,
          temperature: 0.2,
          timeout: MODEL_CALL_TIMEOUT_MS,
        });
        return result.output;
      },
      attempts,
    );

    if (structuredAuto) {
      return {
        dsl: structuredAuto,
        provider: config.provider,
        model: config.models.logic,
        attempts,
      };
    }

    const start = nowMs();
    try {
      const textResult = await generateText({
        model: client.chat(config.models.logic),
        system: `${LOGIC_SYSTEM_PROMPT}\nReturn raw JSON only.`,
        prompt,
        temperature: 0.2,
        timeout: MODEL_CALL_TIMEOUT_MS,
      });

      const extracted = extractStructuredCandidate(textResult.text);
      if (!extracted.value) {
        pushAttempt(attempts, {
          provider: config.provider,
          model: config.models.logic,
          mode: 'text-json',
          outcome: 'invalid-json',
          durationMs: elapsedMs(start),
          errorMessage: 'Could not parse JSON or YAML from text response.',
          rawText: clipText(textResult.text),
        });
        continue;
      }

      const inspected = inspectCandidate(extracted.value, extracted.format);
      if (!inspected.dsl) {
        pushAttempt(attempts, {
          provider: config.provider,
          model: config.models.logic,
          mode: 'text-json',
          outcome: 'invalid-schema',
          durationMs: elapsedMs(start),
          errorMessage: 'Schema mismatch after normalization.',
          extractedFormat: extracted.format ?? undefined,
          rawText: clipText(textResult.text),
          extractedJson: inspected.extractedJson,
          normalizedJson: inspected.normalizedJson,
          schemaIssues: inspected.schemaIssues,
        });
        continue;
      }

      pushAttempt(attempts, {
        provider: config.provider,
        model: config.models.logic,
        mode: 'text-json',
        outcome: 'success',
        durationMs: elapsedMs(start),
        extractedFormat: extracted.format ?? undefined,
        rawText: clipText(textResult.text),
        extractedJson: inspected.extractedJson,
        normalizedJson: inspected.normalizedJson,
      });

      return {
        dsl: inspected.dsl,
        provider: config.provider,
        model: config.models.logic,
        attempts,
      };
    } catch (error) {
      const classified = classifyError(error);
      pushAttempt(attempts, {
        provider: config.provider,
        model: config.models.logic,
        mode: 'text-json',
        outcome: classified.outcome,
        durationMs: elapsedMs(start),
        errorMessage: classified.errorMessage,
      });
    }
  }

  return { dsl: null, provider: lastProvider, model: lastModel, attempts };
}

function ensureLastKnownGood(lastKnownGood?: GameDsl): GameDsl {
  if (lastKnownGood) {
    return lastKnownGood;
  }
  return getDefaultLastKnownGood();
}

function validatedFallback(fallbackDsl: GameDsl): { dsl: GameDsl; validation: CombinedValidationResult } {
  const first = validateDsl(fallbackDsl, DEFAULT_SMOKE_TICKS);
  if (first.ok) {
    return { dsl: first.dsl, validation: first.validation };
  }

  const safeDefault = ensureLastKnownGood();
  const second = validateDsl(safeDefault, DEFAULT_SMOKE_TICKS);
  if (second.ok) {
    return { dsl: second.dsl, validation: second.validation };
  }

  throw new Error('No valid fallback DSL available.');
}

function validateOrFallback(candidate: unknown, fallbackDsl: GameDsl) {
  const result = validateDsl(candidate, DEFAULT_SMOKE_TICKS);
  if (result.ok) {
    return { dsl: result.dsl, validation: result.validation, fallbackUsed: false };
  }

  const fallback = validatedFallback(fallbackDsl);
  return { dsl: fallback.dsl, validation: fallback.validation, fallbackUsed: true };
}

async function repairIfNeeded(
  candidate: unknown,
  fallbackDsl: GameDsl,
): Promise<{
  dsl: GameDsl;
  validation: CombinedValidationResult;
  repaired: boolean;
  fallbackUsed: boolean;
  source: 'model' | 'repair' | 'last-known-good';
  attempts: ModelAttempt[];
}> {
  const attempts: ModelAttempt[] = [];
  let currentValidation = validateDsl(candidate, DEFAULT_SMOKE_TICKS);
  if (currentValidation.ok) {
    return {
      dsl: currentValidation.dsl,
      validation: currentValidation.validation,
      repaired: false,
      fallbackUsed: false,
      source: 'model',
      attempts,
    };
  }

  let currentCandidate = candidate;
  for (let attempt = 0; attempt < MAX_REPAIR_ATTEMPTS; attempt += 1) {
    const repaired = await generateDslWithModel(
      repairPrompt(
        JSON.stringify(currentCandidate),
        formatValidationIssues(currentValidation.validation),
      ),
    );

    attempts.push(...repaired.attempts);
    if (!repaired.dsl) {
      continue;
    }

    currentCandidate = repaired.dsl;
    currentValidation = validateDsl(repaired.dsl, DEFAULT_SMOKE_TICKS);

    if (currentValidation.ok) {
      return {
        dsl: currentValidation.dsl,
        validation: currentValidation.validation,
        repaired: true,
        fallbackUsed: false,
        source: 'repair',
        attempts,
      };
    }
  }

  const fallback = validateOrFallback(fallbackDsl, ensureLastKnownGood());
  return {
    dsl: fallback.dsl,
    validation: fallback.validation,
    repaired: true,
    fallbackUsed: true,
    source: 'last-known-good',
    attempts,
  };
}

export async function generateDslFromPrompt(
  prompt: string,
  lastKnownGood?: GameDsl,
): Promise<SolveResult> {
  const fallbackDsl = ensureLastKnownGood(lastKnownGood);
  const modelResult = await generateDslWithModel(generationPrompt(prompt));

  if (!modelResult.dsl) {
    const templated = createTemplateFromPrompt(prompt);
    const validated = validateOrFallback(templated, fallbackDsl);
    return {
      dsl: validated.dsl,
      validation: validated.validation,
      repaired: false,
      fallbackUsed: validated.fallbackUsed,
      source: validated.fallbackUsed ? 'last-known-good' : 'template',
      statusMessage: validated.fallbackUsed
        ? 'No successful model output. Reverted to last known good game.'
        : 'No successful model output. Used deterministic template generation.',
      provider: modelResult.provider,
      model: modelResult.model,
      attempts: modelResult.attempts,
    };
  }

  const repaired = await repairIfNeeded(modelResult.dsl, fallbackDsl);
  return {
    dsl: repaired.dsl,
    validation: repaired.validation,
    repaired: repaired.repaired,
    fallbackUsed: repaired.fallbackUsed,
    source: repaired.source,
    statusMessage: repaired.fallbackUsed
      ? 'Generated output failed validation; reverted to last known good.'
      : repaired.repaired
        ? 'Generated with automatic repair.'
        : 'Generated successfully.',
    provider: modelResult.provider,
    model: modelResult.model,
    attempts: [...modelResult.attempts, ...repaired.attempts],
  };
}

export async function modifyDslFromInstruction(
  instruction: string,
  currentDsl: GameDsl,
  lastKnownGood?: GameDsl,
): Promise<SolveResult> {
  const fallbackDsl = ensureLastKnownGood(lastKnownGood ?? currentDsl);
  const modelResult = await generateDslWithModel(
    modificationPrompt(instruction, JSON.stringify(currentDsl)),
  );

  if (!modelResult.dsl) {
    const validated = validateOrFallback(currentDsl, fallbackDsl);
    return {
      dsl: validated.dsl,
      validation: validated.validation,
      repaired: false,
      fallbackUsed: validated.fallbackUsed,
      source: validated.fallbackUsed ? 'last-known-good' : 'template',
      statusMessage: validated.fallbackUsed
        ? 'No successful model output. Reverted to last known good game.'
        : 'No successful model output. Kept current validated game.',
      provider: modelResult.provider,
      model: modelResult.model,
      attempts: modelResult.attempts,
    };
  }

  const repaired = await repairIfNeeded(modelResult.dsl, fallbackDsl);
  return {
    dsl: repaired.dsl,
    validation: repaired.validation,
    repaired: repaired.repaired,
    fallbackUsed: repaired.fallbackUsed,
    source: repaired.source,
    statusMessage: repaired.fallbackUsed
      ? 'Modification failed validation; restored last known good game.'
      : repaired.repaired
        ? 'Modification applied after automatic repair.'
        : 'Modification applied successfully.',
    provider: modelResult.provider,
    model: modelResult.model,
    attempts: [...modelResult.attempts, ...repaired.attempts],
  };
}
