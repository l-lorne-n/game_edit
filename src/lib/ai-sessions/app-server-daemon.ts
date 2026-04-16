import type { SandboxCodexAppServerConfig, SandboxProvider } from '@/lib/sandbox/types';
import { getAiSessionWorkspaceRoot } from '@/lib/ai-sessions/workspace';

export type JsonRpcMessage = Record<string, unknown>;

export type HostTokenRuntimeConfig = {
  sessionId: string;
  url: string;
  apiKey?: string;
};

type CodexAppServerDaemonRequest = {
  phase: 'init' | 'turn';
  messages: JsonRpcMessage[];
  stopOnMethods: string[];
  timeoutMs: number;
};

type CodexAppServerDaemonResponse = {
  ok: boolean;
  messages: JsonRpcMessage[];
  state: {
    initialized: boolean;
    threadId: string | null;
    materialized: boolean;
    appServerPid: number | null;
  };
  error?: string;
  code?: string;
};

function getDaemonRoot(sessionId: string): string {
  return `/workspace/home/${getAiSessionWorkspaceRoot(sessionId)}`;
}

export function getAiSessionDaemonPort(sessionId: string): number {
  let hash = 0;
  for (const char of sessionId) {
    hash = (hash * 31 + char.charCodeAt(0)) % 1000;
  }
  return 4700 + hash;
}

