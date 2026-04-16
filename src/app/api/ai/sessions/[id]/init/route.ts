import { NextResponse } from 'next/server';

import { AiSessionTransportNotImplementedError, createAiSessionService } from '@/lib/ai-sessions/service';

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

    const result = await aiSessionService.initializeTransport(id, body.bindToken);
    return NextResponse.json({ ok: true, session: result.session, transport: result.transport });
  } catch (error) {
    const { id } = await params;
    const session = await aiSessionService.getSession(id).catch(() => null);
    const transport = await aiSessionService.getTransportSnapshot(id).catch(() => null);
    if (error instanceof AiSessionTransportNotImplementedError) {
      return NextResponse.json(
        { ok: false, error: error.message, code: error.reason, session, transport },
        { status: 502 },
      );
    }
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : 'Failed to initialize Codex transport',
        code: error instanceof Error && 'code' in error ? String(error.code) : null,
        session,
        transport,
      },
      { status: 500 },
    );
  }
}
