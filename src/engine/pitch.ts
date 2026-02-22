import { PitchDetector } from 'pitchy';
import type { PitchPoint } from '../types/project';
import { audioBufferToWavBlob } from '../audio/wav';
import { clamp } from '../audio/utils';

const hzToMidi = (hz: number): number => 69 + 12 * Math.log2(hz / 440);

const median = (values: number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
};

const smoothMedian = (values: Array<number | null>, size = 5): Array<number | null> => {
  const half = Math.floor(size / 2);
  return values.map((value, index) => {
    if (value === null) return null;
    const candidates: number[] = [];
    for (let i = index - half; i <= index + half; i += 1) {
      const n = values[i];
      if (n !== null) candidates.push(n);
    }
    return candidates.length === 0 ? null : median(candidates);
  });
};

const toMono = (buffer: AudioBuffer): Float32Array => {
  const mono = new Float32Array(buffer.length);
  for (let ch = 0; ch < buffer.numberOfChannels; ch += 1) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < data.length; i += 1) {
      mono[i] += data[i] / buffer.numberOfChannels;
    }
  }
  return mono;
};

export const analyzePitch = (
  buffer: AudioBuffer,
  clarityThreshold: number,
  frameSize = 2048,
  hopSize = 512,
): PitchPoint[] => {
  const mono = toMono(buffer);
  const detector = PitchDetector.forFloat32Array(frameSize);
  const rawHz: Array<number | null> = [];
  const times: number[] = [];
  const clarities: number[] = [];

  for (let start = 0; start + frameSize <= mono.length; start += hopSize) {
    const frame = mono.subarray(start, start + frameSize);
    const [hz, clarity] = detector.findPitch(frame, buffer.sampleRate);
    const valid = Number.isFinite(hz) && clarity >= clarityThreshold ? hz : null;
    rawHz.push(valid);
    clarities.push(clarity);
    times.push(start / buffer.sampleRate);
  }

  const smoothed = smoothMedian(rawHz, 5);
  return smoothed.map((hz, index) => {
    if (hz === null) {
      return {
        timeSec: times[index],
        hz: null,
        midi: null,
        cents: null,
        clarity: clarities[index],
      };
    }
    const midi = hzToMidi(hz);
    return {
      timeSec: times[index],
      hz,
      midi,
      cents: (midi - Math.round(midi)) * 100,
      clarity: clarities[index],
    };
  });
};

export const correctPitchOffline = async (
  sourceBuffer: AudioBuffer,
  pitchPoints: PitchPoint[],
): Promise<{ blob: Blob; semitoneShift: number; sourceDurationSec: number }> => {
  const midiValues = pitchPoints
    .map((point) => point.midi)
    .filter((value): value is number => value !== null);

  if (midiValues.length === 0) {
    return {
      blob: audioBufferToWavBlob(sourceBuffer),
      semitoneShift: 0,
      sourceDurationSec: sourceBuffer.duration,
    };
  }

  const medianMidi = median(midiValues);
  const semitoneShift = clamp(Math.round(medianMidi) - medianMidi, -2, 2);

  const renderedLength = sourceBuffer.length;
  const context = new OfflineAudioContext(
    sourceBuffer.numberOfChannels,
    renderedLength,
    sourceBuffer.sampleRate,
  );

  const source = context.createBufferSource();
  source.buffer = sourceBuffer;
  source.detune.value = semitoneShift * 100;
  source.connect(context.destination);
  source.start(0);

  const rendered = await context.startRendering();
  return {
    blob: audioBufferToWavBlob(rendered),
    semitoneShift,
    sourceDurationSec: rendered.duration,
  };
};
