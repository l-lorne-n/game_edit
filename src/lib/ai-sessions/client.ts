'use client';

import type {
  AiSessionCheckpointRecord,
  AiSessionEventRecord,
  AiSessionRecord,
  AiSessionTurnRecord,
  AiSessionTransportLogEntry,
  AiSessionTransportSnapshot,
  AiSessionWorkspaceVersion,
  AiSessionWorkspaceVersionPayload,
} from '@/lib/ai-sessions/types';
import type { PackageExecutionTraceMeta } from '@/lib/ai/execution-trace';
import type { ModelAttempt } from '@/lib/ai/types';
import type { EvaluatorResult } from '@/lib/evaluator/types';
import type { GamePackageManifest, GeneratedGamePackage } from '@/lib/package/contracts';
import type { HostTokenSessionMetadata } from '@/lib/host-tokens/types';
import type { HydratedProjectRecord } from '@/lib/projects/types';

async function parseJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

export class AiSessionClientError extends Error {
  readonly code: string | null;

  constructor(message: string, code?: string | null) {
    super(message);
    this.code = code ?? null;
  }
}

export type AiSessionSnapshot = {
  session: AiSessionRecord;
  events: AiSessionEventRecord[];
  transport: AiSessionTransportSnapshot | null;
};

export type AiSessionTurnSubmitResponse = {
  acknowledged: true;
  deduplicated: boolean;
  sessionId: string;
  turnId: string;
  acceptedAt: string;
  threadId: string;
  workspaceVersion: number;
  workspaceRoot: string;
  baseTargetId: string | null;
  status: AiSessionTurnRecord['status'];
  artifactState: AiSessionTurnRecord['artifactState'];
};

export type AiSessionTurnStatusResponse = {
  turnId: string;
  sessionId: string;
  status: AiSessionTurnRecord['status'];
  artifactState: AiSessionTurnRecord['artifactState'];
  acceptedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  terminalAt: string | null;
  workspaceVersion: number;
  workspaceRoot: string;
  threadId: string | null;
  turnStatus: string | null;
  finalOutcome: AiSessionTurnRecord['finalOutcome'];
  recoveryOutcome: AiSessionTurnRecord['recoveryOutcome'];
  failureCode: string | null;
  failureMessage: string | null;
};

export type AiSessionTurnResultResponse = {
  acknowledged: true;
  sessionId: string;
  turnId: string;
  acceptedAt: string;
  threadId: string;
  turnStatus: string | null;
  agentText: string;
  workspaceVersion: number;
  workspaceRoot: string;
  baseTargetId: string | null;
  artifactState: AiSessionTurnRecord['artifactState'];
  finalOutcome: AiSessionTurnRecord['finalOutcome'];
  recoveryOutcome: AiSessionTurnRecord['recoveryOutcome'];
  failureCode: string | null;
  failureMessage: string | null;
  package: GeneratedGamePackage | null;
  manifest: GamePackageManifest | null;
  staticEvaluation: EvaluatorResult | null;
  statusMessage: string;
  executionEngine: PackageExecutionTraceMeta | null;
  repaired: boolean;
  fallbackUsed: boolean;
  source: string;
  provider: string;
  model: string;
  attempts: ModelAttempt[];
};

export async function listProjectAiSessions(projectId: string): Promise<AiSessionRecord[]> {
  const response = await fetch(`/api/ai/sessions?projectId=${encodeURIComponent(projectId)}`, {
    cache: 'no-store',
  });
  const json = await parseJson<{ ok: boolean; sessions?: AiSessionRecord[]; error?: string }>(response);
  if (!response.ok || !json.ok || !json.sessions) {
    throw new Error(json.error ?? `Failed to list AI sessions for ${projectId}`);
  }
  return json.sessions;
}

export async function createAiSession(projectId: string): Promise<AiSessionRecord> {
  const response = await fetch('/api/ai/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId }),
  });
  const json = await parseJson<{ ok: boolean; session?: AiSessionRecord; error?: string }>(response);
  if (!response.ok || !json.ok || !json.session) {
    throw new Error(json.error ?? `Failed to create AI session for ${projectId}`);
  }
  return json.session;
}

