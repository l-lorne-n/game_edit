import { copy as blobCopy, del as blobDel, head as blobHead, list as blobList, put as blobPut } from '@vercel/blob';

import type { PutOptions, StorageFileEntry, StorageProvider } from '@/lib/storage/types';

export class VercelBlobProvider implements StorageProvider {
  readonly name = 'blob';

  async put(path: string, content: string | Buffer, options?: PutOptions): Promise<string> {
    const blob = await blobPut(path, content, {
      access: 'public',
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: options?.contentType,
    });
    return blob.url;
  }

  async get(path: string): Promise<string | null> {
    try {
      const blobInfo = await blobHead(path);
      if (!blobInfo) {
        return null;
      }

      const response = await fetch(blobInfo.url);
      if (!response.ok) {
        return null;
      }

      return await response.text();
    } catch {
      return null;
    }
  }

  async del(path: string): Promise<void> {
    await blobDel(path);
  }

  async delPrefix(prefix: string): Promise<void> {
    const files = await this.list(prefix);
    if (files.length === 0) {
      return;
    }

    await Promise.all(files.map(file => blobDel(`${prefix}/${file.path}`)));
  }

  async list(prefix: string): Promise<StorageFileEntry[]> {
    const files: StorageFileEntry[] = [];
    let cursor: string | undefined;

    do {
      const result = await blobList({ prefix, cursor });
      files.push(
        ...result.blobs.map(blob => ({
          path: blob.pathname.replace(`${prefix}/`, ''),
          url: blob.url,
          size: blob.size,
        })),
      );
      cursor = result.hasMore ? result.cursor : undefined;
    } while (cursor);

    return files;
  }

  async head(path: string): Promise<string | null> {
    try {
      const blobInfo = await blobHead(path);
      return blobInfo?.url ?? null;
    } catch {
      return null;
    }
  }

  async copy(sourcePath: string, destPath: string): Promise<string> {
    const source = await blobHead(sourcePath);
    if (!source) {
      throw new Error(`Source blob not found: ${sourcePath}`);
    }

    const result = await blobCopy(source.url, destPath, {
      access: 'public',
      addRandomSuffix: false,
    });

    return result.url;
  }
}
