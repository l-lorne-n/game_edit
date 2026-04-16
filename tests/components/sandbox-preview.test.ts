import { describe, expect, it } from 'vitest';

import { buildSandboxDoc } from '@/components/SandboxPreview';

describe('buildSandboxDoc', () => {
  it('inlines package assets and storage shim into srcdoc', () => {
    const doc = buildSandboxDoc({
      indexHtml: '<main><button id="start-button">Start</button></main>',
      gameJs: 'window.__gameLoaded = true;',
      styleCss: 'button { color: red; }',
      manifestJson: '{"title":"Demo","summary":"Demo","editable":[],"capabilities":[]}',
    });

    expect(doc).toContain('<style>button { color: red; }</style>');
    expect(doc).toContain('window.__gameLoaded = true;');
    expect(doc).toContain("installFallback('localStorage')");
    expect(doc).toContain("installFallback('sessionStorage')");
  });
});
