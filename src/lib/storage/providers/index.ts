import { getStorageProviderName } from '@/lib/config/infra';
import type { StorageProvider } from '@/lib/storage/types';

import { LocalProvider } from './local';
import { VercelBlobProvider } from './vercel-blob';

const providerFactories: Record<'blob' | 'local', () => StorageProvider> = {
  blob: () => new VercelBlobProvider(),
  local: () => new LocalProvider(),
};

let cachedProvider: StorageProvider | null = null;

export function getProvider(name?: 'blob' | 'local'): StorageProvider {
  if (cachedProvider && !name) {
    return cachedProvider;
  }

  const providerName = name ?? getStorageProviderName();
  const factory = providerFactories[providerName];

  if (!factory) {
    throw new Error(`Unknown storage provider: ${providerName}`);
  }

  const provider = factory();
  if (!name) {
    cachedProvider = provider;
  }
  return provider;
}

export function resetProviderCache() {
  cachedProvider = null;
}
