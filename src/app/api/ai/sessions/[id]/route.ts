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

    const transport = await aiSessionService.getTransportSnapshot(id);

    return NextResponse.json({ ok: true, session, transport });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : 'Failed to load AI session' },
      { status: 500 },
    );
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const session = await aiSessionService.revokeSession(id);
    return NextResponse.json({ ok: true, session, transport: null });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : 'Failed to revoke AI session' },
      { status: 500 },
    );
  }
}
