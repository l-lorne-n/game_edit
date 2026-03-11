import type { GameDsl } from '@/lib/game/dsl';

export type InputState = {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
};

export type RuntimeStatus = 'running' | 'won' | 'lost';

export type EnemyState = {
  id: string;
  templateId: string;
  x: number;
  y: number;
  radius: number;
  speed: number;
  damage: number;
  color: string;
};

export type CollectibleState = {
  id: string;
  x: number;
  y: number;
  radius: number;
  value: number;
  color: string;
  collected: boolean;
};

type SpawnerRuntimeState = {
  elapsedMs: number;
  spawnedCount: number;
};

export type RuntimeState = {
  status: RuntimeStatus;
  elapsedMs: number;
  timeLeftSec: number;
  score: number;
  lives: number;
  player: {
    x: number;
    y: number;
    radius: number;
    color: string;
    speed: number;
    invulnerabilityMs: number;
  };
  enemies: EnemyState[];
  collectibles: CollectibleState[];
  spawners: Record<string, SpawnerRuntimeState>;
};

const EPSILON = 0.00001;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function distSq(a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

function hashString(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function randomFromSeed(seed: number): number {
  const x = Math.sin(seed) * 10000;
  return x - Math.floor(x);
}

function spawnPosition(
  area: { xMin: number; xMax: number; yMin: number; yMax: number },
  spawnerId: string,
  index: number,
): { x: number; y: number } {
  const base = hashString(`${spawnerId}:${index}`);
  const rx = randomFromSeed(base + 17);
  const ry = randomFromSeed(base + 31);
  return {
    x: area.xMin + rx * (area.xMax - area.xMin),
    y: area.yMin + ry * (area.yMax - area.yMin),
  };
}

function normalize(x: number, y: number): { x: number; y: number } {
  const mag = Math.sqrt(x * x + y * y);
  if (mag <= EPSILON) {
    return { x: 0, y: 0 };
  }
  return { x: x / mag, y: y / mag };
}

function getEnemyTemplateById(dsl: GameDsl, id: string) {
  return dsl.enemies.find(enemy => enemy.id === id);
}

function clampPlayer(state: RuntimeState, dsl: GameDsl): void {
  const minX = state.player.radius;
  const minY = state.player.radius;
  const maxX = dsl.arena.width - state.player.radius;
  const maxY = dsl.arena.height - state.player.radius;

  state.player.x = clamp(state.player.x, minX, maxX);
  state.player.y = clamp(state.player.y, minY, maxY);
}

function spawnEnemies(state: RuntimeState, dsl: GameDsl, deltaMs: number): void {
  for (const spawner of dsl.spawners) {
    const stateKey = spawner.id;
    if (!state.spawners[stateKey]) {
      state.spawners[stateKey] = { elapsedMs: 0, spawnedCount: 0 };
    }
    const runtime = state.spawners[stateKey];
    runtime.elapsedMs += deltaMs;

    while (runtime.elapsedMs >= spawner.intervalMs) {
      runtime.elapsedMs -= spawner.intervalMs;
      if (state.enemies.length >= spawner.maxAlive) {
        continue;
      }

      const template = getEnemyTemplateById(dsl, spawner.templateEnemyId);
      if (!template) {
        continue;
      }

      const pos = spawnPosition(spawner.area, spawner.id, runtime.spawnedCount);
      runtime.spawnedCount += 1;

      state.enemies.push({
        id: `${spawner.id}:${runtime.spawnedCount}`,
        templateId: template.id,
        x: clamp(pos.x, 0, dsl.arena.width),
        y: clamp(pos.y, 0, dsl.arena.height),
        radius: template.radius,
        speed: template.speed,
        damage: template.damage,
        color: template.color,
      });
    }
  }
}

function updateEnemies(state: RuntimeState, dsl: GameDsl, deltaSec: number): void {
  for (const enemy of state.enemies) {
    const dir = normalize(state.player.x - enemy.x, state.player.y - enemy.y);
    enemy.x += dir.x * enemy.speed * deltaSec;
    enemy.y += dir.y * enemy.speed * deltaSec;

    enemy.x = clamp(enemy.x, enemy.radius, dsl.arena.width - enemy.radius);
    enemy.y = clamp(enemy.y, enemy.radius, dsl.arena.height - enemy.radius);
  }
}

function handleCollectibles(state: RuntimeState): void {
  for (const collectible of state.collectibles) {
    if (collectible.collected) {
      continue;
    }
    const collides =
      distSq(
        { x: collectible.x, y: collectible.y },
        { x: state.player.x, y: state.player.y },
      ) <=
      (collectible.radius + state.player.radius) ** 2;
    if (collides) {
      collectible.collected = true;
      state.score += collectible.value;
    }
  }
}

function handleEnemyCollisions(state: RuntimeState, dsl: GameDsl): void {
  if (state.player.invulnerabilityMs > 0) {
    return;
  }

  const survivors: EnemyState[] = [];
  for (const enemy of state.enemies) {
    const collides =
      distSq({ x: enemy.x, y: enemy.y }, { x: state.player.x, y: state.player.y }) <=
      (enemy.radius + state.player.radius) ** 2;

    if (collides) {
      state.lives -= enemy.damage;
      state.player.invulnerabilityMs = dsl.player.maxInvulnerabilityMs;
      continue;
    }

    survivors.push(enemy);
  }

  state.enemies = survivors;
}

function updateGameEnd(state: RuntimeState, dsl: GameDsl): void {
  if (state.lives <= 0) {
    state.status = 'lost';
    return;
  }

  const win = dsl.rules.winCondition;
  if (win.type === 'scoreAtLeast' && (win.scoreTarget ?? Infinity) <= state.score) {
    state.status = 'won';
    return;
  }

  if (state.timeLeftSec <= 0) {
    if (win.type === 'survive') {
      state.status = 'won';
    } else {
      state.status = state.score >= (win.scoreTarget ?? Infinity) ? 'won' : 'lost';
    }
  }
}

export function createInitialState(dsl: GameDsl): RuntimeState {
  const spawners: Record<string, SpawnerRuntimeState> = {};
  for (const spawner of dsl.spawners) {
    spawners[spawner.id] = { elapsedMs: 0, spawnedCount: 0 };
  }

  return {
    status: 'running',
    elapsedMs: 0,
    timeLeftSec: dsl.rules.durationSec,
    score: 0,
    lives: dsl.rules.startingLives,
    player: {
      x: dsl.player.start.x,
      y: dsl.player.start.y,
      radius: dsl.player.radius,
      color: dsl.player.color,
      speed: dsl.player.speed,
      invulnerabilityMs: 0,
    },
    enemies: dsl.enemies.map(enemy => ({
      id: `seed:${enemy.id}`,
      templateId: enemy.id,
      x: enemy.spawn.x,
      y: enemy.spawn.y,
      radius: enemy.radius,
      speed: enemy.speed,
      damage: enemy.damage,
      color: enemy.color,
    })),
    collectibles: dsl.collectibles.map(collectible => ({
      id: collectible.id,
      x: collectible.spawn.x,
      y: collectible.spawn.y,
      radius: collectible.radius,
      value: collectible.value,
      color: collectible.color,
      collected: false,
    })),
    spawners,
  };
}

export function stepGame(
  state: RuntimeState,
  dsl: GameDsl,
  input: InputState,
  deltaMs: number,
): RuntimeState {
  if (state.status !== 'running') {
    return state;
  }

  const deltaSec = deltaMs / 1000;
  state.elapsedMs += deltaMs;
  state.timeLeftSec = Math.max(0, dsl.rules.durationSec - state.elapsedMs / 1000);

  const moveX = (input.right ? 1 : 0) - (input.left ? 1 : 0);
  const moveY = (input.down ? 1 : 0) - (input.up ? 1 : 0);
  const move = normalize(moveX, moveY);
  state.player.x += move.x * state.player.speed * deltaSec;
  state.player.y += move.y * state.player.speed * deltaSec;
  clampPlayer(state, dsl);

  spawnEnemies(state, dsl, deltaMs);
  updateEnemies(state, dsl, deltaSec);
  handleCollectibles(state);
  handleEnemyCollisions(state, dsl);

  if (state.player.invulnerabilityMs > 0) {
    state.player.invulnerabilityMs = Math.max(0, state.player.invulnerabilityMs - deltaMs);
  }

  updateGameEnd(state, dsl);
  return state;
}

export function hasNonFiniteNumbers(state: RuntimeState): boolean {
  const allNumbers: number[] = [
    state.elapsedMs,
    state.timeLeftSec,
    state.score,
    state.lives,
    state.player.x,
    state.player.y,
    state.player.speed,
  ];

  for (const enemy of state.enemies) {
    allNumbers.push(enemy.x, enemy.y, enemy.radius, enemy.speed, enemy.damage);
  }

  for (const collectible of state.collectibles) {
    allNumbers.push(collectible.x, collectible.y, collectible.radius, collectible.value);
  }

  return allNumbers.some(value => !Number.isFinite(value));
}
