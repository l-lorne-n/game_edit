import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockAiSessionService = {
  createSession: vi.fn(),
  getSession: vi.fn(),
  getTransportSnapshot: vi.fn(),
  listTransportLogs: vi.fn(),
  initializeTransport: vi.fn(),
  listProjectSessions: vi.fn(),
  listEvents: vi.fn(),
  listWorkspaceVersions: vi.fn(),
  getWorkspaceVersionPayload: vi.fn(),
  bootstrapSession: vi.fn(),
  executeMessage: vi.fn(),
  checkpointSession: vi.fn(),
  revokeSession: vi.fn(),
};

const mockProjectService = {
  getProject: vi.fn(),
};

vi.mock('@/lib/ai-sessions/service', () => ({
  AiSessionConflictError: class AiSessionConflictError extends Error {
    readonly code = 'single_writer_conflict';
  },
  AiSessionMessageNotReadyError: class AiSessionMessageNotReadyError extends Error {
    readonly code = 'message_transport_not_ready';
  },
  AiSessionTransportNotInitializedError: class AiSessionTransportNotInitializedError extends Error {
    readonly code = 'codex_transport_not_initialized';
  },
  AiSessionTransportNotImplementedError: class AiSessionTransportNotImplementedError extends Error {
    readonly code = 'message_transport_not_implemented';
  },
  createAiSessionService: () => mockAiSessionService,
}));

vi.mock('@/lib/projects/service', () => ({
  createProjectService: () => mockProjectService,
}));

