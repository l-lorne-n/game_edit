import { describe, expect, it } from 'vitest';

import basicDodge from '@/lib/game/fixtures/basic-dodge.json';
import { normalizeDslCandidate, parseSchemaOnly, validateDsl } from '@/lib/game/validate';

describe('dsl validation', () => {
  const yamlStyleModelDsl = {
    version: '1.0',
    meta: {
      title: '星际生存：45秒逃脱',
      description: '太空主题躲避生存游戏。',
      language: 'zh-CN',
    },
    arena: {
      width: 960,
      height: 540,
      background: {
        color: '#050814',
      },
    },
    player: {
      spawn: { x: 480, y: 270 },
      collision: { radius: 12 },
      color: '#7fffd4',
      speed: 260,
      lives: 1,
    },
    enemies: [
      {
        id: 'asteroid_small',
        color: '#8b8f99',
        speed: { min: 120, max: 180 },
        collision: { radius: 10 },
        behavior: { movement: 'linear' },
      },
      {
        id: 'drone_hunter',
        color: '#ff6b6b',
        speed: { min: 100, max: 150 },
        collision: { radius: 11 },
        behavior: { movement: 'seek_player', track_player: true },
      },
    ],
    spawners: [
      {
        id: 'edge_asteroids',
        enemy_ids: ['asteroid_small'],
        interval: { start: 1.2, end: 0.55 },
        max_alive: 18,
      },
      {
        id: 'hunter_wave',
        enemy_ids: ['drone_hunter'],
        interval: { start: 6.0, end: 3.5 },
        max_alive: 4,
      },
    ],
    collectibles: [
      {
        id: 'coin',
        type: 'gold',
        color: '#ffd54a',
        collision: { radius: 7 },
        value: 10,
      },
    ],
    rules: {
      objective: { type: 'survive', duration_seconds: 45 },
      winCondition: { survive_for_seconds: 45 },
      loseCondition: { type: 'player_hit' },
    },
    ui: {
      hud: {
        timer: { visible: true },
        score: { visible: true },
      },
    },
    theme: {
      name: 'space',
      palette: { accent: '#2575fc' },
    },
  };

  const jsonStyleModelDsl = {
    version: '1.0',
    meta: {
      title: '星际金币生存',
      description: '太空主题的俯视角躲避生存游戏。',
      genre: 'top-down dodge-survival',
    },
    arena: {
      size: { width: 960, height: 540 },
      background: { color: '#070b1a' },
    },
    player: {
      x: 480,
      y: 270,
      radius: 12,
      color: '#7dd3fc',
      move_speed: 220,
      lives: 1,
    },
    enemies: [
      { id: 'drone', radius: 10, color: '#fb7185', speed: 120, behavior: 'chase' },
      { id: 'meteor', radius: 14, color: '#f97316', speed: 90, behavior: 'drift' },
    ],
    spawners: [
      { enemy: 'drone', interval: 2.4, maxAlive: 6 },
      { enemy: 'meteor', interval: 3.8, maxAlive: 4 },
    ],
    collectibles: [
      { id: 'coin', radius: 8, color: '#facc15', score: 10 },
    ],
    rules: {
      survivalTime: 45,
      loseCondition: { type: 'player_hit', hits: 1 },
    },
    ui: {
      showTimer: true,
      showScore: true,
      showLives: false,
    },
    theme: {
      background: '#070b1a',
      accent: '#22d3ee',
    },
  };

  const impossibleDsl = null;

  it('accepts valid fixture schema', () => {
    const parsed = parseSchemaOnly(basicDodge);
    expect(parsed.ok).toBe(true);
  });

  it('rejects invalid fixture schema', () => {
    const parsed = parseSchemaOnly(impossibleDsl);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.schema.issues.length).toBeGreaterThan(0);
    }
  });

  it('returns combined validation errors for invalid fixture', () => {
    const checked = validateDsl(impossibleDsl);
    expect(checked.ok).toBe(false);
    if (!checked.ok) {
      expect(checked.validation.schema.valid).toBe(false);
      expect(checked.validation.valid).toBe(false);
    }
  });

  it('normalizes wrapped version aliases before schema parsing', () => {
    const normalized = normalizeDslCandidate({
      dsl: {
        ...basicDodge,
        version: 1,
      },
    });

    const parsed = parseSchemaOnly(normalized);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.dsl.version).toBe('1.0');
    }
  });

  it('maps yaml-style model output into canonical schema', () => {
    const parsed = parseSchemaOnly(yamlStyleModelDsl);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.dsl.arena.backgroundColor).toBe('#050814');
      expect(parsed.dsl.player.start).toEqual({ x: 480, y: 270 });
      expect(parsed.dsl.rules.durationSec).toBe(45);
      expect(parsed.dsl.collectibles[0]?.kind).toBe('coin');
    }

    const checked = validateDsl(yamlStyleModelDsl);
    expect(checked.ok).toBe(true);
  });

  it('maps json-style model output into canonical schema', () => {
    const parsed = parseSchemaOnly(jsonStyleModelDsl);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.dsl.arena.width).toBe(960);
      expect(parsed.dsl.player.start).toEqual({ x: 480, y: 270 });
      expect(parsed.dsl.player.speed).toBe(220);
      expect(parsed.dsl.theme.accentColor).toBe('#22d3ee');
    }

    const checked = validateDsl(jsonStyleModelDsl);
    expect(checked.ok).toBe(true);
  });
});
