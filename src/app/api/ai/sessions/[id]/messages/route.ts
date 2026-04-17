import { NextResponse } from 'next/server';

import {
  AiSessionMessageNotReadyError,
  AiSessionTurnConflictError,
  AiSessionTransportNotInitializedError,
  AiSessionTransportNotImplementedError,
  createAiSessionService,
} from '@/lib/ai-sessions/service';

const aiSessionService = createAiSessionService();

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = (await request.json()) as {
      mode?: 'create' | 'modify' | 'debug';
      requestText?: string;
      targetId?: string | null;
      routeMode?: 'design' | 'patch' | 'repair' | null;
      routeReason?: string | null;
      allowedPaths?: string[];
    };

    if (!body.mode || !body.requestText?.trim()) {
      return NextResponse.json({ ok: false, error: 'mode and requestText are required' }, { status: 400 });
    }

    const result = await aiSessionService.submitMessageTurn(id, {
      mode: body.mode,
      requestText: body.requestText,
      targetId: body.targetId ?? null,
      routeMode: body.routeMode ?? null,
      routeReason: body.routeReason ?? null,
      allowedPaths: body.allowedPaths,
    });

    return NextResponse.json({ ok: true, result });
  } catch (error) {
    if (error instanceof AiSessionTransportNotInitializedError) {
      return NextResponse.json({ ok: false, error: error.message, code: error.code }, { status: 409 });
    }
    if (error instanceof AiSessionMessageNotReadyError) {
      return NextResponse.json({ ok: false, error: error.message, code: error.code }, { status: 409 });
    }
    if (error instanceof AiSessionTurnConflictError) {
      return NextResponse.json({ ok: false, error: error.message, code: error.code }, { status: 409 });
    }
    if (error instanceof AiSessionTransportNotImplementedError) {
      return NextResponse.json({ ok: false, error: error.message, code: error.reason }, { status: 502 });
    }

    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : 'Failed to execute AI session message' },
      { status: 500 },
    );
  }
}
