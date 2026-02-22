import type { DrumHit } from '../types/project';
import { audioBufferToWavBlob } from '../audio/wav';
import { clamp } from '../audio/utils';

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

const rmsAndZcr = (samples: Float32Array, start: number, windowSize: number): { rms: number; zcr: number } => {
  let power = 0;
  let crossings = 0;
  let prev = samples[start] ?? 0;
  const end = Math.min(samples.length, start + windowSize);
  const count = Math.max(1, end - start);

  for (let i = start; i < end; i += 1) {
    const s = samples[i];
    power += s * s;
    if ((s >= 0 && prev < 0) || (s < 0 && prev >= 0)) {
      crossings += 1;
    }
    prev = s;
  }

  return {
    rms: Math.sqrt(power / count),
    zcr: crossings / count,
  };
};

export const detectDrumHits = (buffer: AudioBuffer): DrumHit[] => {
  const mono = toMono(buffer);
  const sampleRate = buffer.sampleRate;
  const frameSize = 1024;
  const hopSize = 256;
  const onsetThreshold = 0.014;
  const deltaThreshold = 0.006;
  const refractorySec = 0.08;
  const hits: DrumHit[] = [];

  let previousEnergy = 0;
  let lastOnsetSec = -refractorySec;

  for (let i = 0; i + frameSize <= mono.length; i += hopSize) {
    let power = 0;
    for (let j = 0; j < frameSize; j += 1) {
      const sample = mono[i + j];
      power += sample * sample;
    }
    const energy = Math.sqrt(power / frameSize);
    const delta = energy - previousEnergy;
    const timeSec = i / sampleRate;
    const allowed = timeSec - lastOnsetSec >= refractorySec;

    if (allowed && energy > onsetThreshold && delta > deltaThreshold) {
      const features = rmsAndZcr(mono, i, Math.floor(sampleRate * 0.02));
      let type: DrumHit['type'];
      if (features.zcr < 0.08) {
        type = 'kick';
      } else if (features.zcr > 0.2) {
        type = 'hihat';
      } else {
        type = 'snare';
      }

      hits.push({
        timeSec,
        type,
        strength: clamp(features.rms * 8, 0.2, 1),
      });
      lastOnsetSec = timeSec;
    }

    previousEnergy = energy;
  }

  return hits;
};

const addKick = (data: Float32Array, sampleRate: number, start: number, velocity: number): void => {
  const len = Math.floor(sampleRate * 0.18);
  for (let i = 0; i < len; i += 1) {
    const t = i / sampleRate;
    const freq = 130 - 70 * (i / len);
    const env = Math.exp(-t * 20) * velocity;
    const sample = Math.sin(2 * Math.PI * freq * t) * env;
    const idx = start + i;
    if (idx < data.length) data[idx] += sample;
  }
};

const addSnare = (data: Float32Array, sampleRate: number, start: number, velocity: number): void => {
  const len = Math.floor(sampleRate * 0.14);
  for (let i = 0; i < len; i += 1) {
    const t = i / sampleRate;
    const env = Math.exp(-t * 28) * velocity;
    const tone = Math.sin(2 * Math.PI * 210 * t) * 0.2;
    const noise = (Math.random() * 2 - 1) * 0.8;
    const idx = start + i;
    if (idx < data.length) data[idx] += (tone + noise) * env;
  }
};

const addHiHat = (data: Float32Array, sampleRate: number, start: number, velocity: number): void => {
  const len = Math.floor(sampleRate * 0.07);
  for (let i = 0; i < len; i += 1) {
    const t = i / sampleRate;
    const env = Math.exp(-t * 60) * velocity;
    const noise = (Math.random() * 2 - 1) * env;
    const high = noise - (i > 0 ? data[Math.max(0, start + i - 1)] * 0.85 : 0);
    const idx = start + i;
    if (idx < data.length) data[idx] += high;
  }
};

export const synthesizeDrumReplacement = async (
  hits: DrumHit[],
  lengthSec: number,
  sampleRate = 48000,
): Promise<Blob> => {
  const totalSamples = Math.max(1, Math.floor(lengthSec * sampleRate));
  const data = new Float32Array(totalSamples);

  for (const hit of hits) {
    const index = Math.floor(hit.timeSec * sampleRate);
    if (hit.type === 'kick') {
      addKick(data, sampleRate, index, hit.strength);
    } else if (hit.type === 'snare') {
      addSnare(data, sampleRate, index, hit.strength);
    } else {
      addHiHat(data, sampleRate, index, hit.strength);
    }
  }

  for (let i = 0; i < data.length; i += 1) {
    data[i] = clamp(data[i], -1, 1);
  }

  const offline = new OfflineAudioContext(1, totalSamples, sampleRate);
  const buffer = offline.createBuffer(1, totalSamples, sampleRate);
  buffer.copyToChannel(data, 0);
  return audioBufferToWavBlob(buffer);
};
