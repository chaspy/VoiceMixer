import type { Clip, Project, Track } from '../types/project';
import { decodeBlob } from '../audio/utils';
import { audioBufferToWavBlob, normalizeAudioBuffer } from '../audio/wav';

interface RenderOptions {
  normalize: boolean;
}

const clipEnd = (clip: Clip): number => clip.startSec + clip.durationSec;

const activeTracks = (tracks: Track[]): Track[] => {
  const soloed = tracks.filter((track) => track.solo);
  return soloed.length > 0 ? soloed : tracks;
};

export const renderProjectToWav = async (
  context: AudioContext,
  project: Project,
  options: RenderOptions,
): Promise<Blob> => {
  const tracks = activeTracks(project.tracks).filter((track) => !track.mute);
  const maxClipEnd = tracks
    .flatMap((track) => track.clips)
    .reduce((max, clip) => Math.max(max, clipEnd(clip)), 0);
  const durationSec = Math.min(project.lengthSec, Math.max(1, maxClipEnd));
  const sampleRate = 48000;
  const length = Math.ceil(durationSec * sampleRate);

  const offline = new OfflineAudioContext(2, length, sampleRate);

  await Promise.all(
    tracks.map(async (track) => {
      const gainNode = offline.createGain();
      gainNode.gain.value = track.volume;
      const panNode = offline.createStereoPanner();
      panNode.pan.value = track.pan;
      gainNode.connect(panNode);
      panNode.connect(offline.destination);

      await Promise.all(
        track.clips.map(async (clip) => {
          const buffer = await decodeBlob(context, clip.blob);
          const source = offline.createBufferSource();
          source.buffer = buffer;
          source.connect(gainNode);

          const start = Math.max(0, clip.startSec);
          const offset = Math.max(0, clip.offsetSec);
          const duration = Math.max(0, Math.min(clip.durationSec, buffer.duration - offset));
          if (duration <= 0 || start >= durationSec) {
            return;
          }

          source.start(start, offset, Math.min(duration, durationSec - start));
        }),
      );
    }),
  );

  const rendered = await offline.startRendering();
  if (options.normalize) {
    normalizeAudioBuffer(rendered);
  }
  return audioBufferToWavBlob(rendered);
};
