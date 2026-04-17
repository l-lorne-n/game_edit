import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getAiSessionSupervisor, resetAiSessionSupervisor } from '@/lib/ai-sessions/supervisor';
import { markAiSessionTransportReady, startAiSessionTransportInit } from '@/lib/ai-sessions/transport-runtime';
import { createTemplatePackage } from '@/lib/package/template';
import type {
  AiSessionCheckpointRecord,
  AiSessionEventRecord,
  AiSessionRecord,
  AiSessionRepository,
  AiSessionTurnRecord,
  AiSessionTransportLogEntry,
  CreateAiSessionCheckpointInput,
  CreateAiSessionEventInput,
  CreateAiSessionTurnInput,
  UpdateAiSessionInput,
  UpdateAiSessionTurnInput,
} from '@/lib/ai-sessions/types';

const {
  sandboxProviderMock,
  hostTokenRefreshMock,
  ensureDaemonMock,
  callDaemonMock,
  getDaemonHealthMock,
  submitTurnMock,
  getTurnStatusMock,
  getTurnResultMock,
} = vi.hoisted(() => ({
  sandboxProviderMock: {
    getReadiness: vi.fn(),
    getBoxId: vi.fn(),
    ensureCodexRuntime: vi.fn(),
    getDefaultCodexAppServerConfig: vi.fn(),
    writeFiles: vi.fn(),
    readFile: vi.fn(),
    execCommand: vi.fn(),
    startCodexAppServer: vi.fn(),
  },
  hostTokenRefreshMock: vi.fn(),
  ensureDaemonMock: vi.fn(),
  callDaemonMock: vi.fn(),
  getDaemonHealthMock: vi.fn(),
  submitTurnMock: vi.fn(),
  getTurnStatusMock: vi.fn(),
  getTurnResultMock: vi.fn(),
}));

vi.mock('@/lib/sandbox', () => ({
  getSandboxProvider: () => sandboxProviderMock,
}));

vi.mock('@/lib/projects/service', () => ({
  createProjectService: () => ({
    getProject: vi.fn(),
    readProjectFile: vi.fn(),
    saveGeneratedPackage: vi.fn(),
  }),
}));

vi.mock('@/lib/host-tokens/client', () => ({
  HostTokenServiceClient: {
    fromEnv: () => ({
      refresh: hostTokenRefreshMock,
      getBaseUrl: () => 'http://host-token-service.local',
      getApiKey: () => 'host-token-key',
    }),
  },
}));

vi.mock('@/lib/ai-sessions/app-server-daemon', () => ({
  ensureCodexAppServerDaemon: ensureDaemonMock,
  callCodexAppServerDaemon: callDaemonMock,
  getCodexAppServerDaemonHealth: getDaemonHealthMock,
  submitCodexAppServerDaemonTurn: submitTurnMock,
  getCodexAppServerDaemonTurnStatus: getTurnStatusMock,
  getCodexAppServerDaemonTurnResult: getTurnResultMock,
}));

import { AiSessionTransportNotImplementedError, createAiSessionService } from '@/lib/ai-sessions/service';

class InMemoryAiSessionRepository implements AiSessionRepository {
  private readonly sessions = new Map<string, AiSessionRecord>();
  private readonly events: AiSessionEventRecord[] = [];
  private readonly checkpoints: AiSessionCheckpointRecord[] = [];
  private readonly transportLogs: Array<{ sessionId: string; entry: AiSessionTransportLogEntry }> = [];
  private readonly turns = new Map<string, AiSessionTurnRecord>();

  async createSession(input: AiSessionRecord): Promise<AiSessionRecord> {
    this.sessions.set(input.id, structuredClone(input));
    return structuredClone(input);
  }

  async listProjectSessions(projectId: string): Promise<AiSessionRecord[]> {
    return [...this.sessions.values()].filter(session => session.projectId === projectId).map(session => structuredClone(session));
  }

  async getSession(sessionId: string): Promise<AiSessionRecord | null> {
    const session = this.sessions.get(sessionId);
    return session ? structuredClone(session) : null;
  }

