import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AiSessionConflictError, AiSessionTransportNotInitializedError, createAiSessionService } from '@/lib/ai-sessions/service';
import { resetAiSessionSupervisor } from '@/lib/ai-sessions/supervisor';
import type {
  AiSessionCheckpointRecord,
  AiSessionEventRecord,
  AiSessionRecord,
  AiSessionRepository,
  CreateAiSessionCheckpointInput,
  CreateAiSessionEventInput,
  UpdateAiSessionInput,
} from '@/lib/ai-sessions/types';

class InMemoryAiSessionRepository implements AiSessionRepository {
  private readonly sessions = new Map<string, AiSessionRecord>();
  private readonly events: AiSessionEventRecord[] = [];
  private readonly checkpoints: AiSessionCheckpointRecord[] = [];

  async createSession(input: AiSessionRecord): Promise<AiSessionRecord> {
    this.sessions.set(input.id, structuredClone(input));
    return structuredClone(input);
  }

  async listProjectSessions(projectId: string): Promise<AiSessionRecord[]> {
    return [...this.sessions.values()].filter(session => session.projectId === projectId).map(session => structuredClone(session));
  }

  async getSession(sessionId: string): Promise<AiSessionRecord | null> {
    const session = this.sessions.get(sessionId);
    return session ? structuredClone(session) : null;
  }

  async updateSession(sessionId: string, input: UpdateAiSessionInput): Promise<AiSessionRecord> {
    const current = this.sessions.get(sessionId);
    if (!current) {
      throw new Error(`Missing session ${sessionId}`);
    }
    const next: AiSessionRecord = {
      ...current,
      ...input,
      updatedAt: new Date().toISOString(),
    };
    this.sessions.set(sessionId, next);
    return structuredClone(next);
  }

  async appendEvent(input: CreateAiSessionEventInput): Promise<AiSessionEventRecord> {
    const event: AiSessionEventRecord = {
      id: `evt-${this.events.length + 1}`,
      sessionId: input.sessionId,
      type: input.type,
      payload: input.payload ?? {},
      createdAt: new Date().toISOString(),
    };
    this.events.push(event);
    return structuredClone(event);
  }

  async listEvents(sessionId: string): Promise<AiSessionEventRecord[]> {
    return this.events.filter(event => event.sessionId === sessionId).map(event => structuredClone(event));
  }

  async findCheckpointByIdempotencyKey(sessionId: string, idempotencyKey: string): Promise<AiSessionCheckpointRecord | null> {
    const checkpoint = this.checkpoints.find(item => item.sessionId === sessionId && item.idempotencyKey === idempotencyKey);
    return checkpoint ? structuredClone(checkpoint) : null;
  }

  async createCheckpoint(input: CreateAiSessionCheckpointInput): Promise<AiSessionCheckpointRecord> {
    const checkpoint: AiSessionCheckpointRecord = {
      id: `chk-${this.checkpoints.length + 1}`,
      sessionId: input.sessionId,
      idempotencyKey: input.idempotencyKey,
      baseVersion: input.baseVersion,
      newVersion: input.newVersion ?? null,
      status: input.status ?? 'pending',
      manifest: input.manifest ?? {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.checkpoints.push(checkpoint);
    return structuredClone(checkpoint);
  }
}

describe('ai session service', () => {
  let repository: InMemoryAiSessionRepository;

  beforeEach(() => {
    repository = new InMemoryAiSessionRepository();
    resetAiSessionSupervisor();
  });

  afterEach(() => {
    repository = new InMemoryAiSessionRepository();
    resetAiSessionSupervisor();
  });

  it('creates a provisioning session with a lease token', async () => {
    const service = createAiSessionService(repository);

    const session = await service.createSession({
      projectId: 'project-1',
      ownerId: 'owner-1',
      baseVersion: 3,
    });

    expect(session.projectId).toBe('project-1');
    expect(session.baseVersion).toBe(3);
    expect(session.activeWorkspaceVersion).toBe(1);
    expect(session.latestWorkspaceVersion).toBe(1);
    expect(session.status).toBe('provisioning');
    expect(session.authMode).toBe('chatgptAuthTokens');
    expect(session.authState).toBe('bootstrap_pending');
    expect(session.continuityState).toBe('new');
    expect(session.resumeEligibility).toBe('not_resumable');
    expect(session.threadMaterializedAt).toBeNull();
    expect(session.currentLeaseToken.length).toBeGreaterThan(10);
  });

  it('rejects a second active writer for the same project', async () => {
    const service = createAiSessionService(repository);

    await service.createSession({
      projectId: 'project-1',
      ownerId: 'owner-1',
      baseVersion: 3,
    });

    await expect(
      service.createSession({
        projectId: 'project-1',
        ownerId: 'owner-1',
        baseVersion: 3,
      }),
    ).rejects.toBeInstanceOf(AiSessionConflictError);
  });

  it('revokes a session and expires its lease', async () => {
    const service = createAiSessionService(repository);

    const session = await service.createSession({
      projectId: 'project-2',
      ownerId: 'owner-1',
      baseVersion: 4,
    });

    const revoked = await service.revokeSession(session.id);
    expect(revoked.status).toBe('revoked');
    expect(revoked.authState).toBe('revoked');
    expect(revoked.continuityState).toBe('revoked');
    expect(revoked.resumeEligibility).toBe('not_resumable');
    expect(revoked.revokedAt).not.toBeNull();
    expect(new Date(revoked.leaseExpiresAt).getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('lists recorded events for a session', async () => {
    const service = createAiSessionService(repository);

    const session = await service.createSession({
      projectId: 'project-3',
      ownerId: 'owner-1',
      baseVersion: 1,
    });

    const events = await service.listEvents(session.id);
    expect(events.some(event => event.type === 'session.provisioning')).toBe(true);
  });

  it('returns an existing checkpoint for the same idempotency key', async () => {
    const service = createAiSessionService(repository);
    const session = await service.createSession({
      projectId: 'project-4',
      ownerId: 'owner-1',
      baseVersion: 1,
    });

    await repository.createCheckpoint({
      sessionId: session.id,
      idempotencyKey: 'dup-1',
      baseVersion: 1,
      newVersion: 2,
      status: 'committed',
      manifest: { files: ['index.html'] },
    });

    const result = await service.checkpointSession(session.id, 'dup-1');
    expect(result.checkpoint.newVersion).toBe(2);
    expect(result.checkpoint.status).toBe('committed');
  });

  it('rejects message execution before session is ready', async () => {
    const service = createAiSessionService(repository);
    const session = await service.createSession({
      projectId: 'project-5',
      ownerId: 'owner-1',
      baseVersion: 1,
    });

    await expect(
      service.executeMessage(session.id, {
        mode: 'create',
        requestText: 'make a game',
      }),
    ).rejects.toBeInstanceOf(AiSessionTransportNotInitializedError);
  });
});