function buildDaemonScript(): string {
  return `
import { createServer } from 'node:http';
import { readFile, unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import readline from 'node:readline';

const configPath = process.argv[2];
const raw = await readFile(configPath, 'utf8');
const config = JSON.parse(raw);
try { await unlink(configPath); } catch {}

const child = spawn(config.command, config.args, {
  cwd: config.cwd,
  stdio: ['pipe', 'pipe', 'pipe'],
});

const rl = readline.createInterface({ input: child.stdout });
const errRl = readline.createInterface({ input: child.stderr });
const receivedNotifications = new Map();
const pendingNotifications = new Map();
const pendingResponses = new Map();
let initialized = false;
let currentThreadId = null;
let materialized = false;
let childExitError = null;
let activeRequest = null;

function serialize(message) {
  return JSON.stringify(message) + '\\n';
}

function capture(message) {
  if (activeRequest) {
    activeRequest.messages.push(message);
  }
}

function recordThread(message) {
  const result = message?.result;
  const params = message?.params;
  const fromResult = result?.thread?.id ?? null;
  const fromParams = params?.thread?.id ?? null;
  currentThreadId = fromResult ?? fromParams ?? currentThreadId;
}

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
    child.stdin.write(serialize({ id: requestId, error: { code: -32002, message: 'Host token refresh failed' } }));
    return;
  }

  const json = await response.json();
  child.stdin.write(serialize({
    id: requestId,
    result: {
      accessToken: json.accessToken,
      chatgptAccountId: json.accountId,
      chatgptPlanType: json.planType ?? null,
    },
  }));
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
      if (!queued.length) receivedNotifications.delete(method);
      resolve(next);
      return;
    }
    const existing = pendingNotifications.get(method) ?? [];
    existing.push(resolve);
    pendingNotifications.set(method, existing);
  });
}

async function sendMessage(message) {
  child.stdin.write(serialize(message));
  if (typeof message.id === 'number') {
    return waitForResponse(message.id);
  }
  return null;
}

rl.on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    capture({ method: 'stdout', params: { line } });
    return;
  }

  capture(msg);
  if (msg?.method === 'account/chatgptAuthTokens/refresh' && msg.id != null) {
    void refreshExternalTokens(msg.id, msg.params);
  }
  if (msg?.method === 'account/login/completed' || msg?.method === 'account/updated') {
    initialized = true;
  }
  if (msg?.method === 'thread/started' || msg?.method === 'thread/resumed' || (msg?.id === 2 && msg?.result?.thread?.id)) {
    recordThread(msg);
  }
  if (msg?.method === 'turn/completed') {
    materialized = true;
  }

  if (msg && typeof msg.id === 'number' && (Object.prototype.hasOwnProperty.call(msg, 'result') || Object.prototype.hasOwnProperty.call(msg, 'error'))) {
    const waiter = pendingResponses.get(msg.id);
    if (waiter) {
      pendingResponses.delete(msg.id);
      if (msg.error) waiter.reject(msg.error);
      else waiter.resolve(msg);
    }
  }

  if (msg && typeof msg.method === 'string') {
    const waiters = pendingNotifications.get(msg.method);
    if (waiters && waiters.length > 0) {
      pendingNotifications.delete(msg.method);
      for (const resolve of waiters) resolve(msg);
    } else {
      const queued = receivedNotifications.get(msg.method) ?? [];
      queued.push(msg);
      receivedNotifications.set(msg.method, queued);
    }
  }
});

errRl.on('line', (line) => {
  capture({ method: 'stderr', params: { line } });
});

child.on('error', (error) => {
  childExitError = error;
});

child.on('close', (code) => {
  if (code && code !== 0) {
    childExitError = new Error('Codex app-server process exited with code ' + code);
  }
});

const server = createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'GET' && req.url === '/health') {
    res.end(JSON.stringify({
      ok: !childExitError,
      initialized,
      threadId: currentThreadId,
      materialized,
      appServerPid: child.pid ?? null,
      error: childExitError ? String(childExitError.message ?? childExitError) : null,
    }));
    return;
  }

  if (req.method === 'POST' && req.url === '/shutdown') {
    try { child.kill('SIGTERM'); } catch {}
    res.end(JSON.stringify({ ok: true }));
    process.exit(0);
    return;
  }

  if (req.method === 'POST' && req.url === '/execute') {
    if (activeRequest) {
      res.statusCode = 409;
      res.end(JSON.stringify({ ok: false, code: 'daemon_busy', error: 'A turn is already in flight.', state: { initialized, threadId: currentThreadId, materialized, appServerPid: child.pid ?? null }, messages: [] }));
      return;
    }

    let body = '';
    for await (const chunk of req) body += chunk;
    const input = JSON.parse(body);
    activeRequest = { messages: [] };
    const timer = setTimeout(() => {
      activeRequest?.messages.push({ method: 'error', params: { message: 'Daemon timed out waiting for expected notifications.' } });
    }, input.timeoutMs ?? 60000);

    try {
      for (const message of input.messages) {
        await sendMessage(message);
      }
      for (const method of input.stopOnMethods ?? []) {
        await waitForNotification(method);
      }
      clearTimeout(timer);
      const response = {
        ok: !childExitError,
        messages: activeRequest.messages,
        state: {
          initialized,
          threadId: currentThreadId,
          materialized,
          appServerPid: child.pid ?? null,
        },
        error: childExitError ? String(childExitError.message ?? childExitError) : undefined,
      };
      activeRequest = null;
      res.end(JSON.stringify(response));
      return;
    } catch (error) {
      clearTimeout(timer);
      const response = {
        ok: false,
        code: 'daemon_execute_failed',
        error: String(error?.message ?? error ?? 'execute failed'),
        messages: activeRequest.messages,
        state: {
          initialized,
          threadId: currentThreadId,
          materialized,
          appServerPid: child.pid ?? null,
        },
      };
      activeRequest = null;
      res.statusCode = 500;
      res.end(JSON.stringify(response));
      return;
    }
  }

  res.statusCode = 404;
  res.end(JSON.stringify({ ok: false, error: 'not found' }));
});

server.listen(config.port, '127.0.0.1');
`;
}

function buildDaemonConfig(sessionId: string, config: SandboxCodexAppServerConfig, cwd: string, hostTokenService: HostTokenRuntimeConfig) {
  return JSON.stringify(
    {
      command: config.command,
      args: config.args,
      cwd,
      hostTokenService,
      port: getAiSessionDaemonPort(sessionId),
    },
    null,
    2,
  );
}

