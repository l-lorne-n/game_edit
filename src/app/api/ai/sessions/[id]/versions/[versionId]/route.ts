import { NextResponse } from 'next/server';

import { createAiSessionService } from '@/lib/ai-sessions/service';

const aiSessionService = createAiSessionService();

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; versionId: string }> },
) {
  try {
    const { id, versionId } = await params;
    const session = await aiSessionService.getSession(id);
    if (!session) {
      return NextResponse.json({ ok: false, error: 'AI session not found' }, { status: 404 });
    }

    const result = await aiSessionService.getWorkspaceVersionPayload(id, versionId);
    return NextResponse.json({ ok: true, sessionId: id, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load Box session version';
    const status = /not found|Unknown workspace version/i.test(message) ? 404 : 500;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
