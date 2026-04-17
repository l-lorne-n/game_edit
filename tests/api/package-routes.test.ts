import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockProjectService = {
  saveGeneratedPackage: vi.fn(),
  getProject: vi.fn(),
};

const mockAiSessionService = {
  submitMessageTurn: vi.fn(),
};

const runCodexPackageTaskMock = vi.fn();
const computePackageRouteDecisionMock = vi.fn();

vi.mock('@/lib/projects/service', () => ({
  createProjectService: () => mockProjectService,
}));

vi.mock('@/lib/ai-sessions/service', () => ({
  AiSessionMessageNotReadyError: class AiSessionMessageNotReadyError extends Error {
    readonly code = 'message_transport_not_ready';
  },
  AiSessionTransportNotImplementedError: class AiSessionTransportNotImplementedError extends Error {
    readonly reason: string;
    constructor(message: string, reason = 'transport_not_implemented') {
      super(message);
      this.reason = reason;
    }
  },
  AiSessionTransportNotInitializedError: class AiSessionTransportNotInitializedError extends Error {
    readonly code = 'codex_transport_not_initialized';
  },
  createAiSessionService: () => mockAiSessionService,
}));

vi.mock('@/lib/ai/codex-package-task', () => ({
  runCodexPackageTask: runCodexPackageTaskMock,
}));

vi.mock('@/lib/ai/package-route-decision', () => ({
  computePackageRouteDecision: computePackageRouteDecisionMock,
}));

describe('package api routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    computePackageRouteDecisionMock.mockReturnValue({
      agent: 'architect',
      routeMode: 'design',
      confidence: 0.9,
      primaryReasonCode: 'MODIFY_REQUEST',
      secondaryReasonCodes: [],
      summary: 'full-package modify',
      why: 'editable scope disabled',
      withinEditableScope: true,
      editableScopeSummary: 'Editable-scope gating is disabled.',
      allowedPaths: ['indexHtml', 'gameJs', 'styleCss', 'manifestJson'],
      allowedChangeTypes: ['full package update'],
      targetId: '__current__',
      requestText: 'change color',
    });
    mockAiSessionService.submitMessageTurn.mockResolvedValue({
      acknowledged: true,
      deduplicated: false,
      sessionId: 'sess-1',
      turnId: 'turn-1',
      acceptedAt: new Date().toISOString(),
      threadId: 'thr-1',
      workspaceVersion: 1,
      workspaceRoot: '/workspace/home/sessions/sess-1/v1',
      baseTargetId: null,
      status: 'running',
      artifactState: 'pending',
    });
  });

  it('does not reject ai-session modify just because routing says design', async () => {
    computePackageRouteDecisionMock.mockReturnValue({
      agent: 'architect',
      routeMode: 'design',
      confidence: 0.98,
      primaryReasonCode: 'MODIFY_REQUEST',
      secondaryReasonCodes: [],
      summary: 'full-package modify',
      why: 'editable scope disabled',
      withinEditableScope: true,
      editableScopeSummary: 'Editable-scope gating is disabled.',
      allowedPaths: ['indexHtml', 'gameJs', 'styleCss', 'manifestJson'],
      allowedChangeTypes: ['full package update'],
      targetId: '__current__',
      requestText: 'add a whole new combat system',
    });
    const { POST } = await import('@/app/api/package/modify/route');
    const response = await POST(
      new Request('http://localhost/api/package/modify', {
        method: 'POST',
        body: JSON.stringify({
          instruction: 'add a whole new combat system',
          projectId: 'p1',
          aiSessionId: 'sess-1',
          targetId: '__current__',
          currentPackage: {
            indexHtml: '<html></html>',
            gameJs: 'console.log(1);',
            styleCss: 'body {}',
            manifestJson: '{"title":"Demo","summary":"Demo","capabilities":[]}',
          },
        }),
      }),
    );
    const data = await response.json();

    expect(response.status).toBe(202);
    expect(data.ok).toBe(true);
    expect(data.accepted).toBe(true);
    expect(mockAiSessionService.submitMessageTurn).toHaveBeenCalled();
    expect(runCodexPackageTaskMock).not.toHaveBeenCalled();
    expect(mockProjectService.saveGeneratedPackage).not.toHaveBeenCalled();
  });

  it('does not persist durable project versions directly for ai-session generate', async () => {
    const { POST } = await import('@/app/api/package/generate/route');
    const response = await POST(
      new Request('http://localhost/api/package/generate', {
        method: 'POST',
        body: JSON.stringify({ prompt: 'make a game', projectId: 'p1', aiSessionId: 'sess-1' }),
      }),
    );
    const data = await response.json();

    expect(response.status).toBe(202);
    expect(data.ok).toBe(true);
    expect(data.accepted).toBe(true);
    expect(data.project).toBeNull();
    expect(mockAiSessionService.submitMessageTurn).toHaveBeenCalled();
    expect(mockProjectService.saveGeneratedPackage).not.toHaveBeenCalled();
  });
});
