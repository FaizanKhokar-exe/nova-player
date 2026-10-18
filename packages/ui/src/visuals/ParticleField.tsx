import { useEffect, useRef } from 'react';
import { useServices } from '../app/services.js';
import { readAccents, useCanvasSize } from './canvas-utils.js';
import { createParticles, stepParticles, type ParticleSystem } from './particles.js';

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

const BASE_COUNT = 110;

/**
 * Lyrics Mode's moving backdrop: glowing particles that drift with the music and burst on every beat. Draws from the
 * shared visual bus; its particle count and glow follow the performance mode, and it simply is not running when no
 * music plays or the window is hidden. With reduced motion it shows a still, dim field instead.
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
    let system: ParticleSystem | undefined;
    let systemCount = 0;
    let last: number | undefined;
    let frames = 0;

    return visuals.subscribe((frame) => {
      const { width, height, dpr } = size.current;
      if (width < 2 || height < 2) return;
      if (frames++ % 90 === 0) sprites = readAccents().map(makeSprite); // the accents follow the cover
      const wanted = Math.max(24, Math.round(BASE_COUNT * frame.budget.detail));
      if (system === undefined || systemCount !== wanted) {
        system = createParticles(wanted, width, height);
        systemCount = wanted;
      }
      const dt = last === undefined ? 0.016 : (frame.nowMs - last) / 1000;
      last = frame.nowMs;
      stepParticles(system, { dt: reduceMotion ? 0 : dt, level: frame.levels.level, pulse: frame.levels.pulse, beat: !reduceMotion && frame.levels.beat, width, height });

      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.clearRect(0, 0, width, height);
      context.globalCompositeOperation = frame.budget.glow ? 'lighter' : 'source-over';
      for (let i = 0; i < system.count; i += 1) {
        const depth = system.depth[i] as number;
        const glow = system.glow[i] as number;
        const radius = ((system.size[i] as number) * (1 + glow * 1.6 + frame.levels.pulse * 0.25)) * 2.2;
        context.globalAlpha = Math.min(1, (0.16 + depth * 0.4 + glow * 0.5) * (reduceMotion ? 0.6 : 1));
        const sprite = sprites[system.tint[i] as number];
        if (sprite !== undefined) context.drawImage(sprite, (system.x[i] as number) - radius, (system.y[i] as number) - radius, radius * 2, radius * 2);
      }
      context.globalAlpha = 1;
      context.globalCompositeOperation = 'source-over';
    });
  }, [visuals, size, reduceMotion]);

  return <canvas ref={canvasRef} className="nx-np-canvas" aria-hidden="true" data-testid="particle-field" />;
}
