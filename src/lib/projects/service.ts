import {
  copyVersion,
  deleteProjectFiles,
  deleteFile,
  listFiles,
  readFile,
  writeFile,
} from '@/lib/storage';
import {
  filesToGeneratedPackage,
  isCanonicalPackageFilePath,
  packageToCanonicalFiles,
} from '@/lib/projects/package-files';
import { DrizzleProjectRepository } from '@/lib/projects/repository';
import type {
  CanonicalPackageFilePath,
  CreateProjectInput,
  HydratedProjectRecord,
  HydratedProjectVersionRecord,
  ProjectRecord,
  ProjectRepository,
  SaveProjectVersionInput,
} from '@/lib/projects/types';
import type { EvaluatorResult } from '@/lib/evaluator/types';

const DEFAULT_OWNER_ID = 'local-user';

export type ProjectService = ReturnType<typeof createProjectService>;

export function createProjectService(repository: ProjectRepository = new DrizzleProjectRepository()) {
  async function hydrateVersion(projectId: string, version: number, metadata: ProjectRecord['versions'][number]): Promise<HydratedProjectVersionRecord> {
    const listedFiles = await listFiles(projectId, version);
    const fileContents: Partial<Record<CanonicalPackageFilePath, string>> = {};

    await Promise.all(
      listedFiles.map(async file => {
        if (!isCanonicalPackageFilePath(file.path)) {
          return;
        }

        const content = await readFile(projectId, version, file.path);
        if (typeof content === 'string') {
          fileContents[file.path] = content;
        }
      }),
    );

      return {
        ...metadata,
        status: metadata.evaluator ? (metadata.evaluator.ok ? 'passed' : 'failed') : metadata.status,
        pkg: filesToGeneratedPackage(fileContents),
      };
  }

  async function hydrateProject(project: ProjectRecord): Promise<HydratedProjectRecord> {
    const versions = await Promise.all(
      project.versions.map(version => hydrateVersion(project.id, version.version, version)),
    );

    return {
      ...project,
      versions,
    };
  }

  async function cleanupVersionFiles(projectId: string, version: number): Promise<void> {
    await Promise.all(
      ['index.html', 'game.js', 'style.css', 'manifest.json'].map(filePath =>
        deleteFile(projectId, version, filePath).catch(() => undefined),
      ),
    );
  }

  async function getProjectOrThrow(projectId: string): Promise<ProjectRecord> {
    const project = await repository.getProject(projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }
    return project;
  }

  async function persistVersion(input: SaveProjectVersionInput): Promise<HydratedProjectRecord> {
    const project = await getProjectOrThrow(input.projectId);
    const version = project.currentVersion + 1;
    const files = packageToCanonicalFiles(input.pkg);

    try {
      await Promise.all(files.map(file => writeFile(input.projectId, version, file.path, file.content)));
      await repository.insertVersion({ ...input, version });
      await repository.updateCurrentVersion(input.projectId, version);
    } catch (error) {
      await cleanupVersionFiles(input.projectId, version).catch(() => undefined);
      throw error;
    }

    return hydrateProject((await getProjectOrThrow(input.projectId)));
  }

  return {
    async listProjects(): Promise<HydratedProjectRecord[]> {
      const projects = await repository.listProjects();
      return Promise.all(projects.map(project => hydrateProject(project)));
    },

    async getProject(projectId: string): Promise<HydratedProjectRecord | null> {
      const project = await repository.getProject(projectId);
      return project ? hydrateProject(project) : null;
    },

    async createProject(input: Omit<CreateProjectInput, 'ownerId'> & { ownerId?: string }): Promise<HydratedProjectRecord> {
      const created = await repository.createProject({
        id: input.id,
        ownerId: input.ownerId ?? DEFAULT_OWNER_ID,
        name: input.name,
      });
      return hydrateProject(created);
    },

    async deleteProject(projectId: string): Promise<void> {
      await deleteProjectFiles(projectId);
      await repository.deleteProject(projectId);
    },

    async saveGeneratedPackage(input: SaveProjectVersionInput): Promise<HydratedProjectRecord> {
      return persistVersion(input);
    },

    async restoreVersion(projectId: string, targetVersion: number): Promise<HydratedProjectRecord> {
      const project = await getProjectOrThrow(projectId);

      if (targetVersion < 1 || targetVersion >= project.currentVersion) {
        throw new Error('Can only restore to a previous version.');
      }

      const targetExists = project.versions.some(version => version.version === targetVersion);
      if (!targetExists) {
        throw new Error(`Target version not found: ${targetVersion}`);
      }

      const nextVersion = project.currentVersion + 1;
      await copyVersion(projectId, targetVersion, nextVersion);
      await repository.insertVersion({
        projectId,
        version: nextVersion,
        source: 'restore',
        parentVersion: targetVersion,
        restoredFromVersion: targetVersion,
        localSnapshotId: null,
        evaluator: null,
      });
      await repository.updateCurrentVersion(projectId, nextVersion);
      return hydrateProject((await getProjectOrThrow(projectId)));
    },

    async updateVersionEvaluation(projectId: string, version: number, evaluator: EvaluatorResult | null): Promise<HydratedProjectRecord> {
      await repository.updateVersionEvaluation(projectId, version, evaluator);
      return hydrateProject(await getProjectOrThrow(projectId));
    },

    async writeSingleFile(projectId: string, filePath: CanonicalPackageFilePath, content: string): Promise<HydratedProjectRecord> {
      const project = await hydrateProject(await getProjectOrThrow(projectId));
      if (!project) {
        throw new Error(`Project not found: ${projectId}`);
      }

      const current = project.versions.find(version => version.version === project.currentVersion);
      const basePackage = current?.pkg;
      if (!basePackage) {
        throw new Error('Current package is not available.');
      }

      const nextPackage = {
        ...basePackage,
        ...(filePath === 'index.html' ? { indexHtml: content } : {}),
        ...(filePath === 'game.js' ? { gameJs: content } : {}),
        ...(filePath === 'style.css' ? { styleCss: content } : {}),
        ...(filePath === 'manifest.json' ? { manifestJson: content } : {}),
      };

      return persistVersion({
        projectId,
        pkg: nextPackage,
        source: 'modify',
        parentVersion: project.currentVersion || null,
      });
    },

    async readProjectFile(projectId: string, version: number, filePath: CanonicalPackageFilePath): Promise<string | null> {
      return readFile(projectId, version, filePath);
    },

    async listProjectFiles(projectId: string, version: number) {
      const files = await listFiles(projectId, version);
      const fileMap: Record<string, string> = {};
      for (const file of files) {
        fileMap[file.path] = file.url;
      }
      return { files: fileMap, fileList: files };
    },
  };
}
