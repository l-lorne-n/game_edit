import { Box } from '@upstash/box';
import type { ExecStreamChunk } from '@upstash/box';

import {
  getCodexAppServerArgs,
  getCodexAppServerCommand,
  getCodexAppServerPort,
  getCodexRuntimeBinaryName,
  getCodexRuntimeInstallDir,
  getCodexRuntimeReleaseTag,
  getUpstashBoxApiKey,
  getUpstashBoxId,
  getUpstashBoxName,
  isUpstashBoxConfigured,
} from '@/lib/config/infra';
import type {
  SandboxCodexAppServerConfig,
  SandboxCodexRuntimeState,
  SandboxCommandResult,
  SandboxProvider,
  SandboxWorkspaceFile,
  UpstashBoxHandle,
} from '@/lib/sandbox/types';

async function normalizeStreamRunResult(run: {
  status: SandboxCommandResult['status'];
  result: string;
  [Symbol.asyncIterator](): AsyncIterableIterator<ExecStreamChunk>;
}): Promise<SandboxCommandResult> {
  let output = '';
  for await (const chunk of run) {
    if (chunk.type === 'output') {
      output += chunk.data;
    }
  }

  return {
    output: run.result || output,
    status: run.status,
  };
}

export class UpstashBoxProvider implements SandboxProvider {
  readonly name = 'upstash-box';

  private cachedBox: Promise<UpstashBoxHandle> | null = null;
  private runtimeStatePromise: Promise<SandboxCodexRuntimeState> | null = null;
  private resolvedRuntimeBinaryPath: string | null = null;

  getReadiness() {
    return {
      supported: true,
      configured: isUpstashBoxConfigured(),
      provider: this.name,
      reason: isUpstashBoxConfigured()
        ? null
        : 'UPSTASH_BOX_API_KEY and UPSTASH_BOX_ID/UPSTASH_BOX_NAME are required for Upstash Box.',
    } as const;
  }

  getBoxId(): string | null {
    return getUpstashBoxId() ?? getUpstashBoxName() ?? null;
  }

  async ensureCodexRuntime(): Promise<SandboxCodexRuntimeState> {
    if (!this.runtimeStatePromise) {
      this.runtimeStatePromise = this.ensureCodexRuntimeImpl();
    }
    return this.runtimeStatePromise;
  }

  async writeFiles(files: SandboxWorkspaceFile[]): Promise<void> {
    const box = await this.getBox();
    await Promise.all(files.map(file => box.files.write({ path: file.path, content: file.content })));
  }

  async readFile(path: string): Promise<string> {
    const box = await this.getBox();
    return box.files.read(path);
  }

  async execCommand(command: string): Promise<SandboxCommandResult> {
    const box = await this.getBox();
    const run = await box.exec.stream(command);
    return normalizeStreamRunResult(run);
  }

  async startCodexAppServer(config: SandboxCodexAppServerConfig): Promise<SandboxCommandResult> {
    const baseCommand = [config.command, ...config.args].join(' ').trim();
    const command = config.cwd ? `cd ${JSON.stringify(config.cwd)} && ${baseCommand}` : baseCommand;
    if (!command) {
      throw new Error('Codex app-server command is not configured.');
    }

    return this.execCommand(command);
  }

  getDefaultCodexAppServerConfig(): SandboxCodexAppServerConfig {
    const command =
      getCodexAppServerCommand() === 'codex'
        ? (this.resolvedRuntimeBinaryPath ?? `${getCodexRuntimeInstallDir()}/bin/${getCodexRuntimeBinaryName()}`)
        : getCodexAppServerCommand();
    if (!command) {
      throw new Error('CODEX_APP_SERVER_COMMAND is not configured.');
    }

    return {
      command,
      args: getCodexAppServerArgs(),
      port: getCodexAppServerPort(),
    };
  }

