export const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

export const ensureAudioContext = async (
  current: AudioContext | null,
): Promise<AudioContext> => {
  const context = current ?? new AudioContext();
  if (context.state === 'suspended') {
    await context.resume();
  }
  return context;
};

export const decodeBlob = async (context: AudioContext, blob: Blob): Promise<AudioBuffer> => {
  const arrayBuffer = await blob.arrayBuffer();
  return context.decodeAudioData(arrayBuffer.slice(0));
};

export const uid = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

export const formatSec = (sec: number): string => {
  const value = Math.max(0, sec);
  const mm = Math.floor(value / 60);
  const ss = Math.floor(value % 60);
  const ms = Math.floor((value % 1) * 1000);
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}.${String(ms)
    .padStart(3, '0')
    .slice(0, 2)}`;
};
