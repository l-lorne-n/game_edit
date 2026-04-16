import { randomUUID } from 'node:crypto';

import { and, asc, eq, sql } from 'drizzle-orm';

import {
  aiSessionCheckpoints,
  aiSessionEvents,
  aiSessions,
  getDb,
} from '@/lib/db';
import type {
  AiSessionCheckpointRecord,
  AiSessionContinuityState,
  AiSessionDaemonState,
  AiSessionEventRecord,
  AiSessionRecord,
  AiSessionRepository,
  AiSessionResumeEligibility,
  CreateAiSessionCheckpointInput,
  CreateAiSessionEventInput,
  UpdateAiSessionInput,
} from '@/lib/ai-sessions/types';

let aiSessionSchemaInitPromise: Promise<void> | null = null;

async function ensureAiSessionSchema(): Promise<void> {
  if (!aiSessionSchemaInitPromise) {
    aiSessionSchemaInitPromise = (async () => {
      const db = getDb();
      await db.execute(sql`
        do $$ begin
          create type ai_session_state as enum ('provisioning','hydrating','ready','busy','checkpointing','auth_blocked','failed','revoked','terminating','terminated');
        exception when duplicate_object then null;
        end $$;
      `);
      await db.execute(sql`
        do $$ begin
          create type ai_session_auth_mode as enum ('chatgptAuthTokens');
        exception when duplicate_object then null;
        end $$;
      `);
      await db.execute(sql`
        do $$ begin
          create type ai_session_auth_state as enum ('bootstrap_pending','ready','refreshing','blocked','revoked');
        exception when duplicate_object then null;
        end $$;
      `);
      await db.execute(sql`
        do $$ begin
          create type ai_session_box_state as enum ('unassigned','provisioning','ready','busy','failed','terminating','terminated');
        exception when duplicate_object then null;
        end $$;
      `);
      await db.execute(sql`
        do $$ begin
          create type ai_session_app_server_state as enum ('unassigned','starting','healthy','degraded','failed','stopped');
        exception when duplicate_object then null;
        end $$;
      `);
      await db.execute(sql`
        do $$ begin
          create type ai_session_checkpoint_state as enum ('pending','committed','conflict','failed');
        exception when duplicate_object then null;
        end $$;
      `);
      await db.execute(sql`
        create table if not exists ai_sessions (
          id text primary key,
          project_id text not null references projects(id) on delete cascade,
          owner_id text not null,
          base_version integer not null,
          status ai_session_state not null default 'provisioning',
          auth_mode ai_session_auth_mode not null default 'chatgptAuthTokens',
          auth_state ai_session_auth_state not null default 'bootstrap_pending',
          box_id text,
          codex_home_key text,
          box_status ai_session_box_state not null default 'unassigned',
          app_server_status ai_session_app_server_state not null default 'unassigned',
          daemon_status text not null default 'stopped',
          app_server_thread_id text,
          thread_materialized_at timestamptz,
          continuity_state text not null default 'new',
          resume_eligibility text not null default 'not_resumable',
          supervisor_instance_id text,
          supervisor_lease_epoch integer not null default 0,
          last_supervisor_heartbeat_at timestamptz,
          last_failure_code text,
          current_lease_token text not null,
          lease_heartbeat_at timestamptz not null default now(),
          lease_expires_at timestamptz not null,
          last_checkpoint_version integer,
          last_checkpoint_id text,
          revoked_at timestamptz,
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now()
        )
      `);
      await db.execute(sql`alter table ai_sessions add column if not exists codex_home_key text`);
      await db.execute(sql`alter table ai_sessions add column if not exists daemon_status text not null default 'stopped'`);
      await db.execute(sql`alter table ai_sessions add column if not exists thread_materialized_at timestamptz`);
      await db.execute(sql`alter table ai_sessions add column if not exists continuity_state text not null default 'new'`);
      await db.execute(sql`alter table ai_sessions add column if not exists resume_eligibility text not null default 'not_resumable'`);
      await db.execute(sql`alter table ai_sessions add column if not exists supervisor_instance_id text`);
      await db.execute(sql`alter table ai_sessions add column if not exists supervisor_lease_epoch integer not null default 0`);
      await db.execute(sql`alter table ai_sessions add column if not exists last_supervisor_heartbeat_at timestamptz`);
      await db.execute(sql`alter table ai_sessions add column if not exists last_failure_code text`);
      await db.execute(sql`
        create table if not exists ai_session_events (
          id text primary key,
          session_id text not null references ai_sessions(id) on delete cascade,
          type text not null,
          payload jsonb not null default '{}'::jsonb,
          created_at timestamptz not null default now()
        )
      `);
      await db.execute(sql`
        create table if not exists ai_session_checkpoints (
          id text primary key,
          session_id text not null references ai_sessions(id) on delete cascade,
          idempotency_key text not null,
          base_version integer not null,
          new_version integer,
          status ai_session_checkpoint_state not null default 'pending',
          manifest jsonb not null default '{}'::jsonb,
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now()
        )
      `);
    })();
  }

  await aiSessionSchemaInitPromise;
}

