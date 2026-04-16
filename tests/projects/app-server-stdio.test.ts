import { describe, expect, it } from 'vitest';

import {
  buildCodexAppServerRunnerFiles,
  buildCodexRunnerExecCommand,
  findLoginError,
  findRunnerError,
  findThreadId,
} from '@/lib/ai-sessions/app-server-stdio';

describe('app-server stdio runner generation', () => {
  it('generates a sequential runner script with response and notification waits', () => {
    const [runner, config] = buildCodexAppServerRunnerFiles(
      'sess-1',
      {
        command: '/workspace/home/.local/codex-runtime/bin/codex-aarch64-unknown-linux-musl',
        args: ['app-server', '--enable', 'experimentalApi'],
        port: 4317,
      },
      '/workspace/home/sessions/sess-1',
      [
        { method: 'initialize', id: 0, params: {} },
        { method: 'initialized', params: {} },
        { method: 'thread/start', id: 2, params: {} },
      ],
      {
        sessionId: 'sess-1',
        url: 'http://localhost:3000',
        apiKey: 'secret',
      },
      { stopOnMethods: ['thread/started'], timeoutMs: 60000 },
    );

    expect(runner.path).toContain('sessions/sess-1/.codex-runner.mjs');
    expect(runner.content).toContain('pendingResponses');
    expect(runner.content).toContain('waitForResponse');
    expect(runner.content).toContain('waitForNotification');
    expect(runner.content).toContain('receivedNotifications');
    expect(runner.content).toContain('const queued = receivedNotifications.get(method)');
    expect(runner.content).toContain('await sendMessage(message);');
    expect(runner.content).toContain("await waitForNotification(method);");
    expect(runner.content).toContain('/api/codex/host/session/refresh');
    expect(config.content).toContain('thread/started');
  });

  it('uses absolute workspace path when building runner exec command', () => {
    expect(buildCodexRunnerExecCommand('sess-1')).toBe(
      'cd "/workspace/home/sessions/sess-1" && node .codex-runner.mjs ./.codex-runner-config.json',
    );
  });

  it('extracts thread id from thread/started notifications', () => {
    expect(
      findThreadId([
        {
          method: 'thread/started',
          params: { thread: { id: 'thr-1' } },
        },
      ]),
    ).toBe('thr-1');
  });

  it('distinguishes login errors from runner errors', () => {
    expect(
      findLoginError([
        { method: 'account/login/completed', params: { success: false, error: 'bad auth' } },
        { method: 'error', params: { message: 'runner timeout' } },
      ]),
    ).toBe('bad auth');
    expect(findRunnerError([{ method: 'error', params: { message: 'runner timeout' } }])).toBe('runner timeout');
  });
});
