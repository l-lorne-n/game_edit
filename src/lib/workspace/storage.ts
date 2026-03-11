import { createTemplatePackage } from '@/lib/package/template';
import {
  appendMessages,
  createDefaultWorkspace,
  createProject,
  CURRENT_WORKSPACE_VERSION,
} from '@/lib/workspace/state';
import type { GameProject, WorkspaceState } from '@/lib/workspace/types';

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
        : {
            maxProjects: 25,
            maxSnapshotsPerProject: 20,
          },
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
          editable: ['title', 'summary', 'game behavior'],
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

  const messages = snapshots.flatMap(snapshot => [
    {
      id: `legacy-msg-${snapshot.id}`,
      role: 'system' as const,
      mode: 'system' as const,
      text: `Imported legacy archive "${snapshot.title}". Legacy DSL payload:\n${snapshot.legacyDsl}`,
      createdAt: snapshot.createdAt,
    },
  ]);

  const cleanSnapshots = snapshots.map(({ legacyDsl: _legacyDsl, ...snapshot }) => snapshot);

  const importedProject: GameProject = {
    ...appendMessages(project, messages),
    snapshots: cleanSnapshots,
    selectedSnapshotId: cleanSnapshots[0]?.id ?? '',
    selectedModifyBaseId: cleanSnapshots[0]?.id ?? '__current__',
    selectedDebugTargetId: cleanSnapshots[0]?.id ?? '__current__',
  };

  return {
    ...createDefaultWorkspace('Imported Legacy Project'),
    activeProjectId: importedProject.id,
    projects: [importedProject],
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

export async function loadWorkspaceState(): Promise<WorkspaceState> {
  const indexed = await loadFromIndexedDb().catch(() => null);
  if (indexed) {
    return indexed;
  }

  const fallback = loadFromLocalFallback();
  if (fallback) {
    return fallback;
  }

  const migrated = migrateLegacyArchives();
  if (migrated) {
    return migrated;
  }

  return createDefaultWorkspace('Project 1');
}

export async function saveWorkspaceState(workspace: WorkspaceState): Promise<void> {
  try {
    await saveToIndexedDb(workspace);
  } catch {
    saveToLocalFallback(workspace);
  }
}
