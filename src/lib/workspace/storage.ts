import { createProject as createServerProject, listProjects, saveProjectPackage } from '@/lib/projects/client';
import { snapshotIdFromVersion } from '@/lib/projects/package-files';
import type { HydratedProjectRecord } from '@/lib/projects/types';
import type { ExecutionOutcome, RecoveryContext } from '@/lib/ai/execution-trace';
import { createTemplatePackage } from '@/lib/package/template';
import {
  createDefaultWorkspace,
  createProject,
  CURRENT_WORKSPACE_VERSION,
  DEFAULT_WORKSPACE_LIMITS,
  makeChatMessage,
} from '@/lib/workspace/state';
import type {
  GameProject,
  ProjectSnapshot,
  SnapshotStatus,
  WorkspaceState,
} from '@/lib/workspace/types';

const DB_NAME = 'game-edit-workspace-db';
const STORE_NAME = 'workspace';
const DB_VERSION = 1;
const WORKSPACE_KEY = 'workspace-v2';
const FALLBACK_LOCAL_KEY = 'game-edit-workspace-v2-fallback';
const LEGACY_ARCHIVE_KEY = 'ai-dodge-archives-v1';

function hasWindow(): boolean {
  return typeof window !== 'undefined';
}

function supportsIndexedDb(): boolean {
  return hasWindow() && typeof indexedDB !== 'undefined';
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
  });
}

function fromRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function normalizeWorkspace(input: unknown): WorkspaceState | null {
  if (!input || typeof input !== 'object') {
    return null;
  }

  const candidate = input as {
    version?: unknown;
    projects?: unknown;
    activeProjectId?: unknown;
    limits?: unknown;
  };

  if (candidate.version !== CURRENT_WORKSPACE_VERSION) {
    return null;
  }
  if (!Array.isArray(candidate.projects)) {
    return null;
  }
  if (typeof candidate.activeProjectId !== 'string') {
    return null;
  }

  const projects = candidate.projects.filter(
    project => project && typeof project === 'object' && typeof (project as { id?: unknown }).id === 'string',
  ) as GameProject[];

  if (projects.length === 0) {
    return null;
  }

  const activeExists = projects.some(project => project.id === candidate.activeProjectId);

  return {
    version: CURRENT_WORKSPACE_VERSION,
    projects,
    activeProjectId: activeExists ? candidate.activeProjectId : projects[0].id,
    limits:
      candidate.limits && typeof candidate.limits === 'object'
        ? (candidate.limits as WorkspaceState['limits'])
        : DEFAULT_WORKSPACE_LIMITS,
  };
}

function parseManifestTitle(manifestJson: string, fallback: string): string {
  try {
    const parsed = JSON.parse(manifestJson) as { title?: unknown };
    if (typeof parsed.title === 'string' && parsed.title.trim()) {
      return parsed.title.trim();
    }
  } catch {
    return fallback;
  }

  return fallback;
}

function inferStatusFromEvaluator(evaluator: GameProject['currentEvaluator'] | null): SnapshotStatus {
  if (!evaluator) {
    return 'unknown';
  }
  return evaluator.ok ? 'passed' : 'failed';
}

function inferExecutionOutcome(trace: GameProject['lastExecutionTrace']): ExecutionOutcome {
  if (!trace) {
    return 'direct_success';
  }

  if (trace.outcome) {
    return trace.outcome;
  }

  if (trace.engine?.outcome) {
    return trace.engine.outcome;
  }

  if (trace.engine?.fallbackReason === 'workspace_recovered_after_transport_error' || trace.statusMessage.toLowerCase().includes('recovered package from workspace')) {
    return 'recovered_success';
  }

  if (trace.failureContext || trace.source === 'request-error' || trace.staticCode === 'REQUEST_FAILED') {
    return 'hard_failure';
  }

  return 'direct_success';
}

function inferRecoveryContext(trace: GameProject['lastExecutionTrace']): RecoveryContext | null {
  if (!trace) {
    return null;
  }

  if (trace.recovery) {
    return trace.recovery;
  }

  if (trace.engine?.recovery) {
    return trace.engine.recovery;
  }

  if (trace.engine?.fallbackReason === 'workspace_recovered_after_transport_error' || trace.statusMessage.toLowerCase().includes('recovered package from workspace')) {
    return {
      source: 'workspace',
      reason: 'workspace_recovered_after_transport_error',
      recoveredFromFailureCode: trace.failureContext?.code ?? null,
      recoveredFromFailureMessage: trace.failureContext?.message ?? null,
    };
  }

  return null;
}

