import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';

import { getDatabaseUrl } from '@/lib/config/infra';
import * as schema from './schema-pg';

let cachedDb: ReturnType<typeof drizzle<typeof schema>> | null = null;

export function getDb() {
  if (cachedDb) {
    return cachedDb;
  }

  const databaseUrl = getDatabaseUrl();
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is not configured.');
  }

  const sqlClient = neon(databaseUrl);
  cachedDb = drizzle(sqlClient, { schema });
  return cachedDb;
}

export function resetDbForTests() {
  cachedDb = null;
}

export const dbSchema = schema;
export const projects = schema.projects;
export const projectVersions = schema.projectVersions;
export const aiSessions = schema.aiSessions;
export const aiSessionEvents = schema.aiSessionEvents;
export const aiSessionCheckpoints = schema.aiSessionCheckpoints;
export const aiSessionTransportLogs = schema.aiSessionTransportLogs;
export const hostAuthPendingStates = schema.hostAuthPendingStates;
export const hostBrowserAuthAttempts = schema.hostBrowserAuthAttempts;
export const hostAuthSessions = schema.hostAuthSessions;
export const hostAuthBindings = schema.hostAuthBindings;

export type {
  Project,
  NewProject,
  ProjectVersion,
  NewProjectVersion,
  ProjectVersionSource,
  AiSession,
  NewAiSession,
  AiSessionEvent,
  NewAiSessionEvent,
  AiSessionCheckpoint,
  NewAiSessionCheckpoint,
  AiSessionTransportLog,
  NewAiSessionTransportLog,
  HostAuthPendingState,
  NewHostAuthPendingState,
  HostBrowserAuthAttempt,
  NewHostBrowserAuthAttempt,
  HostAuthSession,
  NewHostAuthSession,
  HostAuthBinding,
  NewHostAuthBinding,
  AiSessionState,
  AiSessionAuthMode,
  AiSessionAuthState,
  AiSessionBoxState,
  AiSessionAppServerState,
  AiSessionCheckpointState,
  HostBrowserAuthAttemptStatus,
} from './schema-pg';
