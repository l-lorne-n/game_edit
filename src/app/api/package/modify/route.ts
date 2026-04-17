import { NextResponse } from 'next/server';

import {
  createAiSessionService,
  AiSessionMessageNotReadyError,
  AiSessionTransportNotImplementedError,
  AiSessionTransportNotInitializedError,
} from '@/lib/ai-sessions/service';
import { CodexPackageTaskError, runCodexPackageTask } from '@/lib/ai/codex-package-task';
import { buildCodexWorkspacePrompt } from '@/lib/ai/codex-workspace-prompts';
import { computePackageRouteDecision } from '@/lib/ai/package-route-decision';
import { parseGeneratedGamePackage } from '@/lib/package/contracts';
import { createProjectService } from '@/lib/projects/service';

const projectService = createProjectService();
const aiSessionService = createAiSessionService();

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      instruction?: string;
      currentPackage?: unknown;
      lastKnownGoodPackage?: unknown;
      targetId?: string;
      projectId?: string;
      aiSessionId?: string;
    };

    const instruction = body.instruction?.trim();
    if (!instruction) {
      return NextResponse.json({ ok: false, error: 'instruction is required' }, { status: 400 });
    }

    const parsedCurrent = parseGeneratedGamePackage(body.currentPackage);
    if (!parsedCurrent.ok) {
      return NextResponse.json(
        {
          ok: false,
          error: 'currentPackage is required and must satisfy schema',
          validation: parsedCurrent,
        },
        { status: 400 },
      );
    }

    const parsedLastGood = body.lastKnownGoodPackage
      ? parseGeneratedGamePackage(body.lastKnownGoodPackage)
      : null;
    const serverRouteDecision = computePackageRouteDecision({
      mode: 'modify',
      requestText: instruction,
      targetId: body.targetId ?? '__current__',
      targetPackage: parsedCurrent.pkg,
    });

    if (body.aiSessionId) {
      const turn = await aiSessionService.submitMessageTurn(body.aiSessionId, {
        mode: 'modify',
        requestText: buildCodexWorkspacePrompt({
          mode: 'modify',
          instruction,
          currentPackage: parsedCurrent.pkg,
          routeMode: serverRouteDecision.routeMode,
          routeReason: serverRouteDecision.primaryReasonCode,
          allowedPaths: serverRouteDecision.allowedPaths,
        }),
        targetId: body.targetId ?? null,
        routeMode: serverRouteDecision.routeMode,
        routeReason: serverRouteDecision.primaryReasonCode,
        allowedPaths: serverRouteDecision.allowedPaths,
      });

      return NextResponse.json(
        {
          ok: true,
          accepted: true,
          statusMessage: 'Codex turn accepted for async execution.',
          source: 'model',
          provider: 'openai',
          model: 'codex-app-server',
          repaired: false,
          fallbackUsed: false,
          requiresReplan: false,
          requiresReinit: false,
          asyncTurn: turn,
          executionEngine: {
            requestedEngine: 'codex-app-server',
            actualEngine: 'codex-app-server',
            strategy: 'plan_then_execute',
            routeReason: serverRouteDecision.primaryReasonCode,
            allowedPaths: serverRouteDecision.allowedPaths,
            fallbackReason: null,
            outcome: 'pending',
            recovery: null,
            stages: [],
            failureContext: null,
          },
          serverRouteDecision,
          project: null,
          persistenceWarning: null,
        },
        { status: 202 },
      );
    }

    const result = await runCodexPackageTask({
        mode: 'modify',
        projectId: body.projectId,
        aiSessionId: body.aiSessionId,
        targetId: body.targetId ?? null,
        instruction,
        currentPackage: parsedCurrent.pkg,
      lastKnownGoodPackage: parsedLastGood?.ok ? parsedLastGood.pkg : undefined,
        routeMode: serverRouteDecision.routeMode,
        routeReason: serverRouteDecision.primaryReasonCode,
        allowedPaths: serverRouteDecision.allowedPaths,
      });

    let persistedProject = null;
    let persistenceWarning: string | null = null;
    if (body.projectId && !body.aiSessionId) {
      try {
        persistedProject = await projectService.saveGeneratedPackage({
          projectId: body.projectId,
          pkg: result.solveResult.pkg,
          source: 'modify',
          parentVersion: (await projectService.getProject(body.projectId))?.currentVersion ?? null,
          evaluator: result.solveResult.staticEvaluation,
        });
      } catch (error) {
        persistenceWarning = error instanceof Error ? error.message : 'Project persistence is unavailable.';
      }
    }

    return NextResponse.json({
      ok: true,
      instruction,
      targetId: body.targetId ?? null,
      package: result.solveResult.pkg,
      manifest: result.solveResult.manifest,
      staticEvaluation: result.solveResult.staticEvaluation,
      repaired: result.solveResult.repaired,
      fallbackUsed: result.solveResult.fallbackUsed,
      source: result.solveResult.source,
      statusMessage: result.solveResult.statusMessage,
      provider: result.solveResult.provider,
      model: result.solveResult.model,
      attempts: result.solveResult.attempts,
      requiresReplan: result.requiresReplan,
      requiresReinit: result.requiresReinit,
      executionEngine: result.executionTraceMeta,
      serverRouteDecision,
      project: persistedProject,
      persistenceWarning,
    });
  } catch (error) {
    if (error instanceof CodexPackageTaskError) {
      return NextResponse.json(
        {
          ok: false,
          error: error.message,
          code: error.code,
          requiresReinit: error.requiresReinit,
          executionEngine: error.executionTraceMeta,
        },
        { status: error.statusHint },
      );
    }
    if (error instanceof AiSessionTransportNotInitializedError || error instanceof AiSessionMessageNotReadyError) {
      return NextResponse.json({ ok: false, error: error.message, code: error.code }, { status: 409 });
    }
    if (error instanceof AiSessionTransportNotImplementedError) {
      return NextResponse.json({ ok: false, error: error.message, code: error.reason }, { status: 502 });
    }
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : 'unexpected error',
      },
      { status: 500 },
    );
  }
}