function normalizeExecutionTrace(trace: GameProject['lastExecutionTrace']): GameProject['lastExecutionTrace'] {
  if (!trace) {
    return null;
  }

  return {
    ...trace,
    outcome: inferExecutionOutcome(trace),
    recovery: inferRecoveryContext(trace),
    stages: trace.stages ?? [],
    testsRun: trace.testsRun ?? [],
    filesProduced: trace.filesProduced ?? [],
    attemptSummaries: trace.attemptSummaries ?? [],
  };
}

function toSnapshot(project: HydratedProjectRecord, version: HydratedProjectRecord['versions'][number], cachedProject?: GameProject): ProjectSnapshot {
  const snapshotId = snapshotIdFromVersion(version.version);
  const cachedSnapshot = cachedProject?.snapshots.find(item => item.id === snapshotId) ?? null;

  return {
    id: snapshotId,
    title: parseManifestTitle(version.pkg.manifestJson, `Version ${version.version}`),
    createdAt: version.createdAt,
    parentSnapshotId: version.parentVersion ? snapshotIdFromVersion(version.parentVersion) : null,
    status: version.status,
    pkg: version.pkg,
    evaluator: version.evaluator,
  };
}

export function toGameProject(project: HydratedProjectRecord, cachedProject?: GameProject): GameProject {
  const snapshots = project.versions.map(version => toSnapshot(project, version, cachedProject));
  const currentSnapshotId = project.currentVersion > 0 ? snapshotIdFromVersion(project.currentVersion) : '';
  const currentVersion = project.versions.find(version => version.version === project.currentVersion) ?? null;
  const cachedSelectionIsUsable =
    !!cachedProject?.selectedModifyBaseId &&
    (cachedProject.selectedModifyBaseId === '__current__' ||
      snapshots.some(snapshot => snapshot.id === cachedProject.selectedModifyBaseId));
  const defaultSystemMessage = makeChatMessage({
    role: 'system',
    mode: 'system',
    text: `Server-backed project ready. Current head version: ${project.currentVersion}.`,
  });

  return {
    id: project.id,
    name: project.name,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    persistenceMode: 'server',
    messages: cachedProject?.messages?.length ? cachedProject.messages : [defaultSystemMessage],
    currentPackage: cachedSelectionIsUsable && cachedProject?.currentPackage ? cachedProject.currentPackage : currentVersion?.pkg ?? null,
    currentEvaluator:
      cachedSelectionIsUsable && cachedProject?.currentEvaluator ? cachedProject.currentEvaluator : currentVersion?.evaluator ?? null,
    snapshots,
    selectedSnapshotId:
      cachedProject?.selectedSnapshotId && snapshots.some(snapshot => snapshot.id === cachedProject.selectedSnapshotId)
        ? cachedProject.selectedSnapshotId
        : currentSnapshotId,
    selectedModifyBaseId:
      cachedProject?.selectedModifyBaseId &&
      (cachedProject.selectedModifyBaseId === '__current__' ||
        snapshots.some(snapshot => snapshot.id === cachedProject.selectedModifyBaseId))
        ? cachedProject.selectedModifyBaseId
        : currentSnapshotId || '__current__',
    selectedDebugTargetId:
      cachedProject?.selectedDebugTargetId &&
      (cachedProject.selectedDebugTargetId === '__current__' ||
        snapshots.some(snapshot => snapshot.id === cachedProject.selectedDebugTargetId))
        ? cachedProject.selectedDebugTargetId
        : currentSnapshotId || '__current__',
    lastMode: cachedProject?.lastMode ?? 'create',
    attempts: cachedProject?.attempts ?? [],
    lastGreenSnapshotId:
      cachedProject?.lastGreenSnapshotId && snapshots.some(snapshot => snapshot.id === cachedProject.lastGreenSnapshotId)
        ? cachedProject.lastGreenSnapshotId
        : snapshots.find(snapshot => snapshot.status === 'passed')?.id ?? null,
    lastRouteDecision: cachedProject?.lastRouteDecision ?? null,
    lastExecutionTrace: normalizeExecutionTrace(cachedProject?.lastExecutionTrace ?? null),
  };
}

