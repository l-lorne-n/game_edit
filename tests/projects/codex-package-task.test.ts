import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  generatePackageFromPromptMock,
  modifyPackageFromInstructionMock,
  debugPackageFromReportMock,
  runAppServerPackageExecutorMock,
} = vi.hoisted(() => ({
  generatePackageFromPromptMock: vi.fn(),
  modifyPackageFromInstructionMock: vi.fn(),
  debugPackageFromReportMock: vi.fn(),
  runAppServerPackageExecutorMock: vi.fn(),
}));

vi.mock('@/lib/ai/generate-package', () => ({
  generatePackageFromPrompt: generatePackageFromPromptMock,
  modifyPackageFromInstruction: modifyPackageFromInstructionMock,
  debugPackageFromReport: debugPackageFromReportMock,
}));

vi.mock('@/lib/ai/executors/app-server-package-executor', () => ({
  runAppServerPackageExecutor: runAppServerPackageExecutorMock,
}));

import { runCodexPackageTask } from '@/lib/ai/codex-package-task';
import { createTemplatePackage } from '@/lib/package/template';

describe('runCodexPackageTask', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CODEX_ROUTE_ENGINE = 'legacy';
    delete process.env.UPSTASH_BOX_API_KEY;
    delete process.env.UPSTASH_BOX;
    delete process.env.upstash_box;
    delete process.env.UPSTASH_BOX_NAME;
    delete process.env.upstash_box_name;
    delete process.env.HOST_TOKEN_SERVICE_URL;
    delete process.env.NEXT_PUBLIC_APP_URL;
  });

  it('maps create to plan_then_execute', async () => {
    const pkg = createTemplatePackage('demo');
    generatePackageFromPromptMock.mockResolvedValue({
      pkg,
      manifest: JSON.parse(pkg.manifestJson),
      staticEvaluation: { ok: true, code: 'OK', summary: 'ok', errors: [], warnings: [], runtimeHints: [] },
      repaired: false,
      fallbackUsed: false,
      source: 'model',
      statusMessage: 'done',
      provider: 'test',
      model: 'test-model',
      attempts: [],
    });

    const result = await runCodexPackageTask({ mode: 'create', prompt: 'make game' });
    expect(result.envelope.strategy).toBe('plan_then_execute');
    expect(generatePackageFromPromptMock).toHaveBeenCalledWith('make game', undefined);
  });

  it('maps modify flow to the same plan_then_execute strategy as create', async () => {
    const pkg = createTemplatePackage('demo');
    modifyPackageFromInstructionMock.mockResolvedValue({
      pkg,
      manifest: JSON.parse(pkg.manifestJson),
      staticEvaluation: { ok: true, code: 'OK', summary: 'ok', errors: [], warnings: [], runtimeHints: [] },
      repaired: false,
      fallbackUsed: false,
      source: 'model',
      statusMessage: 'done',
      provider: 'test',
      model: 'test-model',
      attempts: [],
    });

    const result = await runCodexPackageTask({
      mode: 'modify',
      instruction: 'change color',
      currentPackage: pkg,
      routeMode: 'design',
      routeReason: 'MODIFY_REQUEST',
    });

    expect(result.envelope.strategy).toBe('plan_then_execute');
    expect(result.requiresReplan).toBe(false);
    expect(modifyPackageFromInstructionMock).toHaveBeenCalled();
  });

  it('keeps modify on the unified execution path even with routeMode=design', async () => {
    const pkg = createTemplatePackage('demo');
    modifyPackageFromInstructionMock.mockResolvedValue({
      pkg,
      manifest: JSON.parse(pkg.manifestJson),
      staticEvaluation: { ok: true, code: 'OK', summary: 'ok', errors: [], warnings: [], runtimeHints: [] },
      repaired: false,
      fallbackUsed: false,
      source: 'model',
      statusMessage: 'done',
      provider: 'test',
      model: 'test-model',
      attempts: [],
    });

    const result = await runCodexPackageTask({
      mode: 'modify',
      instruction: 'add totally new mechanic',
      currentPackage: pkg,
      routeMode: 'design',
      routeReason: 'MODIFY_REQUEST',
    });

    expect(result.envelope.strategy).toBe('plan_then_execute');
    expect(result.requiresReplan).toBe(false);
    expect(modifyPackageFromInstructionMock).toHaveBeenCalled();
    expect(result.solveResult.staticEvaluation.code).toBe('OK');
  });

  it('maps debug to repair_execute', async () => {
    const pkg = createTemplatePackage('demo');
    debugPackageFromReportMock.mockResolvedValue({
      pkg,
      manifest: JSON.parse(pkg.manifestJson),
      staticEvaluation: { ok: false, code: 'RUNTIME_ERROR', summary: 'bad', errors: ['bad'], warnings: [], runtimeHints: [] },
      repaired: true,
      fallbackUsed: false,
      source: 'repair',
      statusMessage: 'repaired',
      provider: 'test',
      model: 'test-model',
      attempts: [],
    });

    const result = await runCodexPackageTask({
      mode: 'debug',
      errorReport: 'ReferenceError',
      currentPackage: pkg,
    });

    expect(result.envelope.strategy).toBe('repair_execute');
    expect(debugPackageFromReportMock).toHaveBeenCalled();
  });

  it('keeps requested app-server engine distinct from actual engine until transport is wired', async () => {
    process.env.CODEX_ROUTE_ENGINE = 'app-server';
    runAppServerPackageExecutorMock.mockRejectedValue(new Error('Init Codex is required before sending a prompt.'));

    await expect(
      runCodexPackageTask({
        mode: 'create',
        prompt: 'make game',
      }),
    ).rejects.toThrow('Init Codex is required before sending a prompt.');
  });

  it('defaults requested engine to app-server when box and host auth are configured', async () => {
    delete process.env.CODEX_ROUTE_ENGINE;
    process.env.UPSTASH_BOX_API_KEY = 'box-key';
    process.env.upstash_box = 'box_123';
    process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3000';

    const pkg = createTemplatePackage('demo');
    runAppServerPackageExecutorMock.mockResolvedValue({
      solveResult: {
        pkg,
        manifest: JSON.parse(pkg.manifestJson),
        staticEvaluation: { ok: true, code: 'OK', summary: 'ok', errors: [], warnings: [], runtimeHints: [] },
        repaired: false,
        fallbackUsed: false,
        source: 'model',
        statusMessage: 'done',
        provider: 'test',
        model: 'test-model',
        attempts: [],
      },
      actualEngine: 'codex-app-server',
      fallbackReason: null,
    });

    const result = await runCodexPackageTask({ mode: 'create', prompt: 'make game', projectId: 'p1', aiSessionId: 'sess-1' });
    expect(result.envelope.requestedEngine).toBe('codex-app-server');
  });
});