  async updateSession(sessionId: string, input: UpdateAiSessionInput): Promise<AiSessionRecord> {
    const current = this.sessions.get(sessionId);
    if (!current) {
      throw new Error(`Missing session ${sessionId}`);
    }
    const next: AiSessionRecord = {
      ...current,
      ...input,
      updatedAt: new Date().toISOString(),
    };
    this.sessions.set(sessionId, next);
    return structuredClone(next);
  }

  async appendEvent(input: CreateAiSessionEventInput): Promise<AiSessionEventRecord> {
    const event: AiSessionEventRecord = {
      id: `evt-${this.events.length + 1}`,
      sessionId: input.sessionId,
      type: input.type,
      payload: input.payload ?? {},
      createdAt: new Date().toISOString(),
    };
    this.events.push(event);
    return structuredClone(event);
  }

  async listEvents(sessionId: string): Promise<AiSessionEventRecord[]> {
    return this.events.filter(event => event.sessionId === sessionId).map(event => structuredClone(event));
  }

  async appendTransportLog(sessionId: string, entry: AiSessionTransportLogEntry): Promise<AiSessionTransportLogEntry> {
    this.transportLogs.push({ sessionId, entry });
    return structuredClone(entry);
  }

  async listTransportLogs(sessionId: string): Promise<AiSessionTransportLogEntry[]> {
    return this.transportLogs.filter(item => item.sessionId === sessionId).map(item => structuredClone(item.entry));
  }

  async findCheckpointByIdempotencyKey(sessionId: string, idempotencyKey: string): Promise<AiSessionCheckpointRecord | null> {
    const checkpoint = this.checkpoints.find(item => item.sessionId === sessionId && item.idempotencyKey === idempotencyKey);
    return checkpoint ? structuredClone(checkpoint) : null;
  }

