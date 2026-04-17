import { beforeEach, describe, expect, it, vi } from 'vitest';

import { UpstashBoxProvider } from '@/lib/sandbox/providers/upstash-box';

const { getMock, getByNameMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  getByNameMock: vi.fn(),
}));

vi.mock('@upstash/box', () => ({
  Box: {
    get: getMock,
    getByName: getByNameMock,
  },
}));

const ORIGINAL_ENV = { ...process.env };

describe('upstash box provider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...ORIGINAL_ENV };
  });

  it('reports unconfigured when api key or box identifier is missing', () => {
    delete process.env.UPSTASH_BOX_API_KEY;
    delete process.env.UPSTASH_BOX;
    delete process.env.UPSTASH_BOX_NAME;

    const provider = new UpstashBoxProvider();
    const readiness = provider.getReadiness();

    expect(readiness.provider).toBe('upstash-box');
    expect(readiness.configured).toBe(false);
  });

  it('connects by configured box id and writes files', async () => {
    process.env.UPSTASH_BOX_API_KEY = 'box-key';
    process.env.upstash_box = 'box_123';

    const writeMock = vi.fn().mockResolvedValue(undefined);
    getMock.mockResolvedValue({
      files: {
        write: writeMock,
      },
    });

    const provider = new UpstashBoxProvider();
    await provider.writeFiles([
      { path: 'index.html', content: '<html />' },
      { path: 'game.js', content: 'console.log(1);' },
    ]);

    expect(getMock).toHaveBeenCalledWith('box_123', { apiKey: 'box-key' });
    expect(writeMock).toHaveBeenCalledTimes(2);
  });

  it('connects by configured box name and normalizes exec output', async () => {
    process.env.UPSTASH_BOX_API_KEY = 'box-key';
    process.env.upstash_box_name = 'named-box';

    async function* outputStream() {
      yield { type: 'output' as const, data: 'ok' };
      yield { type: 'exit' as const, exitCode: 0, cpuNs: 1 };
    }

    getByNameMock.mockResolvedValue({
      exec: {
        stream: vi.fn().mockResolvedValue({
          result: 'ok',
          status: 'completed',
          [Symbol.asyncIterator]: outputStream,
        }),
      },
    });

    const provider = new UpstashBoxProvider();
    const result = await provider.execCommand('pwd');

    expect(getByNameMock).toHaveBeenCalledWith('named-box', { apiKey: 'box-key' });
    expect(result).toEqual({ output: 'ok', status: 'completed' });
  });

  it('starts codex app-server from configured command and args', async () => {
    process.env.UPSTASH_BOX_API_KEY = 'box-key';
    process.env.UPSTASH_BOX = 'box_123';

    async function* outputStream() {
      yield { type: 'output' as const, data: 'started' };
      yield { type: 'exit' as const, exitCode: 0, cpuNs: 1 };
    }

    const commandMock = vi.fn().mockResolvedValue({
      result: 'started',
      status: 'completed',
      [Symbol.asyncIterator]: outputStream,
    });
    getMock.mockResolvedValue({
      exec: {
        stream: commandMock,
      },
    });

    const provider = new UpstashBoxProvider();
    const result = await provider.startCodexAppServer({
      command: 'codex',
      args: ['app-server', '--listen', 'stdio://'],
      port: 4317,
      cwd: 'sessions/sess-1',
    });

    expect(commandMock).toHaveBeenCalledWith('cd "sessions/sess-1" && codex app-server --listen stdio://');
    expect(result).toEqual({ output: 'started', status: 'completed' });
  });

  it('classifies request-level exec timeouts', async () => {
    process.env.UPSTASH_BOX_API_KEY = 'box-key';
    process.env.UPSTASH_BOX = 'box_123';

    const timeoutError = new TypeError('fetch failed', {
      cause: new Error('Headers Timeout Error'),
    });
    getMock.mockResolvedValue({
      exec: {
        stream: vi.fn().mockRejectedValue(timeoutError),
      },
    });

    const provider = new UpstashBoxProvider();

    await expect(provider.execCommand('pwd')).rejects.toMatchObject({
      code: 'upstash_box_exec_timeout',
      name: 'UpstashBoxExecError',
    });
  });

  it('classifies stream-level exec failures', async () => {
    process.env.UPSTASH_BOX_API_KEY = 'box-key';
    process.env.UPSTASH_BOX = 'box_123';

    async function* brokenStream() {
      yield { type: 'output' as const, data: 'partial' };
      throw new Error('stream terminated unexpectedly');
    }

    getMock.mockResolvedValue({
      exec: {
        stream: vi.fn().mockResolvedValue({
          result: '',
          status: 'running',
          [Symbol.asyncIterator]: brokenStream,
        }),
      },
    });

    const provider = new UpstashBoxProvider();

    await expect(provider.execCommand('pwd')).rejects.toMatchObject({
      code: 'upstash_box_exec_stream_failed',
      name: 'UpstashBoxExecError',
    });
  });
});
