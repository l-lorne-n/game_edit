import { createHash, randomBytes, randomUUID } from 'node:crypto';

import type {
  HostTokenBootstrapResponse,
  HostTokenRefreshResponse,
  HostTokenSessionMetadata,
} from '@/lib/host-tokens/types';
import type { HostTokenServerConfig } from '@/lib/host-tokens/server/config';
import { loadHostTokenServerConfig } from '@/lib/host-tokens/server/config';
import {
  type BrowserAuthAttempt,
  type HostAuthSession,
  type HostTokenStore,
  type PendingOAuthState,
  FileHostTokenStore,
} from '@/lib/host-tokens/server/store';

const PENDING_STATE_TTL_MS = 10 * 60 * 1000;
const REFRESH_SAFETY_WINDOW_MS = 30_000;

type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
};

type JwtClaims = {
  chatgpt_account_id?: string;
  chatgpt_plan_type?: string;
  organizations?: Array<{ id: string }>;
  ['https://api.openai.com/auth']?: {
    chatgpt_account_id?: string;
    chatgpt_plan_type?: string;
  };
};

export type BrowserOAuthStart = {
  authRequestId: string;
  authorizeUrl: string;
  state: string;
  redirectUri: string;
  expiresAt: number;
};

function getTokenExpiry(tokens: TokenResponse, now = Date.now()): number {
  return now + (tokens.expires_in ?? 3600) * 1000;
}

export class HostTokenService {
  constructor(private readonly store: HostTokenStore = new FileHostTokenStore(loadHostTokenServerConfig().storageDir)) {}

  async init(): Promise<void> {
    await this.store.init();
  }

  async beginBrowserOAuth(): Promise<BrowserOAuthStart> {
    const config = loadHostTokenServerConfig();
    const authRequestId = randomUUID();
    const state = randomBytes(18).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const expiresAt = Date.now() + PENDING_STATE_TTL_MS;

    const authorizeUrl = new URL('/oauth/authorize', config.oauth.issuer);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('client_id', config.oauth.clientId);
    authorizeUrl.searchParams.set('redirect_uri', config.oauth.redirectUri);
    authorizeUrl.searchParams.set('scope', config.oauth.scopes.join(' '));
    authorizeUrl.searchParams.set('code_challenge', challenge);
    authorizeUrl.searchParams.set('code_challenge_method', 'S256');
    authorizeUrl.searchParams.set('id_token_add_organizations', 'true');
    authorizeUrl.searchParams.set('codex_cli_simplified_flow', 'true');
    authorizeUrl.searchParams.set('state', state);
    authorizeUrl.searchParams.set('originator', config.oauth.originator);

    await this.store.savePendingState({
      authRequestId,
      state,
      verifier,
      redirectUri: config.oauth.redirectUri,
      createdAt: Date.now(),
      expiresAt,
    } satisfies PendingOAuthState);
    await this.store.saveBrowserAuthAttempt({
      authRequestId,
      state,
      authorizeUrl: authorizeUrl.toString(),
      redirectUri: config.oauth.redirectUri,
      status: 'pending',
      createdAt: Date.now(),
      expiresAt,
      updatedAt: Date.now(),
    } satisfies BrowserAuthAttempt);

    return {
      authRequestId,
      authorizeUrl: authorizeUrl.toString(),
      state,
      redirectUri: config.oauth.redirectUri,
      expiresAt,
    };
  }

  async completeBrowserOAuth(input: { code: string; state: string }): Promise<HostTokenSessionMetadata> {
    const config = loadHostTokenServerConfig();
    const pending = await this.store.consumePendingState(input.state);
    if (!pending || pending.expiresAt <= Date.now()) {
      throw new Error('OAuth state is missing or expired.');
    }

    const tokens = await this.exchangeAuthorizationCode(input.code, pending, config.oauth);
    const session = this.toSession(tokens, undefined, {
      bindToken: randomBytes(24).toString('base64url'),
      bindTokenExpiresAt: getTokenExpiry(tokens),
    });
    await this.store.saveAuthSession(session);
    const attempt = await this.store.getBrowserAuthAttempt(pending.authRequestId);
    if (attempt) {
      await this.store.saveBrowserAuthAttempt({
        ...attempt,
        status: 'completed',
        authSessionId: session.authSessionId,
        accountId: session.accountId,
        planType: session.planType ?? null,
        updatedAt: Date.now(),
      });
    }

    return this.toMetadata(session);
  }