  async createCheckpoint(input: CreateAiSessionCheckpointInput): Promise<AiSessionCheckpointRecord> {
    const checkpoint: AiSessionCheckpointRecord = {
      id: `chk-${this.checkpoints.length + 1}`,
      sessionId: input.sessionId,
      idempotencyKey: input.idempotencyKey,
      baseVersion: input.baseVersion,
      newVersion: input.newVersion ?? null,
      status: input.status ?? 'pending',
      manifest: input.manifest ?? {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.checkpoints.push(checkpoint);
    return structuredClone(checkpoint);
  }

  async createTurn(input: CreateAiSessionTurnInput): Promise<AiSessionTurnRecord> {
    const turn: AiSessionTurnRecord = {
      ...input,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.turns.set(turn.id, turn);
    return structuredClone(turn);
  }

  async getTurn(turnId: string): Promise<AiSessionTurnRecord | null> {
    const turn = this.turns.get(turnId);
    return turn ? structuredClone(turn) : null;
  }

  async listSessionTurns(sessionId: string): Promise<AiSessionTurnRecord[]> {
    return [...this.turns.values()].filter(turn => turn.sessionId === sessionId).map(turn => structuredClone(turn));
  }

  async findActiveTurn(sessionId: string): Promise<AiSessionTurnRecord | null> {
    const turns = [...this.turns.values()].filter(turn => turn.sessionId === sessionId);
    const active = [...turns].reverse().find((turn: AiSessionTurnRecord) => ['submitted', 'running', 'awaiting_artifact'].includes(turn.status));
    return active ? structuredClone(active) : null;
  }

  async findTurnByRequestFingerprint(sessionId: string, requestFingerprint: string): Promise<AiSessionTurnRecord | null> {
    const turns = [...this.turns.values()].filter(turn => turn.sessionId === sessionId && turn.requestFingerprint === requestFingerprint);
    const found = turns.at(-1) ?? null;
    return found ? structuredClone(found) : null;
  }

  async updateTurn(turnId: string, input: UpdateAiSessionTurnInput): Promise<AiSessionTurnRecord> {
    const current = this.turns.get(turnId);
    if (!current) {
      throw new Error(`Missing turn ${turnId}`);
    }
    const next: AiSessionTurnRecord = {
      ...current,
      ...input,
      updatedAt: new Date().toISOString(),
    };
    this.turns.set(turnId, next);
    return structuredClone(next);
  }
}

async function createReadySession(repository: InMemoryAiSessionRepository, sessionId: string): Promise<AiSessionRecord> {
  const nowIso = new Date().toISOString();
  const session = await repository.createSession({
    id: sessionId,
    projectId: 'project-transport-hardening',
    ownerId: 'owner-1',
    baseVersion: 1,
    activeWorkspaceVersion: 1,
    latestWorkspaceVersion: 1,
    status: 'ready',
    authMode: 'chatgptAuthTokens',
    authState: 'ready',
    boxId: 'box-1',
    codexHomeKey: `sessions/${sessionId}`,
    boxStatus: 'ready',
    appServerStatus: 'healthy',
    daemonStatus: 'healthy',
    appServerThreadId: 'thr-1',
    threadMaterializedAt: nowIso,
    transportPhase: 'ready',
    transportInitializedAt: nowIso,
    transportLastActivityAt: nowIso,
    transportIdleDeadlineAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    transportLastErrorCode: null,
    transportLastErrorMessage: null,
    continuityState: 'resumable',
    resumeEligibility: 'resumable',
    recoveryOutcome: 'none',
    supervisorInstanceId: null,
    supervisorLeaseEpoch: 0,
    lastSupervisorHeartbeatAt: null,
    lastFailureCode: null,
    currentLeaseToken: `lease-${sessionId}`,
    leaseHeartbeatAt: nowIso,
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    lastCheckpointVersion: null,
    lastCheckpointId: null,
    revokedAt: null,
    createdAt: nowIso,
    updatedAt: nowIso,
  });

  startAiSessionTransportInit(session.id);
  markAiSessionTransportReady(session.id, 'thr-1');
  const runtime = getAiSessionSupervisor().beginRuntime(session);
  return repository.updateSession(session.id, {
    supervisorInstanceId: runtime.supervisorInstanceId,
    supervisorLeaseEpoch: runtime.supervisorLeaseEpoch,
    lastSupervisorHeartbeatAt: runtime.lastHeartbeatAt,
  });
}

describe('ai session service transport hardening', () => {
  let repository: InMemoryAiSessionRepository;

  beforeEach(() => {
    repository = new InMemoryAiSessionRepository();
    resetAiSessionSupervisor();
    vi.clearAllMocks();

    sandboxProviderMock.getReadiness.mockReturnValue({
      supported: true,
      configured: true,
      provider: 'upstash-box',
      reason: null,
    });
    sandboxProviderMock.getBoxId.mockReturnValue('box-1');
    sandboxProviderMock.ensureCodexRuntime.mockResolvedValue({
      ready: true,
      binaryPath: '/bin/codex',
      installedNow: false,
      version: '1.0.0',
      reason: null,
      platform: 'linux x86_64',
      assetName: 'codex-x86_64-unknown-linux-musl.tar.gz',
    });
    sandboxProviderMock.getDefaultCodexAppServerConfig.mockReturnValue({
      command: '/bin/codex',
      args: ['app-server'],
      port: 4317,
    });
    const durablePkg = createTemplatePackage('Durable Demo');
    sandboxProviderMock.readFile.mockReset();
    sandboxProviderMock.readFile.mockImplementation(async (path: string) => {
      if (path.endsWith('manifest.json')) {
        return durablePkg.manifestJson;
      }
      if (path.endsWith('index.html')) {
        return durablePkg.indexHtml;
      }
      if (path.endsWith('game.js')) {
        return durablePkg.gameJs;
      }
      return durablePkg.styleCss;
    });
    sandboxProviderMock.writeFiles.mockResolvedValue(undefined);

    hostTokenRefreshMock.mockResolvedValue({
      accessToken: 'access-1',
      accountId: 'acct-1',
      expiresAt: Date.now() + 3600_000,
      planType: 'plus',
      sessionId: 'host-session-1',
      idToken: 'id-1',
    });

    ensureDaemonMock.mockResolvedValue(undefined);
    getDaemonHealthMock.mockResolvedValue({
      initialized: true,
      threadId: 'thr-1',
      materialized: true,
      appServerPid: 123,
    });
    submitTurnMock.mockImplementation(async (_sandbox: unknown, _sessionId: string, request: { turnId: string }) => ({
      ok: true,
      deduplicated: false,
      turn: {
        turnId: request.turnId,
        phase: 'running',
        submittedAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
        completedAt: null,
        code: null,
        error: null,
        turnStatus: null,
        messages: [],
        state: {
          initialized: true,
          threadId: 'thr-1',
          materialized: true,
          appServerPid: 123,
        },
      },
    }));
    getTurnStatusMock.mockResolvedValue(null);
    getTurnResultMock.mockResolvedValue(null);
  });

  afterEach(() => {
    resetAiSessionSupervisor();
  });

  it('deduplicates duplicate active submits by persisted fingerprint', async () => {
    const service = createAiSessionService(repository);
    await createReadySession(repository, 'sess-dedup');

    getTurnStatusMock.mockResolvedValue({
      turnId: 'placeholder',
      phase: 'running',
      submittedAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      completedAt: null,
      code: null,
      error: null,
      turnStatus: null,
      messages: [],
      state: {
        initialized: true,
        threadId: 'thr-1',
        materialized: true,
        appServerPid: 123,
      },
    });

    const first = await service.submitMessageTurn('sess-dedup', {
      mode: 'create',
      requestText: 'make a maze game',
    });
    const second = await service.submitMessageTurn('sess-dedup', {
      mode: 'create',
      requestText: 'make a maze game',
    });

    expect(first.deduplicated).toBe(false);
    expect(second.deduplicated).toBe(true);
    expect(second.turnId).toBe(first.turnId);
    expect(submitTurnMock).toHaveBeenCalledTimes(1);
  });

  it('gates result completion on durable workspace artifacts and preserves terminal diagnostics', async () => {
    const service = createAiSessionService(repository);
    await createReadySession(repository, 'sess-durable-gating');

    const submitted = await service.submitMessageTurn('sess-durable-gating', {
      mode: 'create',
      requestText: 'make a maze game',
    });

    getTurnStatusMock.mockResolvedValue({
      turnId: submitted.turnId,
      phase: 'completed',
      submittedAt: submitted.acceptedAt,
      startedAt: submitted.acceptedAt,
      completedAt: new Date().toISOString(),
      code: null,
      error: null,
      turnStatus: 'completed',
      messages: [
        { method: 'item/agentMessage/delta', params: { delta: 'done' } },
        { method: 'turn/completed', params: { turn: { status: 'completed' } } },
      ],
      state: {
        initialized: true,
        threadId: 'thr-1',
        materialized: true,
        appServerPid: 123,
      },
    });
    getTurnResultMock.mockResolvedValue({
      turnId: submitted.turnId,
      phase: 'completed',
      submittedAt: submitted.acceptedAt,
      startedAt: submitted.acceptedAt,
      completedAt: new Date().toISOString(),
      code: null,
      error: null,
      turnStatus: 'completed',
      messages: [
        { method: 'item/agentMessage/delta', params: { delta: 'done' } },
        { method: 'turn/completed', params: { turn: { status: 'completed' } } },
      ],
      state: {
        initialized: true,
        threadId: 'thr-1',
        materialized: true,
        appServerPid: 123,
      },
    });
    sandboxProviderMock.readFile.mockRejectedValueOnce(new Error('fetch failed other side closed'));

    const status = await service.getMessageTurnStatus('sess-durable-gating', submitted.turnId);

    expect(status.status).toBe('awaiting_artifact');
    expect(status.failureCode).toBeNull();

    sandboxProviderMock.readFile.mockImplementation(async (path: string) => (path.endsWith('manifest.json') ? '{}' : '// file'));
    const result = await service.getMessageTurnResult('sess-durable-gating', submitted.turnId);

    expect(result.artifactState).not.toBe('pending');
    expect(result.agentText).toBe('done');
    expect(['completed', 'failed']).toContain(result.finalOutcome);

    const persistedTurn = await repository.getTurn(submitted.turnId);
    expect(persistedTurn?.diagnostics.transportLogsPersistedAt).toBeTruthy();
  });

  it('preserves daemon execute timeout classification through executeMessage', async () => {
    const service = createAiSessionService(repository);
    await createReadySession(repository, 'sess-daemon-timeout');

    getTurnStatusMock.mockResolvedValue({
      turnId: 'unused',
      phase: 'failed',
      submittedAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      code: 'daemon_execute_timeout',
      error: 'Daemon timed out waiting for expected notifications.',
      turnStatus: null,
      messages: [],
      state: {
        initialized: true,
        threadId: 'thr-1',
        materialized: true,
        appServerPid: 123,
      },
    });
    getTurnResultMock.mockResolvedValue({
      turnId: 'unused',
      phase: 'failed',
      submittedAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      code: 'daemon_execute_timeout',
      error: 'Daemon timed out waiting for expected notifications.',
      turnStatus: null,
      messages: [],
      state: {
        initialized: true,
        threadId: 'thr-1',
        materialized: true,
        appServerPid: 123,
      },
    });

    const rejection = service.executeMessage('sess-daemon-timeout', {
      mode: 'create',
      requestText: 'make a maze game',
    });

    await expect(rejection).rejects.toMatchObject({
      code: 'message_transport_not_implemented',
      reason: 'daemon_execute_timeout',
    });

    const updated = await repository.getSession('sess-daemon-timeout');
    expect(updated?.lastFailureCode).toBe('daemon_execute_timeout');
    expect(updated?.transportLastErrorCode).toBe('daemon_execute_timeout');
  });

  it('preserves daemon refresh failure classification through executeMessage', async () => {
    const service = createAiSessionService(repository);
    await createReadySession(repository, 'sess-refresh-failure');

    getTurnStatusMock.mockResolvedValue({
      turnId: 'unused',
      phase: 'failed',
      submittedAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      code: 'daemon_external_token_refresh_failed',
      error: 'Host token refresh failed',
      messages: [
        {
          id: 7,
          error: {
            message: 'Host token refresh failed',
            data: { code: 'daemon_external_token_refresh_failed' },
          },
        },
      ],
      state: {
        initialized: true,
        threadId: 'thr-1',
        materialized: true,
        appServerPid: 123,
      },
    });
    getTurnResultMock.mockResolvedValue({
      turnId: 'unused',
      phase: 'failed',
      submittedAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      code: 'daemon_external_token_refresh_failed',
      error: 'Host token refresh failed',
      turnStatus: null,
      messages: [
        {
          id: 7,
          error: {
            message: 'Host token refresh failed',
            data: { code: 'daemon_external_token_refresh_failed' },
          },
        },
      ],
      state: {
        initialized: true,
        threadId: 'thr-1',
        materialized: true,
        appServerPid: 123,
      },
    });

    const rejection = service.executeMessage('sess-refresh-failure', {
      mode: 'create',
      requestText: 'make a tower defense game',
    });

    await expect(rejection).rejects.toBeInstanceOf(AiSessionTransportNotImplementedError);
    await expect(rejection).rejects.toMatchObject({
      reason: 'daemon_external_token_refresh_failed',
    });

    const updated = await repository.getSession('sess-refresh-failure');
    expect(updated?.lastFailureCode).toBe('daemon_external_token_refresh_failed');
    expect(updated?.transportLastErrorCode).toBe('daemon_external_token_refresh_failed');
  });

  it('refreshes host binding on submit without changing transport bootstrap semantics', async () => {
    const service = createAiSessionService(repository);
    await createReadySession(repository, 'sess-host-binding');

    await service.submitMessageTurn('sess-host-binding', {
      mode: 'create',
      requestText: 'make a card game',
    });

    expect(hostTokenRefreshMock).toHaveBeenCalledWith({ sessionId: 'sess-host-binding', reason: 'unauthorized' });
    expect(submitTurnMock).toHaveBeenCalledTimes(1);
  });
});
