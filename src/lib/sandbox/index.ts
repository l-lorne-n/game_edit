import { getSandboxProviderName } from '@/lib/config/infra';
import { UpstashBoxProvider } from '@/lib/sandbox/providers/upstash-box';
import { VercelSandboxProvider } from '@/lib/sandbox/providers/vercel-sandbox';
import type { SandboxProvider } from '@/lib/sandbox/types';

let cachedProvider: SandboxProvider | null = null;

export function getSandboxProvider() {
  if (!cachedProvider) {
    cachedProvider = getSandboxProviderName() === 'upstash-box' ? new UpstashBoxProvider() : new VercelSandboxProvider();
  }
  return cachedProvider;
}

export function resetSandboxProviderForTests() {
  cachedProvider = null;
}

export function getSandboxReadiness() {
  return getSandboxProvider().getReadiness();
}
