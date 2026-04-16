import { NextResponse } from 'next/server';

import { createAiSessionService } from '@/lib/ai-sessions/service';

const aiSessionService = createAiSessionService();

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = (await request.json()) as { idempotencyKey?: string };
    const idempotencyKey = body.idempotencyKey?.trim();

    if (!idempotencyKey) {
      return NextResponse.json({ ok: false, error: 'idempotencyKey is required' }, { status: 400 });
    }

    const result = await aiSessionService.checkpointSession(id, idempotencyKey);
    const status = result.checkpoint.status === 'conflict' ? 409 : 200;

    return NextResponse.json({ ok: true, ...result }, { status });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : 'Failed to checkpoint AI session' },
      { status: 500 },
    );
  }
}
