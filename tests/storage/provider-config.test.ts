import { afterEach, describe, expect, it } from 'vitest';

import { getInfraReadiness, getStorageProviderName } from '@/lib/config/infra';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('storage provider config', () => {
  it('prefers explicitly configured local provider', () => {
    delete process.env.BLOB_READ_WRITE_TOKEN;
    process.env.STORAGE_PROVIDER = 'local';

    expect(getStorageProviderName()).toBe('local');
    expect(getInfraReadiness().storage.configured).toBe(true);
  });

  it('falls back to blob when blob token exists', () => {
    delete process.env.STORAGE_PROVIDER;
    process.env.BLOB_READ_WRITE_TOKEN = 'blob-token';

    expect(getStorageProviderName()).toBe('blob');
    expect(getInfraReadiness().storage.configured).toBe(true);
  });

  it('uses local when blob is unconfigured', () => {
    delete process.env.STORAGE_PROVIDER;
    delete process.env.BLOB_READ_WRITE_TOKEN;

    expect(getStorageProviderName()).toBe('local');
    expect(getInfraReadiness().storage.provider).toBe('local');
  });
});
