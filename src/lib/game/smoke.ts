import type { GameDsl } from '@/lib/game/dsl';
import { createInitialState, hasNonFiniteNumbers, stepGame, type InputState } from '@/lib/runtime/sim';

export type SmokeResult = {
  valid: boolean;
  issues: string[];
  snapshot: {
    elapsedSec: number;
    enemiesSpawned: number;
    score: number;
    lives: number;
    status: 'running' | 'won' | 'lost';
  };
};

function autopilotInput(tick: number): InputState {
  const phase = tick % 240;
  if (phase < 60) {
    return { up: false, down: false, left: false, right: true };
  }
  if (phase < 120) {
    return { up: false, down: true, left: false, right: false };
  }
  if (phase < 180) {
    return { up: false, down: false, left: true, right: false };
  }
  return { up: true, down: false, left: false, right: false };
}

export function runSmokeSimulation(dsl: GameDsl, ticks = 600): SmokeResult {
  const state = createInitialState(dsl);
  const issues: string[] = [];
  const initialEnemyCount = state.enemies.length;
  const hadInitialEnemies = initialEnemyCount > 0;

  if (state.status !== 'running') {
    issues.push('Game must start in running state.');
  }

  if (state.lives <= 0) {
    issues.push('Game starts with non-positive lives.');
  }

  for (let i = 0; i < ticks; i += 1) {
    const input = autopilotInput(i);
    stepGame(state, dsl, input, 1000 / 60);

    if (hasNonFiniteNumbers(state)) {
      issues.push(`Non-finite runtime number detected at tick ${i}.`);
      break;
    }
  }

  if (state.elapsedMs < 1000) {
    issues.push('Simulation did not progress beyond 1 second.');
  }

  if (state.lives <= 0 && state.elapsedMs < 1000) {
    issues.push('Immediate unavoidable death in first second.');
  }

  const spawnedFromSpawners = Object.values(state.spawners).reduce(
    (sum, spawner) => sum + spawner.spawnedCount,
    0,
  );

  if (!hadInitialEnemies && spawnedFromSpawners === 0 && dsl.spawners.length > 0) {
    issues.push('No enemy was spawned during smoke simulation.');
  }

  return {
    valid: issues.length === 0,
    issues,
    snapshot: {
      elapsedSec: Number((state.elapsedMs / 1000).toFixed(2)),
      enemiesSpawned: spawnedFromSpawners,
      score: state.score,
      lives: state.lives,
      status: state.status,
    },
  };
}