export function mergeServerProjects(serverProjects: HydratedProjectRecord[], cachedWorkspace: WorkspaceState | null): WorkspaceState {
  const cachedByProjectId = new Map((cachedWorkspace?.projects ?? []).map(project => [project.id, project]));
  const projects = serverProjects.map(project => toGameProject(project, cachedByProjectId.get(project.id)));

  return {
    version: CURRENT_WORKSPACE_VERSION,
    activeProjectId:
      cachedWorkspace?.activeProjectId && projects.some(project => project.id === cachedWorkspace.activeProjectId)
        ? cachedWorkspace.activeProjectId
        : projects[0]?.id ?? '',
    projects,
    limits: cachedWorkspace?.limits ?? DEFAULT_WORKSPACE_LIMITS,
  };
}

export function mergeServerProjectIntoWorkspace(
  workspace: WorkspaceState,
  serverProject: HydratedProjectRecord,
): WorkspaceState {
  const cachedProject = workspace.projects.find(project => project.id === serverProject.id);
  const nextProject = toGameProject(serverProject, cachedProject);
  const currentHeadSnapshotId = serverProject.currentVersion > 0 ? snapshotIdFromVersion(serverProject.currentVersion) : '';
  const cachedHeadVersion = cachedProject
    ? Math.max(...cachedProject.snapshots.map(snapshot => Number.parseInt(snapshot.id.replace(/^v/, ''), 10)).filter(Number.isFinite), 0)
    : 0;
  const shouldSelectNewHead = serverProject.currentVersion > cachedHeadVersion;
  const normalizedProject = shouldSelectNewHead
    ? {
        ...nextProject,
        selectedSnapshotId: currentHeadSnapshotId,
        selectedModifyBaseId: currentHeadSnapshotId || '__current__',
        selectedDebugTargetId: currentHeadSnapshotId || '__current__',
      }
    : nextProject;
  const existingIndex = workspace.projects.findIndex(project => project.id === serverProject.id);

  if (existingIndex === -1) {
    return {
      ...workspace,
      activeProjectId: serverProject.id,
      projects: [...workspace.projects, normalizedProject],
    };
  }

  const projects = [...workspace.projects];
  projects[existingIndex] = normalizedProject;
  return {
    ...workspace,
    projects,
    activeProjectId:
      workspace.activeProjectId && workspace.projects.some(project => project.id === workspace.activeProjectId)
        ? workspace.activeProjectId
        : serverProject.id,
  };
}

function migrateLegacyArchives(): WorkspaceState | null {
  if (!hasWindow()) {
    return null;
  }

  const raw = window.localStorage.getItem(LEGACY_ARCHIVE_KEY);
  if (!raw) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    return null;
  }

  const project = createProject({ name: 'Imported Legacy Project', mode: 'create' });
  const snapshots = parsed
    .filter(item => item && typeof item === 'object')
    .slice(0, 20)
    .map((item, index) => {
      const obj = item as { title?: unknown; createdAt?: unknown; dsl?: unknown };
      const title = typeof obj.title === 'string' && obj.title.trim() ? obj.title.trim() : `Legacy ${index + 1}`;
      const createdAt =
        typeof obj.createdAt === 'string' && obj.createdAt.trim() ? obj.createdAt : new Date().toISOString();

      const pkg = createTemplatePackage(title);
      pkg.manifestJson = JSON.stringify(
        {
          title,
          summary: 'Imported from legacy dodge-survival archive. This package is a placeholder scaffold.',
          capabilities: [],
          notes: `Legacy DSL payload attached in message history (entry ${index + 1}).`,
        },
        null,
        2,
      );

      const legacyDsl = (() => {
        try {
          return JSON.stringify(obj.dsl ?? null, null, 2);
        } catch {
          return 'Unable to stringify legacy DSL payload.';
        }
      })();

      return {
        id: `legacy-${index + 1}-${Date.now().toString(36)}`,
        title,
        createdAt,
        parentSnapshotId: null,
        status: 'unknown' as const,
        pkg,
        evaluator: null,
        legacyDsl,
      };
    });

  const messages = snapshots.map(snapshot => ({
    id: `legacy-msg-${snapshot.id}`,
    role: 'system' as const,
    mode: 'system' as const,
    text: `Imported legacy archive "${snapshot.title}". Legacy DSL payload:\n${snapshot.legacyDsl}`,
    createdAt: snapshot.createdAt,
  }));

  const cleanSnapshots = snapshots.map(({ legacyDsl: _legacyDsl, ...snapshot }) => snapshot);

  return {
    ...createDefaultWorkspace('Imported Legacy Project'),
    activeProjectId: project.id,
    projects: [
      {
        ...project,
        messages,
        snapshots: cleanSnapshots,
        selectedSnapshotId: cleanSnapshots[0]?.id ?? '',
        selectedModifyBaseId: cleanSnapshots[0]?.id ?? '__current__',
        selectedDebugTargetId: cleanSnapshots[0]?.id ?? '__current__',
      },
    ],
  };
}

