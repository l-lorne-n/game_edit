import { ZodError } from 'zod';

import { gameDslSchema, type GameDsl } from '@/lib/game/dsl';
import { validateRules, type RuleValidationResult, type ValidationIssue } from '@/lib/game/rules';
import { runSmokeSimulation, type SmokeResult } from '@/lib/game/smoke';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') {
    return value;
  }
  return undefined;
}

function asString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalizeVersion(value: unknown): unknown {
  if (value === 1 || value === 1.0) {
    return '1.0';
  }

  if (typeof value !== 'string') {
    return value;
  }

  const normalized = value.trim().toLowerCase();
  if (
    normalized === '1' ||
    normalized === '1.0' ||
    normalized === 'v1' ||
    normalized === 'v1.0' ||
    normalized === '1.0.0'
  ) {
    return '1.0';
  }

  return value;
}

function normalizeColor(value: unknown, fallback: string): string {
  const text = asString(value);
  if (text && /^#([0-9a-fA-F]{6})$/.test(text)) {
    return text;
  }
  return fallback;
}

function pointFrom(value: unknown): { x: number; y: number } | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const x = asNumber(value.x);
  const y = asNumber(value.y);
  if (x == null || y == null) {
    return undefined;
  }
  return { x, y };
}

function choosePoint(...candidates: unknown[]): { x: number; y: number } | undefined {
  for (const candidate of candidates) {
    const point = pointFrom(candidate);
    if (point) {
      return point;
    }
  }
  return undefined;
}

function chooseNumber(...candidates: unknown[]): number | undefined {
  for (const candidate of candidates) {
    const num = asNumber(candidate);
    if (num != null) {
      return num;
    }
  }
  return undefined;
}

function chooseString(...candidates: unknown[]): string | undefined {
  for (const candidate of candidates) {
    const text = asString(candidate);
    if (text) {
      return text;
    }
  }
  return undefined;
}

function chooseBoolean(...candidates: unknown[]): boolean | undefined {
  for (const candidate of candidates) {
    const flag = asBoolean(candidate);
    if (flag != null) {
      return flag;
    }
  }
  return undefined;
}

function inferEnemySpeed(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return clamp(value, 20, 420);
  }

  if (isRecord(value)) {
    const min = chooseNumber(value.min, value.start, value.base);
    const max = chooseNumber(value.max, value.end, value.peak);
    const picked = max ?? min ?? 120;
    return clamp(picked, 20, 420);
  }

  return 120;
}

function inferRadius(entity: Record<string, unknown>, fallback: number): number {
  const collision = isRecord(entity.collision) ? entity.collision : undefined;
  const size = isRecord(entity.size) ? entity.size : undefined;

  const direct = chooseNumber(entity.radius, collision?.radius);
  if (direct != null) {
    return clamp(direct, 4, 40);
  }

  const width = chooseNumber(size?.width, entity.size);
  const height = chooseNumber(size?.height);
  const derived = width != null || height != null ? Math.max(width ?? 0, height ?? 0) / 2 : fallback;
  return clamp(derived || fallback, 4, 40);
}

function inferPlayerStart(player: Record<string, unknown>, width: number, height: number) {
  return (
    choosePoint(player.start, player.spawn, player.position, { x: player.x, y: player.y }) ?? {
      x: width / 2,
      y: height / 2,
    }
  );
}

function defaultEnemySpawn(index: number, width: number, height: number) {
  const points = [
    { x: 40, y: 40 },
    { x: width - 40, y: 40 },
    { x: 40, y: height - 40 },
    { x: width - 40, y: height - 40 },
  ];
  return points[index % points.length];
}

function defaultCollectibleSpawn(index: number, width: number, height: number) {
  const points = [
    { x: width * 0.25, y: height * 0.3 },
    { x: width * 0.75, y: height * 0.4 },
    { x: width * 0.5, y: height * 0.7 },
  ];
  return points[index % points.length];
}