function getDaemonScriptPath(sessionId: string): string {
  return `${getDaemonRoot(sessionId)}/.codex-daemon.mjs`;
}

function getDaemonConfigPath(sessionId: string): string {
  return `${getDaemonRoot(sessionId)}/.codex-daemon-config.json`;
}

function getDaemonRequestPath(sessionId: string): string {
  return `${getDaemonRoot(sessionId)}/.codex-daemon-request.json`;
}

export async function ensureCodexAppServerDaemon(
  sandboxProvider: SandboxProvider,
  sessionId: string,
  config: SandboxCodexAppServerConfig,
  cwd: string,
  hostTokenService: HostTokenRuntimeConfig,
): Promise<void> {
  const root = getDaemonRoot(sessionId);
  const health = await sandboxProvider.execCommand(`curl -sf http://127.0.0.1:${getAiSessionDaemonPort(sessionId)}/health || true`);
  if (health.output.trim().includes('"ok":true')) {
    return;
  }

  await sandboxProvider.writeFiles([
    { path: getDaemonScriptPath(sessionId), content: buildDaemonScript() },
    { path: getDaemonConfigPath(sessionId), content: buildDaemonConfig(sessionId, config, cwd, hostTokenService) },
  ]);
  await sandboxProvider.execCommand(
    `cd ${JSON.stringify(root)} && nohup node .codex-daemon.mjs ./.codex-daemon-config.json > ./.codex-daemon.out 2>&1 &`,
  );
  const waitResult = await sandboxProvider.execCommand(
    `for i in 1 2 3 4 5 6 7 8 9 10; do curl -sf http://127.0.0.1:${getAiSessionDaemonPort(sessionId)}/health && exit 0; sleep 1; done; exit 1`,
  );
  if (waitResult.status !== 'completed') {
    const daemonOutput = await sandboxProvider.execCommand(
      `cd ${JSON.stringify(root)} && if [ -f ./.codex-daemon.out ]; then cat ./.codex-daemon.out; fi`,
    );
    throw new Error(
      `Failed to start long-lived Codex app-server daemon.${daemonOutput.output ? ` Daemon output: ${daemonOutput.output}` : ''}`,
    );
  }
}

export async function callCodexAppServerDaemon(
  sandboxProvider: SandboxProvider,
  sessionId: string,
  request: CodexAppServerDaemonRequest,
): Promise<CodexAppServerDaemonResponse> {
  await sandboxProvider.writeFiles([
    { path: getDaemonRequestPath(sessionId), content: JSON.stringify(request) },
  ]);
  const result = await sandboxProvider.execCommand(
    `cd ${JSON.stringify(getDaemonRoot(sessionId))} && curl -s -X POST -H "Content-Type: application/json" --data @./.codex-daemon-request.json http://127.0.0.1:${getAiSessionDaemonPort(sessionId)}/execute`,
  );
  if (!result.output.trim()) {
    throw new Error('Codex daemon returned an empty response.');
  }
  return JSON.parse(result.output) as CodexAppServerDaemonResponse;
}

export async function getCodexAppServerDaemonHealth(
  sandboxProvider: SandboxProvider,
  sessionId: string,
): Promise<CodexAppServerDaemonResponse['state'] | null> {
  const result = await sandboxProvider.execCommand(`curl -sf http://127.0.0.1:${getAiSessionDaemonPort(sessionId)}/health || true`);
  if (!result.output.trim()) {
    return null;
  }
  const parsed = JSON.parse(result.output) as { ok?: boolean; threadId?: string | null; initialized?: boolean; materialized?: boolean; appServerPid?: number | null };
  if (!parsed.ok) {
    return null;
  }
  return {
    initialized: Boolean(parsed.initialized),
    threadId: parsed.threadId ?? null,
    materialized: Boolean(parsed.materialized),
    appServerPid: parsed.appServerPid ?? null,
  };
}
