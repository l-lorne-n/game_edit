import { describe, expect, it, vi } from 'vitest';

import {
  ensureCodexAppServerDaemon,
  getCodexAppServerDaemonTurnMessages,
  getCodexAppServerDaemonTurnResult,
  getCodexAppServerDaemonTurnStatus,
  submitCodexAppServerDaemonTurn,
} from '@/lib/ai-sessions/app-server-daemon';
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

  it('writes a daemon script that separates raw messages from compact turn metadata', async () => {
    const execCommand = vi
      .fn()
      .mockResolvedValueOnce({ status: 'completed', output: '' })
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

    const daemonScript = writeFiles.mock.calls[0]?.[0]?.find(file => file.path.endsWith('.codex-daemon.mjs'))?.content;
    expect(daemonScript).toContain("getTurnMessagesPath(turnId)");
    expect(daemonScript).toContain('turnMessagesMatch');
    expect(daemonScript).not.toContain('messages: Array.isArray(turn.messages) ? turn.messages : []');
    expect(daemonScript.indexOf('await persistTurnMessages(turn);')).toBeLessThan(
      daemonScript.indexOf("await writeFile(getTurnPath(turn.turnId), JSON.stringify(summarizeTurn(turn), null, 2));"),
    );
  });
});

describe('daemon turn client helpers', () => {
  it('submits turns through the async submit endpoint', async () => {
    const execCommand = vi.fn().mockResolvedValue({
      status: 'completed',
      output: JSON.stringify({
        ok: true,
        deduplicated: false,
        turn: {
          turnId: 'turn-1',
          phase: 'submitted',
          submittedAt: '2026-04-17T00:00:00.000Z',
          startedAt: null,
          completedAt: null,
          code: null,
          error: null,
          turnStatus: null,
          state: { initialized: true, threadId: 'thr-1', materialized: false, appServerPid: 123 },
        },
      }),
    });
    const sandboxProvider = createSandboxProvider(execCommand);

    const response = await submitCodexAppServerDaemonTurn(sandboxProvider, 'session-1', {
      turnId: 'turn-1',
      phase: 'turn',
      messages: [],
      stopOnMethods: ['turn/completed'],
      timeoutMs: 300000,
    });

    expect(response.turn.phase).toBe('submitted');
    expect(execCommand.mock.calls[0]?.[0]).toContain('/turns/submit');
  });

  it('loads compact status/result records and a separate raw messages stream', async () => {
    const execCommand = vi
      .fn()
      .mockResolvedValueOnce({
        status: 'completed',
        output: JSON.stringify({
          ok: true,
          turn: {
            turnId: 'turn-1',
            phase: 'running',
            submittedAt: '2026-04-17T00:00:00.000Z',
            startedAt: '2026-04-17T00:00:01.000Z',
            completedAt: null,
            code: null,
            error: null,
            turnStatus: null,
            state: { initialized: true, threadId: 'thr-1', materialized: false, appServerPid: 123 },
          },
        }),
      })
      .mockResolvedValueOnce({
        status: 'completed',
        output: JSON.stringify({
          ok: true,
          turn: {
            turnId: 'turn-1',
            phase: 'completed',
            submittedAt: '2026-04-17T00:00:00.000Z',
            startedAt: '2026-04-17T00:00:01.000Z',
            completedAt: '2026-04-17T00:00:02.000Z',
            code: null,
            error: null,
            turnStatus: 'completed',
            state: { initialized: true, threadId: 'thr-1', materialized: true, appServerPid: 123 },
          },
        }),
      })
      .mockResolvedValueOnce({
        status: 'completed',
        output: JSON.stringify({
          ok: true,
          turnId: 'turn-1',
          messages: [
            { method: 'item/agentMessage/delta', params: { delta: 'done' } },
            { method: 'turn/completed', params: { turn: { status: 'completed' } } },
          ],
        }),
      });
    const sandboxProvider = createSandboxProvider(execCommand);

    const status = await getCodexAppServerDaemonTurnStatus(sandboxProvider, 'session-1', 'turn-1');
    const result = await getCodexAppServerDaemonTurnResult(sandboxProvider, 'session-1', 'turn-1');
    const messages = await getCodexAppServerDaemonTurnMessages(sandboxProvider, 'session-1', 'turn-1');

    expect(status?.phase).toBe('running');
    expect(result?.turnStatus).toBe('completed');
    expect(messages).toHaveLength(2);
    expect(execCommand.mock.calls[0]?.[0]).toContain('/turns/turn-1/status');
    expect(execCommand.mock.calls[1]?.[0]).toContain('/turns/turn-1/result');
    expect(execCommand.mock.calls[2]?.[0]).toContain('/turns/turn-1/messages');
  });
});