function makeSyntheticEnemy(id: string, index: number, width: number, height: number) {
  const colors = ['#ff5d73', '#f97316', '#b388ff', '#8b8f99'];
  return {
    id,
    radius: 10 + (index % 3) * 2,
    color: colors[index % colors.length],
    speed: 120 + (index % 3) * 30,
    spawn: defaultEnemySpawn(index, width, height),
    damage: 1,
    behavior: 'seek' as const,
  };
}

function unwrapRoot(input: Record<string, unknown>): Record<string, unknown> {
  if (isRecord(input.dsl)) {
    return input.dsl;
  }
  if (isRecord(input.game)) {
    return input.game;
  }
  return input;
}

function adaptToCanonicalDsl(source: Record<string, unknown>): Record<string, unknown> {
  const root = unwrapRoot(source);

  const arena = isRecord(root.arena) ? root.arena : {};
  const arenaSize = isRecord(arena.size) ? arena.size : {};
  const arenaBackground = isRecord(arena.background) ? arena.background : {};
  const arenaBounds = isRecord(arena.bounds) ? arena.bounds : {};

  const width = clamp(
    chooseNumber(arena.width, arenaSize.width, arenaBounds.right, 960) ?? 960,
    320,
    1920,
  );
  const height = clamp(
    chooseNumber(arena.height, arenaSize.height, arenaBounds.bottom, 540) ?? 540,
    240,
    1080,
  );

  const player = isRecord(root.player) ? root.player : {};
  const playerCollision = isRecord(player.collision) ? player.collision : {};
  const playerStart = inferPlayerStart(player, width, height);

  const theme = isRecord(root.theme) ? root.theme : {};
  const themePalette = isRecord(theme.palette) ? theme.palette : {};

  const enemyInputs = Array.isArray(root.enemies) ? root.enemies.filter(isRecord) : [];
  const canonicalEnemies = enemyInputs.map((enemy, index) => ({
    id: chooseString(enemy.id, enemy.type, `enemy-${index + 1}`) ?? `enemy-${index + 1}`,
    radius: inferRadius(enemy, 12),
    color: normalizeColor(enemy.color, '#ff5d73'),
    speed: inferEnemySpeed(enemy.speed),
    spawn: choosePoint(enemy.spawn, enemy.position) ?? defaultEnemySpawn(index, width, height),
    damage: clamp(chooseNumber(enemy.damage, enemy.damage_on_contact, 1) ?? 1, 1, 3),
    behavior: 'seek' as const,
  }));

  const spawnerInputs = Array.isArray(root.spawners) ? root.spawners.filter(isRecord) : [];
  const canonicalSpawners = spawnerInputs.map((spawner, index) => {
    const interval = isRecord(spawner.interval) ? spawner.interval : {};
    const enemyIds = Array.isArray(spawner.enemy_ids)
      ? spawner.enemy_ids.map(asString).filter((value): value is string => Boolean(value))
      : [];

    return {
      id: chooseString(spawner.id, `spawner-${index + 1}`) ?? `spawner-${index + 1}`,
      intervalMs: clamp(
        Math.round((chooseNumber(spawner.intervalMs, spawner.interval, interval.start, 1.8) ?? 1.8) * 1000),
        500,
        8000,
      ),
      maxAlive: clamp(chooseNumber(spawner.maxAlive, spawner.max_alive, 8) ?? 8, 0, 100),
      templateEnemyId:
        chooseString(
          spawner.templateEnemyId,
          spawner.template_enemy_id,
          spawner.enemy_id,
          spawner.enemy,
          enemyIds[0],
          canonicalEnemies[index]?.id,
          canonicalEnemies[0]?.id,
        ) ??
        `enemy-${index + 1}`,
      area: {
        xMin: 0,
        xMax: width,
        yMin: 0,
        yMax: height,
      },
    };
  });

  const enemyMap = new Map(canonicalEnemies.map(enemy => [enemy.id, enemy]));
  for (const [index, spawner] of canonicalSpawners.entries()) {
    if (!enemyMap.has(spawner.templateEnemyId)) {
      enemyMap.set(
        spawner.templateEnemyId,
        makeSyntheticEnemy(spawner.templateEnemyId, index, width, height),
      );
    }
  }

  const ensuredEnemies = Array.from(enemyMap.values());

  if (ensuredEnemies.length === 0) {
    ensuredEnemies.push(makeSyntheticEnemy('default-seeker', 0, width, height));
  }

  const ensuredSpawners = canonicalSpawners.length > 0
    ? canonicalSpawners
    : [
        {
          id: 'default-spawner',
          intervalMs: 1800,
          maxAlive: 8,
          templateEnemyId: ensuredEnemies[0].id,
          area: {
            xMin: 0,
            xMax: width,
            yMin: 0,
            yMax: height,
          },
        },
      ];

  const collectibleInputs = Array.isArray(root.collectibles)
    ? root.collectibles.filter(isRecord)
    : [];
  const canonicalCollectibles = collectibleInputs.map((collectible, index) => ({
    id: chooseString(collectible.id, `coin-${index + 1}`) ?? `coin-${index + 1}`,
    kind: 'coin' as const,
    radius: clamp(inferRadius(collectible, 8), 4, 30),
    color: normalizeColor(collectible.color, '#f4d35e'),
    value: clamp(chooseNumber(collectible.value, collectible.score, 10) ?? 10, 1, 100),
    spawn:
      choosePoint(collectible.spawn, collectible.position) ?? defaultCollectibleSpawn(index, width, height),
  }));

  const rules = isRecord(root.rules) ? root.rules : {};
  const rulesObjective = isRecord(rules.objective) ? rules.objective : {};
  const rulesWin = isRecord(rules.winCondition) ? rules.winCondition : {};
  const rulesLose = isRecord(rules.loseCondition) ? rules.loseCondition : {};
  const ui = isRecord(root.ui) ? root.ui : {};
  const uiHud = isRecord(ui.hud) ? ui.hud : {};
  const uiHudTimer = isRecord(uiHud.timer) ? uiHud.timer : {};
  const uiHudScore = isRecord(uiHud.score) ? uiHud.score : {};
  const uiHudLives = isRecord(uiHud.lives) ? uiHud.lives : {};

  const durationSec = clamp(
    Math.round(
      chooseNumber(
        rules.durationSec,
        rulesObjective.duration_seconds,
        rulesWin.survive_for_seconds,
        rulesWin.duration,
        rules.survivalTime,
        45,
      ) ?? 45,
    ),
    10,
    300,
  );

  const startingLives = clamp(
    Math.round(chooseNumber(rules.startingLives, player.lives, rulesLose.hits, 1) ?? 1),
    1,
    9,
  );

  const scoreTarget = chooseNumber(rulesWin.scoreTarget, rules.targetScore, rules.score_target);

  return {
    version: normalizeVersion(root.version ?? root.dslVersion ?? '1.0'),
    meta: {
      title: chooseString(root.meta && isRecord(root.meta) ? root.meta.title : undefined, root.title, 'Generated Dodge Prototype') ?? 'Generated Dodge Prototype',
      description:
        chooseString(
          root.meta && isRecord(root.meta) ? root.meta.description : undefined,
          root.description,
          'AI-generated dodge survival prototype.',
        ) ?? 'AI-generated dodge survival prototype.',
    },
    arena: {
      width,
      height,
      backgroundColor: normalizeColor(
        arena.backgroundColor ?? arenaBackground.color ?? theme.background ?? themePalette.bg,
        '#101820',
      ),
    },
    player: {
      radius: clamp(inferRadius({ ...player, collision: playerCollision }, 14), 6, 36),
      color: normalizeColor(player.color ?? themePalette.player, '#7bdff2'),
      speed: clamp(chooseNumber(player.speed, player.move_speed, 220) ?? 220, 60, 520),
      start: {
        x: clamp(playerStart.x, 0, width),
        y: clamp(playerStart.y, 0, height),
      },
      maxInvulnerabilityMs: clamp(
        Math.round(chooseNumber(player.maxInvulnerabilityMs, player.invulnerabilityMs, 800) ?? 800),
        0,
        2000,
      ),
    },
    enemies: ensuredEnemies,
    spawners: ensuredSpawners,
    collectibles: canonicalCollectibles,
    rules: {
      durationSec,
      startingLives,
      winCondition:
        scoreTarget != null
          ? {
              type: 'scoreAtLeast' as const,
              scoreTarget: clamp(Math.round(scoreTarget), 1, 1000),
            }
          : { type: 'survive' as const },
      loseCondition: {
        type: 'livesDepleted' as const,
      },
    },
    ui: {
      showTimer: chooseBoolean(ui.showTimer, ui.show_timer, uiHudTimer.visible, true) ?? true,
      showScore: chooseBoolean(ui.showScore, ui.show_score, uiHudScore.visible, true) ?? true,
      showLives: chooseBoolean(ui.showLives, ui.show_lives, uiHudLives.visible, player.lives != null) ?? true,
    },
    theme: {
      name: chooseString(theme.name, root.meta && isRecord(root.meta) ? root.meta.genre : undefined, 'Generated') ?? 'Generated',
      accentColor: normalizeColor(theme.accentColor ?? theme.accent ?? themePalette.accent ?? player.color, '#00a6fb'),
    },
  };
}

