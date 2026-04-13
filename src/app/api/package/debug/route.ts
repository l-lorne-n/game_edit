import { NextResponse } from 'next/server';

import { debugPackageFromReport } from '@/lib/ai/generate-package';
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

    const result = await debugPackageFromReport({
      errorReport,
      currentPackage: parsedCurrent.pkg,
      evaluatorSummary: body.evaluatorSummary,
      lastKnownGood: parsedLastGood?.ok ? parsedLastGood.pkg : undefined,
    });

    let persistedProject = null;
    let persistenceWarning: string | null = null;
    if (body.projectId) {
      try {
        persistedProject = await projectService.saveGeneratedPackage({
          projectId: body.projectId,
          pkg: result.pkg,
          source: 'debug',
          parentVersion: (await projectService.getProject(body.projectId))?.currentVersion ?? null,
          evaluator: result.staticEvaluation,
        });
      } catch (error) {
        persistenceWarning = error instanceof Error ? error.message : 'Project persistence is unavailable.';
      }
    }

    return NextResponse.json({
      ok: true,
      errorReport,
      targetId: body.targetId ?? null,
      package: result.pkg,
      manifest: result.manifest,
      staticEvaluation: result.staticEvaluation,
      repaired: result.repaired,
      fallbackUsed: result.fallbackUsed,
      source: result.source,
      statusMessage: result.statusMessage,
      provider: result.provider,
      model: result.model,
      attempts: result.attempts,
      project: persistedProject,
      persistenceWarning,
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : 'unexpected error',
      },
      { status: 500 },
    );
  }
}
