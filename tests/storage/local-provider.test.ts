import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readLocalStoredFile } from '@/lib/storage/providers/local';
import { resetProviderCache } from '@/lib/storage/providers';
import { LocalProvider } from '@/lib/storage/providers/local';

describe('local storage provider', () => {
  let tempDir: string;
  let provider: LocalProvider;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'game-edit-local-'));
    process.env.LOCAL_STORAGE_PATH = tempDir;
    process.env.STORAGE_PROVIDER = 'local';
    process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3000';
    resetProviderCache();
    provider = new LocalProvider();
  });

  afterEach(async () => {
    resetProviderCache();
    delete process.env.LOCAL_STORAGE_PATH;
    delete process.env.STORAGE_PROVIDER;
    delete process.env.NEXT_PUBLIC_APP_URL;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('writes, reads, lists, copies, and serves local files', async () => {
    const url = await provider.put('projects/test-project/v1/index.html', '<h1>Hello</h1>', {
      contentType: 'text/html; charset=utf-8',
    });
    expect(url).toContain('/api/storage/projects/test-project/v1/index.html');

    expect(await provider.get('projects/test-project/v1/index.html')).toBe('<h1>Hello</h1>');

    const listed = await provider.list('projects/test-project/v1');
    expect(listed).toHaveLength(1);
    expect(listed[0]?.path).toBe('index.html');

    await provider.copy('projects/test-project/v1/index.html', 'projects/test-project/v2/index.html');
    expect(await provider.get('projects/test-project/v2/index.html')).toBe('<h1>Hello</h1>');

    const stored = await readLocalStoredFile('projects/test-project/v2/index.html');
    expect(stored?.contentType).toContain('text/html');
    expect(stored?.body.toString('utf-8')).toBe('<h1>Hello</h1>');
  });
});
