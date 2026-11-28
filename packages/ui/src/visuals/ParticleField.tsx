import { useEffect, useRef } from 'react';
import { useServices } from '../app/services.js';
import { readAccents, useCanvasSize } from './canvas-utils.js';
import { aliveCount, createParticles, particleAlpha, stepParticles } from './particles.js';

/** A soft round sprite in one accent colour, drawn once and reused for every particle (no per-frame gradients). */
function makeSprite(rgb: string): HTMLCanvasElement {
  const sprite = document.createElement('canvas');
  sprite.width = sprite.height = 64;
  const context = sprite.getContext('2d');
  if (context !== null) {
    const gradient = context.createRadialGradient(32, 32, 0, 32, 32, 32);
    gradient.addColorStop(0, `rgba(${rgb}, 1)`);
    gradient.addColorStop(0.35, `rgba(${rgb}, 0.55)`);
    gradient.addColorStop(1, `rgba(${rgb}, 0)`);
    context.fillStyle = gradient;
    context.fillRect(0, 0, 64, 64);
  }
  return sprite;
}

const POOL = 160;

/**
 * Lyrics Mode's backdrop: glowing particles released by the music's beats and nothing else. Each detected beat sends out a
 * burst (bigger for a harder hit) that flies outward and fades; with no beat the field stays empty. Draws from the shared
 * visual bus; the burst size follows the performance mode, and it is not running when no music plays or the window is
 * hidden. With reduced motion it draws nothing.
 */
export function ParticleField({ reduceMotion = false }: { reduceMotion?: boolean }) {
  const { visuals } = useServices();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const size = useCanvasSize(canvasRef);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (canvas === null || context === null || context === undefined) return;
    let sprites = readAccents().map(makeSprite);
    const system = createParticles(POOL);
    let last: number | undefined;
    let frames = 0;
    let wasDrawing = false;

    return visuals.subscribe((frame) => {
      const { width, height, dpr } = size.current;
      if (width < 2 || height < 2) return;
      if (frames++ % 90 === 0) sprites = readAccents().map(makeSprite); // the accents follow the cover
      const dt = last === undefined ? 0.016 : (frame.nowMs - last) / 1000;
      last = frame.nowMs;
      if (reduceMotion) return;
      stepParticles(system, { dt, beat: frame.levels.beat, strength: frame.levels.pulse, detail: frame.budget.detail, width, height });

      const drawing = aliveCount(system) > 0;
      if (!drawing && !wasDrawing) return; // an empty field costs nothing
      wasDrawing = drawing;
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.clearRect(0, 0, width, height);
      context.globalCompositeOperation = frame.budget.glow ? 'lighter' : 'source-over';
      for (let i = 0; i < system.count; i += 1) {
        const life = system.life[i] as number;
        if (life <= 0) continue;
        const depth = system.depth[i] as number;
        const radius = (system.size[i] as number) * (1.4 + (1 - life) * 0.5) * 2.2;
        context.globalAlpha = Math.min(1, particleAlpha(life) * (0.28 + depth * 0.3 + (system.strength[i] as number) * 0.4));
        const sprite = sprites[system.tint[i] as number];
        if (sprite !== undefined) context.drawImage(sprite, (system.x[i] as number) - radius, (system.y[i] as number) - radius, radius * 2, radius * 2);
      }
      context.globalAlpha = 1;
      context.globalCompositeOperation = 'source-over';
    });
  }, [visuals, size, reduceMotion]);

  return <canvas ref={canvasRef} className="nx-np-canvas" aria-hidden="true" data-testid="particle-field" />;
}