  async getBrowserAuthAttemptSummary(authRequestId: string): Promise<BrowserAuthAttempt | null> {
    return (await this.store.getBrowserAuthAttempt(authRequestId)) ?? null;
  }

  async bootstrap(aiSessionId: string): Promise<HostTokenBootstrapResponse> {
    throw new Error('bindToken is required for bootstrap; use bootstrapWithBindToken().');
  }

  async bootstrapWithBindToken(aiSessionId: string, bindToken: string): Promise<HostTokenBootstrapResponse> {
    const session = await this.resolveBoundSession(aiSessionId, {
      forceRefresh: false,
      allowAutoBind: true,
      bindToken,
    });
    return {
      sessionId: aiSessionId,
      idToken: session.idToken ?? '',
      accessToken: session.accessToken,
      expiresAt: session.expiresAt,
      accountId: session.accountId,
      planType: session.planType ?? null,
    };
  }

  async refresh(aiSessionId: string, previousAccountId?: string | null): Promise<HostTokenRefreshResponse> {
    const session = await this.resolveBoundSession(aiSessionId, {
      forceRefresh: true,
      allowAutoBind: false,
      previousAccountId: previousAccountId ?? undefined,
    });
    return {
      sessionId: aiSessionId,
      idToken: session.idToken ?? '',
      accessToken: session.accessToken,
      expiresAt: session.expiresAt,
      accountId: session.accountId,
      planType: session.planType ?? null,
    };
  }

  async revoke(aiSessionId: string): Promise<void> {
    const binding = await this.store.getBinding(aiSessionId);
    if (!binding) {
      return;
    }
    await this.store.saveBinding({
      ...binding,
      revokedAt: Date.now(),
      updatedAt: Date.now(),
    });
  }

  async getSession(aiSessionId: string): Promise<HostTokenSessionMetadata | null> {
    const binding = await this.store.getBinding(aiSessionId);
    if (!binding || binding.revokedAt) {
      return null;
    }
    const session = await this.store.getAuthSession(binding.authSessionId);
    return session ? this.toMetadata(session) : null;
  }

  async getLatestSession(): Promise<HostTokenSessionMetadata | null> {
    const session = await this.store.getLatestActiveAuthSession();
    return session ? this.toMetadata(session) : null;
  }

  private async resolveBoundSession(
    aiSessionId: string,
    options: {
      forceRefresh: boolean;
      allowAutoBind: boolean;
      bindToken?: string;
      previousAccountId?: string;
    },
  ): Promise<HostAuthSession> {
    const binding = await this.store.getBinding(aiSessionId);
    let session: HostAuthSession | undefined;

    if (binding?.revokedAt) {
      throw new Error('Host token binding for this AI session has been revoked.');
    }

    if (binding && !binding.revokedAt) {
      session = await this.store.getAuthSession(binding.authSessionId);
    }

    if (!session) {
      if (!options.allowAutoBind) {
        throw new Error('No active host token binding exists for this AI session.');
      }
      session = await this.store.getLatestActiveAuthSession();
      if (!session) {
        throw new Error('No active host auth session exists; complete browser login first.');
      }
      if (!options.bindToken || !session.bindToken || session.bindToken !== options.bindToken) {
        throw new Error('bindToken is required and must match an active host auth session.');
      }
      if (session.bindTokenExpiresAt && session.bindTokenExpiresAt <= Date.now()) {
        throw new Error('bindToken has expired; complete browser login again.');
      }
      await this.store.saveBinding({
        aiSessionId,
        authSessionId: session.authSessionId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }

    if (options.previousAccountId && session.accountId && options.previousAccountId !== session.accountId) {
      throw new Error('Host auth session account does not match previousAccountId.');
    }

    const stillFresh = !options.forceRefresh && session.expiresAt > Date.now() + REFRESH_SAFETY_WINDOW_MS;
    if (stillFresh) {
      return session;
    }

    if (!session.refreshToken) {
      throw new Error('Host auth session is missing a refresh token; sign in again.');
    }

    const config = loadHostTokenServerConfig();
    const refreshedTokens = await this.refreshAccessToken(session.refreshToken, config.oauth);
    const refreshedSession = this.toSession(refreshedTokens, session);
    await this.store.saveAuthSession(refreshedSession);
    return refreshedSession;
  }

  private async exchangeAuthorizationCode(code: string, pending: PendingOAuthState, oauth: HostTokenServerConfig['oauth']): Promise<TokenResponse> {
    const response = await fetch(new URL('/oauth/token', oauth.issuer), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: pending.redirectUri,
        client_id: oauth.clientId,
        code_verifier: pending.verifier,
      }).toString(),
    });

