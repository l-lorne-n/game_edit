import { NextResponse } from 'next/server';

import { createAiSessionService } from '@/lib/ai-sessions/service';

const aiSessionService = createAiSessionService();

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = (await request.json()) as { bindToken?: string };
    if (!body.bindToken?.trim()) {
      return NextResponse.json({ ok: false, error: 'bindToken is required' }, { status: 400 });
    }
    const session = await aiSessionService.bootstrapSession(id, body.bindToken);
    return NextResponse.json({ ok: true, session });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : 'Failed to bootstrap AI session' },
      { status: 500 },
    );
  }
}
