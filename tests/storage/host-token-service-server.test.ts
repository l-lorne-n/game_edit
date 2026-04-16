import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HostTokenService } from '@/lib/host-tokens/server/service';
import { FileHostTokenStore } from '@/lib/host-tokens/server/store';

const ORIGINAL_ENV = { ...process.env };

describe('host token service server', () => {
  let storageDir = '';

  beforeEach(async () => {
    process.env = { ...ORIGINAL_ENV };
    storageDir = await mkdtemp(join(tmpdir(), 'game-edit-host-token-'));
    process.env.HOST_TOKEN_STORAGE_DIR = storageDir;
    process.env.OPENAI_OAUTH_ISSUER = 'https://auth.example.com';
    process.env.OPENAI_OAUTH_CLIENT_ID = 'client-123';
    process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3000';
  });

  afterEach(async () => {
    process.env = { ...ORIGINAL_ENV };
    vi.unstubAllGlobals();
    if (storageDir) {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  it('bootstraps only when a valid bind token is provided and binds it to ai session id', async () => {
    const store = new FileHostTokenStore(storageDir);
    await store.init();
    await store.saveAuthSession({
      authSessionId: 'auth-1',
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      idToken: 'id-1',
      bindToken: 'bind-1',
      bindTokenExpiresAt: Date.now() + 60_000,
      expiresAt: Date.now() + 60_000,
      accountId: 'acct-1',
      planType: 'plus',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const service = new HostTokenService(store);
    const result = await service.bootstrapWithBindToken('ai-session-1', 'bind-1');

    expect(result.sessionId).toBe('ai-session-1');
    expect(result.accountId).toBe('acct-1');
    expect(result.planType).toBe('plus');
    const binding = await store.getBinding('ai-session-1');
    expect(binding?.authSessionId).toBe('auth-1');
  });

  it('rejects bootstrap when bind token is missing or wrong', async () => {
    const store = new FileHostTokenStore(storageDir);
    await store.init();
    await store.saveAuthSession({
      authSessionId: 'auth-1',
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      idToken: 'id-1',
      bindToken: 'bind-1',
      bindTokenExpiresAt: Date.now() + 60_000,
      expiresAt: Date.now() + 60_000,
      accountId: 'acct-1',
      planType: 'plus',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const service = new HostTokenService(store);
    await expect(service.bootstrapWithBindToken('ai-session-1', 'wrong-bind')).rejects.toThrow(/bindToken/i);
  });

  it('refreshes an expired bound auth session through the oauth issuer', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: 'access-2',
          refresh_token: 'refresh-2',
          id_token: 'header.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoiYWNjdC0xIiwiY2hhdGdwdF9wbGFuX3R5cGUiOiJwcm8ifX0.sig',
          expires_in: 3600,
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const store = new FileHostTokenStore(storageDir);
    await store.init();
    await store.saveAuthSession({
      authSessionId: 'auth-1',
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      idToken: 'header.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoiYWNjdC0xIiwiY2hhdGdwdF9wbGFuX3R5cGUiOiJwbHVzIn19.sig',
      expiresAt: Date.now() - 10_000,
      accountId: 'acct-1',
      planType: 'plus',
      createdAt: Date.now() - 20_000,
      updatedAt: Date.now() - 20_000,
    });
    await store.saveBinding({
      aiSessionId: 'ai-session-1',
      authSessionId: 'auth-1',
      createdAt: Date.now() - 20_000,
      updatedAt: Date.now() - 20_000,
    });

    const service = new HostTokenService(store);
    const result = await service.refresh('ai-session-1', 'acct-1');

    expect(result.accessToken).toBe('access-2');
    expect(result.accountId).toBe('acct-1');
    expect(result.planType).toBe('pro');
    expect(fetchMock).toHaveBeenCalled();
  });

  it('revokes a bound ai session without deleting the underlying auth session', async () => {
    const store = new FileHostTokenStore(storageDir);
    await store.init();
    await store.saveAuthSession({
      authSessionId: 'auth-1',
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      idToken: 'id-1',
      expiresAt: Date.now() + 60_000,
      accountId: 'acct-1',
      planType: 'plus',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await store.saveBinding({
      aiSessionId: 'ai-session-1',
      authSessionId: 'auth-1',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const service = new HostTokenService(store);
    await service.revoke('ai-session-1');

    expect(await service.getSession('ai-session-1')).toBeNull();
    expect(await store.getAuthSession('auth-1')).toBeDefined();
  });
});
