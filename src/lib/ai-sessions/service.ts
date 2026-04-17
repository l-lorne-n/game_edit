import { createHash, randomUUID } from 'node:crypto';

import { HostTokenServiceClient } from '@/lib/host-tokens/client';
import {
  appendAiSessionTransportLog,
  appendAiSessionTransportLogs,
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
  getCodexAppServerDaemonTurnMessages,
  getCodexAppServerDaemonTurnResult,
  getCodexAppServerDaemonTurnStatus,
  getCodexAppServerDaemonHealth,
  submitCodexAppServerDaemonTurn,
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
import { recoverPackageFromAgentText } from '@/lib/ai/codex-agent-text-package';
import type { ModelAttempt } from '@/lib/ai/types';
import { createExecutionStage, type ExecutionOutcome, type FailureContext, type PackageExecutionTraceMeta } from '@/lib/ai/execution-trace';
import { evaluatePackageStatic } from '@/lib/evaluator/static';
import type { EvaluatorResult } from '@/lib/evaluator/types';
import { parseGeneratedGamePackage, type GamePackageManifest, type GeneratedGamePackage } from '@/lib/package/contracts';
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
  AiSessionTurnRecord,
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

export class AiSessionTurnConflictError extends Error {
  readonly code = 'ai_session_turn_conflict';

  constructor(message: string) {
    super(message);
  }
}

type ExecuteMessageInput = {
  mode: 'create' | 'modify' | 'debug';
  requestText: string;
  targetId?: string | null;
  routeMode?: 'design' | 'patch' | 'repair' | null;
  routeReason?: string | null;
  allowedPaths?: string[];
};

type MessageTurnSubmitResult = {
  acknowledged: true;
  deduplicated: boolean;
  sessionId: string;
  turnId: string;
  acceptedAt: string;
  threadId: string;
  workspaceVersion: number;
  workspaceRoot: string;
  baseTargetId: string | null;
  status: AiSessionTurnRecord['status'];
  artifactState: AiSessionTurnRecord['artifactState'];
};

type MessageTurnResult = {
  acknowledged: true;
  sessionId: string;
  turnId: string;
  acceptedAt: string;
  threadId: string;
  turnStatus: string | null;
  agentText: string;
  workspaceVersion: number;
  workspaceRoot: string;
  baseTargetId: string | null;
  artifactState: AiSessionTurnRecord['artifactState'];
  finalOutcome: AiSessionTurnRecord['finalOutcome'];
  recoveryOutcome: AiSessionTurnRecord['recoveryOutcome'];
  failureCode: string | null;
  failureMessage: string | null;
  package: GeneratedGamePackage | null;
  manifest: GamePackageManifest | null;
  staticEvaluation: EvaluatorResult | null;
  statusMessage: string;
  executionEngine: PackageExecutionTraceMeta | null;
  repaired: boolean;
  fallbackUsed: boolean;
  source: string;
  provider: string;
  model: string;
  attempts: ModelAttempt[];
};

type StructuredTransportFailure = {
  code: string;
  message: string;
};

function getStructuredTransportFailureFromMessages(messages: Record<string, unknown>[]): StructuredTransportFailure | null {
  for (const message of messages) {
    if ('error' in message) {
      const error = message.error as { message?: string; data?: { code?: string } } | undefined;
      if (typeof error?.data?.code === 'string') {
        return {
          code: error.data.code,
          message: error.message ?? 'Unknown app-server protocol error.',
        };
      }
    }

    if (message.method === 'daemon/error' || message.method === 'error') {
      const params = message.params as { code?: string; message?: string } | undefined;
      if (typeof params?.code === 'string') {
        return {
          code: params.code,
          message: params.message ?? 'Unknown daemon error.',
        };
      }
    }
  }

  return null;
}

function getStructuredTransportFailureFromError(error: unknown): StructuredTransportFailure | null {
  if (error instanceof AiSessionTransportNotImplementedError) {
    return {
      code: error.reason,
      message: error.message,
    };
  }

  if (error instanceof Error && typeof (error as Error & { code?: unknown }).code === 'string') {
    return {
      code: (error as Error & { code: string }).code,
      message: error.message,
    };
  }

  return null;
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

function isActiveTurnStatus(status: AiSessionTurnRecord['status']): boolean {
  return status === 'submitted' || status === 'running' || status === 'awaiting_artifact';
}

function isTerminalTurnStatus(status: AiSessionTurnRecord['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'rejected';
}

function createTurnRequestFingerprint(input: {
  mode: ExecuteMessageInput['mode'];
  requestText: string;
  targetId: string | null;
  routeMode: ExecuteMessageInput['routeMode'];
  routeReason: ExecuteMessageInput['routeReason'];
  allowedPaths: string[];
  workspaceVersion: number;
}): string {
  return createHash('sha256')
    .update(JSON.stringify(input))
    .digest('hex');
}

function fingerprintPackage(pkg: GeneratedGamePackage | null): string | null {
  if (!pkg) {
    return null;
  }
  return JSON.stringify([pkg.indexHtml, pkg.gameJs, pkg.styleCss, pkg.manifestJson]);
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

  async function appendTransportLogs(
    sessionId: string,
    phase: 'init' | 'turn',
    direction: 'outbound' | 'inbound' | 'system',
    messages: unknown[],
    options?: { idForMessage?: (message: unknown, index: number) => string },
  ) {
    if (messages.length === 0) {
      return [];
    }

    const entries = appendAiSessionTransportLogs(
      sessionId,
      messages.map((message, index) => ({
        id: options?.idForMessage?.(message, index),
        phase,
        direction,
        message,
      })),
    );
    await repository.appendTransportLogs(sessionId, entries);
    const session = await repository.getSession(sessionId);
    const lastEntry = entries[entries.length - 1];
    if (session && lastEntry) {
      await repository.updateSession(sessionId, {
        transportLastActivityAt: lastEntry.createdAt,
        transportIdleDeadlineAt: session.transportPhase !== 'initializing'
          ? new Date(new Date(lastEntry.createdAt).getTime() + 10 * 60 * 1000).toISOString()
          : null,
      });
    }
    return entries;
  }

  function shouldPersistInboundTurnTransportLogMessage(message: Record<string, unknown>) {
    const method = typeof message.method === 'string' ? message.method : null;
    if (!method) {
      return true;
    }

    if (method.endsWith('/delta') || method.endsWith('/chunk')) {
      return false;
    }

    return true;
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

  function toSubmittedTurnResult(turn: AiSessionTurnRecord): MessageTurnSubmitResult {
    return {
      acknowledged: true,
      deduplicated: false,
      sessionId: turn.sessionId,
      turnId: turn.id,
      acceptedAt: turn.acceptedAt,
      threadId: turn.threadId ?? '',
      workspaceVersion: turn.workspaceVersion,
      workspaceRoot: turn.workspaceRoot,
      baseTargetId: turn.baseTargetId,
      status: turn.status,
      artifactState: turn.artifactState,
    };
  }

  function buildTurnExecutionEngine(turn: AiSessionTurnRecord) {
    const diagnostics = turn.diagnostics ?? {};
    const outcome: ExecutionOutcome =
      turn.finalOutcome === 'failed'
        ? 'hard_failure'
        : turn.recoveryOutcome !== 'none'
          ? 'recovered_success'
          : 'direct_success';
    const failureContext: FailureContext | null =
      turn.failureCode || turn.failureMessage
        ? {
            checkpoint: 'transport_turn',
            reason: turn.failureCode === 'package_schema_validation_failed' ? 'invalid_schema' : 'turn_failed',
            code: turn.failureCode,
            message: turn.failureMessage ?? 'Codex turn failed.',
            transport: {
              phase: 'transport_lost',
              threadId: turn.threadId,
              requiresReinit: turn.finalOutcome === 'failed',
              lastErrorCode: turn.failureCode,
              lastErrorMessage: turn.failureMessage,
            },
            session: {
              sessionId: turn.sessionId,
              projectId: turn.projectId,
              status: turn.status,
              lastFailureCode: turn.failureCode,
              lastCheckpointId: null,
              lastCheckpointVersion: null,
            },
          }
        : null;
    return {
      requestedEngine: 'codex-app-server',
      actualEngine: 'codex-app-server',
      strategy: turn.mode === 'debug' ? 'repair_execute' : 'plan_then_execute',
      routeReason: turn.routeReason,
      allowedPaths: turn.allowedPaths,
      fallbackReason: turn.finalOutcome === 'completed' && turn.recoveryOutcome !== 'none'
        ? 'workspace_recovered_after_transport_error'
        : null,
      outcome,
      recovery:
        turn.recoveryOutcome !== 'none'
          ? {
              source: 'workspace' as const,
              reason: turn.recoveryOutcome,
              workspaceVersion: turn.workspaceVersion,
              recoveredFromFailureCode: typeof diagnostics.recoveredFromFailureCode === 'string' ? diagnostics.recoveredFromFailureCode : turn.failureCode,
              recoveredFromFailureMessage: typeof diagnostics.recoveredFromFailureMessage === 'string' ? diagnostics.recoveredFromFailureMessage : turn.failureMessage,
            }
          : null,
      stages: [
        createExecutionStage({
          key: 'transport_turn',
          status: turn.finalOutcome === 'failed' ? 'failed' : 'completed',
          durationMs:
            turn.startedAt && (turn.completedAt || turn.terminalAt)
              ? Math.max(0, new Date(turn.completedAt ?? turn.terminalAt ?? turn.startedAt).getTime() - new Date(turn.startedAt).getTime())
              : 0,
          detail: turn.failureMessage ?? turn.turnStatus ?? turn.status,
        }),
      ],
      failureContext,
    };
  }

  function toCompletedTurnResult(turn: AiSessionTurnRecord): MessageTurnResult {
    const resultPayload = turn.resultPayload ?? {};
    return {
      acknowledged: true,
      sessionId: turn.sessionId,
      turnId: turn.id,
      acceptedAt: turn.acceptedAt,
      threadId: turn.threadId ?? '',
      turnStatus: turn.turnStatus,
      agentText: turn.agentText,
      workspaceVersion: turn.workspaceVersion,
      workspaceRoot: turn.workspaceRoot,
      baseTargetId: turn.baseTargetId,
      artifactState: turn.artifactState,
      finalOutcome: turn.finalOutcome,
      recoveryOutcome: turn.recoveryOutcome,
      failureCode: turn.failureCode,
      failureMessage: turn.failureMessage,
      package: (resultPayload.package as GeneratedGamePackage | null | undefined) ?? null,
      manifest: (resultPayload.manifest as GamePackageManifest | null | undefined) ?? null,
      staticEvaluation: (resultPayload.staticEvaluation as EvaluatorResult | null | undefined) ?? null,
      statusMessage:
        typeof resultPayload.statusMessage === 'string'
          ? resultPayload.statusMessage
          : turn.failureMessage ?? (turn.finalOutcome === 'completed' ? 'Codex async turn completed.' : 'Codex async turn failed.'),
      executionEngine: buildTurnExecutionEngine(turn),
      repaired: Boolean(resultPayload.repaired),
      fallbackUsed: Boolean(resultPayload.fallbackUsed),
      source: typeof resultPayload.source === 'string' ? resultPayload.source : 'model',
      provider: typeof resultPayload.provider === 'string' ? resultPayload.provider : 'openai',
      model: typeof resultPayload.model === 'string' ? resultPayload.model : 'codex-app-server',
      attempts: Array.isArray(resultPayload.attempts) ? (resultPayload.attempts as ModelAttempt[]) : [],
    };
  }

  async function appendTurnInboundMessagesOnce(turn: AiSessionTurnRecord, messages: Record<string, unknown>[]) {
    const latestTurn = await repository.getTurn(turn.id);
    const persistedTurn = latestTurn ?? turn;
    const diagnostics = persistedTurn.diagnostics ?? {};
    if (diagnostics.transportLogsPersistedAt) {
      return persistedTurn;
    }

    const retainedMessages = messages.filter(shouldPersistInboundTurnTransportLogMessage);

    await appendTransportLogs(persistedTurn.sessionId, 'turn', 'inbound', retainedMessages, {
      idForMessage: (_message, index) => `${persistedTurn.id}:inbound:${index}`,
    });

    return repository.updateTurn(persistedTurn.id, {
      diagnostics: {
        ...diagnostics,
        transportLogsPersistedAt: new Date().toISOString(),
      },
    });
  }

  async function finalizeSuccessfulTurn(turn: AiSessionTurnRecord, messages: Record<string, unknown>[]) {
    let updatedTurn = await appendTurnInboundMessagesOnce(turn, messages);
    const turnStatus = findTurnCompletedStatus(messages);
    const agentText = collectAgentMessageText(messages);
    const nowIso = new Date().toISOString();
    let workspacePackage: GeneratedGamePackage;

    try {
      workspacePackage = await readWorkspacePackageVersion(updatedTurn.sessionId, updatedTurn.workspaceVersion);
    } catch (error) {
      return repository.updateTurn(updatedTurn.id, {
        status: 'awaiting_artifact',
        artifactState: 'pending',
        turnStatus,
        agentText,
        completedAt: updatedTurn.completedAt ?? nowIso,
        diagnostics: {
          ...updatedTurn.diagnostics,
          durableArtifactPending: true,
          artifactReadError: error instanceof Error ? error.message : String(error),
        },
      });
    }

    let parsed = parseGeneratedGamePackage(workspacePackage);
    if (!parsed.ok && agentText.trim()) {
      const recovered = recoverPackageFromAgentText(agentText);
      if (recovered.ok) {
        await writeWorkspacePackageVersion(updatedTurn.sessionId, updatedTurn.workspaceVersion, recovered.pkg);
        workspacePackage = recovered.pkg;
        parsed = recovered;
        updatedTurn = await repository.updateTurn(updatedTurn.id, {
          recoveryOutcome: 'same_rollout_thread_restarted',
          diagnostics: {
            ...updatedTurn.diagnostics,
            recoveredFromFailureCode: 'package_schema_validation_failed',
            recoveredFromFailureMessage: 'Recovered package from agent text.',
          },
        });
      }
    }

    if (!parsed.ok) {
      return finalizeFailedTurn(
        updatedTurn,
        messages,
        'package_schema_validation_failed',
        `${parsed.message}${parsed.issues?.length ? ` Issues: ${parsed.issues.join(' | ')}` : ''}`,
      );
    }

    const staticEvaluation = evaluatePackageStatic(parsed.pkg);

    updatedTurn = await repository.updateTurn(updatedTurn.id, {
      status: 'completed',
      artifactState: 'durable',
      artifactReadyAt: nowIso,
      completedAt: updatedTurn.completedAt ?? nowIso,
      terminalAt: nowIso,
      turnStatus,
      agentText,
      finalOutcome: 'completed',
      failureCode: null,
      failureMessage: null,
      diagnostics: {
        ...updatedTurn.diagnostics,
        durableArtifactPending: false,
      },
      resultPayload: {
        ...updatedTurn.resultPayload,
        package: parsed.pkg,
        manifest: parsed.manifest,
        staticEvaluation,
        repaired: updatedTurn.mode === 'debug',
        fallbackUsed: updatedTurn.recoveryOutcome !== 'none',
        source: 'model',
        statusMessage: turnStatus
          ? `Codex app-server completed turn with status: ${turnStatus}`
          : 'Codex app-server completed a turn.',
        provider: 'openai',
        model: 'codex-app-server',
        attempts: [],
      },
    });

    const latestSession = await repository.getSession(updatedTurn.sessionId);
    const nextLatestWorkspaceVersion = latestSession
      ? Math.max(updatedTurn.workspaceVersion, getLatestWorkspaceVersion(latestSession))
      : updatedTurn.workspaceVersion;

    await repository.updateSession(updatedTurn.sessionId, {
      status: 'ready',
      activeWorkspaceVersion: updatedTurn.workspaceVersion,
      latestWorkspaceVersion: nextLatestWorkspaceVersion,
      appServerStatus: 'healthy',
      daemonStatus: 'healthy',
      threadMaterializedAt: updatedTurn.acceptedAt,
      continuityState: 'resumable',
      resumeEligibility: 'resumable',
      lastSupervisorHeartbeatAt: nowIso,
      lastFailureCode: null,
    });
    supervisor.updateRuntime(updatedTurn.sessionId, {
      daemonStatus: 'healthy',
      continuityState: 'resumable',
      resumeEligibility: 'resumable',
      threadId: updatedTurn.threadId,
      threadMaterializedAt: updatedTurn.acceptedAt,
      lastFailureCode: null,
    });
    await persistTransportSnapshot(updatedTurn.sessionId, finishAiSessionTransportTurn(updatedTurn.sessionId));
    await repository.appendEvent({
      sessionId: updatedTurn.sessionId,
      type: 'message.turn_completed',
      payload: {
        turnId: updatedTurn.id,
        threadId: updatedTurn.threadId,
        turnStatus,
        agentText,
        workspaceVersion: updatedTurn.workspaceVersion,
        workspaceRoot: updatedTurn.workspaceRoot,
        baseTargetId: updatedTurn.baseTargetId,
        recoveryOutcome: updatedTurn.recoveryOutcome,
      },
    });
    await repository.appendEvent({
      sessionId: updatedTurn.sessionId,
      type: 'workspace.promoted',
      payload: {
        workspaceVersion: updatedTurn.workspaceVersion,
        workspaceTargetId: getAiSessionVersionTargetId(updatedTurn.workspaceVersion),
        workspaceRoot: updatedTurn.workspaceRoot,
      },
    });
    return updatedTurn;
  }

  async function finalizeFailedTurn(turn: AiSessionTurnRecord, messages: Record<string, unknown>[], code: string | null, message: string | null) {
    let updatedTurn = await appendTurnInboundMessagesOnce(turn, messages);
    const nowIso = new Date().toISOString();
    const failureCode = code ?? 'codex_app_server_turn_failed';
    const failureMessage = message ?? 'Codex app-server turn did not complete successfully.';

    try {
      const workspacePackage = await readWorkspacePackageVersion(updatedTurn.sessionId, updatedTurn.workspaceVersion);
      const parsed = parseGeneratedGamePackage(workspacePackage);
      const baselineFingerprint = typeof updatedTurn.diagnostics?.baselineFingerprint === 'string' ? updatedTurn.diagnostics.baselineFingerprint : null;
      let recovered = parsed;
      if (!recovered.ok) {
        const recoveredFromAgentText = recoverPackageFromAgentText(collectAgentMessageText(messages));
        if (recoveredFromAgentText.ok) {
          await writeWorkspacePackageVersion(updatedTurn.sessionId, updatedTurn.workspaceVersion, recoveredFromAgentText.pkg);
          recovered = recoveredFromAgentText;
        }
      }
      if (recovered.ok) {
        const nextFingerprint = fingerprintPackage(recovered.pkg);
        if (!baselineFingerprint || nextFingerprint !== baselineFingerprint) {
          const staticEvaluation = evaluatePackageStatic(recovered.pkg);
          if (staticEvaluation.ok) {
            const recoveredTurn = await repository.updateTurn(updatedTurn.id, {
              status: 'completed',
              artifactState: 'durable',
              completedAt: updatedTurn.completedAt ?? nowIso,
              terminalAt: nowIso,
              artifactReadyAt: nowIso,
              finalOutcome: 'completed',
              recoveryOutcome: 'same_rollout_thread_restarted',
              diagnostics: {
                ...updatedTurn.diagnostics,
                recoveredFromFailureCode: failureCode,
                recoveredFromFailureMessage: failureMessage,
              },
              resultPayload: {
                ...updatedTurn.resultPayload,
                package: recovered.pkg,
                manifest: recovered.manifest,
                staticEvaluation,
                repaired: updatedTurn.mode === 'debug',
                fallbackUsed: true,
                source: 'model',
                statusMessage: `Recovered package from workspace after transport error; re-initialize the AI session before the next turn. ${failureMessage}`,
                provider: 'openai',
                model: 'codex-app-server',
                attempts: [],
              },
            });
            const latestSession = await repository.getSession(updatedTurn.sessionId);
            const nextLatestWorkspaceVersion = latestSession
              ? Math.max(recoveredTurn.workspaceVersion, getLatestWorkspaceVersion(latestSession))
              : recoveredTurn.workspaceVersion;
            await repository.updateSession(updatedTurn.sessionId, {
              status: 'ready',
              activeWorkspaceVersion: recoveredTurn.workspaceVersion,
              latestWorkspaceVersion: nextLatestWorkspaceVersion,
              appServerStatus: 'degraded',
              daemonStatus: 'degraded',
              threadMaterializedAt: recoveredTurn.acceptedAt,
              continuityState: 'continuity_lost',
              resumeEligibility: 'restart_required',
              lastSupervisorHeartbeatAt: nowIso,
              lastFailureCode: failureCode,
            });
            await persistTransportSnapshot(updatedTurn.sessionId, markAiSessionTransportLost(updatedTurn.sessionId, failureCode, failureMessage));
            await repository.appendEvent({
              sessionId: updatedTurn.sessionId,
              type: 'message.turn_recovered',
              payload: {
                turnId: updatedTurn.id,
                workspaceVersion: updatedTurn.workspaceVersion,
                failureCode,
                failureMessage,
              },
            });
            return recoveredTurn;
          }
        }
      }
    } catch {
      // keep original hard failure path
    }

    updatedTurn = await repository.updateTurn(updatedTurn.id, {
      status: 'failed',
      artifactState: 'missing',
      completedAt: updatedTurn.completedAt ?? nowIso,
      terminalAt: nowIso,
      finalOutcome: 'failed',
      failureCode,
      failureMessage,
      diagnostics: {
        ...updatedTurn.diagnostics,
      },
    });

    await repository.updateSession(updatedTurn.sessionId, {
      status: 'ready',
      appServerStatus: 'degraded',
      daemonStatus: 'degraded',
      appServerThreadId: null,
      continuityState: 'continuity_lost',
      resumeEligibility: 'restart_required',
      recoveryOutcome: 'none',
      lastFailureCode: failureCode,
    });
    await persistTransportSnapshot(updatedTurn.sessionId, markAiSessionTransportLost(updatedTurn.sessionId, failureCode, failureMessage));
    supervisor.updateRuntime(updatedTurn.sessionId, {
      daemonStatus: 'degraded',
      continuityState: 'continuity_lost',
      resumeEligibility: 'restart_required',
      threadId: null,
      lastFailureCode: failureCode,
    });
    await persistTransportSnapshot(updatedTurn.sessionId, syncAiSessionTransportThreadId(updatedTurn.sessionId, null));
    await repository.appendEvent({
      sessionId: updatedTurn.sessionId,
      type: 'message.turn_failed',
      payload: {
        turnId: updatedTurn.id,
        workspaceVersion: updatedTurn.workspaceVersion,
        workspaceRoot: updatedTurn.workspaceRoot,
        failureCode,
        failureMessage,
      },
    });
    return updatedTurn;
  }

  async function syncTurnFromDaemon(turn: AiSessionTurnRecord): Promise<AiSessionTurnRecord> {
    if (isTerminalTurnStatus(turn.status)) {
      return turn;
    }

    const sandboxProvider = getSandboxProvider();
    const daemonStatus = await getCodexAppServerDaemonTurnStatus(sandboxProvider, turn.sessionId, turn.id).catch(() => null);
    if (!daemonStatus) {
      return turn;
    }

    let updatedTurn = turn;
    if (daemonStatus.phase === 'submitted' || daemonStatus.phase === 'running') {
      updatedTurn = await repository.updateTurn(turn.id, {
        status: daemonStatus.phase === 'submitted' ? 'submitted' : 'running',
        threadId: daemonStatus.state.threadId ?? turn.threadId,
        startedAt: daemonStatus.startedAt,
        completedAt: daemonStatus.completedAt,
        diagnostics: {
          ...turn.diagnostics,
          daemonPhase: daemonStatus.phase,
          daemonState: daemonStatus.state,
        },
      });
      return updatedTurn;
    }

    const daemonResult = await getCodexAppServerDaemonTurnResult(sandboxProvider, turn.sessionId, turn.id).catch(() => daemonStatus);
    if (!daemonResult) {
      return updatedTurn;
    }

    const messages =
      (await getCodexAppServerDaemonTurnMessages(sandboxProvider, turn.sessionId, turn.id).catch(() => [])) ?? [];

    updatedTurn = await repository.updateTurn(turn.id, {
      threadId: daemonResult.state.threadId ?? turn.threadId,
      startedAt: daemonResult.startedAt,
      completedAt: daemonResult.completedAt,
      diagnostics: {
        ...turn.diagnostics,
        daemonPhase: daemonResult.phase,
        daemonState: daemonResult.state,
        },
    });

    if (daemonResult.phase === 'failed') {
      const structuredFailure = getStructuredTransportFailureFromMessages(messages);
      return finalizeFailedTurn(
        updatedTurn,
        messages,
        structuredFailure?.code ?? daemonResult.code ?? 'codex_app_server_turn_failed',
        structuredFailure?.message ?? daemonResult.error ?? 'Codex app-server turn failed.',
      );
    }

    const protocolError = findJsonRpcError(messages);
    const structuredTurnFailure = getStructuredTransportFailureFromMessages(messages);
    const turnStatus = findTurnCompletedStatus(messages);
    if (protocolError || !turnStatus || turnStatus === 'interrupted') {
      return finalizeFailedTurn(
        updatedTurn,
        messages,
        structuredTurnFailure?.code ?? daemonResult.code ?? 'codex_app_server_turn_failed',
        structuredTurnFailure?.message ?? protocolError ?? daemonResult.error ?? `Codex app-server turn did not complete successfully (${turnStatus ?? 'unknown'}).`,
      );
    }

    return finalizeSuccessfulTurn(updatedTurn, messages);
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
    if (!daemonHealth || !daemonHealth.initialized || daemonHealth.threadId !== session.appServerThreadId) {
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
      const structuredStartFailure = getStructuredTransportFailureFromMessages(startResult.messages);
      const runnerError = startResult.error ?? findRunnerError(startResult.messages);
      const threadStartError = findThreadStartError(startResult.messages);
      if (!didAccountLoginSucceed(startResult.messages) || loginError) {
        const failureCode = structuredStartFailure?.code ?? startResult.code ?? 'codex_app_server_external_auth_login_failed';
        const failureMessage = loginError ?? structuredStartFailure?.message ?? 'Codex app-server external auth login did not succeed.';
        await repository.updateSession(sessionId, {
          appServerStatus: 'degraded',
          daemonStatus: 'degraded',
          appServerThreadId: null,
          continuityState: 'failed',
          resumeEligibility: 'restart_required',
          recoveryOutcome: 'none',
          lastFailureCode: failureCode,
        });
        await persistTransportSnapshot(sessionId, markAiSessionTransportLost(
          sessionId,
          failureCode,
          failureMessage,
        ));
        throw new AiSessionTransportNotImplementedError(
          failureMessage,
          failureCode,
        );
      }

      if (threadStartError || runnerError || !startResult.ok) {
        const failureCode = structuredStartFailure?.code ?? startResult.code ?? (threadStartError ? 'codex_app_server_thread_start_failed' : 'codex_app_server_runner_failed');
        const failureMessage = structuredStartFailure?.message ?? threadStartError ?? runnerError ?? 'Codex app-server init failed after login.';
        await repository.updateSession(sessionId, {
          appServerStatus: 'degraded',
          daemonStatus: 'degraded',
          appServerThreadId: null,
          continuityState: 'failed',
          resumeEligibility: 'restart_required',
          recoveryOutcome: 'none',
          lastFailureCode: failureCode,
        });
        await persistTransportSnapshot(sessionId, markAiSessionTransportLost(
          sessionId,
          failureCode,
          failureMessage,
        ));
        throw new AiSessionTransportNotImplementedError(
          failureMessage,
          failureCode,
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

    async submitMessageTurn(sessionId: string, input: ExecuteMessageInput): Promise<MessageTurnSubmitResult> {
      let session = await repository.getSession(sessionId);
      if (!session) {
        throw new Error(`Unknown AI session ${sessionId}`);
      }

      const earlyFingerprint = createTurnRequestFingerprint({
        mode: input.mode,
        requestText: input.requestText,
        targetId: input.targetId ?? null,
        routeMode: input.routeMode ?? null,
        routeReason: input.routeReason ?? null,
        allowedPaths: input.allowedPaths ?? [],
        workspaceVersion: input.mode === 'create' ? getActiveWorkspaceVersion(session) : getLatestWorkspaceVersion(session) + 1,
      });
      const preexistingTurn = await repository.findTurnByRequestFingerprint(sessionId, earlyFingerprint);
      if (preexistingTurn && isActiveTurnStatus(preexistingTurn.status)) {
        const syncedPreexistingTurn = await syncTurnFromDaemon(preexistingTurn);
        if (isActiveTurnStatus(syncedPreexistingTurn.status)) {
          return {
            ...toSubmittedTurnResult(syncedPreexistingTurn),
            deduplicated: true,
          };
        }
      }

      const preexistingActiveTurn = await repository.findActiveTurn(sessionId);
      if (preexistingActiveTurn) {
        const syncedPreexistingActiveTurn = await syncTurnFromDaemon(preexistingActiveTurn);
        if (isActiveTurnStatus(syncedPreexistingActiveTurn.status)) {
          throw new AiSessionTurnConflictError(`AI session ${sessionId} already has active turn ${syncedPreexistingActiveTurn.id}.`);
        }
      }

      const canReuseReadyTransport =
        session.status === 'ready'
        && session.boxStatus === 'ready'
        && session.authState === 'ready'
        && session.appServerStatus !== 'failed'
        && Boolean(session.appServerThreadId);
      const existingTransport = canReuseReadyTransport ? await this.getTransportSnapshot(sessionId).catch(() => null) : null;
      if (!canReuseReadyTransport || !existingTransport || existingTransport.phase !== 'ready') {
        const recovered = await this.initializeTransport(sessionId, null);
        session = recovered.session;
      }
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
      let baselineFingerprint: string | null = null;
      if (input.mode === 'create') {
        try {
          baselineFingerprint = fingerprintPackage(await readWorkspacePackageVersion(session.id, executionWorkspaceVersion));
        } catch {
          baselineFingerprint = null;
        }
      }
      if (input.mode !== 'create') {
        const resolvedBase = await resolveWorkspaceBasePackage(session, input.targetId ?? '__current__');
        executionWorkspaceVersion = getLatestWorkspaceVersion(session) + 1;
        baselineFingerprint = fingerprintPackage(resolvedBase.pkg);
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
      const requestFingerprint = createTurnRequestFingerprint({
        mode: input.mode,
        requestText: input.requestText,
        targetId: input.targetId ?? null,
        routeMode: input.routeMode ?? null,
        routeReason: input.routeReason ?? null,
        allowedPaths: input.allowedPaths ?? [],
        workspaceVersion: executionWorkspaceVersion,
      });

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
          requestFingerprint,
        },
      });
      await repository.updateSession(sessionId, { status: 'busy' });
      await persistTransportSnapshot(sessionId, startAiSessionTransportTurn(sessionId));
      await appendTransportLog(sessionId, 'turn', 'system', `Starting ${input.mode} turn in workspace v${executionWorkspaceVersion}.`);

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
        await persistTransportSnapshot(sessionId, markAiSessionTransportLost(sessionId, 'codex_app_server_binary_missing', runtimeState.reason ?? 'Codex runtime is not available in the Box.'));
        supervisor.updateRuntime(sessionId, {
          daemonStatus: 'degraded',
          continuityState: 'failed',
          resumeEligibility: 'restart_required',
          threadId: null,
          lastFailureCode: 'codex_app_server_binary_missing',
        });
        throw new AiSessionTransportNotImplementedError(runtimeState.reason ?? 'Codex runtime is not available in the Box.', 'codex_app_server_binary_missing');
      }

      const appServerConfig = sandboxProvider.getDefaultCodexAppServerConfig();
      const hostTokenClient = HostTokenServiceClient.fromEnv();
      await hostTokenClient.refresh({ sessionId, reason: 'unauthorized' });
      const acceptedAt = new Date().toISOString();
      const hostTokenRuntime = {
        sessionId,
        url: hostTokenClient.getBaseUrl(),
        apiKey: hostTokenClient.getApiKey(),
      };

      const threadId = session.appServerThreadId;
      if (!threadId) {
        await repository.updateSession(sessionId, {
          status: 'ready',
          appServerStatus: 'stopped',
          daemonStatus: 'stopped',
          continuityState: 'continuity_lost',
          resumeEligibility: 'restart_required',
          recoveryOutcome: 'none',
          lastFailureCode: 'codex_turn_missing_thread',
        });
        await persistTransportSnapshot(sessionId, markAiSessionTransportLost(sessionId, 'codex_turn_missing_thread', 'Codex turn cannot start without a thread id.'));
        throw new AiSessionTransportNotInitializedError('Codex turn cannot start without a thread id. Reinitialize the session.');
      }

      await ensureCodexAppServerDaemon(sandboxProvider, sessionId, appServerConfig, workspaceRoot, hostTokenRuntime);
      const messages = [createTurnStartMessage(threadId, input.requestText, workspaceRoot)];
      for (const message of messages) {
        await appendTransportLog(sessionId, 'turn', 'outbound', message);
      }

      const turn = await repository.createTurn({
        id: randomUUID(),
        sessionId,
        projectId: session.projectId,
        workspaceVersion: executionWorkspaceVersion,
        workspaceRoot,
        mode: input.mode,
        requestText: input.requestText,
        targetId: input.targetId ?? null,
        baseTargetId,
        routeMode: input.routeMode ?? null,
        routeReason: input.routeReason ?? null,
        allowedPaths: input.allowedPaths ?? [],
        requestFingerprint,
        status: 'submitted',
        artifactState: 'pending',
        threadId,
        acceptedAt,
        startedAt: null,
        completedAt: null,
        terminalAt: null,
        artifactReadyAt: null,
        turnStatus: null,
        agentText: '',
        recoveryOutcome: session.recoveryOutcome,
        finalOutcome: 'pending',
        failureCode: null,
        failureMessage: null,
        diagnostics: {
          submissionSource: 'host_submit',
          baselineFingerprint,
        },
        resultPayload: {},
      });

      await repository.appendEvent({
        sessionId,
        type: 'message.dispatched_to_daemon',
        payload: {
          turnId: turn.id,
          mode: input.mode,
          threadId,
          workspaceVersion: executionWorkspaceVersion,
          workspaceRoot,
          baseTargetId,
        },
      });

      const daemonSubmit = await submitCodexAppServerDaemonTurn(sandboxProvider, sessionId, {
        turnId: turn.id,
        phase: 'turn',
        messages,
        stopOnMethods: ['turn/completed'],
        timeoutMs: 300000,
      });

      const submittedTurn = await repository.updateTurn(turn.id, {
        status: daemonSubmit.turn.phase === 'running' ? 'running' : 'submitted',
        threadId: daemonSubmit.turn.state.threadId ?? threadId,
        startedAt: daemonSubmit.turn.startedAt,
        diagnostics: {
          ...turn.diagnostics,
          daemonSubmissionDeduplicated: daemonSubmit.deduplicated,
          daemonPhase: daemonSubmit.turn.phase,
          daemonState: daemonSubmit.turn.state,
        },
      });

      return {
        ...toSubmittedTurnResult(submittedTurn),
        deduplicated: daemonSubmit.deduplicated,
      };
    },

    async getMessageTurnStatus(sessionId: string, turnId: string) {
      const turn = await repository.getTurn(turnId);
      if (!turn || turn.sessionId !== sessionId) {
        throw new Error(`Unknown AI session turn ${turnId}`);
      }
      const syncedTurn = await syncTurnFromDaemon(turn);
      return {
        turnId: syncedTurn.id,
        sessionId: syncedTurn.sessionId,
        status: syncedTurn.status,
        artifactState: syncedTurn.artifactState,
        acceptedAt: syncedTurn.acceptedAt,
        startedAt: syncedTurn.startedAt,
        completedAt: syncedTurn.completedAt,
        terminalAt: syncedTurn.terminalAt,
        workspaceVersion: syncedTurn.workspaceVersion,
        workspaceRoot: syncedTurn.workspaceRoot,
        threadId: syncedTurn.threadId,
        turnStatus: syncedTurn.turnStatus,
        finalOutcome: syncedTurn.finalOutcome,
        recoveryOutcome: syncedTurn.recoveryOutcome,
        failureCode: syncedTurn.failureCode,
        failureMessage: syncedTurn.failureMessage,
      };
    },

    async getMessageTurnResult(sessionId: string, turnId: string): Promise<MessageTurnResult> {
      const turn = await repository.getTurn(turnId);
      if (!turn || turn.sessionId !== sessionId) {
        throw new Error(`Unknown AI session turn ${turnId}`);
      }
      const syncedTurn = await syncTurnFromDaemon(turn);
      if (!isTerminalTurnStatus(syncedTurn.status)) {
        throw new AiSessionMessageNotReadyError(`AI session turn ${turnId} has not finished yet.`);
      }
      if (syncedTurn.status === 'completed' && syncedTurn.artifactState !== 'durable') {
        throw new AiSessionMessageNotReadyError(`AI session turn ${turnId} is waiting for durable workspace artifacts.`);
      }
      return toCompletedTurnResult(syncedTurn);
    },

    /**
     * @deprecated Production callers should use submitMessageTurn() + getMessageTurnResult().
     * Retained only as a thin compatibility wrapper around the async turn path.
     */
    async executeMessage(sessionId: string, input: ExecuteMessageInput): Promise<{
      acknowledged: true;
      sessionId: string;
      acceptedAt: string;
      threadId: string;
      turnStatus: string | null;
      agentText: string;
      workspaceVersion: number;
      workspaceRoot: string;
      baseTargetId: string | null;
      turnId: string;
    }> {
      const submitted = await this.submitMessageTurn(sessionId, input);
      const startedAt = Date.now();

      while (Date.now() - startedAt < 310000) {
        try {
          const result = await this.getMessageTurnResult(sessionId, submitted.turnId);
          if (result.finalOutcome === 'failed' || !result.package || !result.manifest || !result.staticEvaluation) {
            throw new AiSessionTransportNotImplementedError(result.failureMessage ?? 'Codex app-server turn failed.', result.failureCode ?? 'codex_app_server_turn_failed');
          }
          return {
            acknowledged: true,
            sessionId: result.sessionId,
            acceptedAt: result.acceptedAt,
            threadId: result.threadId,
            turnStatus: result.turnStatus,
            agentText: result.agentText,
            workspaceVersion: result.workspaceVersion,
            workspaceRoot: result.workspaceRoot,
            baseTargetId: result.baseTargetId,
            turnId: result.turnId,
          };
        } catch (error) {
          if (!(error instanceof AiSessionMessageNotReadyError)) {
            throw error;
          }
          await new Promise(resolve => setTimeout(resolve, 250));
        }
      }

      throw new AiSessionTransportNotImplementedError('Timed out waiting for AI session turn completion.', 'codex_turn_result_timeout');
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
