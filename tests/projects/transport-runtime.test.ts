import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  appendAiSessionTransportLog,
  clearAiSessionTransport,
  expireAiSessionTransportIfIdle,
  getAiSessionTransportSnapshot,
  listAiSessionTransportLogs,
  markAiSessionTransportReady,
  startAiSessionTransportInit,
} from '@/lib/ai-sessions/transport-runtime';
import type { AiSessionRecord } from '@/lib/ai-sessions/types';

function createSessionRecord(overrides: Partial<AiSessionRecord> = {}): AiSessionRecord {
  const now = new Date().toISOString();
    return {
      id: 'sess-1',
      projectId: 'project-1',
      ownerId: 'owner-1',
      baseVersion: 1,
      activeWorkspaceVersion: 1,
      latestWorkspaceVersion: 1,
      status: 'ready',
    authMode: 'chatgptAuthTokens',
    authState: 'ready',
    boxId: 'box-1',
    codexHomeKey: 'sessions/sess-1',
    boxStatus: 'ready',
    appServerStatus: 'healthy',
    daemonStatus: 'healthy',
    appServerThreadId: null,
    threadMaterializedAt: null,
    transportPhase: 'uninitialized',
    transportInitializedAt: null,
    transportLastActivityAt: null,
    transportIdleDeadlineAt: null,
    transportLastErrorCode: null,
    transportLastErrorMessage: null,
    continuityState: 'resumable',
    resumeEligibility: 'resumable',
    recoveryOutcome: 'none',
    supervisorInstanceId: null,
    supervisorLeaseEpoch: 0,
    lastSupervisorHeartbeatAt: now,
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

describe('ai session transport runtime', () => {
  beforeEach(() => {
    vi.useRealTimers();
    clearAiSessionTransport('sess-1');
  });

  it('returns transport_lost when persisted app-server state exists but runtime is missing', () => {
    const snapshot = getAiSessionTransportSnapshot(
      createSessionRecord({ appServerThreadId: 'thr-1', appServerStatus: 'healthy' }),
    );

    expect(snapshot.phase).toBe('transport_lost');
    expect(snapshot.requiresReinit).toBe(true);
  });

  it('expires ready transport after 10 minutes of inactivity', () => {
    startAiSessionTransportInit('sess-1');
    markAiSessionTransportReady('sess-1', 'thr-1');
    const { snapshot } = listAiSessionTransportLogs('sess-1');
    const expired = expireAiSessionTransportIfIdle('sess-1', new Date(snapshot.idleDeadlineAt ?? 0).getTime() + 1);

    expect(expired?.phase).toBe('idle_expired');
    expect(expired?.requiresReinit).toBe(true);
  });

  it('redacts token-like values in transcripts', () => {
    startAiSessionTransportInit('sess-1');
    appendAiSessionTransportLog(
      'sess-1',
      'init',
      'outbound',
      'Authorization: Bearer super-secret-token accessToken="abc" bindToken="xyz"',
    );

    const { initTranscript } = listAiSessionTransportLogs('sess-1');
    expect(initTranscript[0]?.message).toContain('[REDACTED]');
    expect(initTranscript[0]?.message).not.toContain('super-secret-token');
    expect(initTranscript[0]?.message).not.toContain('abc');
    expect(initTranscript[0]?.message).not.toContain('xyz');
  });
});