async function loadFromIndexedDb(): Promise<WorkspaceState | null> {
  if (!supportsIndexedDb()) {
    return null;
  }

  const db = await openDb();
  try {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const raw = await fromRequest(store.get(WORKSPACE_KEY));
    return normalizeWorkspace(raw);
  } finally {
    db.close();
  }
}

async function saveToIndexedDb(workspace: WorkspaceState): Promise<void> {
  if (!supportsIndexedDb()) {
    return;
  }
  const db = await openDb();
  try {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    await fromRequest(store.put(workspace, WORKSPACE_KEY));
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    });
  } finally {
    db.close();
  }
}

function loadFromLocalFallback(): WorkspaceState | null {
  if (!hasWindow()) {
    return null;
  }

  const raw = window.localStorage.getItem(FALLBACK_LOCAL_KEY);
  if (!raw) {
    return null;
  }

  try {
    return normalizeWorkspace(JSON.parse(raw));
  } catch {
    return null;
  }
}

function saveToLocalFallback(workspace: WorkspaceState): void {
  if (!hasWindow()) {
    return;
  }

  window.localStorage.setItem(FALLBACK_LOCAL_KEY, JSON.stringify(workspace));
}

async function importCachedWorkspaceToServer(workspace: WorkspaceState): Promise<WorkspaceState> {
  const importedProjects: HydratedProjectRecord[] = [];

  for (const project of workspace.projects) {
    const created = await createServerProject(project.name);
    let latest = created;
    const remainingSnapshots = [...project.snapshots].sort(
      (left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime(),
    );
    const importedSnapshotVersions = new Map<string, number>();

    while (remainingSnapshots.length > 0) {
      let progressed = false;

      for (let index = 0; index < remainingSnapshots.length; index += 1) {
        const snapshot = remainingSnapshots[index];
        const parentVersion = snapshot.parentSnapshotId
          ? importedSnapshotVersions.get(snapshot.parentSnapshotId)
          : null;

        if (snapshot.parentSnapshotId && typeof parentVersion !== 'number') {
          continue;
        }

        latest = await saveProjectPackage({
          projectId: latest.id,
          pkg: snapshot.pkg,
          source: 'import',
          parentVersion: parentVersion ?? null,
          localSnapshotId: snapshot.id,
          evaluator: snapshot.evaluator,
        });
        importedSnapshotVersions.set(snapshot.id, latest.currentVersion);
        remainingSnapshots.splice(index, 1);
        progressed = true;
        break;
      }

      if (!progressed) {
        throw new Error(`Unable to preserve snapshot lineage while importing project ${project.name}.`);
      }
    }

    if (project.currentPackage && !project.snapshots.some(snapshot => snapshot.pkg.manifestJson === project.currentPackage?.manifestJson)) {
      latest = await saveProjectPackage({
        projectId: latest.id,
        pkg: project.currentPackage,
        source: 'import',
        parentVersion: latest.currentVersion || null,
        evaluator: project.currentEvaluator,
      });
    }

    importedProjects.push(latest);
  }

  return mergeServerProjects(importedProjects, workspace);
}

export async function loadWorkspaceState(): Promise<WorkspaceState> {
  const indexed = await loadFromIndexedDb().catch(() => null);
  const cachedWorkspace = indexed ?? loadFromLocalFallback();

  try {
    let projects = await listProjects();
    if (projects.length === 0) {
      if (cachedWorkspace?.projects.length) {
        return await importCachedWorkspaceToServer(cachedWorkspace);
      }

      const created = await createServerProject('Project 1');
      projects = [created];
    }

    return mergeServerProjects(projects, cachedWorkspace);
  } catch {
    if (cachedWorkspace) {
      return cachedWorkspace;
    }

    const migrated = migrateLegacyArchives();
    if (migrated) {
      return migrated;
    }

    return createDefaultWorkspace('Project 1');
  }
}

export async function saveWorkspaceState(workspace: WorkspaceState): Promise<void> {
  try {
    await saveToIndexedDb(workspace);
  } catch {
    saveToLocalFallback(workspace);
  }
}
