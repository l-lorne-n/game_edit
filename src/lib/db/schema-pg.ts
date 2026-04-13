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

export const projectsRelations = relations(projects, ({ many }) => ({
  versions: many(projectVersions),
}));

export const projectVersionsRelations = relations(projectVersions, ({ one }) => ({
  project: one(projects, {
    fields: [projectVersions.projectId],
    references: [projects.id],
  }),
}));

export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;
export type ProjectVersion = typeof projectVersions.$inferSelect;
export type NewProjectVersion = typeof projectVersions.$inferInsert;
export type ProjectVersionSource = (typeof projectVersionSourceEnum.enumValues)[number];
