import { describe, expect, it } from 'vitest';

import basicDodge from '@/lib/game/fixtures/basic-dodge.json';
import {
  archiveDescendantIds,
  buildArchiveDisplay,
  dslHash,
  makeArchiveEntry,
  modifyBase,
  pushArchive,
  removeArchiveSubtree,
  sanitizeArchiveEntries,
} from '@/lib/state/versioning';
import { parseSchemaOnly } from '@/lib/game/validate';

describe('versioned preview helpers', () => {
  it('prefers staged dsl as modify base', () => {
    const parsed = parseSchemaOnly(basicDodge);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }

    const live = parsed.dsl;
    const staged = {
      ...parsed.dsl,
      meta: {
        ...parsed.dsl.meta,
        title: 'Staged Variant',
      },
    };

    const base = modifyBase(staged, live);
    expect(base?.meta.title).toBe('Staged Variant');
  });

  it('dedupes archives by dsl content hash', () => {
    const parsed = parseSchemaOnly(basicDodge);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }

    const entryA = makeArchiveEntry(parsed.dsl, 'live', null);
    const entryB = makeArchiveEntry(parsed.dsl, 'live', null);

    const archives = pushArchive(pushArchive([], entryA), entryB);
    expect(archives.length).toBe(1);
    expect(dslHash(archives[0].dsl)).toBe(dslHash(parsed.dsl));
  });

  it('removes archive subtree by root id', () => {
    const parsed = parseSchemaOnly(basicDodge);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }

    const entryA = makeArchiveEntry(parsed.dsl, 'live', null);
    const entryB = makeArchiveEntry(
      {
        ...parsed.dsl,
        meta: {
          ...parsed.dsl.meta,
          title: 'Variant B',
        },
      },
      'live',
      entryA.id,
    );
    const entries = [entryA, entryB];

    const descendants = archiveDescendantIds(entries, entryA.id);
    expect(descendants).toEqual([entryB.id]);

    const result = removeArchiveSubtree(entries, entryA.id);
    expect(result.entries).toHaveLength(0);
    expect(result.removedIds).toEqual([entryA.id, entryB.id]);
  });

  it('builds archive display with derived depth', () => {
    const parsed = parseSchemaOnly(basicDodge);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }

    const parent = makeArchiveEntry(parsed.dsl, 'live', null);
    const child = makeArchiveEntry(
      {
        ...parsed.dsl,
        meta: {
          ...parsed.dsl.meta,
          title: 'Child',
        },
      },
      'live',
      parent.id,
    );

    const display = buildArchiveDisplay([parent, child]);
    expect(display[0].entry.id).toBe(parent.id);
    expect(display[0].depth).toBe(0);
    expect(display[1].entry.id).toBe(child.id);
    expect(display[1].depth).toBe(1);
    expect(display[1].parentTitle).toBe(parent.title);
  });

  it('sanitizes archive payloads and removes invalid dsl entries', () => {
    const parsed = parseSchemaOnly(basicDodge);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }

    const raw = [
      {
        id: 'ok',
        title: 'good',
        source: 'live',
        createdAt: '2026-03-10T00:00:00.000Z',
        dsl: parsed.dsl,
      },
      {
        id: 'bad',
        title: 'bad',
        source: 'live',
        createdAt: '2026-03-10T00:00:00.000Z',
        dsl: { version: 'broken' },
      },
    ];

    const sanitized = sanitizeArchiveEntries(raw);
    expect(sanitized.length).toBe(1);
    expect(sanitized[0].id).toBe('ok');
  });
});
