import { isSandboxConfigured } from '@/lib/config/infra';
import type { SandboxProvider } from '@/lib/sandbox/types';

export class VercelSandboxProvider implements SandboxProvider {
  readonly name = 'vercel-sandbox';

  getReadiness() {
    return {
      supported: true,
      configured: isSandboxConfigured(),
      provider: this.name,
      reason: isSandboxConfigured()
        ? null
        : 'Vercel Sandbox seam is reserved but not configured in this rehearsal.',
    } as const;
  }
}