function toSessionRecord(input: typeof aiSessions.$inferSelect): AiSessionRecord {
  return {
    id: input.id,
    projectId: input.projectId,
    ownerId: input.ownerId,
    baseVersion: input.baseVersion,
    status: input.status,
    authMode: input.authMode,
    authState: input.authState,
    boxId: input.boxId,
    codexHomeKey: input.codexHomeKey,
    boxStatus: input.boxStatus,
    appServerStatus: input.appServerStatus,
    daemonStatus: input.daemonStatus as AiSessionDaemonState,
    appServerThreadId: input.appServerThreadId,
    threadMaterializedAt: input.threadMaterializedAt?.toISOString() ?? null,
    continuityState: input.continuityState as AiSessionContinuityState,
    resumeEligibility: input.resumeEligibility as AiSessionResumeEligibility,
    supervisorInstanceId: input.supervisorInstanceId,
    supervisorLeaseEpoch: input.supervisorLeaseEpoch,
    lastSupervisorHeartbeatAt: input.lastSupervisorHeartbeatAt?.toISOString() ?? null,
    lastFailureCode: input.lastFailureCode,
    currentLeaseToken: input.currentLeaseToken,
    leaseHeartbeatAt: input.leaseHeartbeatAt.toISOString(),
    leaseExpiresAt: input.leaseExpiresAt.toISOString(),
    lastCheckpointVersion: input.lastCheckpointVersion,
    lastCheckpointId: input.lastCheckpointId,
    revokedAt: input.revokedAt?.toISOString() ?? null,
    createdAt: input.createdAt.toISOString(),
    updatedAt: input.updatedAt.toISOString(),
  };
}

function toEventRecord(input: typeof aiSessionEvents.$inferSelect): AiSessionEventRecord {
  return {
    id: input.id,
    sessionId: input.sessionId,
    type: input.type,
    payload: (input.payload ?? {}) as Record<string, unknown>,
    createdAt: input.createdAt.toISOString(),
  };
}

function toCheckpointRecord(input: typeof aiSessionCheckpoints.$inferSelect): AiSessionCheckpointRecord {
  return {
    id: input.id,
    sessionId: input.sessionId,
    idempotencyKey: input.idempotencyKey,
    baseVersion: input.baseVersion,
    newVersion: input.newVersion,
    status: input.status,
    manifest: (input.manifest ?? {}) as Record<string, unknown>,
    createdAt: input.createdAt.toISOString(),
    updatedAt: input.updatedAt.toISOString(),
  };
}

export class DrizzleAiSessionRepository implements AiSessionRepository {
  async createSession(input: AiSessionRecord): Promise<AiSessionRecord> {
    await ensureAiSessionSchema();
    const db = getDb();
    await db.insert(aiSessions).values({
      id: input.id,
      projectId: input.projectId,
      ownerId: input.ownerId,
      baseVersion: input.baseVersion,
      status: input.status,
        authMode: input.authMode,
        authState: input.authState,
        boxId: input.boxId,
        codexHomeKey: input.codexHomeKey,
        boxStatus: input.boxStatus,
        appServerStatus: input.appServerStatus,
        daemonStatus: input.daemonStatus,
        appServerThreadId: input.appServerThreadId,
        threadMaterializedAt: input.threadMaterializedAt ? new Date(input.threadMaterializedAt) : null,
        continuityState: input.continuityState,
        resumeEligibility: input.resumeEligibility,
        supervisorInstanceId: input.supervisorInstanceId,
        supervisorLeaseEpoch: input.supervisorLeaseEpoch,
        lastSupervisorHeartbeatAt: input.lastSupervisorHeartbeatAt ? new Date(input.lastSupervisorHeartbeatAt) : null,
        lastFailureCode: input.lastFailureCode,
        currentLeaseToken: input.currentLeaseToken,
      leaseHeartbeatAt: new Date(input.leaseHeartbeatAt),
      leaseExpiresAt: new Date(input.leaseExpiresAt),
      lastCheckpointVersion: input.lastCheckpointVersion,
      lastCheckpointId: input.lastCheckpointId,
      revokedAt: input.revokedAt ? new Date(input.revokedAt) : null,
    });

    const created = await this.getSession(input.id);
    if (!created) {
      throw new Error(`Failed to create AI session ${input.id}`);
    }
    return created;
  }

  async listProjectSessions(projectId: string): Promise<AiSessionRecord[]> {
    await ensureAiSessionSchema();
    const db = getDb();
    const rows = await db.select().from(aiSessions).where(eq(aiSessions.projectId, projectId));
    return rows.map(toSessionRecord);
  }

  async getSession(sessionId: string): Promise<AiSessionRecord | null> {
    await ensureAiSessionSchema();
    const db = getDb();
    const row = await db.query.aiSessions.findFirst({
      where: eq(aiSessions.id, sessionId),
    });
    return row ? toSessionRecord(row) : null;
  }

