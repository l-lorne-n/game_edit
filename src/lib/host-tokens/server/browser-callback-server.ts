import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { HostTokenService } from '@/lib/host-tokens/server/service';
import type { HostTokenServerConfig } from '@/lib/host-tokens/server/config';

let callbackServerStarted = false;

function renderSuccessHtml(appUrl: string): string {
  return `<!doctype html>
<html lang="en">
  <body>
    <script>
      (function () {
        const payload = { type: 'host-auth-complete' };
        if (window.opener && typeof window.opener.postMessage === 'function') {
          window.opener.postMessage(payload, ${JSON.stringify(appUrl)});
        }
        setTimeout(() => window.close(), 1200);
        setTimeout(() => { window.location.replace(${JSON.stringify(appUrl)}); }, 1500);
      })();
    </script>
    <p>Host authentication completed. You can return to the app.</p>
  </body>
</html>`;
}

function renderErrorHtml(title: string, description: string): string {
  return `<!doctype html>
<html lang="en">
  <body>
    <h1>${escapeHtml(title)}</h1>
    <pre>${escapeHtml(description)}</pre>
  </body>
</html>`;
}

export function ensureBrowserCallbackServerStarted(service: HostTokenService, config: HostTokenServerConfig): void {
  if (callbackServerStarted) {
    return;
  }

  const server = createServer(async (request, response) => {
    await handleBrowserCallback(request, response, service, config);
  });

  server.listen(config.oauth.callbackPort, '127.0.0.1', () => {
    callbackServerStarted = true;
  });
}

async function handleBrowserCallback(
  request: IncomingMessage,
  response: ServerResponse,
  service: HostTokenService,
  config: HostTokenServerConfig,
): Promise<void> {
  const url = new URL(request.url ?? '/', config.oauth.redirectUri);
  if (request.method !== 'GET' || url.pathname !== config.oauth.callbackPath) {
    respondHtml(response, 404, 'Not found');
    return;
  }

  const state = url.searchParams.get('state') ?? undefined;
  const code = url.searchParams.get('code') ?? undefined;
  const error = url.searchParams.get('error') ?? undefined;
  const errorDescription = url.searchParams.get('error_description') ?? undefined;
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';

  try {
    if (error) {
      respondHtml(response, 400, renderErrorHtml('Authorization Failed', errorDescription ?? error));
      return;
    }

    if (!code || !state) {
      respondHtml(response, 400, renderErrorHtml('Authorization Failed', 'Missing OAuth code or state in callback'));
      return;
    }

    await service.completeBrowserOAuth({ code, state });
    respondHtml(response, 200, renderSuccessHtml(appUrl));
  } catch (caught) {
    respondHtml(
      response,
      400,
      renderErrorHtml('Authorization Failed', caught instanceof Error ? caught.message : String(caught)),
    );
  }
}

function respondHtml(response: ServerResponse, status: number, html: string): void {
  response.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  response.end(html);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
