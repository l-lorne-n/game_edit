import { NextResponse } from 'next/server';

import { generatePackageFromPrompt } from '@/lib/ai/generate-package';
import { parseGeneratedGamePackage } from '@/lib/package/contracts';
import { createProjectService } from '@/lib/projects/service';

const projectService = createProjectService();

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      prompt?: string;
      lastKnownGoodPackage?: unknown;
      projectId?: string;
    };

    const prompt = body.prompt?.trim();
    if (!prompt) {
      return NextResponse.json({ ok: false, error: 'prompt is required' }, { status: 400 });
    }

    const parsedLastGood = body.lastKnownGoodPackage
      ? parseGeneratedGamePackage(body.lastKnownGoodPackage)
      : null;

    const result = await generatePackageFromPrompt(
      prompt,
      parsedLastGood?.ok ? parsedLastGood.pkg : undefined,
    );

    let persistedProject = null;
    let persistenceWarning: string | null = null;
    if (body.projectId) {
      try {
        persistedProject = await projectService.saveGeneratedPackage({
          projectId: body.projectId,
          pkg: result.pkg,
          source: 'generate',
          parentVersion: (await projectService.getProject(body.projectId))?.currentVersion ?? null,
          evaluator: result.staticEvaluation,
        });
      } catch (error) {
        persistenceWarning = error instanceof Error ? error.message : 'Project persistence is unavailable.';
      }
    }

    return NextResponse.json({
      ok: true,
      prompt,
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
