import { NextResponse } from 'next/server';

import { getHostTokenService } from '@/lib/host-tokens/server';

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    if (!code || !state) {
      return NextResponse.json({ error: 'code and state are required' }, { status: 400 });
    }

    const service = getHostTokenService();
    await service.init();
    const session = await service.completeBrowserOAuth({ code, state });
    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
    const html = `<!doctype html>
<html>
  <body>
    <script>
      (function () {
        const payload = ${JSON.stringify({ type: 'host-auth-complete', session })};
        if (window.opener && typeof window.opener.postMessage === 'function') {
          window.opener.postMessage(payload, ${JSON.stringify(appUrl)});
        }
        window.location.replace(${JSON.stringify(appUrl)});
      })();
    </script>
    <p>Host authentication completed. You can close this window.</p>
  </body>
</html>`;
    return new Response(html, {
      status: 201,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to complete browser OAuth' },
      { status: 500 },
    );
  }
}
