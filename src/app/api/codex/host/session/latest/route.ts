import { NextResponse } from 'next/server';

import { getHostTokenService } from '@/lib/host-tokens/server';

export async function GET() {
  try {
    const service = getHostTokenService();
    await service.init();
    const session = await service.getLatestSession();
    if (!session) {
      return NextResponse.json({ found: false });
    }
    return NextResponse.json({ found: true, session });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to load latest host token session' },
      { status: 500 },
    );
  }
}
