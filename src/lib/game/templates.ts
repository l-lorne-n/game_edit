import basicDodge from '@/lib/game/fixtures/basic-dodge.json';
import coinsAndTimer from '@/lib/game/fixtures/coins-and-timer.json';
import { gameDslSchema, type GameDsl } from '@/lib/game/dsl';

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function inferTitle(prompt: string): string {
  const trimmed = prompt.trim();
  if (trimmed.length < 6) {
    return 'AI Dodge Prototype';
  }
  return trimmed.slice(0, 50);
}

export function createTemplateFromPrompt(prompt: string): GameDsl {
  const lower = prompt.toLowerCase();
  const raw = lower.includes('coin') || lower.includes('score') ? clone(coinsAndTimer) : clone(basicDodge);
  const base = gameDslSchema.parse(raw);

  base.meta.title = inferTitle(prompt);
  base.meta.description = `Generated from prompt: ${prompt.slice(0, 180)}`;

  if (lower.includes('hard') || lower.includes('difficult')) {
    for (const enemy of base.enemies) {
      enemy.speed = Math.min(enemy.speed + 40, 420);
    }
    for (const spawner of base.spawners) {
      spawner.intervalMs = Math.max(700, spawner.intervalMs - 300);
    }
  }

  if (lower.includes('easy')) {
    for (const enemy of base.enemies) {
      enemy.speed = Math.max(60, enemy.speed - 30);
    }
    for (const spawner of base.spawners) {
      spawner.intervalMs = Math.min(2600, spawner.intervalMs + 300);
    }
  }

  if (lower.includes('dark')) {
    base.arena.backgroundColor = '#0b132b';
    base.theme.accentColor = '#5bc0be';
  }

  if (lower.includes('bright')) {
    base.arena.backgroundColor = '#1f2937';
    base.theme.accentColor = '#fbbf24';
  }

  return gameDslSchema.parse(base);
}

export function getDefaultLastKnownGood(): GameDsl {
  return gameDslSchema.parse(clone(basicDodge));
}
