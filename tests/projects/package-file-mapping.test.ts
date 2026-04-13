import { describe, expect, it } from 'vitest';

import { filesToGeneratedPackage, packageToCanonicalFiles, snapshotIdFromVersion, versionFromSnapshotId } from '@/lib/projects/package-files';
import { createTemplatePackage } from '@/lib/package/template';

describe('package-file mapping', () => {
  it('round-trips generated package through canonical files', () => {
    const pkg = createTemplatePackage('Round Trip');

    const files = packageToCanonicalFiles(pkg);
    const reconstructed = filesToGeneratedPackage({
      'index.html': files.find(file => file.path === 'index.html')?.content,
      'game.js': files.find(file => file.path === 'game.js')?.content,
      'style.css': files.find(file => file.path === 'style.css')?.content,
      'manifest.json': files.find(file => file.path === 'manifest.json')?.content,
    });

    expect(reconstructed).toEqual(pkg);
  });

  it('fails deterministically when a canonical file is missing', () => {
    expect(() =>
      filesToGeneratedPackage({
        'index.html': '<html></html>',
        'game.js': 'console.log("hi")',
        'style.css': '',
      }),
    ).toThrowError('Missing canonical file: manifest.json');
  });

  it('converts version numbers to stable snapshot ids', () => {
    expect(snapshotIdFromVersion(3)).toBe('v3');
    expect(versionFromSnapshotId('v3')).toBe(3);
    expect(versionFromSnapshotId('legacy-1')).toBeNull();
  });
});
