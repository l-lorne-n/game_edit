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

export type AiSessionRecoveryOutcome = 'none' | 'same_thread_resumed' | 'same_rollout_thread_restarted';

export type AiSessionTurnState = 'submitted' | 'running' | 'awaiting_artifact' | 'completed' | 'failed' | 'rejected';

export type AiSessionTurnArtifactState = 'pending' | 'durable' | 'missing';

export type AiSessionTurnFinalOutcome = 'pending' | 'completed' | 'failed' | 'deduplicated' | 'rejected';

export type AiSessionRecord = {
  id: string;
  projectId: string;
  ownerId: string;
  baseVersion: number;
  activeWorkspaceVersion: number;
  latestWorkspaceVersion: number;
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
   transportPhase: AiSessionTransportPhase;
   transportInitializedAt: string | null;
   transportLastActivityAt: string | null;
   transportIdleDeadlineAt: string | null;
   transportLastErrorCode: string | null;
   transportLastErrorMessage: string | null;
  continuityState: AiSessionContinuityState;
  resumeEligibility: AiSessionResumeEligibility;
   recoveryOutcome: AiSessionRecoveryOutcome;
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

export type AiSessionTurnRecord = {
  id: string;
  sessionId: string;
  projectId: string;
  workspaceVersion: number;
  workspaceRoot: string;
  mode: 'create' | 'modify' | 'debug';
  requestText: string;
  targetId: string | null;
  baseTargetId: string | null;
  routeMode: 'design' | 'patch' | 'repair' | null;
  routeReason: string | null;
  allowedPaths: string[];
  requestFingerprint: string;
  status: AiSessionTurnState;
  artifactState: AiSessionTurnArtifactState;
  threadId: string | null;
  acceptedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  terminalAt: string | null;
  artifactReadyAt: string | null;
  turnStatus: string | null;
  agentText: string;
  recoveryOutcome: AiSessionRecoveryOutcome;
  finalOutcome: AiSessionTurnFinalOutcome;
  failureCode: string | null;
  failureMessage: string | null;
  diagnostics: Record<string, unknown>;
  resultPayload: Record<string, unknown>;
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

export type AiSessionWorkspaceVersion = {
  versionId: string;
  workspaceVersion: number;
  createdAt: string;
  isActive: boolean;
  isLatest: boolean;
  sourceTargetId: string | null;
};

export type AiSessionWorkspaceVersionPayload = AiSessionWorkspaceVersion & {
  package: {
    indexHtml: string;
    gameJs: string;
    styleCss: string;
    manifestJson: string;
  };
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
      | 'baseVersion'
      | 'activeWorkspaceVersion'
      | 'latestWorkspaceVersion'
      | 'authState'
      | 'boxId'
    | 'codexHomeKey'
    | 'boxStatus'
      | 'appServerStatus'
      | 'daemonStatus'
      | 'appServerThreadId'
      | 'threadMaterializedAt'
      | 'transportPhase'
      | 'transportInitializedAt'
      | 'transportLastActivityAt'
      | 'transportIdleDeadlineAt'
      | 'transportLastErrorCode'
      | 'transportLastErrorMessage'
      | 'continuityState'
      | 'resumeEligibility'
      | 'recoveryOutcome'
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

export type CreateAiSessionTurnInput = Omit<AiSessionTurnRecord, 'createdAt' | 'updatedAt'>;

export type UpdateAiSessionTurnInput = Partial<
  Pick<
    AiSessionTurnRecord,
    | 'status'
    | 'artifactState'
    | 'threadId'
    | 'startedAt'
    | 'completedAt'
    | 'terminalAt'
    | 'artifactReadyAt'
    | 'turnStatus'
    | 'agentText'
    | 'recoveryOutcome'
    | 'finalOutcome'
    | 'failureCode'
    | 'failureMessage'
    | 'diagnostics'
    | 'resultPayload'
  >
>;

export type AiSessionRepository = {
  createSession(input: AiSessionRecord): Promise<AiSessionRecord>;
  listProjectSessions(projectId: string): Promise<AiSessionRecord[]>;
  getSession(sessionId: string): Promise<AiSessionRecord | null>;
  updateSession(sessionId: string, input: UpdateAiSessionInput): Promise<AiSessionRecord>;
  appendEvent(input: CreateAiSessionEventInput): Promise<AiSessionEventRecord>;
  listEvents(sessionId: string): Promise<AiSessionEventRecord[]>;
  appendTransportLog(sessionId: string, entry: AiSessionTransportLogEntry): Promise<AiSessionTransportLogEntry>;
  listTransportLogs(sessionId: string): Promise<AiSessionTransportLogEntry[]>;
  findCheckpointByIdempotencyKey(sessionId: string, idempotencyKey: string): Promise<AiSessionCheckpointRecord | null>;
  createCheckpoint(input: CreateAiSessionCheckpointInput): Promise<AiSessionCheckpointRecord>;
  createTurn(input: CreateAiSessionTurnInput): Promise<AiSessionTurnRecord>;
  getTurn(turnId: string): Promise<AiSessionTurnRecord | null>;
  listSessionTurns(sessionId: string): Promise<AiSessionTurnRecord[]>;
  findActiveTurn(sessionId: string): Promise<AiSessionTurnRecord | null>;
  findTurnByRequestFingerprint(sessionId: string, requestFingerprint: string): Promise<AiSessionTurnRecord | null>;
  updateTurn(turnId: string, input: UpdateAiSessionTurnInput): Promise<AiSessionTurnRecord>;
};
