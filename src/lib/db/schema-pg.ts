import { relations, sql } from 'drizzle-orm';
import {
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

export const projectVersionSourceEnum = pgEnum('project_version_source', [
  'generate',
  'modify',
  'debug',
  'restore',
  'import',
  'archive',
]);

export const aiSessionStateEnum = pgEnum('ai_session_state', [
  'provisioning',
  'hydrating',
  'ready',
  'busy',
  'checkpointing',
  'auth_blocked',
  'failed',
  'revoked',
  'terminating',
  'terminated',
]);

export const aiSessionAuthModeEnum = pgEnum('ai_session_auth_mode', ['chatgptAuthTokens']);

export const aiSessionAuthStateEnum = pgEnum('ai_session_auth_state', [
  'bootstrap_pending',
  'ready',
  'refreshing',
  'blocked',
  'revoked',
]);

export const aiSessionBoxStateEnum = pgEnum('ai_session_box_state', [
  'unassigned',
  'provisioning',
  'ready',
  'busy',
  'failed',
  'terminating',
  'terminated',
]);

export const aiSessionAppServerStateEnum = pgEnum('ai_session_app_server_state', [
  'unassigned',
  'starting',
  'healthy',
  'degraded',
  'failed',
  'stopped',
]);

export const aiSessionCheckpointStateEnum = pgEnum('ai_session_checkpoint_state', [
  'pending',
  'committed',
  'conflict',
  'failed',
]);

export const hostBrowserAuthAttemptStatusEnum = pgEnum('host_browser_auth_attempt_status', [
  'pending',
  'completed',
  'failed',
  'expired',
]);

export const projects = pgTable('projects', {
  id: text('id').primaryKey(),
  ownerId: text('owner_id').notNull(),
  name: text('name').notNull(),
  currentVersion: integer('current_version').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdateFn(() => sql`now()`),
});

export const projectVersions = pgTable(
  'project_versions',
  {
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    source: projectVersionSourceEnum('source').notNull(),
    parentVersion: integer('parent_version'),
    restoredFromVersion: integer('restored_from_version'),
    localSnapshotId: text('local_snapshot_id'),
    evaluator: jsonb('evaluator'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  table => [primaryKey({ columns: [table.projectId, table.version] })],
);

export const aiSessions = pgTable('ai_sessions', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  ownerId: text('owner_id').notNull(),
  baseVersion: integer('base_version').notNull(),
  activeWorkspaceVersion: integer('active_workspace_version').notNull().default(1),
  latestWorkspaceVersion: integer('latest_workspace_version').notNull().default(1),
  status: aiSessionStateEnum('status').notNull().default('provisioning'),
  authMode: aiSessionAuthModeEnum('auth_mode').notNull().default('chatgptAuthTokens'),
  authState: aiSessionAuthStateEnum('auth_state').notNull().default('bootstrap_pending'),
  boxId: text('box_id'),
  codexHomeKey: text('codex_home_key'),
  boxStatus: aiSessionBoxStateEnum('box_status').notNull().default('unassigned'),
  appServerStatus: aiSessionAppServerStateEnum('app_server_status').notNull().default('unassigned'),
  daemonStatus: text('daemon_status').notNull().default('stopped'),
  appServerThreadId: text('app_server_thread_id'),
  threadMaterializedAt: timestamp('thread_materialized_at', { withTimezone: true }),
  continuityState: text('continuity_state').notNull().default('new'),
  resumeEligibility: text('resume_eligibility').notNull().default('not_resumable'),
  supervisorInstanceId: text('supervisor_instance_id'),
  supervisorLeaseEpoch: integer('supervisor_lease_epoch').notNull().default(0),
  lastSupervisorHeartbeatAt: timestamp('last_supervisor_heartbeat_at', { withTimezone: true }),
  lastFailureCode: text('last_failure_code'),
  currentLeaseToken: text('current_lease_token').notNull(),
  leaseHeartbeatAt: timestamp('lease_heartbeat_at', { withTimezone: true }).notNull().defaultNow(),
  leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }).notNull(),
  lastCheckpointVersion: integer('last_checkpoint_version'),
  lastCheckpointId: text('last_checkpoint_id'),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdateFn(() => sql`now()`),
});

