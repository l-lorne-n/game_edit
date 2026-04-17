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

export type CodexAppServerDaemonTurnPhase = 'submitted' | 'running' | 'completed' | 'failed';

export type CodexAppServerDaemonTurnRecord = {
  turnId: string;
  phase: CodexAppServerDaemonTurnPhase;
  submittedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  code: string | null;
  error: string | null;
  turnStatus: string | null;
  messages: JsonRpcMessage[];
  state: CodexAppServerDaemonResponse['state'];
};

export type CodexAppServerDaemonTurnSubmitResponse = {
  ok: boolean;
  deduplicated: boolean;
  turn: CodexAppServerDaemonTurnRecord;
  error?: string;
  code?: string;
};

type ErrorWithCode = Error & { code?: string; cause?: unknown };

export class CodexAppServerDaemonError extends Error {
  constructor(message: string, readonly code: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'CodexAppServerDaemonError';
  }
}

function getErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error) {
    return error.message || fallback;
  }
  if (typeof error === 'string' && error.trim()) {
    return error;
  }
  return fallback;
}

function getErrorCode(error: unknown, fallback: string): string {
  if (error instanceof CodexAppServerDaemonError) {
    return error.code;
  }
  if (error instanceof Error && typeof (error as ErrorWithCode).code === 'string' && (error as ErrorWithCode).code) {
    return (error as ErrorWithCode).code as string;
  }
  return fallback;
}

