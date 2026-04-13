'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

import type { ModelAttempt } from '@/lib/ai/types';
import type { EvaluatorResult } from '@/lib/evaluator/types';
import type { GamePackageManifest, GeneratedGamePackage } from '@/lib/package/contracts';
import {
  createProject as createServerProject,
  deleteProject as deleteServerProject,
  restoreProjectVersion,
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
import styles from '@/components/CodegenAppShell.module.css';

type PackageApiSuccess = {
  ok: true;
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
  project: import('@/lib/projects/types').HydratedProjectRecord | null;
  persistenceWarning?: string | null;
};

type PackageApiFailure = {
  ok: false;
  error: string;
};

type ApiResponse = PackageApiSuccess | PackageApiFailure;

type PhaseState = 'idle' | 'running' | 'passed' | 'failed' | 'repairing';

type PhaseRow = {
  id: 'generator' | 'tester' | 'checker';
  label: string;
  state: PhaseState;
  detail: string;
  elapsedMs: number;
};

const MODES: Array<{ id: ActionMode; label: string }> = [
  { id: 'create', label: '创建游戏' },
  { id: 'modify', label: '改游戏' },
  { id: 'debug', label: '修错误' },
];

function defaultPhases(): PhaseRow[] {
  return [
    { id: 'generator', label: '架构师/工人/修理工', state: 'idle', detail: '等待任务', elapsedMs: 0 },
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
      return '架构师';
    case 'worker':
      return '工人';
    case 'fixer':
      return '修理工';
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
  const [runtimeNonce, setRuntimeNonce] = useState(0);
  const [phases, setPhases] = useState<PhaseRow[]>(defaultPhases);

  const phaseStartedRef = useRef<Record<'generator' | 'tester' | 'checker', number>>({
    generator: 0,
    tester: 0,
    checker: 0,
  });
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
      if (cancelled) {
        return;
      }
      setWorkspace(loaded);
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
    if (!workspaceReady || !workspace) {
      return;
    }
    saveWorkspaceState(workspace).catch(() => {
      // ignore persistence failures in UI path
    });
  }, [workspace, workspaceReady]);

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
    const targetVersion = versionFromSnapshotId(selectedSnapshot.id);
    if (!targetVersion) {
      window.alert('Selected snapshot does not map to a server version.');
      return;
    }

    setBusy(true);
    try {
      const restoredProject = await restoreProjectVersion(activeProject.id, targetVersion);
      setWorkspace(prev => {
        if (!prev) {
          return prev;
        }
        const merged = mergeServerProjectIntoWorkspace(prev, restoredProject);
        return updateProject(merged, activeProject.id, project => ({
          ...project,
          messages: [
            ...project.messages,
            makeChatMessage({
              role: 'system',
              mode: 'system',
              text: `Restored version ${targetVersion} into a new head version.`,
            }),
          ],
        }));
      });
      setRuntimeNonce(prev => prev + 1);
    } catch (error) {
      if (isServerBackedProject(activeProject)) {
        window.alert(error instanceof Error ? error.message : String(error));
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
        setRuntimeNonce(prev => prev + 1);
      }
    } finally {
      setBusy(false);
    }
  }

  function handleDeleteSnapshot(): void {
    if (!activeProject || !selectedSnapshot) {
      return;
    }
    window.alert('Server-backed versions are immutable in this rehearsal. Use restore to fork a new head version instead.');
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

    let endpoint = '/api/package/generate';
    let payload: Record<string, unknown> = {};
    let routeDecision: RouteDecision;

    if (mode === 'create') {
      routeDecision = decideRoute({
        mode,
        requestText: text,
        targetId: '__current__',
        targetPackage: activeProject.currentPackage,
      });
      endpoint = '/api/package/generate';
      payload = {
        prompt: text,
        projectId: activeProject.id,
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
      routeDecision = decideRoute({
        mode,
        requestText: text,
        targetId,
        targetPackage,
      });
      endpoint = '/api/package/modify';
      payload = {
        instruction: text,
        projectId: activeProject.id,
        targetId,
        currentPackage: targetPackage,
        lastKnownGoodPackage: activeProject.lastGreenSnapshotId
          ? activeProject.snapshots.find(snapshot => snapshot.id === activeProject.lastGreenSnapshotId)?.pkg
          : null,
        routeMode: routeDecision.routeMode,
        routeReason: routeDecision.primaryReasonCode,
      };
    } else {
      const targetId = effectiveDebugTargetId || '__current__';
      const targetPackage = resolvePackageFromTarget(activeProject, targetId);
      if (!targetPackage) {
        window.alert('No debug target selected.');
        return;
      }
      routeDecision = decideRoute({
        mode,
        requestText: text,
        targetId,
        targetPackage,
      });
      endpoint = '/api/package/debug';
      payload = {
        errorReport: text,
        projectId: activeProject.id,
        targetId,
        currentPackage: targetPackage,
        evaluatorSummary: activeProject.currentEvaluator?.summary ?? '',
        lastKnownGoodPackage: activeProject.lastGreenSnapshotId
          ? activeProject.snapshots.find(snapshot => snapshot.id === activeProject.lastGreenSnapshotId)?.pkg
          : null,
        routeMode: routeDecision.routeMode,
        routeReason: routeDecision.primaryReasonCode,
      };
    }

    const generatorLabel = labelForAgent(routeDecision.agent);

    setBusy(true);
    phaseStartedRef.current.generator = nowMs();
    setPhases([
      {
        id: 'generator',
        label: generatorLabel,
        state: mode === 'debug' ? 'repairing' : 'running',
        detail: `${routeDecision.summary} ${mode === 'debug' ? '正在修复错误...' : mode === 'modify' ? '正在应用修改...' : '正在生成项目包...'}`,
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
        lastRouteDecision: routeDecision,
      }),
    );

    const response = await postJson(endpoint, payload).catch(
      (error): PackageApiFailure => ({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }),
    );

    if (!response.ok) {
      const elapsed = Math.max(0, nowMs() - phaseStartedRef.current.generator);
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
              text: `Request failed: ${response.error}`,
            }),
          ]),
          lastExecutionTrace: {
            requestMode: mode,
            endpoint,
            targetId: routeDecision.targetId,
            roleLabel: generatorLabel,
            statusMessage: response.error,
            source: 'request-error',
            provider: '-',
            model: '-',
            repaired: false,
            fallbackUsed: false,
          staticCode: 'REQUEST_FAILED',
          testsRun: [],
          filesProduced: [],
          attemptSummaries: [],
        } as ExecutionTrace,
      }),
      );
      setBusy(false);
      return;
    }

    const generated = response.package;
    const latestAttempt = response.attempts.at(-1);
    const fallbackReason = response.fallbackUsed
      ? latestAttempt?.outcome === 'timeout'
        ? `fallback reason: model timeout (${latestAttempt.durationMs || 60000}ms limit)`
        : latestAttempt?.errorMessage
          ? `fallback reason: ${latestAttempt.errorMessage}`
          : 'fallback reason: model request failed'
      : null;
    const summary = [
      response.statusMessage,
      `source: ${response.source}`,
      `provider/model: ${response.provider} / ${response.model}`,
      `repaired: ${String(response.repaired)} | fallback: ${String(response.fallbackUsed)}`,
      `static: ${response.staticEvaluation.code}`,
      response.persistenceWarning ? `persistence: ${response.persistenceWarning}` : null,
      fallbackReason,
    ].join('\n');

    const elapsed = Math.max(0, nowMs() - phaseStartedRef.current.generator);
    phaseStartedRef.current.tester = nowMs();
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
          attempts: response.attempts,
          lastMode: mode,
          lastRouteDecision: routeDecision,
          lastExecutionTrace: {
            requestMode: mode,
            endpoint,
            targetId: routeDecision.targetId,
            roleLabel: generatorLabel,
            statusMessage: response.statusMessage,
            source: response.source,
            provider: response.provider,
            model: response.model,
            repaired: response.repaired,
            fallbackUsed: response.fallbackUsed,
            staticCode: response.staticEvaluation.code,
            testsRun: ['static-evaluator', 'sandbox-ready', 'sandbox-runTests'],
            filesProduced: ['indexHtml', 'gameJs', 'styleCss', 'manifestJson'],
            attemptSummaries: toAttemptSummaries(response.attempts),
          },
        };
      });

      if (response.project) {
        return mergeServerProjectIntoWorkspace(locallyUpdated, response.project);
      }

      if (isServerBackedProject(activeProject)) {
        return updateProject(prev, activeProject.id, project => ({
          ...project,
          messages: [
            ...project.messages,
            makeChatMessage({
              role: 'system',
              mode: 'system',
              text: `Server persistence failed; the generated package was not adopted as the canonical head. ${response.persistenceWarning ?? ''}`.trim(),
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

    const elapsed = Math.max(0, nowMs() - phaseStartedRef.current.tester);
    setPhases([
      phases[0] ?? {
        id: 'generator',
        label: '架构师/工人/修理工',
        state: 'idle',
        detail: '等待任务',
        elapsedMs: 0,
      },
      {
        id: 'tester',
        label: '测试者',
        state: result.ok ? 'passed' : 'failed',
        detail: result.summary,
        elapsedMs: elapsed,
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
        elapsedMs: elapsed,
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
          }
        : project.lastExecutionTrace,
    }));

    if (isServerBackedProject(activeProject)) {
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
  const selectedPreviewLabel = parseManifestTitle(activeProject.currentPackage);

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
                  (mode === 'debug' && requireDebugTargetChoice)
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
          </div>
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

          <div className={styles.previewBody}>
            <SandboxPreview
              packageData={activeProject.currentPackage}
              runtimeNonce={runtimeNonce}
              onReport={handleSandboxReport}
            />
          </div>

          <pre className={styles.mono} style={{ margin: 0, whiteSpace: 'pre-wrap' }}>
            {activeProject.currentPackage
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
