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

    const versions = await aiSessionService.listWorkspaceVersions(id);
    return NextResponse.json({ ok: true, sessionId: id, versions });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : 'Failed to list Box session versions' },
      { status: 500 },
    );
  }
}