export function normalizeDslCandidate(input: unknown): unknown {
  if (!isRecord(input)) {
    return input;
  }

  const root = unwrapRoot(input);
  const canonical = adaptToCanonicalDsl(root);
  return canonical;
}

export type SchemaValidationResult = {
  valid: boolean;
  issues: ValidationIssue[];
};

export type CombinedValidationResult = {
  schema: SchemaValidationResult;
  rules: RuleValidationResult;
  smoke: SmokeResult;
  valid: boolean;
};

export type ValidatedDslResult =
  | {
      ok: true;
      dsl: GameDsl;
      validation: CombinedValidationResult;
    }
  | {
      ok: false;
      validation: CombinedValidationResult;
    };

function issuesFromZod(error: ZodError): ValidationIssue[] {
  return error.issues.map(issue => ({
    code: 'SCHEMA_ERROR',
    path: issue.path.join('.') || 'root',
    message: issue.message,
  }));
}

export function parseDslUnsafe(input: unknown): GameDsl {
  return gameDslSchema.parse(normalizeDslCandidate(input));
}

export function parseSchemaOnly(input: unknown): { ok: true; dsl: GameDsl; schema: SchemaValidationResult } | { ok: false; schema: SchemaValidationResult } {
  const parsed = gameDslSchema.safeParse(normalizeDslCandidate(input));

  if (!parsed.success) {
    return {
      ok: false,
      schema: {
        valid: false,
        issues: issuesFromZod(parsed.error),
      },
    };
  }

  return {
    ok: true,
    dsl: parsed.data,
    schema: {
      valid: true,
      issues: [],
    },
  };
}