  private async ensureCodexRuntimeImpl(): Promise<SandboxCodexRuntimeState> {
    const installDir = getCodexRuntimeInstallDir();

    const platformProbe = await this.execCommand('uname -s && uname -m');
    const platform = platformProbe.output
      .split(/\r?\n/)
      .map(part => part.trim())
      .filter(Boolean)
      .join(' ');

    const assetName = this.selectCodexAssetName(platform);
    const binaryName = this.selectCodexBinaryName(platform) ?? getCodexRuntimeBinaryName();
    const binaryPath = `${installDir}/bin/${binaryName}`;
    if (!assetName) {
      return {
        ready: false,
        binaryPath: null,
        installedNow: false,
        version: null,
        reason: `Unsupported Box platform for Codex runtime: ${platform || 'unknown'}`,
        platform: platform || null,
        assetName: null,
      };
    }

    const assetUrl = `https://github.com/openai/codex/releases/download/${getCodexRuntimeReleaseTag()}/${assetName}`;

    const existing = await this.execCommand(`if [ -x ${JSON.stringify(binaryPath)} ]; then ${JSON.stringify(binaryPath)} --version; else exit 42; fi`);
    if (existing.status === 'completed') {
      this.resolvedRuntimeBinaryPath = binaryPath;
      return {
        ready: true,
        binaryPath,
        installedNow: false,
        version: existing.output.trim() || null,
        reason: null,
        platform: platform || null,
        assetName,
      };
    }

    const provisionScript = [
      `rm -rf ${JSON.stringify(`${installDir}/bin`)}`,
      `mkdir -p ${JSON.stringify(`${installDir}/bin`)}`,
      `curl -fsSL ${JSON.stringify(assetUrl)} -o ${JSON.stringify(`${installDir}/codex.tar.gz`)}`,
      `tar -xzf ${JSON.stringify(`${installDir}/codex.tar.gz`)} -C ${JSON.stringify(`${installDir}/bin`)}`,
      `chmod +x ${JSON.stringify(binaryPath)}`,
      `${JSON.stringify(binaryPath)} --version`,
    ].join(' && ');

    const install = await this.execCommand(provisionScript);
    if (install.status !== 'completed') {
      const lowered = install.output.toLowerCase();
      const reason = lowered.includes('exec format error')
        ? 'Codex runtime binary format does not match the Box platform.'
        : lowered.includes('glibc_') || lowered.includes('version `glibc')
          ? 'Codex runtime binary requires a newer glibc than the Box provides; use the musl build.'
        : install.output || 'Failed to provision codex runtime in Upstash Box.';
      return {
        ready: false,
        binaryPath: null,
        installedNow: false,
        version: null,
        reason,
        platform: platform || null,
        assetName,
      };
    }

    this.resolvedRuntimeBinaryPath = binaryPath;
    return {
      ready: true,
      binaryPath,
      installedNow: true,
      version: install.output.trim() || null,
      reason: null,
      platform: platform || null,
      assetName,
    };
  }

  private selectCodexAssetName(platform: string): string | null {
    const normalized = platform.toLowerCase();
    if (normalized.includes('linux') && normalized.includes('x86_64')) {
      return 'codex-x86_64-unknown-linux-musl.tar.gz';
    }
    if (normalized.includes('linux') && normalized.includes('aarch64')) {
      return 'codex-aarch64-unknown-linux-musl.tar.gz';
    }
    return null;
  }

  private selectCodexBinaryName(platform: string): string | null {
    const normalized = platform.toLowerCase();
    if (normalized.includes('linux') && normalized.includes('x86_64')) {
      return 'codex-x86_64-unknown-linux-musl';
    }
    if (normalized.includes('linux') && normalized.includes('aarch64')) {
      return 'codex-aarch64-unknown-linux-musl';
    }
    return null;
  }

  private async getBox(): Promise<UpstashBoxHandle> {
    if (!this.cachedBox) {
      this.cachedBox = this.connect();
    }

    return this.cachedBox;
  }

  private async connect(): Promise<UpstashBoxHandle> {
    const apiKey = getUpstashBoxApiKey();
    const boxId = getUpstashBoxId();
    const boxName = getUpstashBoxName();

    if (!apiKey) {
      throw new Error('UPSTASH_BOX_API_KEY is not configured.');
    }

    if (boxId) {
      return Box.get(boxId, { apiKey });
    }

    if (boxName) {
      return Box.getByName(boxName, { apiKey });
    }

    throw new Error('UPSTASH_BOX_ID/UPSTASH_BOX or UPSTASH_BOX_NAME/upstash_box_name must be configured.');
  }
}
