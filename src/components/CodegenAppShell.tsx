'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

import {
  buildClientFailureContext,
  createExecutionStage,
  upsertExecutionStage,
  type ExecutionOutcome,
  type ExecutionStage,
  type FailureContext,
  type PackageExecutionTraceMeta,
  type RecoveryContext,
} from '@/lib/ai/execution-trace';
import type { ModelAttempt } from '@/lib/ai/types';
import {
  AiSessionClientError,
  beginHostBrowserOAuth,
  checkpointAiSession,
  createAiSession,
  getAiSessionMessageTurnResult,
  getAiSessionMessageTurnStatus,
  getAiSessionLogs,
  getAiSessionSnapshot,
  getLatestHostTokenSession,
  initAiSessionTransport,
  listProjectAiSessions,
  revokeAiSession,
  listAiSessionVersions,
  getAiSessionVersionPayload,
  type AiSessionSnapshot,
} from '@/lib/ai-sessions/client';
import type { AiSessionTransportLogEntry, AiSessionTransportSnapshot, AiSessionWorkspaceVersion, AiSessionWorkspaceVersionPayload } from '@/lib/ai-sessions/types';
import type { EvaluatorResult } from '@/lib/evaluator/types';
import type { HostTokenSessionMetadata } from '@/lib/host-tokens/types';
import type { GamePackageManifest, GeneratedGamePackage } from '@/lib/package/contracts';
import {
  createProject as createServerProject,
  deleteProject as deleteServerProject,
  saveProjectPackage,
  updateProjectEvaluation,
} from '@/lib/projects/client';
import { versionFromSnapshotId } from '@/lib/projects/package-files';
import { buildSnapshotDisplay } from '@/lib/workspace/state';
import { decideRoute } from '@/lib/workspace/routing';
import {
  addProject,
  appendMessages,
  archiveCurrentPackage,
  deleteProject,
  getActiveProject,
  makeChatMessage,
  resolvePackageFromTarget,
  snapshotDescendantIds,
  updateProject,
} from '@/lib/workspace/state';
import { loadWorkspaceState, mergeServerProjectIntoWorkspace, saveWorkspaceState } from '@/lib/workspace/storage';
import type {
  ActionMode,
  ExecutionTrace,
  GameProject,
  RouteDecision,
  SnapshotDisplayItem,
  WorkspaceState,
} from '@/lib/workspace/types';
import RequestWorkbench from '@/components/RequestWorkbench';
import SandboxPreview from '@/components/SandboxPreview';
import CodexPanel from '@/components/CodexPanel';
import styles from '@/components/CodegenAppShell.module.css';

type AsyncTurnResponse = {
  acknowledged: true;
  deduplicated?: boolean;
  sessionId: string;
  turnId: string;
  acceptedAt: string;
  threadId: string;
  workspaceVersion: number;
  workspaceRoot: string;
  baseTargetId: string | null;
  status: string;
  artifactState: string;
};

type PackageApiAccepted = {
  ok: true;
  accepted: true;
  statusMessage: string;
  source: string;
  provider: string;
  model: string;
  repaired: boolean;
  fallbackUsed: boolean;
  requiresReplan?: boolean;
  requiresReinit?: boolean;
  executionEngine?: PackageExecutionTraceMeta;
  serverRouteDecision?: RouteDecision;
  project: import('@/lib/projects/types').HydratedProjectRecord | null;
  persistenceWarning?: string | null;
  asyncTurn: AsyncTurnResponse;
};

type PackageApiCompleted = {
  ok: true;
  accepted?: false;
  package: GeneratedGamePackage;
  manifest: GamePackageManifest;
  staticEvaluation: EvaluatorResult;
  repaired: boolean;
  fallbackUsed: boolean;
  source: string;
  statusMessage: string;
  provider: string;
  model: string;
  attempts: ModelAttempt[];
  requiresReplan?: boolean;
  requiresReinit?: boolean;
  executionEngine?: PackageExecutionTraceMeta;
  serverRouteDecision?: RouteDecision;
  project: import('@/lib/projects/types').HydratedProjectRecord | null;
  persistenceWarning?: string | null;
};

type PackageApiFailure = {
  ok: false;
  error: string;
  code?: string;
  requiresReinit?: boolean;
  executionEngine?: PackageExecutionTraceMeta;
};

type PackageApiSuccess = PackageApiAccepted | PackageApiCompleted;

type ApiResponse = PackageApiSuccess | PackageApiFailure;

type PhaseState = 'idle' | 'running' | 'passed' | 'failed' | 'repairing';

type PhaseRow = {
  id: 'generator' | 'tester' | 'checker';
  label: string;
  state: PhaseState;
  detail: string;
  elapsedMs: number;
};

type CodexPanelState = {
  transport: AiSessionTransportSnapshot | null;
  initTranscript: AiSessionTransportLogEntry[];
  turnTranscript: AiSessionTransportLogEntry[];
};

const MODES: Array<{ id: ActionMode; label: string }> = [
  { id: 'create', label: '创建游戏' },
  { id: 'modify', label: '改游戏' },
  { id: 'debug', label: '修错误' },
];

function defaultPhases(): PhaseRow[] {
  return [
    { id: 'generator', label: '生成器/修复器', state: 'idle', detail: '等待任务', elapsedMs: 0 },
    { id: 'tester', label: '测试者', state: 'idle', detail: '等待生成结果', elapsedMs: 0 },
    { id: 'checker', label: '检查者', state: 'idle', detail: '等待验证结果', elapsedMs: 0 },
  ];
}

function phaseBadgeClass(state: PhaseState): string {
  if (state === 'running' || state === 'repairing') {
    return `${styles.badge} ${styles.badgeRunning}`;
  }
  if (state === 'passed') {
    return `${styles.badge} ${styles.badgePassed}`;
  }
  if (state === 'failed') {
    return `${styles.badge} ${styles.badgeFailed}`;
  }
  return styles.badge;
}

function snapshotOptionLabel(item: SnapshotDisplayItem): string {
  const indent = item.depth > 0 ? `${'  '.repeat(item.depth)}|- ` : '';
  const parent = item.parentTitle ? ` [from: ${item.parentTitle}]` : '';
  const state = item.snapshot.status === 'passed' ? 'OK' : item.snapshot.status === 'failed' ? 'FAIL' : 'UNKNOWN';
  return `${indent}${item.snapshot.title} (${new Date(item.snapshot.createdAt).toLocaleString()}) [${state}]${parent}`;
}

function labelForAgent(agent: RouteDecision['agent']): string {
  switch (agent) {
    case 'architect':
      return '生成器';
    case 'fixer':
      return '修复器';
    default:
      return '执行者';
  }
}

function parseManifestTitle(pkg: GeneratedGamePackage | null): string {
  if (!pkg) {
    return 'No package loaded';
  }
  try {
    const parsed = JSON.parse(pkg.manifestJson) as { title?: unknown };
    if (typeof parsed.title === 'string' && parsed.title.trim()) {
      return parsed.title;
    }
  } catch {
    return 'Invalid manifest JSON';
  }
  return 'Untitled package';
}

function inferDebugSuggestion(text: string): boolean {
  return /(error|exception|stack|trace|failed|syntaxerror|typeerror|referenceerror|报错|错误|崩溃|无法运行)/i.test(
    text,
  );
}

function nowMs(): number {
  return Date.now();
}

function toAttemptSummaries(attempts: ModelAttempt[]) {
  return attempts.map(attempt => ({
    mode: attempt.mode,
    outcome: attempt.outcome,
    durationMs: attempt.durationMs,
    errorMessage: attempt.errorMessage,
    provider: attempt.provider,
    model: attempt.model,
  }));
}

function plausibleDebugTargets(project: GameProject): string[] {
  const ids = new Set<string>();
  if (project.currentEvaluator && !project.currentEvaluator.ok) {
    ids.add('__current__');
  }
  for (const snapshot of project.snapshots) {
    if (snapshot.status === 'failed') {
      ids.add(snapshot.id);
    }
  }
  return [...ids];
}

function mergeExecutionStages(base: ExecutionStage[] | null | undefined, additions: ExecutionStage[]): ExecutionStage[] {
  return additions.reduce((merged, stage) => upsertExecutionStage(merged, stage), base ?? []);
}

function buildStageDetailFromFailure(input: {
  response: PackageApiFailure;
  fallback: FailureContext;
}): FailureContext {
  return input.response.executionEngine?.failureContext ?? input.fallback;
}

function getExecutionOutcome(engine: PackageExecutionTraceMeta | null | undefined, ok: boolean): ExecutionOutcome {
  if (!ok) {
    return 'hard_failure';
  }
  return engine?.outcome ?? 'direct_success';
}

function getRecoveryContext(engine: PackageExecutionTraceMeta | null | undefined): RecoveryContext | null {
  return engine?.recovery ?? null;
}

