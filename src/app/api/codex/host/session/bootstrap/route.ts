import { NextResponse } from 'next/server';

import { getHostTokenService } from '@/lib/host-tokens/server';
import { HostTokenRouteAuthError, assertHostTokenServiceAuth } from '@/lib/host-tokens/server/http';

export async function POST(request: Request) {
  try {
    assertHostTokenServiceAuth(request);
    const body = (await request.json()) as { sessionId?: string; bindToken?: string };
    if (!body.sessionId?.trim() || !body.bindToken?.trim()) {
      return NextResponse.json({ error: 'sessionId and bindToken are required' }, { status: 400 });
    }
    const service = getHostTokenService();
    await service.init();
    const response = await service.bootstrapWithBindToken(body.sessionId, body.bindToken);
    return NextResponse.json(response);
  } catch (error) {
    const status = error instanceof HostTokenRouteAuthError ? error.status : 500;
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to bootstrap host token session' },
      { status },
    );
  }
}
