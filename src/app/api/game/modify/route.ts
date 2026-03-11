import { NextResponse } from 'next/server';

import { modifyDslFromInstruction } from '@/lib/ai/generate-game';
import { parseSchemaOnly } from '@/lib/game/validate';

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      instruction?: string;
      currentDsl?: unknown;
      lastKnownGood?: unknown;
    };

    const instruction = body.instruction?.trim();
    if (!instruction) {
      return NextResponse.json({ error: 'instruction is required' }, { status: 400 });
    }

    const parsedCurrent = parseSchemaOnly(body.currentDsl);
    if (!parsedCurrent.ok) {
      return NextResponse.json(
        {
          error: 'currentDsl is required and must satisfy schema',
          schemaIssues: parsedCurrent.schema.issues,
        },
        { status: 400 },
      );
    }

    const parsedLastGood = body.lastKnownGood ? parseSchemaOnly(body.lastKnownGood) : undefined;
    const lastKnownGood = parsedLastGood && parsedLastGood.ok ? parsedLastGood.dsl : undefined;

    const result = await modifyDslFromInstruction(
      instruction,
      parsedCurrent.dsl,
      lastKnownGood,
    );

    return NextResponse.json({
      ok: true,
      instruction,
      dsl: result.dsl,
      validation: result.validation,
      repaired: result.repaired,
      fallbackUsed: result.fallbackUsed,
      source: result.source,
      provider: result.provider,
      model: result.model,
      statusMessage: result.statusMessage,
      attempts: result.attempts,
      lastKnownGood: result.dsl,
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
