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

  it('normalizes legacy execution traces so recovered and failed runs do not appear as direct success', () => {
    const pkg = createTemplatePackage('Recovered Project');
    const serverProjects: HydratedProjectRecord[] = [
      {
        id: 'project-legacy',
        ownerId: 'local-user',
        name: 'Legacy Project',
        currentVersion: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        versions: [
          {
            projectId: 'project-legacy',
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

    const workspace = mergeServerProjects(serverProjects, {
      version: '2.0',
      activeProjectId: 'project-legacy',
      limits: { maxProjects: 10, maxSnapshotsPerProject: 20 },
      projects: [
        {
          id: 'project-legacy',
          name: 'Legacy Project',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          persistenceMode: 'server',
          messages: [],
          currentPackage: pkg,
          currentEvaluator: null,
          snapshots: [],
          selectedSnapshotId: 'v1',
          selectedModifyBaseId: '__current__',
          selectedDebugTargetId: '__current__',
          lastMode: 'create',
          attempts: [],
          lastGreenSnapshotId: null,
          lastRouteDecision: null,
          lastExecutionTrace: {
            requestMode: 'create',
            endpoint: '/api/package/generate',
            targetId: '__current__',
            roleLabel: '生成器',
            statusMessage: 'Recovered package from workspace after transport error; re-initialize the AI session before the next turn. fetch failed',
            source: 'model',
            provider: 'openai',
            model: 'codex-app-server',
            repaired: false,
            fallbackUsed: true,
            staticCode: 'STATIC_OK',
            testsRun: [],
            filesProduced: [],
            engine: {
              requestedEngine: 'codex-app-server',
              actualEngine: 'codex-app-server',
              strategy: 'plan_then_execute',
              routeReason: 'CREATE_REQUEST',
              allowedPaths: ['indexHtml', 'gameJs', 'styleCss', 'manifestJson'],
              fallbackReason: 'workspace_recovered_after_transport_error',
              outcome: 'recovered_success',
              recovery: {
                source: 'workspace',
                reason: 'workspace_recovered_after_transport_error',
                workspaceVersion: 1,
                recoveredFromFailureCode: 'codex_turn_unexpected_error',
                recoveredFromFailureMessage: 'fetch failed',
              },
              stages: [],
              failureContext: null,
            },
            stages: [],
            failureContext: {
              checkpoint: 'transport_turn',
              reason: 'fetch_failed',
              code: 'codex_turn_unexpected_error',
              message: 'fetch failed',
              transport: null,
              session: null,
            },
            attemptSummaries: [],
          },
        },
      ],
    });

    expect(workspace.projects[0]?.lastExecutionTrace?.outcome).toBe('recovered_success');
    expect(workspace.projects[0]?.lastExecutionTrace?.recovery?.source).toBe('workspace');
  });
});
