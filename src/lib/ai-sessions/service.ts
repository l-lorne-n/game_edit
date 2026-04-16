import { randomUUID } from 'node:crypto';

import { HostTokenServiceClient } from '@/lib/host-tokens/client';
import {
  appendAiSessionTransportLog,
  clearAiSessionTransport,
  expireAiSessionTransportIfIdle,
  getAiSessionTransportSnapshot,
  hasAiSessionTransportRuntime,
  listAiSessionTransportLogs,
  markAiSessionTransportLost,
  markAiSessionTransportReady,
  restoreAiSessionTransport,
  startAiSessionTransportInit,
  startAiSessionTransportTurn,
  finishAiSessionTransportTurn,
  syncAiSessionTransportThreadId,
} from '@/lib/ai-sessions/transport-runtime';
import { getAiSessionSupervisor } from '@/lib/ai-sessions/supervisor';
import {
  callCodexAppServerDaemon,
  ensureCodexAppServerDaemon,
  getCodexAppServerDaemonHealth,
} from '@/lib/ai-sessions/app-server-daemon';
import {
  collectAgentMessageText,
  createExternalAuthLoginMessage,
  createInitializeMessages,
  createThreadStartMessage,
  createTurnStartMessage,
  didAccountLoginSucceed,
  findLoginError,
  findJsonRpcError,
  findRunnerError,
  findThreadId,
  findThreadStartError,
  findTurnCompletedStatus,
  getAiSessionWorkspaceAbsoluteRoot,
} from '@/lib/ai-sessions/app-server-stdio';
import {
  getAiSessionVersionTargetId,
  getAiSessionWorkspaceFilePath,
  getAiSessionWorkspaceRoot,
  parseAiSessionVersionTargetId,
} from '@/lib/ai-sessions/workspace';
import { filesToGeneratedPackage, versionFromSnapshotId } from '@/lib/projects/package-files';
import { createWorkspaceContractFiles } from '@/lib/package/workspace-contract';
import { CANONICAL_PACKAGE_FILE_PATHS, type CanonicalPackageFilePath } from '@/lib/projects/types';
import { createProjectService } from '@/lib/projects/service';
import { getSandboxProvider } from '@/lib/sandbox';
import { DrizzleAiSessionRepository } from '@/lib/ai-sessions/repository';
import type {
  AiSessionEventRecord,
  AiSessionRecord,
  AiSessionRepository,
  AiSessionState,
  CreateAiSessionInput,
  AiSessionTransportSnapshot,
} from '@/lib/ai-sessions/types';

const DEFAULT_LEASE_TTL_SECONDS = 5 * 60;

const ACTIVE_WRITER_STATES = new Set<AiSessionState>([
  'provisioning',
  'hydrating',
  'ready',
  'busy',
  'checkpointing',
  'auth_blocked',
]);

export class AiSessionConflictError extends Error {
  readonly code = 'single_writer_conflict';

  constructor(projectId: string) {
    super(`An active writable AI session already exists for project ${projectId}.`);
  }
}

export class AiSessionLeaseError extends Error {
  readonly code = 'invalid_lease';

  constructor(message: string) {
    super(message);
  }
}

export class AiSessionMessageNotReadyError extends Error {
  readonly code = 'message_transport_not_ready';

  constructor(message: string) {
    super(message);
  }
}

export class AiSessionTransportNotImplementedError extends Error {
  readonly code = 'message_transport_not_implemented';
  readonly reason: string;

  constructor(message: string, reason = 'codex_app_server_message_transport_not_wired_yet') {
    super(message);
    this.reason = reason;
  }
}

export class AiSessionTransportNotInitializedError extends Error {
  readonly code = 'codex_transport_not_initialized';

  constructor(message = 'Codex transport is not initialized for this AI session.') {
    super(message);
  }
}

function isActiveWriterSession(session: AiSessionRecord, now = Date.now()): boolean {
  return ACTIVE_WRITER_STATES.has(session.status) && new Date(session.leaseExpiresAt).getTime() > now && !session.revokedAt;
}

function getActiveWorkspaceVersion(session: AiSessionRecord): number {
  return session.activeWorkspaceVersion > 0 ? session.activeWorkspaceVersion : 1;
}

function getLatestWorkspaceVersion(session: AiSessionRecord): number {
  return session.latestWorkspaceVersion > 0 ? session.latestWorkspaceVersion : 1;
}

