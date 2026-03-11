import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { validateDsl } from '@/lib/game/validate';

function parseArgs() {
  const fixtureFlagIndex = process.argv.indexOf('--fixture');
  const fixture =
    fixtureFlagIndex >= 0 && process.argv[fixtureFlagIndex + 1]
      ? process.argv[fixtureFlagIndex + 1]
      : 'basic-dodge';
  return { fixture };
}

async function main() {
  const { fixture } = parseArgs();
  const fixturePath = path.resolve(process.cwd(), 'src/lib/game/fixtures', `${fixture}.json`);
  const file = await readFile(fixturePath, 'utf8');
  const input = JSON.parse(file) as unknown;

  const checked = validateDsl(input);
  if (!checked.ok) {
    console.error('NOT_PLAYABLE');
    console.error(JSON.stringify(checked.validation, null, 2));
    process.exit(1);
  }

  console.log('PLAYABLE');
  console.log(JSON.stringify(checked.validation.smoke.snapshot, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
