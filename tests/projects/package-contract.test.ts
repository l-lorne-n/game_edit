import { describe, expect, it } from 'vitest';

import { parseGeneratedGamePackage, stringifyManifest } from '@/lib/package/contracts';
import { createTemplatePackage } from '@/lib/package/template';

describe('package contracts', () => {
  it('accepts template package', () => {
    const pkg = createTemplatePackage('Test Runner');
    const parsed = parseGeneratedGamePackage(pkg);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.manifest.title).toContain('Test Runner');
  });

  it('rejects unsupported capability values', () => {
    const pkg = createTemplatePackage('Bad Capability');
    pkg.manifestJson = stringifyManifest({
      title: 'Bad Capability',
      summary: 'contains invalid capability',
      capabilities: ['audio', 'network' as never],
    });

    const parsed = parseGeneratedGamePackage(pkg);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) {
      return;
    }
    expect(parsed.code).toBe('MANIFEST_SCHEMA_INVALID');
  });

  it('accepts manifests that omit editable metadata', () => {
    const pkg = createTemplatePackage('No Editable');
    pkg.manifestJson = JSON.stringify({
      title: 'No Editable',
      summary: 'editable metadata removed',
      capabilities: [],
    });

    const parsed = parseGeneratedGamePackage(pkg);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.manifest.editable).toBeUndefined();
  });

  it('rejects missing required package fields', () => {
    const parsed = parseGeneratedGamePackage({
      indexHtml: '<div />',
      styleCss: '',
      manifestJson: '{}',
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) {
      return;
    }
    expect(parsed.code).toBe('PACKAGE_SCHEMA_INVALID');
  });
});
