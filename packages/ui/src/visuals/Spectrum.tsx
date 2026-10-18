import { useEffect, useRef } from 'react';
import { logBars } from '../audio/beat-detector.js';
import type { VisualizerStyle } from '../prefs/prefs-store.js';
import { useServices } from '../app/services.js';
import { readAccents, useCanvasSize } from './canvas-utils.js';

/**
 * The live audio spectrum, drawn on a canvas from the shared visual bus (one analyser read per frame for every
 * visual). `bars` = rounded log-frequency bars, `wave` = a smooth filled curve, `ring` = bars around a circle.
 * With no real audio data (Web Audio unavailable) it shows a calm idle shimmer instead of nothing.
 * Decorative: `aria-hidden`, the player's own controls carry the meaning.
 */
export function Spectrum({ style, bars = 48, mirror = false, className }: { style: VisualizerStyle; bars?: number; mirror?: boolean; className?: string }) {
  const { visuals } = useServices();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const size = useCanvasSize(canvasRef);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (canvas === null || context === null || context === undefined) return;
    const values = new Float32Array(bars);
    const smooth = new Float32Array(bars);
    let accents = readAccents();
    let frameCount = 0;

    return visuals.subscribe((frame) => {
      const { width, height, dpr } = size.current;
      if (width < 2 || height < 2) return;
      if (frameCount++ % 30 === 0) {
        accents = readAccents();
        canvas.dataset['live'] = frame.synthetic ? 'false' : 'true'; // 'true' = drawing real analyser data
      }
      const count = Math.max(8, Math.round(bars * Math.max(0.5, frame.budget.detail)));
      if (frame.synthetic) {
        for (let i = 0; i < values.length; i += 1) values[i] = 0.12 + 0.1 * Math.sin(frame.nowMs / 420 + i * 0.5);
      } else {
        logBars(frame.bins, frame.binHz, values);
      }
      for (let i = 0; i < values.length; i += 1) {
        const target = Math.min(1, (values[i] as number) * 1.35);
        const previous = smooth[i] as number;
        smooth[i] = target > previous ? previous + (target - previous) * 0.7 : previous + (target - previous) * 0.2;
      }
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.clearRect(0, 0, width, height);
      const [primary, secondary, highlight] = accents;
      const gradient = context.createLinearGradient(0, height, 0, 0);
      gradient.addColorStop(0, `rgba(${secondary}, 0.95)`);
      gradient.addColorStop(0.6, `rgba(${primary}, 0.95)`);
      gradient.addColorStop(1, `rgba(${highlight}, 1)`);
      context.fillStyle = gradient;
      context.strokeStyle = gradient;

      if (style === 'bars') {
        const gap = Math.max(1.5, width / count / 4);
        const barWidth = Math.max(2, (width - gap * (count - 1)) / count);
        for (let i = 0; i < count; i += 1) {
          const value = smooth[Math.floor((i / count) * values.length)] as number;
          const barHeight = Math.max(3, value * height * (mirror ? 0.5 : 1));
          const x = i * (barWidth + gap);
          const radius = Math.min(barWidth / 2, 4);
          context.beginPath();
          if (mirror) context.roundRect(x, height / 2 - barHeight, barWidth, barHeight * 2, radius);
          else context.roundRect(x, height - barHeight, barWidth, barHeight, radius);
          context.fill();
        }
      } else if (style === 'wave') {
        context.beginPath();
        context.moveTo(0, height);
        const step = width / (values.length - 1);
        for (let i = 0; i < values.length; i += 1) {
          const y = height - Math.max(2, (smooth[i] as number) * height * 0.95);
          if (i === 0) context.lineTo(0, y);
          else {
            const px = (i - 1) * step;
            const py = height - Math.max(2, (smooth[i - 1] as number) * height * 0.95);
            context.quadraticCurveTo(px, py, (px + i * step) / 2, (py + y) / 2);
          }
        }
        context.lineTo(width, height);
        context.closePath();
        context.globalAlpha = 0.85;
        context.fill();
        context.globalAlpha = 1;
      } else {
        const radius = Math.min(width, height) * 0.28;
        const cx = width / 2;
        const cy = height / 2;
        const spokes = Math.max(24, count * 2);
        context.lineCap = 'round';
        context.lineWidth = Math.max(2, (Math.PI * 2 * radius) / spokes / 2);
        for (let i = 0; i < spokes; i += 1) {
          const value = smooth[Math.floor((i / spokes) * values.length)] as number;
          const angle = (i / spokes) * Math.PI * 2 - Math.PI / 2;
          const length = radius * 0.15 + value * radius * 0.9;
          context.beginPath();
          context.moveTo(cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius);
          context.lineTo(cx + Math.cos(angle) * (radius + length), cy + Math.sin(angle) * (radius + length));
          context.stroke();
        }
      }
    });
  }, [visuals, style, bars, mirror, size]);

  return <canvas ref={canvasRef} className={className ?? 'nx-spectrum'} aria-hidden="true" data-testid="spectrum" data-style={style} />;
}
