import type { EvaluatorResult } from '@/lib/evaluator/types';
import type { GeneratedGamePackage } from '@/lib/package/contracts';
import {
  type ActionMode,
  type ChatMessage,
  type GameProject,
  type ProjectSnapshot,
  type SnapshotDisplayItem,
  type WorkspaceLimits,
  type WorkspaceState,
} from '@/lib/workspace/types';

export const DEFAULT_WORKSPACE_LIMITS: WorkspaceLimits = {
  maxProjects: 25,
  maxSnapshotsPerProject: 20,
};

export const CURRENT_WORKSPACE_VERSION: WorkspaceState['version'] = '2.0';

type SnapshotResult =
  | {
      ok: true;
      project: GameProject;
      snapshot: ProjectSnapshot;
    }
  | {
      ok: false;
      project: GameProject;
      error: 'SNAPSHOT_LIMIT_REACHED' | 'MISSING_CURRENT_PACKAGE';
    };

type ProjectResult =
  | {
      ok: true;
      workspace: WorkspaceState;
      project: GameProject;
    }
  | {
      ok: false;
      workspace: WorkspaceState;
      error: 'PROJECT_LIMIT_REACHED';
    };

function nowIso(): string {
  return new Date().toISOString();
}

function uid(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}-${Date.now().toString(36)}`;
}

export function makeChatMessage(input: {
  role: ChatMessage['role'];
  mode: ChatMessage['mode'];
  text: string;
}): ChatMessage {
  return {
    id: uid('msg'),
    role: input.role,
    mode: input.mode,
    text: input.text,
    createdAt: nowIso(),
  };
}

export function createProject(input?: { name?: string; mode?: ActionMode }): GameProject {
  const createdAt = nowIso();
  return {
    id: uid('proj'),
    name: input?.name?.trim() || 'New Game Project',
    createdAt,
    updatedAt: createdAt,
    persistenceMode: 'local',
    messages: [
      makeChatMessage({
        role: 'system',
        mode: 'system',
        text: 'Project created. Start by describing the mini-game you want to build.',
      }),
    ],
    currentPackage: null,
    currentEvaluator: null,
    snapshots: [],
    selectedSnapshotId: '',
    selectedModifyBaseId: '__current__',
    selectedDebugTargetId: '__current__',
    lastMode: input?.mode ?? 'create',
    attempts: [],
    lastGreenSnapshotId: null,
    lastRouteDecision: null,
    lastExecutionTrace: null,
  };
}

export function createDefaultWorkspace(name = 'Project 1'): WorkspaceState {
  const project = createProject({ name, mode: 'create' });
  return {
    version: CURRENT_WORKSPACE_VERSION,
    activeProjectId: project.id,
    projects: [project],
    limits: DEFAULT_WORKSPACE_LIMITS,
  };
}

export function getActiveProject(workspace: WorkspaceState): GameProject | null {
  return workspace.projects.find(project => project.id === workspace.activeProjectId) ?? null;
}

export function updateProject(
  workspace: WorkspaceState,
  projectId: string,
  updater: (project: GameProject) => GameProject,
): WorkspaceState {
  return {
    ...workspace,
    projects: workspace.projects.map(project => {
      if (project.id !== projectId) {
        return project;
      }
      const next = updater(project);
      return {
        ...next,
        updatedAt: nowIso(),
      };
    }),
  };
}

export function addProject(workspace: WorkspaceState, name: string): ProjectResult {
  if (workspace.projects.length >= workspace.limits.maxProjects) {
    return {
      ok: false,
      workspace,
      error: 'PROJECT_LIMIT_REACHED',
    };
  }

  const project = createProject({ name, mode: 'create' });
  return {
    ok: true,
    project,
    workspace: {
      ...workspace,
      activeProjectId: project.id,
      projects: [...workspace.projects, project],
    },
  };
}

export function deleteProject(workspace: WorkspaceState, projectId: string): WorkspaceState {
  const remaining = workspace.projects.filter(project => project.id !== projectId);
  if (remaining.length === 0) {
    return createDefaultWorkspace('Project 1');
  }

  const activeExists = remaining.some(project => project.id === workspace.activeProjectId);
  return {
    ...workspace,
    activeProjectId: activeExists ? workspace.activeProjectId : remaining[0].id,
    projects: remaining,
  };
}

export function appendMessages(
  project: GameProject,
  messages: ChatMessage[],
): GameProject {
  return {
    ...project,
    messages: [...project.messages, ...messages],
  };
}

export function snapshotDescendantIds(snapshots: ProjectSnapshot[], snapshotId: string): string[] {
  const children = new Map<string, ProjectSnapshot[]>();
  for (const snapshot of snapshots) {
    const key = snapshot.parentSnapshotId ?? '__root__';
    const list = children.get(key) ?? [];
    list.push(snapshot);
    children.set(key, list);
  }

  const descendants: string[] = [];
  const queue = [...(children.get(snapshotId) ?? [])];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      continue;
    }
    descendants.push(current.id);
    for (const child of children.get(current.id) ?? []) {
      queue.push(child);
    }
  }

  return descendants;
}

export function removeSnapshotSubtree(project: GameProject, snapshotId: string): GameProject {
  const descendants = snapshotDescendantIds(project.snapshots, snapshotId);
  const removeSet = new Set([snapshotId, ...descendants]);

  const snapshots = project.snapshots.filter(snapshot => !removeSet.has(snapshot.id));
  const selectedSnapshotId =
    project.selectedSnapshotId && removeSet.has(project.selectedSnapshotId)
      ? snapshots[0]?.id ?? ''
      : project.selectedSnapshotId;

  return {
    ...project,
    snapshots,
    selectedSnapshotId,
    selectedModifyBaseId:
      project.selectedModifyBaseId !== '__current__' && removeSet.has(project.selectedModifyBaseId)
        ? '__current__'
        : project.selectedModifyBaseId,
    selectedDebugTargetId:
      project.selectedDebugTargetId !== '__current__' && removeSet.has(project.selectedDebugTargetId)
        ? '__current__'
        : project.selectedDebugTargetId,
    lastGreenSnapshotId:
      project.lastGreenSnapshotId && removeSet.has(project.lastGreenSnapshotId)
        ? null
        : project.lastGreenSnapshotId,
  };
}

function inferSnapshotStatus(result: EvaluatorResult | null): ProjectSnapshot['status'] {
  if (!result) {
    return 'unknown';
  }
  return result.ok ? 'passed' : 'failed';
}

export function archiveCurrentPackage(project: GameProject, input?: { parentSnapshotId?: string | null }): SnapshotResult {
  if (!project.currentPackage) {
    return {
      ok: false,
      project,
      error: 'MISSING_CURRENT_PACKAGE',
    };
  }

  if (project.snapshots.length >= DEFAULT_WORKSPACE_LIMITS.maxSnapshotsPerProject) {
    return {
      ok: false,
      project,
      error: 'SNAPSHOT_LIMIT_REACHED',
    };
  }

  let title = 'Snapshot';
  try {
    const manifest = JSON.parse(project.currentPackage.manifestJson) as { title?: string };
    if (typeof manifest.title === 'string' && manifest.title.trim()) {
      title = manifest.title.trim().slice(0, 80);
    }
  } catch {
    title = 'Snapshot';
  }

  const createdAt = nowIso();
  const snapshot: ProjectSnapshot = {
    id: uid('snap'),
    title,
    createdAt,
    parentSnapshotId: input?.parentSnapshotId ?? null,
    status: inferSnapshotStatus(project.currentEvaluator),
    pkg: project.currentPackage,
    evaluator: project.currentEvaluator,
  };

  const next: GameProject = {
    ...project,
    snapshots: [snapshot, ...project.snapshots],
    selectedSnapshotId: snapshot.id,
    lastGreenSnapshotId:
      snapshot.status === 'passed' ? snapshot.id : project.lastGreenSnapshotId,
  };

  return {
    ok: true,
    project: next,
    snapshot,
  };
}

function validParent(byId: Map<string, ProjectSnapshot>, snapshot: ProjectSnapshot): string | null {
  if (!snapshot.parentSnapshotId || snapshot.parentSnapshotId === snapshot.id) {
    return null;
  }
  return byId.has(snapshot.parentSnapshotId) ? snapshot.parentSnapshotId : null;
}

export function buildSnapshotDisplay(snapshots: ProjectSnapshot[]): SnapshotDisplayItem[] {
  const byId = new Map(snapshots.map(snapshot => [snapshot.id, snapshot]));
  const children = new Map<string | null, ProjectSnapshot[]>();

  for (const snapshot of snapshots) {
    const key = validParent(byId, snapshot);
    const list = children.get(key) ?? [];
    list.push(snapshot);
    children.set(key, list);
  }

  const byTime = (a: ProjectSnapshot, b: ProjectSnapshot) =>
    new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();

  for (const [key, list] of children.entries()) {
    children.set(key, [...list].sort(byTime));
  }

  const items: SnapshotDisplayItem[] = [];
  const visited = new Set<string>();

  const walk = (snapshot: ProjectSnapshot, depth: number): void => {
    if (visited.has(snapshot.id)) {
      return;
    }
    visited.add(snapshot.id);
    const parentId = validParent(byId, snapshot);
    items.push({
      snapshot,
      depth,
      parentTitle: parentId ? byId.get(parentId)?.title ?? null : null,
    });

    for (const child of children.get(snapshot.id) ?? []) {
      walk(child, depth + 1);
    }
  };

  for (const root of children.get(null) ?? []) {
    walk(root, 0);
  }

  const remaining = snapshots.filter(snapshot => !visited.has(snapshot.id)).sort(byTime);
  for (const snapshot of remaining) {
    walk(snapshot, 0);
  }

  return items;
}

export function resolvePackageFromTarget(project: GameProject, targetId: string): GeneratedGamePackage | null {
  if (targetId === '__current__') {
    return project.currentPackage;
  }
  return project.snapshots.find(snapshot => snapshot.id === targetId)?.pkg ?? null;
}
