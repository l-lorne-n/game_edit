export type SandboxReadiness = {
  supported: boolean;
  configured: boolean;
  provider: 'vercel-sandbox';
  reason: string | null;
};

export interface SandboxProvider {
  readonly name: 'vercel-sandbox';
  getReadiness(): SandboxReadiness;
}
