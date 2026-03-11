import { describe, expect, it } from 'vitest';

import { evaluatePackageStatic } from '@/lib/evaluator/static';
import { createTemplatePackage } from '@/lib/package/template';

describe('static evaluator', () => {
  it('passes valid template package', () => {
    const pkg = createTemplatePackage('Evaluator Test');
    const result = evaluatePackageStatic(pkg);
    expect(result.ok).toBe(true);
    expect(result.code).toBe('STATIC_OK');
  });

  it('fails malformed manifest JSON', () => {
    const pkg = createTemplatePackage('Broken Manifest');
    pkg.manifestJson = '{bad-json';
    const result = evaluatePackageStatic(pkg);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('MANIFEST_JSON_INVALID');
  });

  it('fails invalid JavaScript syntax', () => {
    const pkg = createTemplatePackage('Broken JS');
    pkg.gameJs = 'function () {';
    const result = evaluatePackageStatic(pkg);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('SYNTAX_ERROR');
  });
});
