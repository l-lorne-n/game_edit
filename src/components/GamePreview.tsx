'use client';

import { useEffect, useRef } from 'react';
import { Application } from '@pixi/app';
import { Graphics } from '@pixi/graphics';

import type { GameDsl } from '@/lib/game/dsl';
import { createInitialState, stepGame, type RuntimeState } from '@/lib/runtime/sim';

type HudSnapshot = {
  score: number;
  lives: number;
  timeLeftSec: number;
  status: RuntimeState['status'];
};

type Props = {
  dsl: GameDsl | null;
  onHudChange?: (hud: HudSnapshot) => void;
  runtimeNonce?: number;
};

const emptyInput = { up: false, down: false, left: false, right: false };

function keyToDirection(key: string): keyof typeof emptyInput | null {
  switch (key) {
    case 'ArrowUp':
    case 'w':
    case 'W':
      return 'up';
    case 'ArrowDown':
    case 's':
    case 'S':
      return 'down';
    case 'ArrowLeft':
    case 'a':
    case 'A':
      return 'left';
    case 'ArrowRight':
    case 'd':
    case 'D':
      return 'right';
    default:
      return null;
  }
}

function colorToHex(color: string): number {
  return Number.parseInt(color.replace('#', ''), 16);
}

function drawState(graphics: Graphics, dsl: GameDsl, state: RuntimeState): void {
  graphics.clear();

  graphics.beginFill(colorToHex(dsl.arena.backgroundColor));
  graphics.drawRect(0, 0, dsl.arena.width, dsl.arena.height);
  graphics.endFill();

  for (const collectible of state.collectibles) {
    if (collectible.collected) {
      continue;
    }
    graphics.beginFill(colorToHex(collectible.color));
    graphics.drawCircle(collectible.x, collectible.y, collectible.radius);
    graphics.endFill();
  }

  for (const enemy of state.enemies) {
    graphics.beginFill(colorToHex(enemy.color));
    graphics.drawCircle(enemy.x, enemy.y, enemy.radius);
    graphics.endFill();
  }

  const playerColor =
    state.player.invulnerabilityMs > 0
      ? colorToHex(dsl.theme.accentColor)
      : colorToHex(state.player.color);
  graphics.beginFill(playerColor);
  graphics.drawCircle(state.player.x, state.player.y, state.player.radius);
  graphics.endFill();
}

export default function GamePreview({ dsl, onHudChange, runtimeNonce = 0 }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!dsl || !containerRef.current) {
      return;
    }

    const app = new Application({
      width: dsl.arena.width,
      height: dsl.arena.height,
      antialias: true,
      autoDensity: true,
      resolution: window.devicePixelRatio || 1,
      backgroundColor: colorToHex(dsl.arena.backgroundColor),
    });

    const container = containerRef.current;
    container.innerHTML = '';
    container.appendChild(app.view as HTMLCanvasElement);

    const input = { ...emptyInput };
    const graphics = new Graphics();
    app.stage.addChild(graphics);

    const state = createInitialState(dsl);

    const emitHud = () => {
      onHudChange?.({
        score: state.score,
        lives: state.lives,
        timeLeftSec: state.timeLeftSec,
        status: state.status,
      });
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      const direction = keyToDirection(event.key);
      if (direction) {
        input[direction] = true;
      }
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      const direction = keyToDirection(event.key);
      if (direction) {
        input[direction] = false;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);

    emitHud();
    drawState(graphics, dsl, state);

    const tick = () => {
      stepGame(state, dsl, input, app.ticker.deltaMS);
      drawState(graphics, dsl, state);
      emitHud();
    };

    app.ticker.add(tick);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      app.ticker.remove(tick);
      app.destroy(true, true);
      if (container) {
        container.innerHTML = '';
      }
    };
  }, [dsl, onHudChange, runtimeNonce]);

  return (
    <div
      ref={containerRef}
      style={{
        width: '100%',
        height: '100%',
        borderRadius: 12,
        overflow: 'hidden',
        border: '1px solid var(--border)',
        background: 'var(--panel-2)',
      }}
    />
  );
}