export async function bootstrapAiSession(sessionId: string, bindToken: string): Promise<AiSessionRecord> {
  const response = await fetch(`/api/ai/sessions/${sessionId}/bootstrap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bindToken }),
  });
  const json = await parseJson<{ ok: boolean; session?: AiSessionRecord; error?: string }>(response);
  if (!response.ok || !json.ok || !json.session) {
    throw new Error(json.error ?? `Failed to bootstrap AI session ${sessionId}`);
  }
  return json.session;
}

export async function initAiSessionTransport(
  sessionId: string,
  bindToken: string,
): Promise<{ session: AiSessionRecord; transport: AiSessionTransportSnapshot }> {
  const response = await fetch(`/api/ai/sessions/${sessionId}/init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bindToken }),
  });
  const json = await parseJson<{
    ok: boolean;
    session?: AiSessionRecord;
    transport?: AiSessionTransportSnapshot;
    error?: string;
    code?: string;
  }>(response);
  if (!response.ok || !json.ok || !json.session || !json.transport) {
    throw new AiSessionClientError(json.error ?? `Failed to initialize Codex transport for ${sessionId}`, json.code);
  }
  return { session: json.session, transport: json.transport };
}

export async function getAiSessionLogs(sessionId: string): Promise<{
  transport: AiSessionTransportSnapshot;
  initTranscript: AiSessionTransportLogEntry[];
  turnTranscript: AiSessionTransportLogEntry[];
}> {
  const response = await fetch(`/api/ai/sessions/${sessionId}/logs`, {
    cache: 'no-store',
  });
  const json = await parseJson<{
    ok: boolean;
    transport?: AiSessionTransportSnapshot;
    initTranscript?: AiSessionTransportLogEntry[];
    turnTranscript?: AiSessionTransportLogEntry[];
    error?: string;
  }>(response);
  if (!response.ok || !json.ok || !json.transport || !json.initTranscript || !json.turnTranscript) {
    throw new Error(json.error ?? `Failed to load Codex logs for ${sessionId}`);
  }
  return {
    transport: json.transport,
    initTranscript: json.initTranscript,
    turnTranscript: json.turnTranscript,
  };
}

export async function getLatestHostTokenSession(): Promise<HostTokenSessionMetadata | null> {
  const response = await fetch('/api/codex/host/session/latest', { cache: 'no-store' });
  const json = await parseJson<{ found?: boolean; session?: HostTokenSessionMetadata; error?: string }>(response);
  if (!response.ok) {
    throw new Error(json.error ?? 'Failed to load latest host token session');
  }
  return json.found && json.session ? json.session : null;
}

export async function beginHostBrowserOAuth(): Promise<{
  authRequestId: string;
  authorizeUrl: string;
  state: string;
  redirectUri: string;
  expiresAt: number;
}> {
  const response = await fetch('/api/codex/host/browser/start', { cache: 'no-store' });
  const json = await parseJson<{
    authRequestId?: string;
    authorizeUrl?: string;
    state?: string;
    redirectUri?: string;
    expiresAt?: number;
    error?: string;
  }>(response);
  if (!response.ok || !json.authRequestId || !json.authorizeUrl || !json.state || !json.redirectUri || typeof json.expiresAt !== 'number') {
    throw new Error(json.error ?? 'Failed to begin host browser OAuth');
  }
  return {
    authRequestId: json.authRequestId,
    authorizeUrl: json.authorizeUrl,
    state: json.state,
    redirectUri: json.redirectUri,
    expiresAt: json.expiresAt,
  };
}

export async function revokeAiSession(sessionId: string): Promise<AiSessionRecord> {
  const response = await fetch(`/api/ai/sessions/${sessionId}`, {
    method: 'DELETE',
  });
  const json = await parseJson<{ ok: boolean; session?: AiSessionRecord; error?: string }>(response);
  if (!response.ok || !json.ok || !json.session) {
    throw new Error(json.error ?? `Failed to revoke AI session ${sessionId}`);
  }
  return json.session;
}

export async function checkpointAiSession(sessionId: string, idempotencyKey: string): Promise<{
  session: AiSessionRecord;
  checkpoint: AiSessionCheckpointRecord;
  project: HydratedProjectRecord | null;
}> {
  const response = await fetch(`/api/ai/sessions/${sessionId}/checkpoint`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idempotencyKey }),
  });
  const json = await parseJson<{
    ok: boolean;
    session?: AiSessionRecord;
    checkpoint?: AiSessionCheckpointRecord;
    project?: HydratedProjectRecord | null;
    error?: string;
  }>(response);
  if (!response.ok && response.status !== 409) {
    throw new Error(json.error ?? `Failed to checkpoint AI session ${sessionId}`);
  }
  if (!json.ok || !json.session || !json.checkpoint) {
    throw new Error(json.error ?? `Failed to checkpoint AI session ${sessionId}`);
  }
  return {
    session: json.session,
    checkpoint: json.checkpoint,
    project: json.project ?? null,
  };
}