describe('ai sessions api routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAiSessionService.listWorkspaceVersions.mockResolvedValue([]);
    mockAiSessionService.getTransportSnapshot.mockResolvedValue({
      phase: 'uninitialized',
      threadId: null,
      initializedAt: null,
      lastActivityAt: null,
      idleDeadlineAt: null,
      lastErrorCode: null,
      lastErrorMessage: null,
      initLogCount: 0,
      turnLogCount: 0,
      requiresReinit: true,
    });
    mockAiSessionService.listTransportLogs.mockResolvedValue({
      snapshot: {
        phase: 'uninitialized',
        threadId: null,
        initializedAt: null,
        lastActivityAt: null,
        idleDeadlineAt: null,
        lastErrorCode: null,
        lastErrorMessage: null,
        initLogCount: 0,
        turnLogCount: 0,
        requiresReinit: true,
      },
      initTranscript: [],
      turnTranscript: [],
    });
  });

  it('creates an ai session from the project current version', async () => {
    mockProjectService.getProject.mockResolvedValue({ id: 'p1', ownerId: 'owner-1', currentVersion: 7 });
    mockAiSessionService.createSession.mockResolvedValue({ id: 'sess-1', projectId: 'p1', baseVersion: 7, status: 'provisioning' });

    const { POST } = await import('@/app/api/ai/sessions/route');
    const response = await POST(
      new Request('http://localhost/api/ai/sessions', {
        method: 'POST',
        body: JSON.stringify({ projectId: 'p1' }),
      }),
    );
    const data = await response.json();

    expect(response.status).toBe(201);
    expect(data.ok).toBe(true);
    expect(mockAiSessionService.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'p1', ownerId: 'owner-1', baseVersion: 7 }),
    );
  }, 15000);

  it('returns 404 when creating a session for a missing project', async () => {
    mockProjectService.getProject.mockResolvedValue(null);

    const { POST } = await import('@/app/api/ai/sessions/route');
    const response = await POST(
      new Request('http://localhost/api/ai/sessions', {
        method: 'POST',
        body: JSON.stringify({ projectId: 'missing' }),
      }),
    );
    const data = await response.json();

    expect(response.status).toBe(404);
    expect(data.ok).toBe(false);
  });

  it('loads a single ai session', async () => {
    mockAiSessionService.getSession.mockResolvedValue({ id: 'sess-1', projectId: 'p1', status: 'ready' });

    const { GET } = await import('@/app/api/ai/sessions/[id]/route');
    const response = await GET(new Request('http://localhost/api/ai/sessions/sess-1'), {
      params: Promise.resolve({ id: 'sess-1' }),
    });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.session.id).toBe('sess-1');
    expect(data.transport.phase).toBe('uninitialized');
  });

  it('revokes an ai session', async () => {
    mockAiSessionService.revokeSession.mockResolvedValue({ id: 'sess-1', status: 'revoked' });

    const { DELETE } = await import('@/app/api/ai/sessions/[id]/route');
    const response = await DELETE(new Request('http://localhost/api/ai/sessions/sess-1', { method: 'DELETE' }), {
      params: Promise.resolve({ id: 'sess-1' }),
    });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.session.status).toBe('revoked');
    expect(data.transport).toBeNull();
  });

  it('bootstraps an ai session', async () => {
    mockAiSessionService.bootstrapSession.mockResolvedValue({ id: 'sess-1', status: 'ready', boxStatus: 'ready' });

    const { POST } = await import('@/app/api/ai/sessions/[id]/bootstrap/route');
    const response = await POST(
      new Request('http://localhost/api/ai/sessions/sess-1/bootstrap', {
        method: 'POST',
        body: JSON.stringify({ bindToken: 'bind-1' }),
      }),
      {
        params: Promise.resolve({ id: 'sess-1' }),
      },
    );
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.session.status).toBe('ready');
    expect(mockAiSessionService.bootstrapSession).toHaveBeenCalledWith('sess-1', 'bind-1');
  });

  it('initializes codex transport for an ai session', async () => {
    mockAiSessionService.initializeTransport.mockResolvedValue({
      session: { id: 'sess-1', status: 'ready', appServerThreadId: 'thr-1' },
      transport: {
        phase: 'ready',
        threadId: 'thr-1',
        initializedAt: new Date().toISOString(),
        lastActivityAt: new Date().toISOString(),
        idleDeadlineAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        lastErrorCode: null,
        lastErrorMessage: null,
        initLogCount: 4,
        turnLogCount: 0,
        requiresReinit: false,
      },
    });

    const { POST } = await import('@/app/api/ai/sessions/[id]/init/route');
    const response = await POST(
      new Request('http://localhost/api/ai/sessions/sess-1/init', {
        method: 'POST',
        body: JSON.stringify({ bindToken: 'bind-1' }),
      }),
      { params: Promise.resolve({ id: 'sess-1' }) },
    );
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.transport.phase).toBe('ready');
    expect(mockAiSessionService.initializeTransport).toHaveBeenCalledWith('sess-1', 'bind-1');
  });

  it('returns a structured init failure without crashing route state', async () => {
    mockAiSessionService.getSession.mockResolvedValue({ id: 'sess-1', projectId: 'p1', status: 'ready' });
    mockAiSessionService.getTransportSnapshot.mockResolvedValue({
      phase: 'transport_lost',
      threadId: null,
      initializedAt: null,
      lastActivityAt: new Date().toISOString(),
      idleDeadlineAt: null,
      lastErrorCode: 'codex_app_server_runner_failed',
      lastErrorMessage: 'runner timeout',
      initLogCount: 5,
      turnLogCount: 0,
      requiresReinit: true,
    });
    mockAiSessionService.initializeTransport.mockRejectedValue({
      message: 'runner timeout',
      reason: 'codex_app_server_runner_failed',
      code: 'message_transport_not_implemented',
    });

    const { POST } = await import('@/app/api/ai/sessions/[id]/init/route');
    const response = await POST(
      new Request('http://localhost/api/ai/sessions/sess-1/init', {
        method: 'POST',
        body: JSON.stringify({ bindToken: 'bind-1' }),
      }),
      { params: Promise.resolve({ id: 'sess-1' }) },
    );
    const data = await response.json();

    expect(response.status).toBe(500);
    expect(data.transport.phase).toBe('transport_lost');
  });

  it('returns codex logs for an ai session', async () => {
    mockAiSessionService.getSession.mockResolvedValue({ id: 'sess-1', projectId: 'p1', status: 'ready' });
    mockAiSessionService.listTransportLogs.mockResolvedValue({
      snapshot: {
        phase: 'ready',
        threadId: 'thr-1',
        initializedAt: new Date().toISOString(),
        lastActivityAt: new Date().toISOString(),
        idleDeadlineAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        lastErrorCode: null,
        lastErrorMessage: null,
        initLogCount: 2,
        turnLogCount: 1,
        requiresReinit: false,
      },
      initTranscript: [{ id: 'log-1', phase: 'init', direction: 'system', message: 'ready', createdAt: new Date().toISOString() }],
      turnTranscript: [{ id: 'log-2', phase: 'turn', direction: 'outbound', message: 'turn/start', createdAt: new Date().toISOString() }],
    });

    const { GET } = await import('@/app/api/ai/sessions/[id]/logs/route');
    const response = await GET(new Request('http://localhost/api/ai/sessions/sess-1/logs'), {
      params: Promise.resolve({ id: 'sess-1' }),
    });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.transport.threadId).toBe('thr-1');
    expect(data.initTranscript).toHaveLength(1);
    expect(data.turnTranscript).toHaveLength(1);
  });

  it('streams a snapshot of session events over sse', async () => {
    mockAiSessionService.getSession.mockResolvedValue({ id: 'sess-1', status: 'ready' });
    mockAiSessionService.listEvents.mockResolvedValue([{ id: 'evt-1', type: 'session.ready' }]);

    const { GET } = await import('@/app/api/ai/sessions/[id]/events/route');
    const response = await GET(new Request('http://localhost/api/ai/sessions/sess-1/events'), {
      params: Promise.resolve({ id: 'sess-1' }),
    });

    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const body = await response.text();
    expect(body).toContain('session.snapshot');
    expect(body).toContain('session.ready');
  });

  it('lists Box workspace versions for an ai session', async () => {
    mockAiSessionService.getSession.mockResolvedValue({ id: 'sess-1', status: 'ready' });
    mockAiSessionService.listWorkspaceVersions.mockResolvedValue([
      { versionId: 'session:v1', workspaceVersion: 1, createdAt: new Date().toISOString(), isActive: false, isLatest: false, sourceTargetId: null },
      { versionId: 'session:v2', workspaceVersion: 2, createdAt: new Date().toISOString(), isActive: true, isLatest: true, sourceTargetId: 'session:v1' },
    ]);

    const { GET } = await import('@/app/api/ai/sessions/[id]/versions/route');
    const response = await GET(new Request('http://localhost/api/ai/sessions/sess-1/versions'), {
      params: Promise.resolve({ id: 'sess-1' }),
    });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.versions).toHaveLength(2);
    expect(data.versions[1].versionId).toBe('session:v2');
  });

  it('loads a specific Box workspace version payload', async () => {
    mockAiSessionService.getSession.mockResolvedValue({ id: 'sess-1', status: 'ready' });
    mockAiSessionService.getWorkspaceVersionPayload.mockResolvedValue({
      versionId: 'session:v1',
      workspaceVersion: 1,
      package: {
        indexHtml: '<html></html>',
        gameJs: 'console.log(1);',
        styleCss: 'body {}',
        manifestJson: '{"title":"Demo","summary":"Demo","capabilities":[]}',
      },
      isActive: false,
      isLatest: false,
    });

    const { GET } = await import('@/app/api/ai/sessions/[id]/versions/[versionId]/route');
    const response = await GET(new Request('http://localhost/api/ai/sessions/sess-1/versions/session:v1'), {
      params: Promise.resolve({ id: 'sess-1', versionId: 'session:v1' }),
    });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.versionId).toBe('session:v1');
    expect(data.package.gameJs).toContain('console.log');
  });

  it('checkpoints an ai session', async () => {
    mockAiSessionService.checkpointSession.mockResolvedValue({
      session: { id: 'sess-1', status: 'ready' },
      checkpoint: { id: 'chk-1', status: 'committed', newVersion: 8 },
      project: { id: 'p1', currentVersion: 8 },
    });

    const { POST } = await import('@/app/api/ai/sessions/[id]/checkpoint/route');
    const response = await POST(
      new Request('http://localhost/api/ai/sessions/sess-1/checkpoint', {
        method: 'POST',
        body: JSON.stringify({ idempotencyKey: 'key-1' }),
      }),
      { params: Promise.resolve({ id: 'sess-1' }) },
    );
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.checkpoint.newVersion).toBe(8);
  });

  it('returns conflict status for stale-base checkpoint', async () => {
    mockAiSessionService.checkpointSession.mockResolvedValue({
      session: { id: 'sess-1', status: 'ready' },
      checkpoint: { id: 'chk-2', status: 'conflict', newVersion: null },
      project: { id: 'p1', currentVersion: 9 },
    });

    const { POST } = await import('@/app/api/ai/sessions/[id]/checkpoint/route');
    const response = await POST(
      new Request('http://localhost/api/ai/sessions/sess-1/checkpoint', {
        method: 'POST',
        body: JSON.stringify({ idempotencyKey: 'key-2' }),
      }),
      { params: Promise.resolve({ id: 'sess-1' }) },
    );

    expect(response.status).toBe(409);
  });

  it('returns 502 when session message transport is not wired', async () => {
    const { AiSessionTransportNotImplementedError } = await import('@/lib/ai-sessions/service');
    mockAiSessionService.executeMessage.mockRejectedValue(
      new AiSessionTransportNotImplementedError('Codex app-server message transport is not wired yet'),
    );

    const { POST } = await import('@/app/api/ai/sessions/[id]/messages/route');
    const response = await POST(
      new Request('http://localhost/api/ai/sessions/sess-1/messages', {
        method: 'POST',
        body: JSON.stringify({ mode: 'modify', requestText: 'change color' }),
      }),
      { params: Promise.resolve({ id: 'sess-1' }) },
    );

    expect(response.status).toBe(502);
  });
});
