import { randomUUID } from 'node:crypto';

import type {
  AiSessionRecord,
  AiSessionTransportLogDirection,
  AiSessionTransportLogEntry,
  AiSessionTransportLogPhase,
  AiSessionTransportPhase,
  AiSessionTransportSnapshot,
} from '@/lib/ai-sessions/types';

const IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_LOG_ENTRIES = 200;

type TransportRuntimeRecord = {
  phase: AiSessionTransportPhase;
  threadId: string | null;
  initializedAt: string | null;
  lastActivityAt: string | null;
  idleDeadlineAt: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  initTranscript: AiSessionTransportLogEntry[];
  turnTranscript: AiSessionTransportLogEntry[];
};

export type PersistedTransportRuntimeState = {
  phase: AiSessionTransportPhase;
  threadId: string | null;
  initializedAt: string | null;
  lastActivityAt: string | null;
  idleDeadlineAt: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
};

const runtimeBySession = new Map<string, TransportRuntimeRecord>();

function nowIso(): string {
  return new Date().toISOString();
}

function computeIdleDeadline(baseIso: string): string {
  return new Date(new Date(baseIso).getTime() + IDLE_TIMEOUT_MS).toISOString();
}

function trimEntries(entries: AiSessionTransportLogEntry[]): AiSessionTransportLogEntry[] {
  if (entries.length <= MAX_LOG_ENTRIES) {
    return entries;
  }
  return entries.slice(entries.length - MAX_LOG_ENTRIES);
}

