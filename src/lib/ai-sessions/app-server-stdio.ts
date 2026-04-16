import { getAiSessionWorkspaceRoot } from '@/lib/ai-sessions/workspace';
import type { HostTokenBootstrapResponse } from '@/lib/host-tokens/types';
import type { SandboxCodexAppServerConfig, SandboxProvider } from '@/lib/sandbox/types';

type JsonRpcMessage = Record<string, unknown>;

export type HostTokenRuntimeConfig = {
  sessionId: string;
  url: string;
  apiKey?: string;
};

export type CodexAppServerStopConfig = {
  stopOnMethods: string[];
  timeoutMs: number;
};

export function getAiSessionWorkspaceAbsoluteRoot(sessionId: string): string {
  return `/workspace/home/${getAiSessionWorkspaceRoot(sessionId)}`;
}

function toJsonl(messages: JsonRpcMessage[]): string {
  return messages.map(message => JSON.stringify(message)).join('\n');
}

function buildBaseCommand(config: SandboxCodexAppServerConfig): string {
  return [config.command, ...config.args].join(' ').trim();
}

export function buildCodexAppServerStdioCommand(config: SandboxCodexAppServerConfig, cwd: string, messages: JsonRpcMessage[]): string {
  const baseCommand = buildBaseCommand(config);
  const jsonl = toJsonl(messages);
  return `cd ${JSON.stringify(cwd)} && cat <<'__CODEX_JSONL__' | ${baseCommand}\n${jsonl}\n__CODEX_JSONL__`;
}

function buildRunnerScript(): string {
  return `
import { readFile, unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import readline from 'node:readline';

const configPath = process.argv[2];
if (!configPath) {
  throw new Error('Missing codex runner config path');
}

const raw = await readFile(configPath, 'utf8');
const config = JSON.parse(raw);
try { await unlink(configPath); } catch {}

const child = spawn(config.command, config.args, {
  cwd: config.cwd,
  stdio: ['pipe', 'pipe', 'inherit'],
});

const rl = readline.createInterface({ input: child.stdout });
let stopScheduled = false;
const pendingResponses = new Map();
const pendingNotifications = new Map();
const receivedNotifications = new Map();
let childExitError = null;

function rejectPending(reason) {
  for (const waiter of pendingResponses.values()) {
    waiter.reject(reason);
  }
  pendingResponses.clear();
  for (const waiters of pendingNotifications.values()) {
    for (const resolve of waiters) {
      resolve({ method: 'error', params: { message: String(reason?.message ?? reason ?? 'runner stopped') } });
    }
  }
  pendingNotifications.clear();
}

child.on('error', (error) => {
  childExitError = error;
  rejectPending(error);
});

child.on('close', (code) => {
  if (code && code !== 0) {
    const error = new Error('Codex app-server process exited with code ' + code);
    childExitError = error;
    rejectPending(error);
  }
});

function emitAndStop(message) {
  if (stopScheduled) return;
  stopScheduled = true;
  if (message) {
    process.stdout.write(JSON.stringify(message) + '\\n');
  }
  try { child.stdin.end(); } catch {}
  setTimeout(() => {
    if (!child.killed) {
      child.kill('SIGTERM');
    }
  }, 250);
}

const timeout = setTimeout(() => {
  emitAndStop({
    method: 'error',
    params: {
      message: 'Codex app-server runner timed out waiting for expected notifications.',
    },
  });
}, config.stop.timeoutMs ?? 60000);

async function refreshExternalTokens(requestId, params) {
  const response = await fetch(new URL('/api/codex/host/session/refresh', config.hostTokenService.url), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(config.hostTokenService.apiKey ? { Authorization: 'Bearer ' + config.hostTokenService.apiKey } : {}),
    },
    body: JSON.stringify({
      sessionId: config.hostTokenService.sessionId,
      previousAccountId: params?.previousAccountId ?? null,
      reason: params?.reason === 'unauthorized' ? 'unauthorized' : 'unauthorized',
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    child.stdin.write(JSON.stringify({
      id: requestId,
      error: { code: -32002, message: text || 'Host token refresh failed' },
    }) + '\\n');
    return;
  }

  const json = await response.json();
  child.stdin.write(JSON.stringify({
    id: requestId,
    result: {
      accessToken: json.accessToken,
      chatgptAccountId: json.accountId,
      chatgptPlanType: json.planType ?? null,
    },
  }) + '\\n');
}

function waitForResponse(id) {
  return new Promise((resolve, reject) => {
    pendingResponses.set(id, { resolve, reject });
  });
}

function waitForNotification(method) {
  return new Promise((resolve) => {
    const queued = receivedNotifications.get(method);
    if (queued && queued.length > 0) {
      const next = queued.shift();
      if (!queued.length) {
        receivedNotifications.delete(method);
      }
      resolve(next);
      return;
    }

    const existing = pendingNotifications.get(method) ?? [];
    existing.push(resolve);
    pendingNotifications.set(method, existing);
  });
}

async function sendMessage(message) {
  child.stdin.write(JSON.stringify(message) + '\\n');
  if (typeof message.id === 'number') {
    return waitForResponse(message.id);
  }
  return null;
}

rl.on('line', (line) => {
  process.stdout.write(line + '\\n');
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  if (msg && msg.method === 'account/chatgptAuthTokens/refresh' && msg.id != null) {
    void refreshExternalTokens(msg.id, msg.params);
  }

  if (msg && typeof msg.id === 'number' && (Object.prototype.hasOwnProperty.call(msg, 'result') || Object.prototype.hasOwnProperty.call(msg, 'error'))) {
    const waiter = pendingResponses.get(msg.id);
    if (waiter) {
      pendingResponses.delete(msg.id);
      if (msg.error) {
        waiter.reject(msg.error);
      } else {
        waiter.resolve(msg);
      }
    }
  }

  if (msg && typeof msg.method === 'string') {
    const waiters = pendingNotifications.get(msg.method);
    if (waiters && waiters.length > 0) {
      pendingNotifications.delete(msg.method);
      for (const resolve of waiters) {
        resolve(msg);
      }
    } else {
      const queued = receivedNotifications.get(msg.method) ?? [];
      queued.push(msg);
      receivedNotifications.set(msg.method, queued);
    }
  }

  if (msg?.method && Array.isArray(config.stop?.stopOnMethods) && config.stop.stopOnMethods.includes(msg.method)) {
    // stop is coordinated after sequential waits finish
  }
});

for (const message of config.messages) {
  await sendMessage(message);
}

if (Array.isArray(config.stop?.stopOnMethods)) {
  for (const method of config.stop.stopOnMethods) {
    await waitForNotification(method);
  }
}

emitAndStop(null);

const exitCode = await new Promise((resolve) => {
  child.on('close', (code) => resolve(code ?? 0));
});

clearTimeout(timeout);

if (childExitError) {
  throw childExitError;
}

if (exitCode !== 0) {
  process.exit(Number(exitCode));
}
`;
}

