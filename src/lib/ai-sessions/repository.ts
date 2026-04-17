import { randomUUID } from 'node:crypto';

import { and, asc, eq, sql } from 'drizzle-orm';

import {
  aiSessionCheckpoints,
  aiSessionEvents,
  aiSessionTransportLogs,
  aiSessionTurns,
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
  AiSessionTurnRecord,
  AiSessionTransportLogDirection,
  AiSessionTransportLogEntry,
  AiSessionTransportLogPhase,
  CreateAiSessionCheckpointInput,
  CreateAiSessionEventInput,
  CreateAiSessionTurnInput,
  UpdateAiSessionInput,
  UpdateAiSessionTurnInput,
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
          active_workspace_version integer not null default 1,
          latest_workspace_version integer not null default 1,
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
      await db.execute(sql`alter table ai_sessions add column if not exists active_workspace_version integer not null default 1`);
      await db.execute(sql`alter table ai_sessions add column if not exists latest_workspace_version integer not null default 1`);
      await db.execute(sql`alter table ai_sessions add column if not exists codex_home_key text`);
      await db.execute(sql`alter table ai_sessions add column if not exists daemon_status text not null default 'stopped'`);
      await db.execute(sql`alter table ai_sessions add column if not exists thread_materialized_at timestamptz`);
      await db.execute(sql`alter table ai_sessions add column if not exists transport_phase text not null default 'uninitialized'`);
      await db.execute(sql`alter table ai_sessions add column if not exists transport_initialized_at timestamptz`);
      await db.execute(sql`alter table ai_sessions add column if not exists transport_last_activity_at timestamptz`);
      await db.execute(sql`alter table ai_sessions add column if not exists transport_idle_deadline_at timestamptz`);
      await db.execute(sql`alter table ai_sessions add column if not exists transport_last_error_code text`);
      await db.execute(sql`alter table ai_sessions add column if not exists transport_last_error_message text`);
      await db.execute(sql`alter table ai_sessions add column if not exists continuity_state text not null default 'new'`);
      await db.execute(sql`alter table ai_sessions add column if not exists resume_eligibility text not null default 'not_resumable'`);
      await db.execute(sql`alter table ai_sessions add column if not exists recovery_outcome text not null default 'none'`);
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
      await db.execute(sql`
        create table if not exists ai_session_transport_logs (
          id text primary key,
          session_id text not null references ai_sessions(id) on delete cascade,
          phase text not null,
          direction text not null,
          message text not null,
          created_at timestamptz not null
        )
      `);
      await db.execute(sql`create index if not exists ai_session_transport_logs_session_created_idx on ai_session_transport_logs(session_id, created_at)`);
      await db.execute(sql`
        create table if not exists ai_session_turns (
          id text primary key,
          session_id text not null references ai_sessions(id) on delete cascade,
          project_id text not null,
          workspace_version integer not null,
          workspace_root text not null,
          mode text not null,
          request_text text not null,
          target_id text,
          base_target_id text,
          route_mode text,
          route_reason text,
          allowed_paths jsonb not null default '[]'::jsonb,
          request_fingerprint text not null,
          status text not null default 'submitted',
          artifact_state text not null default 'pending',
          thread_id text,
          accepted_at timestamptz not null,
          started_at timestamptz,
          completed_at timestamptz,
          terminal_at timestamptz,
          artifact_ready_at timestamptz,
          turn_status text,
          agent_text text not null default '',
          recovery_outcome text not null default 'none',
          final_outcome text not null default 'pending',
          failure_code text,
          failure_message text,
          diagnostics jsonb not null default '{}'::jsonb,
          result_payload jsonb not null default '{}'::jsonb,
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now()
        )
      `);
      await db.execute(sql`create index if not exists ai_session_turns_session_created_idx on ai_session_turns(session_id, created_at)`);
      await db.execute(sql`create index if not exists ai_session_turns_session_status_idx on ai_session_turns(session_id, status, updated_at)`);
      await db.execute(sql`create index if not exists ai_session_turns_session_fingerprint_idx on ai_session_turns(session_id, request_fingerprint, created_at)`);
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
    activeWorkspaceVersion: input.activeWorkspaceVersion,
    latestWorkspaceVersion: input.latestWorkspaceVersion,
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
    transportPhase: input.transportPhase as AiSessionRecord['transportPhase'],
    transportInitializedAt: input.transportInitializedAt?.toISOString() ?? null,
    transportLastActivityAt: input.transportLastActivityAt?.toISOString() ?? null,
    transportIdleDeadlineAt: input.transportIdleDeadlineAt?.toISOString() ?? null,
    transportLastErrorCode: input.transportLastErrorCode,
    transportLastErrorMessage: input.transportLastErrorMessage,
    continuityState: input.continuityState as AiSessionContinuityState,
    resumeEligibility: input.resumeEligibility as AiSessionResumeEligibility,
    recoveryOutcome: input.recoveryOutcome as AiSessionRecord['recoveryOutcome'],
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

function toTurnRecord(input: typeof aiSessionTurns.$inferSelect): AiSessionTurnRecord {
  return {
    id: input.id,
    sessionId: input.sessionId,
    projectId: input.projectId,
    workspaceVersion: input.workspaceVersion,
    workspaceRoot: input.workspaceRoot,
    mode: input.mode as AiSessionTurnRecord['mode'],
    requestText: input.requestText,
    targetId: input.targetId,
    baseTargetId: input.baseTargetId,
    routeMode: (input.routeMode ?? null) as AiSessionTurnRecord['routeMode'],
    routeReason: input.routeReason,
    allowedPaths: Array.isArray(input.allowedPaths) ? input.allowedPaths.filter((item): item is string => typeof item === 'string') : [],
    requestFingerprint: input.requestFingerprint,
    status: input.status as AiSessionTurnRecord['status'],
    artifactState: input.artifactState as AiSessionTurnRecord['artifactState'],
    threadId: input.threadId,
    acceptedAt: input.acceptedAt.toISOString(),
    startedAt: input.startedAt?.toISOString() ?? null,
    completedAt: input.completedAt?.toISOString() ?? null,
    terminalAt: input.terminalAt?.toISOString() ?? null,
    artifactReadyAt: input.artifactReadyAt?.toISOString() ?? null,
    turnStatus: input.turnStatus,
    agentText: input.agentText,
    recoveryOutcome: input.recoveryOutcome as AiSessionTurnRecord['recoveryOutcome'],
    finalOutcome: input.finalOutcome as AiSessionTurnRecord['finalOutcome'],
    failureCode: input.failureCode,
    failureMessage: input.failureMessage,
    diagnostics: (input.diagnostics ?? {}) as Record<string, unknown>,
    resultPayload: (input.resultPayload ?? {}) as Record<string, unknown>,
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
        activeWorkspaceVersion: input.activeWorkspaceVersion,
        latestWorkspaceVersion: input.latestWorkspaceVersion,
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
        transportPhase: input.transportPhase,
        transportInitializedAt: input.transportInitializedAt ? new Date(input.transportInitializedAt) : null,
        transportLastActivityAt: input.transportLastActivityAt ? new Date(input.transportLastActivityAt) : null,
        transportIdleDeadlineAt: input.transportIdleDeadlineAt ? new Date(input.transportIdleDeadlineAt) : null,
        transportLastErrorCode: input.transportLastErrorCode,
        transportLastErrorMessage: input.transportLastErrorMessage,
        continuityState: input.continuityState,
        resumeEligibility: input.resumeEligibility,
        recoveryOutcome: input.recoveryOutcome,
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
        ...('baseVersion' in input ? { baseVersion: input.baseVersion } : {}),
        ...('activeWorkspaceVersion' in input ? { activeWorkspaceVersion: input.activeWorkspaceVersion ?? 1 } : {}),
        ...('latestWorkspaceVersion' in input ? { latestWorkspaceVersion: input.latestWorkspaceVersion ?? 1 } : {}),
        ...('authState' in input ? { authState: input.authState } : {}),
        ...('boxId' in input ? { boxId: input.boxId ?? null } : {}),
        ...('codexHomeKey' in input ? { codexHomeKey: input.codexHomeKey ?? null } : {}),
        ...('boxStatus' in input ? { boxStatus: input.boxStatus } : {}),
        ...('appServerStatus' in input ? { appServerStatus: input.appServerStatus } : {}),
        ...('daemonStatus' in input ? { daemonStatus: input.daemonStatus } : {}),
        ...('appServerThreadId' in input ? { appServerThreadId: input.appServerThreadId ?? null } : {}),
        ...('threadMaterializedAt' in input ? { threadMaterializedAt: input.threadMaterializedAt ? new Date(input.threadMaterializedAt) : null } : {}),
        ...('transportPhase' in input ? { transportPhase: input.transportPhase ?? 'uninitialized' } : {}),
        ...('transportInitializedAt' in input ? { transportInitializedAt: input.transportInitializedAt ? new Date(input.transportInitializedAt) : null } : {}),
        ...('transportLastActivityAt' in input ? { transportLastActivityAt: input.transportLastActivityAt ? new Date(input.transportLastActivityAt) : null } : {}),
        ...('transportIdleDeadlineAt' in input ? { transportIdleDeadlineAt: input.transportIdleDeadlineAt ? new Date(input.transportIdleDeadlineAt) : null } : {}),
        ...('transportLastErrorCode' in input ? { transportLastErrorCode: input.transportLastErrorCode ?? null } : {}),
        ...('transportLastErrorMessage' in input ? { transportLastErrorMessage: input.transportLastErrorMessage ?? null } : {}),
        ...('continuityState' in input ? { continuityState: input.continuityState } : {}),
        ...('resumeEligibility' in input ? { resumeEligibility: input.resumeEligibility } : {}),
        ...('recoveryOutcome' in input ? { recoveryOutcome: input.recoveryOutcome ?? 'none' } : {}),
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

  async appendTransportLog(sessionId: string, entry: AiSessionTransportLogEntry): Promise<AiSessionTransportLogEntry> {
    await ensureAiSessionSchema();
    const db = getDb();
    await db.insert(aiSessionTransportLogs).values({
      id: entry.id,
      sessionId,
      phase: entry.phase,
      direction: entry.direction,
      message: entry.message,
      createdAt: new Date(entry.createdAt),
    });
    return structuredClone(entry);
  }

  async appendTransportLogs(sessionId: string, entries: AiSessionTransportLogEntry[]): Promise<AiSessionTransportLogEntry[]> {
    if (entries.length === 0) {
      return [];
    }

    await ensureAiSessionSchema();
    const db = getDb();
    await db
      .insert(aiSessionTransportLogs)
      .values(entries.map(entry => ({
        id: entry.id,
        sessionId,
        phase: entry.phase,
        direction: entry.direction,
        message: entry.message,
        createdAt: new Date(entry.createdAt),
      })))
      .onConflictDoNothing();
    return entries.map(entry => structuredClone(entry));
  }

  async listTransportLogs(sessionId: string): Promise<AiSessionTransportLogEntry[]> {
    await ensureAiSessionSchema();
    const db = getDb();
    const rows = await db.select().from(aiSessionTransportLogs).where(eq(aiSessionTransportLogs.sessionId, sessionId)).orderBy(asc(aiSessionTransportLogs.createdAt));
    return rows.map(row => ({
      id: row.id,
      phase: row.phase as AiSessionTransportLogPhase,
      direction: row.direction as AiSessionTransportLogDirection,
      message: row.message,
      createdAt: row.createdAt.toISOString(),
    }));
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

  async createTurn(input: CreateAiSessionTurnInput): Promise<AiSessionTurnRecord> {
    await ensureAiSessionSchema();
    const db = getDb();
    await db.insert(aiSessionTurns).values({
      id: input.id,
      sessionId: input.sessionId,
      projectId: input.projectId,
      workspaceVersion: input.workspaceVersion,
      workspaceRoot: input.workspaceRoot,
      mode: input.mode,
      requestText: input.requestText,
      targetId: input.targetId,
      baseTargetId: input.baseTargetId,
      routeMode: input.routeMode,
      routeReason: input.routeReason,
      allowedPaths: input.allowedPaths,
      requestFingerprint: input.requestFingerprint,
      status: input.status,
      artifactState: input.artifactState,
      threadId: input.threadId,
      acceptedAt: new Date(input.acceptedAt),
      startedAt: input.startedAt ? new Date(input.startedAt) : null,
      completedAt: input.completedAt ? new Date(input.completedAt) : null,
      terminalAt: input.terminalAt ? new Date(input.terminalAt) : null,
      artifactReadyAt: input.artifactReadyAt ? new Date(input.artifactReadyAt) : null,
      turnStatus: input.turnStatus,
      agentText: input.agentText,
      recoveryOutcome: input.recoveryOutcome,
      finalOutcome: input.finalOutcome,
      failureCode: input.failureCode,
      failureMessage: input.failureMessage,
      diagnostics: input.diagnostics,
      resultPayload: input.resultPayload,
    });

    const created = await this.getTurn(input.id);
    if (!created) {
      throw new Error(`Failed to create AI session turn ${input.id}`);
    }
    return created;
  }

  async getTurn(turnId: string): Promise<AiSessionTurnRecord | null> {
    await ensureAiSessionSchema();
    const db = getDb();
    const row = await db.query.aiSessionTurns.findFirst({
      where: eq(aiSessionTurns.id, turnId),
    });
    return row ? toTurnRecord(row) : null;
  }

  async listSessionTurns(sessionId: string): Promise<AiSessionTurnRecord[]> {
    await ensureAiSessionSchema();
    const db = getDb();
    const rows = await db
      .select()
      .from(aiSessionTurns)
      .where(eq(aiSessionTurns.sessionId, sessionId))
      .orderBy(asc(aiSessionTurns.createdAt));
    return rows.map(toTurnRecord);
  }

  async findActiveTurn(sessionId: string): Promise<AiSessionTurnRecord | null> {
    await ensureAiSessionSchema();
    const db = getDb();
    const rows = await db
      .select()
      .from(aiSessionTurns)
      .where(eq(aiSessionTurns.sessionId, sessionId))
      .orderBy(asc(aiSessionTurns.createdAt));
    const active = rows.reverse().find(row => ['submitted', 'running', 'awaiting_artifact'].includes(row.status));
    return active ? toTurnRecord(active) : null;
  }

  async findTurnByRequestFingerprint(sessionId: string, requestFingerprint: string): Promise<AiSessionTurnRecord | null> {
    await ensureAiSessionSchema();
    const db = getDb();
    const rows = await db
      .select()
      .from(aiSessionTurns)
      .where(and(eq(aiSessionTurns.sessionId, sessionId), eq(aiSessionTurns.requestFingerprint, requestFingerprint)))
      .orderBy(asc(aiSessionTurns.createdAt));
    const turn = rows.at(-1) ?? null;
    return turn ? toTurnRecord(turn) : null;
  }

  async updateTurn(turnId: string, input: UpdateAiSessionTurnInput): Promise<AiSessionTurnRecord> {
    await ensureAiSessionSchema();
    const db = getDb();
    await db
      .update(aiSessionTurns)
      .set({
        ...('status' in input ? { status: input.status } : {}),
        ...('artifactState' in input ? { artifactState: input.artifactState } : {}),
        ...('threadId' in input ? { threadId: input.threadId ?? null } : {}),
        ...('startedAt' in input ? { startedAt: input.startedAt ? new Date(input.startedAt) : null } : {}),
        ...('completedAt' in input ? { completedAt: input.completedAt ? new Date(input.completedAt) : null } : {}),
        ...('terminalAt' in input ? { terminalAt: input.terminalAt ? new Date(input.terminalAt) : null } : {}),
        ...('artifactReadyAt' in input ? { artifactReadyAt: input.artifactReadyAt ? new Date(input.artifactReadyAt) : null } : {}),
        ...('turnStatus' in input ? { turnStatus: input.turnStatus ?? null } : {}),
        ...('agentText' in input ? { agentText: input.agentText ?? '' } : {}),
        ...('recoveryOutcome' in input ? { recoveryOutcome: input.recoveryOutcome ?? 'none' } : {}),
        ...('finalOutcome' in input ? { finalOutcome: input.finalOutcome ?? 'pending' } : {}),
        ...('failureCode' in input ? { failureCode: input.failureCode ?? null } : {}),
        ...('failureMessage' in input ? { failureMessage: input.failureMessage ?? null } : {}),
        ...('diagnostics' in input ? { diagnostics: input.diagnostics ?? {} } : {}),
        ...('resultPayload' in input ? { resultPayload: input.resultPayload ?? {} } : {}),
        updatedAt: new Date(),
      })
      .where(eq(aiSessionTurns.id, turnId));

    const updated = await this.getTurn(turnId);
    if (!updated) {
      throw new Error(`Failed to update AI session turn ${turnId}`);
    }
    return updated;
  }
}
