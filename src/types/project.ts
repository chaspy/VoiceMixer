export type TrackKind = 'vocal' | 'drum' | 'other';

export interface PitchPoint {
  timeSec: number;
  hz: number | null;
  midi: number | null;
  cents: number | null;
  clarity: number;
}

export interface DrumHit {
  timeSec: number;
  type: 'kick' | 'snare' | 'hihat';
  strength: number;
}

export interface Clip {
  id: string;
  name: string;
  blob: Blob;
  mimeType: string;
  startSec: number;
  offsetSec: number;
  durationSec: number;
  sourceDurationSec: number;
  createdAt: string;
  pitch?: PitchPoint[];
}

export interface Track {
  id: string;
  name: string;
  kind: TrackKind;
  mute: boolean;
  solo: boolean;
  volume: number;
  pan: number;
  armed: boolean;
  clips: Clip[];
}

export interface Project {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  bpm: number;
  timeSigNumerator: number;
  timeSigDenominator: number;
  lengthSec: number;
  tracks: Track[];
}

export interface EditorState {
  cursorSec: number;
  playing: boolean;
  metronomeEnabled: boolean;
  metronomeVolume: number;
  normalizeOnExport: boolean;
}

export interface PersistedRoot {
  projects: Project[];
}
