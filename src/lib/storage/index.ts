import { getProvider } from './providers';

export type { PutOptions, StorageFileEntry, StorageProvider } from './types';

function getVersionPath(projectId: string, version: number): string {
  return `projects/${projectId}/v${version}`;
}

function getFilePath(projectId: string, version: number, filePath: string): string {
  const cleanPath = filePath.startsWith('/') ? filePath.slice(1) : filePath;
  return `${getVersionPath(projectId, version)}/${cleanPath}`;
}

export async function writeFile(projectId: string, version: number, filePath: string, content: string): Promise<string> {
  return getProvider().put(getFilePath(projectId, version, filePath), content);
}

export async function readFile(projectId: string, version: number, filePath: string): Promise<string | null> {
  return getProvider().get(getFilePath(projectId, version, filePath));
}

export async function listFiles(projectId: string, version: number) {
  return getProvider().list(getVersionPath(projectId, version));
}

export async function deleteFile(projectId: string, version: number, filePath: string): Promise<void> {
  await getProvider().del(getFilePath(projectId, version, filePath));
}

export async function deleteProjectFiles(projectId: string): Promise<void> {
  await getProvider().delPrefix(`projects/${projectId}`);
}

export async function copyVersion(projectId: string, fromVersion: number, toVersion: number): Promise<void> {
  const files = await listFiles(projectId, fromVersion);
  await Promise.all(
    files.map(file => getProvider().copy(getFilePath(projectId, fromVersion, file.path), getFilePath(projectId, toVersion, file.path))),
  );
}

export async function getPreviewUrl(projectId: string, version: number): Promise<string | null> {
  return getProvider().head(getFilePath(projectId, version, 'index.html'));
}

export function getStoragePath(projectId: string, version: number, filePath: string): string {
  return getFilePath(projectId, version, filePath);
}
