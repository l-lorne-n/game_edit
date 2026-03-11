import { describe, expect, it } from 'vitest';

import basicDodge from '@/lib/game/fixtures/basic-dodge.json';
import { runSmokeSimulation } from '@/lib/game/smoke';
import { parseSchemaOnly } from '@/lib/game/validate';

describe('smoke simulation', () => {
  it('marks basic fixture playable', () => {
    const parsed = parseSchemaOnly(basicDodge);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }

    const smoke = runSmokeSimulation(parsed.dsl, 600);
    expect(smoke.valid).toBe(true);
    expect(smoke.snapshot.elapsedSec).toBeGreaterThan(1);
  });
});
