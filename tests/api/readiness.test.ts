import { afterEach, describe, expect, it } from 'vitest';

import { GET } from '@/app/api/health/route';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('health readiness api', () => {
  it('reports configured infrastructure without leaking secrets', async () => {
    process.env.DATABASE_URL = 'postgres://user:secret@localhost:5432/game_edit';
    process.env.BLOB_READ_WRITE_TOKEN = 'blob-token';
    process.env.VERCEL_SANDBOX_TEAM_SLUG = 'team';
    process.env.VERCEL_SANDBOX_PROJECT_NAME = 'project';

    const response = await GET();
    const data = await response.json();

    expect(data.infra.database.configured).toBe(true);
    expect(data.infra.storage.configured).toBe(true);
    expect(data.sandbox.configured).toBe(true);
    expect(JSON.stringify(data)).not.toContain('blob-token');
    expect(JSON.stringify(data)).not.toContain('postgres://user:secret');
  });

  it('reports missing envs as unconfigured', async () => {
    delete process.env.DATABASE_URL;
    delete process.env.BLOB_READ_WRITE_TOKEN;
    delete process.env.VERCEL_SANDBOX_TEAM_SLUG;
    delete process.env.VERCEL_SANDBOX_PROJECT_NAME;

    const response = await GET();
    const data = await response.json();

    expect(data.infra.database.configured).toBe(false);
    expect(data.infra.storage.provider).toBe('local');
    expect(data.sandbox.configured).toBe(false);
  });
});
