import { generateText } from 'ai';
import { parse as parseYaml } from 'yaml';

import { createProviderClient, getActiveProvider, getProviderConfig } from '@/lib/ai/config';
import {
  PACKAGE_SYSTEM_PROMPT,
  packageDebugPrompt,
  packageGenerationPrompt,
  packageModificationPrompt,
  packageRepairPrompt,
} from '@/lib/ai/package-prompts';
import type { ModelAttempt, ModelAttemptOutcome } from '@/lib/ai/types';
import { evaluatePackageStatic } from '@/lib/evaluator/static';
import type { EvaluatorResult } from '@/lib/evaluator/types';
import {
  parseGeneratedGamePackage,
  type GamePackageManifest,
  type GeneratedGamePackage,
} from '@/lib/package/contracts';
import { createTemplatePackage } from '@/lib/package/template';

export type PackageSolveSource = 'model' | 'repair' | 'template';

export type PackageSolveResult = {
  pkg: GeneratedGamePackage;
  manifest: GamePackageManifest;
  staticEvaluation: EvaluatorResult;
  repaired: boolean;
  fallbackUsed: boolean;
  source: PackageSolveSource;
  statusMessage: string;
  provider: string;
  model: string;
  attempts: ModelAttempt[];
};

const MODEL_CALL_TIMEOUT_MS = Number.parseInt(process.env.MODEL_CALL_TIMEOUT_MS ?? '120000', 10);

function isTimeoutError(error: unknown): boolean {
  return /abort|timeout/i.test(String(error));
}

function getModelTimeoutMs(): number {
  return Number.isFinite(MODEL_CALL_TIMEOUT_MS) && MODEL_CALL_TIMEOUT_MS > 0 ? MODEL_CALL_TIMEOUT_MS : 120_000;
}

