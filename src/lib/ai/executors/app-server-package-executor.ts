import {
  AiSessionTransportNotInitializedError,
  createAiSessionService,
} from '@/lib/ai-sessions/service';
import { packageSizes, recoverPackageFromAgentText } from '@/lib/ai/codex-agent-text-package';
import { buildCodexWorkspacePrompt } from '@/lib/ai/codex-workspace-prompts';
import type { PackageExecutorInput, PackageExecutorResult } from '@/lib/ai/executors/types';
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

  const pkg = await readWorkspacePackageWithRetry(
    aiSessionService,
    sessionId,
    refreshedSession.activeWorkspaceVersion,
  ).catch(() => null);
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

  const preExecutionPackageFingerprint =
    input.mode === 'create'
      ? await readWorkspacePackageWithRetry(aiSessionService, session.id, session.activeWorkspaceVersion)
          .then(pkg => fingerprintPackage(pkg))
          .catch(() => undefined)
      : undefined;

  let messageResult: Awaited<ReturnType<typeof aiSessionService.executeMessage>>;
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
  } catch (error) {
    const recovered = await tryRecoverPackageAfterExecutionFailure(
      aiSessionService,
      session.id,
      input,
      error,
      preExecutionPackageFingerprint,
    );
    if (!recovered) {
      throw error;
    }

    return {
      solveResult: {
        pkg: recovered.pkg,
        manifest: recovered.manifest,
        staticEvaluation: evaluatePackageStatic(recovered.pkg),
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
      requiresReinit: true,
    };
  }

  const pkg = await readWorkspacePackageWithRetry(aiSessionService, session.id, messageResult.workspaceVersion);
  let parsed = parseGeneratedGamePackage(pkg);
  if (!parsed.ok && messageResult.agentText.trim()) {
    const recovered = recoverPackageFromAgentText(messageResult.agentText);
    if (recovered.ok) {
      await aiSessionService.writeWorkspacePackage(session.id, recovered.pkg, messageResult.workspaceVersion);
      parsed = recovered;
    }
  }

  if (!parsed.ok) {
    throw new Error(
      `Codex app-server execution completed, but the resulting package failed schema validation. ${parsed.message}${parsed.issues?.length ? ` Issues: ${parsed.issues.join(' | ')}` : ''} Workspace sizes: ${packageSizes(pkg)}${messageResult.agentText.trim() ? ' Agent text was present but no recoverable package JSON was found.' : ' Agent text was empty.'}`,
    );
  }

  const finalPkg = parsed.pkg;
  await aiSessionService.promoteWorkspaceVersion(session.id, messageResult.workspaceVersion);

  return {
    solveResult: {
      pkg: finalPkg,
      manifest: parsed.manifest,
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
    requiresReinit: false,
  };
}