export const aiSessionEvents = pgTable('ai_session_events', {
  id: text('id').primaryKey(),
  sessionId: text('session_id')
    .notNull()
    .references(() => aiSessions.id, { onDelete: 'cascade' }),
  type: text('type').notNull(),
  payload: jsonb('payload').notNull().default(sql`'{}'::jsonb`),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const aiSessionCheckpoints = pgTable('ai_session_checkpoints', {
  id: text('id').primaryKey(),
  sessionId: text('session_id')
    .notNull()
    .references(() => aiSessions.id, { onDelete: 'cascade' }),
  idempotencyKey: text('idempotency_key').notNull(),
  baseVersion: integer('base_version').notNull(),
  newVersion: integer('new_version'),
  status: aiSessionCheckpointStateEnum('status').notNull().default('pending'),
  manifest: jsonb('manifest').notNull().default(sql`'{}'::jsonb`),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdateFn(() => sql`now()`),
});

export const hostAuthPendingStates = pgTable('host_auth_pending_states', {
  state: text('state').primaryKey(),
  authRequestId: text('auth_request_id').notNull(),
  verifier: text('verifier').notNull(),
  redirectUri: text('redirect_uri').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});

export const hostBrowserAuthAttempts = pgTable('host_browser_auth_attempts', {
  authRequestId: text('auth_request_id').primaryKey(),
  state: text('state').notNull(),
  authorizeUrl: text('authorize_url').notNull(),
  redirectUri: text('redirect_uri').notNull(),
  status: hostBrowserAuthAttemptStatusEnum('status').notNull().default('pending'),
  authSessionId: text('auth_session_id'),
  accountId: text('account_id'),
  planType: text('plan_type'),
  error: text('error'),
  errorDescription: text('error_description'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
});

export const hostAuthSessions = pgTable('host_auth_sessions', {
  authSessionId: text('auth_session_id').primaryKey(),
  accessToken: text('access_token').notNull(),
  refreshToken: text('refresh_token').notNull(),
  idToken: text('id_token'),
  bindToken: text('bind_token'),
  bindTokenExpiresAt: timestamp('bind_token_expires_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  accountId: text('account_id'),
  planType: text('plan_type'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
});

export const hostAuthBindings = pgTable('host_auth_bindings', {
  aiSessionId: text('ai_session_id').primaryKey(),
  authSessionId: text('auth_session_id')
    .notNull()
    .references(() => hostAuthSessions.authSessionId, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
});

export const projectsRelations = relations(projects, ({ many }) => ({
  versions: many(projectVersions),
  aiSessions: many(aiSessions),
}));

export const projectVersionsRelations = relations(projectVersions, ({ one }) => ({
  project: one(projects, {
    fields: [projectVersions.projectId],
    references: [projects.id],
  }),
}));

export const aiSessionsRelations = relations(aiSessions, ({ many, one }) => ({
  project: one(projects, {
    fields: [aiSessions.projectId],
    references: [projects.id],
  }),
  events: many(aiSessionEvents),
  checkpoints: many(aiSessionCheckpoints),
}));

export const aiSessionEventsRelations = relations(aiSessionEvents, ({ one }) => ({
  session: one(aiSessions, {
    fields: [aiSessionEvents.sessionId],
    references: [aiSessions.id],
  }),
}));

export const aiSessionCheckpointsRelations = relations(aiSessionCheckpoints, ({ one }) => ({
  session: one(aiSessions, {
    fields: [aiSessionCheckpoints.sessionId],
    references: [aiSessions.id],
  }),
}));

export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;
export type ProjectVersion = typeof projectVersions.$inferSelect;
export type NewProjectVersion = typeof projectVersions.$inferInsert;
export type ProjectVersionSource = (typeof projectVersionSourceEnum.enumValues)[number];
export type AiSession = typeof aiSessions.$inferSelect;
export type NewAiSession = typeof aiSessions.$inferInsert;
export type AiSessionEvent = typeof aiSessionEvents.$inferSelect;
export type NewAiSessionEvent = typeof aiSessionEvents.$inferInsert;
export type AiSessionCheckpoint = typeof aiSessionCheckpoints.$inferSelect;
export type NewAiSessionCheckpoint = typeof aiSessionCheckpoints.$inferInsert;
export type HostAuthPendingState = typeof hostAuthPendingStates.$inferSelect;
export type NewHostAuthPendingState = typeof hostAuthPendingStates.$inferInsert;
export type HostBrowserAuthAttempt = typeof hostBrowserAuthAttempts.$inferSelect;
export type NewHostBrowserAuthAttempt = typeof hostBrowserAuthAttempts.$inferInsert;
export type HostAuthSession = typeof hostAuthSessions.$inferSelect;
export type NewHostAuthSession = typeof hostAuthSessions.$inferInsert;
export type HostAuthBinding = typeof hostAuthBindings.$inferSelect;
export type NewHostAuthBinding = typeof hostAuthBindings.$inferInsert;
export type AiSessionState = (typeof aiSessionStateEnum.enumValues)[number];
export type AiSessionAuthMode = (typeof aiSessionAuthModeEnum.enumValues)[number];
export type AiSessionAuthState = (typeof aiSessionAuthStateEnum.enumValues)[number];
export type AiSessionBoxState = (typeof aiSessionBoxStateEnum.enumValues)[number];
export type AiSessionAppServerState = (typeof aiSessionAppServerStateEnum.enumValues)[number];
export type AiSessionCheckpointState = (typeof aiSessionCheckpointStateEnum.enumValues)[number];
export type HostBrowserAuthAttemptStatus = (typeof hostBrowserAuthAttemptStatusEnum.enumValues)[number];
