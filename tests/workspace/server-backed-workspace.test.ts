import { describe, expect, it } from 'vitest';

import { createTemplatePackage } from '@/lib/package/template';
import { mergeServerProjects } from '@/lib/workspace/storage';
import type { HydratedProjectRecord } from '@/lib/projects/types';

describe('server-backed workspace projection', () => {
  it('maps hydrated server projects into workspace state', () => {
    const pkg = createTemplatePackage('Server Project');
    const serverProjects: HydratedProjectRecord[] = [
      {
        id: 'project-1',
        ownerId: 'local-user',
        name: 'Project 1',
        currentVersion: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        versions: [
          {
            projectId: 'project-1',
            version: 1,
            source: 'generate',
            parentVersion: null,
            restoredFromVersion: null,
            localSnapshotId: null,
            evaluator: { ok: true, code: 'READY', source: 'sandbox', summary: 'ready', at: new Date().toISOString(), errors: [], logs: [] },
            status: 'passed',
            createdAt: new Date().toISOString(),
            pkg,
          },
        ],
      },
    ];

    const workspace = mergeServerProjects(serverProjects, null);
    expect(workspace.projects).toHaveLength(1);
    expect(workspace.projects[0]?.persistenceMode).toBe('server');
    expect(workspace.projects[0]?.currentPackage).toEqual(pkg);
    expect(workspace.projects[0]?.snapshots[0]?.id).toBe('v1');
  });
});
