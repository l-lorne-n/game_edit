import type { GeneratedGamePackage } from '@/lib/package/contracts';

import {
  CANONICAL_PACKAGE_FILE_PATHS,
  type CanonicalPackageFilePath,
} from '@/lib/projects/types';

export type CanonicalPackageFile = {
  path: CanonicalPackageFilePath;
  content: string;
  contentType: string;
};

export const CANONICAL_PACKAGE_FILE_METADATA: Record<CanonicalPackageFilePath, { key: keyof GeneratedGamePackage; contentType: string }> = {
  'index.html': { key: 'indexHtml', contentType: 'text/html; charset=utf-8' },
  'game.js': { key: 'gameJs', contentType: 'application/javascript; charset=utf-8' },
  'style.css': { key: 'styleCss', contentType: 'text/css; charset=utf-8' },
  'manifest.json': { key: 'manifestJson', contentType: 'application/json; charset=utf-8' },
};

export function packageToCanonicalFiles(pkg: GeneratedGamePackage): CanonicalPackageFile[] {
  return CANONICAL_PACKAGE_FILE_PATHS.map(path => ({
    path,
    content: pkg[CANONICAL_PACKAGE_FILE_METADATA[path].key],
    contentType: CANONICAL_PACKAGE_FILE_METADATA[path].contentType,
  }));
}

export function filesToGeneratedPackage(files: Partial<Record<CanonicalPackageFilePath, string>>): GeneratedGamePackage {
  for (const path of CANONICAL_PACKAGE_FILE_PATHS) {
    if (typeof files[path] !== 'string') {
      throw new Error(`Missing canonical file: ${path}`);
    }
  }

  return {
    indexHtml: files['index.html'] ?? '',
    gameJs: files['game.js'] ?? '',
    styleCss: files['style.css'] ?? '',
    manifestJson: files['manifest.json'] ?? '',
  };
}

export function isCanonicalPackageFilePath(path: string): path is CanonicalPackageFilePath {
  return CANONICAL_PACKAGE_FILE_PATHS.includes(path as CanonicalPackageFilePath);
}

export function snapshotIdFromVersion(version: number): string {
  return `v${version}`;
}

export function versionFromSnapshotId(snapshotId: string): number | null {
  const match = /^v(\d+)$/.exec(snapshotId);
  if (!match) {
    return null;
  }
  return Number.parseInt(match[1], 10);
}
