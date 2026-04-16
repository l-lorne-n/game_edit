import {
  getHostTokenServiceApiKey,
  getHostTokenServiceBaseUrl,
} from '@/lib/config/infra';
import type {
  HostTokenBootstrapRequest,
  HostTokenBootstrapResponse,
  HostTokenRefreshRequest,
  HostTokenRefreshResponse,
  HostTokenSessionMetadata,
} from '@/lib/host-tokens/types';

type FetchLike = typeof fetch;

export class HostTokenServiceError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status = 500, code = 'host_token_service_error') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function parseJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

export class HostTokenServiceClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey?: string,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  static fromEnv(fetchImpl?: FetchLike) {
    const baseUrl = getHostTokenServiceBaseUrl();
    if (!baseUrl) {
      throw new HostTokenServiceError('HOST_TOKEN_SERVICE_URL is not configured.', 500, 'host_token_service_unconfigured');
    }

    return new HostTokenServiceClient(baseUrl, getHostTokenServiceApiKey(), fetchImpl);
  }

  async bootstrap(input: HostTokenBootstrapRequest): Promise<HostTokenBootstrapResponse> {
    return this.post<HostTokenBootstrapResponse>('/api/codex/host/session/bootstrap', input);
  }

  async refresh(input: HostTokenRefreshRequest): Promise<HostTokenRefreshResponse> {
    return this.post<HostTokenRefreshResponse>('/api/codex/host/session/refresh', input);
  }

  async revoke(sessionId: string): Promise<void> {
    await this.post<{ ok: true }>('/api/codex/host/session/revoke', { sessionId });
  }

  async getSession(sessionId: string): Promise<HostTokenSessionMetadata> {
    const response = await this.fetchImpl(this.toUrl(`/api/codex/host/session/${encodeURIComponent(sessionId)}`), {
      method: 'GET',
      headers: this.headers(),
      cache: 'no-store',
    });

    if (!response.ok) {
      throw await this.toError(response);
    }

    return parseJson<HostTokenSessionMetadata>(response);
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  getApiKey(): string | undefined {
    return this.apiKey;
  }

  private async post<T>(path: string, body: object): Promise<T> {
    const response = await this.fetchImpl(this.toUrl(path), {
      method: 'POST',
      headers: {
        ...this.headers(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      cache: 'no-store',
    });

    if (!response.ok) {
      throw await this.toError(response);
    }

    return parseJson<T>(response);
  }

  private headers() {
    return {
      ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
    };
  }

  private toUrl(path: string): string {
    return new URL(path, this.baseUrl).toString();
  }

  private async toError(response: Response): Promise<HostTokenServiceError> {
    const fallback = `Host token service request failed (${response.status})`;

    try {
      const data = await response.json() as { error?: string; code?: string };
      return new HostTokenServiceError(data.error ?? fallback, response.status, data.code ?? 'host_token_service_error');
    } catch {
      return new HostTokenServiceError(fallback, response.status, 'host_token_service_error');
    }
  }
}
