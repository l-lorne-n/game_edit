import { NextResponse } from 'next/server';

import { createAiSessionService } from '@/lib/ai-sessions/service';

const aiSessionService = createAiSessionService();

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const session = await aiSessionService.getSession(id);
    if (!session) {
      return NextResponse.json({ ok: false, error: 'AI session not found' }, { status: 404 });
    }

    const { snapshot, initTranscript, turnTranscript } = await aiSessionService.listTransportLogs(id);
    return NextResponse.json({ ok: true, transport: snapshot, initTranscript, turnTranscript });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : 'Failed to load Codex logs' },
      { status: 500 },
    );
  }
}
