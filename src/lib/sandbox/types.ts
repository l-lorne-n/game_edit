import type { Box } from '@upstash/box';

export type SandboxReadiness = {
  supported: boolean;
  configured: boolean;
  provider: 'vercel-sandbox' | 'upstash-box';
  reason: string | null;
};

export type SandboxWorkspaceFile = {
  path: string;
  content: string;
};

export type SandboxCommandResult = {
  output: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'detached';
};

export type SandboxCodexRuntimeState = {
  ready: boolean;
  binaryPath: string | null;
  installedNow: boolean;
  version: string | null;
  reason: string | null;
  platform: string | null;
  assetName: string | null;
};

export type SandboxCodexAppServerConfig = {
  command: string;
  args: string[];
  port: number;
  cwd?: string;
  env?: Record<string, string>;
};

export interface SandboxProvider {
  readonly name: 'vercel-sandbox' | 'upstash-box';
  getReadiness(): SandboxReadiness;
  getBoxId(): string | null;
  ensureCodexRuntime(): Promise<SandboxCodexRuntimeState>;
  getDefaultCodexAppServerConfig(): SandboxCodexAppServerConfig;
  writeFiles(files: SandboxWorkspaceFile[]): Promise<void>;
  readFile(path: string): Promise<string>;
  execCommand(command: string): Promise<SandboxCommandResult>;
  startCodexAppServer(config: SandboxCodexAppServerConfig): Promise<SandboxCommandResult>;
}

export type UpstashBoxHandle = Box<unknown>;
