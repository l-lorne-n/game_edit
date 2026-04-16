import {
  type GamePackageManifest,
  type GeneratedGamePackage,
  stringifyManifest,
} from '@/lib/package/contracts';

function sanitizeTitle(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return 'AI Mini Game';
  }
  return trimmed.slice(0, 48);
}

export function createTemplatePackage(seed: string): GeneratedGamePackage {
  const title = sanitizeTitle(seed);
  const manifest: GamePackageManifest = {
    title,
    summary: 'A small browser mini-game scaffold generated as a safe fallback package.',
    capabilities: [],
    notes: 'Fallback package used when model output is missing or invalid.',
  };

  return {
    indexHtml: `
<main id="app">
  <header>
    <h1>${title}</h1>
    <p>Move with WASD/arrow keys. Avoid obstacles and survive.</p>
  </header>
  <canvas id="game" width="960" height="540" aria-label="game-canvas"></canvas>
  <footer>
    <span id="hud">Score: 0 | Time: 45</span>
  </footer>
</main>
`.trim(),
    styleCss: `
html, body {
  margin: 0;
  padding: 0;
  width: 100%;
  height: 100%;
  background: #0d1326;
  color: #e7eefb;
  font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
}

#app {
  display: grid;
  gap: 10px;
  justify-items: center;
  padding: 12px;
}

canvas {
  border: 1px solid #36528d;
  border-radius: 8px;
  background: #121b34;
  max-width: 100%;
  height: auto;
}

header, footer {
  text-align: center;
}
`.trim(),
    gameJs: `
(() => {
  const canvas = document.getElementById('game');
  if (!(canvas instanceof HTMLCanvasElement)) {
    throw new Error('Canvas not found');
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('2D context not available');
  }

  const hud = document.getElementById('hud');
  const keys = new Set();
  const player = { x: 480, y: 270, r: 12, speed: 220 };
  const obstacles = Array.from({ length: 8 }, (_, i) => ({
    x: 120 + i * 90,
    y: 80 + (i % 3) * 120,
    r: 10,
    dx: i % 2 === 0 ? 90 : -90,
  }));

  let score = 0;
  let timeLeft = 45;
  let last = performance.now();
  let finished = false;

  window.addEventListener('keydown', event => keys.add(event.key));
  window.addEventListener('keyup', event => keys.delete(event.key));

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function tick(now) {
    if (finished) {
      return;
    }
    const dt = (now - last) / 1000;
    last = now;
    timeLeft = Math.max(0, timeLeft - dt);

    let vx = 0;
    let vy = 0;
    if (keys.has('ArrowUp') || keys.has('w') || keys.has('W')) vy -= 1;
    if (keys.has('ArrowDown') || keys.has('s') || keys.has('S')) vy += 1;
    if (keys.has('ArrowLeft') || keys.has('a') || keys.has('A')) vx -= 1;
    if (keys.has('ArrowRight') || keys.has('d') || keys.has('D')) vx += 1;

    const len = Math.hypot(vx, vy) || 1;
    player.x = clamp(player.x + (vx / len) * player.speed * dt, player.r, canvas.width - player.r);
    player.y = clamp(player.y + (vy / len) * player.speed * dt, player.r, canvas.height - player.r);

    for (const obstacle of obstacles) {
      obstacle.x += obstacle.dx * dt;
      if (obstacle.x < obstacle.r || obstacle.x > canvas.width - obstacle.r) {
        obstacle.dx *= -1;
      }
      const dx = obstacle.x - player.x;
      const dy = obstacle.y - player.y;
      const hit = dx * dx + dy * dy <= (obstacle.r + player.r) ** 2;
      if (hit) {
        finished = true;
      }
    }

    if (!finished) {
      score += dt * 10;
      if (timeLeft <= 0) {
        finished = true;
      }
    }

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#121b34';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    for (const obstacle of obstacles) {
      ctx.fillStyle = '#ef476f';
      ctx.beginPath();
      ctx.arc(obstacle.x, obstacle.y, obstacle.r, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.fillStyle = '#4cc9f0';
    ctx.beginPath();
    ctx.arc(player.x, player.y, player.r, 0, Math.PI * 2);
    ctx.fill();

    if (hud) {
      const status = finished ? (timeLeft <= 0 ? 'won' : 'lost') : 'running';
      hud.textContent = 'Score: ' + Math.floor(score) + ' | Time: ' + timeLeft.toFixed(1) + ' | ' + status;
    }

    if (!finished) {
      requestAnimationFrame(tick);
    }
  }

  window.runTests = () => {
    const hasCanvas = !!canvas;
    return {
      ok: hasCanvas,
      message: hasCanvas ? 'Canvas initialized.' : 'Canvas missing.',
    };
  };

  requestAnimationFrame(tick);
})();
`.trim(),
    manifestJson: stringifyManifest(manifest),
  };
}