function classifyDaemonRequestFailure(status: 'running' | 'completed' | 'failed' | 'cancelled' | 'detached', output: string): CodexAppServerDaemonError {
  const trimmed = output.trim();
  const lowered = trimmed.toLowerCase();
  const code = lowered.includes('timed out') || lowered.includes('timeout')
    ? 'codex_daemon_request_timeout'
    : 'codex_daemon_request_failed';
  return new CodexAppServerDaemonError(trimmed || `Codex daemon request ended with status ${status}.`, code);
}

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
  return String.raw`
import { createServer } from 'node:http';
import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import readline from 'node:readline';

const REFRESH_TIMEOUT_MS = 15000;

const configPath = process.argv[2];
const raw = await readFile(configPath, 'utf8');
const config = JSON.parse(raw);
try { await unlink(configPath); } catch {}

const turnDir = join(config.cwd, '.codex-turns');
await mkdir(turnDir, { recursive: true });

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
let activeTurn = null;

function serialize(message) {
  return JSON.stringify(message) + '\n';
}

function toErrorMessage(error, fallback) {
  if (error && typeof error.message === 'string' && error.message.trim()) {
    return error.message;
  }
  if (typeof error === 'string' && error.trim()) {
    return error;
  }
  return fallback;
}

function toErrorCode(error, fallback) {
  if (error && typeof error.code === 'string' && error.code.trim()) {
    return error.code;
  }
  return fallback;
}

function getState() {
  return {
    initialized,
    threadId: currentThreadId,
    materialized,
    appServerPid: child.pid ?? null,
  };
}

function summarizeTurn(turn) {
  return {
    turnId: turn.turnId,
    phase: turn.phase,
    submittedAt: turn.submittedAt,
    startedAt: turn.startedAt ?? null,
    completedAt: turn.completedAt ?? null,
    code: turn.code ?? null,
    error: turn.error ?? null,
    turnStatus: turn.turnStatus ?? null,
    messages: Array.isArray(turn.messages) ? turn.messages : [],
    state: turn.state ?? getState(),
  };
}

async function persistTurn(turn) {
  await writeFile(join(turnDir, turn.turnId + '.json'), JSON.stringify(summarizeTurn(turn), null, 2));
}

async function loadTurn(turnId) {
  try {
    const rawTurn = await readFile(join(turnDir, turnId + '.json'), 'utf8');
    return JSON.parse(rawTurn);
  } catch {
    return null;
  }
}

async function recoverDanglingTurns() {
  const entries = await readdir(turnDir).catch(() => []);
  await Promise.all(entries.filter(entry => entry.endsWith('.json')).map(async entry => {
    const turnId = entry.slice(0, -5);
    const turn = await loadTurn(turnId);
    if (!turn || !['submitted', 'running'].includes(turn.phase)) {
      return;
    }
    turn.phase = 'failed';
    turn.code = 'daemon_restarted_before_turn_completed';
    turn.error = 'Codex daemon restarted before the turn completed.';
    turn.completedAt = new Date().toISOString();
    turn.state = getState();
    await persistTurn(turn);
  }));
}

await recoverDanglingTurns();

function rejectPending(error) {
  for (const waiter of pendingResponses.values()) {
    waiter.reject(error);
  }
  pendingResponses.clear();
  for (const waiters of pendingNotifications.values()) {
    for (const resolve of waiters) {
      resolve({ method: 'daemon/error', params: { code: toErrorCode(error, 'daemon_execute_failed'), message: toErrorMessage(error, 'Codex daemon request stopped unexpectedly.') } });
    }
  }
  pendingNotifications.clear();
}

function captureStructuredError(code, message, details) {
  capture({
    method: 'daemon/error',
    params: {
      code,
      message,
      ...(details ? { details } : {}),
    },
  });
}

function failActiveRequest(code, message) {
  const error = new Error(message);
  error.code = code;
  childExitError = error;
  captureStructuredError(code, message, null);
  rejectPending(error);
  try {
    child.kill('SIGTERM');
  } catch {}
  return error;
}

function capture(message) {
  if (activeRequest) {
    activeRequest.messages.push(message);
  }
  if (activeTurn) {
    activeTurn.messages.push(message);
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
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REFRESH_TIMEOUT_MS);
  try {
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
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      const message = text || 'Host token refresh failed';
      captureStructuredError('daemon_external_token_refresh_failed', message, { status: response.status });
      child.stdin.write(serialize({
        id: requestId,
        error: {
          code: -32002,
          message,
          data: {
            code: 'daemon_external_token_refresh_failed',
            status: response.status,
          },
        },
      }));
      return;
    }

    const json = await response.json();
    if (!json?.accessToken) {
      throw Object.assign(new Error('Host token refresh response did not include an access token.'), {
        code: 'daemon_external_token_refresh_invalid',
      });
    }

    child.stdin.write(serialize({
      id: requestId,
      result: {
        accessToken: json.accessToken,
        chatgptAccountId: json.accountId,
        chatgptPlanType: json.planType ?? null,
      },
    }));
  } catch (error) {
    const code = error?.name === 'AbortError'
      ? 'daemon_external_token_refresh_timeout'
      : toErrorCode(error, 'daemon_external_token_refresh_failed');
    const message = error?.name === 'AbortError'
      ? 'Host token refresh timed out.'
      : toErrorMessage(error, 'Host token refresh failed.');
    captureStructuredError(code, message, null);
    child.stdin.write(serialize({
      id: requestId,
      error: {
        code: -32002,
        message,
        data: { code },
      },
    }));
  } finally {
    clearTimeout(timeout);
  }
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

async function runTurn(turn, input) {
  activeTurn = turn;
  turn.phase = 'running';
  turn.startedAt = new Date().toISOString();
  turn.state = getState();
  await persistTurn(turn);

  const timer = setTimeout(() => {
    const error = new Error('Daemon timed out waiting for expected notifications.');
    error.code = 'daemon_execute_timeout';
    rejectPending(error);
  }, input.timeoutMs ?? 300000);

  try {
    for (const message of input.messages) {
      await sendMessage(message);
    }
    for (const method of input.stopOnMethods ?? []) {
      await waitForNotification(method);
    }
    clearTimeout(timer);
    turn.phase = 'completed';
    turn.completedAt = new Date().toISOString();
    turn.state = getState();
    await persistTurn(turn);
  } catch (error) {
    clearTimeout(timer);
    turn.phase = 'failed';
    turn.completedAt = new Date().toISOString();
    turn.code = toErrorCode(error, 'daemon_execute_failed');
    turn.error = toErrorMessage(error, 'execute failed');
    turn.state = getState();
    await persistTurn(turn);
  } finally {
    activeTurn = null;
  }
}

rl.on('line', line => {
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

errRl.on('line', line => {
  capture({ method: 'stderr', params: { line } });
});

child.on('error', error => {
  childExitError = error;
  rejectPending(error);
});

child.on('close', code => {
  if (code && code !== 0) {
    childExitError = new Error('Codex app-server process exited with code ' + code);
  }
  if (childExitError) {
    rejectPending(childExitError);
  }
});

const server = createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'GET' && req.url === '/health') {
    res.end(JSON.stringify({
      ok: !childExitError,
      ...getState(),
      activeTurnId: activeTurn?.turnId ?? null,
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
    if (activeRequest || activeTurn) {
      res.statusCode = 409;
      res.end(JSON.stringify({ ok: false, code: 'daemon_busy', error: 'A turn is already in flight.', state: getState(), messages: [] }));
      return;
    }

    let body = '';
    for await (const chunk of req) body += chunk;
    const input = JSON.parse(body);
    activeRequest = { messages: [] };
    const timer = setTimeout(() => {
      failActiveRequest('daemon_execute_timeout', 'Daemon timed out waiting for expected notifications.');
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
        state: getState(),
        error: childExitError ? String(childExitError.message ?? childExitError) : undefined,
      };
      activeRequest = null;
      res.end(JSON.stringify(response));
      return;
    } catch (error) {
      clearTimeout(timer);
      const code = toErrorCode(error, 'daemon_execute_failed');
      const response = {
        ok: false,
        code,
        error: toErrorMessage(error, 'execute failed'),
        messages: activeRequest.messages,
        state: getState(),
      };
      activeRequest = null;
      res.statusCode = code === 'daemon_execute_timeout' ? 504 : 500;
      res.end(JSON.stringify(response));
      return;
    }
  }

  if (req.method === 'POST' && req.url === '/turns/submit') {
    let body = '';
    for await (const chunk of req) body += chunk;
    const input = JSON.parse(body);
    const persisted = await loadTurn(input.turnId);
    if (persisted) {
      res.end(JSON.stringify({ ok: true, deduplicated: true, turn: persisted }));
      return;
    }
    if (activeRequest || (activeTurn && activeTurn.turnId !== input.turnId)) {
      res.statusCode = 409;
      res.end(JSON.stringify({ ok: false, code: 'daemon_busy', error: 'A turn is already in flight.', turn: activeTurn ? summarizeTurn(activeTurn) : null }));
      return;
    }
    const turn = {
      turnId: input.turnId,
      phase: 'submitted',
      submittedAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
      code: null,
      error: null,
      turnStatus: null,
      messages: [],
      state: getState(),
    };
    await persistTurn(turn);
    void runTurn(turn, input);
    res.end(JSON.stringify({ ok: true, deduplicated: false, turn: summarizeTurn(turn) }));
    return;
  }

  const turnStatusMatch = req.url?.match(/^\/turns\/([^/]+)\/status$/);
  if (req.method === 'GET' && turnStatusMatch) {
    const turn = await loadTurn(decodeURIComponent(turnStatusMatch[1]));
    if (!turn) {
      res.statusCode = 404;
      res.end(JSON.stringify({ ok: false, code: 'turn_not_found', error: 'Turn not found.' }));
      return;
    }
    res.end(JSON.stringify({ ok: true, turn }));
    return;
  }

  const turnResultMatch = req.url?.match(/^\/turns\/([^/]+)\/result$/);
  if (req.method === 'GET' && turnResultMatch) {
    const turn = await loadTurn(decodeURIComponent(turnResultMatch[1]));
    if (!turn) {
      res.statusCode = 404;
      res.end(JSON.stringify({ ok: false, code: 'turn_not_found', error: 'Turn not found.' }));
      return;
    }
    if (!['completed', 'failed'].includes(turn.phase)) {
      res.statusCode = 409;
      res.end(JSON.stringify({ ok: false, code: 'turn_not_ready', error: 'Turn has not completed yet.', turn }));
      return;
    }
    res.end(JSON.stringify({ ok: true, turn }));
    return;
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

  if (health.output.trim()) {
    await sandboxProvider.execCommand(`curl -s -X POST http://127.0.0.1:${getAiSessionDaemonPort(sessionId)}/shutdown || true`);
  }

  await sandboxProvider.writeFiles([
    { path: getDaemonScriptPath(sessionId), content: buildDaemonScript() },
    { path: getDaemonConfigPath(sessionId), content: buildDaemonConfig(sessionId, config, cwd, hostTokenService) },
  ]);
  await sandboxProvider.execCommand(`cd ${JSON.stringify(root)} && nohup node .codex-daemon.mjs ./.codex-daemon-config.json > ./.codex-daemon.out 2>&1 &`);
  const waitResult = await sandboxProvider.execCommand(`for i in 1 2 3 4 5 6 7 8 9 10; do out=$(curl -s http://127.0.0.1:${getAiSessionDaemonPort(sessionId)}/health || true); printf "%s" "$out" | grep -q '"ok":true' && exit 0; sleep 1; done; exit 1`);
  if (waitResult.status !== 'completed') {
    const daemonOutput = await sandboxProvider.execCommand(`cd ${JSON.stringify(root)} && if [ -f ./.codex-daemon.out ]; then cat ./.codex-daemon.out; fi`);
    throw new Error(`Failed to start long-lived Codex app-server daemon.${daemonOutput.output ? ` Daemon output: ${daemonOutput.output}` : ''}`);
  }
}

