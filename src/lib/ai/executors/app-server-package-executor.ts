import {
  AiSessionTransportNotInitializedError,
  createAiSessionService,
} from '@/lib/ai-sessions/service';
import { createExecutionStage, upsertExecutionStage, type ExecutionStage, type FailureContext } from '@/lib/ai/execution-trace';
import { packageSizes, recoverPackageFromAgentText } from '@/lib/ai/codex-agent-text-package';
import { buildCodexWorkspacePrompt } from '@/lib/ai/codex-workspace-prompts';
import {
  PackageExecutorFailure,
  type PackageExecutorInput,
  type PackageExecutorResult,
} from '@/lib/ai/executors/types';
import { evaluatePackageStatic } from '@/lib/evaluator/static';
import { parseGeneratedGamePackage, type GeneratedGamePackage } from '@/lib/package/contracts';
import { createProjectService } from '@/lib/projects/service';

function isRecoverableWorkspaceFetchError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return message.includes('fetch failed') || message.includes('empty response');
}

function fingerprintPackage(pkg: GeneratedGamePackage | null): string | null {
  if (!pkg) {
    return null;
  }
  return JSON.stringify([pkg.indexHtml, pkg.gameJs, pkg.styleCss, pkg.manifestJson]);
}

function timeSince(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt);
}

function inferFailureReason(error: unknown, fallbackCode: string | null): string {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (message.includes('fetch failed')) {
    return 'fetch_failed';
  }
  if (message.includes('empty response')) {
    return 'empty_response';
  }
  if (fallbackCode === 'transport_lost') {
    return 'transport_lost';
  }
  return fallbackCode ?? 'unexpected_error';
}

async function buildFailureContext(input: {
  aiSessionService: ReturnType<typeof createAiSessionService>;
  sessionId: string;
  checkpoint: FailureContext['checkpoint'];
  error: unknown;
  requiresReinit: boolean;
  fallbackCode?: string | null;
}): Promise<FailureContext> {
  const [session, transport] = await Promise.all([
    (async () => {
      try {
        return (await input.aiSessionService.getSession(input.sessionId)) ?? null;
      } catch {
        return null;
      }
    })(),
    (async () => {
      try {
        return (await input.aiSessionService.getTransportSnapshot(input.sessionId)) ?? null;
      } catch {
        return null;
      }
    })(),
  ]);
  const message = input.error instanceof Error ? input.error.message : String(input.error);
  const code = input.fallbackCode ?? transport?.lastErrorCode ?? session?.lastFailureCode ?? null;

  return {
    checkpoint: input.checkpoint,
    reason: inferFailureReason(input.error, code),
    code,
    message,
    transport: transport
      ? {
          phase: transport.phase,
          threadId: transport.threadId,
          requiresReinit: input.requiresReinit || transport.requiresReinit,
          lastErrorCode: transport.lastErrorCode,
          lastErrorMessage: transport.lastErrorMessage,
        }
      : null,
    session: session
      ? {
          sessionId: session.id,
          projectId: session.projectId,
          status: session.status,
          lastFailureCode: session.lastFailureCode,
          lastCheckpointId: session.lastCheckpointId,
          lastCheckpointVersion: session.lastCheckpointVersion,
        }
      : null,
  };
}

async function throwExecutorFailure(input: {
  aiSessionService: ReturnType<typeof createAiSessionService>;
  sessionId: string;
  checkpoint: FailureContext['checkpoint'];
  error: unknown;
  executionStages: ExecutionStage[];
  requiresReinit: boolean;
  fallbackReason?: string | null;
  code?: string | null;
}): Promise<never> {
  const failureContext = await buildFailureContext({
    aiSessionService: input.aiSessionService,
    sessionId: input.sessionId,
    checkpoint: input.checkpoint,
    error: input.error,
    requiresReinit: input.requiresReinit,
    fallbackCode: input.code,
  });

  throw new PackageExecutorFailure({
    message: failureContext.message,
    code: failureContext.code,
    actualEngine: 'codex-app-server',
    fallbackReason: input.fallbackReason ?? null,
    requiresReinit: input.requiresReinit,
    executionStages: input.executionStages,
    failureContext,
  });
}

