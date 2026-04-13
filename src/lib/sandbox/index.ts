import { VercelSandboxProvider } from '@/lib/sandbox/providers/vercel-sandbox';

let cachedProvider: VercelSandboxProvider | null = null;

export function getSandboxProvider() {
  if (!cachedProvider) {
    cachedProvider = new VercelSandboxProvider();
  }
  return cachedProvider;
}

export function getSandboxReadiness() {
  return getSandboxProvider().getReadiness();
}
