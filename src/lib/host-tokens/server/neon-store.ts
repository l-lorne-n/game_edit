import { desc, eq, sql } from 'drizzle-orm';

import {
  getDb,
  hostAuthBindings,
  hostAuthPendingStates,
  hostAuthSessions,
  hostBrowserAuthAttempts,
} from '@/lib/db';
import type {
  AiSessionBinding,
  BrowserAuthAttempt,
  HostAuthSession,
  PendingOAuthState,
} from '@/lib/host-tokens/server/store';

export class NeonHostTokenStore {
  async init(): Promise<void> {
    const db = getDb();
    await db.execute(sql`
      create table if not exists host_auth_pending_states (
        state text primary key,
        auth_request_id text not null,
        verifier text not null,
        redirect_uri text not null,
        created_at timestamptz not null,
        expires_at timestamptz not null
      )
    `);
    await db.execute(sql`
      create table if not exists host_browser_auth_attempts (
        auth_request_id text primary key,
        state text not null,
        authorize_url text not null,
        redirect_uri text not null,
        status text not null,
        auth_session_id text,
        account_id text,
        plan_type text,
        error text,
        error_description text,
        created_at timestamptz not null,
        expires_at timestamptz not null,
        updated_at timestamptz not null
      )
    `);
    await db.execute(sql`
      create table if not exists host_auth_sessions (
        auth_session_id text primary key,
        access_token text not null,
        refresh_token text not null,
        id_token text,
        bind_token text,
        bind_token_expires_at timestamptz,
        expires_at timestamptz not null,
        account_id text,
        plan_type text,
        created_at timestamptz not null,
        updated_at timestamptz not null,
        revoked_at timestamptz
      )
    `);
    await db.execute(sql`
      create table if not exists host_auth_bindings (
        ai_session_id text primary key,
        auth_session_id text not null references host_auth_sessions(auth_session_id) on delete cascade,
        created_at timestamptz not null,
        updated_at timestamptz not null,
        revoked_at timestamptz
      )
    `);
  }

  async savePendingState(state: PendingOAuthState): Promise<void> {
    const db = getDb();
    await db
      .insert(hostAuthPendingStates)
      .values({
        state: state.state,
        authRequestId: state.authRequestId,
        verifier: state.verifier,
        redirectUri: state.redirectUri,
        createdAt: new Date(state.createdAt),
        expiresAt: new Date(state.expiresAt),
      })
      .onConflictDoUpdate({
        target: hostAuthPendingStates.state,
        set: {
          authRequestId: state.authRequestId,
          verifier: state.verifier,
          redirectUri: state.redirectUri,
          createdAt: new Date(state.createdAt),
          expiresAt: new Date(state.expiresAt),
        },
      });
  }

  async consumePendingState(state: string): Promise<PendingOAuthState | undefined> {
    const db = getDb();
    const current = await db.query.hostAuthPendingStates.findFirst({ where: eq(hostAuthPendingStates.state, state) });
    if (!current) {
      return undefined;
    }
    await db.delete(hostAuthPendingStates).where(eq(hostAuthPendingStates.state, state));
    return {
      authRequestId: current.authRequestId,
      state: current.state,
      verifier: current.verifier,
      redirectUri: current.redirectUri,
      createdAt: current.createdAt.getTime(),
      expiresAt: current.expiresAt.getTime(),
    };
  }

  async saveBrowserAuthAttempt(attempt: BrowserAuthAttempt): Promise<void> {
    const db = getDb();
    await db
      .insert(hostBrowserAuthAttempts)
      .values({
        authRequestId: attempt.authRequestId,
        state: attempt.state,
        authorizeUrl: attempt.authorizeUrl,
        redirectUri: attempt.redirectUri,
        status: attempt.status,
        authSessionId: attempt.authSessionId ?? null,
        accountId: attempt.accountId ?? null,
        planType: attempt.planType ?? null,
        error: attempt.error ?? null,
        errorDescription: attempt.errorDescription ?? null,
        createdAt: new Date(attempt.createdAt),
        expiresAt: new Date(attempt.expiresAt),
        updatedAt: new Date(attempt.updatedAt),
      })
      .onConflictDoUpdate({
        target: hostBrowserAuthAttempts.authRequestId,
        set: {
          state: attempt.state,
          authorizeUrl: attempt.authorizeUrl,
          redirectUri: attempt.redirectUri,
          status: attempt.status,
          authSessionId: attempt.authSessionId ?? null,
          accountId: attempt.accountId ?? null,
          planType: attempt.planType ?? null,
          error: attempt.error ?? null,
          errorDescription: attempt.errorDescription ?? null,
          expiresAt: new Date(attempt.expiresAt),
          updatedAt: new Date(attempt.updatedAt),
        },
      });
  }

  async getBrowserAuthAttempt(authRequestId: string): Promise<BrowserAuthAttempt | undefined> {
    const db = getDb();
    const row = await db.query.hostBrowserAuthAttempts.findFirst({ where: eq(hostBrowserAuthAttempts.authRequestId, authRequestId) });
    return row ? this.toBrowserAuthAttempt(row) : undefined;
  }