async function readWorkspacePackageWithRetry(
  aiSessionService: ReturnType<typeof createAiSessionService>,
  sessionId: string,
  workspaceVersion: number,
): Promise<GeneratedGamePackage> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await aiSessionService.readWorkspacePackage(sessionId, workspaceVersion);
    } catch (error) {
      lastError = error;
      if (!isRecoverableWorkspaceFetchError(error) || attempt === 1) {
        throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Failed to read workspace package.');
}

async function tryRecoverPackageAfterExecutionFailure(
  aiSessionService: ReturnType<typeof createAiSessionService>,
  sessionId: string,
  input: PackageExecutorInput,
  error: unknown,
  preExecutionPackageFingerprint: string | null | undefined,
) {
  if (input.mode !== 'create' || !isRecoverableWorkspaceFetchError(error)) {
    return null;
  }

  const refreshedSession = await aiSessionService.getSession(sessionId);
  if (!refreshedSession) {
    return null;
  }

  let pkg: GeneratedGamePackage | null = null;
  try {
    pkg = await readWorkspacePackageWithRetry(
      aiSessionService,
      sessionId,
      refreshedSession.activeWorkspaceVersion,
    );
  } catch {
    pkg = null;
  }
  if (!pkg) {
    return null;
  }

  const parsed = parseGeneratedGamePackage(pkg);
  if (!parsed.ok) {
    return null;
  }

  if (preExecutionPackageFingerprint === undefined || fingerprintPackage(parsed.pkg) === preExecutionPackageFingerprint) {
    return null;
  }

  return {
    pkg: parsed.pkg,
    manifest: parsed.manifest,
    workspaceVersion: refreshedSession.activeWorkspaceVersion,
  };
}

export async function runAppServerPackageExecutor(input: PackageExecutorInput): Promise<PackageExecutorResult> {
  const aiSessionService = createAiSessionService();
  const projectService = createProjectService();
  const executionStages: ExecutionStage[] = [];

  if (!input.projectId) {
    throw new AiSessionTransportNotInitializedError('Project id is required before sending a Codex prompt.');
  }

  if (!input.aiSessionId) {
    throw new AiSessionTransportNotInitializedError('Init Codex is required before sending a prompt.');
  }

  const project = await projectService.getProject(input.projectId);
  if (!project) {
    throw new Error(`Project not found: ${input.projectId}`);
  }

  const session = await aiSessionService.getSession(input.aiSessionId);
  if (!session) {
    throw new AiSessionTransportNotInitializedError('The selected AI session no longer exists. Re-create and re-initialize Codex.');
  }

  if (session.projectId !== project.id) {
    throw new AiSessionTransportNotInitializedError('The selected AI session does not belong to the active project.');
  }

  const transport = await aiSessionService.getTransportSnapshot(session.id);
  if (!transport || transport.phase !== 'ready') {
    throw new AiSessionTransportNotInitializedError('Init Codex is required before sending a prompt.');
  }

  let preExecutionPackageFingerprint: string | null | undefined;
  if (input.mode === 'create') {
    try {
      const baselinePkg = await readWorkspacePackageWithRetry(
        aiSessionService,
        session.id,
        session.activeWorkspaceVersion,
      );
      preExecutionPackageFingerprint = fingerprintPackage(baselinePkg);
    } catch {
      preExecutionPackageFingerprint = undefined;
    }
  }

  let messageResult: Awaited<ReturnType<typeof aiSessionService.executeMessage>>;
  const transportTurnStartedAt = Date.now();
  try {
    messageResult = await aiSessionService.executeMessage(session.id, {
      mode: input.mode,
      requestText: buildCodexWorkspacePrompt({
        mode: input.mode,
        prompt: input.prompt,
        instruction: input.instruction,
        errorReport: input.errorReport,
        currentPackage: input.currentPackage,
        evaluatorSummary: input.evaluatorSummary,
        routeMode: input.routeMode,
        routeReason: input.routeReason,
        allowedPaths: input.allowedPaths,
      }),
      targetId: input.targetId ?? null,
      routeMode: input.routeMode ?? null,
      routeReason: input.routeReason ?? null,
      allowedPaths: input.allowedPaths,
    });
    executionStages.push(
      createExecutionStage({
        key: 'transport_turn',
        status: 'completed',
        durationMs: timeSince(transportTurnStartedAt),
        detail: messageResult.turnStatus
          ? `Codex turn completed with status: ${messageResult.turnStatus}`
          : 'Codex turn completed.',
      }),
    );
  } catch (error) {
    executionStages.push(
      createExecutionStage({
        key: 'transport_turn',
        status: 'failed',
        durationMs: timeSince(transportTurnStartedAt),
        detail: error instanceof Error ? error.message : String(error),
      }),
    );

    const recoveryStartedAt = Date.now();
    const recovered = await tryRecoverPackageAfterExecutionFailure(
      aiSessionService,
      session.id,
      input,
      error,
      preExecutionPackageFingerprint,
    );
    if (!recovered) {
      await throwExecutorFailure({
        aiSessionService,
        sessionId: session.id,
        checkpoint: 'transport_turn',
        error,
        executionStages,
        requiresReinit: true,
      });
    }
    const recoveredPackage = recovered;
    if (!recoveredPackage) {
      throw new Error('Workspace recovery unexpectedly returned no package.');
    }

    const recoveryFailureContext = await buildFailureContext({
      aiSessionService,
      sessionId: session.id,
      checkpoint: 'transport_turn',
      error,
      requiresReinit: true,
    });

    executionStages.push(
      createExecutionStage({
        key: 'workspace_recovery',
        status: 'completed',
        durationMs: timeSince(recoveryStartedAt),
        detail: error instanceof Error ? error.message : String(error),
      }),
    );

    return {
      solveResult: {
        pkg: recoveredPackage.pkg,
        manifest: recoveredPackage.manifest,
        staticEvaluation: evaluatePackageStatic(recoveredPackage.pkg),
        repaired: input.mode === 'debug',
        fallbackUsed: true,
        source: 'model',
        statusMessage: `Recovered package from workspace after transport error; re-initialize the AI session before the next turn. ${error instanceof Error ? error.message : String(error)}`,
        provider: 'openai',
        model: 'codex-app-server',
        attempts: [],
      },
      actualEngine: 'codex-app-server',
      fallbackReason: 'workspace_recovered_after_transport_error',
      outcome: 'recovered_success',
      recovery: {
        source: 'workspace',
        reason: 'workspace_recovered_after_transport_error',
        workspaceVersion: recoveredPackage.workspaceVersion,
        recoveredFromFailureCode: recoveryFailureContext.code,
        recoveredFromFailureMessage: recoveryFailureContext.message,
      },
      requiresReinit: true,
      executionStages,
      failureContext: recoveryFailureContext,
    };
  }

  const readbackStartedAt = Date.now();
  let workspacePackage: GeneratedGamePackage | null = null;
  try {
    workspacePackage = await readWorkspacePackageWithRetry(aiSessionService, session.id, messageResult.workspaceVersion);
  } catch (error) {
    executionStages.push(
      createExecutionStage({
        key: 'workspace_readback',
        status: 'failed',
        durationMs: timeSince(readbackStartedAt),
        detail: error instanceof Error ? error.message : String(error),
      }),
    );
    await throwExecutorFailure({
      aiSessionService,
      sessionId: session.id,
      checkpoint: 'workspace_readback',
      error,
      executionStages,
      requiresReinit: true,
    });
  }
  if (!workspacePackage) {
    throw new Error('Workspace readback unexpectedly returned no package.');
  }
  executionStages.push(
    createExecutionStage({
      key: 'workspace_readback',
      status: 'completed',
      durationMs: timeSince(readbackStartedAt),
      detail: `Read workspace v${messageResult.workspaceVersion}`,
    }),
  );
  let parsed = parseGeneratedGamePackage(workspacePackage);
  if (!parsed.ok && messageResult.agentText.trim()) {
    const recovered = recoverPackageFromAgentText(messageResult.agentText);
    if (recovered.ok) {
      await aiSessionService.writeWorkspacePackage(session.id, recovered.pkg, messageResult.workspaceVersion);
      parsed = recovered;
    }
  }

  if (!parsed.ok) {
    const schemaError = new Error(
      `Codex app-server execution completed, but the resulting package failed schema validation. ${parsed.message}${parsed.issues?.length ? ` Issues: ${parsed.issues.join(' | ')}` : ''} Workspace sizes: ${packageSizes(workspacePackage)}${messageResult.agentText.trim() ? ' Agent text was present but no recoverable package JSON was found.' : ' Agent text was empty.'}`,
    );
    const failedReadbackStage = createExecutionStage({
      key: 'workspace_readback',
      status: 'failed',
      durationMs: timeSince(readbackStartedAt),
      detail: schemaError.message,
    });
    executionStages.splice(0, executionStages.length, ...upsertExecutionStage(executionStages, failedReadbackStage));
    await throwExecutorFailure({
      aiSessionService,
      sessionId: session.id,
      checkpoint: 'workspace_readback',
      error: schemaError,
      executionStages,
      requiresReinit: false,
      code: 'package_schema_validation_failed',
    });
  }

  const finalPkg = parsed.ok ? parsed.pkg : null;
  const finalManifest = parsed.ok ? parsed.manifest : null;
  if (!finalPkg || !finalManifest) {
    throw new Error('Validated workspace package was unexpectedly unavailable after schema validation.');
  }
  const promoteStartedAt = Date.now();
  try {
    await aiSessionService.promoteWorkspaceVersion(session.id, messageResult.workspaceVersion);
  } catch (error) {
    executionStages.push(
      createExecutionStage({
        key: 'workspace_promote',
        status: 'failed',
        durationMs: timeSince(promoteStartedAt),
        detail: error instanceof Error ? error.message : String(error),
      }),
    );
    await throwExecutorFailure({
      aiSessionService,
      sessionId: session.id,
      checkpoint: 'workspace_promote',
      error,
      executionStages,
      requiresReinit: false,
    });
  }
  executionStages.push(
    createExecutionStage({
      key: 'workspace_promote',
      status: 'completed',
      durationMs: timeSince(promoteStartedAt),
      detail: `Promoted workspace v${messageResult.workspaceVersion}`,
    }),
  );

  return {
    solveResult: {
      pkg: finalPkg,
      manifest: finalManifest,
      staticEvaluation: evaluatePackageStatic(finalPkg),
      repaired: input.mode === 'debug',
      fallbackUsed: false,
      source: 'model',
      statusMessage: messageResult.turnStatus
        ? `Codex app-server completed turn with status: ${messageResult.turnStatus}`
        : 'Codex app-server completed a turn.',
      provider: 'openai',
      model: 'codex-app-server',
      attempts: [],
    },
    actualEngine: 'codex-app-server',
    fallbackReason: null,
    outcome: 'direct_success',
    recovery: null,
    requiresReinit: false,
    executionStages,
    failureContext: null,
  };
}
