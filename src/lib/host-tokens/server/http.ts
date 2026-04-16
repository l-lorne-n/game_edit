import { timingSafeEqual } from 'node:crypto';

import { getHostTokenServiceApiKey } from '@/lib/config/infra';

export class HostTokenRouteAuthError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function equalsSafe(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}

export function assertHostTokenServiceAuth(request: Request): void {
  const expected = getHostTokenServiceApiKey();
  if (!expected) {
    throw new HostTokenRouteAuthError('HOST_TOKEN_SERVICE_API_KEY must be configured for privileged host token routes.', 503);
  }

  const header = request.headers.get('authorization');
  if (!header?.startsWith('Bearer ')) {
    throw new HostTokenRouteAuthError('Missing host token service bearer token.', 401);
  }

  const provided = header.slice('Bearer '.length).trim();
  if (!equalsSafe(expected, provided)) {
    throw new HostTokenRouteAuthError('Invalid host token service bearer token.', 401);
  }
}
