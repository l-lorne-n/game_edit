import { createOpenAI } from '@ai-sdk/openai';

export type LlmProvider = 'apiyi' | 'openrouter';
export type LlmRole = 'logic' | 'style';

type ProviderConfig = {
  provider: LlmProvider;
  baseURL: string;
  apiKey: string;
  models: Record<LlmRole, string>;
};

const DEFAULTS = {
  apiyi: {
    baseURL: 'https://api.apiyi.com/v1',
    logicModel: 'gpt-5.4',
    styleModel: 'gemini-3.1-pro-preview',
  },
  openrouter: {
    baseURL: 'https://openrouter.ai/api/v1',
    logicModel: 'openai/gpt-5.4',
    styleModel: 'google/gemini-3.1-pro-preview',
  },
} as const;

function env(name: string): string | undefined {
  const value = process.env[name];
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function getActiveProvider(): LlmProvider {
  const raw = env('LLM_PROVIDER');
  if (raw === 'openrouter') {
    return 'openrouter';
  }
  return 'apiyi';
}

export function getProviderConfig(provider = getActiveProvider()): ProviderConfig {
  if (provider === 'openrouter') {
    return {
      provider,
      baseURL: env('OPENROUTER_BASE_URL') ?? DEFAULTS.openrouter.baseURL,
      apiKey: env('OPENROUTER_LLM_API_KEY') ?? '',
      models: {
        logic: env('OPENROUTER_LOGIC_MODEL') ?? DEFAULTS.openrouter.logicModel,
        style: env('OPENROUTER_STYLE_MODEL') ?? DEFAULTS.openrouter.styleModel,
      },
    };
  }

  return {
    provider: 'apiyi',
    baseURL: env('APIYI_BASE_URL') ?? DEFAULTS.apiyi.baseURL,
    apiKey: env('APIYI_LLM_API_KEY') ?? '',
    models: {
      logic: env('APIYI_LOGIC_MODEL') ?? DEFAULTS.apiyi.logicModel,
      style: env('APIYI_STYLE_MODEL') ?? DEFAULTS.apiyi.styleModel,
    },
  };
}

export function createProviderClient(provider = getActiveProvider()) {
  const config = getProviderConfig(provider);
  const client = createOpenAI({
    name: config.provider,
    baseURL: config.baseURL,
    apiKey: config.apiKey,
  });

  return {
    config,
    client,
  };
}

export function getModelId(role: LlmRole, provider = getActiveProvider()): string {
  const config = getProviderConfig(provider);
  return config.models[role];
}

export function getHealthSummary() {
  const provider = getActiveProvider();
  const config = getProviderConfig(provider);

  return {
    status: 'ok' as const,
    provider,
    hasApiKey: config.apiKey.length > 0,
    baseURL: config.baseURL,
    models: {
      logic: config.models.logic,
      style: config.models.style,
    },
  };
}
