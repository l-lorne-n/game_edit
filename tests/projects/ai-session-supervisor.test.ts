import { describe, expect, it } from 'vitest';

import { getAiSessionSupervisor, resetAiSessionSupervisor } from '@/lib/ai-sessions/supervisor';
import type { AiSessionRecord } from '@/lib/ai-sessions/types';

function createSession(overrides: Partial<AiSessionRecord> = {}): AiSessionRecord {
  const now = new Date().toISOString();
  return {
    id: 'sess-1',
    projectId: 'project-1',
    ownerId: 'owner-1',
    baseVersion: 1,
    status: 'ready',
    authMode: 'chatgptAuthTokens',
    authState: 'ready',
    boxId: 'box-1',
    codexHomeKey: 'sessions/sess-1',
    boxStatus: 'ready',
    appServerStatus: 'stopped',
    daemonStatus: 'stopped',
    appServerThreadId: null,
    threadMaterializedAt: null,
    continuityState: 'auth_ready',
    resumeEligibility: 'not_resumable',
    supervisorInstanceId: null,
    supervisorLeaseEpoch: 0,
    lastSupervisorHeartbeatAt: null,
    lastFailureCode: null,
    currentLeaseToken: 'lease-1',
    leaseHeartbeatAt: now,
    leaseExpiresAt: now,
    lastCheckpointVersion: null,
    lastCheckpointId: null,
    revokedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('ai session supervisor', () => {
  it('creates one runtime per session and keeps the same lease while alive', () => {
    resetAiSessionSupervisor();
    const supervisor = getAiSessionSupervisor();
    const session = createSession();

    const started = supervisor.beginRuntime(session);
    const adopted = supervisor.getRuntime({
      ...session,
      supervisorInstanceId: started.supervisorInstanceId,
      supervisorLeaseEpoch: started.supervisorLeaseEpoch,
    });

    expect(adopted?.supervisorInstanceId).toBe(started.supervisorInstanceId);
    expect(adopted?.supervisorLeaseEpoch).toBe(started.supervisorLeaseEpoch);
  });

  it('refuses stale runtime lineage', () => {
    resetAiSessionSupervisor();
    const supervisor = getAiSessionSupervisor();
    const started = supervisor.beginRuntime(createSession());

    const stale = supervisor.getRuntime({
      ...createSession(),
      supervisorInstanceId: started.supervisorInstanceId,
      supervisorLeaseEpoch: started.supervisorLeaseEpoch + 1,
    });

    expect(stale).toBeNull();
  });
});
