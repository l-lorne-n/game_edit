export type AiSessionState =
  | 'provisioning'
  | 'hydrating'
  | 'ready'
  | 'busy'
  | 'checkpointing'
  | 'auth_blocked'
  | 'failed'
  | 'revoked'
  | 'terminating'
  | 'terminated';

export type AiSessionAuthMode = 'chatgptAuthTokens';

export type AiSessionAuthState = 'bootstrap_pending' | 'ready' | 'refreshing' | 'blocked' | 'revoked';

export type AiSessionBoxState = 'unassigned' | 'provisioning' | 'ready' | 'busy' | 'failed' | 'terminating' | 'terminated';

export type AiSessionAppServerState = 'unassigned' | 'starting' | 'healthy' | 'degraded' | 'failed' | 'stopped';

export type AiSessionCheckpointState = 'pending' | 'committed' | 'conflict' | 'failed';

export type AiSessionContinuityState =
  | 'new'
  | 'auth_ready'
  | 'daemon_starting'
  | 'thread_started_provisional'
  | 'first_turn_materialized'
  | 'resumable'
  | 'continuity_lost'
  | 'restart_required'
  | 'expired'
  | 'failed'
  | 'revoked';

export type AiSessionDaemonState = 'stopped' | 'starting' | 'healthy' | 'degraded' | 'terminating' | 'terminated';

export type AiSessionResumeEligibility = 'not_resumable' | 'provisional' | 'resumable' | 'restart_required';

export type AiSessionTransportPhase =
  | 'uninitialized'
  | 'initializing'
  | 'ready'
  | 'turn_running'
  | 'idle_expired'
  | 'transport_lost';

export type AiSessionTransportLogPhase = 'init' | 'turn';

export type AiSessionTransportLogDirection = 'outbound' | 'inbound' | 'system';

export type AiSessionTransportLogEntry = {
  id: string;
  phase: AiSessionTransportLogPhase;
  direction: AiSessionTransportLogDirection;
  message: string;
  createdAt: string;
};

export type AiSessionTransportSnapshot = {
  phase: AiSessionTransportPhase;
  threadId: string | null;
  initializedAt: string | null;
  lastActivityAt: string | null;
  idleDeadlineAt: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  initLogCount: number;
  turnLogCount: number;
  requiresReinit: boolean;
};

export type AiSessionRecord = {
  id: string;
  projectId: string;
  ownerId: string;
  baseVersion: number;
  status: AiSessionState;
  authMode: AiSessionAuthMode;
  authState: AiSessionAuthState;
  boxId: string | null;
  codexHomeKey: string | null;
  boxStatus: AiSessionBoxState;
  appServerStatus: AiSessionAppServerState;
  daemonStatus: AiSessionDaemonState;
  appServerThreadId: string | null;
  threadMaterializedAt: string | null;
  continuityState: AiSessionContinuityState;
  resumeEligibility: AiSessionResumeEligibility;
  supervisorInstanceId: string | null;
  supervisorLeaseEpoch: number;
  lastSupervisorHeartbeatAt: string | null;
  lastFailureCode: string | null;
  currentLeaseToken: string;
  leaseHeartbeatAt: string;
  leaseExpiresAt: string;
  lastCheckpointVersion: number | null;
  lastCheckpointId: string | null;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AiSessionEventRecord = {
  id: string;
  sessionId: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

export type AiSessionCheckpointRecord = {
  id: string;
  sessionId: string;
  idempotencyKey: string;
  baseVersion: number;
  newVersion: number | null;
  status: AiSessionCheckpointState;
  manifest: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type CreateAiSessionInput = {
  projectId: string;
  ownerId: string;
  baseVersion: number;
  authMode?: AiSessionAuthMode;
  leaseTtlSeconds?: number;
};

export type UpdateAiSessionInput = Partial<
  Pick<
    AiSessionRecord,
    | 'status'
    | 'authState'
    | 'boxId'
    | 'codexHomeKey'
    | 'boxStatus'
    | 'appServerStatus'
    | 'daemonStatus'
    | 'appServerThreadId'
    | 'threadMaterializedAt'
    | 'continuityState'
    | 'resumeEligibility'
    | 'supervisorInstanceId'
    | 'supervisorLeaseEpoch'
    | 'lastSupervisorHeartbeatAt'
    | 'lastFailureCode'
    | 'currentLeaseToken'
    | 'leaseHeartbeatAt'
    | 'leaseExpiresAt'
    | 'lastCheckpointVersion'
    | 'lastCheckpointId'
    | 'revokedAt'
  >
>;

export type CreateAiSessionEventInput = {
  sessionId: string;
  type: string;
  payload?: Record<string, unknown>;
};

export type CreateAiSessionCheckpointInput = {
  sessionId: string;
  idempotencyKey: string;
  baseVersion: number;
  newVersion?: number | null;
  status?: AiSessionCheckpointState;
  manifest?: Record<string, unknown>;
};

export type AiSessionRepository = {
  createSession(input: AiSessionRecord): Promise<AiSessionRecord>;
  listProjectSessions(projectId: string): Promise<AiSessionRecord[]>;
  getSession(sessionId: string): Promise<AiSessionRecord | null>;
  updateSession(sessionId: string, input: UpdateAiSessionInput): Promise<AiSessionRecord>;
  appendEvent(input: CreateAiSessionEventInput): Promise<AiSessionEventRecord>;
  listEvents(sessionId: string): Promise<AiSessionEventRecord[]>;
  findCheckpointByIdempotencyKey(sessionId: string, idempotencyKey: string): Promise<AiSessionCheckpointRecord | null>;
  createCheckpoint(input: CreateAiSessionCheckpointInput): Promise<AiSessionCheckpointRecord>;
};
