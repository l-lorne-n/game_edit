import { afterEach, describe, expect, it } from 'vitest';

import { getSandboxReadiness, resetSandboxProviderForTests } from '@/lib/sandbox';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  resetSandboxProviderForTests();
});

describe('sandbox seam', () => {
  it('defaults to the reserved vercel seam when no sandbox env is set', () => {
    delete process.env.VERCEL_SANDBOX_TEAM_SLUG;
    delete process.env.VERCEL_SANDBOX_PROJECT_NAME;
    delete process.env.UPSTASH_BOX_API_KEY;
    delete process.env.UPSTASH_BOX;
    delete process.env.upstash_box;
    delete process.env.UPSTASH_BOX_NAME;
    delete process.env.upstash_box_name;

    const readiness = getSandboxReadiness();
    expect(readiness.supported).toBe(true);
    expect(readiness.configured).toBe(false);
    expect(readiness.provider).toBe('vercel-sandbox');
  });

  it('becomes configured for vercel when required envs exist', () => {
    process.env.VERCEL_SANDBOX_TEAM_SLUG = 'team';
    process.env.VERCEL_SANDBOX_PROJECT_NAME = 'project';

    const readiness = getSandboxReadiness();
    expect(readiness.configured).toBe(true);
    expect(readiness.provider).toBe('vercel-sandbox');
    expect(readiness.reason).toBeNull();
  });

  it('prefers Upstash Box when Upstash env is configured', () => {
    process.env.UPSTASH_BOX_API_KEY = 'box-key';
    process.env.upstash_box = 'box_123';

    const readiness = getSandboxReadiness();
    expect(readiness.configured).toBe(true);
    expect(readiness.provider).toBe('upstash-box');
    expect(readiness.reason).toBeNull();
  });
});
