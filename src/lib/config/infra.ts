function readEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function readAnyEnv(...names: string[]): string | undefined {
  for (const name of names) {
    const value = readEnv(name);
    if (value) {
      return value;
    }
  }
  return undefined;
}

export type SupportedStorageProvider = 'blob' | 'local';
export type SupportedSandboxProvider = 'upstash-box' | 'vercel-sandbox';
export type SupportedCodexRouteEngine = 'legacy-model' | 'codex-app-server';

export function getHostTokenServiceBaseUrl(): string | undefined {
  return readAnyEnv('HOST_TOKEN_SERVICE_URL', 'APP_URL', 'NEXT_PUBLIC_APP_URL');
}

export function getHostTokenServiceApiKey(): string | undefined {
  return readEnv('HOST_TOKEN_SERVICE_API_KEY');
}

export function isHostTokenServiceConfigured(): boolean {
  return Boolean(getHostTokenServiceBaseUrl());
}

export function getDatabaseUrl(): string | undefined {
  return readEnv('DATABASE_URL');
}

export function isDatabaseConfigured(): boolean {
  return Boolean(getDatabaseUrl());
}

export function getStorageProviderName(): SupportedStorageProvider {
  const configured = readEnv('STORAGE_PROVIDER');
  if (configured === 'blob' || configured === 'local') {
    return configured;
  }

  return readEnv('BLOB_READ_WRITE_TOKEN') ? 'blob' : 'local';
}

export function isBlobConfigured(): boolean {
  return Boolean(readEnv('BLOB_READ_WRITE_TOKEN'));
}

export function getLocalStoragePath(): string | undefined {
  return readEnv('LOCAL_STORAGE_PATH');
}

export function getSandboxTeamSlug(): string | undefined {
  return readEnv('VERCEL_SANDBOX_TEAM_SLUG');
}

export function getSandboxProjectName(): string | undefined {
  return readEnv('VERCEL_SANDBOX_PROJECT_NAME');
}

export function isSandboxConfigured(): boolean {
  return Boolean(getSandboxTeamSlug() && getSandboxProjectName());
}

export function getUpstashBoxApiKey(): string | undefined {
  return readAnyEnv('UPSTASH_BOX_API_KEY');
}

export function getUpstashBoxId(): string | undefined {
  return readAnyEnv('UPSTASH_BOX_ID', 'UPSTASH_BOX', 'upstash_box');
}

export function getUpstashBoxName(): string | undefined {
  return readAnyEnv('UPSTASH_BOX_NAME', 'upstash_box_name');
}

export function isUpstashBoxConfigured(): boolean {
  return Boolean(getUpstashBoxApiKey() && (getUpstashBoxId() || getUpstashBoxName()));
}

export function getSandboxProviderName(): SupportedSandboxProvider {
  const configured = readEnv('SANDBOX_PROVIDER');
  if (configured === 'upstash-box' || configured === 'vercel-sandbox') {
    return configured;
  }

  if (isUpstashBoxConfigured()) {
    return 'upstash-box';
  }

  return 'vercel-sandbox';
}

export function getCodexAppServerCommand(): string | undefined {
  return readEnv('CODEX_APP_SERVER_COMMAND') ?? 'codex';
}

export function getCodexAppServerArgs(): string[] {
  const raw = readEnv('CODEX_APP_SERVER_ARGS');
  if (!raw) {
    return ['app-server'];
  }

  return raw.split(/(?:\r?\n|,)/).map(part => part.trim()).filter(Boolean);
}

export function getCodexAppServerPort(): number {
  const raw = readEnv('CODEX_APP_SERVER_PORT');
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 4317;
}

export function getCodexRuntimeInstallDir(): string {
  return readEnv('CODEX_RUNTIME_INSTALL_DIR') ?? '/workspace/home/.local/codex-runtime';
}

export function getCodexRuntimeReleaseTag(): string {
  return readEnv('CODEX_RUNTIME_RELEASE_TAG') ?? 'rust-v0.120.0';
}

export function getCodexRuntimeBinaryName(): string {
  return readEnv('CODEX_RUNTIME_BINARY_NAME') ?? 'codex';
}

export function getCodexRouteEngine(): SupportedCodexRouteEngine {
  const configured = readEnv('CODEX_ROUTE_ENGINE');
  if (configured === 'app-server') {
    return 'codex-app-server';
  }
  if (configured === 'legacy') {
    return 'legacy-model';
  }

  if (isUpstashBoxConfigured() && isHostTokenServiceConfigured()) {
    return 'codex-app-server';
  }

  return 'legacy-model';
}

export function getInfraReadiness() {
  const storageProvider = getStorageProviderName();
  const blobConfigured = isBlobConfigured();
  const sandboxProvider = getSandboxProviderName();
  const sandboxConfigured = sandboxProvider === 'upstash-box' ? isUpstashBoxConfigured() : isSandboxConfigured();
  const hostTokenServiceConfigured = isHostTokenServiceConfigured();

  return {
    database: {
      supported: true,
      configured: isDatabaseConfigured(),
      reason: isDatabaseConfigured() ? null : 'DATABASE_URL is not configured.',
    },
    storage: {
      supported: true,
      provider: storageProvider,
      configured: storageProvider === 'local' ? true : blobConfigured,
      reason:
        storageProvider === 'local'
          ? null
          : blobConfigured
            ? null
            : 'BLOB_READ_WRITE_TOKEN is not configured for blob storage.',
    },
    hostTokenService: {
      supported: true,
      configured: hostTokenServiceConfigured,
      reason: hostTokenServiceConfigured ? null : 'HOST_TOKEN_SERVICE_URL is not configured.',
    },
    sandbox: {
      supported: true,
      provider: sandboxProvider,
      configured: sandboxConfigured,
      reason: sandboxConfigured
        ? null
        : sandboxProvider === 'upstash-box'
          ? 'UPSTASH_BOX_API_KEY and UPSTASH_BOX_ID/UPSTASH_BOX_NAME are required for Upstash Box.'
          : 'VERCEL_SANDBOX_TEAM_SLUG and VERCEL_SANDBOX_PROJECT_NAME are required for the reserved sandbox seam.',
    },
  };
}
