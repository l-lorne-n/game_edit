import { isSandboxConfigured } from '@/lib/config/infra';
import type { SandboxCodexAppServerConfig, SandboxProvider } from '@/lib/sandbox/types';

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

  getBoxId(): string | null {
    return null;
  }

  async ensureCodexRuntime() {
    return {
      ready: false,
      binaryPath: null,
      installedNow: false,
      version: null,
      reason: 'Vercel Sandbox provider is still a reserved seam in this project.',
      platform: null,
      assetName: null,
    } as const;
  }

  getDefaultCodexAppServerConfig(): SandboxCodexAppServerConfig {
    throw new Error('Vercel Sandbox provider is still a reserved seam in this project.');
  }

  async writeFiles(): Promise<void> {
    throw new Error('Vercel Sandbox provider is still a reserved seam in this project.');
  }

  async readFile(): Promise<string> {
    throw new Error('Vercel Sandbox provider is still a reserved seam in this project.');
  }

  async execCommand(): Promise<never> {
    throw new Error('Vercel Sandbox provider is still a reserved seam in this project.');
  }

  async startCodexAppServer(_config: SandboxCodexAppServerConfig): Promise<never> {
    throw new Error('Vercel Sandbox provider is still a reserved seam in this project.');
  }
}
