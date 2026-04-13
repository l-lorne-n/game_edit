import { randomUUID } from 'node:crypto';

import { and, asc, desc, eq } from 'drizzle-orm';

import type { EvaluatorResult } from '@/lib/evaluator/types';
import { getDb, projects, projectVersions } from '@/lib/db';
import type { CreateProjectInput, ProjectRecord, ProjectRepository, ProjectSaveSource, ProjectVersionRecord, SaveProjectVersionInput } from '@/lib/projects/types';

function toProjectRecord(input: typeof projects.$inferSelect, versions: ProjectVersionRecord[]): ProjectRecord {
  return {
    id: input.id,
    ownerId: input.ownerId,
    name: input.name,
    currentVersion: input.currentVersion,
    createdAt: input.createdAt.toISOString(),
    updatedAt: input.updatedAt.toISOString(),
    versions,
  };
}

function toVersionRecord(input: typeof projectVersions.$inferSelect): ProjectVersionRecord {
  const evaluator = (input.evaluator ?? null) as EvaluatorResult | null;
  return {
    projectId: input.projectId,
    version: input.version,
    source: input.source as ProjectSaveSource,
    parentVersion: input.parentVersion,
    restoredFromVersion: input.restoredFromVersion,
    localSnapshotId: input.localSnapshotId,
    evaluator,
    status: evaluator ? (evaluator.ok ? 'passed' : 'failed') : 'unknown',
    createdAt: input.createdAt.toISOString(),
  };
}

export class DrizzleProjectRepository implements ProjectRepository {
  async createProject(input: CreateProjectInput): Promise<ProjectRecord> {
    const db = getDb();
    const id = input.id ?? randomUUID();

    await db.insert(projects).values({
      id,
      ownerId: input.ownerId,
      name: input.name,
      currentVersion: 0,
    });

    const created = await this.getProject(id);
    if (!created) {
      throw new Error(`Failed to create project ${id}`);
    }

    return created;
  }

  async listProjects(): Promise<ProjectRecord[]> {
    const db = getDb();
    const projectRows = await db.select().from(projects).orderBy(desc(projects.updatedAt), asc(projects.createdAt));

    return Promise.all(projectRows.map(async projectRow => (await this.getProject(projectRow.id))!));
  }

  async getProject(projectId: string): Promise<ProjectRecord | null> {
    const db = getDb();
    const projectRow = await db.query.projects.findFirst({
      where: eq(projects.id, projectId),
    });

    if (!projectRow) {
      return null;
    }

    const versionRows = await db
      .select()
      .from(projectVersions)
      .where(eq(projectVersions.projectId, projectId))
      .orderBy(desc(projectVersions.version));

    return toProjectRecord(projectRow, versionRows.map(toVersionRecord));
  }

  async insertVersion(input: Omit<SaveProjectVersionInput, 'pkg'> & { version: number }): Promise<ProjectVersionRecord> {
    const db = getDb();

    await db.insert(projectVersions).values({
      projectId: input.projectId,
      version: input.version,
      source: input.source,
      parentVersion: input.parentVersion,
      restoredFromVersion: input.restoredFromVersion ?? null,
      localSnapshotId: input.localSnapshotId ?? null,
      evaluator: input.evaluator ?? null,
    });

    const inserted = await db.query.projectVersions.findFirst({
      where: and(eq(projectVersions.projectId, input.projectId), eq(projectVersions.version, input.version)),
    });

    if (!inserted) {
      throw new Error(`Failed to insert project version ${input.projectId}@${input.version}`);
    }

    return toVersionRecord(inserted);
  }

  async updateCurrentVersion(projectId: string, version: number): Promise<void> {
    const db = getDb();
    await db.update(projects).set({ currentVersion: version, updatedAt: new Date() }).where(eq(projects.id, projectId));
  }

  async updateVersionEvaluation(projectId: string, version: number, evaluator: EvaluatorResult | null): Promise<ProjectVersionRecord> {
    const db = getDb();
    await db
      .update(projectVersions)
      .set({ evaluator })
      .where(and(eq(projectVersions.projectId, projectId), eq(projectVersions.version, version)));

    const updated = await db.query.projectVersions.findFirst({
      where: and(eq(projectVersions.projectId, projectId), eq(projectVersions.version, version)),
    });

    if (!updated) {
      throw new Error(`Failed to update evaluator for ${projectId}@${version}`);
    }

    return toVersionRecord(updated);
  }

  async deleteProject(projectId: string): Promise<void> {
    const db = getDb();
    await db.delete(projects).where(eq(projects.id, projectId));
  }
}