export function validateDsl(input: unknown, smokeTicks = 600): ValidatedDslResult {
  const schemaResult = parseSchemaOnly(input);

  if (!schemaResult.ok) {
    return {
      ok: false,
      validation: {
        schema: schemaResult.schema,
        rules: { valid: false, issues: [] },
        smoke: {
          valid: false,
          issues: ['Smoke simulation skipped due to schema failure.'],
          snapshot: {
            elapsedSec: 0,
            enemiesSpawned: 0,
            score: 0,
            lives: 0,
            status: 'lost',
          },
        },
        valid: false,
      },
    };
  }

  const rules = validateRules(schemaResult.dsl);
  const smoke = rules.valid
    ? runSmokeSimulation(schemaResult.dsl, smokeTicks)
    : {
        valid: false,
        issues: ['Smoke simulation skipped due to rule validation failure.'],
        snapshot: {
          elapsedSec: 0,
          enemiesSpawned: 0,
          score: 0,
          lives: schemaResult.dsl.rules.startingLives,
          status: 'running' as const,
        },
      };

  const validation: CombinedValidationResult = {
    schema: schemaResult.schema,
    rules,
    smoke,
    valid: schemaResult.schema.valid && rules.valid && smoke.valid,
  };

  if (!validation.valid) {
    return {
      ok: false,
      validation,
    };
  }

  return {
    ok: true,
    dsl: schemaResult.dsl,
    validation,
  };
}