function formatOutcomeLabel(outcome: ExecutionOutcome): string {
  switch (outcome) {
    case 'pending':
      return '进行中';
    case 'recovered_success':
      return '恢复成功';
    case 'hard_failure':
      return '失败';
    case 'direct_success':
    default:
      return '直接成功';
  }
}

function buildAssistantSummary(input: {
  outcome: ExecutionOutcome;
  statusMessage: string;
  source: string;
  provider: string;
  model: string;
  repaired: boolean;
  fallbackUsed: boolean;
  requiresReplan?: boolean;
  persistenceWarning?: string | null;
  staticCode: string;
  engine?: PackageExecutionTraceMeta | null;
  failureContext?: FailureContext | null;
  recovery?: RecoveryContext | null;
  fallbackReason?: string | null;
}): string {
  const recoverySource = input.recovery
    ? [
        `source=${input.recovery.source}`,
        typeof input.recovery.workspaceVersion === 'number' ? `workspace=v${input.recovery.workspaceVersion}` : null,
        input.recovery.reason,
      ]
        .filter(Boolean)
        .join(' | ')
    : null;

  return [
    `Outcome: ${formatOutcomeLabel(input.outcome)}`,
    `Status: ${input.statusMessage}`,
    input.outcome === 'recovered_success' && input.failureContext
      ? `Original failure: ${input.failureContext.code ?? input.failureContext.reason ?? 'unknown'} | ${input.failureContext.message}`
      : null,
    recoverySource ? `Recovery source: ${recoverySource}` : null,
    `Source: ${input.source}`,
    `Provider/Model: ${input.provider} / ${input.model}`,
    `Repaired: ${String(input.repaired)} | Fallback: ${String(input.fallbackUsed)}`,
    input.requiresReplan ? 'Route: replan required' : null,
    input.engine
      ? `Engine requested/actual/strategy: ${input.engine.requestedEngine} / ${input.engine.actualEngine} / ${input.engine.strategy}`
      : null,
    input.engine?.fallbackReason ? `Engine fallback: ${input.engine.fallbackReason}` : null,
    input.fallbackReason ? `Fallback reason: ${input.fallbackReason}` : null,
    `Static: ${input.staticCode}`,
    input.persistenceWarning ? `Persistence: ${input.persistenceWarning}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

function isTerminalAsyncTurnState(state: string | null | undefined): boolean {
  return state === 'completed' || state === 'failed' || state === 'rejected';
}

function getHeadVersion(project: GameProject): number {
  const versions = project.snapshots
    .map(snapshot => versionFromSnapshotId(snapshot.id))
    .filter((value): value is number => typeof value === 'number');

  return versions.length > 0 ? Math.max(...versions) : 0;
}

function isServerBackedProject(project: GameProject): boolean {
  return project.persistenceMode === 'server';
}

async function postJson(path: string, payload: unknown): Promise<ApiResponse> {
  const response = await fetch(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const json = (await response.json()) as ApiResponse;
  if (!response.ok && json.ok !== false) {
    return {
      ok: false,
      error: `HTTP ${response.status}`,
    };
  }
  return json;
}

export default function CodegenAppShell() {
  const [workspace, setWorkspace] = useState<WorkspaceState | null>(null);
  const [workspaceReady, setWorkspaceReady] = useState(false);
  const [composerText, setComposerText] = useState('');
  const [mode, setMode] = useState<ActionMode>('create');
  const [busy, setBusy] = useState(false);
  const [hostAuthBusy, setHostAuthBusy] = useState(false);
  const [sessionBusy, setSessionBusy] = useState(false);
  const [runtimeNonce, setRuntimeNonce] = useState(0);
  const [phases, setPhases] = useState<PhaseRow[]>(defaultPhases);
  const [aiSessionSnapshots, setAiSessionSnapshots] = useState<Record<string, AiSessionSnapshot | null>>({});
  const [codexPanels, setCodexPanels] = useState<Record<string, CodexPanelState | null>>({});
  const [codexLogsBusy, setCodexLogsBusy] = useState(false);
  const [hostAuthSession, setHostAuthSession] = useState<HostTokenSessionMetadata | null>(null);
  const [aiSessionVersions, setAiSessionVersions] = useState<AiSessionWorkspaceVersion[]>([]);
  const [viewedAiSessionVersion, setViewedAiSessionVersion] = useState<AiSessionWorkspaceVersionPayload | null>(null);
  const [viewedAiSessionVersionId, setViewedAiSessionVersionId] = useState<string>('');

  const phaseStartedRef = useRef<Record<'generator' | 'tester' | 'checker', number>>({
    generator: 0,
    tester: 0,
    checker: 0,
  });
  const finalizeAsyncTurnRef = useRef<(projectId: string, turnId: string) => Promise<void>>(async () => undefined);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  const activeProject = useMemo(() => (workspace ? getActiveProject(workspace) : null), [workspace]);
  const snapshotDisplay = useMemo(
    () => buildSnapshotDisplay(activeProject?.snapshots ?? []),
    [activeProject?.snapshots],
  );

  const selectedSnapshot = useMemo(
    () =>
      activeProject?.snapshots.find(snapshot => snapshot.id === activeProject.selectedSnapshotId) ?? null,
    [activeProject],
  );

  const activeAiSessionSnapshot = activeProject ? aiSessionSnapshots[activeProject.id] ?? null : null;
  const activeAiSession = activeAiSessionSnapshot?.session ?? null;
  const activeCodexPanel = activeProject ? codexPanels[activeProject.id] ?? null : null;
  const activeProjectId = activeProject?.id ?? null;
  const activeAiSessionId = activeAiSession?.id ?? null;

  const targetOptions = useMemo(() => {
    const options = [
      {
        id: '__current__',
        label: `Current preview (${parseManifestTitle(activeProject?.currentPackage ?? null)})`,
      },
      ...snapshotDisplay.map(item => ({
        id: item.snapshot.id,
        label: snapshotOptionLabel(item),
      })),
    ];
    return options;
  }, [activeProject?.currentPackage, snapshotDisplay]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      const loaded = await loadWorkspaceState();
      const latestHostSession = await getLatestHostTokenSession().catch(() => null);
      if (cancelled) {
        return;
      }
      setWorkspace(loaded);
      setHostAuthSession(latestHostSession);
      const project = getActiveProject(loaded);
      setMode(project?.lastMode ?? 'create');
      setWorkspaceReady(true);
      window.setTimeout(() => inputRef.current?.focus(), 0);
    }

    load();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!activeProjectId || !activeProject || !isServerBackedProject(activeProject)) {
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const sessions = await listProjectAiSessions(activeProjectId);
        if (cancelled || sessions.length === 0) {
          return;
        }
        const preferred = [...sessions].sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0];
        if (!preferred) {
          return;
        }
        await refreshAiSessionSnapshot(activeProjectId, preferred.id);
      } catch {
        // best-effort restoration only
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [activeProject, activeProjectId]);

  useEffect(() => {
    const expectedOrigin = process.env.NEXT_PUBLIC_APP_URL ?? window.location.origin;

    function handleHostAuthMessage(event: MessageEvent<unknown>) {
      if (event.origin !== expectedOrigin) {
        return;
      }
      const data = event.data as { type?: string; session?: HostTokenSessionMetadata } | null;
      if (data?.type === 'host-auth-complete') {
        void getLatestHostTokenSession().then(setHostAuthSession).catch(() => undefined);
      }
    }

    window.addEventListener('message', handleHostAuthMessage);
    return () => {
      window.removeEventListener('message', handleHostAuthMessage);
    };
  }, []);

  useEffect(() => {
    if (!workspaceReady || !workspace) {
      return;
    }
    saveWorkspaceState(workspace).catch(() => {
      // ignore persistence failures in UI path
    });
  }, [workspace, workspaceReady]);

  useEffect(() => {
    if (!activeProject || !activeAiSessionId) {
      return;
    }

    const activeTurnId = activeProject.lastExecutionTrace?.turnId ?? null;
    const activeTurnState = activeProject.lastExecutionTrace?.turnState ?? null;
    if (!activeTurnId || isTerminalAsyncTurnState(activeTurnState)) {
      return;
    }

    let cancelled = false;
    let timeoutId: number | null = null;

    const poll = async () => {
      try {
        const status = await getAiSessionMessageTurnStatus(activeAiSessionId, activeTurnId);
        if (cancelled) {
          return;
        }

        setWorkspace(prev =>
          prev
            ? updateProject(prev, activeProject.id, project => ({
                ...project,
                lastExecutionTrace: project.lastExecutionTrace
                  ? {
                      ...project.lastExecutionTrace,
                      turnId: status.turnId,
                      turnState: status.status,
                      artifactState: status.artifactState,
                      acceptedAt: status.acceptedAt,
                      statusMessage: status.failureMessage ?? project.lastExecutionTrace.statusMessage,
                    }
                  : project.lastExecutionTrace,
              }))
            : prev,
        );

        if (!isTerminalAsyncTurnState(status.status)) {
          const generatorLabel = activeProject.lastRouteDecision ? labelForAgent(activeProject.lastRouteDecision.agent) : '生成器';
          const elapsed = status.acceptedAt ? Math.max(0, Date.now() - Date.parse(status.acceptedAt)) : 0;
          setPhases([
            {
              id: 'generator',
              label: generatorLabel,
              state: activeProject.lastMode === 'debug' ? 'repairing' : 'running',
              detail: `Async turn ${status.status} (artifact: ${status.artifactState})`,
              elapsedMs: elapsed,
            },
            { id: 'tester', label: '测试者', state: 'idle', detail: '等待生成完成', elapsedMs: 0 },
            { id: 'checker', label: '检查者', state: 'idle', detail: '等待最终结果', elapsedMs: 0 },
          ]);
        }

        if (isTerminalAsyncTurnState(status.status)) {
          await finalizeAsyncTurnRef.current(activeProject.id, activeTurnId);
          return;
        }
      } catch {
        // keep polling for transient request failures
      }

      timeoutId = window.setTimeout(() => {
        void poll();
      }, 1000);
    };

    void poll();

    return () => {
      cancelled = true;
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [activeAiSessionId, activeProject]);

  function mutateActiveProject(updater: (project: GameProject) => GameProject): void {
    if (!activeProject) {
      return;
    }
    setWorkspace(prev => (prev ? updateProject(prev, activeProject.id, updater) : prev));
  }

  function handleModeChange(nextMode: ActionMode): void {
    setMode(nextMode);
    mutateActiveProject(project => ({
      ...project,
      lastMode: nextMode,
      selectedDebugTargetId:
        nextMode === 'debug'
          ? (() => {
              const plausible = plausibleDebugTargets(project);
              if (plausible.length === 1) {
                return plausible[0];
              }
              if (plausible.length > 1) {
                return '';
              }
              return project.selectedDebugTargetId || '__current__';
            })()
          : project.selectedDebugTargetId,
      selectedModifyBaseId:
        nextMode === 'modify'
          ? project.selectedModifyBaseId || project.selectedSnapshotId || '__current__'
          : project.selectedModifyBaseId,
    }));
  }

  async function refreshAiSessionSnapshot(projectId: string, sessionId: string): Promise<void> {
    const snapshot = await getAiSessionSnapshot(sessionId);
    setAiSessionSnapshots(prev => ({
      ...prev,
      [projectId]: snapshot,
    }));
  }

  async function refreshCodexPanel(projectId: string, sessionId: string): Promise<void> {
    const logs = await getAiSessionLogs(sessionId);
    setCodexPanels(prev => ({
      ...prev,
      [projectId]: logs,
    }));
  }

  async function finalizeAsyncTurn(projectId: string, turnId: string): Promise<void> {
    if (!activeAiSessionId) {
      return;
    }

    const result = await getAiSessionMessageTurnResult(activeAiSessionId, turnId);
    const routeDecision = activeProject?.lastRouteDecision ?? null;
    const generatorLabel = routeDecision ? labelForAgent(routeDecision.agent) : '生成器';
    const failureContext = (result.executionEngine?.failureContext as FailureContext | null | undefined) ?? null;

    if (result.finalOutcome === 'failed' || !result.package || !result.staticEvaluation || !result.manifest) {
      const message = result.failureMessage ?? result.statusMessage;
      const elapsed = result.acceptedAt ? Math.max(0, Date.now() - Date.parse(result.acceptedAt)) : 0;
      setPhases([
        {
          id: 'generator',
          label: generatorLabel,
          state: 'failed',
          detail: message,
          elapsedMs: elapsed,
        },
        { id: 'tester', label: '测试者', state: 'failed', detail: '跳过：生成失败', elapsedMs: 0 },
        { id: 'checker', label: '检查者', state: 'failed', detail: '请求失败', elapsedMs: 0 },
      ]);

      setWorkspace(prev =>
        prev
          ? updateProject(prev, projectId, project => ({
              ...appendMessages(project, [
                makeChatMessage({
                  role: 'assistant',
                  mode: project.lastMode,
                  text: buildAssistantSummary({
                    outcome: 'hard_failure',
                    statusMessage: message,
                    source: 'request-error',
                    provider: result.provider,
                    model: result.model,
                    repaired: result.repaired,
                    fallbackUsed: result.fallbackUsed,
                    staticCode: 'REQUEST_FAILED',
                    engine: result.executionEngine ?? null,
                    failureContext,
                    recovery: null,
                  }),
                }),
              ]),
              lastExecutionTrace: project.lastExecutionTrace
                ? {
                    ...project.lastExecutionTrace,
                    outcome: 'hard_failure',
                    turnState: 'failed',
                    artifactState: result.artifactState,
                    statusMessage: message,
                    engine: (result.executionEngine as PackageExecutionTraceMeta | null | undefined) ?? null,
                    failureContext,
                  }
                : project.lastExecutionTrace,
            }))
          : prev,
      );
      return;
    }

    const generatedPackage = result.package;
    const staticEvaluation = result.staticEvaluation;
    const outcome = getExecutionOutcome((result.executionEngine as PackageExecutionTraceMeta | null | undefined) ?? null, true);
    const recovery = getRecoveryContext((result.executionEngine as PackageExecutionTraceMeta | null | undefined) ?? null);
    const summary = buildAssistantSummary({
      outcome,
      statusMessage: result.statusMessage,
      source: result.source,
      provider: result.provider,
      model: result.model,
      repaired: result.repaired,
      fallbackUsed: result.fallbackUsed,
      staticCode: staticEvaluation.code,
      engine: (result.executionEngine as PackageExecutionTraceMeta | null | undefined) ?? null,
      failureContext,
      recovery,
    });

    const elapsed = result.acceptedAt ? Math.max(0, Date.now() - Date.parse(result.acceptedAt)) : 0;
    phaseStartedRef.current.tester = nowMs();
    phaseStartedRef.current.checker = phaseStartedRef.current.tester;
    setPhases([
      { id: 'generator', label: generatorLabel, state: 'passed', detail: '异步生成完成，已加载版本包', elapsedMs: elapsed },
      { id: 'tester', label: '测试者', state: 'running', detail: '等待 sandbox READY + runTests', elapsedMs: 0 },
      { id: 'checker', label: '检查者', state: 'running', detail: '等待测试结论', elapsedMs: 0 },
    ]);

    setWorkspace(prev => {
      if (!prev) {
        return prev;
      }
      return updateProject(prev, projectId, project => ({
        ...appendMessages(project, [
          makeChatMessage({ role: 'assistant', mode: project.lastMode, text: summary }),
        ]),
        currentPackage: generatedPackage,
        currentEvaluator: staticEvaluation,
        selectedModifyBaseId: '__current__',
        selectedDebugTargetId: '__current__',
        lastExecutionTrace: project.lastExecutionTrace
          ? {
              ...project.lastExecutionTrace,
              outcome,
              recovery,
              turnState: 'completed',
              artifactState: result.artifactState,
              statusMessage: result.statusMessage,
              source: result.source,
              provider: result.provider,
              model: result.model,
              repaired: result.repaired,
              fallbackUsed: result.fallbackUsed,
              staticCode: staticEvaluation.code,
              engine: (result.executionEngine as PackageExecutionTraceMeta | null | undefined) ?? null,
              failureContext,
            }
          : project.lastExecutionTrace,
      }));
    });
    setRuntimeNonce(prev => prev + 1);
  }

  finalizeAsyncTurnRef.current = finalizeAsyncTurn;

  async function ensureAiSessionReadyForSend(projectId: string): Promise<string> {
    let session = activeAiSession;

    if (!session) {
      session = await createAiSession(projectId);
      await refreshAiSessionSnapshot(projectId, session.id).catch(() => undefined);
    }

    const transportPhase = activeCodexPanel?.transport?.phase ?? activeAiSessionSnapshot?.transport?.phase ?? 'uninitialized';
    if (transportPhase === 'ready') {
      return session.id;
    }

    const hostSession = await getLatestHostTokenSession();
    if (!hostSession?.bindToken) {
      throw new Error('Connect OAuth before sending prompts.');
    }

    const initResult = await initAiSessionTransport(session.id, hostSession.bindToken);
    await refreshAiSessionSnapshot(projectId, initResult.session.id).catch(() => undefined);
    await refreshCodexPanel(projectId, initResult.session.id).catch(() => undefined);
    return initResult.session.id;
  }

  async function handleCreateAiSession(): Promise<void> {
    if (!activeProject || busy || sessionBusy || !isServerBackedProject(activeProject)) {
      return;
    }

    const projectId = activeProject.id;

    setSessionBusy(true);
    try {
      const session = await createAiSession(projectId);
      await refreshAiSessionSnapshot(projectId, session.id);
      setCodexPanels(prev => ({
        ...prev,
        [projectId]: {
          transport: null,
          initTranscript: [],
          turnTranscript: [],
        },
      }));
      mutateActiveProject(project =>
        appendMessages(project, [
          makeChatMessage({
            role: 'system',
            mode: 'system',
            text: `AI session created: ${session.id}`,
          }),
        ]),
      );
    } finally {
      setSessionBusy(false);
    }
  }

  async function handleInitAiSession(): Promise<void> {
    if (!activeProject || !activeAiSession || busy || sessionBusy) {
      return;
    }

    const projectId = activeProject.id;
    const sessionId = activeAiSession.id;

    setSessionBusy(true);
    try {
      const hostSession = await getLatestHostTokenSession();
      if (!hostSession?.bindToken) {
        window.alert('No host token bind token is available. Complete host browser login first.');
        return;
      }

      const result = await initAiSessionTransport(sessionId, hostSession.bindToken);
      await refreshAiSessionSnapshot(projectId, result.session.id);
      await refreshCodexPanel(projectId, result.session.id);
      mutateActiveProject(project =>
        appendMessages(project, [
          makeChatMessage({
            role: 'system',
            mode: 'system',
            text: `Codex initialized. Thread=${result.transport.threadId ?? 'pending'} phase=${result.transport.phase}`,
          }),
        ]),
      );
    } catch (error) {
      await refreshAiSessionSnapshot(projectId, sessionId).catch(() => undefined);
      await refreshCodexPanel(projectId, sessionId).catch(() => undefined);
      mutateActiveProject(project =>
        appendMessages(project, [
          makeChatMessage({
            role: 'assistant',
            mode: 'system',
            text:
              error instanceof AiSessionClientError
                ? `Init Codex failed: ${error.message}${error.code ? ` (${error.code})` : ''}`
                : `Init Codex failed: ${error instanceof Error ? error.message : String(error)}`,
          }),
        ]),
      );
    } finally {
      setSessionBusy(false);
    }
  }

  async function handleStartHostAuth(): Promise<void> {
    if (hostAuthBusy) {
      return;
    }

    setHostAuthBusy(true);
    try {
      const start = await beginHostBrowserOAuth();
      const popup = window.open(start.authorizeUrl, 'game_edit_host_oauth', 'popup,width=720,height=820');
      if (!popup) {
        window.location.href = start.authorizeUrl;
        return;
      }
      const interval = window.setInterval(() => {
        if (popup.closed) {
          window.clearInterval(interval);
          void getLatestHostTokenSession().then(setHostAuthSession).catch(() => undefined);
        }
      }, 1000);
    } finally {
      setHostAuthBusy(false);
    }
  }

  async function handleCheckpointAiSession(): Promise<void> {
    if (!activeProject || !activeAiSession || busy || sessionBusy) {
      return;
    }

    if (activeProject.selectedModifyBaseId && activeProject.selectedModifyBaseId !== '__current__') {
      window.alert('Checkpoint only saves the current AI-session head. If you are previewing an older version, run Modify first to fork a new current head.');
      return;
    }

    setSessionBusy(true);
    try {
      const result = await checkpointAiSession(activeAiSession.id, `chk-${activeAiSession.id}-${Date.now()}`);
      if (result.project) {
        setWorkspace(prev => (prev ? mergeServerProjectIntoWorkspace(prev, result.project!) : prev));
      }
      await refreshAiSessionSnapshot(activeProject.id, activeAiSession.id);
      mutateActiveProject(project =>
        appendMessages(project, [
          makeChatMessage({
            role: 'system',
            mode: 'system',
            text:
              result.checkpoint.status === 'conflict'
                ? 'Checkpoint conflict: durable head moved ahead of this session base version.'
                : `Checkpoint committed as version ${result.checkpoint.newVersion ?? 'unknown'}.`,
          }),
        ]),
      );
    } finally {
      setSessionBusy(false);
    }
  }

  async function handleRevokeAiSession(): Promise<void> {
    if (!activeProject || !activeAiSession || busy || sessionBusy) {
      return;
    }

    setSessionBusy(true);
    try {
      const session = await revokeAiSession(activeAiSession.id);
      await refreshAiSessionSnapshot(activeProject.id, session.id);
      setCodexPanels(prev => ({
        ...prev,
        [activeProject.id]: {
          transport: null,
          initTranscript: [],
          turnTranscript: [],
        },
      }));
      mutateActiveProject(project =>
        appendMessages(project, [
          makeChatMessage({
            role: 'system',
            mode: 'system',
            text: `AI session revoked: ${session.id}`,
          }),
        ]),
      );
    } finally {
      setSessionBusy(false);
    }
  }

  useEffect(() => {
    if (!activeProjectId || !activeAiSessionId) {
      return;
    }

    const sessionId = activeAiSessionId;
    const projectId = activeProjectId;

    let cancelled = false;
    async function syncLogs() {
      try {
        setCodexLogsBusy(true);
        const logs = await getAiSessionLogs(sessionId);
        if (!cancelled) {
          setCodexPanels(prev => ({
            ...prev,
            [projectId]: logs,
          }));
        }
      } catch {
        // best-effort diagnostics only
      } finally {
        if (!cancelled) {
          setCodexLogsBusy(false);
        }
      }
    }

    void syncLogs();
    const timer = window.setInterval(() => {
      void syncLogs();
    }, 2000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [activeAiSessionId, activeProjectId]);

  useEffect(() => {
    if (!activeAiSessionId) {
      setAiSessionVersions([]);
      setViewedAiSessionVersion(null);
      setViewedAiSessionVersionId('');
      return;
    }

    setAiSessionVersions([]);
    setViewedAiSessionVersion(null);
    setViewedAiSessionVersionId('');

    let cancelled = false;
    async function fetchVersions() {
      try {
        const versions = await listAiSessionVersions(activeAiSessionId!);
        if (!cancelled) {
          setAiSessionVersions(versions);
          setViewedAiSessionVersionId(currentId => (currentId && !versions.some(version => version.versionId === currentId) ? '' : currentId));
          setViewedAiSessionVersion(current => (current && !versions.some(version => version.versionId === current.versionId) ? null : current));
        }
      } catch {
        // ignore
      }
    }

    void fetchVersions();
    const timer = window.setInterval(() => {
      void fetchVersions();
    }, 5000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [activeAiSessionId]);

  async function handleCreateProject(): Promise<void> {
    if (!workspace || busy) {
      return;
    }
    setBusy(true);
    try {
      const name = `Project ${workspace.projects.length + 1}`;
      const createdProject = await createServerProject(name);
      setWorkspace(prev => (prev ? mergeServerProjectIntoWorkspace(prev, createdProject) : prev));
      setMode('create');
      setComposerText('');
      setPhases(defaultPhases());
      window.setTimeout(() => inputRef.current?.focus(), 0);
    } catch (error) {
      const allowLocalFallback = !workspace.projects.some(project => isServerBackedProject(project));
      const result = addProject(workspace, `Project ${workspace.projects.length + 1}`);
      if (allowLocalFallback && result.ok) {
        setWorkspace(result.workspace);
        setMode('create');
        setComposerText('');
        setPhases(defaultPhases());
      } else {
        window.alert(error instanceof Error ? error.message : String(error));
      }
    } finally {
      setBusy(false);
    }
  }

  function handleSelectProject(projectId: string): void {
    if (!workspace) {
      return;
    }
    setWorkspace(prev =>
      prev
        ? {
            ...prev,
            activeProjectId: projectId,
          }
        : prev,
    );
    const project = workspace.projects.find(item => item.id === projectId);
    setMode(project?.lastMode ?? 'create');
    setComposerText('');
    setPhases(defaultPhases());
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }

  async function handleDeleteProject(): Promise<void> {
    if (!activeProject || !workspace || busy) {
      return;
    }
    const first = window.confirm(`Delete project "${activeProject.name}"?`);
    if (!first) {
      return;
    }
    const second = window.confirm(
      `This will permanently delete ${activeProject.snapshots.length} snapshot(s) under this project. Continue?`,
    );
    if (!second) {
      return;
    }
    setBusy(true);
    try {
      await deleteServerProject(activeProject.id);
      const next = await loadWorkspaceState();
      setWorkspace(next);
      setMode(getActiveProject(next)?.lastMode ?? 'create');
      setComposerText('');
      setPhases(defaultPhases());
      window.setTimeout(() => inputRef.current?.focus(), 0);
    } catch (error) {
      if (isServerBackedProject(activeProject)) {
        window.alert(error instanceof Error ? error.message : String(error));
      } else {
        const next = deleteProject(workspace, activeProject.id);
        setWorkspace(next);
        setMode(getActiveProject(next)?.lastMode ?? 'create');
        setComposerText('');
        setPhases(defaultPhases());
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleArchiveSnapshot(): Promise<void> {
    if (!activeProject || !activeProject.currentPackage || busy) {
      return;
    }
    setBusy(true);
    try {
      const persistedProject = await saveProjectPackage({
        projectId: activeProject.id,
        pkg: activeProject.currentPackage,
        source: 'archive',
        parentVersion: getHeadVersion(activeProject) || null,
      });
      setWorkspace(prev => {
        if (!prev) {
          return prev;
        }
        const merged = mergeServerProjectIntoWorkspace(prev, persistedProject);
        return updateProject(merged, activeProject.id, project => ({
          ...project,
          messages: [
            ...project.messages,
            makeChatMessage({
              role: 'system',
              mode: 'system',
              text: 'Archived the current server-backed version.',
            }),
          ],
        }));
      });
    } catch (error) {
      if (isServerBackedProject(activeProject)) {
        window.alert(error instanceof Error ? error.message : String(error));
      } else {
        const result = archiveCurrentPackage(activeProject, {
          parentSnapshotId: activeProject.selectedSnapshotId || null,
        });
        if (result.ok) {
          mutateActiveProject(project => ({
            ...result.project,
            messages: [
              ...project.messages,
              makeChatMessage({
                role: 'system',
                mode: 'system',
                text: 'Archived snapshot locally because server persistence is unavailable.',
              }),
            ],
          }));
        } else {
          window.alert(error instanceof Error ? error.message : String(error));
        }
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleRestoreSnapshot(): Promise<void> {
    if (!activeProject || !selectedSnapshot) {
      return;
    }

    setBusy(true);
    try {
      if (isServerBackedProject(activeProject)) {
        mutateActiveProject(project => ({
          ...project,
          currentPackage: selectedSnapshot.pkg,
          currentEvaluator: selectedSnapshot.evaluator,
          selectedModifyBaseId: selectedSnapshot.id,
          selectedDebugTargetId: selectedSnapshot.id,
          messages: [
            ...project.messages,
            makeChatMessage({
              role: 'system',
              mode: 'system',
              text: `Switched preview to version ${selectedSnapshot.id}. Modify will fork from this version.`,
            }),
          ],
        }));
      } else {
        mutateActiveProject(project => ({
          ...project,
          currentPackage: selectedSnapshot.pkg,
          currentEvaluator: selectedSnapshot.evaluator,
          selectedModifyBaseId: selectedSnapshot.id,
          selectedDebugTargetId: selectedSnapshot.id,
          messages: [
            ...project.messages,
            makeChatMessage({
              role: 'system',
              mode: 'system',
              text: `Restored snapshot locally: ${selectedSnapshot.title}`,
            }),
          ],
        }));
      }
      setRuntimeNonce(prev => prev + 1);
    } catch (error) {
      if (isServerBackedProject(activeProject)) {
        window.alert(error instanceof Error ? error.message : String(error));
      }
    } finally {
      setBusy(false);
    }
  }

  function handleDeleteSnapshot(): void {
    if (!activeProject || !selectedSnapshot) {
      return;
    }
    window.alert('Server-backed versions are immutable. Restore only switches preview; it does not delete or fork versions by itself.');
  }

  async function handleSelectAiSessionVersion(versionId: string): Promise<void> {
    setViewedAiSessionVersionId(versionId);
    if (!versionId) {
      setViewedAiSessionVersion(null);
      return;
    }

    if (!activeAiSessionId) {
      return;
    }

    setBusy(true);
    try {
      const payload = await getAiSessionVersionPayload(activeAiSessionId, versionId);
      setViewedAiSessionVersion(payload);
      setRuntimeNonce(prev => prev + 1);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : String(error));
      setViewedAiSessionVersionId('');
      setViewedAiSessionVersion(null);
    } finally {
      setBusy(false);
    }
  }

  async function handleSubmit(): Promise<void> {
    if (!activeProject || busy) {
      return;
    }
    const text = composerText.trim();
    if (!text) {
      return;
    }

    const debugTargets = plausibleDebugTargets(activeProject);
    if (mode === 'debug' && debugTargets.length > 1 && !effectiveDebugTargetId) {
      window.alert('Please choose a debug target version first.');
      return;
    }

    setBusy(true);

    let ensuredAiSessionId: string | undefined;
    let sessionPrepareStage: ExecutionStage | null = null;
    if (isServerBackedProject(activeProject)) {
      const sessionPrepareStartedAt = nowMs();
      try {
        ensuredAiSessionId = await ensureAiSessionReadyForSend(activeProject.id);
        sessionPrepareStage = createExecutionStage({
          key: 'session_prepare',
          status: 'completed',
          durationMs: Math.max(0, nowMs() - sessionPrepareStartedAt),
          detail: 'Codex session prepared for the next request.',
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const code = error instanceof AiSessionClientError ? error.code ?? undefined : undefined;
        sessionPrepareStage = createExecutionStage({
          key: 'session_prepare',
          status: 'failed',
          durationMs: Math.max(0, nowMs() - sessionPrepareStartedAt),
          detail: message,
        });
        mutateActiveProject(project =>
          appendMessages(project, [
            makeChatMessage({
              role: 'assistant',
              mode,
              text: `Request failed before send: ${message}`,
            }),
          ]),
        );
        mutateActiveProject(project => ({
          ...project,
          lastExecutionTrace: {
            requestMode: mode,
            endpoint: 'session-prepare',
            targetId: activeProject.selectedSnapshotId || '__current__',
            roleLabel: 'Codex session',
            statusMessage: message,
            source: 'request-error',
            provider: '-',
            model: '-',
            repaired: false,
            fallbackUsed: false,
            staticCode: 'REQUEST_FAILED',
            testsRun: [],
            filesProduced: [],
            engine: null,
            stages: sessionPrepareStage ? [sessionPrepareStage] : [],
            failureContext: buildClientFailureContext({
              checkpoint: 'request_setup',
              error: message,
              code,
              reason: 'session_prepare_failed',
            }),
            attemptSummaries: [],
          },
        }));
        setBusy(false);
        return;
      }
    }

    let endpoint = '/api/package/generate';
    let payload: Record<string, unknown> = {};
      let clientRouteDecision: RouteDecision;

      if (mode === 'create') {
        clientRouteDecision = decideRoute({
          mode,
          requestText: text,
          targetId: '__current__',
          targetPackage: activeProject.currentPackage,
      });
      endpoint = '/api/package/generate';
      payload = {
        prompt: text,
        projectId: activeProject.id,
        aiSessionId: ensuredAiSessionId,
        lastKnownGoodPackage: activeProject.lastGreenSnapshotId
          ? activeProject.snapshots.find(snapshot => snapshot.id === activeProject.lastGreenSnapshotId)?.pkg
          : null,
      };
      } else if (mode === 'modify') {
        const targetId = effectiveModifyBaseId;
        const targetPackage = resolvePackageFromTarget(activeProject, targetId);
        if (!targetPackage) {
          window.alert('No modify baseline selected.');
          return;
        }
        clientRouteDecision = decideRoute({
          mode,
          requestText: text,
          targetId,
          targetPackage,
      });
      endpoint = '/api/package/modify';
      payload = {
        instruction: text,
        projectId: activeProject.id,
          aiSessionId: ensuredAiSessionId,
          targetId,
          currentPackage: targetPackage,
          lastKnownGoodPackage: activeProject.lastGreenSnapshotId
            ? activeProject.snapshots.find(snapshot => snapshot.id === activeProject.lastGreenSnapshotId)?.pkg
            : null,
        };
      } else {
        const targetId = effectiveDebugTargetId || '__current__';
        const targetPackage = resolvePackageFromTarget(activeProject, targetId);
        if (!targetPackage) {
          window.alert('No debug target selected.');
          return;
        }
        clientRouteDecision = decideRoute({
          mode,
          requestText: text,
          targetId,
          targetPackage,
      });
      endpoint = '/api/package/debug';
      payload = {
        errorReport: text,
        projectId: activeProject.id,
        aiSessionId: ensuredAiSessionId,
        targetId,
          currentPackage: targetPackage,
          evaluatorSummary: activeProject.currentEvaluator?.summary ?? '',
          lastKnownGoodPackage: activeProject.lastGreenSnapshotId
            ? activeProject.snapshots.find(snapshot => snapshot.id === activeProject.lastGreenSnapshotId)?.pkg
            : null,
        };
      }

      const generatorLabel = labelForAgent(clientRouteDecision.agent);

    phaseStartedRef.current.generator = nowMs();
    setPhases([
      {
        id: 'generator',
        label: generatorLabel,
        state: mode === 'debug' ? 'repairing' : 'running',
        detail: `${clientRouteDecision.summary} ${mode === 'debug' ? '正在修复错误...' : mode === 'modify' ? '正在应用修改...' : '正在生成项目包...'}`,
        elapsedMs: 0,
      },
      {
        id: 'tester',
        label: '测试者',
        state: 'idle',
        detail: '等待生成结果',
        elapsedMs: 0,
      },
      {
        id: 'checker',
        label: '检查者',
        state: 'idle',
        detail: '等待测试结果',
        elapsedMs: 0,
      },
    ]);

    mutateActiveProject(project =>
      ({
        ...appendMessages(project, [
          makeChatMessage({
            role: 'user',
            mode,
            text,
          }),
        ]),
        lastRouteDecision: clientRouteDecision,
      }),
    );

    const response = await postJson(endpoint, payload).catch(
      (error): PackageApiFailure => ({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        executionEngine: undefined,
      }),
    );

    if (!response.ok) {
      const elapsed = Math.max(0, nowMs() - phaseStartedRef.current.generator);
      const failureStages = mergeExecutionStages(
        sessionPrepareStage ? [sessionPrepareStage] : [],
        response.executionEngine?.stages ?? [],
      );
      const failureContext = buildStageDetailFromFailure({
        response,
        fallback: buildClientFailureContext({
          checkpoint: 'request_send',
          error: response.error,
          code: response.code,
          reason: response.code ?? 'request_failed',
        }),
      });
      setPhases([
        {
          id: 'generator',
          label: generatorLabel,
          state: 'failed',
          detail: response.error,
          elapsedMs: elapsed,
        },
        {
          id: 'tester',
          label: '测试者',
          state: 'failed',
          detail: '跳过：生成失败',
          elapsedMs: 0,
        },
        {
          id: 'checker',
          label: '检查者',
          state: 'failed',
          detail: '请求失败',
          elapsedMs: 0,
        },
      ]);

      mutateActiveProject(project =>
        ({
          ...appendMessages(project, [
            makeChatMessage({
              role: 'assistant',
              mode,
              text: buildAssistantSummary({
                outcome: 'hard_failure',
                statusMessage: response.error,
                source: 'request-error',
                provider: '-',
                model: '-',
                repaired: false,
                fallbackUsed: false,
                staticCode: 'REQUEST_FAILED',
                engine: response.executionEngine ?? null,
                failureContext,
                recovery: null,
              }),
            }),
          ]),
          lastExecutionTrace: {
            requestMode: mode,
            endpoint,
            targetId: clientRouteDecision.targetId,
            roleLabel: generatorLabel,
            outcome: 'hard_failure',
            recovery: null,
            statusMessage: response.error,
            source: 'request-error',
            provider: '-',
            model: '-',
            repaired: false,
            fallbackUsed: false,
            staticCode: 'REQUEST_FAILED',
            testsRun: [],
            filesProduced: [],
            engine: response.executionEngine ?? null,
            stages: failureStages,
            failureContext,
            attemptSummaries: [],
          },
        }),
      );
      setBusy(false);
      return;
    }

      if (response.accepted) {
        const routeDecision = response.serverRouteDecision ?? clientRouteDecision;
        const outcome: ExecutionOutcome = 'pending';
        const summary = buildAssistantSummary({
          outcome,
          statusMessage: response.statusMessage,
          source: response.source,
          provider: response.provider,
          model: response.model,
          repaired: response.repaired,
          fallbackUsed: response.fallbackUsed,
          requiresReplan: response.requiresReplan,
          persistenceWarning: response.persistenceWarning,
          staticCode: 'TURN_ACCEPTED',
          engine: response.executionEngine ?? null,
          failureContext: null,
          recovery: null,
        });
        const elapsed = Math.max(0, nowMs() - phaseStartedRef.current.generator);
        setPhases([
          {
            id: 'generator',
            label: generatorLabel,
            state: mode === 'debug' ? 'repairing' : 'running',
            detail: `Turn accepted (${response.asyncTurn.turnId}). Waiting for async completion...`,
            elapsedMs: elapsed,
          },
          {
            id: 'tester',
            label: '测试者',
            state: 'idle',
            detail: '等待生成完成',
            elapsedMs: 0,
          },
          {
            id: 'checker',
            label: '检查者',
            state: 'idle',
            detail: '等待最终结果',
            elapsedMs: 0,
          },
        ]);

        mutateActiveProject(project => ({
          ...appendMessages(project, [
            makeChatMessage({
              role: 'assistant',
              mode,
              text: summary,
            }),
          ]),
          lastMode: mode,
          lastRouteDecision: routeDecision,
          lastExecutionTrace: {
            requestMode: mode,
            endpoint,
            targetId: routeDecision.targetId,
            roleLabel: generatorLabel,
            outcome,
            recovery: null,
            turnId: response.asyncTurn.turnId,
            turnState: response.asyncTurn.status,
            artifactState: response.asyncTurn.artifactState,
            acceptedAt: response.asyncTurn.acceptedAt,
            deduplicated: Boolean(response.asyncTurn.deduplicated),
            statusMessage: response.statusMessage,
            source: response.source,
            provider: response.provider,
            model: response.model,
            repaired: response.repaired,
            fallbackUsed: response.fallbackUsed,
            staticCode: 'TURN_ACCEPTED',
            testsRun: [],
            filesProduced: [],
            engine: response.executionEngine ?? null,
            stages: mergeExecutionStages(sessionPrepareStage ? [sessionPrepareStage] : [], response.executionEngine?.stages ?? []),
            failureContext: null,
            attemptSummaries: [],
          },
        }));
        setBusy(false);
        return;
      }

      const generated = response.package;
      const routeDecision = response.serverRouteDecision ?? clientRouteDecision;
      const latestAttempt = response.attempts.at(-1);
      const fallbackReason = response.fallbackUsed
        ? latestAttempt?.outcome === 'timeout'
          ? `model timeout (${latestAttempt.durationMs || 60000}ms limit)`
          : latestAttempt?.errorMessage
            ? latestAttempt.errorMessage
            : 'model request failed'
        : null;
      const outcome = getExecutionOutcome(response.executionEngine ?? null, true);
      const recovery = getRecoveryContext(response.executionEngine ?? null);
      const failureContext = response.executionEngine?.failureContext ?? null;
      const summary = buildAssistantSummary({
        outcome,
        statusMessage: response.statusMessage,
        source: response.source,
        provider: response.provider,
        model: response.model,
        repaired: response.repaired,
        fallbackUsed: response.fallbackUsed,
        requiresReplan: response.requiresReplan,
        persistenceWarning: response.persistenceWarning,
        staticCode: response.staticEvaluation.code,
        engine: response.executionEngine ?? null,
        failureContext,
        recovery,
        fallbackReason,
      });

    const elapsed = Math.max(0, nowMs() - phaseStartedRef.current.generator);
    phaseStartedRef.current.tester = nowMs();
    phaseStartedRef.current.checker = phaseStartedRef.current.tester;
    setPhases([
      {
        id: 'generator',
        label: generatorLabel,
        state: 'passed',
        detail: '已生成版本包',
        elapsedMs: elapsed,
      },
      {
        id: 'tester',
        label: '测试者',
        state: 'running',
        detail: '等待 sandbox READY + runTests',
        elapsedMs: 0,
      },
      {
        id: 'checker',
        label: '检查者',
        state: 'running',
        detail: '等待测试结论',
        elapsedMs: 0,
      },
    ]);

    setWorkspace(prev => {
      if (!prev) {
        return prev;
      }

      const locallyUpdated = updateProject(prev, activeProject.id, project => {
        const next = appendMessages(project, [
          makeChatMessage({
            role: 'assistant',
            mode,
            text: summary,
          }),
        ]);

        return {
          ...next,
          currentPackage: generated,
          currentEvaluator: response.staticEvaluation,
          selectedModifyBaseId: '__current__',
          selectedDebugTargetId: '__current__',
          attempts: response.attempts,
          lastMode: mode,
          lastRouteDecision: routeDecision,
          lastExecutionTrace: {
            requestMode: mode,
            endpoint,
            targetId: routeDecision.targetId,
            roleLabel: generatorLabel,
            outcome,
            recovery,
            statusMessage: response.statusMessage,
            source: response.source,
            provider: response.provider,
            model: response.model,
            repaired: response.repaired,
            fallbackUsed: response.fallbackUsed,
            staticCode: response.requiresReplan
              ? `${response.staticEvaluation.code} [${response.executionEngine?.strategy ?? 'plan_then_execute'}]`
              : response.staticEvaluation.code,
            testsRun: ['static-evaluator', 'sandbox-ready', 'sandbox-runTests'],
            filesProduced: ['indexHtml', 'gameJs', 'styleCss', 'manifestJson'],
            engine: response.executionEngine ?? null,
            stages: mergeExecutionStages(
              sessionPrepareStage ? [sessionPrepareStage] : [],
              response.executionEngine?.stages ?? [],
            ),
            failureContext,
            attemptSummaries: toAttemptSummaries(response.attempts),
          },
        };
      });

      if (response.project) {
        return mergeServerProjectIntoWorkspace(locallyUpdated, response.project);
      }

      if (!response.project && response.persistenceWarning) {
        return updateProject(locallyUpdated, activeProject.id, project => ({
          ...project,
          messages: [
            ...project.messages,
            makeChatMessage({
              role: 'system',
              mode: 'system',
              text: `Server persistence warning: ${response.persistenceWarning}`,
            }),
          ],
        }));
      }

      return locallyUpdated;
    });

    setComposerText('');
    setRuntimeNonce(prev => prev + 1);
    setBusy(false);
  }

  function handleSandboxReport(result: EvaluatorResult): void {
    if (!activeProject) {
      return;
    }

    const testerElapsed = Math.max(0, nowMs() - phaseStartedRef.current.tester);
    const checkerElapsed = Math.max(0, nowMs() - phaseStartedRef.current.checker);
    setPhases([
      phases[0] ?? {
        id: 'generator',
        label: '生成器/修复器',
        state: 'idle',
        detail: '等待任务',
        elapsedMs: 0,
      },
      {
        id: 'tester',
        label: '测试者',
        state: result.ok ? 'passed' : 'failed',
        detail: result.summary,
        elapsedMs: testerElapsed,
      },
      {
        id: 'checker',
        label: '检查者',
        state: result.ok ? 'passed' : 'failed',
        detail: result.ok
          ? result.summary === 'No runTests hook defined.'
            ? '基础启动通过，但没有项目自定义 runTests。'
            : '符合当前执行模式要求。'
          : '发现错误，建议切换修复或继续调试。',
        elapsedMs: checkerElapsed,
      },
    ]);

    mutateActiveProject(project => ({
      ...project,
      currentEvaluator: result,
      lastGreenSnapshotId: result.ok ? project.selectedSnapshotId || project.lastGreenSnapshotId : project.lastGreenSnapshotId,
      lastExecutionTrace: project.lastExecutionTrace
        ? {
            ...project.lastExecutionTrace,
            sandboxCode: result.code,
            stages: mergeExecutionStages(project.lastExecutionTrace.stages, [
              createExecutionStage({
                key: 'sandbox_test',
                status: result.ok ? 'completed' : 'failed',
                durationMs: testerElapsed,
                detail: result.summary,
              }),
              createExecutionStage({
                key: 'final_check',
                status: result.ok ? 'completed' : 'failed',
                durationMs: checkerElapsed,
                detail: result.ok ? 'Sandbox evaluation completed.' : 'Sandbox evaluation reported failures.',
              }),
            ]),
          }
        : project.lastExecutionTrace,
    }));

    if (isServerBackedProject(activeProject) && !activeAiSession) {
      const currentHeadVersion = getHeadVersion(activeProject);
      if (currentHeadVersion > 0) {
        void updateProjectEvaluation({
          projectId: activeProject.id,
          version: currentHeadVersion,
          evaluator: result,
        })
          .then(project => {
            setWorkspace(prev => (prev ? mergeServerProjectIntoWorkspace(prev, project) : prev));
          })
          .catch(() => undefined);
      }
    }
  }

  if (!workspaceReady || !workspace || !activeProject) {
    return (
      <main className={styles.main}>
        <h1 style={{ margin: '0 0 6px' }}>AI Mini-Game Workspace</h1>
        <p style={{ margin: '0 0 12px', color: 'var(--text-dim)' }}>
          Loading workspace...
        </p>
      </main>
    );
  }

  const effectiveModifyBaseId =
    activeProject.selectedModifyBaseId || activeProject.selectedSnapshotId || '__current__';
  const debugTargets = plausibleDebugTargets(activeProject);
  const effectiveDebugTargetId =
    activeProject.selectedDebugTargetId || (debugTargets.length === 1 ? debugTargets[0] : '');
  const looksLikeDebug = inferDebugSuggestion(composerText);
  const requireDebugTargetChoice = mode === 'debug' && debugTargets.length > 1 && !effectiveDebugTargetId;
  const selectedPreviewLabel = parseManifestTitle(viewedAiSessionVersion?.package ?? activeProject.currentPackage);
  const codexReady =
    !isServerBackedProject(activeProject) ||
    activeCodexPanel?.transport?.phase === 'ready' ||
    activeAiSessionSnapshot?.transport?.phase === 'ready';

  return (
    <main className={styles.main}>
      <h1 style={{ margin: '0 0 6px' }}>AI Mini-Game Workspace</h1>
      <p style={{ margin: '0 0 12px', color: 'var(--text-dim)' }}>
        Project-scoped chat editing with sandbox preview, explicit modes, and snapshot lineage.
      </p>

      <section className={styles.layout}>
        <aside className={styles.panel}>
          <div className={styles.row}>
            <strong>Projects</strong>
             <button className={styles.btnPrimary} type="button" onClick={() => void handleCreateProject()} disabled={busy}>
              + New
            </button>
          </div>

          <div className={styles.projectList}>
            {workspace.projects.map(project => (
              <button
                key={project.id}
                type="button"
                className={`${styles.projectItem} ${
                  project.id === workspace.activeProjectId ? styles.projectItemActive : ''
                }`}
                onClick={() => handleSelectProject(project.id)}
              >
                <div style={{ fontWeight: 700 }}>{project.name}</div>
                <div className={styles.mono}>Snapshots: {project.snapshots.length}</div>
                <div className={styles.mono}>Messages: {project.messages.length}</div>
              </button>
            ))}
          </div>

           <button className={styles.btnDanger} type="button" onClick={() => void handleDeleteProject()} disabled={busy}>
            Delete Active Project
          </button>
        </aside>

        <section className={styles.panel}>
          <div className={styles.row}>
            <strong>{activeProject.name}</strong>
            <span className={styles.mono}>Current: {selectedPreviewLabel}</span>
          </div>

          <div className={styles.messages}>
            {activeProject.messages.map(message => (
              <article
                key={message.id}
                className={
                  message.role === 'user'
                    ? styles.bubbleUser
                    : message.role === 'assistant'
                      ? styles.bubbleAssistant
                      : styles.bubbleSystem
                }
              >
                <div className={styles.mono}>
                  {message.role.toUpperCase()} | {message.mode} | {new Date(message.createdAt).toLocaleTimeString()}
                </div>
                <div>{message.text}</div>
              </article>
            ))}
          </div>

          <div className={styles.composer}>
            <div className={styles.row}>
              <div className={styles.modeGroup}>
                {MODES.map(item => (
                  <button
                    key={item.id}
                    type="button"
                    className={`${styles.modeBtn} ${mode === item.id ? styles.modeBtnActive : ''}`}
                    onClick={() => handleModeChange(item.id)}
                    disabled={busy}
                  >
                    {item.label}
                  </button>
                ))}
              </div>

              {looksLikeDebug && mode !== 'debug' ? (
                <button type="button" className={styles.btn} onClick={() => handleModeChange('debug')}>
                  看起来像报错，切到修错误
                </button>
              ) : null}
            </div>

            {mode === 'modify' ? (
              <label style={{ display: 'grid', gap: 6 }}>
                <span className={styles.mono}>基于哪个快照修改</span>
                <select
                  className={styles.select}
                  value={effectiveModifyBaseId}
                  onChange={event =>
                    mutateActiveProject(project => ({
                      ...project,
                      selectedModifyBaseId: event.target.value,
                    }))
                  }
                  disabled={busy}
                >
                  {targetOptions.map(option => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}

            {mode === 'debug' ? (
              <label style={{ display: 'grid', gap: 6 }}>
                <span className={styles.mono}>修复哪个版本</span>
                <select
                  className={styles.select}
                  value={effectiveDebugTargetId}
                  onChange={event =>
                    mutateActiveProject(project => ({
                      ...project,
                      selectedDebugTargetId: event.target.value,
                    }))
                  }
                  disabled={busy}
                >
                  {debugTargets.length > 1 ? <option value="">选择修复目标版本</option> : null}
                  {targetOptions.map(option => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
                {requireDebugTargetChoice ? (
                  <span className={styles.mono}>Multiple failing candidates found. Choose one target before sending.</span>
                ) : (
                  <span className={styles.mono}>Debug uses explicit target selection and text error input.</span>
                )}
              </label>
            ) : null}

            <textarea
              ref={inputRef}
              className={styles.input}
              value={composerText}
              onChange={event => setComposerText(event.target.value)}
              placeholder={
                mode === 'create'
                  ? '描述你想生成的小游戏...'
                  : mode === 'modify'
                    ? '描述你要修改的玩法/界面/规则...'
                    : '粘贴错误文本并说明你希望修复到什么状态...'
              }
              disabled={busy}
            />

            <div className={styles.row}>
              <button
                className={styles.btnPrimary}
                type="button"
                disabled={
                  busy ||
                  !composerText.trim() ||
                  (mode === 'debug' && requireDebugTargetChoice) ||
                  Boolean(viewedAiSessionVersionId)
                }
                onClick={() => {
                  handleSubmit().catch(error => {
                    setBusy(false);
                    mutateActiveProject(project =>
                      appendMessages(project, [
                        makeChatMessage({
                          role: 'assistant',
                          mode,
                          text: `Unexpected request error: ${
                            error instanceof Error ? error.message : String(error)
                          }`,
                        }),
                      ]),
                    );
                  });
                }}
              >
                Send
              </button>
              <span className={styles.mono}>{busy ? 'Working...' : 'Idle'}</span>
            </div>
            {!codexReady ? <span className={styles.mono}>Send will auto-initialize Codex if OAuth is ready.</span> : null}
            {viewedAiSessionVersionId ? <span className={styles.mono} style={{ color: 'var(--text-dim)' }}>Cannot send requests while viewing a read-only Box version. Switch to Active Head first.</span> : null}
          </div>

          {isServerBackedProject(activeProject) ? (
            <div className={styles.panel} style={{ padding: 8 }}>
              <div className={styles.row}>
                <strong>Host OAuth</strong>
                <span className={styles.mono}>{hostAuthBusy ? 'Authorizing...' : hostAuthSession ? 'Connected' : 'Not connected'}</span>
              </div>

              <pre className={styles.mono} style={{ whiteSpace: 'pre-wrap', margin: '8px 0' }}>
                {JSON.stringify(
                  hostAuthSession
                    ? {
                        sessionId: hostAuthSession.sessionId,
                        accountId: hostAuthSession.accountId,
                        expiresAt: hostAuthSession.expiresAt,
                        bindTokenPresent: Boolean(hostAuthSession.bindToken),
                        revoked: Boolean(hostAuthSession.revoked),
                      }
                    : { connected: false },
                  null,
                  2,
                )}
              </pre>

              <div className={styles.row}>
                <button className={styles.btn} type="button" onClick={() => void handleStartHostAuth()} disabled={hostAuthBusy || busy || sessionBusy}>
                  {hostAuthSession ? 'Reconnect OAuth' : 'Connect OAuth'}
                </button>
              </div>

              <div className={styles.row}>
                <strong>AI Session</strong>
                <span className={styles.mono}>{sessionBusy ? 'Session working...' : activeAiSession ? activeAiSession.status : 'No session'}</span>
              </div>

              <pre className={styles.mono} style={{ whiteSpace: 'pre-wrap', margin: '8px 0' }}>
                {activeAiSessionSnapshot
                  ? JSON.stringify(
                      {
                        sessionId: activeAiSessionSnapshot.session.id,
                        status: activeAiSessionSnapshot.session.status,
                        activeWorkspaceVersion: activeAiSessionSnapshot.session.activeWorkspaceVersion,
                        latestWorkspaceVersion: activeAiSessionSnapshot.session.latestWorkspaceVersion,
                        authState: activeAiSessionSnapshot.session.authState,
                        boxId: activeAiSessionSnapshot.session.boxId,
                        boxStatus: activeAiSessionSnapshot.session.boxStatus,
                        appServerStatus: activeAiSessionSnapshot.session.appServerStatus,
                        transportPhase: activeAiSessionSnapshot.transport?.phase ?? 'uninitialized',
                        recoveryOutcome: activeAiSessionSnapshot.session.recoveryOutcome,
                        lastCheckpointVersion: activeAiSessionSnapshot.session.lastCheckpointVersion,
                        recentEvents: activeAiSessionSnapshot.events.map(event => event.type),
                      },
                      null,
                      2,
                    )
                  : 'No AI session created for this project yet.'}
              </pre>

              <div className={styles.row}>
                <button className={styles.btn} type="button" onClick={() => void handleCreateAiSession()} disabled={busy || sessionBusy || Boolean(activeAiSession)}>
                  Create Session
                </button>
                <button
                  className={styles.btn}
                  type="button"
                  onClick={() => void handleInitAiSession()}
                  disabled={
                    busy ||
                    sessionBusy ||
                    !activeAiSession ||
                    !hostAuthSession?.bindToken ||
                    activeAiSessionSnapshot?.transport?.phase === 'ready'
                  }
                >
                  Init Codex
                </button>
                <button
                  className={styles.btn}
                  type="button"
                  onClick={() => void handleCheckpointAiSession()}
                  disabled={busy || sessionBusy || !activeAiSession || activeProject.selectedModifyBaseId !== '__current__'}
                >
                  Checkpoint
                </button>
                <button className={styles.btnDanger} type="button" onClick={() => void handleRevokeAiSession()} disabled={busy || sessionBusy || !activeAiSession}>
                  Revoke Session
                </button>
              </div>

              <CodexPanel
                transport={activeCodexPanel?.transport ?? activeAiSessionSnapshot?.transport ?? null}
                initTranscript={activeCodexPanel?.initTranscript ?? []}
                turnTranscript={activeCodexPanel?.turnTranscript ?? []}
                loading={codexLogsBusy}
              />
            </div>
          ) : null}
        </section>

        <section className={styles.panel}>
          <strong>Agent Status</strong>
          <div className={styles.phaseList}>
            {phases.map(phase => (
              <article key={phase.id} className={styles.phaseCard}>
                <div className={styles.row}>
                  <strong>{phase.label}</strong>
                  <span className={phaseBadgeClass(phase.state)}>{phase.state}</span>
                </div>
                <div>{phase.detail}</div>
                <div className={styles.mono}>Elapsed: {(phase.elapsedMs / 1000).toFixed(2)}s</div>
              </article>
            ))}
          </div>

          <div className={styles.panel} style={{ padding: 8 }}>
            <strong>Current Evaluator</strong>
            <pre className={styles.mono} style={{ whiteSpace: 'pre-wrap', margin: 0 }}>
              {JSON.stringify(activeProject.currentEvaluator, null, 2)}
            </pre>
          </div>
        </section>

        <section className={styles.panel}>
          <div className={styles.row}>
            <strong>Preview + Snapshots</strong>
            <span className={styles.mono}>Snapshots: {activeProject.snapshots.length}</span>
          </div>

          <div className={styles.row}>
            <select
              className={styles.select}
              value={activeProject.selectedSnapshotId}
              onChange={event =>
                mutateActiveProject(project => ({
                  ...project,
                  selectedSnapshotId: event.target.value,
                }))
              }
              disabled={busy || activeProject.snapshots.length === 0}
            >
              {activeProject.snapshots.length === 0 ? <option value="">No snapshots</option> : null}
              {snapshotDisplay.map(item => (
                <option key={item.snapshot.id} value={item.snapshot.id}>
                  {snapshotOptionLabel(item)}
                </option>
              ))}
            </select>

             <button className={styles.btn} type="button" onClick={() => void handleRestoreSnapshot()} disabled={!selectedSnapshot || busy}>
              Restore
            </button>
             <button className={styles.btn} type="button" onClick={() => void handleArchiveSnapshot()} disabled={busy || !activeProject.currentPackage}>
              Archive Snapshot
            </button>
             <button className={styles.btnDanger} type="button" onClick={handleDeleteSnapshot} disabled>
               Delete Snapshot
             </button>
          </div>

          {activeAiSessionId && aiSessionVersions.length > 0 ? (
            <div className={styles.row} style={{ marginTop: 8 }}>
              <span className={styles.mono}>Box Versions:</span>
              <select
                className={styles.select}
                value={viewedAiSessionVersionId}
                onChange={event => void handleSelectAiSessionVersion(event.target.value)}
                disabled={busy}
              >
                <option value="">(View Active Head)</option>
                {aiSessionVersions.map(version => (
                  <option key={version.versionId} value={version.versionId}>
                    {version.versionId} (v{version.workspaceVersion}) {version.isActive ? '[Active]' : ''} {version.isLatest ? '[Latest]' : ''}
                  </option>
                ))}
              </select>
              {viewedAiSessionVersionId ? (
                <span className={styles.mono} style={{ color: 'var(--text-dim)' }}>
                  Viewing read-only Box version.
                </span>
              ) : null}
            </div>
          ) : null}

          <div className={styles.previewBody}>
            <SandboxPreview
              packageData={viewedAiSessionVersion?.package ?? activeProject.currentPackage}
              runtimeNonce={runtimeNonce}
              onReport={handleSandboxReport}
            />
          </div>

          <pre className={styles.mono} style={{ margin: 0, whiteSpace: 'pre-wrap' }}>
            {viewedAiSessionVersion?.package
              ? viewedAiSessionVersion.package.manifestJson
              : activeProject.currentPackage
                ? activeProject.currentPackage.manifestJson
                : 'No package loaded yet.'}
          </pre>
        </section>
      </section>

      <RequestWorkbench
        routeDecision={activeProject.lastRouteDecision}
        executionTrace={activeProject.lastExecutionTrace}
        currentEvaluator={activeProject.currentEvaluator}
        attempts={activeProject.attempts}
      />
    </main>
  );
}
