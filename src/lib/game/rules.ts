import type { GameDsl } from '@/lib/game/dsl';

export type ValidationIssue = {
  code: string;
  path: string;
  message: string;
};

export type RuleValidationResult = {
  valid: boolean;
  issues: ValidationIssue[];
};

function inBounds(x: number, y: number, width: number, height: number): boolean {
  return x >= 0 && y >= 0 && x <= width && y <= height;
}

export function validateRules(dsl: GameDsl): RuleValidationResult {
  const issues: ValidationIssue[] = [];
  const width = dsl.arena.width;
  const height = dsl.arena.height;

  if (!inBounds(dsl.player.start.x, dsl.player.start.y, width, height)) {
    issues.push({
      code: 'PLAYER_OUT_OF_BOUNDS',
      path: 'player.start',
      message: 'Player start position must be inside the arena.',
    });
  }

  if (dsl.enemies.length === 0 && dsl.spawners.length === 0) {
    issues.push({
      code: 'NO_ENEMIES',
      path: 'enemies',
      message: 'At least one enemy template or spawner is required.',
    });
  }

  const enemyTemplateIds = new Set(dsl.enemies.map(enemy => enemy.id));
  for (const spawner of dsl.spawners) {
    if (!enemyTemplateIds.has(spawner.templateEnemyId)) {
      issues.push({
        code: 'SPAWNER_TEMPLATE_MISSING',
        path: `spawners.${spawner.id}.templateEnemyId`,
        message: `Spawner references unknown template '${spawner.templateEnemyId}'.`,
      });
    }

    if (spawner.area.xMin > spawner.area.xMax || spawner.area.yMin > spawner.area.yMax) {
      issues.push({
        code: 'SPAWNER_AREA_INVALID',
        path: `spawners.${spawner.id}.area`,
        message: 'Spawner area min values must be <= max values.',
      });
    }

    if (!inBounds(spawner.area.xMin, spawner.area.yMin, width, height)) {
      issues.push({
        code: 'SPAWNER_AREA_OUT_OF_BOUNDS',
        path: `spawners.${spawner.id}.area`,
        message: 'Spawner area min bounds must be inside arena.',
      });
    }

    if (!inBounds(spawner.area.xMax, spawner.area.yMax, width, height)) {
      issues.push({
        code: 'SPAWNER_AREA_OUT_OF_BOUNDS',
        path: `spawners.${spawner.id}.area`,
        message: 'Spawner area max bounds must be inside arena.',
      });
    }
  }

  for (const coin of dsl.collectibles) {
    if (!inBounds(coin.spawn.x, coin.spawn.y, width, height)) {
      issues.push({
        code: 'COLLECTIBLE_OUT_OF_BOUNDS',
        path: `collectibles.${coin.id}.spawn`,
        message: 'Collectible spawn position must be inside arena.',
      });
    }
  }

  for (const enemy of dsl.enemies) {
    if (!inBounds(enemy.spawn.x, enemy.spawn.y, width, height)) {
      issues.push({
        code: 'ENEMY_OUT_OF_BOUNDS',
        path: `enemies.${enemy.id}.spawn`,
        message: 'Enemy spawn position must be inside arena.',
      });
    }
  }

  if (dsl.rules.winCondition.type === 'scoreAtLeast' && dsl.collectibles.length === 0) {
    issues.push({
      code: 'SCORE_WITHOUT_COLLECTIBLES',
      path: 'rules.winCondition',
      message: 'scoreAtLeast win condition requires at least one collectible.',
    });
  }

  return {
    valid: issues.length === 0,
    issues,
  };
}