export async function callCodexAppServerDaemon(
  sandboxProvider: SandboxProvider,
  sessionId: string,
  request: CodexAppServerDaemonRequest,
): Promise<CodexAppServerDaemonResponse> {
  await sandboxProvider.writeFiles([{ path: getDaemonRequestPath(sessionId), content: JSON.stringify(request) }]);
  let result;
  try {
    result = await sandboxProvider.execCommand(`cd ${JSON.stringify(getDaemonRoot(sessionId))} && curl -sS -X POST -H "Content-Type: application/json" --data @./.codex-daemon-request.json http://127.0.0.1:${getAiSessionDaemonPort(sessionId)}/execute`);
  } catch (error) {
    throw new CodexAppServerDaemonError(getErrorMessage(error, 'Codex daemon request failed.'), getErrorCode(error, 'codex_daemon_request_failed'), { cause: error });
  }
  if (result.status !== 'completed') {
    throw classifyDaemonRequestFailure(result.status, result.output);
  }
  if (!result.output.trim()) {
    throw new CodexAppServerDaemonError('Codex daemon returned an empty response.', 'codex_daemon_empty_response');
  }
  try {
    return JSON.parse(result.output) as CodexAppServerDaemonResponse;
  } catch (error) {
    throw new CodexAppServerDaemonError('Codex daemon returned invalid JSON.', 'codex_daemon_invalid_response', { cause: error });
  }
}

