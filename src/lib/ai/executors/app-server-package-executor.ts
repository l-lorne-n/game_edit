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

  const messageResult = await aiSessionService.executeMessage(session.id, {
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

  const pkg = await aiSessionService.readWorkspacePackage(session.id);
  let parsed = parseGeneratedGamePackage(pkg);
  if (!parsed.ok && messageResult.agentText.trim()) {
    const recovered = recoverPackageFromAgentText(messageResult.agentText);
    if (recovered.ok) {
      await aiSessionService.writeWorkspacePackage(session.id, recovered.pkg);
      parsed = recovered;
    }
  }

  if (!parsed.ok) {
    throw new Error(
      `Codex app-server execution completed, but the resulting package failed schema validation. ${parsed.message}${parsed.issues?.length ? ` Issues: ${parsed.issues.join(' | ')}` : ''} Workspace sizes: ${packageSizes(pkg)}${messageResult.agentText.trim() ? ' Agent text was present but no recoverable package JSON was found.' : ' Agent text was empty.'}`,
    );
  }

  const finalPkg = parsed.pkg;

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
  };
}