export function createAiSessionService(repository: AiSessionRepository = new DrizzleAiSessionRepository()) {
  const projectService = createProjectService();
  const supervisor = getAiSessionSupervisor();

  async function readProjectPackageVersion(projectId: string, version: number) {
    const project = await projectService.getProject(projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }

    const targetVersion = project.versions.find(item => item.version === version);
    if (!targetVersion) {
      throw new Error(`Project version not found: ${projectId}@${version}`);
    }

    return targetVersion.pkg;
  }

  async function readWorkspacePackageVersion(sessionId: string, workspaceVersion: number) {
    const sandboxProvider = getSandboxProvider();
    const files: Partial<Record<CanonicalPackageFilePath, string>> = {};
    await Promise.all(
      CANONICAL_PACKAGE_FILE_PATHS.map(async path => {
        files[path] = await sandboxProvider.readFile(getAiSessionWorkspaceFilePath(sessionId, path, workspaceVersion));
      }),
    );
    return filesToGeneratedPackage(files);
  }

  async function writeWorkspacePackageVersion(
    sessionId: string,
    workspaceVersion: number,
    pkg: {
      indexHtml: string;
      gameJs: string;
      styleCss: string;
      manifestJson: string;
    },
  ) {
    const sandboxProvider = getSandboxProvider();
    await sandboxProvider.writeFiles([
      { path: getAiSessionWorkspaceFilePath(sessionId, 'index.html', workspaceVersion), content: pkg.indexHtml },
      { path: getAiSessionWorkspaceFilePath(sessionId, 'game.js', workspaceVersion), content: pkg.gameJs },
      { path: getAiSessionWorkspaceFilePath(sessionId, 'style.css', workspaceVersion), content: pkg.styleCss },
      { path: getAiSessionWorkspaceFilePath(sessionId, 'manifest.json', workspaceVersion), content: pkg.manifestJson },
      ...createWorkspaceContractFiles(`${getAiSessionWorkspaceRoot(sessionId)}/v${workspaceVersion}`),
    ]);
  }

  async function resolveWorkspaceBasePackage(session: AiSessionRecord, targetId?: string | null) {
    if (!targetId || targetId === '__current__') {
      const workspaceVersion = getActiveWorkspaceVersion(session);
      return {
        pkg: await readWorkspacePackageVersion(session.id, workspaceVersion),
        sourceTargetId: getAiSessionVersionTargetId(workspaceVersion),
        workspaceVersion,
      };
    }

    const sessionWorkspaceVersion = parseAiSessionVersionTargetId(targetId);
    if (sessionWorkspaceVersion) {
      return {
        pkg: await readWorkspacePackageVersion(session.id, sessionWorkspaceVersion),
        sourceTargetId: getAiSessionVersionTargetId(sessionWorkspaceVersion),
        workspaceVersion: sessionWorkspaceVersion,
      };
    }

    const projectVersion = versionFromSnapshotId(targetId);
    if (projectVersion) {
      return {
        pkg: await readProjectPackageVersion(session.projectId, projectVersion),
        sourceTargetId: targetId,
        workspaceVersion: null,
      };
    }

    throw new Error(`Unknown modify target: ${targetId}`);
  }

  function toTransportSnapshotState(session: AiSessionRecord) {
    return {
      phase: session.transportPhase,
      threadId: session.appServerThreadId,
      initializedAt: session.transportInitializedAt,
      lastActivityAt: session.transportLastActivityAt,
      idleDeadlineAt: session.transportIdleDeadlineAt,
      lastErrorCode: session.transportLastErrorCode,
      lastErrorMessage: session.transportLastErrorMessage,
    };
  }

  function toTransportSessionUpdate(snapshot: AiSessionTransportSnapshot) {
    return {
      transportPhase: snapshot.phase,
      transportInitializedAt: snapshot.initializedAt,
      transportLastActivityAt: snapshot.lastActivityAt,
      transportIdleDeadlineAt: snapshot.idleDeadlineAt,
      transportLastErrorCode: snapshot.lastErrorCode,
      transportLastErrorMessage: snapshot.lastErrorMessage,
    };
  }

  async function persistTransportSnapshot(sessionId: string, snapshot: AiSessionTransportSnapshot) {
    await repository.updateSession(sessionId, toTransportSessionUpdate(snapshot));
    return snapshot;
  }

  async function appendTransportLog(sessionId: string, phase: 'init' | 'turn', direction: 'outbound' | 'inbound' | 'system', message: unknown) {
    const entry = appendAiSessionTransportLog(sessionId, phase, direction, message);
    await repository.appendTransportLog(sessionId, entry);
    const session = await repository.getSession(sessionId);
    if (session) {
      await repository.updateSession(sessionId, {
        transportLastActivityAt: entry.createdAt,
        transportIdleDeadlineAt: session.transportPhase !== 'initializing'
          ? new Date(new Date(entry.createdAt).getTime() + 10 * 60 * 1000).toISOString()
          : null,
      });
    }
    return entry;
  }

  async function rehydrateTransportRuntime(session: AiSessionRecord) {
    if (hasAiSessionTransportRuntime(session.id)) {
      return getAiSessionTransportSnapshot(session);
    }

    const persistedLogs = await repository.listTransportLogs(session.id);
    const initTranscript = persistedLogs.filter(entry => entry.phase === 'init');
    const turnTranscript = persistedLogs.filter(entry => entry.phase === 'turn');
    const restored = restoreAiSessionTransport(session.id, toTransportSnapshotState(session), initTranscript, turnTranscript);
    if (session.supervisorInstanceId && session.supervisorLeaseEpoch > 0) {
      supervisor.restoreRuntime(session);
    }
    return restored;
  }

  async function updateRecoveryOutcome(sessionId: string, recoveryOutcome: 'none' | 'same_thread_resumed' | 'same_rollout_thread_restarted') {
    return repository.updateSession(sessionId, { recoveryOutcome });
  }

  async function getWorkspaceVersionMetas(session: AiSessionRecord) {
    const events = await repository.listEvents(session.id);
    const byVersion = new Map<number, { workspaceVersion: number; createdAt: string; sourceTargetId: string | null }>();
    const latestVisibleVersion = getLatestWorkspaceVersion(session);

    const register = (workspaceVersion: number | null | undefined, createdAt: string, sourceTargetId: string | null) => {
      if (!workspaceVersion || workspaceVersion <= 0 || workspaceVersion > latestVisibleVersion || byVersion.has(workspaceVersion)) {
        return;
      }
      byVersion.set(workspaceVersion, { workspaceVersion, createdAt, sourceTargetId });
    };

    for (const event of events) {
      if (event.type === 'workspace.hydrated') {
        register(Number(event.payload.workspaceVersion ?? 0), event.createdAt, null);
      }
      if (event.type === 'workspace.version_staged') {
        register(Number(event.payload.stagedWorkspaceVersion ?? 0), event.createdAt, typeof event.payload.baseTargetId === 'string' ? event.payload.baseTargetId : null);
      }
    }

    for (let workspaceVersion = 1; workspaceVersion <= latestVisibleVersion; workspaceVersion += 1) {
      if (!byVersion.has(workspaceVersion)) {
        register(workspaceVersion, session.createdAt, null);
      }
    }

    return [...byVersion.values()]
      .sort((left, right) => left.workspaceVersion - right.workspaceVersion)
      .map(item => ({
        versionId: getAiSessionVersionTargetId(item.workspaceVersion),
        workspaceVersion: item.workspaceVersion,
        createdAt: item.createdAt,
        isActive: item.workspaceVersion === getActiveWorkspaceVersion(session),
        isLatest: item.workspaceVersion === getLatestWorkspaceVersion(session),
        sourceTargetId: item.sourceTargetId,
      }));
  }

  async function tryResumeExistingThread(session: AiSessionRecord) {
    if (!session.appServerThreadId || session.boxStatus !== 'ready') {
      return null;
    }

    const sandboxProvider = getSandboxProvider();
    const daemonHealth = await getCodexAppServerDaemonHealth(sandboxProvider, session.id);
    if (!daemonHealth?.ok || !daemonHealth.initialized || daemonHealth.threadId !== session.appServerThreadId) {
      return null;
    }

    const restoredTransport = await rehydrateTransportRuntime(session);
    supervisor.restoreRuntime(session);
    const readySnapshot = markAiSessionTransportReady(session.id, session.appServerThreadId);
    await persistTransportSnapshot(session.id, readySnapshot);
    const updatedSession = await repository.updateSession(session.id, {
      appServerStatus: 'healthy',
      daemonStatus: 'healthy',
      continuityState: 'resumable',
      resumeEligibility: 'resumable',
      recoveryOutcome: 'same_thread_resumed',
      lastFailureCode: null,
    });
    await repository.appendEvent({
      sessionId: session.id,
      type: 'transport.recovered_same_thread',
      payload: {
        threadId: session.appServerThreadId,
        restoredPhase: restoredTransport.phase,
      },
    });
    return { session: updatedSession, transport: readySnapshot };
  }

  return {
    async createSession(input: CreateAiSessionInput): Promise<AiSessionRecord> {
      const existingSessions = await repository.listProjectSessions(input.projectId);
      const conflictingSession = existingSessions.find(session => isActiveWriterSession(session));
      if (conflictingSession) {
        throw new AiSessionConflictError(input.projectId);
      }

      const now = new Date();
      const ttlMs = (input.leaseTtlSeconds ?? DEFAULT_LEASE_TTL_SECONDS) * 1000;
      const sessionId = randomUUID();
      const record: AiSessionRecord = {
        id: sessionId,
        projectId: input.projectId,
        ownerId: input.ownerId,
        baseVersion: input.baseVersion,
        activeWorkspaceVersion: 1,
        latestWorkspaceVersion: 1,
        status: 'provisioning',
        authMode: input.authMode ?? 'chatgptAuthTokens',
        authState: 'bootstrap_pending',
        boxId: null,
        codexHomeKey: getAiSessionWorkspaceRoot(sessionId),
        boxStatus: 'unassigned',
        appServerStatus: 'unassigned',
        daemonStatus: 'stopped',
        appServerThreadId: null,
        threadMaterializedAt: null,
        transportPhase: 'uninitialized',
        transportInitializedAt: null,
        transportLastActivityAt: null,
        transportIdleDeadlineAt: null,
        transportLastErrorCode: null,
        transportLastErrorMessage: null,
        continuityState: 'new',
        resumeEligibility: 'not_resumable',
        recoveryOutcome: 'none',
        supervisorInstanceId: null,
        supervisorLeaseEpoch: 0,
        lastSupervisorHeartbeatAt: null,
        lastFailureCode: null,
        currentLeaseToken: randomUUID(),
        leaseHeartbeatAt: now.toISOString(),
        leaseExpiresAt: new Date(now.getTime() + ttlMs).toISOString(),
        lastCheckpointVersion: null,
        lastCheckpointId: null,
        revokedAt: null,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      };

      const created = await repository.createSession(record);
      await repository.appendEvent({
        sessionId: created.id,
        type: 'session.provisioning',
        payload: { baseVersion: created.baseVersion, authMode: created.authMode },
      });
      return created;
    },

    async getSession(sessionId: string): Promise<AiSessionRecord | null> {
      return repository.getSession(sessionId);
    },

    async getTransportSnapshot(sessionId: string): Promise<AiSessionTransportSnapshot | null> {
      const session = await repository.getSession(sessionId);
      if (!session) {
        return null;
      }

      await rehydrateTransportRuntime(session);

      const expired = expireAiSessionTransportIfIdle(sessionId);
      if (expired) {
        await repository.updateSession(sessionId, {
          appServerStatus: 'stopped',
          appServerThreadId: null,
          continuityState: 'restart_required',
          resumeEligibility: 'restart_required',
          recoveryOutcome: 'none',
        });
        await persistTransportSnapshot(sessionId, expired);
      }

      const freshSession = (expired ? await repository.getSession(sessionId) : session) ?? session;
      return getAiSessionTransportSnapshot(freshSession);
    },

    async listTransportLogs(sessionId: string) {
      const session = await repository.getSession(sessionId);
      if (!session) {
        throw new Error(`Unknown AI session ${sessionId}`);
      }

      await rehydrateTransportRuntime(session);

      const expired = expireAiSessionTransportIfIdle(sessionId);
      if (expired) {
        await repository.updateSession(sessionId, {
          appServerStatus: 'stopped',
          appServerThreadId: null,
          continuityState: 'restart_required',
          resumeEligibility: 'restart_required',
          recoveryOutcome: 'none',
        });
        await persistTransportSnapshot(sessionId, expired);
      }

      return listAiSessionTransportLogs(sessionId);
    },

    async listWorkspaceVersions(sessionId: string) {
      const session = await repository.getSession(sessionId);
      if (!session) {
        throw new Error(`Unknown AI session ${sessionId}`);
      }

      return getWorkspaceVersionMetas(session);
    },

    async getWorkspaceVersionPayload(sessionId: string, versionId: string) {
      const session = await repository.getSession(sessionId);
      if (!session) {
        throw new Error(`Unknown AI session ${sessionId}`);
      }

      const workspaceVersion = parseAiSessionVersionTargetId(versionId);
      if (!workspaceVersion) {
        throw new Error(`Unknown workspace version: ${versionId}`);
      }

      if (workspaceVersion > getLatestWorkspaceVersion(session)) {
        throw new Error(`Workspace version not found: ${versionId}`);
      }

      const pkg = await readWorkspacePackageVersion(sessionId, workspaceVersion);
      return {
        versionId,
        workspaceVersion,
        package: pkg,
        isActive: workspaceVersion === getActiveWorkspaceVersion(session),
        isLatest: workspaceVersion === getLatestWorkspaceVersion(session),
      };
    },

    async listProjectSessions(projectId: string): Promise<AiSessionRecord[]> {
      return repository.listProjectSessions(projectId);
    },

    async listEvents(sessionId: string): Promise<AiSessionEventRecord[]> {
      return repository.listEvents(sessionId);
    },

    async markReady(sessionId: string): Promise<AiSessionRecord> {
      const updated = await repository.updateSession(sessionId, {
        status: 'ready',
        authState: 'ready',
        boxStatus: 'ready',
        appServerStatus: 'healthy',
        recoveryOutcome: 'none',
      });
      await repository.appendEvent({ sessionId, type: 'session.ready' });
      return updated;
    },

    async touchLease(sessionId: string, leaseToken: string, leaseTtlSeconds = DEFAULT_LEASE_TTL_SECONDS): Promise<AiSessionRecord> {
      const session = await repository.getSession(sessionId);
      if (!session) {
        throw new AiSessionLeaseError(`Unknown AI session ${sessionId}`);
      }
      if (session.revokedAt || session.status === 'revoked') {
        throw new AiSessionLeaseError(`AI session ${sessionId} has been revoked.`);
      }
      if (session.currentLeaseToken !== leaseToken) {
        throw new AiSessionLeaseError(`Lease token mismatch for AI session ${sessionId}.`);
      }

      const now = new Date();
      return repository.updateSession(sessionId, {
        leaseHeartbeatAt: now.toISOString(),
        leaseExpiresAt: new Date(now.getTime() + leaseTtlSeconds * 1000).toISOString(),
      });
    },

    async blockAuth(sessionId: string): Promise<AiSessionRecord> {
      const updated = await repository.updateSession(sessionId, {
        status: 'auth_blocked',
        authState: 'blocked',
      });
      await repository.appendEvent({ sessionId, type: 'auth.blocked' });
      return updated;
    },

    async revokeSession(sessionId: string): Promise<AiSessionRecord> {
      const now = new Date().toISOString();
      const updated = await repository.updateSession(sessionId, {
        status: 'revoked',
        authState: 'revoked',
        continuityState: 'revoked',
        resumeEligibility: 'not_resumable',
        recoveryOutcome: 'none',
        daemonStatus: 'terminated',
        lastFailureCode: null,
        revokedAt: now,
        leaseExpiresAt: now,
      });
      clearAiSessionTransport(sessionId);
      supervisor.terminateRuntime(sessionId);
      await repository.appendEvent({ sessionId, type: 'session.revoked' });
      return updated;
    },

    async bootstrapSession(sessionId: string, bindToken: string): Promise<AiSessionRecord> {
      const session = await repository.getSession(sessionId);
      if (!session) {
        throw new Error(`Unknown AI session ${sessionId}`);
      }

      if (session.revokedAt || session.status === 'revoked') {
        throw new AiSessionLeaseError(`AI session ${sessionId} has been revoked.`);
      }

      await repository.appendEvent({ sessionId, type: 'session.bootstrap_started' });
      let updated = await repository.updateSession(sessionId, {
        status: 'hydrating',
        boxStatus: 'provisioning',
        appServerStatus: 'starting',
        daemonStatus: 'starting',
        continuityState: 'auth_ready',
        resumeEligibility: 'not_resumable',
        recoveryOutcome: 'none',
        codexHomeKey: getAiSessionWorkspaceRoot(sessionId),
        lastFailureCode: null,
      });

      const hostTokenClient = HostTokenServiceClient.fromEnv();
      const hostTokens = await hostTokenClient.bootstrap({ sessionId, bindToken });
      await repository.appendEvent({
        sessionId,
        type: 'auth.bootstrap_ready',
        payload: {
          expiresAt: hostTokens.expiresAt,
          accountId: hostTokens.accountId ?? null,
        },
      });

      const sandboxProvider = getSandboxProvider();
      const readiness = sandboxProvider.getReadiness();
      if (!readiness.configured) {
        updated = await repository.updateSession(sessionId, {
          status: 'failed',
          boxStatus: 'failed',
          appServerStatus: 'failed',
        });
        await repository.appendEvent({
          sessionId,
          type: 'session.bootstrap_failed',
          payload: { reason: readiness.reason ?? 'Sandbox is not configured.' },
        });
        return updated;
      }

      const baseProject = await projectService.getProject(session.projectId);
      if (!baseProject) {
        throw new Error(`Project not found: ${session.projectId}`);
      }

      const filesToHydrate = await Promise.all(
        CANONICAL_PACKAGE_FILE_PATHS.map(async path => ({
          path: getAiSessionWorkspaceFilePath(sessionId, path, 1),
          content: (await projectService.readProjectFile(session.projectId, session.baseVersion, path)) ?? '',
        })),
      );
      await sandboxProvider.writeFiles([
        ...filesToHydrate,
        ...createWorkspaceContractFiles(`${getAiSessionWorkspaceRoot(sessionId)}/v1`),
      ]);
      await repository.appendEvent({
        sessionId,
        type: 'workspace.hydrated',
        payload: {
          baseVersion: session.baseVersion,
          workspaceRoot: `${getAiSessionWorkspaceRoot(sessionId)}/v1`,
          workspaceVersion: 1,
        },
      });

      updated = await repository.updateSession(sessionId, {
        status: 'ready',
        authState: 'ready',
        boxId: sandboxProvider.getBoxId(),
        codexHomeKey: getAiSessionWorkspaceRoot(sessionId),
        boxStatus: 'ready',
        appServerStatus: 'stopped',
        daemonStatus: 'stopped',
        appServerThreadId: null,
        threadMaterializedAt: null,
        transportPhase: 'uninitialized',
        transportInitializedAt: null,
        transportLastActivityAt: null,
        transportIdleDeadlineAt: null,
        transportLastErrorCode: null,
        transportLastErrorMessage: null,
        continuityState: 'auth_ready',
        resumeEligibility: 'not_resumable',
        recoveryOutcome: 'none',
        lastFailureCode: null,
      });

      await repository.appendEvent({
        sessionId,
        type: 'transport.ready',
        payload: {
          boxId: sandboxProvider.getBoxId(),
          mode: 'stdio-manual-init',
        },
      });

      return updated;
    },

    async initializeTransport(sessionId: string, bindToken: string | null): Promise<{ session: AiSessionRecord; transport: AiSessionTransportSnapshot }> {
      let session = await repository.getSession(sessionId);
      if (!session) {
        throw new Error(`Unknown AI session ${sessionId}`);
      }

      if (session.revokedAt || session.status === 'revoked') {
        throw new AiSessionLeaseError(`AI session ${sessionId} has been revoked.`);
      }

      await rehydrateTransportRuntime(session);

      const currentTransport = await this.getTransportSnapshot(sessionId);
      const currentRuntime = supervisor.getRuntime(session);
      if (currentTransport?.phase === 'ready' && session.appServerThreadId) {
        if (hasAiSessionTransportRuntime(sessionId) && currentRuntime) {
          return { session, transport: currentTransport };
        }
        const resumed = await tryResumeExistingThread(session);
        if (resumed) {
          return resumed;
        }
      }

      if (session.status !== 'ready' || session.boxStatus !== 'ready' || session.authState !== 'ready') {
        if (!bindToken?.trim()) {
          throw new AiSessionTransportNotInitializedError('Bind token is required to bootstrap this AI session transport.');
        }
        session = await this.bootstrapSession(sessionId, bindToken);
      }

      await persistTransportSnapshot(sessionId, startAiSessionTransportInit(sessionId));
      await appendTransportLog(sessionId, 'init', 'system', 'Starting Codex init sequence.');
      const runtime = supervisor.beginRuntime(session);
      await repository.updateSession(sessionId, {
        supervisorInstanceId: runtime.supervisorInstanceId,
        supervisorLeaseEpoch: runtime.supervisorLeaseEpoch,
        lastSupervisorHeartbeatAt: runtime.lastHeartbeatAt,
        daemonStatus: 'starting',
        continuityState: 'daemon_starting',
        resumeEligibility: 'not_resumable',
        recoveryOutcome: session.appServerThreadId ? 'same_rollout_thread_restarted' : 'none',
        lastFailureCode: null,
      });

      const sandboxProvider = getSandboxProvider();
      const runtimeState = await sandboxProvider.ensureCodexRuntime();
      if (!runtimeState.ready) {
        await repository.updateSession(sessionId, {
          appServerStatus: 'failed',
          daemonStatus: 'degraded',
          appServerThreadId: null,
          continuityState: 'failed',
          resumeEligibility: 'restart_required',
          recoveryOutcome: 'none',
          lastFailureCode: 'codex_app_server_binary_missing',
        });
        await persistTransportSnapshot(sessionId, markAiSessionTransportLost(
          sessionId,
          'codex_app_server_binary_missing',
          runtimeState.reason ?? 'Codex runtime is not available in the Box.',
        ));
        throw new AiSessionTransportNotImplementedError(
          runtimeState.reason ?? 'Codex runtime is not available in the Box.',
          'codex_app_server_binary_missing',
        );
      }

      const appServerConfig = sandboxProvider.getDefaultCodexAppServerConfig();
      const hostTokenClient = HostTokenServiceClient.fromEnv();
      const hostTokens = await hostTokenClient.refresh({ sessionId, reason: 'unauthorized' });
      const hostTokenRuntime = {
        sessionId,
        url: hostTokenClient.getBaseUrl(),
        apiKey: hostTokenClient.getApiKey(),
      };
      const messages = [
        ...createInitializeMessages(),
        createExternalAuthLoginMessage(hostTokens),
        createThreadStartMessage(sessionId, getActiveWorkspaceVersion(session)),
      ];

      for (const message of messages) {
        await appendTransportLog(sessionId, 'init', 'outbound', message);
      }

      await ensureCodexAppServerDaemon(
        sandboxProvider,
        sessionId,
        appServerConfig,
        getAiSessionWorkspaceAbsoluteRoot(sessionId, getActiveWorkspaceVersion(session)),
        hostTokenRuntime,
      );
      const startResult = await callCodexAppServerDaemon(sandboxProvider, sessionId, {
        phase: 'init',
        messages,
        stopOnMethods: ['thread/started'],
        timeoutMs: 60000,
      });

      for (const message of startResult.messages) {
        await appendTransportLog(sessionId, 'init', 'inbound', message);
      }

      const loginError = findLoginError(startResult.messages);
      const runnerError = startResult.error ?? findRunnerError(startResult.messages);
      const threadStartError = findThreadStartError(startResult.messages);
      if (!didAccountLoginSucceed(startResult.messages) || loginError) {
        await repository.updateSession(sessionId, {
          appServerStatus: 'degraded',
          daemonStatus: 'degraded',
          appServerThreadId: null,
          continuityState: 'failed',
          resumeEligibility: 'restart_required',
          recoveryOutcome: 'none',
          lastFailureCode: 'codex_app_server_external_auth_login_failed',
        });
        await persistTransportSnapshot(sessionId, markAiSessionTransportLost(
          sessionId,
          'codex_app_server_external_auth_login_failed',
          loginError ?? 'Codex app-server external auth login did not succeed.',
        ));
        throw new AiSessionTransportNotImplementedError(
          loginError ?? 'Codex app-server external auth login did not succeed.',
          'codex_app_server_external_auth_login_failed',
        );
      }

      if (threadStartError || runnerError) {
        await repository.updateSession(sessionId, {
          appServerStatus: 'degraded',
          daemonStatus: 'degraded',
          appServerThreadId: null,
          continuityState: 'failed',
          resumeEligibility: 'restart_required',
          recoveryOutcome: 'none',
          lastFailureCode: threadStartError ? 'codex_app_server_thread_start_failed' : 'codex_app_server_runner_failed',
        });
        await persistTransportSnapshot(sessionId, markAiSessionTransportLost(
          sessionId,
          threadStartError ? 'codex_app_server_thread_start_failed' : 'codex_app_server_runner_failed',
          threadStartError ?? runnerError ?? 'Codex app-server init failed after login.',
        ));
        throw new AiSessionTransportNotImplementedError(
          threadStartError ?? runnerError ?? 'Codex app-server init failed after login.',
          threadStartError ? 'codex_app_server_thread_start_failed' : 'codex_app_server_runner_failed',
        );
      }

      const threadId = startResult.state.threadId ?? findThreadId(startResult.messages);
      if (!threadId) {
        await repository.updateSession(sessionId, {
          appServerStatus: 'degraded',
          daemonStatus: 'degraded',
          appServerThreadId: null,
          continuityState: 'failed',
          resumeEligibility: 'restart_required',
          recoveryOutcome: 'none',
          lastFailureCode: 'codex_app_server_thread_start_failed',
        });
        await persistTransportSnapshot(sessionId, markAiSessionTransportLost(sessionId, 'codex_app_server_thread_start_failed', 'Codex app-server did not return a thread id.'));
        throw new AiSessionTransportNotImplementedError(
          'Codex app-server did not return a thread id.',
          'codex_app_server_thread_start_failed',
        );
      }

      const updatedSession = await repository.updateSession(sessionId, {
        status: 'ready',
        appServerStatus: 'healthy',
        daemonStatus: 'healthy',
        appServerThreadId: threadId,
        continuityState: 'thread_started_provisional',
        resumeEligibility: 'provisional',
        recoveryOutcome: session.threadMaterializedAt ? 'same_rollout_thread_restarted' : 'none',
        lastSupervisorHeartbeatAt: new Date().toISOString(),
        lastFailureCode: null,
      });
      supervisor.updateRuntime(sessionId, {
        boxId: updatedSession.boxId,
        codexHomeKey: updatedSession.codexHomeKey,
        daemonStatus: 'healthy',
        continuityState: 'thread_started_provisional',
        resumeEligibility: 'provisional',
        threadId,
        lastFailureCode: null,
      });
      syncAiSessionTransportThreadId(sessionId, threadId);
      const transport = await persistTransportSnapshot(sessionId, markAiSessionTransportReady(sessionId, threadId));
      await repository.appendEvent({
        sessionId,
        type: 'transport.initialized',
        payload: {
          threadId,
          recoveryOutcome: updatedSession.recoveryOutcome,
        },
      });

      return { session: updatedSession, transport };
    },

    async checkpointSession(sessionId: string, idempotencyKey: string) {
      const session = await repository.getSession(sessionId);
      if (!session) {
        throw new Error(`Unknown AI session ${sessionId}`);
      }

      const existingCheckpoint = await repository.findCheckpointByIdempotencyKey(sessionId, idempotencyKey);
      if (existingCheckpoint) {
        return { session, checkpoint: existingCheckpoint, project: null };
      }

      const project = await projectService.getProject(session.projectId);
      if (!project) {
        throw new Error(`Project not found: ${session.projectId}`);
      }

      if (project.currentVersion !== session.baseVersion) {
        const checkpoint = await repository.createCheckpoint({
          sessionId,
          idempotencyKey,
          baseVersion: session.baseVersion,
          status: 'conflict',
          manifest: {
            reason: 'stale_base_conflict',
            currentVersion: project.currentVersion,
          },
        });
        await repository.appendEvent({
          sessionId,
          type: 'checkpoint.conflict',
          payload: { baseVersion: session.baseVersion, currentVersion: project.currentVersion },
        });
        return { session, checkpoint, project };
      }

      await repository.updateSession(sessionId, { status: 'checkpointing' });
      const workspaceVersion = getActiveWorkspaceVersion(session);
      const pkg = await readWorkspacePackageVersion(sessionId, workspaceVersion);
      const persistedProject = await projectService.saveGeneratedPackage({
        projectId: session.projectId,
        pkg,
        source: 'modify',
        parentVersion: session.baseVersion,
      });
      const checkpoint = await repository.createCheckpoint({
        sessionId,
        idempotencyKey,
        baseVersion: session.baseVersion,
        newVersion: persistedProject.currentVersion,
        status: 'committed',
        manifest: {
          files: CANONICAL_PACKAGE_FILE_PATHS,
          newVersion: persistedProject.currentVersion,
        },
      });

      const updatedSession = await repository.updateSession(sessionId, {
        baseVersion: persistedProject.currentVersion,
        status: 'ready',
        lastCheckpointId: checkpoint.id,
        lastCheckpointVersion: checkpoint.newVersion,
      });
      await repository.appendEvent({
        sessionId,
        type: 'checkpoint.committed',
        payload: { idempotencyKey, newVersion: persistedProject.currentVersion, workspaceVersion },
      });

      return { session: updatedSession, checkpoint, project: persistedProject };
    },

    async executeMessage(sessionId: string, input: {
      mode: 'create' | 'modify' | 'debug';
      requestText: string;
      targetId?: string | null;
      routeMode?: 'design' | 'patch' | 'repair' | null;
      routeReason?: string | null;
      allowedPaths?: string[];
    }): Promise<{
      acknowledged: true;
      sessionId: string;
      acceptedAt: string;
      threadId: string;
      turnStatus: string | null;
      agentText: string;
      workspaceVersion: number;
      workspaceRoot: string;
      baseTargetId: string | null;
    }> {
      let session = await repository.getSession(sessionId);
      if (!session) {
        throw new Error(`Unknown AI session ${sessionId}`);
      }

      const recovered = await this.initializeTransport(sessionId, null);
      session = recovered.session;
      const transport = recovered.transport;
      let runtime = supervisor.getRuntime(session) ?? supervisor.restoreRuntime(session);

      if (!runtime) {
        const recoveredRuntime = supervisor.restoreRuntime(session);
        if (!recoveredRuntime) {
          await repository.updateSession(sessionId, {
            appServerStatus: 'stopped',
            daemonStatus: 'stopped',
            appServerThreadId: null,
            continuityState: 'continuity_lost',
            resumeEligibility: 'restart_required',
            recoveryOutcome: 'none',
            lastFailureCode: 'codex_supervisor_runtime_missing',
          });
          await persistTransportSnapshot(sessionId, syncAiSessionTransportThreadId(sessionId, null));
          throw new AiSessionTransportNotInitializedError('Codex supervisor runtime is missing for this AI session. Restart the session.');
        }
        runtime = recoveredRuntime;
      }

      supervisor.heartbeat(sessionId);
      await repository.updateSession(sessionId, {
        lastSupervisorHeartbeatAt: new Date().toISOString(),
      });

      if (session.status !== 'ready' || session.appServerStatus === 'failed') {
        throw new AiSessionMessageNotReadyError(`AI session ${sessionId} is not ready for message execution.`);
      }

      let executionWorkspaceVersion = getActiveWorkspaceVersion(session);
      let baseTargetId: string | null = null;
      if (input.mode !== 'create') {
        const resolvedBase = await resolveWorkspaceBasePackage(session, input.targetId ?? '__current__');
        executionWorkspaceVersion = getLatestWorkspaceVersion(session) + 1;
        await writeWorkspacePackageVersion(session.id, executionWorkspaceVersion, resolvedBase.pkg);
        baseTargetId = resolvedBase.sourceTargetId;
        await repository.appendEvent({
          sessionId,
          type: 'workspace.version_staged',
          payload: {
            mode: input.mode,
            baseTargetId,
            stagedWorkspaceVersion: executionWorkspaceVersion,
          },
        });
      }

      const workspaceRoot = getAiSessionWorkspaceAbsoluteRoot(sessionId, executionWorkspaceVersion);

      await repository.appendEvent({
        sessionId,
        type: 'message.requested',
        payload: {
          mode: input.mode,
          targetId: input.targetId ?? null,
          baseTargetId,
          routeMode: input.routeMode ?? null,
          routeReason: input.routeReason ?? null,
          allowedPaths: input.allowedPaths ?? [],
          workspaceVersion: executionWorkspaceVersion,
          workspaceRoot,
        },
      });
      await repository.updateSession(sessionId, { status: 'busy' });
      await persistTransportSnapshot(sessionId, startAiSessionTransportTurn(sessionId));
      try {
        await appendTransportLog(
          sessionId,
          'turn',
          'system',
          `Starting ${input.mode} turn in workspace v${executionWorkspaceVersion}.`,
        );

        const sandboxProvider = getSandboxProvider();
        const daemonHealth = await getCodexAppServerDaemonHealth(sandboxProvider, sessionId);
        if (!daemonHealth) {
          await repository.updateSession(sessionId, {
            status: 'ready',
            appServerStatus: 'stopped',
            daemonStatus: 'stopped',
            appServerThreadId: null,
            continuityState: 'continuity_lost',
            resumeEligibility: 'restart_required',
            recoveryOutcome: 'none',
            lastFailureCode: 'codex_daemon_unreachable',
          });
          await persistTransportSnapshot(sessionId, markAiSessionTransportLost(sessionId, 'codex_daemon_unreachable', 'Codex daemon is not reachable for this AI session.'));
          supervisor.updateRuntime(sessionId, {
            daemonStatus: 'stopped',
            continuityState: 'continuity_lost',
            resumeEligibility: 'restart_required',
            threadId: null,
            lastFailureCode: 'codex_daemon_unreachable',
          });
          await persistTransportSnapshot(sessionId, syncAiSessionTransportThreadId(sessionId, null));
          throw new AiSessionTransportNotInitializedError('Codex daemon is not reachable for this AI session. Restart the session.');
        }

        const runtimeState = await sandboxProvider.ensureCodexRuntime();
        if (!runtimeState.ready) {
          await repository.updateSession(sessionId, {
            status: 'ready',
            appServerStatus: 'failed',
            daemonStatus: 'degraded',
            appServerThreadId: null,
            continuityState: 'failed',
            resumeEligibility: 'restart_required',
            recoveryOutcome: 'none',
            lastFailureCode: 'codex_app_server_binary_missing',
          });
          await persistTransportSnapshot(sessionId, markAiSessionTransportLost(
            sessionId,
            'codex_app_server_binary_missing',
            runtimeState.reason ?? 'Codex runtime is not available in the Box.',
          ));
          supervisor.updateRuntime(sessionId, {
            daemonStatus: 'degraded',
            continuityState: 'failed',
            resumeEligibility: 'restart_required',
            threadId: null,
            lastFailureCode: 'codex_app_server_binary_missing',
          });
          throw new AiSessionTransportNotImplementedError(
            runtimeState.reason ?? 'Codex runtime is not available in the Box.',
            'codex_app_server_binary_missing',
          );
        }
        const appServerConfig = sandboxProvider.getDefaultCodexAppServerConfig();
        const hostTokenClient = HostTokenServiceClient.fromEnv();
        const hostTokens = await hostTokenClient.refresh({ sessionId, reason: 'unauthorized' });
        const acceptedAt = new Date().toISOString();
        const hostTokenRuntime = {
          sessionId,
          url: hostTokenClient.getBaseUrl(),
          apiKey: hostTokenClient.getApiKey(),
        };

        const threadId = session.appServerThreadId;
        await ensureCodexAppServerDaemon(
          sandboxProvider,
          sessionId,
          appServerConfig,
          workspaceRoot,
          hostTokenRuntime,
        );
        const messages = [createTurnStartMessage(threadId, input.requestText, workspaceRoot)];

        await repository.appendEvent({
          sessionId,
          type: 'message.dispatched_to_daemon',
          payload: {
            mode: input.mode,
            threadId,
            workspaceVersion: executionWorkspaceVersion,
            workspaceRoot,
            baseTargetId,
          },
        });

        for (const message of messages) {
          await appendTransportLog(sessionId, 'turn', 'outbound', message);
        }

        const turnResult = await callCodexAppServerDaemon(sandboxProvider, sessionId, {
          phase: 'turn',
          messages,
          stopOnMethods: ['turn/completed'],
          timeoutMs: 300000,
        });

        for (const message of turnResult.messages) {
          await appendTransportLog(sessionId, 'turn', 'inbound', message);
        }

        const protocolError = findJsonRpcError(turnResult.messages);
        const turnStatus = findTurnCompletedStatus(turnResult.messages);
        const agentText = collectAgentMessageText(turnResult.messages);
        if (!turnResult.ok || protocolError || !turnStatus || turnStatus === 'interrupted') {
          await repository.updateSession(sessionId, {
            status: 'ready',
            appServerStatus: 'degraded',
            daemonStatus: 'degraded',
            appServerThreadId: null,
            continuityState: 'continuity_lost',
            resumeEligibility: 'restart_required',
            recoveryOutcome: 'none',
            lastFailureCode: 'codex_app_server_turn_failed',
          });
          await persistTransportSnapshot(sessionId, markAiSessionTransportLost(
            sessionId,
            'codex_app_server_turn_failed',
            protocolError ?? turnResult.error ?? `Codex app-server turn did not complete successfully (${turnStatus ?? 'unknown'}).`,
          ));
          supervisor.updateRuntime(sessionId, {
            daemonStatus: 'degraded',
            continuityState: 'continuity_lost',
            resumeEligibility: 'restart_required',
            threadId: null,
            lastFailureCode: 'codex_app_server_turn_failed',
          });
          throw new AiSessionTransportNotImplementedError(
            protocolError ?? turnResult.error ?? `Codex app-server turn did not complete successfully (${turnStatus ?? 'unknown'}).`,
            'codex_app_server_turn_failed',
          );
        }

        await repository.updateSession(sessionId, {
          status: 'ready',
          appServerStatus: 'healthy',
          daemonStatus: 'healthy',
          threadMaterializedAt: session.threadMaterializedAt ?? acceptedAt,
          continuityState: session.threadMaterializedAt ? 'resumable' : 'first_turn_materialized',
          resumeEligibility: 'resumable',
          lastSupervisorHeartbeatAt: new Date().toISOString(),
          lastFailureCode: null,
        });
        supervisor.updateRuntime(sessionId, {
          daemonStatus: 'healthy',
          continuityState: session.threadMaterializedAt ? 'resumable' : 'first_turn_materialized',
          resumeEligibility: 'resumable',
          threadId,
          threadMaterializedAt: session.threadMaterializedAt ?? acceptedAt,
          lastFailureCode: null,
        });
        await persistTransportSnapshot(sessionId, finishAiSessionTransportTurn(sessionId));
        await repository.appendEvent({
          sessionId,
          type: 'message.turn_completed',
          payload: {
            threadId,
            turnStatus,
            agentText,
            workspaceVersion: executionWorkspaceVersion,
            workspaceRoot,
            baseTargetId,
            recoveryOutcome: session.recoveryOutcome,
          },
        });

        return {
          acknowledged: true,
          sessionId,
          acceptedAt,
          threadId,
          turnStatus,
          agentText,
          workspaceVersion: executionWorkspaceVersion,
          workspaceRoot,
          baseTargetId,
        };
      } catch (error) {
        const alreadyHandled =
          error instanceof AiSessionTransportNotInitializedError ||
          error instanceof AiSessionTransportNotImplementedError ||
          error instanceof AiSessionMessageNotReadyError;
        if (!alreadyHandled) {
          await repository.updateSession(sessionId, {
            status: 'ready',
            appServerStatus: 'degraded',
            daemonStatus: 'degraded',
            appServerThreadId: null,
            continuityState: 'continuity_lost',
            resumeEligibility: 'restart_required',
            recoveryOutcome: 'none',
            lastFailureCode: 'codex_turn_unexpected_error',
          });
          await persistTransportSnapshot(
            sessionId,
            markAiSessionTransportLost(
              sessionId,
              'codex_turn_unexpected_error',
              error instanceof Error ? error.message : 'Unexpected error during Codex turn execution.',
            ),
          );
          supervisor.updateRuntime(sessionId, {
            daemonStatus: 'degraded',
            continuityState: 'continuity_lost',
            resumeEligibility: 'restart_required',
            threadId: null,
            lastFailureCode: 'codex_turn_unexpected_error',
          });
          await persistTransportSnapshot(sessionId, syncAiSessionTransportThreadId(sessionId, null));
        }
        throw error;
      }
    },

    async promoteWorkspaceVersion(sessionId: string, workspaceVersion: number) {
      const session = await repository.getSession(sessionId);
      if (!session) {
        throw new Error(`Unknown AI session ${sessionId}`);
      }

      const updated = await repository.updateSession(sessionId, {
        activeWorkspaceVersion: workspaceVersion,
        latestWorkspaceVersion: Math.max(workspaceVersion, getLatestWorkspaceVersion(session)),
      });
      await repository.appendEvent({
        sessionId,
        type: 'workspace.promoted',
        payload: {
          workspaceVersion,
          workspaceTargetId: getAiSessionVersionTargetId(workspaceVersion),
          workspaceRoot: getAiSessionWorkspaceAbsoluteRoot(sessionId, workspaceVersion),
        },
      });
      return updated;
    },

    async readWorkspacePackage(sessionId: string, workspaceVersion?: number) {
      const session = await repository.getSession(sessionId);
      if (!session) {
        throw new Error(`Unknown AI session ${sessionId}`);
      }

      const resolvedWorkspaceVersion = workspaceVersion ?? getActiveWorkspaceVersion(session);
      const pkg = await readWorkspacePackageVersion(sessionId, resolvedWorkspaceVersion);
      await repository.appendEvent({
        sessionId,
        type: 'workspace.readback',
        payload: {
          workspaceVersion: resolvedWorkspaceVersion,
          workspaceTargetId: getAiSessionVersionTargetId(resolvedWorkspaceVersion),
        },
      });
      return pkg;
    },

    async writeWorkspacePackage(sessionId: string, pkg: {
      indexHtml: string;
      gameJs: string;
      styleCss: string;
      manifestJson: string;
    }, workspaceVersion?: number) {
      const session = await repository.getSession(sessionId);
      if (!session) {
        throw new Error(`Unknown AI session ${sessionId}`);
      }

      const resolvedWorkspaceVersion = workspaceVersion ?? getActiveWorkspaceVersion(session);
      await writeWorkspacePackageVersion(sessionId, resolvedWorkspaceVersion, pkg);
      await repository.appendEvent({
        sessionId,
        type: 'workspace.package_written',
        payload: {
          workspaceVersion: resolvedWorkspaceVersion,
          workspaceTargetId: getAiSessionVersionTargetId(resolvedWorkspaceVersion),
          sizes: {
            indexHtml: pkg.indexHtml.length,
            gameJs: pkg.gameJs.length,
            styleCss: pkg.styleCss.length,
            manifestJson: pkg.manifestJson.length,
          },
        },
      });
    },
  };
}
