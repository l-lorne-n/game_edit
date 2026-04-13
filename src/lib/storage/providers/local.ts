import fs from 'node:fs/promises';
import path from 'node:path';

import { getLocalStoragePath } from '@/lib/config/infra';
import type { PutOptions, StorageFileEntry, StorageProvider } from '@/lib/storage/types';

const CONTENT_TYPE_BY_EXTENSION: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function normalizeLogicalPath(logicalPath: string): string {
  return logicalPath.replace(/^\/+/, '').replace(/\\/g, '/');
}

export function getLocalStorageRoot(): string {
  return getLocalStoragePath() ?? path.join(process.cwd(), '.storage');
}

export function getLocalPublicBaseUrl(): string {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL?.trim() || 'http://localhost:3000';
  return `${baseUrl}/api/storage`;
}

export function resolveLocalAbsolutePath(logicalPath: string): string {
  return path.join(getLocalStorageRoot(), normalizeLogicalPath(logicalPath));
}

async function deleteEmptyParents(startDir: string, stopDir: string): Promise<void> {
  let currentDir = startDir;
  const normalizedStop = path.resolve(stopDir);

  while (path.resolve(currentDir).startsWith(normalizedStop) && path.resolve(currentDir) !== normalizedStop) {
    try {
      const entries = await fs.readdir(currentDir);
      if (entries.length > 0) {
        return;
      }
      await fs.rmdir(currentDir);
      currentDir = path.dirname(currentDir);
    } catch {
      return;
    }
  }
}

function resolveMetaPath(logicalPath: string): string {
  return `${resolveLocalAbsolutePath(logicalPath)}.__meta__`;
}

function inferContentType(logicalPath: string): string {
  return CONTENT_TYPE_BY_EXTENSION[path.extname(logicalPath)] ?? 'application/octet-stream';
}

export async function readLocalStoredFile(logicalPath: string): Promise<{
  body: Buffer;
  contentType: string;
} | null> {
  try {
    const body = await fs.readFile(resolveLocalAbsolutePath(logicalPath));
    let contentType = inferContentType(logicalPath);
    try {
      const rawMeta = await fs.readFile(resolveMetaPath(logicalPath), 'utf-8');
      const parsed = JSON.parse(rawMeta) as { contentType?: unknown };
      if (typeof parsed.contentType === 'string' && parsed.contentType.trim()) {
        contentType = parsed.contentType;
      }
    } catch {
      // sidecar metadata is optional
    }

    return { body, contentType };
  } catch {
    return null;
  }
}

async function walkDir(dir: string, prefix: string, results: StorageFileEntry[]): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name.endsWith('.__meta__')) {
      continue;
    }

    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkDir(fullPath, prefix, results);
      continue;
    }

    const stat = await fs.stat(fullPath);
    const relativePath = path.relative(resolveLocalAbsolutePath(prefix), fullPath).replace(/\\/g, '/');
    results.push({
      path: relativePath,
      url: `${getLocalPublicBaseUrl()}/${normalizeLogicalPath(`${prefix}/${relativePath}`)}`,
      size: stat.size,
      contentType: inferContentType(relativePath),
    });
  }
}

export class LocalProvider implements StorageProvider {
  readonly name = 'local';

  async put(logicalPath: string, content: string | Buffer, options?: PutOptions): Promise<string> {
    const normalized = normalizeLogicalPath(logicalPath);
    const absolutePath = resolveLocalAbsolutePath(normalized);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });

    if (typeof content === 'string') {
      await fs.writeFile(absolutePath, content, 'utf-8');
    } else {
      await fs.writeFile(absolutePath, content);
    }

    await fs.writeFile(
      resolveMetaPath(normalized),
      JSON.stringify({ contentType: options?.contentType ?? inferContentType(normalized) }),
      'utf-8',
    );

    return `${getLocalPublicBaseUrl()}/${normalized}`;
  }

  async get(logicalPath: string): Promise<string | null> {
    try {
      return await fs.readFile(resolveLocalAbsolutePath(logicalPath), 'utf-8');
    } catch {
      return null;
    }
  }

  async del(logicalPath: string): Promise<void> {
    const absolutePath = resolveLocalAbsolutePath(logicalPath);
    await fs.unlink(absolutePath).catch(() => undefined);
    await fs.unlink(resolveMetaPath(logicalPath)).catch(() => undefined);
    await deleteEmptyParents(path.dirname(absolutePath), getLocalStorageRoot()).catch(() => undefined);
  }

  async delPrefix(prefix: string): Promise<void> {
    const absolutePath = resolveLocalAbsolutePath(prefix);
    await fs.rm(absolutePath, { recursive: true, force: true }).catch(() => undefined);
  }

  async list(prefix: string): Promise<StorageFileEntry[]> {
    const files: StorageFileEntry[] = [];
    await walkDir(resolveLocalAbsolutePath(prefix), prefix, files).catch(() => undefined);
    return files;
  }

  async head(logicalPath: string): Promise<string | null> {
    try {
      await fs.access(resolveLocalAbsolutePath(logicalPath));
      return `${getLocalPublicBaseUrl()}/${normalizeLogicalPath(logicalPath)}`;
    } catch {
      return null;
    }
  }

  async copy(sourcePath: string, destPath: string): Promise<string> {
    const sourceAbsolute = resolveLocalAbsolutePath(sourcePath);
    const destAbsolute = resolveLocalAbsolutePath(destPath);
    await fs.mkdir(path.dirname(destAbsolute), { recursive: true });
    await fs.copyFile(sourceAbsolute, destAbsolute);
    await fs.copyFile(resolveMetaPath(sourcePath), resolveMetaPath(destPath)).catch(() => undefined);
    return `${getLocalPublicBaseUrl()}/${normalizeLogicalPath(destPath)}`;
  }
}
