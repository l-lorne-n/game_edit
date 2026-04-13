import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTemplatePackage } from '@/lib/package/template';
import { createProjectService } from '@/lib/projects/service';
import type { CreateProjectInput, ProjectRecord, ProjectRepository, ProjectVersionRecord, SaveProjectVersionInput } from '@/lib/projects/types';
import { resetProviderCache } from '@/lib/storage/providers';

class InMemoryProjectRepository implements ProjectRepository {
  private readonly projects = new Map<string, ProjectRecord>();

  async createProject(input: CreateProjectInput): Promise<ProjectRecord> {
    const project: ProjectRecord = {
      id: input.id ?? `proj-${this.projects.size + 1}`,
      ownerId: input.ownerId,
      name: input.name,
      currentVersion: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      versions: [],
    };
    this.projects.set(project.id, project);
    return structuredClone(project);
  }

  async listProjects(): Promise<ProjectRecord[]> {
    return [...this.projects.values()].map(project => structuredClone(project));
  }

  async getProject(projectId: string): Promise<ProjectRecord | null> {
    const project = this.projects.get(projectId);
    return project ? structuredClone(project) : null;
  }

  async insertVersion(input: Omit<SaveProjectVersionInput, 'pkg'> & { version: number }): Promise<ProjectVersionRecord> {
    const project = this.projects.get(input.projectId);
    if (!project) {
      throw new Error(`Missing project ${input.projectId}`);
    }
    const version: ProjectVersionRecord = {
      projectId: input.projectId,
      version: input.version,
      source: input.source,
      parentVersion: input.parentVersion,
      restoredFromVersion: input.restoredFromVersion ?? null,
      localSnapshotId: input.localSnapshotId ?? null,
      evaluator: input.evaluator ?? null,
      status: input.evaluator ? (input.evaluator.ok ? 'passed' : 'failed') : 'unknown',
      createdAt: new Date().toISOString(),
    };
    project.versions = [version, ...project.versions];
    project.updatedAt = new Date().toISOString();
    return structuredClone(version);
  }

  async updateCurrentVersion(projectId: string, version: number): Promise<void> {
    const project = this.projects.get(projectId);
    if (!project) {
      throw new Error(`Missing project ${projectId}`);
    }
    project.currentVersion = version;
    project.updatedAt = new Date().toISOString();
  }

  async updateVersionEvaluation(projectId: string, version: number, evaluator: ProjectVersionRecord['evaluator']): Promise<ProjectVersionRecord> {
    const project = this.projects.get(projectId);
    if (!project) {
      throw new Error(`Missing project ${projectId}`);
    }
    const record = project.versions.find(item => item.version === version);
    if (!record) {
      throw new Error(`Missing version ${projectId}@${version}`);
    }
    record.evaluator = evaluator;
    record.status = evaluator ? (evaluator.ok ? 'passed' : 'failed') : 'unknown';
    return structuredClone(record);
  }

  async deleteProject(projectId: string): Promise<void> {
    this.projects.delete(projectId);
  }
}

describe('project version service', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'game-edit-service-'));
    process.env.LOCAL_STORAGE_PATH = tempDir;
    process.env.STORAGE_PROVIDER = 'local';
    process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3000';
    resetProviderCache();
  });

  afterEach(async () => {
    delete process.env.LOCAL_STORAGE_PATH;
    delete process.env.STORAGE_PROVIDER;
    delete process.env.NEXT_PUBLIC_APP_URL;
    resetProviderCache();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('writes a new version and advances the current head', async () => {
    const service = createProjectService(new InMemoryProjectRepository());
    const project = await service.createProject({ name: 'Service Test' });
    const pkg = createTemplatePackage('v1');

    const updated = await service.saveGeneratedPackage({
      projectId: project.id,
      pkg,
      source: 'generate',
      parentVersion: null,
    });

    expect(updated.currentVersion).toBe(1);
    expect(updated.versions[0]?.version).toBe(1);
    expect(updated.versions[0]?.pkg).toEqual(pkg);
  });

  it('restores a previous version into a new head', async () => {
    const service = createProjectService(new InMemoryProjectRepository());
    const project = await service.createProject({ name: 'Restore Test' });
    const pkg1 = createTemplatePackage('Version 1');
    const v1 = await service.saveGeneratedPackage({
      projectId: project.id,
      pkg: pkg1,
      source: 'generate',
      parentVersion: null,
    });

    const pkg2 = createTemplatePackage('Version 2');
    pkg2.gameJs = 'console.log("version 2")';
    await service.saveGeneratedPackage({
      projectId: v1.id,
      pkg: pkg2,
      source: 'modify',
      parentVersion: 1,
    });

    const restored = await service.restoreVersion(v1.id, 1);
    expect(restored.currentVersion).toBe(3);
    expect(restored.versions[0]?.restoredFromVersion).toBe(1);
    expect(restored.versions[0]?.pkg).toEqual(pkg1);
  });

  it('deletes stored files when deleting a project', async () => {
    const service = createProjectService(new InMemoryProjectRepository());
    const project = await service.createProject({ name: 'Delete Test' });
    const pkg = createTemplatePackage('Delete Me');

    const updated = await service.saveGeneratedPackage({
      projectId: project.id,
      pkg,
      source: 'generate',
      parentVersion: null,
    });

    await service.deleteProject(updated.id);

    const files = await fs.readdir(tempDir, { recursive: true }).catch(() => []);
    expect(files.some(file => String(file).includes(updated.id))).toBe(false);
  });
});
