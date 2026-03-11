import { NextResponse } from 'next/server';

import { debugPackageFromReport } from '@/lib/ai/generate-package';
import { parseGeneratedGamePackage } from '@/lib/package/contracts';

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      errorReport?: string;
      currentPackage?: unknown;
      evaluatorSummary?: string;
      lastKnownGoodPackage?: unknown;
      targetId?: string;
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
