import { NextResponse } from 'next/server';

import { createAiSessionService } from '@/lib/ai-sessions/service';

const aiSessionService = createAiSessionService();

function toSseEvent(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

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

    const events = await aiSessionService.listEvents(id);
    const transport = await aiSessionService.getTransportSnapshot(id);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode(toSseEvent({ type: 'session.snapshot', session, events, transport })));
        controller.close();
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      },
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : 'Failed to stream AI session events' },
      { status: 500 },
    );
  }
}
