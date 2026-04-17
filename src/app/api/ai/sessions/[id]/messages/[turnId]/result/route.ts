import { NextResponse } from 'next/server';

import { AiSessionMessageNotReadyError, createAiSessionService } from '@/lib/ai-sessions/service';

const aiSessionService = createAiSessionService();

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; turnId: string }> },
) {
  try {
    const { id, turnId } = await params;
    const result = await aiSessionService.getMessageTurnResult(id, turnId);
    return NextResponse.json({ ok: true, result });
  } catch (error) {
    if (error instanceof AiSessionMessageNotReadyError) {
      return NextResponse.json({ ok: false, error: error.message, code: error.code }, { status: 409 });
    }
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : 'Failed to load AI session turn result' },
      { status: 500 },
    );
  }
}
