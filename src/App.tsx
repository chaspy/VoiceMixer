import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './App.css';
import { ensureAudioContext, decodeBlob, formatSec, uid, clamp } from './audio/utils';
import type { Clip, DrumHit, Project, Track } from './types/project';
import { deleteProjectById, listProjects, saveProject } from './storage/indexedDb';
import { analyzePitch, correctPitchOffline } from './engine/pitch';
import { PitchChart } from './components/PitchChart';
import { detectDrumHits, synthesizeDrumReplacement } from './engine/drumReplace';
import { renderProjectToWav } from './engine/render';

const DEFAULT_BPM = 120;
const DEFAULT_LENGTH_SEC = 180;
const MAX_TRACKS = 16;
const PROJECT_LIMIT_SEC = 600;
const TIMELINE_PX_PER_SEC = 80;

interface RecordingMeta {
  trackId: string;
  startSec: number;
  mode: 'normal' | 'punch';
  punchEndSec?: number;
}

interface DragState {
  projectId: string;
  trackId: string;
  clipId: string;
  originStartSec: number;
  startX: number;
}

const createTrack = (index: number): Track => ({
  id: uid(),
  name: `Track ${index + 1}`,
  kind: 'vocal',
  mute: false,
  solo: false,
  volume: 0.9,
  pan: 0,
  armed: index === 0,
  clips: [],
});

const createProject = (name: string): Project => {
  const now = new Date().toISOString();
  return {
    id: uid(),
    name,
    createdAt: now,
    updatedAt: now,
    bpm: DEFAULT_BPM,
    timeSigNumerator: 4,
    timeSigDenominator: 4,
    lengthSec: DEFAULT_LENGTH_SEC,
    tracks: Array.from({ length: 8 }, (_, index) => createTrack(index)),
  };
};

const clipEnd = (clip: Clip): number => clip.startSec + clip.durationSec;

const downloadBlob = (blob: Blob, filename: string): void => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
};

