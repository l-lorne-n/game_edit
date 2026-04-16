import { NextResponse } from 'next/server';

import { getHostTokenService } from '@/lib/host-tokens/server';
import { HostTokenRouteAuthError, assertHostTokenServiceAuth } from '@/lib/host-tokens/server/http';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  try {
    assertHostTokenServiceAuth(request);
    const { sessionId } = await params;
    const service = getHostTokenService();
    await service.init();
    const session = await service.getSession(sessionId);
    if (!session) {
      return NextResponse.json({ error: 'Host token session not found' }, { status: 404 });
    }
    return NextResponse.json(session);
  } catch (error) {
    const status = error instanceof HostTokenRouteAuthError ? error.status : 500;
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to load host token session' },
      { status },
    );
  }
}
