import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

type HostTokenOAuthConfig = {
  issuer: string;
  clientId: string;
  redirectUri: string;
  callbackPort: number;
  callbackPath: string;
  scopes: string[];
  originator: string;
};

export type HostTokenServerConfig = {
  storageDir: string;
  oauth: HostTokenOAuthConfig;
};

function readEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

export function getHostTokenStorageDir(): string {
  return resolve(process.cwd(), readEnv('HOST_TOKEN_STORAGE_DIR') ?? '.data/host-tokens');
}

export function loadHostTokenServerConfig(): HostTokenServerConfig {
  const issuer = readEnv('OPENAI_OAUTH_ISSUER');
  const clientId = readEnv('OPENAI_OAUTH_CLIENT_ID');
  const callbackPort = Number.parseInt(readEnv('OPENAI_OAUTH_CALLBACK_PORT') ?? '1455', 10);
  const callbackPath = normalizeCallbackPath(readEnv('OPENAI_OAUTH_CALLBACK_PATH') ?? '/auth/callback');
  const redirectUri =
    readEnv('OPENAI_OAUTH_REDIRECT_URI') ??
    new URL(callbackPath, `http://localhost:${callbackPort}`).toString();
  const scopes = (readEnv('OPENAI_OAUTH_SCOPES') ?? 'openid profile email offline_access').split(/\s+/).filter(Boolean);
  const originator = readEnv('OPENAI_OAUTH_ORIGINATOR') ?? 'game_edit';

  if (!issuer || !clientId) {
    throw new Error('OPENAI_OAUTH_ISSUER and OPENAI_OAUTH_CLIENT_ID are required for the host token service.');
  }

  return {
    storageDir: getHostTokenStorageDir(),
    oauth: {
      issuer,
      clientId,
      redirectUri,
      callbackPort,
      callbackPath,
      scopes,
      originator,
    },
  };
}

function normalizeCallbackPath(path: string): string {
  return path.startsWith('/') ? path : `/${path}`;
}

export async function ensureHostTokenStorageDir(): Promise<string> {
  const dir = getHostTokenStorageDir();
  await mkdir(dir, { recursive: true });
  return dir;
}
