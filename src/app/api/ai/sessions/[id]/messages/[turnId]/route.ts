import { NextResponse } from 'next/server';

import { createAiSessionService } from '@/lib/ai-sessions/service';

const aiSessionService = createAiSessionService();

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; turnId: string }> },
) {
  try {
    const { id, turnId } = await params;
    const status = await aiSessionService.getMessageTurnStatus(id, turnId);
    return NextResponse.json({ ok: true, status });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : 'Failed to load AI session turn status' },
      { status: 500 },
    );
  }
}
