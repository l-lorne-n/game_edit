import { NextResponse } from 'next/server';

import { generatePackageFromPrompt } from '@/lib/ai/generate-package';
import { parseGeneratedGamePackage } from '@/lib/package/contracts';

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      prompt?: string;
      lastKnownGoodPackage?: unknown;
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
