import { NextResponse } from 'next/server';

import { modifyPackageFromInstruction } from '@/lib/ai/generate-package';
import { parseGeneratedGamePackage } from '@/lib/package/contracts';

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      instruction?: string;
      currentPackage?: unknown;
      lastKnownGoodPackage?: unknown;
      targetId?: string;
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

    const result = await modifyPackageFromInstruction({
      instruction,
      currentPackage: parsedCurrent.pkg,
      lastKnownGood: parsedLastGood?.ok ? parsedLastGood.pkg : undefined,
    });

    return NextResponse.json({
      ok: true,
      instruction,
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
