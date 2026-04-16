import { randomUUID } from 'node:crypto';

import type {
  AiSessionContinuityState,
  AiSessionDaemonState,
  AiSessionRecord,
  AiSessionResumeEligibility,
} from '@/lib/ai-sessions/types';

export type AiSessionSupervisorRuntime = {
  sessionId: string;
  projectId: string;
  boxId: string | null;
  codexHomeKey: string | null;
  supervisorInstanceId: string;
  supervisorLeaseEpoch: number;
  daemonStatus: AiSessionDaemonState;
  continuityState: AiSessionContinuityState;
  resumeEligibility: AiSessionResumeEligibility;
  threadId: string | null;
  threadMaterializedAt: string | null;
  lastHeartbeatAt: string;
  lastFailureCode: string | null;
};

function nowIso(): string {
  return new Date().toISOString();
}

class AiSessionSupervisor {
  private readonly runtimes = new Map<string, AiSessionSupervisorRuntime>();

  beginRuntime(session: AiSessionRecord): AiSessionSupervisorRuntime {
    const existing = this.runtimes.get(session.id);
    if (existing && existing.supervisorInstanceId === session.supervisorInstanceId && existing.supervisorLeaseEpoch === session.supervisorLeaseEpoch) {
      existing.lastHeartbeatAt = nowIso();
      return structuredClone(existing);
    }

    const runtime: AiSessionSupervisorRuntime = {
      sessionId: session.id,
      projectId: session.projectId,
      boxId: session.boxId,
      codexHomeKey: session.codexHomeKey,
      supervisorInstanceId: randomUUID(),
      supervisorLeaseEpoch: (session.supervisorLeaseEpoch ?? 0) + 1,
      daemonStatus: 'starting',
      continuityState: session.continuityState,
      resumeEligibility: session.resumeEligibility,
      threadId: session.appServerThreadId,
      threadMaterializedAt: session.threadMaterializedAt,
      lastHeartbeatAt: nowIso(),
      lastFailureCode: session.lastFailureCode,
    };
    this.runtimes.set(session.id, runtime);
    return structuredClone(runtime);
  }

  getRuntime(session: AiSessionRecord): AiSessionSupervisorRuntime | null {
    const existing = this.runtimes.get(session.id);
    if (!existing) {
      return null;
    }

    if (
      session.supervisorInstanceId &&
      (existing.supervisorInstanceId !== session.supervisorInstanceId || existing.supervisorLeaseEpoch !== session.supervisorLeaseEpoch)
    ) {
      return null;
    }

    return structuredClone(existing);
  }

  heartbeat(sessionId: string): AiSessionSupervisorRuntime | null {
    const existing = this.runtimes.get(sessionId);
    if (!existing) {
      return null;
    }

    existing.lastHeartbeatAt = nowIso();
    return structuredClone(existing);
  }

  updateRuntime(
    sessionId: string,
    input: Partial<Pick<AiSessionSupervisorRuntime, 'boxId' | 'codexHomeKey' | 'daemonStatus' | 'continuityState' | 'resumeEligibility' | 'threadId' | 'threadMaterializedAt' | 'lastFailureCode'>>,
  ): AiSessionSupervisorRuntime | null {
    const existing = this.runtimes.get(sessionId);
    if (!existing) {
      return null;
    }

    Object.assign(existing, input, { lastHeartbeatAt: nowIso() });
    return structuredClone(existing);
  }

  terminateRuntime(sessionId: string): void {
    this.runtimes.delete(sessionId);
  }
}

let supervisorSingleton: AiSessionSupervisor | null = null;

export function getAiSessionSupervisor(): AiSessionSupervisor {
  if (!supervisorSingleton) {
    supervisorSingleton = new AiSessionSupervisor();
  }
  return supervisorSingleton;
}

export function resetAiSessionSupervisor(): void {
  supervisorSingleton = null;
}
