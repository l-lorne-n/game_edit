import { NextResponse } from 'next/server';

import { getHostTokenService } from '@/lib/host-tokens/server';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ authRequestId: string }> },
) {
  try {
    const { authRequestId } = await params;
    const service = getHostTokenService();
    await service.init();
    const attempt = await service.getBrowserAuthAttemptSummary(authRequestId);
    if (!attempt) {
      return NextResponse.json({ error: 'Browser auth attempt not found' }, { status: 404 });
    }
    return NextResponse.json(attempt);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to load browser auth attempt' },
      { status: 500 },
    );
  }
}
