import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockProjectService = {
  saveGeneratedPackage: vi.fn(),
  getProject: vi.fn(),
};

const runCodexPackageTaskMock = vi.fn();
const computePackageRouteDecisionMock = vi.fn();

vi.mock('@/lib/projects/service', () => ({
  createProjectService: () => mockProjectService,
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
    runCodexPackageTaskMock.mockResolvedValue({
      solveResult: {
        pkg: {
          indexHtml: '<html></html>',
          gameJs: 'console.log(2);',
          styleCss: 'body { background: white; }',
          manifestJson: '{"title":"Demo","summary":"Demo","capabilities":[]}',
        },
        manifest: { title: 'Demo', summary: 'Demo', capabilities: [] },
        staticEvaluation: { ok: true, code: 'STATIC_OK', source: 'static', summary: 'ok', at: new Date().toISOString(), errors: [], logs: [] },
        repaired: false,
        fallbackUsed: false,
        source: 'model',
        statusMessage: 'done',
        provider: 'test',
        model: 'test-model',
        attempts: [],
      },
      requiresReplan: false,
      executionTraceMeta: {
        requestedEngine: 'codex-app-server',
        actualEngine: 'codex-app-server',
        strategy: 'plan_then_execute',
        routeReason: 'MODIFY_REQUEST',
        allowedPaths: ['indexHtml', 'gameJs', 'styleCss', 'manifestJson'],
        fallbackReason: null,
      },
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

    expect(response.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(runCodexPackageTaskMock).toHaveBeenCalled();
    expect(mockProjectService.saveGeneratedPackage).not.toHaveBeenCalled();
  });

  it('does not persist durable project versions directly for ai-session generate', async () => {
    runCodexPackageTaskMock.mockResolvedValue({
      solveResult: {
        pkg: {
          indexHtml: '<html></html>',
          gameJs: 'console.log(1);',
          styleCss: 'body {}',
          manifestJson: '{"title":"Demo","summary":"Demo","capabilities":[]}',
        },
        manifest: { title: 'Demo', summary: 'Demo', capabilities: [] },
        staticEvaluation: { ok: true, code: 'STATIC_OK', source: 'static', summary: 'ok', at: new Date().toISOString(), errors: [], logs: [] },
        repaired: false,
        fallbackUsed: false,
        source: 'model',
        statusMessage: 'done',
        provider: 'test',
        model: 'test-model',
        attempts: [],
      },
      executionTraceMeta: {
        requestedEngine: 'codex-app-server',
        actualEngine: 'codex-app-server',
        strategy: 'plan_then_execute',
        routeReason: 'CREATE_REQUEST',
        allowedPaths: ['indexHtml', 'gameJs', 'styleCss', 'manifestJson'],
        fallbackReason: null,
      },
    });

    const { POST } = await import('@/app/api/package/generate/route');
    const response = await POST(
      new Request('http://localhost/api/package/generate', {
        method: 'POST',
        body: JSON.stringify({ prompt: 'make a game', projectId: 'p1', aiSessionId: 'sess-1' }),
      }),
    );
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.project).toBeNull();
    expect(mockProjectService.saveGeneratedPackage).not.toHaveBeenCalled();
  });
});