function clipText(value: string | undefined, max = 4000): string | undefined {
  if (!value) {
    return undefined;
  }
  const text = value.trim();
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max)}\n...[truncated]`;
}

function parseJsonObject(text: string): unknown | null {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseYamlObject(text: string): unknown | null {
  try {
    const parsed = parseYaml(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function extractCandidate(text: string): { value: unknown | null; format: 'json' | 'yaml' | null } {
  const trimmed = text.trim();
  const wholeJson = parseJsonObject(trimmed);
  if (wholeJson) {
    return { value: wholeJson, format: 'json' };
  }

  const fenceRegex = /```(json|yaml|yml)?\s*([\s\S]*?)```/gi;
  let match: RegExpExecArray | null = null;
  while ((match = fenceRegex.exec(trimmed)) !== null) {
    const lang = (match[1] ?? '').toLowerCase();
    const body = match[2].trim();

    if (lang !== 'yaml' && lang !== 'yml') {
      const jsonBody = parseJsonObject(body);
      if (jsonBody) {
        return { value: jsonBody, format: 'json' };
      }
    }

    const yamlBody = parseYamlObject(body);
    if (yamlBody) {
      return { value: yamlBody, format: 'yaml' };
    }
  }

  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const maybeJson = parseJsonObject(trimmed.slice(firstBrace, lastBrace + 1));
    if (maybeJson) {
      return { value: maybeJson, format: 'json' };
    }
  }

  const wholeYaml = parseYamlObject(trimmed);
  if (wholeYaml) {
    return { value: wholeYaml, format: 'yaml' };
  }

  return { value: null, format: null };
}

function attemptOutcomeForParse(input: {
  candidate: unknown | null;
  validationOk: boolean;
  staticOk: boolean;
}): ModelAttemptOutcome {
  if (!input.candidate) {
    return 'invalid-json';
  }
  if (!input.validationOk || !input.staticOk) {
    return 'invalid-schema';
  }
  return 'success';
}

async function callModel(prompt: string): Promise<{ text: string; durationMs: number }> {
  const provider = getActiveProvider();
  const { config, client } = createProviderClient(provider);
  const modelId = config.models.logic;

  const timeoutMs = getModelTimeoutMs();

  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const result = await generateText({
      model: client(modelId),
      system: PACKAGE_SYSTEM_PROMPT,
      prompt,
      temperature: 0.2,
      abortSignal: controller.signal,
    });

    return {
      text: result.text,
      durationMs: Math.max(0, Date.now() - started),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function parseWithValidation(candidate: unknown): {
  ok: boolean;
  pkg?: GeneratedGamePackage;
  manifest?: GamePackageManifest;
  issueText: string;
  staticEval: EvaluatorResult;
} {
  const parsed = parseGeneratedGamePackage(candidate);
  if (!parsed.ok) {
    return {
      ok: false,
      issueText: [parsed.message, ...(parsed.issues ?? [])].join('\n'),
      staticEval: evaluatePackageStatic(candidate),
    };
  }

  const staticEval = evaluatePackageStatic(parsed.pkg);
  if (!staticEval.ok) {
    return {
      ok: false,
      issueText: [staticEval.summary, ...staticEval.errors].join('\n'),
      staticEval,
    };
  }

  return {
    ok: true,
    pkg: parsed.pkg,
    manifest: parsed.manifest,
    issueText: '',
    staticEval,
  };
}

function fallbackResult(input: {
  seed: string;
  sourceLabel: string;
  attempts: ModelAttempt[];
  fallbackPackage?: GeneratedGamePackage;
  provider: string;
  model: string;
}): PackageSolveResult {
  const pkg = input.fallbackPackage ?? createTemplatePackage(input.seed);
  const parsed = parseGeneratedGamePackage(pkg);
  const manifest =
    parsed.ok
      ? parsed.manifest
      : {
          title: 'Fallback Package',
          summary: 'Fallback package used because model output was invalid.',
          editable: [],
          capabilities: [],
        };
  return {
    pkg,
    manifest,
    staticEvaluation: evaluatePackageStatic(pkg),
    repaired: false,
    fallbackUsed: true,
    source: 'template',
    statusMessage: input.sourceLabel,
    provider: input.provider,
    model: input.model,
    attempts: input.attempts,
  };
}

async function solvePackage(input: {
  prompt: string;
  seed: string;
  fallbackPackage?: GeneratedGamePackage;
}): Promise<PackageSolveResult> {
  const attempts: ModelAttempt[] = [];
  const provider = getActiveProvider();
  const providerConfig = getProviderConfig(provider);
  const model = providerConfig.models.logic;

  if (!providerConfig.apiKey) {
    attempts.push({
      provider,
      model,
      mode: 'text-json',
      outcome: 'no-api-key',
      durationMs: 0,
      errorMessage: 'Missing provider API key.',
    });
    return fallbackResult({
      seed: input.seed,
      sourceLabel: 'No API key configured. Using fallback package.',
      attempts,
      fallbackPackage: input.fallbackPackage,
      provider,
      model,
    });
  }

  let firstRaw = '';
  let validationIssueText = '';

  try {
    const first = await callModel(input.prompt);
    firstRaw = first.text;
    const firstCandidate = extractCandidate(first.text);
    const parsed = firstCandidate.value ? parseWithValidation(firstCandidate.value) : null;

    attempts.push({
      provider,
      model,
      mode: 'text-json',
      outcome: attemptOutcomeForParse({
        candidate: firstCandidate.value,
        validationOk: Boolean(parsed?.ok),
        staticOk: Boolean(parsed?.staticEval.ok),
      }),
      durationMs: first.durationMs,
      extractedFormat: firstCandidate.format ?? undefined,
      rawText: clipText(first.text),
      normalizedJson: firstCandidate.value ? clipText(JSON.stringify(firstCandidate.value, null, 2)) : undefined,
      errorMessage: parsed?.ok ? undefined : parsed?.issueText || 'Unable to parse package object.',
    });

    if (parsed?.ok && parsed.pkg && parsed.manifest) {
      return {
        pkg: parsed.pkg,
        manifest: parsed.manifest,
        staticEvaluation: parsed.staticEval,
        repaired: false,
        fallbackUsed: false,
        source: 'model',
        statusMessage: 'Generated package and passed static checks.',
        provider,
        model,
        attempts,
      };
    }

    validationIssueText = parsed?.issueText ?? 'Unable to parse model package output.';
  } catch (error) {
    const timeout = isTimeoutError(error);
    const message = error instanceof Error ? error.message : String(error);
    attempts.push({
      provider,
      model,
      mode: 'text-json',
      outcome: timeout ? 'timeout' : 'error',
      durationMs: timeout ? getModelTimeoutMs() : 0,
      errorMessage: message,
    });
    return fallbackResult({
      seed: input.seed,
      sourceLabel: timeout
        ? `Model request timed out after ${getModelTimeoutMs()}ms. Using fallback package.`
        : `Model request failed (${message}). Using fallback package.`,
      attempts,
      fallbackPackage: input.fallbackPackage,
      provider,
      model,
    });
  }

  const repairPrompt = packageRepairPrompt({
    candidateText: firstRaw,
    validationIssues: validationIssueText,
  });

  try {
    const repair = await callModel(repairPrompt);
    const repairCandidate = extractCandidate(repair.text);
    const parsedRepair = repairCandidate.value ? parseWithValidation(repairCandidate.value) : null;

    attempts.push({
      provider,
      model,
      mode: 'text-json',
      outcome: attemptOutcomeForParse({
        candidate: repairCandidate.value,
        validationOk: Boolean(parsedRepair?.ok),
        staticOk: Boolean(parsedRepair?.staticEval.ok),
      }),
      durationMs: repair.durationMs,
      extractedFormat: repairCandidate.format ?? undefined,
      rawText: clipText(repair.text),
      normalizedJson: repairCandidate.value
        ? clipText(JSON.stringify(repairCandidate.value, null, 2))
        : undefined,
      errorMessage: parsedRepair?.ok
        ? undefined
        : parsedRepair?.issueText || 'Unable to parse repaired package output.',
    });

    if (parsedRepair?.ok && parsedRepair.pkg && parsedRepair.manifest) {
      return {
        pkg: parsedRepair.pkg,
        manifest: parsedRepair.manifest,
        staticEvaluation: parsedRepair.staticEval,
        repaired: true,
        fallbackUsed: false,
        source: 'repair',
        statusMessage: 'Generated package required one repair pass.',
        provider,
        model,
        attempts,
      };
    }
  } catch (error) {
    const timeout = isTimeoutError(error);
    const message = error instanceof Error ? error.message : String(error);
    attempts.push({
      provider,
      model,
      mode: 'text-json',
      outcome: timeout ? 'timeout' : 'error',
      durationMs: timeout ? getModelTimeoutMs() : 0,
      errorMessage: message,
    });
  }

  return fallbackResult({
    seed: input.seed,
    sourceLabel: 'Model output remained invalid after repair. Using fallback package.',
    attempts,
    fallbackPackage: input.fallbackPackage,
    provider,
    model,
  });
}

export async function generatePackageFromPrompt(
  prompt: string,
  lastKnownGood?: GeneratedGamePackage,
): Promise<PackageSolveResult> {
  return solvePackage({
    prompt: packageGenerationPrompt(prompt),
    seed: prompt,
    fallbackPackage: lastKnownGood,
  });
}

export async function modifyPackageFromInstruction(input: {
  instruction: string;
  currentPackage: GeneratedGamePackage;
  lastKnownGood?: GeneratedGamePackage;
}): Promise<PackageSolveResult> {
  return solvePackage({
    prompt: packageModificationPrompt({
      instruction: input.instruction,
      currentPackage: input.currentPackage,
    }),
    seed: input.instruction,
    fallbackPackage: input.lastKnownGood ?? input.currentPackage,
  });
}

export async function debugPackageFromReport(input: {
  errorReport: string;
  currentPackage: GeneratedGamePackage;
  evaluatorSummary?: string;
  lastKnownGood?: GeneratedGamePackage;
}): Promise<PackageSolveResult> {
  return solvePackage({
    prompt: packageDebugPrompt({
      errorReport: input.errorReport,
      currentPackage: input.currentPackage,
      evaluatorSummary: input.evaluatorSummary,
    }),
    seed: input.errorReport,
    fallbackPackage: input.lastKnownGood ?? input.currentPackage,
  });
}
