import { NextResponse } from 'next/server';

import { generateDslFromPrompt } from '@/lib/ai/generate-game';
import { parseSchemaOnly, parseDslUnsafe } from '@/lib/game/validate';

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      prompt?: string;
      lastKnownGood?: unknown;
    };

    const prompt = body.prompt?.trim();
    if (!prompt) {
      return NextResponse.json({ error: 'prompt is required' }, { status: 400 });
    }

    const parsedLastGood = body.lastKnownGood ? parseSchemaOnly(body.lastKnownGood) : undefined;
    const lastKnownGood = parsedLastGood && parsedLastGood.ok ? parsedLastGood.dsl : undefined;

    const result = await generateDslFromPrompt(prompt, lastKnownGood);

    return NextResponse.json({
      ok: true,
      prompt,
      dsl: result.dsl,
      validation: result.validation,
      repaired: result.repaired,
      fallbackUsed: result.fallbackUsed,
      source: result.source,
      provider: result.provider,
      model: result.model,
      statusMessage: result.statusMessage,
      attempts: result.attempts,
      lastKnownGood: parseDslUnsafe(result.dsl),
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
