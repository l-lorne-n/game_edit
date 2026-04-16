import { NextResponse } from 'next/server';

import {
  AiSessionMessageNotReadyError,
  AiSessionTransportNotImplementedError,
  AiSessionTransportNotInitializedError,
} from '@/lib/ai-sessions/service';
import { runCodexPackageTask } from '@/lib/ai/codex-package-task';
import { computePackageRouteDecision } from '@/lib/ai/package-route-decision';
import { parseGeneratedGamePackage } from '@/lib/package/contracts';
import { createProjectService } from '@/lib/projects/service';

const projectService = createProjectService();

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      errorReport?: string;
      currentPackage?: unknown;
      evaluatorSummary?: string;
      lastKnownGoodPackage?: unknown;
      targetId?: string;
      projectId?: string;
      aiSessionId?: string;
    };

    const errorReport = body.errorReport?.trim();
    if (!errorReport) {
      return NextResponse.json({ ok: false, error: 'errorReport is required' }, { status: 400 });
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
      mode: 'debug',
      requestText: errorReport,
      targetId: body.targetId ?? '__current__',
      targetPackage: parsedCurrent.pkg,
    });

    const result = await runCodexPackageTask({
        mode: 'debug',
        projectId: body.projectId,
        aiSessionId: body.aiSessionId,
        targetId: body.targetId ?? null,
        errorReport,
        currentPackage: parsedCurrent.pkg,
      evaluatorSummary: body.evaluatorSummary,
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
          source: 'debug',
          parentVersion: (await projectService.getProject(body.projectId))?.currentVersion ?? null,
          evaluator: result.solveResult.staticEvaluation,
        });
      } catch (error) {
        persistenceWarning = error instanceof Error ? error.message : 'Project persistence is unavailable.';
      }
    }

    return NextResponse.json({
      ok: true,
      errorReport,
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
      executionEngine: result.executionTraceMeta,
      serverRouteDecision,
      project: persistedProject,
      persistenceWarning,
    });
  } catch (error) {
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