async function readDaemonJson<T>(sandboxProvider: SandboxProvider, command: string): Promise<T> {
  const result = await sandboxProvider.execCommand(command);
  if (result.status !== 'completed') {
    throw classifyDaemonRequestFailure(result.status, result.output);
  }
  if (!result.output.trim()) {
    throw new CodexAppServerDaemonError('Codex daemon returned an empty response.', 'codex_daemon_empty_response');
  }
  try {
    return JSON.parse(result.output) as T;
  } catch (error) {
    throw new CodexAppServerDaemonError('Codex daemon returned invalid JSON.', 'codex_daemon_invalid_response', { cause: error });
  }
}

export async function submitCodexAppServerDaemonTurn(
  sandboxProvider: SandboxProvider,
  sessionId: string,
  request: CodexAppServerDaemonRequest & { turnId: string },
): Promise<CodexAppServerDaemonTurnSubmitResponse> {
  await sandboxProvider.writeFiles([{ path: getDaemonRequestPath(sessionId), content: JSON.stringify(request) }]);
  return readDaemonJson<CodexAppServerDaemonTurnSubmitResponse>(
    sandboxProvider,
    `cd ${JSON.stringify(getDaemonRoot(sessionId))} && curl -sS -X POST -H "Content-Type: application/json" --data @./.codex-daemon-request.json http://127.0.0.1:${getAiSessionDaemonPort(sessionId)}/turns/submit`,
  );
}

export async function getCodexAppServerDaemonTurnStatus(
  sandboxProvider: SandboxProvider,
  sessionId: string,
  turnId: string,
): Promise<CodexAppServerDaemonTurnRecord | null> {
  const encodedTurnId = encodeURIComponent(turnId);
  const response = await readDaemonJson<{ ok: boolean; turn?: CodexAppServerDaemonTurnRecord; code?: string }>(
    sandboxProvider,
    `curl -sS http://127.0.0.1:${getAiSessionDaemonPort(sessionId)}/turns/${encodedTurnId}/status`,
  ).catch(error => {
    if (error instanceof CodexAppServerDaemonError && error.code === 'codex_daemon_empty_response') {
      return { ok: false };
    }
    throw error;
  });
  if (!('turn' in response) || !response.ok || !response.turn) {
    return null;
  }
  return response.turn;
}

export async function getCodexAppServerDaemonTurnResult(
  sandboxProvider: SandboxProvider,
  sessionId: string,
  turnId: string,
): Promise<CodexAppServerDaemonTurnRecord | null> {
  const encodedTurnId = encodeURIComponent(turnId);
  const response = await readDaemonJson<{ ok: boolean; turn?: CodexAppServerDaemonTurnRecord; code?: string }>(
    sandboxProvider,
    `curl -sS http://127.0.0.1:${getAiSessionDaemonPort(sessionId)}/turns/${encodedTurnId}/result`,
  ).catch(error => {
    if (error instanceof CodexAppServerDaemonError && error.code === 'codex_daemon_empty_response') {
      return { ok: false };
    }
    throw error;
  });
  if (!('turn' in response) || !response.ok || !response.turn) {
    return null;
  }
  return response.turn;
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
