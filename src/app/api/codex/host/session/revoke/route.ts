import { NextResponse } from 'next/server';

import { getHostTokenService } from '@/lib/host-tokens/server';
import { HostTokenRouteAuthError, assertHostTokenServiceAuth } from '@/lib/host-tokens/server/http';

export async function POST(request: Request) {
  try {
    assertHostTokenServiceAuth(request);
    const body = (await request.json()) as { sessionId?: string };
    if (!body.sessionId?.trim()) {
      return NextResponse.json({ error: 'sessionId is required' }, { status: 400 });
    }
    const service = getHostTokenService();
    await service.init();
    await service.revoke(body.sessionId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    const status = error instanceof HostTokenRouteAuthError ? error.status : 500;
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to revoke host token session' },
      { status },
    );
  }
}
