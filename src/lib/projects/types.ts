import type { GeneratedGamePackage } from '@/lib/package/contracts';
import type { EvaluatorResult } from '@/lib/evaluator/types';
import type { SnapshotStatus } from '@/lib/workspace/types';

export const CANONICAL_PACKAGE_FILE_PATHS = [
  'index.html',
  'game.js',
  'style.css',
  'manifest.json',
] as const;

export type CanonicalPackageFilePath = (typeof CANONICAL_PACKAGE_FILE_PATHS)[number];

export type ProjectSaveSource = 'generate' | 'modify' | 'debug' | 'restore' | 'import' | 'archive';

export type ProjectVersionRecord = {
  projectId: string;
  version: number;
  source: ProjectSaveSource;
  parentVersion: number | null;
  restoredFromVersion: number | null;
  localSnapshotId: string | null;
  evaluator: EvaluatorResult | null;
  status: SnapshotStatus;
  createdAt: string;
};

export type HydratedProjectVersionRecord = ProjectVersionRecord & {
  pkg: GeneratedGamePackage;
};

export type ProjectRecord = {
  id: string;
  ownerId: string;
  name: string;
  currentVersion: number;
  createdAt: string;
  updatedAt: string;
  versions: ProjectVersionRecord[];
};

export type HydratedProjectRecord = Omit<ProjectRecord, 'versions'> & {
  versions: HydratedProjectVersionRecord[];
};

export type CreateProjectInput = {
  id?: string;
  ownerId: string;
  name: string;
};

export type SaveProjectVersionInput = {
  projectId: string;
  pkg: GeneratedGamePackage;
  source: ProjectSaveSource;
  parentVersion: number | null;
  restoredFromVersion?: number | null;
  localSnapshotId?: string | null;
  evaluator?: EvaluatorResult | null;
};

export type ProjectRepository = {
  createProject(input: CreateProjectInput): Promise<ProjectRecord>;
  listProjects(): Promise<ProjectRecord[]>;
  getProject(projectId: string): Promise<ProjectRecord | null>;
  insertVersion(input: Omit<SaveProjectVersionInput, 'pkg'> & { version: number }): Promise<ProjectVersionRecord>;
  updateCurrentVersion(projectId: string, version: number): Promise<void>;
  updateVersionEvaluation(projectId: string, version: number, evaluator: EvaluatorResult | null): Promise<ProjectVersionRecord>;
  deleteProject(projectId: string): Promise<void>;
};
