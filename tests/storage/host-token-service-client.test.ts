import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HostTokenServiceClient, HostTokenServiceError } from '@/lib/host-tokens/client';

const ORIGINAL_ENV = { ...process.env };

describe('host token service client', () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('bootstraps a session through the host token service', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          sessionId: 'sess-1',
          idToken: 'id-token',
          accessToken: 'access-token',
          expiresAt: 123,
          accountId: 'acct-1',
        }),
        { status: 200 },
      ),
    );

    const client = new HostTokenServiceClient('http://localhost:8787', 'secret-key', fetchImpl as typeof fetch);
    const result = await client.bootstrap({ sessionId: 'sess-1', bindToken: 'bind-1' });

    expect(result.accessToken).toBe('access-token');
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://localhost:8787/api/codex/host/session/bootstrap',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer secret-key' }),
      }),
    );
  });

  it('throws a typed error on failed refresh', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'refresh blocked', code: 'host_session_revoked' }), { status: 401 }),
    );

    const client = new HostTokenServiceClient('http://localhost:8787', undefined, fetchImpl as typeof fetch);

    await expect(client.refresh({ sessionId: 'sess-1' })).rejects.toEqual(
      expect.objectContaining<Partial<HostTokenServiceError>>({ status: 401, code: 'host_session_revoked' }),
    );
  });

  it('builds a client from env', async () => {
    process.env.HOST_TOKEN_SERVICE_URL = 'http://localhost:8787';
    process.env.HOST_TOKEN_SERVICE_API_KEY = 'env-key';

    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ revoked: false, sessionId: 'sess-1', expiresAt: 123 }), { status: 200 }),
    );

    const client = HostTokenServiceClient.fromEnv(fetchImpl as typeof fetch);
    await client.getSession('sess-1');

    expect(fetchImpl).toHaveBeenCalledWith(
      'http://localhost:8787/api/codex/host/session/sess-1',
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer env-key' }) }),
    );
  });
});