  async updateSession(sessionId: string, input: UpdateAiSessionInput): Promise<AiSessionRecord> {
    await ensureAiSessionSchema();
    const db = getDb();
    await db
      .update(aiSessions)
      .set({
        ...('status' in input ? { status: input.status } : {}),
        ...('authState' in input ? { authState: input.authState } : {}),
        ...('boxId' in input ? { boxId: input.boxId ?? null } : {}),
        ...('codexHomeKey' in input ? { codexHomeKey: input.codexHomeKey ?? null } : {}),
        ...('boxStatus' in input ? { boxStatus: input.boxStatus } : {}),
        ...('appServerStatus' in input ? { appServerStatus: input.appServerStatus } : {}),
        ...('daemonStatus' in input ? { daemonStatus: input.daemonStatus } : {}),
        ...('appServerThreadId' in input ? { appServerThreadId: input.appServerThreadId ?? null } : {}),
        ...('threadMaterializedAt' in input ? { threadMaterializedAt: input.threadMaterializedAt ? new Date(input.threadMaterializedAt) : null } : {}),
        ...('continuityState' in input ? { continuityState: input.continuityState } : {}),
        ...('resumeEligibility' in input ? { resumeEligibility: input.resumeEligibility } : {}),
        ...('supervisorInstanceId' in input ? { supervisorInstanceId: input.supervisorInstanceId ?? null } : {}),
        ...('supervisorLeaseEpoch' in input ? { supervisorLeaseEpoch: input.supervisorLeaseEpoch ?? 0 } : {}),
        ...('lastSupervisorHeartbeatAt' in input ? { lastSupervisorHeartbeatAt: input.lastSupervisorHeartbeatAt ? new Date(input.lastSupervisorHeartbeatAt) : null } : {}),
        ...('lastFailureCode' in input ? { lastFailureCode: input.lastFailureCode ?? null } : {}),
        ...('currentLeaseToken' in input ? { currentLeaseToken: input.currentLeaseToken } : {}),
        ...('leaseHeartbeatAt' in input ? { leaseHeartbeatAt: input.leaseHeartbeatAt ? new Date(input.leaseHeartbeatAt) : undefined } : {}),
        ...('leaseExpiresAt' in input ? { leaseExpiresAt: input.leaseExpiresAt ? new Date(input.leaseExpiresAt) : undefined } : {}),
        ...('lastCheckpointVersion' in input ? { lastCheckpointVersion: input.lastCheckpointVersion ?? null } : {}),
        ...('lastCheckpointId' in input ? { lastCheckpointId: input.lastCheckpointId ?? null } : {}),
        ...('revokedAt' in input ? { revokedAt: input.revokedAt ? new Date(input.revokedAt) : null } : {}),
        updatedAt: new Date(),
      })
      .where(eq(aiSessions.id, sessionId));

    const updated = await this.getSession(sessionId);
    if (!updated) {
      throw new Error(`Failed to update AI session ${sessionId}`);
    }
    return updated;
  }

  async appendEvent(input: CreateAiSessionEventInput): Promise<AiSessionEventRecord> {
    await ensureAiSessionSchema();
    const db = getDb();
    const id = randomUUID();
    await db.insert(aiSessionEvents).values({
      id,
      sessionId: input.sessionId,
      type: input.type,
      payload: input.payload ?? {},
    });

    const row = await db.query.aiSessionEvents.findFirst({
      where: eq(aiSessionEvents.id, id),
    });
    if (!row) {
      throw new Error(`Failed to append AI session event ${id}`);
    }
    return toEventRecord(row);
  }

  async listEvents(sessionId: string): Promise<AiSessionEventRecord[]> {
    await ensureAiSessionSchema();
    const db = getDb();
    const rows = await db
      .select()
      .from(aiSessionEvents)
      .where(eq(aiSessionEvents.sessionId, sessionId))
      .orderBy(asc(aiSessionEvents.createdAt));

    return rows.map(toEventRecord);
  }

  async findCheckpointByIdempotencyKey(sessionId: string, idempotencyKey: string): Promise<AiSessionCheckpointRecord | null> {
    await ensureAiSessionSchema();
    const db = getDb();
    const row = await db.query.aiSessionCheckpoints.findFirst({
      where: and(eq(aiSessionCheckpoints.sessionId, sessionId), eq(aiSessionCheckpoints.idempotencyKey, idempotencyKey)),
    });
    return row ? toCheckpointRecord(row) : null;
  }

  async createCheckpoint(input: CreateAiSessionCheckpointInput): Promise<AiSessionCheckpointRecord> {
    await ensureAiSessionSchema();
    const db = getDb();
    const id = randomUUID();
    await db.insert(aiSessionCheckpoints).values({
      id,
      sessionId: input.sessionId,
      idempotencyKey: input.idempotencyKey,
      baseVersion: input.baseVersion,
      newVersion: input.newVersion ?? null,
      status: input.status ?? 'pending',
      manifest: input.manifest ?? {},
    });

    const row = await db.query.aiSessionCheckpoints.findFirst({
      where: eq(aiSessionCheckpoints.id, id),
    });
    if (!row) {
      throw new Error(`Failed to create AI session checkpoint ${id}`);
    }
    return toCheckpointRecord(row);
  }
}
