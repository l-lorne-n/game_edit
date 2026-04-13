function readEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

export type SupportedStorageProvider = 'blob' | 'local';

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

export function getInfraReadiness() {
  const storageProvider = getStorageProviderName();
  const blobConfigured = isBlobConfigured();
  const sandboxConfigured = isSandboxConfigured();

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
    sandbox: {
      supported: true,
      configured: sandboxConfigured,
      reason: sandboxConfigured
        ? null
        : 'VERCEL_SANDBOX_TEAM_SLUG and VERCEL_SANDBOX_PROJECT_NAME are required for the reserved sandbox seam.',
    },
  };
}