    if (!response.ok) {
      throw new Error(`OAuth authorization code exchange failed (${response.status}).`);
    }

    return (await response.json()) as TokenResponse;
  }

  private async refreshAccessToken(refreshToken: string, oauth: HostTokenServerConfig['oauth']): Promise<TokenResponse> {
    const response = await fetch(new URL('/oauth/token', oauth.issuer), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: oauth.clientId,
      }).toString(),
    });

    if (!response.ok) {
      throw new Error(`OAuth refresh token exchange failed (${response.status}).`);
    }

    return (await response.json()) as TokenResponse;
  }

  private toSession(
    tokens: TokenResponse,
    previous?: HostAuthSession,
    extras?: { bindToken?: string; bindTokenExpiresAt?: number },
  ): HostAuthSession {
    const now = Date.now();
    const expiresAt = getTokenExpiry(tokens, now);
    const idToken = tokens.id_token ?? previous?.idToken;
    const claims = parseJwtClaims(idToken ?? tokens.access_token);
    const bindToken = extras?.bindToken ?? previous?.bindToken;
    const bindTokenExpiresAt = bindToken
      ? Math.max(extras?.bindTokenExpiresAt ?? 0, previous?.bindTokenExpiresAt ?? 0, expiresAt)
      : undefined;
    return {
      authSessionId: previous?.authSessionId ?? randomUUID(),
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? previous?.refreshToken ?? '',
      ...(idToken ? { idToken } : {}),
      ...(bindToken ? { bindToken } : {}),
      ...(bindTokenExpiresAt ? { bindTokenExpiresAt } : {}),
      expiresAt,
      accountId: extractAccountId(claims) ?? previous?.accountId,
      planType: extractPlanType(claims) ?? previous?.planType ?? null,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    };
  }

  private toMetadata(session: HostAuthSession): HostTokenSessionMetadata {
    return {
      sessionId: session.authSessionId,
      expiresAt: session.expiresAt,
      accountId: session.accountId,
      revoked: Boolean(session.revokedAt),
      bindToken: session.bindToken,
    };
  }
}

function parseJwtClaims(token: string): JwtClaims | undefined {
  const parts = token.split('.');
  if (parts.length !== 3) {
    return undefined;
  }

  try {
    return JSON.parse(Buffer.from(parts[1] ?? '', 'base64url').toString('utf8')) as JwtClaims;
  } catch {
    return undefined;
  }
}

function extractAccountId(claims: JwtClaims | undefined): string | undefined {
  return claims?.chatgpt_account_id ?? claims?.['https://api.openai.com/auth']?.chatgpt_account_id ?? claims?.organizations?.[0]?.id;
}

function extractPlanType(claims: JwtClaims | undefined): string | null | undefined {
  return claims?.chatgpt_plan_type ?? claims?.['https://api.openai.com/auth']?.chatgpt_plan_type;
}
