import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  createAiSessionServiceMock,
  createProjectServiceMock,
  runLegacyPackageExecutorMock,
} = vi.hoisted(() => ({
  createAiSessionServiceMock: vi.fn(),
  createProjectServiceMock: vi.fn(),
  runLegacyPackageExecutorMock: vi.fn(),
}));

vi.mock('@/lib/ai-sessions/service', () => ({
  AiSessionMessageNotReadyError: class AiSessionMessageNotReadyError extends Error {
    readonly code = 'message_transport_not_ready';
  },
  AiSessionTransportNotInitializedError: class AiSessionTransportNotInitializedError extends Error {
    readonly code = 'codex_transport_not_initialized';
  },
  AiSessionTransportNotImplementedError: class AiSessionTransportNotImplementedError extends Error {
    readonly code = 'message_transport_not_implemented';
  },
  createAiSessionService: createAiSessionServiceMock,
}));

vi.mock('@/lib/projects/service', () => ({
  createProjectService: createProjectServiceMock,
}));

vi.mock('@/lib/ai/executors/legacy-package-executor', () => ({
  runLegacyPackageExecutor: runLegacyPackageExecutorMock,
}));

import { runAppServerPackageExecutor } from '@/lib/ai/executors/app-server-package-executor';

describe('runAppServerPackageExecutor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runLegacyPackageExecutorMock.mockResolvedValue({
      solveResult: {
        pkg: {
          indexHtml: '<html></html>',
          gameJs: 'console.log(1);',
          styleCss: 'body {}',
          manifestJson: '{"title":"Demo","summary":"Demo","editable":[],"capabilities":[]}',
        },
        manifest: { title: 'Demo', summary: 'Demo', editable: [], capabilities: [] },
        staticEvaluation: {
          ok: true,
          code: 'STATIC_OK',
          source: 'static',
          summary: 'ok',
          at: new Date().toISOString(),
          errors: [],
          logs: [],
        },
        repaired: false,
        fallbackUsed: false,
        source: 'model',
        statusMessage: 'done',
        provider: 'test',
        model: 'test-model',
        attempts: [],
      },
      actualEngine: 'legacy-model',
      fallbackReason: null,
    });
  });

  it('rejects when projectId is missing', async () => {
    await expect(
      runAppServerPackageExecutor({
        mode: 'create',
        prompt: 'make game',
      }),
    ).rejects.toThrow('Project id is required before sending a Codex prompt.');
    expect(runLegacyPackageExecutorMock).not.toHaveBeenCalled();
  });

  it('rejects when aiSessionId is missing', async () => {
    const projectService = {
      getProject: vi.fn().mockResolvedValue({ id: 'project-1', ownerId: 'owner-1', currentVersion: 3 }),
    };
    createProjectServiceMock.mockReturnValue(projectService);
    createAiSessionServiceMock.mockReturnValue({});

    await expect(
      runAppServerPackageExecutor({
        mode: 'modify',
        projectId: 'project-1',
        instruction: 'change color',
      }),
    ).rejects.toThrow('Init Codex is required before sending a prompt.');
  });

  it('rejects when transport is not ready', async () => {
    const aiSessionService = {
      getSession: vi.fn().mockResolvedValue({
        id: 'sess-1',
        projectId: 'project-1',
        baseVersion: 3,
        activeWorkspaceVersion: 1,
        latestWorkspaceVersion: 1,
        revokedAt: null,
        status: 'ready',
        appServerStatus: 'stopped',
      }),
      getTransportSnapshot: vi.fn().mockResolvedValue({ phase: 'idle_expired' }),
    };
    const projectService = {
      getProject: vi.fn().mockResolvedValue({ id: 'project-1', ownerId: 'owner-1', currentVersion: 3 }),
    };

    createAiSessionServiceMock.mockReturnValue(aiSessionService);
    createProjectServiceMock.mockReturnValue(projectService);

    await expect(
      runAppServerPackageExecutor({
        mode: 'modify',
        projectId: 'project-1',
        aiSessionId: 'sess-1',
        instruction: 'change color',
      }),
    ).rejects.toThrow('Init Codex is required before sending a prompt.');
  });

  it('returns codex-app-server as actual engine when message execution succeeds', async () => {
    const aiSessionService = {
      getSession: vi.fn().mockResolvedValue({
        id: 'sess-1',
        projectId: 'project-1',
        baseVersion: 3,
        activeWorkspaceVersion: 1,
        latestWorkspaceVersion: 1,
        revokedAt: null,
        status: 'ready',
        appServerStatus: 'healthy',
      }),
      getTransportSnapshot: vi.fn().mockResolvedValue({ phase: 'ready' }),
      executeMessage: vi.fn().mockResolvedValue({
        acknowledged: true,
        sessionId: 'sess-1',
        acceptedAt: new Date().toISOString(),
        threadId: 'thr-1',
        turnStatus: 'completed',
        agentText: 'done',
        workspaceVersion: 2,
        workspaceRoot: '/workspace/home/sessions/sess-1/v2',
        baseTargetId: 'session:v1',
      }),
      readWorkspacePackage: vi.fn().mockResolvedValue({
        indexHtml: '<html></html>',
        gameJs: 'console.log(1);',
        styleCss: 'body {}',
        manifestJson: '{"title":"Demo","summary":"Demo","editable":[],"capabilities":[]}',
      }),
      writeWorkspacePackage: vi.fn(),
      promoteWorkspaceVersion: vi.fn().mockResolvedValue(undefined),
    };
    const projectService = {
      getProject: vi.fn().mockResolvedValue({ id: 'project-1', ownerId: 'owner-1', currentVersion: 3 }),
    };

    createAiSessionServiceMock.mockReturnValue(aiSessionService);
    createProjectServiceMock.mockReturnValue(projectService);

    const result = await runAppServerPackageExecutor({
      mode: 'modify',
      projectId: 'project-1',
      aiSessionId: 'sess-1',
      instruction: 'change color',
      currentPackage: {
        indexHtml: '<html></html>',
        gameJs: 'console.log(1);',
        styleCss: 'body {}',
        manifestJson: '{"title":"Demo","summary":"Demo","editable":[],"capabilities":[]}',
      },
      routeMode: 'patch',
      routeReason: 'MODIFY_REQUEST',
      allowedPaths: ['gameJs'],
    });

    expect(result.actualEngine).toBe('codex-app-server');
    expect(result.fallbackReason).toBeNull();
    expect(aiSessionService.readWorkspacePackage).toHaveBeenCalledWith('sess-1', 2);
    expect(aiSessionService.promoteWorkspaceVersion).toHaveBeenCalledWith('sess-1', 2);
  });

  it('recovers package files from agent text when workspace files remain empty', async () => {
    const recoveredPkg = {
      indexHtml: '<main>hi</main>',
      gameJs: "console.log('x')",
      styleCss: 'body{}',
      manifestJson: '{"title":"Demo","summary":"Demo","editable":[],"capabilities":[]}',
    };
    const aiSessionService = {
      getSession: vi.fn().mockResolvedValue({
        id: 'sess-1',
        projectId: 'project-1',
        baseVersion: 3,
        activeWorkspaceVersion: 1,
        latestWorkspaceVersion: 1,
        revokedAt: null,
        status: 'ready',
        appServerStatus: 'healthy',
      }),
      getTransportSnapshot: vi.fn().mockResolvedValue({ phase: 'ready' }),
      executeMessage: vi.fn().mockResolvedValue({
        acknowledged: true,
        sessionId: 'sess-1',
        acceptedAt: new Date().toISOString(),
        threadId: 'thr-1',
        turnStatus: 'completed',
        agentText: JSON.stringify(recoveredPkg),
        workspaceVersion: 2,
        workspaceRoot: '/workspace/home/sessions/sess-1/v2',
        baseTargetId: 'session:v1',
      }),
      readWorkspacePackage: vi.fn().mockResolvedValue({
        indexHtml: '',
        gameJs: '',
        styleCss: '',
        manifestJson: '',
      }),
      writeWorkspacePackage: vi.fn().mockResolvedValue(undefined),
      promoteWorkspaceVersion: vi.fn().mockResolvedValue(undefined),
    };
    const projectService = {
      getProject: vi.fn().mockResolvedValue({ id: 'project-1', ownerId: 'owner-1', currentVersion: 3 }),
    };

    createAiSessionServiceMock.mockReturnValue(aiSessionService);
    createProjectServiceMock.mockReturnValue(projectService);

    const result = await runAppServerPackageExecutor({
      mode: 'create',
      projectId: 'project-1',
      aiSessionId: 'sess-1',
      prompt: 'make game',
    });

    expect(aiSessionService.writeWorkspacePackage).toHaveBeenCalledWith('sess-1', recoveredPkg, 2);
    expect(aiSessionService.promoteWorkspaceVersion).toHaveBeenCalledWith('sess-1', 2);
    expect(result.solveResult.pkg.indexHtml).toBe('<main>hi</main>');
  });
});