  async getBrowserAuthAttemptByState(state: string): Promise<BrowserAuthAttempt | undefined> {
    const db = getDb();
    const row = await db.query.hostBrowserAuthAttempts.findFirst({ where: eq(hostBrowserAuthAttempts.state, state) });
    return row ? this.toBrowserAuthAttempt(row) : undefined;
  }

  async saveAuthSession(session: HostAuthSession): Promise<void> {
    const db = getDb();
    await db
      .insert(hostAuthSessions)
      .values({
        authSessionId: session.authSessionId,
        accessToken: session.accessToken,
        refreshToken: session.refreshToken,
        idToken: session.idToken ?? null,
        bindToken: session.bindToken ?? null,
        bindTokenExpiresAt: session.bindTokenExpiresAt ? new Date(session.bindTokenExpiresAt) : null,
        expiresAt: new Date(session.expiresAt),
        accountId: session.accountId ?? null,
        planType: session.planType ?? null,
        createdAt: new Date(session.createdAt),
        updatedAt: new Date(session.updatedAt),
        revokedAt: session.revokedAt ? new Date(session.revokedAt) : null,
      })
      .onConflictDoUpdate({
        target: hostAuthSessions.authSessionId,
        set: {
          accessToken: session.accessToken,
          refreshToken: session.refreshToken,
          idToken: session.idToken ?? null,
          bindToken: session.bindToken ?? null,
          bindTokenExpiresAt: session.bindTokenExpiresAt ? new Date(session.bindTokenExpiresAt) : null,
          expiresAt: new Date(session.expiresAt),
          accountId: session.accountId ?? null,
          planType: session.planType ?? null,
          updatedAt: new Date(session.updatedAt),
          revokedAt: session.revokedAt ? new Date(session.revokedAt) : null,
        },
      });
  }

  async getAuthSession(authSessionId: string): Promise<HostAuthSession | undefined> {
    const db = getDb();
    const row = await db.query.hostAuthSessions.findFirst({ where: eq(hostAuthSessions.authSessionId, authSessionId) });
    return row ? this.toHostAuthSession(row) : undefined;
  }

  async getLatestActiveAuthSession(): Promise<HostAuthSession | undefined> {
    const db = getDb();
    const row = await db.query.hostAuthSessions.findFirst({
      where: sql`${hostAuthSessions.revokedAt} is null`,
      orderBy: [desc(hostAuthSessions.updatedAt)],
    });
    return row ? this.toHostAuthSession(row) : undefined;
  }

  async saveBinding(binding: AiSessionBinding): Promise<void> {
    const db = getDb();
    await db
      .insert(hostAuthBindings)
      .values({
        aiSessionId: binding.aiSessionId,
        authSessionId: binding.authSessionId,
        createdAt: new Date(binding.createdAt),
        updatedAt: new Date(binding.updatedAt),
        revokedAt: binding.revokedAt ? new Date(binding.revokedAt) : null,
      })
      .onConflictDoUpdate({
        target: hostAuthBindings.aiSessionId,
        set: {
          authSessionId: binding.authSessionId,
          updatedAt: new Date(binding.updatedAt),
          revokedAt: binding.revokedAt ? new Date(binding.revokedAt) : null,
        },
      });
  }

  async getBinding(aiSessionId: string): Promise<AiSessionBinding | undefined> {
    const db = getDb();
    const row = await db.query.hostAuthBindings.findFirst({ where: eq(hostAuthBindings.aiSessionId, aiSessionId) });
    return row
      ? {
          aiSessionId: row.aiSessionId,
          authSessionId: row.authSessionId,
          createdAt: row.createdAt.getTime(),
          updatedAt: row.updatedAt.getTime(),
          revokedAt: row.revokedAt?.getTime(),
        }
      : undefined;
  }

  private toBrowserAuthAttempt(input: typeof hostBrowserAuthAttempts.$inferSelect): BrowserAuthAttempt {
    return {
      authRequestId: input.authRequestId,
      state: input.state,
      authorizeUrl: input.authorizeUrl,
      redirectUri: input.redirectUri,
      status: input.status,
      authSessionId: input.authSessionId ?? undefined,
      accountId: input.accountId ?? undefined,
      planType: input.planType,
      error: input.error ?? undefined,
      errorDescription: input.errorDescription ?? undefined,
      createdAt: input.createdAt.getTime(),
      expiresAt: input.expiresAt.getTime(),
      updatedAt: input.updatedAt.getTime(),
    };
  }

  private toHostAuthSession(input: typeof hostAuthSessions.$inferSelect): HostAuthSession {
    return {
      authSessionId: input.authSessionId,
      accessToken: input.accessToken,
      refreshToken: input.refreshToken,
      idToken: input.idToken ?? undefined,
      bindToken: input.bindToken ?? undefined,
      bindTokenExpiresAt: input.bindTokenExpiresAt?.getTime(),
      expiresAt: input.expiresAt.getTime(),
      accountId: input.accountId ?? undefined,
      planType: input.planType,
      createdAt: input.createdAt.getTime(),
      updatedAt: input.updatedAt.getTime(),
      revokedAt: input.revokedAt?.getTime(),
    };
  }
}
