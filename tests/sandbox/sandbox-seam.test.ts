import { afterEach, describe, expect, it } from 'vitest';

import { getSandboxReadiness } from '@/lib/sandbox';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('sandbox seam', () => {
  it('defaults to an unconfigured reserved seam', () => {
    delete process.env.VERCEL_SANDBOX_TEAM_SLUG;
    delete process.env.VERCEL_SANDBOX_PROJECT_NAME;

    const readiness = getSandboxReadiness();
    expect(readiness.supported).toBe(true);
    expect(readiness.configured).toBe(false);
    expect(readiness.provider).toBe('vercel-sandbox');
  });

  it('becomes configured when required envs exist', () => {
    process.env.VERCEL_SANDBOX_TEAM_SLUG = 'team';
    process.env.VERCEL_SANDBOX_PROJECT_NAME = 'project';

    const readiness = getSandboxReadiness();
    expect(readiness.configured).toBe(true);
    expect(readiness.reason).toBeNull();
  });
});
