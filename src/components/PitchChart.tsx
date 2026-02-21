import { useEffect, useMemo, useRef } from 'react';
import type { ReactElement } from 'react';
import type { PitchPoint } from '../types/project';

interface PitchChartProps {
  points: PitchPoint[];
}

export function PitchChart({ points }: PitchChartProps): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const scale = useMemo(() => {
    const midiValues = points
      .map((point) => point.midi)
      .filter((value): value is number => value !== null);

    const maxTime = points.at(-1)?.timeSec ?? 1;
    const minMidi = midiValues.length > 0 ? Math.min(...midiValues) - 1 : 48;
    const maxMidi = midiValues.length > 0 ? Math.max(...midiValues) + 1 : 72;
    return {
      maxTime: Math.max(1, maxTime),
      minMidi,
      maxMidi,
    };
  }, [points]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const { width, height } = canvas;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, width, height);

    ctx.strokeStyle = '#1e293b';
    for (let i = 1; i < 6; i += 1) {
      const y = (height / 6) * i;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }

    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 2;

    let open = false;
    for (const point of points) {
      if (point.midi === null) {
        open = false;
        continue;
      }

      const x = (point.timeSec / scale.maxTime) * width;
      const y = height - ((point.midi - scale.minMidi) / (scale.maxMidi - scale.minMidi)) * height;
      if (!open) {
        ctx.beginPath();
        ctx.moveTo(x, y);
        open = true;
      } else {
        ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    ctx.fillStyle = '#94a3b8';
    ctx.font = '12px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillText('Pitch (MIDI + cents)', 8, 18);
  }, [points, scale.maxMidi, scale.maxTime, scale.minMidi]);

  return <canvas ref={canvasRef} width={700} height={180} className="pitch-chart" />;
}
