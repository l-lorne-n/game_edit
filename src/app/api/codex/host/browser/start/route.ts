import { NextResponse } from 'next/server';

import { getHostTokenService } from '@/lib/host-tokens/server';
import { ensureBrowserCallbackServerStarted } from '@/lib/host-tokens/server/browser-callback-server';
import { loadHostTokenServerConfig } from '@/lib/host-tokens/server/config';

export async function GET() {
  try {
    const service = getHostTokenService();
    await service.init();
    ensureBrowserCallbackServerStarted(service, loadHostTokenServerConfig());
    const start = await service.beginBrowserOAuth();
    return NextResponse.json(start, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to begin browser OAuth' },
      { status: 500 },
    );
  }
}