export function buildCodexAppServerRunnerFiles(
  sessionId: string,
  config: SandboxCodexAppServerConfig,
  cwd: string,
  messages: JsonRpcMessage[],
  hostTokenService: HostTokenRuntimeConfig,
  stop: CodexAppServerStopConfig,
) {
  const root = getAiSessionWorkspaceRoot(sessionId);
  const runnerPath = `${root}/.codex-runner.mjs`;
  const configPath = `${root}/.codex-runner-config.json`;

  return [
    { path: runnerPath, content: buildRunnerScript() },
    {
      path: configPath,
      content: JSON.stringify(
        {
          command: config.command,
          args: config.args,
          cwd,
          messages,
          hostTokenService,
          stop,
        },
        null,
        2,
      ),
    },
  ] as const;
}

export function buildCodexRunnerExecCommand(sessionId: string): string {
  const root = getAiSessionWorkspaceAbsoluteRoot(sessionId);
  return `cd ${JSON.stringify(root)} && node .codex-runner.mjs ./.codex-runner-config.json`;
}

export function parseJsonlOutput(output: string): JsonRpcMessage[] {
  return output
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .flatMap(line => {
      try {
        return [JSON.parse(line) as JsonRpcMessage];
      } catch {
        return [];
      }
    });
}

export function createInitializeMessages(): JsonRpcMessage[] {
  return [
    {
      method: 'initialize',
      id: 0,
      params: {
        clientInfo: {
          name: 'game_edit',
          title: 'Game Edit',
          version: '1.0.0',
        },
        capabilities: {
          experimentalApi: true,
        },
      },
    },
    {
      method: 'initialized',
      params: {},
    },
  ];
}

export function createExternalAuthLoginMessage(tokens: HostTokenBootstrapResponse): JsonRpcMessage {
  return {
    method: 'account/login/start',
    id: 1,
    params: {
      type: 'chatgptAuthTokens',
      accessToken: tokens.accessToken,
      chatgptAccountId: tokens.accountId,
      chatgptPlanType: null,
    },
  };
}

function getCodexSandboxMode(): string {
  return process.env.CODEX_APP_SERVER_SANDBOX ?? 'danger-full-access';
}