export async function getAiSessionSnapshot(sessionId: string): Promise<AiSessionSnapshot> {
  const response = await fetch(`/api/ai/sessions/${sessionId}/events`, {
    cache: 'no-store',
  });

  if (!response.ok) {
    const json = await parseJson<{ error?: string }>(response).catch(() => ({ error: `HTTP ${response.status}` }));
    throw new Error(json.error ?? `Failed to load AI session events for ${sessionId}`);
  }

  const text = await response.text();
  const line = text
    .split('\n')
    .map(item => item.trim())
    .find(item => item.startsWith('data: '));

  if (!line) {
    throw new Error(`AI session stream for ${sessionId} did not contain a snapshot event.`);
  }

  const payload = JSON.parse(line.slice('data: '.length)) as {
    type: string;
    session: AiSessionRecord;
    events: AiSessionEventRecord[];
    transport?: AiSessionTransportSnapshot | null;
  };

  return {
    session: payload.session,
    events: payload.events,
    transport: payload.transport ?? null,
  };
}

export async function listAiSessionVersions(sessionId: string): Promise<AiSessionWorkspaceVersion[]> {
  const response = await fetch(`/api/ai/sessions/${sessionId}/versions`, {
    cache: 'no-store',
  });
  const json = await parseJson<{ ok: boolean; versions?: AiSessionWorkspaceVersion[]; error?: string }>(response);
  if (!response.ok || !json.ok || !json.versions) {
    throw new Error(json.error ?? `Failed to list versions for AI session ${sessionId}`);
  }
  return json.versions;
}

export async function getAiSessionVersionPayload(sessionId: string, versionId: string): Promise<AiSessionWorkspaceVersionPayload> {
  const response = await fetch(`/api/ai/sessions/${sessionId}/versions/${encodeURIComponent(versionId)}`, {
    cache: 'no-store',
  });
  const json = await parseJson<{ ok: boolean; error?: string } & Partial<AiSessionWorkspaceVersionPayload>>(response);
  if (!response.ok || !json.ok || !json.package) {
    throw new Error(json.error ?? `Failed to load version ${versionId} for AI session ${sessionId}`);
  }
  return json as AiSessionWorkspaceVersionPayload;
}

export async function submitAiSessionMessageTurn(
  sessionId: string,
  input: {
    mode: 'create' | 'modify' | 'debug';
    requestText: string;
    targetId?: string | null;
    routeMode?: 'design' | 'patch' | 'repair' | null;
    routeReason?: string | null;
    allowedPaths?: string[];
  },
): Promise<AiSessionTurnSubmitResponse> {
  const response = await fetch(`/api/ai/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const json = await parseJson<{ ok: boolean; result?: AiSessionTurnSubmitResponse; error?: string; code?: string }>(response);
  if (!response.ok || !json.ok || !json.result) {
    throw new AiSessionClientError(json.error ?? `Failed to submit AI session turn for ${sessionId}`, json.code);
  }
  return json.result;
}

export async function getAiSessionMessageTurnStatus(sessionId: string, turnId: string) {
  const response = await fetch(`/api/ai/sessions/${sessionId}/messages/${encodeURIComponent(turnId)}`, {
    cache: 'no-store',
  });
  const json = await parseJson<{ ok: boolean; status?: AiSessionTurnStatusResponse; error?: string }>(response);
  if (!response.ok || !json.ok || !json.status) {
    throw new Error(json.error ?? `Failed to load AI session turn status for ${turnId}`);
  }
  return json.status;
}

export async function getAiSessionMessageTurnResult(sessionId: string, turnId: string) {
  const response = await fetch(`/api/ai/sessions/${sessionId}/messages/${encodeURIComponent(turnId)}/result`, {
    cache: 'no-store',
  });
  const json = await parseJson<{ ok: boolean; result?: AiSessionTurnResultResponse; error?: string; code?: string }>(response);
  if (!response.ok || !json.ok || !json.result) {
    throw new AiSessionClientError(json.error ?? `Failed to load AI session turn result for ${turnId}`, json.code);
  }
  return json.result;
}