function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [currentProjectId, setCurrentProjectId] = useState<string>('');
  const [selectedTrackId, setSelectedTrackId] = useState<string>('');
  const [selectedClipId, setSelectedClipId] = useState<string>('');
  const [cursorSec, setCursorSec] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [recording, setRecording] = useState(false);
  const [metronomeEnabled, setMetronomeEnabled] = useState(true);
  const [metronomeVolume, setMetronomeVolume] = useState(0.25);
  const [normalizeOnExport, setNormalizeOnExport] = useState(true);
  const [punchStartSec, setPunchStartSec] = useState(8);
  const [punchEndSec, setPunchEndSec] = useState(10);
  const [statusMessage, setStatusMessage] = useState('Ready');
  const [busy, setBusy] = useState(false);

  const audioContextRef = useRef<AudioContext | null>(null);
  const playingSourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const playTokenRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const metronomeTimerRef = useRef<number | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recorderChunksRef = useRef<BlobPart[]>([]);
  const recordingMetaRef = useRef<RecordingMeta | null>(null);
  const recordingTimeoutRef = useRef<number | null>(null);
  const transportRef = useRef({ baseSec: 0, startedAtCtxSec: 0, nextBeatSec: 0 });
  const dragRef = useRef<DragState | null>(null);
  const decodeCacheRef = useRef<Map<string, AudioBuffer>>(new Map());

  const currentProject = useMemo(
    () => projects.find((project) => project.id === currentProjectId) ?? null,
    [projects, currentProjectId],
  );

  const selectedTrack = useMemo(
    () => currentProject?.tracks.find((track) => track.id === selectedTrackId) ?? null,
    [currentProject, selectedTrackId],
  );

  const selectedClip = useMemo(
    () => selectedTrack?.clips.find((clip) => clip.id === selectedClipId) ?? null,
    [selectedTrack, selectedClipId],
  );

  const updateCurrentProject = useCallback((updater: (project: Project) => Project): void => {
    if (!currentProjectId) return;
    setProjects((prev) =>
      prev.map((project) => {
        if (project.id !== currentProjectId) return project;
        const next = updater(project);
        return { ...next, updatedAt: new Date().toISOString() };
      }),
    );
  }, [currentProjectId]);

  const getAudioContext = async (): Promise<AudioContext> => {
    const context = await ensureAudioContext(audioContextRef.current);
    audioContextRef.current = context;
    return context;
  };

  const getDecodedClip = async (clip: Clip): Promise<AudioBuffer> => {
    const cached = decodeCacheRef.current.get(clip.id);
    if (cached) return cached;
    const context = await getAudioContext();
    const decoded = await decodeBlob(context, clip.blob);
    decodeCacheRef.current.set(clip.id, decoded);
    return decoded;
  };

  const stopAllSources = (): void => {
    for (const source of playingSourcesRef.current) {
      try {
        source.stop();
      } catch {
        // ignore already stopped
      }
    }
    playingSourcesRef.current = [];
  };

  const clearSchedulers = (): void => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (metronomeTimerRef.current !== null) {
      window.clearInterval(metronomeTimerRef.current);
      metronomeTimerRef.current = null;
    }
  };

  const stopPlayback = (): void => {
    if (!playing) return;
    const context = audioContextRef.current;
    if (context) {
      const elapsed = Math.max(0, context.currentTime - transportRef.current.startedAtCtxSec);
      const nextCursor = Math.min(
        currentProject?.lengthSec ?? PROJECT_LIMIT_SEC,
        transportRef.current.baseSec + elapsed,
      );
      setCursorSec(nextCursor);
    }
    stopAllSources();
    clearSchedulers();
    setPlaying(false);
  };

  const scheduleClick = (
    context: AudioContext,
    when: number,
    accent: boolean,
    volume: number,
  ): void => {
    const osc = context.createOscillator();
    const gain = context.createGain();
    osc.type = 'square';
    osc.frequency.value = accent ? 1320 : 980;
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, volume), when + 0.001);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.045);
    osc.connect(gain);
    gain.connect(context.destination);
    osc.start(when);
    osc.stop(when + 0.05);
  };

  const runCountIn = async (project: Project): Promise<void> => {
    if (!metronomeEnabled) return;
    const context = await getAudioContext();
    const beats = project.timeSigNumerator;
    const spb = 60 / project.bpm;
    const startAt = context.currentTime + 0.05;
    for (let i = 0; i < beats; i += 1) {
      scheduleClick(context, startAt + i * spb, i === 0, metronomeVolume);
    }
    await new Promise<void>((resolve) => {
      window.setTimeout(() => resolve(), beats * spb * 1000 + 80);
    });
  };

  const startPlayback = async (fromSec: number): Promise<void> => {
    const project = currentProject;
    if (!project || playing) return;

    const context = await getAudioContext();
    playTokenRef.current += 1;
    const playToken = playTokenRef.current;

    const startCtx = context.currentTime + 0.4;
    const baseSec = clamp(fromSec, 0, project.lengthSec);
    const beatSec = 60 / project.bpm;
    transportRef.current = {
      baseSec,
      startedAtCtxSec: startCtx,
      nextBeatSec: Math.ceil(baseSec / beatSec) * beatSec,
    };

    const activeTracks = (() => {
      const soloed = project.tracks.filter((track) => track.solo);
      return soloed.length > 0 ? soloed : project.tracks;
    })().filter((track) => !track.mute);

    const sources: AudioBufferSourceNode[] = [];

    for (const track of activeTracks) {
      for (const clip of track.clips) {
        const endSec = clipEnd(clip);
        if (endSec <= baseSec || clip.startSec >= project.lengthSec) continue;

        const buffer = await getDecodedClip(clip);
        if (playTokenRef.current !== playToken) {
          return;
        }

        const gainNode = context.createGain();
        gainNode.gain.value = track.volume;
        const panner = context.createStereoPanner();
        panner.pan.value = track.pan;
        gainNode.connect(panner);
        panner.connect(context.destination);

        const source = context.createBufferSource();
        source.buffer = buffer;
        source.connect(gainNode);

        const offsetByCursor = Math.max(0, baseSec - clip.startSec);
        const initialOffset = clip.offsetSec + offsetByCursor;
        const maxDuration = Math.max(0, clip.durationSec - offsetByCursor);
        if (maxDuration <= 0 || initialOffset >= buffer.duration) {
          continue;
        }

        const clipStartInTransport = Math.max(0, clip.startSec - baseSec);
        let scheduleAt = startCtx + clipStartInTransport;
        let offset = initialOffset;
        let duration = Math.min(maxDuration, buffer.duration - offset);

        const minNow = context.currentTime + 0.01;
        if (scheduleAt < minNow) {
          const late = minNow - scheduleAt;
          scheduleAt = minNow;
          offset += late;
          duration -= late;
        }

        if (duration <= 0) continue;
        source.start(scheduleAt, offset, duration);
        source.onended = () => {
          const idx = sources.indexOf(source);
          if (idx >= 0) sources.splice(idx, 1);
        };
        sources.push(source);
      }
    }

    playingSourcesRef.current = sources;
    setPlaying(true);

    if (metronomeEnabled) {
      metronomeTimerRef.current = window.setInterval(() => {
        const beat = 60 / project.bpm;
        const lookahead = 0.2;
        while (transportRef.current.nextBeatSec <= transportRef.current.baseSec + (context.currentTime - startCtx) + lookahead) {
          const beatTimeSec = transportRef.current.nextBeatSec;
          const beatIndex = Math.floor(beatTimeSec / beat) % project.timeSigNumerator;
          const when = startCtx + (beatTimeSec - transportRef.current.baseSec);
          scheduleClick(context, when, beatIndex === 0, metronomeVolume);
          transportRef.current.nextBeatSec += beat;
        }
      }, 50);
    }

    const tick = (): void => {
      const nowPos = transportRef.current.baseSec + Math.max(0, context.currentTime - startCtx);
      if (nowPos >= project.lengthSec) {
        setCursorSec(project.lengthSec);
        stopPlayback();
        return;
      }
      setCursorSec(nowPos);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  };

  const startRecording = async (mode: 'normal' | 'punch'): Promise<void> => {
    const project = currentProject;
    if (!project || recording) return;

    const armed = project.tracks.find((track) => track.armed);
    if (!armed) {
      setStatusMessage('録音アームされたトラックがありません');
      return;
    }

    const startSec = mode === 'punch' ? punchStartSec : cursorSec;
    const endSec = mode === 'punch' ? punchEndSec : undefined;
    if (mode === 'punch' && (endSec === undefined || endSec <= startSec)) {
      setStatusMessage('パンチイン範囲が不正です');
      return;
    }

    try {
      setBusy(true);
      await runCountIn(project);
      await startPlayback(startSec);

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: false,
        },
      });
      streamRef.current = stream;

      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm';

      const recorder = new MediaRecorder(stream, { mimeType });
      recorderRef.current = recorder;
      recorderChunksRef.current = [];
      recordingMetaRef.current = {
        trackId: armed.id,
        startSec,
        mode,
        punchEndSec: endSec,
      };

      recorder.ondataavailable = (event: BlobEvent) => {
        if (event.data.size > 0) {
          recorderChunksRef.current.push(event.data);
        }
      };

      recorder.start();
      setRecording(true);
      setStatusMessage(mode === 'punch' ? 'パンチイン録音中...' : '録音中...');

      if (mode === 'punch' && endSec !== undefined) {
        const durationMs = Math.max(0, (endSec - startSec) * 1000);
        recordingTimeoutRef.current = window.setTimeout(() => {
          void stopRecording();
        }, durationMs + 20);
      }
    } catch (error) {
      setStatusMessage(`録音開始に失敗: ${(error as Error).message}`);
      stopPlayback();
    } finally {
      setBusy(false);
    }
  };

  const applyClipUpdate = useCallback((trackId: string, updater: (clips: Clip[]) => Clip[]): void => {
    updateCurrentProject((project) => ({
      ...project,
      tracks: project.tracks.map((track) =>
        track.id === trackId ? { ...track, clips: updater(track.clips) } : track,
      ),
    }));
  }, [updateCurrentProject]);

  const applyPunchIn = (baseClips: Clip[], recorded: Clip, startSec: number, endSec: number): Clip[] => {
    const next: Clip[] = [];
    for (const clip of baseClips) {
      const cStart = clip.startSec;
      const cEnd = clipEnd(clip);
      if (cEnd <= startSec || cStart >= endSec) {
        next.push(clip);
        continue;
      }

      const leftDur = startSec - cStart;
      if (leftDur > 0.01) {
        next.push({
          ...clip,
          id: uid(),
          durationSec: leftDur,
        });
      }

      const rightDur = cEnd - endSec;
      if (rightDur > 0.01) {
        next.push({
          ...clip,
          id: uid(),
          startSec: endSec,
          offsetSec: clip.offsetSec + (endSec - cStart),
          durationSec: rightDur,
        });
      }
    }

    next.push(recorded);
    return next.sort((a, b) => a.startSec - b.startSec);
  };

  const stopRecording = async (): Promise<void> => {
    if (!recording) return;

    if (recordingTimeoutRef.current !== null) {
      window.clearTimeout(recordingTimeoutRef.current);
      recordingTimeoutRef.current = null;
    }

    const recorder = recorderRef.current;
    const meta = recordingMetaRef.current;
    if (!recorder || !meta) {
      setRecording(false);
      return;
    }

    const stoppedBlob = await new Promise<Blob>((resolve, reject) => {
      recorder.onstop = () => {
        resolve(new Blob(recorderChunksRef.current, { type: recorder.mimeType || 'audio/webm' }));
      };
      recorder.onerror = () => reject(new Error('録音エラー'));
      recorder.stop();
    });

    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    recorderRef.current = null;
    recordingMetaRef.current = null;
    setRecording(false);

    try {
      const context = await getAudioContext();
      const decoded = await decodeBlob(context, stoppedBlob);
      const newClip: Clip = {
        id: uid(),
        name: `Take ${new Date().toLocaleTimeString()}`,
        blob: stoppedBlob,
        mimeType: stoppedBlob.type || 'audio/webm',
        startSec: meta.startSec,
        offsetSec: 0,
        durationSec: decoded.duration,
        sourceDurationSec: decoded.duration,
        createdAt: new Date().toISOString(),
      };

      decodeCacheRef.current.set(newClip.id, decoded);

      if (meta.mode === 'punch' && meta.punchEndSec !== undefined) {
        applyClipUpdate(meta.trackId, (clips) => applyPunchIn(clips, newClip, meta.startSec, meta.punchEndSec ?? meta.startSec));
      } else {
        applyClipUpdate(meta.trackId, (clips) => [...clips, newClip].sort((a, b) => a.startSec - b.startSec));
      }

      setSelectedTrackId(meta.trackId);
      setSelectedClipId(newClip.id);
      setStatusMessage('録音を保存しました');
    } catch (error) {
      setStatusMessage(`録音保存に失敗: ${(error as Error).message}`);
    } finally {
      stopPlayback();
    }
  };

  const moveClip = useCallback((trackId: string, clipId: string, nextStartSec: number): void => {
    if (!currentProject) return;
    applyClipUpdate(trackId, (clips) =>
      clips.map((clip) =>
        clip.id === clipId
          ? {
              ...clip,
              startSec: clamp(nextStartSec, 0, Math.max(0, currentProject.lengthSec - clip.durationSec)),
            }
          : clip,
      ),
    );
  }, [applyClipUpdate, currentProject]);

  const trimSelectedClip = (edge: 'start' | 'end', stepSec: number): void => {
    if (!selectedTrack || !selectedClip) return;
    applyClipUpdate(selectedTrack.id, (clips) =>
      clips.map((clip) => {
        if (clip.id !== selectedClip.id) return clip;
        if (edge === 'start') {
          const nextDuration = clip.durationSec - stepSec;
          if (nextDuration < 0.05) return clip;
          const nextOffset = clip.offsetSec + stepSec;
          if (nextOffset >= clip.sourceDurationSec) return clip;
          return {
            ...clip,
            startSec: clip.startSec + stepSec,
            offsetSec: nextOffset,
            durationSec: nextDuration,
          };
        }

        const nextDuration = clip.durationSec - stepSec;
        if (nextDuration < 0.05) return clip;
        return {
          ...clip,
          durationSec: nextDuration,
        };
      }),
    );
  };

  const analyzeSelectedClipPitch = async (): Promise<void> => {
    if (!selectedTrack || !selectedClip) return;
    try {
      setBusy(true);
      const buffer = await getDecodedClip(selectedClip);
      const points = analyzePitch(buffer, 0.65);
      applyClipUpdate(selectedTrack.id, (clips) =>
        clips.map((clip) => (clip.id === selectedClip.id ? { ...clip, pitch: points } : clip)),
      );
      setStatusMessage('ピッチ解析が完了しました');
    } catch (error) {
      setStatusMessage(`ピッチ解析失敗: ${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const correctSelectedClipPitch = async (): Promise<void> => {
    if (!selectedTrack || !selectedClip) return;
    try {
      setBusy(true);
      const buffer = await getDecodedClip(selectedClip);
      const points = selectedClip.pitch ?? analyzePitch(buffer, 0.65);
      const result = await correctPitchOffline(buffer, points);
      const context = await getAudioContext();
      const correctedBuffer = await decodeBlob(context, result.blob);

      applyClipUpdate(selectedTrack.id, (clips) =>
        clips.map((clip) =>
          clip.id === selectedClip.id
            ? {
                ...clip,
                blob: result.blob,
                mimeType: result.blob.type,
                offsetSec: 0,
                sourceDurationSec: result.sourceDurationSec,
                durationSec: Math.min(clip.durationSec, correctedBuffer.duration),
                pitch: undefined,
              }
            : clip,
        ),
      );

      decodeCacheRef.current.set(selectedClip.id, correctedBuffer);
      setStatusMessage(`簡易補正を適用（${result.semitoneShift.toFixed(2)} semitone）`);
    } catch (error) {
      setStatusMessage(`ピッチ補正失敗: ${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const replaceSelectedClipAsDrums = async (): Promise<void> => {
    const project = currentProject;
    if (!project || !selectedTrack || !selectedClip) return;
    if (project.tracks.length >= MAX_TRACKS) {
      setStatusMessage('トラック上限(16)に達しています');
      return;
    }

    try {
      setBusy(true);
      const buffer = await getDecodedClip(selectedClip);
      const hits: DrumHit[] = detectDrumHits(buffer);
      const blob = await synthesizeDrumReplacement(hits, selectedClip.durationSec);
      const context = await getAudioContext();
      const decoded = await decodeBlob(context, blob);

      const drumClip: Clip = {
        id: uid(),
        name: `${selectedClip.name} Drum`,
        blob,
        mimeType: blob.type,
        startSec: selectedClip.startSec,
        offsetSec: 0,
        durationSec: Math.min(selectedClip.durationSec, decoded.duration),
        sourceDurationSec: decoded.duration,
        createdAt: new Date().toISOString(),
      };
      decodeCacheRef.current.set(drumClip.id, decoded);

      const drumTrack: Track = {
        id: uid(),
        name: `Drum Replace ${project.tracks.length + 1}`,
        kind: 'drum',
        mute: false,
        solo: false,
        volume: 0.9,
        pan: 0,
        armed: false,
        clips: [drumClip],
      };

      updateCurrentProject((draft) => ({
        ...draft,
        tracks: [...draft.tracks, drumTrack],
      }));
      setStatusMessage(`ドラム置換を追加（${hits.length} hits）`);
    } catch (error) {
      setStatusMessage(`ドラム置換失敗: ${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const exportWav = async (): Promise<void> => {
    const project = currentProject;
    if (!project) return;
    try {
      setBusy(true);
      const context = await getAudioContext();
      const wav = await renderProjectToWav(context, project, { normalize: normalizeOnExport });
      downloadBlob(wav, `${project.name.replace(/\s+/g, '_')}.wav`);
      setStatusMessage('WAVを書き出しました');
    } catch (error) {
      setStatusMessage(`書き出し失敗: ${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void (async () => {
      const loaded = await listProjects();
      if (loaded.length === 0) {
        const initial = createProject('VoiceMixer Project');
        setProjects([initial]);
        setCurrentProjectId(initial.id);
        setSelectedTrackId(initial.tracks[0].id);
        return;
      }

      setProjects(loaded);
      setCurrentProjectId(loaded[0].id);
      setSelectedTrackId(loaded[0].tracks[0]?.id ?? '');
    })();
  }, []);

  useEffect(() => {
    if (!currentProject) return;
    const timer = window.setTimeout(() => {
      void saveProject(currentProject);
    }, 700);
    return () => window.clearTimeout(timer);
  }, [currentProject]);

  useEffect(() => {
    if (!currentProject) return;
    if (!currentProject.tracks.some((track) => track.id === selectedTrackId)) {
      setSelectedTrackId(currentProject.tracks[0]?.id ?? '');
      setSelectedClipId('');
    }
  }, [currentProject, selectedTrackId]);

  useEffect(() => {
    if (!selectedTrack) {
      setSelectedClipId('');
      return;
    }
    if (!selectedTrack.clips.some((clip) => clip.id === selectedClipId)) {
      setSelectedClipId('');
    }
  }, [selectedTrack, selectedClipId]);

  useEffect(() => {
    const onMove = (event: MouseEvent): void => {
      if (!dragRef.current || !currentProject) return;
      const deltaSec = (event.clientX - dragRef.current.startX) / TIMELINE_PX_PER_SEC;
      moveClip(dragRef.current.trackId, dragRef.current.clipId, dragRef.current.originStartSec + deltaSec);
    };
    const onUp = (): void => {
      dragRef.current = null;
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [currentProject, moveClip]);

  useEffect(() => () => {
    stopAllSources();
    clearSchedulers();
    if (audioContextRef.current) {
      void audioContextRef.current.close();
    }
  }, []);

  const addTrack = (): void => {
    if (!currentProject || currentProject.tracks.length >= MAX_TRACKS) return;
    updateCurrentProject((project) => ({
      ...project,
      tracks: [...project.tracks, createTrack(project.tracks.length)],
    }));
  };

  const removeTrack = (trackId: string): void => {
    if (!currentProject || currentProject.tracks.length <= 1) return;
    updateCurrentProject((project) => ({
      ...project,
      tracks: project.tracks.filter((track) => track.id !== trackId),
    }));
  };

  const createNewProject = (): void => {
    const project = createProject(`Project ${projects.length + 1}`);
    setProjects((prev) => [project, ...prev]);
    setCurrentProjectId(project.id);
    setSelectedTrackId(project.tracks[0].id);
    setCursorSec(0);
  };

  const deleteCurrentProject = async (): Promise<void> => {
    if (!currentProject) return;
    const id = currentProject.id;
    setProjects((prev) => prev.filter((project) => project.id !== id));
    await deleteProjectById(id);
    setStatusMessage('プロジェクトを削除しました');
  };

  const timelineWidth = (currentProject?.lengthSec ?? DEFAULT_LENGTH_SEC) * TIMELINE_PX_PER_SEC;

  return (
    <div className="app">
      <aside className="sidebar">
        <h1>VoiceMixer</h1>
        <button onClick={createNewProject}>+ 新規プロジェクト</button>
        <div className="project-list">
          {projects.map((project) => (
            <button
              key={project.id}
              className={project.id === currentProjectId ? 'active' : ''}
              onClick={() => {
                setCurrentProjectId(project.id);
                setCursorSec(0);
              }}
            >
              <span>{project.name}</span>
              <small>{new Date(project.updatedAt).toLocaleString()}</small>
            </button>
          ))}
        </div>
      </aside>

      <main className="main">
        {!currentProject ? null : (
          <>
            <section className="toolbar">
              <div className="row">
                <strong>{currentProject.name}</strong>
                <label>
                  BPM
                  <input
                    type="number"
                    min={40}
                    max={240}
                    value={currentProject.bpm}
                    onChange={(event) => {
                      const bpm = clamp(Number(event.target.value) || DEFAULT_BPM, 40, 240);
                      updateCurrentProject((project) => ({ ...project, bpm }));
                    }}
                  />
                </label>
                <label>
                  長さ(sec)
                  <input
                    type="number"
                    min={30}
                    max={PROJECT_LIMIT_SEC}
                    value={currentProject.lengthSec}
                    onChange={(event) => {
                      const lengthSec = clamp(Number(event.target.value) || DEFAULT_LENGTH_SEC, 30, PROJECT_LIMIT_SEC);
                      updateCurrentProject((project) => ({ ...project, lengthSec }));
                    }}
                  />
                </label>
                <label>
                  メトロノーム
                  <input
                    type="checkbox"
                    checked={metronomeEnabled}
                    onChange={(event) => setMetronomeEnabled(event.target.checked)}
                  />
                </label>
                <label>
                  Click Vol
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.01}
                    value={metronomeVolume}
                    onChange={(event) => setMetronomeVolume(Number(event.target.value))}
                  />
                </label>
              </div>

              <div className="row">
                <button disabled={playing || busy} onClick={() => void startPlayback(cursorSec)}>
                  ▶ 再生
                </button>
                <button onClick={stopPlayback}>■ 停止</button>
                <button disabled={recording || busy} onClick={() => void startRecording('normal')}>
                  ● 録音
                </button>
                <button disabled={recording || busy} onClick={() => void startRecording('punch')}>
                  ● パンチイン
                </button>
                <button disabled={!recording} onClick={() => void stopRecording()}>
                  録音停止
                </button>
                <label>
                  Punch Start
                  <input
                    type="number"
                    min={0}
                    max={currentProject.lengthSec}
                    step={0.01}
                    value={punchStartSec}
                    onChange={(event) => setPunchStartSec(Number(event.target.value) || 0)}
                  />
                </label>
                <label>
                  Punch End
                  <input
                    type="number"
                    min={0}
                    max={currentProject.lengthSec}
                    step={0.01}
                    value={punchEndSec}
                    onChange={(event) => setPunchEndSec(Number(event.target.value) || 0)}
                  />
                </label>
                <button onClick={addTrack} disabled={currentProject.tracks.length >= MAX_TRACKS}>
                  + Track
                </button>
                <button onClick={() => void deleteCurrentProject()}>削除</button>
              </div>

              <div className="row">
                <span>Cursor: {formatSec(cursorSec)}</span>
                <input
                  className="cursor-slider"
                  type="range"
                  min={0}
                  max={currentProject.lengthSec}
                  step={0.01}
                  value={cursorSec}
                  onChange={(event) => {
                    const next = Number(event.target.value);
                    setCursorSec(next);
                    if (!playing) {
                      transportRef.current.baseSec = next;
                    }
                  }}
                />
                <label>
                  Normalize
                  <input
                    type="checkbox"
                    checked={normalizeOnExport}
                    onChange={(event) => setNormalizeOnExport(event.target.checked)}
                  />
                </label>
                <button disabled={busy} onClick={() => void exportWav()}>
                  WAV書き出し
                </button>
              </div>
              <p className="status">{statusMessage}</p>
            </section>

            <section className="mixer">
              <h2>Tracks ({currentProject.tracks.length}/{MAX_TRACKS})</h2>
              {currentProject.tracks.map((track) => (
                <div key={track.id} className={`track ${track.id === selectedTrackId ? 'selected' : ''}`}>
                  <button
                    className="track-name"
                    onClick={() => {
                      setSelectedTrackId(track.id);
                      setSelectedClipId(track.clips[0]?.id ?? '');
                    }}
                  >
                    {track.name}
                  </button>
                  <label>
                    Arm
                    <input
                      type="checkbox"
                      checked={track.armed}
                      onChange={() => {
                        updateCurrentProject((project) => ({
                          ...project,
                          tracks: project.tracks.map((item) => ({
                            ...item,
                            armed: item.id === track.id,
                          })),
                        }));
                      }}
                    />
                  </label>
                  <label>
                    Mute
                    <input
                      type="checkbox"
                      checked={track.mute}
                      onChange={(event) => {
                        const checked = event.target.checked;
                        updateCurrentProject((project) => ({
                          ...project,
                          tracks: project.tracks.map((item) =>
                            item.id === track.id ? { ...item, mute: checked } : item,
                          ),
                        }));
                      }}
                    />
                  </label>
                  <label>
                    Solo
                    <input
                      type="checkbox"
                      checked={track.solo}
                      onChange={(event) => {
                        const checked = event.target.checked;
                        updateCurrentProject((project) => ({
                          ...project,
                          tracks: project.tracks.map((item) =>
                            item.id === track.id ? { ...item, solo: checked } : item,
                          ),
                        }));
                      }}
                    />
                  </label>
                  <label>
                    Vol
                    <input
                      type="range"
                      min={0}
                      max={1.5}
                      step={0.01}
                      value={track.volume}
                      onChange={(event) => {
                        const volume = Number(event.target.value);
                        updateCurrentProject((project) => ({
                          ...project,
                          tracks: project.tracks.map((item) =>
                            item.id === track.id ? { ...item, volume } : item,
                          ),
                        }));
                      }}
                    />
                  </label>
                  <label>
                    Pan
                    <input
                      type="range"
                      min={-1}
                      max={1}
                      step={0.01}
                      value={track.pan}
                      onChange={(event) => {
                        const pan = Number(event.target.value);
                        updateCurrentProject((project) => ({
                          ...project,
                          tracks: project.tracks.map((item) =>
                            item.id === track.id ? { ...item, pan } : item,
                          ),
                        }));
                      }}
                    />
                  </label>
                  <button onClick={() => removeTrack(track.id)} disabled={currentProject.tracks.length <= 1}>
                    削除
                  </button>
                </div>
              ))}
            </section>

            <section className="timeline-wrap">
              <h2>Timeline (自由移動)</h2>
              <div className="timeline" style={{ width: timelineWidth }}>
                <div
                  className="cursor-line"
                  style={{ left: cursorSec * TIMELINE_PX_PER_SEC }}
                  onDoubleClick={(event) => {
                    const rect = (event.currentTarget.parentElement as HTMLDivElement).getBoundingClientRect();
                    const x = event.clientX - rect.left;
                    setCursorSec(clamp(x / TIMELINE_PX_PER_SEC, 0, currentProject.lengthSec));
                  }}
                />
                {currentProject.tracks.map((track, trackIndex) => (
                  <div className="lane" key={track.id} style={{ top: trackIndex * 64 }}>
                    {track.clips.map((clip) => (
                      <div
                        key={clip.id}
                        className={`clip ${clip.id === selectedClipId ? 'selected' : ''}`}
                        style={{
                          left: clip.startSec * TIMELINE_PX_PER_SEC,
                          width: Math.max(20, clip.durationSec * TIMELINE_PX_PER_SEC),
                        }}
                        onMouseDown={(event) => {
                          setSelectedTrackId(track.id);
                          setSelectedClipId(clip.id);
                          dragRef.current = {
                            projectId: currentProject.id,
                            trackId: track.id,
                            clipId: clip.id,
                            originStartSec: clip.startSec,
                            startX: event.clientX,
                          };
                        }}
                      >
                        {clip.name}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </section>

            <section className="editor">
              <h2>Selected Clip</h2>
              {!selectedClip ? (
                <p>クリップを選択してください</p>
              ) : (
                <>
                  <div className="row">
                    <span>{selectedClip.name}</span>
                    <span>
                      Start {selectedClip.startSec.toFixed(2)}s / Dur {selectedClip.durationSec.toFixed(2)}s
                    </span>
                    <button onClick={() => trimSelectedClip('start', 0.05)}>前を0.05sトリム</button>
                    <button onClick={() => trimSelectedClip('end', 0.05)}>後ろを0.05sトリム</button>
                    <button
                      onClick={() => {
                        if (!selectedTrack) return;
                        moveClip(selectedTrack.id, selectedClip.id, selectedClip.startSec - 0.01);
                      }}
                    >
                      ◀ 0.01s
                    </button>
                    <button
                      onClick={() => {
                        if (!selectedTrack) return;
                        moveClip(selectedTrack.id, selectedClip.id, selectedClip.startSec + 0.01);
                      }}
                    >
                      0.01s ▶
                    </button>
                  </div>
                  <div className="row">
                    <button disabled={busy} onClick={() => void analyzeSelectedClipPitch()}>
                      ピッチ解析
                    </button>
                    <button disabled={busy} onClick={() => void correctSelectedClipPitch()}>
                      簡易ピッチ補正
                    </button>
                    <button disabled={busy} onClick={() => void replaceSelectedClipAsDrums()}>
                      口ドラム置換(K/S/HH)
                    </button>
                  </div>
                  <PitchChart points={selectedClip.pitch ?? []} />
                </>
              )}
            </section>
          </>
        )}
      </main>
    </div>
  );
}

export default App;
