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

export type {
  Project,
  NewProject,
  ProjectVersion,
  NewProjectVersion,
  ProjectVersionSource,
} from './schema-pg';
