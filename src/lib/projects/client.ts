'use client';

import type { EvaluatorResult } from '@/lib/evaluator/types';
import type { GeneratedGamePackage } from '@/lib/package/contracts';
import type { HydratedProjectRecord, ProjectSaveSource } from '@/lib/projects/types';

async function parseJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

export async function listProjects(): Promise<HydratedProjectRecord[]> {
  const response = await fetch('/api/projects', { cache: 'no-store' });
  const json = await parseJson<{ ok: boolean; projects?: HydratedProjectRecord[]; error?: string }>(response);
  if (!response.ok || !json.ok || !json.projects) {
    throw new Error(json.error ?? `Failed to list projects (${response.status})`);
  }
  return json.projects;
}

export async function getProject(projectId: string): Promise<HydratedProjectRecord> {
  const response = await fetch(`/api/projects/${projectId}`, { cache: 'no-store' });
  const json = await parseJson<{ ok: boolean; project?: HydratedProjectRecord; error?: string }>(response);
  if (!response.ok || !json.ok || !json.project) {
    throw new Error(json.error ?? `Failed to load project ${projectId}`);
  }
  return json.project;
}

export async function createProject(name: string): Promise<HydratedProjectRecord> {
  const response = await fetch('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  const json = await parseJson<{ ok: boolean; project?: HydratedProjectRecord; error?: string }>(response);
  if (!response.ok || !json.ok || !json.project) {
    throw new Error(json.error ?? 'Failed to create project');
  }
  return json.project;
}

export async function deleteProject(projectId: string): Promise<void> {
  const response = await fetch(`/api/projects/${projectId}`, { method: 'DELETE' });
  const json = await parseJson<{ ok: boolean; error?: string }>(response);
  if (!response.ok || !json.ok) {
    throw new Error(json.error ?? `Failed to delete project ${projectId}`);
  }
}

export async function saveProjectPackage(input: {
  projectId: string;
  pkg: GeneratedGamePackage;
  source: ProjectSaveSource;
  parentVersion?: number | null;
  restoredFromVersion?: number | null;
  localSnapshotId?: string | null;
  evaluator?: EvaluatorResult | null;
}): Promise<HydratedProjectRecord> {
  const response = await fetch(`/api/projects/${input.projectId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const json = await parseJson<{ ok: boolean; project?: HydratedProjectRecord; error?: string }>(response);
  if (!response.ok || !json.ok || !json.project) {
    throw new Error(json.error ?? `Failed to save project package for ${input.projectId}`);
  }
  return json.project;
}

export async function updateProjectEvaluation(input: {
  projectId: string;
  version: number;
  evaluator: EvaluatorResult | null;
}): Promise<HydratedProjectRecord> {
  const response = await fetch(`/api/projects/${input.projectId}/evaluation`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ version: input.version, evaluator: input.evaluator }),
  });
  const json = await parseJson<{ ok: boolean; project?: HydratedProjectRecord; error?: string }>(response);
  if (!response.ok || !json.ok || !json.project) {
    throw new Error(json.error ?? `Failed to update evaluation for ${input.projectId}@${input.version}`);
  }
  return json.project;
}

export async function restoreProjectVersion(projectId: string, version: number): Promise<HydratedProjectRecord> {
  const response = await fetch(`/api/projects/${projectId}/restore`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ version }),
  });
  const json = await parseJson<{ ok: boolean; project?: HydratedProjectRecord; error?: string }>(response);
  if (!response.ok || !json.ok || !json.project) {
    throw new Error(json.error ?? `Failed to restore version ${version}`);
  }
  return json.project;
}