function replaceSecrets(input: string): string {
  return input
    .replace(/("?(?:accessToken|bindToken|Authorization|authorization)"?\s*[:=]\s*")([^"]+)(")/gi, '$1[REDACTED]$3')
    .replace(/(Bearer\s+)[A-Za-z0-9._\-]+/gi, '$1[REDACTED]');
}

function sanitizeMessage(message: unknown): string {
  const raw = typeof message === 'string' ? message : JSON.stringify(message);
  return replaceSecrets(raw);
}

function createBaseRecord(): TransportRuntimeRecord {
  return {
    phase: 'uninitialized',
    threadId: null,
    initializedAt: null,
    lastActivityAt: null,
    idleDeadlineAt: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    initTranscript: [],
    turnTranscript: [],
  };
}

function restoreRecord(
  state: PersistedTransportRuntimeState,
  initTranscript: AiSessionTransportLogEntry[],
  turnTranscript: AiSessionTransportLogEntry[],
): TransportRuntimeRecord {
  return {
    phase: state.phase,
    threadId: state.threadId,
    initializedAt: state.initializedAt,
    lastActivityAt: state.lastActivityAt,
    idleDeadlineAt: state.idleDeadlineAt,
    lastErrorCode: state.lastErrorCode,
    lastErrorMessage: state.lastErrorMessage,
    initTranscript: trimEntries(initTranscript),
    turnTranscript: trimEntries(turnTranscript),
  };
}

function getOrCreateRecord(sessionId: string): TransportRuntimeRecord {
  const existing = runtimeBySession.get(sessionId);
  if (existing) {
    return existing;
  }

  const created = createBaseRecord();
  runtimeBySession.set(sessionId, created);
  return created;
}

function toSnapshot(record: TransportRuntimeRecord): AiSessionTransportSnapshot {
  return {
    phase: record.phase,
    threadId: record.threadId,
    initializedAt: record.initializedAt,
    lastActivityAt: record.lastActivityAt,
    idleDeadlineAt: record.idleDeadlineAt,
    lastErrorCode: record.lastErrorCode,
    lastErrorMessage: record.lastErrorMessage,
    initLogCount: record.initTranscript.length,
    turnLogCount: record.turnTranscript.length,
    requiresReinit: record.phase !== 'ready',
  };
}

export function getAiSessionTransportSnapshot(session: AiSessionRecord): AiSessionTransportSnapshot {
  const existing = runtimeBySession.get(session.id);
  if (!existing) {
    if (session.appServerThreadId || session.appServerStatus === 'healthy' || session.appServerStatus === 'degraded') {
      return {
        phase: 'transport_lost',
        threadId: null,
        initializedAt: null,
        lastActivityAt: null,
        idleDeadlineAt: null,
        lastErrorCode: 'codex_transport_runtime_missing',
        lastErrorMessage: 'Transport runtime state is unavailable; re-initialize Codex.',
        initLogCount: 0,
        turnLogCount: 0,
        requiresReinit: true,
      };
    }

    return toSnapshot(createBaseRecord());
  }

  return toSnapshot(existing);
}

export function listAiSessionTransportLogs(sessionId: string): {
  snapshot: AiSessionTransportSnapshot;
  initTranscript: AiSessionTransportLogEntry[];
  turnTranscript: AiSessionTransportLogEntry[];
} {
  const record = getOrCreateRecord(sessionId);
  return {
    snapshot: toSnapshot(record),
    initTranscript: [...record.initTranscript],
    turnTranscript: [...record.turnTranscript],
  };
}

export function startAiSessionTransportInit(sessionId: string): AiSessionTransportSnapshot {
  const record = getOrCreateRecord(sessionId);
  record.phase = 'initializing';
  record.lastErrorCode = null;
  record.lastErrorMessage = null;
  record.lastActivityAt = nowIso();
  record.idleDeadlineAt = null;
  return toSnapshot(record);
}

export function markAiSessionTransportReady(sessionId: string, threadId: string): AiSessionTransportSnapshot {
  const record = getOrCreateRecord(sessionId);
  const current = nowIso();
  record.phase = 'ready';
  record.threadId = threadId;
  record.initializedAt = record.initializedAt ?? current;
  record.lastActivityAt = current;
  record.idleDeadlineAt = computeIdleDeadline(current);
  record.lastErrorCode = null;
  record.lastErrorMessage = null;
  return toSnapshot(record);
}

export function startAiSessionTransportTurn(sessionId: string): AiSessionTransportSnapshot {
  const record = getOrCreateRecord(sessionId);
  const current = nowIso();
  record.phase = 'turn_running';
  record.lastActivityAt = current;
  record.idleDeadlineAt = computeIdleDeadline(current);
  return toSnapshot(record);
}

export function finishAiSessionTransportTurn(sessionId: string): AiSessionTransportSnapshot {
  const record = getOrCreateRecord(sessionId);
  const current = nowIso();
  record.phase = 'ready';
  record.lastActivityAt = current;
  record.idleDeadlineAt = computeIdleDeadline(current);
  return toSnapshot(record);
}

export function markAiSessionTransportLost(
  sessionId: string,
  errorCode: string,
  errorMessage: string,
): AiSessionTransportSnapshot {
  const record = getOrCreateRecord(sessionId);
  record.phase = 'transport_lost';
  record.threadId = null;
  record.idleDeadlineAt = null;
  record.lastActivityAt = nowIso();
  record.lastErrorCode = errorCode;
  record.lastErrorMessage = sanitizeMessage(errorMessage);
  return toSnapshot(record);
}

export function expireAiSessionTransportIfIdle(sessionId: string, now = Date.now()): AiSessionTransportSnapshot | null {
  const record = runtimeBySession.get(sessionId);
  if (!record?.idleDeadlineAt) {
    return null;
  }

  if (record.phase === 'initializing' || record.phase === 'turn_running') {
    return null;
  }

  if (new Date(record.idleDeadlineAt).getTime() > now) {
    return null;
  }

  record.phase = 'idle_expired';
  record.threadId = null;
  record.idleDeadlineAt = null;
  record.lastActivityAt = new Date(now).toISOString();
  record.lastErrorCode = 'codex_transport_idle_expired';
  record.lastErrorMessage = 'Codex transport expired after 10 minutes of inactivity.';
  return toSnapshot(record);
}

export function appendAiSessionTransportLog(
  sessionId: string,
  phase: AiSessionTransportLogPhase,
  direction: AiSessionTransportLogDirection,
  message: unknown,
): AiSessionTransportLogEntry {
  const record = getOrCreateRecord(sessionId);
  const createdAt = nowIso();
  const entry: AiSessionTransportLogEntry = {
    id: randomUUID(),
    phase,
    direction,
    message: sanitizeMessage(message),
    createdAt,
  };

  if (phase === 'init') {
    record.initTranscript = trimEntries([...record.initTranscript, entry]);
  } else {
    record.turnTranscript = trimEntries([...record.turnTranscript, entry]);
  }

  record.lastActivityAt = createdAt;
  if (record.phase !== 'initializing') {
    record.idleDeadlineAt = computeIdleDeadline(createdAt);
  }
  return entry;
}

export function clearAiSessionTransport(sessionId: string): void {
  runtimeBySession.delete(sessionId);
}

export function hasAiSessionTransportRuntime(sessionId: string): boolean {
  return runtimeBySession.has(sessionId);
}

export function restoreAiSessionTransport(
  sessionId: string,
  state: PersistedTransportRuntimeState,
  initTranscript: AiSessionTransportLogEntry[],
  turnTranscript: AiSessionTransportLogEntry[],
): AiSessionTransportSnapshot {
  const restored = restoreRecord(state, initTranscript, turnTranscript);
  runtimeBySession.set(sessionId, restored);
  return toSnapshot(restored);
}

export function syncAiSessionTransportThreadId(sessionId: string, threadId: string | null): AiSessionTransportSnapshot {
  const record = getOrCreateRecord(sessionId);
  record.threadId = threadId;
  return toSnapshot(record);
}