export function createThreadStartMessage(sessionId: string): JsonRpcMessage {
  return {
    method: 'thread/start',
    id: 2,
    params: {
      model: 'gpt-5.4',
      cwd: getAiSessionWorkspaceAbsoluteRoot(sessionId),
      approvalPolicy: 'never',
      sandbox: getCodexSandboxMode(),
      serviceName: 'game_edit',
    },
  };
}

export function createThreadResumeMessage(threadId: string): JsonRpcMessage {
  return {
    method: 'thread/resume',
    id: 2,
    params: {
      threadId,
    },
  };
}

export function createTurnStartMessage(sessionId: string, threadId: string, prompt: string): JsonRpcMessage {
  return {
    method: 'turn/start',
    id: 3,
    params: {
      threadId,
      cwd: getAiSessionWorkspaceAbsoluteRoot(sessionId),
      approvalPolicy: 'never',
      sandbox: getCodexSandboxMode(),
      input: [{ type: 'text', text: prompt }],
    },
  };
}

export async function runCodexAppServerJsonRpc(
  sandboxProvider: SandboxProvider,
  config: SandboxCodexAppServerConfig,
  cwd: string,
  messages: JsonRpcMessage[],
  sessionId: string,
  hostTokenService: HostTokenRuntimeConfig,
  stop: CodexAppServerStopConfig,
) {
  const files = buildCodexAppServerRunnerFiles(sessionId, config, cwd, messages, hostTokenService, stop);
  await sandboxProvider.writeFiles(files.map(file => ({ path: file.path, content: file.content })));
  const result = await sandboxProvider.execCommand(buildCodexRunnerExecCommand(sessionId));
  return {
    ...result,
    messages: parseJsonlOutput(result.output),
  };
}

export function findThreadId(messages: JsonRpcMessage[]): string | null {
  for (const message of messages) {
    const result = message.result as { thread?: { id?: string } } | undefined;
    if (result?.thread?.id) {
      return result.thread.id;
    }

    const params = message.params as { thread?: { id?: string } } | undefined;
    if ((message.method === 'thread/started' || message.method === 'thread/resumed') && params?.thread?.id) {
      return params.thread.id;
    }
  }
  return null;
}

export function didAccountLoginSucceed(messages: JsonRpcMessage[]): boolean {
  return messages.some(message => {
    if (message.method === 'account/login/completed' || message.method === 'account/updated') {
      return true;
    }

    if (message.id === 1 && 'result' in message && !('error' in message)) {
      return true;
    }

    return false;
  });
}

export function findJsonRpcError(messages: JsonRpcMessage[]): string | null {
  for (const message of messages) {
    if ('error' in message) {
      const error = message.error as { message?: string; code?: number } | undefined;
      return error?.message ?? 'Unknown app-server protocol error.';
    }
    if (message.method === 'error') {
      const params = message.params as { message?: string } | undefined;
      return params?.message ?? 'Unknown app-server notification error.';
    }
  }
  return null;
}

export function findLoginError(messages: JsonRpcMessage[]): string | null {
  for (const message of messages) {
    if (message.id === 1 && 'error' in message) {
      const error = message.error as { message?: string } | undefined;
      return error?.message ?? 'Codex app-server login request failed.';
    }

    if (message.method === 'account/login/completed') {
      const params = message.params as { success?: boolean; error?: string | { message?: string } | null } | undefined;
      if (params?.success === false) {
        if (typeof params.error === 'string') {
          return params.error;
        }
        return params?.error && typeof params.error === 'object' && 'message' in params.error
          ? (params.error.message ?? 'Codex app-server login did not succeed.')
          : 'Codex app-server login did not succeed.';
      }
    }
  }

  return null;
}

export function findThreadStartError(messages: JsonRpcMessage[]): string | null {
  for (const message of messages) {
    if (message.id === 2 && 'error' in message) {
      const error = message.error as { message?: string } | undefined;
      return error?.message ?? 'Codex app-server thread start failed.';
    }
  }

  return null;
}

export function findRunnerError(messages: JsonRpcMessage[]): string | null {
  for (const message of messages) {
    if (message.method === 'error') {
      const params = message.params as { message?: string } | undefined;
      return params?.message ?? 'Unknown app-server runner error.';
    }
  }

  return null;
}

export function findTurnCompletedStatus(messages: JsonRpcMessage[]): string | null {
  for (const message of messages) {
    if (message.method === 'turn/completed') {
      const params = message.params as { turn?: { status?: string } } | undefined;
      return params?.turn?.status ?? null;
    }
  }
  return null;
}

export function collectAgentMessageText(messages: JsonRpcMessage[]): string {
  return messages
    .filter(message => message.method === 'item/agentMessage/delta')
    .map(message => {
      const params = message.params as { delta?: string; text?: string } | undefined;
      return params?.delta ?? params?.text ?? '';
    })
    .join('');
}
