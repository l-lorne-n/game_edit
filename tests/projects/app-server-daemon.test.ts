import { describe, expect, it, vi } from 'vitest';

import { ensureCodexAppServerDaemon } from '@/lib/ai-sessions/app-server-daemon';
import type { SandboxProvider } from '@/lib/sandbox/types';

function createSandboxProvider(execCommand: SandboxProvider['execCommand']): SandboxProvider {
  return {
    name: 'upstash-box',
    getReadiness: () => ({ supported: true, configured: true, provider: 'upstash-box', reason: null }),
    getBoxId: () => 'box-1',
    ensureCodexRuntime: vi.fn(),
    writeFiles: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn(),
    execCommand,
    startCodexAppServer: vi.fn(),
    getDefaultCodexAppServerConfig: vi.fn(),
  };
}

describe('ensureCodexAppServerDaemon', () => {
  it('shuts down an unhealthy wrapper before starting a new daemon and waits for ok:true', async () => {
    const execCommand = vi
      .fn()
      .mockResolvedValueOnce({ status: 'completed', output: '{"ok":false,"error":"child died"}' })
      .mockResolvedValueOnce({ status: 'completed', output: '{"ok":true}' })
      .mockResolvedValueOnce({ status: 'completed', output: '' })
      .mockResolvedValueOnce({ status: 'completed', output: '' });
    const sandboxProvider = createSandboxProvider(execCommand);
    const writeFiles = vi.spyOn(sandboxProvider, 'writeFiles').mockResolvedValue(undefined);

    await ensureCodexAppServerDaemon(
      sandboxProvider,
      'session-1',
      { command: 'codex', args: ['app-server'], port: 4317 },
      '/workspace/home/sessions/session-1',
      { sessionId: 'session-1', url: 'http://host-token-service.local', apiKey: 'key' },
    );

    expect(execCommand).toHaveBeenCalledTimes(4);
    expect(execCommand.mock.calls[1]?.[0]).toContain('/shutdown');
    expect(execCommand.mock.calls[3]?.[0]).toContain('"ok":true');
    expect(writeFiles).toHaveBeenCalledTimes(1);
  });
});
