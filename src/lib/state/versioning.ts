import { parseSchemaOnly } from '@/lib/game/validate';
import type { GameDsl } from '@/lib/game/dsl';
import type { ArchivedVersion } from '@/lib/state/session';

export const ARCHIVE_STORAGE_KEY = 'ai-dodge-archives-v1';
const MAX_ARCHIVES = 10;

export type ArchiveDisplayItem = {
  entry: ArchivedVersion;
  depth: number;
  parentTitle: string | null;
};

export function dslHash(dsl: GameDsl): string {
  const json = JSON.stringify(dsl);
  let hash = 2166136261;
  for (let i = 0; i < json.length; i += 1) {
    hash ^= json.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

export function makeArchiveEntry(
  dsl: GameDsl,
  source: 'live' | 'staged',
  parentArchiveId: string | null,
): ArchivedVersion {
  const stamp = new Date().toISOString();
  return {
    id: `${stamp}-${dslHash(dsl)}`,
    title: dsl.meta.title,
    createdAt: stamp,
    source,
    parentArchiveId,
    dsl,
  };
}

export function pushArchive(entries: ArchivedVersion[], entry: ArchivedVersion): ArchivedVersion[] {
  const duplicate = entries.some(existing => dslHash(existing.dsl) === dslHash(entry.dsl));
  if (duplicate) {
    return entries;
  }

  return [entry, ...entries].slice(0, MAX_ARCHIVES);
}

export function removeArchiveById(entries: ArchivedVersion[], id: string): ArchivedVersion[] {
  return entries.filter(entry => entry.id !== id);
}

function validParent(entriesById: Map<string, ArchivedVersion>, entry: ArchivedVersion): string | null {
  if (!entry.parentArchiveId || entry.parentArchiveId === entry.id) {
    return null;
  }
  return entriesById.has(entry.parentArchiveId) ? entry.parentArchiveId : null;
}

function childrenMap(entries: ArchivedVersion[]): Map<string | null, ArchivedVersion[]> {
  const byId = new Map(entries.map(entry => [entry.id, entry]));
  const map = new Map<string | null, ArchivedVersion[]>();
  for (const entry of entries) {
    const parentId = validParent(byId, entry);
    const list = map.get(parentId) ?? [];
    list.push(entry);
    map.set(parentId, list);
  }

  const byTimeDesc = (a: ArchivedVersion, b: ArchivedVersion) =>
    new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();

  for (const [parentId, list] of map.entries()) {
    map.set(parentId, [...list].sort(byTimeDesc));
  }

  return map;
}

export function archiveDescendantIds(entries: ArchivedVersion[], id: string): string[] {
  const map = childrenMap(entries);
  const descendants: string[] = [];
  const queue = [...(map.get(id) ?? [])];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      continue;
    }
    descendants.push(current.id);
    for (const child of map.get(current.id) ?? []) {
      queue.push(child);
    }
  }

  return descendants;
}

export function removeArchiveSubtree(
  entries: ArchivedVersion[],
  rootId: string,
): { entries: ArchivedVersion[]; removedIds: string[] } {
  const descendants = archiveDescendantIds(entries, rootId);
  const removedIds = [rootId, ...descendants];
  const removedSet = new Set(removedIds);
  return {
    entries: entries.filter(entry => !removedSet.has(entry.id)),
    removedIds,
  };
}

export function buildArchiveDisplay(entries: ArchivedVersion[]): ArchiveDisplayItem[] {
  const byId = new Map(entries.map(entry => [entry.id, entry]));
  const map = childrenMap(entries);
  const items: ArchiveDisplayItem[] = [];
  const visited = new Set<string>();

  const walk = (entry: ArchivedVersion, depth: number): void => {
    if (visited.has(entry.id)) {
      return;
    }
    visited.add(entry.id);
    const parentId = validParent(byId, entry);
    items.push({
      entry,
      depth,
      parentTitle: parentId ? byId.get(parentId)?.title ?? null : null,
    });

    for (const child of map.get(entry.id) ?? []) {
      walk(child, depth + 1);
    }
  };

  for (const root of map.get(null) ?? []) {
    walk(root, 0);
  }

  const remaining = entries
    .filter(entry => !visited.has(entry.id))
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  for (const entry of remaining) {
    walk(entry, 0);
  }

  return items;
}

export function modifyBase(staged: GameDsl | null, live: GameDsl | null): GameDsl | null {
  return staged ?? live;
}

export function sanitizeArchiveEntries(input: unknown): ArchivedVersion[] {
  if (!Array.isArray(input)) {
    return [];
  }

  const entries: ArchivedVersion[] = [];
  for (const item of input) {
    if (!item || typeof item !== 'object') {
      continue;
    }

    const obj = item as {
      id?: unknown;
      title?: unknown;
      createdAt?: unknown;
      source?: unknown;
      parentArchiveId?: unknown;
      dsl?: unknown;
    };

    const parsedDsl = parseSchemaOnly(obj.dsl);
    if (!parsedDsl.ok) {
      continue;
    }

    const source = obj.source === 'staged' ? 'staged' : 'live';
    const createdAt = typeof obj.createdAt === 'string' ? obj.createdAt : new Date().toISOString();
    const title =
      typeof obj.title === 'string' && obj.title.trim().length > 0
        ? obj.title
        : parsedDsl.dsl.meta.title;
    const id =
      typeof obj.id === 'string' && obj.id.trim().length > 0
        ? obj.id
        : `${createdAt}-${dslHash(parsedDsl.dsl)}`;
    const parentArchiveId =
      typeof obj.parentArchiveId === 'string' && obj.parentArchiveId.trim().length > 0
        ? obj.parentArchiveId
        : null;

    entries.push({
      id,
      title,
      createdAt,
      source,
      parentArchiveId,
      dsl: parsedDsl.dsl,
    });
  }

  const sliced = entries.slice(0, MAX_ARCHIVES);
  const ids = new Set(sliced.map(entry => entry.id));
  return sliced.map(entry => ({
    ...entry,
    parentArchiveId:
      entry.parentArchiveId && entry.parentArchiveId !== entry.id && ids.has(entry.parentArchiveId)
        ? entry.parentArchiveId
        : null,
  }));
}
